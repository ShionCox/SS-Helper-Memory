import { MEMORY_GRAPH_V0, MEMORY_RECALL_V0, MEMORY_UPDATED_V0, type MemoryUpdatedPayload, type PluginSession } from '@ss-helper/sdk';

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
  graph?: {
    preview(input: { chatKey: string; query: string; limit?: number }): Promise<{
      nodes: readonly { id: string; label: string }[];
      edges: readonly { id: string; from: string; to: string; predicate: string; kind: string; confidence: number; backingFactId: string }[];
    }>;
  };
}

export function registerMemoryServices(
  session: PluginSession,
  controller: MemoryRecallController,
): { dispose(): void; publishUpdated(payload: MemoryUpdatedPayload): void } {
  const disposeRecall = session.services.expose(MEMORY_RECALL_V0, async (request, context) => {
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
  const disposeGraph = session.services.expose(MEMORY_GRAPH_V0, async (request, context) => {
    context.signal.throwIfAborted();
    if (request.chatKey !== controller.getChatKey()) return { nodes: [], edges: [] };
    if (!controller.graph) return { nodes: [], edges: [] };
    const graph = await controller.graph.preview({ chatKey: request.chatKey, query: request.query, limit: request.limit });
    context.signal.throwIfAborted();
    // Contract DTO is intentionally safe: no evidence excerpts, prompt text,
    // database chat keys, or internal status fields leave the plugin.
    return {
      nodes: graph.nodes.map((node) => ({ id: node.id, label: node.label })),
      edges: graph.edges.map((edge) => ({
        id: edge.id,
        from: edge.from,
        to: edge.to,
        predicate: edge.predicate,
        kind: edge.kind,
        confidence: edge.confidence,
        backingFactId: edge.backingFactId,
      })),
    };
  });
  return {
    dispose: () => { disposeGraph(); disposeRecall(); },
    publishUpdated: (payload) => session.events.publish(MEMORY_UPDATED_V0, payload),
  };
}
