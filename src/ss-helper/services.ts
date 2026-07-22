import { MEMORY_GRAPH_V0, MEMORY_RECALL_V0, MEMORY_UPDATED_V0, type MemoryRecallMode, type MemoryRecallPartition, type MemoryRecallResponse, type MemoryUpdatedPayload, type PluginSession } from '@ss-helper/sdk';

export interface MemoryRecallController {
  getChatKey(): string;
  /** v0 multi-actor recall. The adapter redacts domain packets before crossing SDK. */
  recallActors: (input: {
    query: string;
    chatKey: string;
    sceneOwnerIds: readonly string[];
    presentOwnerIds: readonly string[];
    viewpointOwnerId: string;
    mode: MemoryRecallMode;
    maxItems?: number;
    sceneEpoch?: string;
  }) => Promise<unknown>;
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
  const emptyPartition = (ownerId: string, owner: string): MemoryRecallPartition => ({ ownerId, owner, memories: [] });
  const normalizePartition = (value: unknown, ownerId: string, owner: string): MemoryRecallPartition => {
    if (!value || typeof value !== 'object') return emptyPartition(ownerId, owner);
    const row = value as { ownerId?: unknown; ownerName?: unknown; owner?: unknown; packets?: unknown; memories?: unknown };
    const packets = Array.isArray(row.memories) ? row.memories : Array.isArray(row.packets) ? row.packets : [];
    const memories = packets.flatMap((packet): Array<{ text: string; confidence: number; strength?: number }> => {
      if (!packet || typeof packet !== 'object') return [];
      const item = packet as { text?: unknown; gist?: unknown; effectiveStrength?: unknown; clarity?: unknown };
      const text = String(item.text ?? item.gist ?? '').trim();
      if (!text) return [];
      const strength = Number(item.effectiveStrength);
      return [{ text, confidence: Number.isFinite(strength) ? Math.max(0, Math.min(1, strength / 100)) : 0, ...(Number.isFinite(strength) ? { strength: Math.max(0, Math.min(100, strength)) } : {}) }];
    });
    return { ownerId: String(row.ownerId ?? ownerId), owner: String(row.ownerName ?? row.owner ?? owner), memories };
  };
  const normalizeActorResponse = (value: unknown, mode: MemoryRecallMode): MemoryRecallResponse => {
    if (!value || typeof value !== 'object') return { mode, world: emptyPartition('owner:world', '世界'), narrator: emptyPartition('owner:narrator', '旁白'), actors: [] };
    const row = value as { mode?: unknown; world?: unknown; narrator?: unknown; actors?: unknown };
    const actors = Array.isArray(row.actors) ? row.actors.map((item) => normalizePartition(item, 'owner:unknown', '未知主体')) : [];
    return {
      mode: row.mode === 'strict_pov' || row.mode === 'omniscient' || row.mode === 'multi_actor' ? row.mode : mode,
      world: normalizePartition(row.world, 'owner:world', '世界'),
      narrator: normalizePartition(row.narrator, 'owner:narrator', '旁白'),
      actors,
    };
  };
  const disposeRecall = session.services.expose(MEMORY_RECALL_V0, async (request, context) => {
    context.signal.throwIfAborted();
    if (request.chatKey !== controller.getChatKey()) return normalizeActorResponse(undefined, request.mode);
    const actorResult = await controller.recallActors({
      query: request.query,
      chatKey: request.chatKey,
      sceneOwnerIds: request.sceneOwnerIds,
      presentOwnerIds: request.presentOwnerIds,
      viewpointOwnerId: request.viewpointOwnerId,
      mode: request.mode,
      maxItems: request.maxItems,
      sceneEpoch: request.sceneEpoch,
    });
    context.signal.throwIfAborted();
    return normalizeActorResponse(actorResult, request.mode);
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
