import type {
  ChatMessageSnapshot,
  ChatMessageType,
  HostCharacterSnapshot,
  HostPersonaSnapshot,
  WorldbookSnapshot,
} from '@ss-helper/sdk';
import type { SourceBlock } from '../application/ingest/types';
import { containsSensitiveCredential, isSensitiveStatePath } from '../application/ingest/source-blocks';
import { classifyActorName, classifyLocationName } from '../domain';

export interface MemorySourceGroup {
  id: string;
  kind: SourceBlock['kind'];
  label: string;
  count: number;
  charCount: number;
}

interface SillyTavernMemorySections {
  content: string;
  actorRefs: string[];
  locationRefs: string[];
}

const CAST_HEADER = /^目前已出场角色\s*[：:]\s*(.*)$/u;
const STATE_HEADER = /^状态栏\s*[：:]\s*$/u;
const PLOT_HEADER = /^剧情选项\s*[：:]\s*$/u;
const INVENTORY_HEADER = /^(?:系统商店|物品栏)\s*[：:]/u;
const INVENTORY_ROW = /^(?:武器|药品|食物|防具|特殊道具|低级核心|中级核心|高级核心|顶级核心|特殊核心)\s*[：:]/u;
const STATE_ROW = /^(?:姓名|动作姿势|心情状态|是否发情|所在位置|位置|健康状态|伤势|当前目标|关系状态|装备状态)\s*[：:]/u;
const SECTION_SEPARATOR = /^-{3,}$/u;

function isStrictCastName(value: string): boolean {
  // A cast manifest is an explicit identity declaration. Do not reject valid
  // future names such as 2B/R2-D2 or a character whose name is also a common
  // noun; structural and quantified rows are still rejected by the shared
  // entity-boundary policy.
  return classifyActorName(value, { trust: 'trusted' }).accepted;
}

function splitCastNames(value: string): string[] {
  return [...new Set(value
    .split(/[，,、;；\n]/u)
    .map(item => item.trim().replace(/^[-*•]\s*/u, ''))
    .filter(isStrictCastName))];
}

/**
 * SillyTavern assistant messages often append cast manifests, future plot
 * choices and status panels to the actual prose. Only prose and the current
 * status snapshot are evidence; cast names become trusted directory seeds and
 * future choices are removed completely.
 */
function parseSillyTavernMemorySections(value: string): SillyTavernMemorySections {
  const normalized = value.replace(/\r\n?/gu, '\n').trim();
  const lines = normalized.split('\n');
  const actorRefs = new Set<string>();
  const locationRefs = new Set<string>();
  const inventoryRows: string[] = [];
  const stateRows: string[] = [];
  let metadataStart = lines.length;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    const cast = line.match(CAST_HEADER);
    if (cast) {
      metadataStart = Math.min(metadataStart, index);
      for (const name of splitCastNames(cast[1] ?? '')) actorRefs.add(name);
      // A cast manifest is intentionally tiny: consume only consecutive
      // comma-separated name lines, and stop before inventory/status prose.
      for (let cursor = index + 1; cursor < Math.min(lines.length, index + 4); cursor += 1) {
        const next = lines[cursor]!.trim();
        if (!next || SECTION_SEPARATOR.test(next) || STATE_HEADER.test(next) || PLOT_HEADER.test(next)
          || INVENTORY_HEADER.test(next) || INVENTORY_ROW.test(next)) break;
        const names = splitCastNames(next);
        if (names.length === 0) break;
        names.forEach(name => actorRefs.add(name));
      }
      continue;
    }
    if (STATE_HEADER.test(line) || PLOT_HEADER.test(line) || INVENTORY_HEADER.test(line) || INVENTORY_ROW.test(line)) {
      metadataStart = Math.min(metadataStart, index);
    }
    if (INVENTORY_ROW.test(line)) inventoryRows.push(line);
  }

  const stateIndex = lines.findIndex(line => STATE_HEADER.test(line.trim()));
  if (stateIndex >= 0) {
    for (let index = stateIndex + 1; index < lines.length; index += 1) {
      const line = lines[index]!.trim();
      if (PLOT_HEADER.test(line) || (SECTION_SEPARATOR.test(line) && lines.slice(index + 1, index + 4).some(next => PLOT_HEADER.test(next.trim())))) break;
      if (!line) {
        if (stateRows.at(-1) !== '') stateRows.push('');
        continue;
      }
      if (!STATE_ROW.test(line)) continue;
      stateRows.push(line);
      const name = line.match(/^姓名\s*[：:]\s*(.+)$/u)?.[1]?.trim();
      if (name && isStrictCastName(name)) actorRefs.add(name);
      const location = line.match(/^(?:所在位置|位置)\s*[：:]\s*(.+)$/u)?.[1]?.trim();
      if (location) {
        const decision = classifyLocationName(location, { trust: 'trusted' });
        if (decision.accepted) locationRefs.add(decision.canonicalName);
      }
    }
  }

  const narrativeLines = lines.slice(0, metadataStart);
  while (narrativeLines.length > 0 && (!narrativeLines.at(-1)!.trim() || SECTION_SEPARATOR.test(narrativeLines.at(-1)!.trim()))) narrativeLines.pop();
  let narrative = narrativeLines.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
  if (inventoryRows.length > 0) narrative = `${narrative}\n\n【当前物资快照】\n${uniqueLines(inventoryRows).join('\n')}`.trim();
  const compactState = trimBlankLines(stateRows);
  if (compactState.length > 0) narrative = `${narrative}\n\n【当前状态快照】\n${compactState.join('\n')}`.trim();
  return {
    content: narrative,
    actorRefs: [...actorRefs],
    // Free prose is intentionally not regex-mined for locations. Arbitrary
    // worlds and languages are handled by Claim locationCandidates with exact
    // evidence, while explicit host/state location fields remain trusted.
    locationRefs: [...locationRefs],
  };
}

function uniqueLines(lines: readonly string[]): string[] {
  return [...new Set(lines.map(line => line.trim()).filter(Boolean))];
}

function trimBlankLines(lines: readonly string[]): string[] {
  const result = [...lines];
  while (result[0] === '') result.shift();
  while (result.at(-1) === '') result.pop();
  return result;
}

export interface MemorySourceReader {
  readMessages(): Promise<readonly ChatMessageSnapshot[]>;
  readCharacter(): Promise<HostCharacterSnapshot | null>;
  readPersona(): Promise<HostPersonaSnapshot | null>;
  readActiveWorldbooks(): Promise<readonly WorldbookSnapshot[]>;
}

function text(value: unknown): string {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim();
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => text(item)).filter(Boolean) : typeof value === 'string' ? value.split(/[，,;；\n]/u).map(item => text(item)).filter(Boolean) : [];
}

function messageId(message: Record<string, unknown>, index: number): string {
  return text(message.mesid ?? message.mes_id ?? message.message_id ?? message.id) || `floor-${index}`;
}

function messageCreatedAt(message: Record<string, unknown>, index: number): number {
  const value = message.send_date ?? message.createdAt;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return index;
}

function contentHash(value: string): string {
  let hash = 0x811c9dc5;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function sourceAuthor(message: Record<string, unknown>, messageType: ChatMessageType): SourceBlock['author'] {
  const extra = message.extra && typeof message.extra === 'object' ? message.extra as Record<string, unknown> : undefined;
  const typedAuthor = message.author && typeof message.author === 'object' ? message.author as Record<string, unknown> : undefined;
  const originalAvatar = text(message.original_avatar ?? message.originalAvatar ?? typedAuthor?.originalAvatar ?? extra?.original_avatar);
  const avatar = text(message.avatar ?? typedAuthor?.avatar ?? extra?.avatar);
  const displayName = text(message.name ?? message.displayName ?? typedAuthor?.displayName);
  const kind = messageType === 'narrator' || typedAuthor?.kind === 'narrator'
    ? 'narrator'
    : messageType === 'system' ? 'system' : message.is_user === true || message.role === 'user' ? 'user' : 'assistant';
  return {
    kind,
    ...(displayName ? { displayName } : {}),
    ...(avatar ? { avatar } : {}),
    ...(originalAvatar ? { originalAvatar } : {}),
  };
}

const SKIPPED_STATE_KEYS = new Set(['命运分支', 'schema', 'initialized_lorebooks', '__proto__', 'prototype', 'constructor']);
const MAX_STATE_LEAVES = 160;
const MAX_STATE_VALUE_CHARS = 800;

function flattenStateSnapshot(value: unknown, path: string[], lines: string[], depth = 0): void {
  if (lines.length >= MAX_STATE_LEAVES || depth > 8 || value == null) return;
  if (isSensitiveStatePath(path)) return;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (containsSensitiveCredential(value)) return;
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    const normalized = text(serialized).slice(0, MAX_STATE_VALUE_CHARS);
    if (path.length > 0 && normalized) lines.push(`状态快照\t${path.join(' / ')}\t${normalized}`);
    return;
  }
  if (Array.isArray(value)) {
    const serialized = JSON.stringify(value);
    if (path.length > 0 && serialized.length <= MAX_STATE_VALUE_CHARS) lines.push(`状态快照\t${path.join(' / ')}\t${serialized}`);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SKIPPED_STATE_KEYS.has(key) || isSensitiveStatePath([...path, key])) continue;
    flattenStateSnapshot(child, [...path, key], lines, depth + 1);
    if (lines.length >= MAX_STATE_LEAVES) break;
  }
}

/** 读取最后一条宿主变量快照，作为独立、可审计的当前状态来源。 */
export function buildLatestVariableStateBlock(chatKey: string, rawMessages: readonly unknown[]): SourceBlock[] {
  for (let index = rawMessages.length - 1; index >= 0; index -= 1) {
    const value = rawMessages[index];
    if (!value || typeof value !== 'object') continue;
    const message = value as Record<string, unknown>;
    const variables = Array.isArray(message.variables) ? message.variables : [];
    const snapshot = [...variables].reverse().find(item => item && typeof item === 'object' && (item as Record<string, unknown>).stat_data);
    const statData = snapshot && typeof snapshot === 'object' ? (snapshot as Record<string, unknown>).stat_data : undefined;
    if (!statData || typeof statData !== 'object') continue;
    const lines: string[] = [];
    flattenStateSnapshot(statData, [], lines);
    if (lines.length === 0) return [];
    const content = lines.join('\n');
    return [{
      id: `state:${messageId(message, index)}:${contentHash(content)}`,
      chatKey,
      kind: 'state',
      role: 'metadata',
      content,
      createdAt: messageCreatedAt(message, index),
      floor: index,
      entityKeys: ['当前变量状态'],
    }];
  }
  return [];
}

export function buildVisibleChatSourceBlocks(chatKey: string, rawMessages: readonly unknown[]): SourceBlock[] {
  return rawMessages.flatMap((value, index): SourceBlock[] => {
    if (!value || typeof value !== 'object') return [];
    const message = value as Record<string, unknown>;
    const rawContent = text(message.mes ?? message.content ?? message.text);
    if (!rawContent) return [];
    const sections = parseSillyTavernMemorySections(rawContent);
    const content = sections.content;
    if (!content && sections.actorRefs.length === 0) return [];
    const extra = message.extra && typeof message.extra === 'object' ? message.extra as Record<string, unknown> : undefined;
    const messageType: ChatMessageType = message.messageType === 'tool' || message.role === 'tool' || extra?.type === 'tool'
      ? 'tool'
      : message.messageType === 'reasoning' || message.is_reasoning === true
        ? 'reasoning'
        : message.messageType === 'narrator' || message.role === 'narrator' || extra?.type === 'narrator' || message.is_narrator === true
          ? 'narrator'
        : message.messageType === 'system' || message.is_system === true || message.role === 'system'
          ? 'system'
          : 'conversation';
    const role = messageType === 'system'
      ? 'system'
      : messageType === 'tool'
        ? 'tool'
        : message.is_user === true || message.role === 'user' ? 'user' : 'assistant';
    const explicitHidden = message.is_hidden === true
      || message.hidden === true
      || Boolean(extra?.hidden === true);
    const hidden = messageType !== 'system' && (explicitHidden || message.visibleToAi === false || messageType === 'tool' || messageType === 'reasoning');
    const actorRefs = [...new Set([
      ...textList(message.actorRefs ?? message.actor_refs ?? extra?.actorRefs ?? extra?.actor_refs),
      ...sections.actorRefs,
    ])];
    const speakerOwnerRef = text(message.speakerActorId ?? message.speakerOwnerId ?? message.speakerName ?? extra?.speakerActorId ?? extra?.speakerOwnerId);
    const viewpointOwnerRef = text(message.perspectiveActorId ?? message.viewpointOwnerId ?? extra?.perspectiveActorId ?? extra?.viewpointOwnerId);
    const observerOwnerRefs = textList(message.observerActorIds ?? message.observerOwnerIds ?? extra?.observerActorIds ?? extra?.observerOwnerIds);
    const mentionedOwnerRefs = textList(message.mentionedActorIds ?? message.mentionedOwnerIds ?? extra?.mentionedActorIds ?? extra?.mentionedOwnerIds);
    const presentOwnerRefs = textList(message.presentActorIds ?? message.presentOwnerIds ?? extra?.presentActorIds ?? extra?.presentOwnerIds);
    const perspective = speakerOwnerRef || viewpointOwnerRef || observerOwnerRefs.length > 0 || mentionedOwnerRefs.length > 0 || presentOwnerRefs.length > 0
      ? {
        ...(speakerOwnerRef ? { speakerOwnerRef } : {}),
        ...(viewpointOwnerRef ? { viewpointOwnerRef } : {}),
        ...(observerOwnerRefs.length > 0 ? { observerOwnerRefs } : {}),
        ...(mentionedOwnerRefs.length > 0 ? { mentionedOwnerRefs } : {}),
        ...(presentOwnerRefs.length > 0 ? { presentOwnerRefs } : {}),
        confidence: 1,
      }
      : undefined;
    const sceneRefs = textList(message.sceneRefs ?? message.sceneIds ?? extra?.sceneRefs ?? extra?.sceneIds);
    const enteredOwnerRefs = textList(message.enteredActorIds ?? message.enteredOwnerIds ?? extra?.enteredActorIds ?? extra?.enteredOwnerIds);
    const exitedOwnerRefs = textList(message.exitedActorIds ?? message.exitedOwnerIds ?? extra?.exitedActorIds ?? extra?.exitedOwnerIds);
    const nearbyOwnerRefs = textList(message.nearbyActorIds ?? message.nearbyOwnerIds ?? extra?.nearbyActorIds ?? extra?.nearbyOwnerIds);
    const locationKeys = [...new Set([
      ...textList(message.locationKeys ?? message.locationKey ?? message.location ?? extra?.locationKeys ?? extra?.locationKey ?? extra?.location),
      ...sections.locationRefs,
    ])];
    const timeJump = message.timeJump === true || extra?.timeJump === true;
    const sceneReset = message.sceneReset === true || extra?.sceneReset === true;
    const transition = enteredOwnerRefs.length > 0 || exitedOwnerRefs.length > 0 || nearbyOwnerRefs.length > 0 || locationKeys.length > 0 || timeJump || sceneReset
      ? {
        ...(enteredOwnerRefs.length > 0 ? { enteredOwnerRefs } : {}),
        ...(exitedOwnerRefs.length > 0 ? { exitedOwnerRefs } : {}),
        ...(nearbyOwnerRefs.length > 0 ? { nearbyOwnerRefs } : {}),
        ...(locationKeys.length > 0 ? { locationKeys } : {}),
        ...(timeJump ? { timeJump: true } : {}),
        ...(sceneReset ? { sceneReset: true } : {}),
        confidence: 1,
      }
      : undefined;
    return [{
      id: `message:${messageId(message, index)}`,
      chatKey,
      kind: 'message',
      role,
      content,
      createdAt: messageCreatedAt(message, index),
      floor: index,
      ...(messageType === 'conversation' ? {} : { messageType }),
      hidden,
      author: sourceAuthor(message, messageType),
      visibility: messageType === 'system' ? 'control' : hidden ? 'hidden' : 'visible',
      ...(actorRefs.length > 0 ? { actorRefs } : {}),
      ...(locationKeys.length > 0 ? { locationRefs: locationKeys } : {}),
      semanticSection: 'narrative',
      ...(perspective ? { perspective } : {}),
      ...(transition ? { transition } : {}),
      ...(sceneRefs.length > 0 ? { sceneRefs } : {}),
    }];
  });
}

function buildSdkCharacterBlock(chatKey: string, character: HostCharacterSnapshot | null): SourceBlock[] {
  if (!character) return [];
  const fields = [
    ['角色名', character.name], ['描述', character.description], ['性格', character.personality],
    ['场景', character.scenario], ['开场白', character.firstMessage],
  ].filter((item) => text(item[1])).map(([label, value]) => `${label}：${text(value)}`);
  if (fields.length === 0) return [];
  const hostCard: SourceBlock = {
    id: `host_card:${character.id}:${contentHash(fields.join('\n'))}`, chatKey, kind: 'host_card', role: 'metadata',
    content: fields.join('\n'), createdAt: Date.now(), entityKeys: [character.id, character.name].filter(Boolean),
    author: { kind: 'assistant', displayName: character.name, ...(character.avatar ? { avatar: character.avatar } : {}) },
  };
  return [hostCard];
}

function buildSdkPersonaBlock(chatKey: string, persona: HostPersonaSnapshot | null): SourceBlock[] {
  const content = text(persona?.description);
  if (!persona || !content) return [];
  return [{
    id: `persona:${persona.id ?? persona.name}:${contentHash(content)}`, chatKey, kind: 'persona', role: 'metadata',
    content: `用户名：${persona.name}\nPersona：${content}`, createdAt: Date.now(), entityKeys: [persona.name],
  }];
}

function buildSdkWorldbookBlocks(chatKey: string, books: readonly WorldbookSnapshot[]): SourceBlock[] {
  return books.flatMap((book) => (book.entries ?? []).filter((entry) => entry.enabled).map((entry) => ({
    id: `worldbook:${book.id}:${entry.id}:${contentHash(entry.content)}`,
    chatKey,
    kind: 'worldbook' as const,
    role: 'metadata' as const,
    content: entry.content,
    createdAt: Date.now(),
    entityKeys: [book.name, ...entry.keys].filter(Boolean),
  })));
}

function sourceGroupId(source: SourceBlock): string {
  if (source.kind !== 'worldbook') return source.kind;
  const book = source.entityKeys?.[0]?.trim();
  return book ? `worldbook:${book}` : 'worldbook';
}

function sourceGroupLabel(source: SourceBlock): string {
  if (source.kind === 'message') return '聊天消息';
  if (source.kind === 'state') return '最新变量状态';
  if (source.kind === 'host_card') return '角色卡世界容器';
  if (source.kind === 'persona') return '用户 Persona';
  const book = source.entityKeys?.[0]?.trim();
  return book ? `世界书：${book}` : '世界书';
}

/** 按用户能理解的来源范围汇总数量和正文规模；世界书按书名拆分。 */
export function summarizeSourceGroups(sources: readonly SourceBlock[]): MemorySourceGroup[] {
  const groups = new Map<string, MemorySourceGroup>();
  for (const source of sources) {
    if (source.hidden && source.kind === 'host_card') continue;
    const id = sourceGroupId(source);
    const current = groups.get(id);
    if (current) {
      current.count += 1;
      current.charCount += source.content.length;
      continue;
    }
    groups.set(id, {
      id,
      kind: source.kind,
      label: sourceGroupLabel(source),
      count: 1,
      charCount: source.content.length,
    });
  }
  const order: Readonly<Record<SourceBlock['kind'], number>> = {
    message: 0,
    state: 1,
    host_card: 2,
    persona: 3,
    worldbook: 4,
  };
  return [...groups.values()].sort((left, right) => order[left.kind] - order[right.kind] || left.label.localeCompare(right.label, 'zh-CN'));
}

/** 根据设置页勾选的来源组裁剪初始化输入；空数组表示用户明确不选择任何来源。 */
export function selectSourceGroups(sources: readonly SourceBlock[], selectedGroupIds?: readonly string[]): SourceBlock[] {
  if (selectedGroupIds === undefined) return [...sources];
  const selected = new Set(selectedGroupIds);
  return sources.filter((source) => selected.has(sourceGroupId(source)));
}

/** 读取当前角色、Persona、启用世界书与完整聊天历史；可见性由后续过滤选项决定。 */
export async function collectCurrentChatSources(chatKey: string, reader: MemorySourceReader): Promise<SourceBlock[]> {
  const [messages, character, persona, books] = await Promise.all([
    reader.readMessages(), reader.readCharacter(), reader.readPersona(), reader.readActiveWorldbooks(),
  ]);
  return [
    ...buildSdkCharacterBlock(chatKey, character),
    ...buildSdkPersonaBlock(chatKey, persona),
    ...buildSdkWorldbookBlocks(chatKey, books),
    ...buildVisibleChatSourceBlocks(chatKey, messages),
    ...buildLatestVariableStateBlock(chatKey, messages),
  ];
}
