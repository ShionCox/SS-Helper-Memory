export function getSillyTavernContextEvent() {
  return { getRequestHeaders: () => ({}) };
}
export function buildSdkChatIdEvent() { return 'baseline-chat'; }
export function getCurrentTavernCharacterSnapshotEvent() { return null; }
export function getCurrentTavernUserSnapshotEvent() { return null; }
export function listTavernActiveWorldbooksEvent() { return []; }
export function loadTavernWorldbookEntriesEvent() { return []; }
export function getTavernEventSourceEvent() { return null; }
export function getTavernEventTypesEvent() { return {}; }
export function getTavernCurrentModel() { return ''; }
export function getTavernMessageTextEvent(value: unknown) {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return String(record.content ?? record.mes ?? record.text ?? '');
  }
  return String(value ?? '');
}
export function getTavernRuntimeContextEvent() { return {}; }
export function listTavernPromptTargetsEvent(payload: unknown) {
  if (!payload || typeof payload !== 'object') return [];
  const messages = (payload as { messages?: unknown }).messages;
  return Array.isArray(messages) ? [{ messages }] : [];
}
export function getTavernPromptMessageTextEvent(message: unknown) {
  return getTavernMessageTextEvent(message);
}
export function insertTavernPromptSystemMessageEvent(
  messages: unknown[],
  options: { text?: string; insertBeforeIndex?: number },
) {
  const index = Number.isInteger(options.insertBeforeIndex) ? Number(options.insertBeforeIndex) : messages.length;
  messages.splice(index, 0, { role: 'system', content: String(options.text ?? '') });
}

