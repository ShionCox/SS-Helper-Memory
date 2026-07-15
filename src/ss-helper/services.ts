import { MEMORY_RECALL_V1, MEMORY_UPDATED_V1, type MemoryUpdatedPayload, type PluginSession } from '@ss-helper/sdk';

interface MemoryRecallResult {
  readonly items: readonly {
    readonly fact: {
      readonly id: string;
      readonly content: string;
      readonly sourceRefs?: readonly string[];
    };
    readonly score: number;
  }[];
}

export interface MemoryRecallController {
  getChatKey(): string;
  recall: { preview(input: { query: string; maxItems?: number }): Promise<MemoryRecallResult> };
}

export function registerMemoryServices(
  session: PluginSession,
  controller: MemoryRecallController,
): { dispose(): void; publishUpdated(payload: MemoryUpdatedPayload): void } {
  const disposeRecall = session.services.expose(MEMORY_RECALL_V1, async (request, context) => {
    context.signal.throwIfAborted();
    if (request.chatKey !== controller.getChatKey()) return { items: [] };
    const result = await controller.recall.preview({ query: request.query, maxItems: request.limit });
    context.signal.throwIfAborted();
    return {
      items: result.items.map((item) => ({
        id: item.fact.id,
        text: item.fact.content,
        score: item.score,
        source: item.fact.sourceRefs?.[0],
      })),
    };
  });
  return {
    dispose: disposeRecall,
    publishUpdated: (payload) => session.events.publish(MEMORY_UPDATED_V1, payload),
  };
}
