import type {
  InventoryItem,
  InventoryItemCategory,
  InventoryMeasureKind,
  InventoryPrecision,
  InventoryState,
} from '../domain';

export type InventoryWorkbenchScope = 'current' | 'catalog';
export type InventoryWorkbenchSort = 'recent' | 'name' | 'amount' | 'confidence';

export interface InventoryWorkbenchModelInput {
  readonly items: readonly InventoryItem[];
  readonly states: readonly InventoryState[];
  readonly scope: InventoryWorkbenchScope;
  readonly category: InventoryItemCategory | '';
  readonly query: string;
  readonly sort: InventoryWorkbenchSort;
  readonly selectedId: string;
}

export interface InventoryWorkbenchModel {
  readonly statesByItem: ReadonlyMap<string, readonly InventoryState[]>;
  readonly heldItems: readonly InventoryItem[];
  readonly precisionCounts: Readonly<Record<InventoryPrecision, number>>;
  readonly maxCoverageDays?: number;
  readonly scopeItems: readonly InventoryItem[];
  readonly categoryCounts: Readonly<Record<InventoryItemCategory, number>>;
  readonly filteredItems: readonly InventoryItem[];
  readonly selectedId: string;
}

const emptyCategoryCounts = (): Record<InventoryItemCategory, number> => ({
  weapon: 0,
  medicine: 0,
  food: 0,
  armor: 0,
  special: 0,
  core: 0,
  material: 0,
  other: 0,
});

export function latestInventoryState(
  statesByItem: ReadonlyMap<string, readonly InventoryState[]>,
  itemId: string,
  measureKind?: InventoryMeasureKind,
): InventoryState | undefined {
  return [...(statesByItem.get(itemId) ?? [])]
    .filter(state => !measureKind || state.measureKind === measureKind)
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

function sortableQuantityAmount(statesByItem: ReadonlyMap<string, readonly InventoryState[]>, itemId: string): number | undefined {
  const quantity = latestInventoryState(statesByItem, itemId, 'quantity');
  if (!quantity || quantity.availability === 'absent' || quantity.precision === 'unknown' || !Number.isFinite(quantity.amount)) return undefined;
  return quantity.amount;
}

function normalizeSearch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN');
}

export function selectInventoryWorkbenchModel(input: InventoryWorkbenchModelInput): InventoryWorkbenchModel {
  const statesByItem = new Map<string, InventoryState[]>();
  for (const state of input.states) {
    const group = statesByItem.get(state.itemId) ?? [];
    group.push(state);
    statesByItem.set(state.itemId, group);
  }

  const validItems = input.items.filter(item => item.status !== 'invalid');
  const currentItemIds = new Set(input.states.map(state => state.itemId));
  const heldItems = validItems.filter(item => (statesByItem.get(item.id) ?? []).some(state => state.availability !== 'absent'));
  const precisionCounts = heldItems.reduce((counts, item) => {
    const quantity = latestInventoryState(statesByItem, item.id, 'quantity');
    const precision = quantity?.availability === 'absent' ? 'unknown' : quantity?.precision ?? 'unknown';
    counts[precision] += 1;
    return counts;
  }, { exact: 0, approximate: 0, unknown: 0 } satisfies Record<InventoryPrecision, number>);
  const coverageValues = heldItems.flatMap(item => (statesByItem.get(item.id) ?? [])
    .filter(state => state.measureKind === 'coverage_days' && state.availability !== 'absent' && Number.isFinite(state.amount))
    .map(state => state.amount!));
  const scopeItems = validItems.filter(item => input.scope === 'catalog' || currentItemIds.has(item.id));
  const categoryCounts = scopeItems.reduce((counts, item) => {
    counts[item.category] += 1;
    return counts;
  }, emptyCategoryCounts());
  const needle = normalizeSearch(input.query.trim());
  const filteredItems = scopeItems.filter(item => (!input.category || item.category === input.category)
    && (!needle || [item.canonicalName, ...item.aliases].some(name => normalizeSearch(name).includes(needle))))
    .sort((left, right) => {
      if (input.sort === 'name') return left.canonicalName.localeCompare(right.canonicalName, 'zh-CN');
      if (input.sort === 'confidence') return right.confidence - left.confidence || left.canonicalName.localeCompare(right.canonicalName, 'zh-CN');
      if (input.sort === 'amount') {
        const leftAmount = sortableQuantityAmount(statesByItem, left.id);
        const rightAmount = sortableQuantityAmount(statesByItem, right.id);
        if (leftAmount !== undefined && rightAmount !== undefined) return rightAmount - leftAmount || left.canonicalName.localeCompare(right.canonicalName, 'zh-CN');
        if (leftAmount !== undefined) return -1;
        if (rightAmount !== undefined) return 1;
        return left.canonicalName.localeCompare(right.canonicalName, 'zh-CN');
      }
      return (latestInventoryState(statesByItem, right.id)?.updatedAt ?? right.updatedAt)
        - (latestInventoryState(statesByItem, left.id)?.updatedAt ?? left.updatedAt)
        || left.canonicalName.localeCompare(right.canonicalName, 'zh-CN');
    });
  const selectedId = filteredItems.some(item => item.id === input.selectedId) ? input.selectedId : filteredItems[0]?.id ?? '';

  return {
    statesByItem,
    heldItems,
    precisionCounts,
    ...(coverageValues.length ? { maxCoverageDays: Math.max(...coverageValues) } : {}),
    scopeItems,
    categoryCounts,
    filteredItems,
    selectedId,
  };
}
