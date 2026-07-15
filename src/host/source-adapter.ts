import type {
  ChatMessageSnapshot,
  HostCharacterSnapshot,
  HostPersonaSnapshot,
  WorldbookSnapshot,
} from '@ss-helper/sdk';
import type { SourceBlock } from '../application/ingest/types';

export interface MemorySourceGroup {
  id: string;
  kind: SourceBlock['kind'];
  label: string;
  count: number;
  charCount: number;
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

const SKIPPED_STATE_KEYS = new Set(['命运分支', 'schema', 'initialized_lorebooks', '__proto__', 'prototype', 'constructor']);
const MAX_STATE_LEAVES = 160;
const MAX_STATE_VALUE_CHARS = 800;

function flattenStateSnapshot(value: unknown, path: string[], lines: string[], depth = 0): void {
  if (lines.length >= MAX_STATE_LEAVES || depth > 8 || value == null) return;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
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
    if (SKIPPED_STATE_KEYS.has(key)) continue;
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
    const content = text(message.mes ?? message.content ?? message.text);
    if (!content) return [];
    const role = message.is_system === true || message.role === 'system'
      ? 'system'
      : message.role === 'tool' || message.extra && typeof message.extra === 'object' && (message.extra as Record<string, unknown>).type === 'tool'
        ? 'tool'
        : message.is_user === true || message.role === 'user' ? 'user' : 'assistant';
    const hidden = message.is_hidden === true
      || message.hidden === true
      || message.is_reasoning === true
      || Boolean(message.extra && typeof message.extra === 'object' && (message.extra as Record<string, unknown>).hidden === true);
    return [{
      id: `message:${messageId(message, index)}`,
      chatKey,
      kind: 'message',
      role,
      content,
      createdAt: messageCreatedAt(message, index),
      floor: index,
      hidden,
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
  return [{
    id: `character:${character.id}:${contentHash(fields.join('\n'))}`, chatKey, kind: 'character', role: 'metadata',
    content: fields.join('\n'), createdAt: Date.now(), entityKeys: [character.id, character.name].filter(Boolean),
  }];
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
  if (source.kind === 'character') return '角色卡';
  if (source.kind === 'persona') return '用户 Persona';
  const book = source.entityKeys?.[0]?.trim();
  return book ? `世界书：${book}` : '世界书';
}

/** 按用户能理解的来源范围汇总数量和正文规模；世界书按书名拆分。 */
export function summarizeSourceGroups(sources: readonly SourceBlock[]): MemorySourceGroup[] {
  const groups = new Map<string, MemorySourceGroup>();
  for (const source of sources) {
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
    character: 2,
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

/** 读取当前角色、Persona、启用世界书与可见聊天历史。 */
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
