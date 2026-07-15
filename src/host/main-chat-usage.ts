import type { MainChatUsage } from '../domain';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonNegativeInteger(...values: unknown[]): number | null {
  for (const value of values) {
    const numeric = typeof value === 'string' && value.trim() ? Number(value) : value;
    if (typeof numeric === 'number' && Number.isFinite(numeric) && numeric >= 0) return Math.trunc(numeric);
  }
  return null;
}

function text(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (normalized) return normalized;
  }
  return undefined;
}

function safeId(value: string): string {
  return value.replace(/[^\p{L}\p{N}_.:-]+/gu, '_').slice(0, 160);
}

/**
 * 从 SillyTavern generation_ended 与最终消息提取真实 usage。
 * 宿主未提供的字段保持 null；只把 extra.token_count 当作回复 token，绝不冒充总用量。
 */
export function captureMainChatUsage(
  chatKey: string,
  payload: unknown,
  messages: readonly unknown[],
  capturedAt = Date.now(),
): MainChatUsage | null {
  const payloadRecord = record(payload);
  const rawIndex = typeof payload === 'number' || typeof payload === 'string' ? Number(payload) : Number.NaN;
  const indexedMessage = Number.isInteger(rawIndex) && rawIndex >= 0 ? messages[rawIndex] : undefined;
  const message = record(indexedMessage) ?? record(messages.at(-1));
  if (!message || !chatKey.trim()) return null;
  const extra = record(message.extra);
  const usage = record(payloadRecord?.usage) ?? record(record(payloadRecord?.extra)?.usage) ?? record(message.usage) ?? record(extra?.usage);
  const messageId = text(
    payloadRecord?.messageId,
    payloadRecord?.message_id,
    message.mesid,
    message.mes_id,
    message.message_id,
    message.id,
    Number.isInteger(rawIndex) ? `floor-${rawIndex}` : undefined,
  ) ?? `captured-${capturedAt}`;

  const promptTokens = nonNegativeInteger(usage?.promptTokens, usage?.prompt_tokens, usage?.input_tokens, usage?.inputTokens);
  const completionTokens = nonNegativeInteger(
    usage?.completionTokens,
    usage?.completion_tokens,
    usage?.output_tokens,
    usage?.outputTokens,
    extra?.token_count,
  );
  const cacheReadTokens = nonNegativeInteger(
    usage?.cacheReadTokens,
    usage?.cache_read_tokens,
    usage?.prompt_cache_hit_tokens,
    usage?.cache_read_input_tokens,
  );
  const cacheWriteTokens = nonNegativeInteger(
    usage?.cacheWriteTokens,
    usage?.cache_write_tokens,
    usage?.prompt_cache_miss_tokens,
    usage?.cache_creation_input_tokens,
  );
  const reportedTotalTokens = nonNegativeInteger(usage?.totalTokens, usage?.total_tokens);
  const totalTokens = reportedTotalTokens ?? (
    promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null
  );
  const provider = text(usage?.provider, extra?.provider, payloadRecord?.provider);
  const model = text(usage?.model, extra?.model, payloadRecord?.model);

  return {
    id: `main-usage:${safeId(chatKey)}:${safeId(messageId)}`,
    chatKey,
    messageId,
    promptTokens,
    completionTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    capturedAt,
  };
}
