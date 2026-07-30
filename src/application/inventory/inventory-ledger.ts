import {
  stableMemoryRecordKey,
  type InventoryAvailability,
  type InventoryCommand,
  type InventoryItem,
  type InventoryItemCategory,
  type InventoryMeasureKind,
  type InventoryPrecision,
  type InventoryState,
} from '../../domain';
import type { KnownInventoryContextItem, SourceBlock } from '../ingest/types';

const SNAPSHOT_HEADER = '【当前物资快照】';
const NEXT_SECTION = /^【.+】$/u;
const CATEGORY_BY_LABEL: Readonly<Record<string, InventoryItemCategory>> = Object.freeze({
  武器: 'weapon', 药品: 'medicine', 食物: 'food', 防具: 'armor', 特殊道具: 'special',
  低级核心: 'core', 中级核心: 'core', 高级核心: 'core', 顶级核心: 'core', 特殊核心: 'core',
  材料: 'material',
});
const ROW = /^([^：:]{1,20})[：:]\s*(.+)$/u;
const REMOVED = /(?:已丢弃|已耗尽|已失去|已销毁|已用完|不再持有)/u;
const UNKNOWN = /若干/u;
const APPROXIMATE = /(?:约|大约|大概|近)/u;
const COVERAGE = /(?:可维持|维持|天份|日份)/u;
const NUMBER_WITH_UNIT = /(?<raw>(?:[x×]\s*)?(?:约|大约|大概|近)?\s*(?<amount>\d+(?:\.\d+)?)\s*(?<unit>天份|日份|天|日|小时|瓶|包|盒|枚|份|块|支|套|罐|袋|个|件|把|克|千克|公斤|毫克|毫升|升|g|kg|mg|ml|l))(?=$|[（(）)\s，,、；;])/iu;
const MULTIPLIER = /(?<raw>[x×]\s*(?<amount>\d+(?:\.\d+)?))(?=$|[（(）)\s，,、；;])/iu;

export interface DeterministicInventoryProposal {
  readonly source: SourceBlock;
  readonly itemName: string;
  readonly category: InventoryItemCategory;
  readonly command: Omit<InventoryCommand, 'itemId'>;
}

function unique(values: readonly string[]): string[] { return [...new Set(values.filter(Boolean))]; }

export function normalizeInventoryName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

export function inventoryItemId(workspaceId: string, canonicalName: string): string {
  return `inventory-item:${stableMemoryRecordKey(`${workspaceId}\0${normalizeInventoryName(canonicalName)}`)}`;
}

export function inventoryStateId(chatKey: string, itemId: string, measureKind: InventoryMeasureKind, unitKey: string): string {
  return `inventory-state:${stableMemoryRecordKey(`${chatKey}\0${itemId}\0${measureKind}\0${unitKey}`)}`;
}

export function normalizeInventoryUnit(value: string): string {
  const normalized = value.normalize('NFKC').trim().toLocaleLowerCase();
  return ({ 公斤: 'kg', 千克: 'kg', 克: 'g', 毫克: 'mg', 毫升: 'ml', 升: 'l', 日份: '天份', 日: '天' } as Record<string, string>)[normalized] ?? normalized;
}

function splitTopLevel(value: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === '(' || char === '（' || char === '[' || char === '【') depth += 1;
    else if (char === ')' || char === '）' || char === ']' || char === '】') depth = Math.max(0, depth - 1);
    else if (depth === 0 && /[、，,；;]/u.test(char)) {
      const item = value.slice(start, index).trim();
      if (item) result.push(item);
      start = index + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail) result.push(tail);
  return result;
}

function nestedQuantifiedItems(value: string): string[] {
  const inner = value.match(/[（(]([^（）()]*)[）)]\s*$/u)?.[1]?.trim();
  if (!inner) return [];
  const parts = splitTopLevel(inner);
  return parts.length >= 2 && parts.every(part => NUMBER_WITH_UNIT.test(part) || MULTIPLIER.test(part)) ? parts : [];
}

function stripStateSuffix(value: string): string {
  return value
    .replace(/[（(](?:约|大约|大概|近)?\s*\d+(?:\.\d+)?\s*(?:天份|日份|天|日|小时|瓶|包|盒|枚|份|块|支|套|罐|袋|个|件|把|克|千克|公斤|毫克|毫升|升|g|kg|mg|ml|l)[）)]\s*$/iu, '')
    .replace(/[x×]\s*\d+(?:\.\d+)?\s*$/iu, '')
    .replace(/[x×]?\s*(?:约|大约|大概|近)?\s*\d+(?:\.\d+)?\s*(?:天份|日份|天|日|小时|瓶|包|盒|枚|份|块|支|套|罐|袋|个|件|把|克|千克|公斤|毫克|毫升|升|g|kg|mg|ml|l)\s*$/iu, '')
    .replace(/若干(?:[（(].*?[）)])?\s*$/u, '')
    .replace(/[（(](?:已丢弃|已耗尽|已失去|已销毁|已用完|不再持有|已使用)[^）)]*[）)]\s*$/u, '')
    .trim();
}

function quantityOf(value: string): {
  amount?: number;
  rawAmount?: string;
  unit: string;
  precision: InventoryPrecision;
  measureKind: InventoryMeasureKind;
} {
  if (UNKNOWN.test(value)) return { unit: '', precision: 'unknown', measureKind: 'quantity' };
  const outer = value.split(/[（(]/u, 1)[0] ?? value;
  const searchValue = /\d/u.test(outer) ? outer : value;
  const multiplier = [...searchValue.matchAll(new RegExp(MULTIPLIER.source, 'giu'))][0];
  const measured = [...searchValue.matchAll(new RegExp(NUMBER_WITH_UNIT.source, 'giu'))][0];
  const match = measured ?? multiplier;
  const amountText = match?.groups?.amount;
  if (!amountText) return { unit: '', precision: 'unknown', measureKind: 'quantity' };
  const rawAmount = match.groups?.raw?.trim();
  const rawUnit = measured?.groups?.unit ?? '个';
  const unit = normalizeInventoryUnit(rawUnit);
  return {
    amount: Number(amountText),
    ...(rawAmount ? { rawAmount } : {}),
    unit,
    precision: APPROXIMATE.test(rawAmount ?? '') ? 'approximate' : 'exact',
    measureKind: COVERAGE.test(value) || unit === '天份' ? 'coverage_days' : 'quantity',
  };
}

function proposal(source: SourceBlock, category: InventoryItemCategory, value: string): DeterministicInventoryProposal | undefined {
  const itemName = stripStateSuffix(value);
  if (!itemName || itemName.length > 120) return undefined;
  const removed = REMOVED.test(value);
  const quantity = quantityOf(value);
  const stateNote = value.match(/[（(]([^（）()]*(?:已使用|已安装|已丢弃|已耗尽|已失去|已销毁|已用完)[^（）()]*)[）)]/u)?.[1]?.trim();
  return {
    source,
    itemName,
    category,
    command: {
      operation: removed ? 'remove' : 'set',
      measureKind: quantity.measureKind,
      ...(quantity.amount === undefined ? {} : { amount: quantity.amount }),
      ...(quantity.rawAmount ? { rawAmount: quantity.rawAmount } : {}),
      unit: quantity.unit,
      precision: quantity.precision,
      reason: 'recount',
      ...(stateNote ? { stateNote } : {}),
      sourceRef: source.id,
      evidenceExcerpt: value,
      ...(source.floor === undefined ? {} : { floor: source.floor }),
      occurredAt: source.createdAt,
      origin: 'automatic',
      confidence: 1,
    },
  };
}

/** Deterministic parser for explicit Tavern inventory snapshots only. */
export function parseInventorySnapshots(sources: readonly SourceBlock[], writableSourceRefs: ReadonlySet<string>): DeterministicInventoryProposal[] {
  const result: DeterministicInventoryProposal[] = [];
  for (const source of sources) {
    if (!writableSourceRefs.has(source.id)) continue;
    const lines = source.content.split(/\r?\n/u);
    const header = lines.findIndex(line => line.trim() === SNAPSHOT_HEADER);
    if (header < 0) continue;
    for (let index = header + 1; index < lines.length; index += 1) {
      const line = lines[index]!.trim();
      if (!line) continue;
      if (NEXT_SECTION.test(line)) break;
      const match = line.match(ROW);
      if (!match) continue;
      const category = CATEGORY_BY_LABEL[match[1]!.trim()];
      if (!category) continue;
      for (const item of splitTopLevel(match[2]!)) {
        const parsed = proposal(source, category, item);
        if (parsed) result.push(parsed);
        // ponytail: nested parsing is limited to clearly quantified sibling lists; use a grammar only if real snapshots outgrow it.
        for (const nested of nestedQuantifiedItems(item)) {
          const child = proposal(source, category, nested);
          if (child) result.push(child);
        }
      }
    }
  }
  const seen = new Set<string>();
  return result.filter((item) => {
    const key = `${item.source.id}\0${normalizeInventoryName(item.itemName)}\0${item.command.measureKind}\0${item.command.unit}\0${item.command.operation}\0${item.command.rawAmount ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function selectKnownInventoryContext(
  sources: readonly SourceBlock[],
  items: readonly InventoryItem[],
  states: readonly InventoryState[],
  limit = 50,
): KnownInventoryContextItem[] {
  const text = sources.map(source => source.content).join('\n');
  const matches = items.map((item, index) => ({
    item,
    index,
    position: Math.min(...unique([item.canonicalName, ...item.aliases])
      .filter(name => name.length >= 2)
      .map(name => text.indexOf(name))
      .filter(position => position >= 0)),
  })).filter(entry => entry.item.status !== 'invalid' && Number.isFinite(entry.position))
    .sort((left, right) => left.position - right.position || left.index - right.index)
    .map(entry => entry.item);
  return matches.slice(0, limit).map((item, index) => ({
    referenceId: `I${String(index + 1).padStart(2, '0')}`,
    itemId: item.id,
    canonicalName: item.canonicalName,
    aliases: [...item.aliases],
    category: item.category,
    states: states.filter(state => state.itemId === item.id).map(state => ({
      measureKind: state.measureKind,
      ...(state.amount === undefined ? {} : { amount: state.amount }),
      unit: state.unit,
      precision: state.precision,
      availability: state.availability,
      ...(state.updatedAtFloor === undefined ? {} : { updatedAtFloor: state.updatedAtFloor }),
    })),
  }));
}

function inventoryXmlEscape(value: string): string {
  return value.replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
}

/** Inject only inventory names that the current user message mentions exactly. */
export function buildMatchedInventoryPrompt(
  userMessage: string,
  items: readonly InventoryItem[],
  states: readonly InventoryState[],
  maxChars: number,
): string {
  const query = userMessage.normalize('NFKC').toLocaleLowerCase();
  const matched = items.filter(item => item.status !== 'invalid' && unique([item.canonicalName, ...item.aliases])
    .some(name => name.length >= 2 && query.includes(name.normalize('NFKC').toLocaleLowerCase())))
    .slice(0, 50);
  if (matched.length === 0 || maxChars <= 0) return '';
  const lines = ['<current_inventory>', '以下状态仅用于读取当前物品数量，不构成本轮新变动的证据。'];
  for (const item of matched) {
    const itemStates = states.filter(state => state.itemId === item.id);
    const measures = itemStates.length === 0
      ? ['未记录当前数量']
      : itemStates.map((state) => {
          if (state.availability === 'absent') return `${state.measureKind}: 已移除`;
          if (state.amount === undefined || state.precision === 'unknown') return `${state.measureKind}: 数量未知`;
          return `${state.measureKind}: ${state.precision === 'approximate' ? '约' : ''}${state.amount}${state.unit}`;
        });
    const line = `<item name="${inventoryXmlEscape(item.canonicalName)}">${inventoryXmlEscape(measures.join('；'))}</item>`;
    if ([...lines, line, '</current_inventory>'].join('\n').length > maxChars) break;
    lines.push(line);
  }
  if (lines.length === 2) return '';
  lines.push('</current_inventory>');
  return lines.join('\n');
}
