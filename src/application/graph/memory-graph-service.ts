import {
  deriveMemoryGraphProjection,
  type MemoryGraphPreview,
  type MemoryGraphStatus,
  type MemoryGraphProjection,
} from '../../domain';
import { MemoryRepository } from '../../infrastructure';
import {
  MemoryGraphRecallIndex,
  type GraphRecallCandidateProvider,
  type GraphRecallSearchInput,
  type GraphRecallSearchResult,
} from './graph-recall-index';

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function clampPreviewLimit(value: number | undefined): number {
  return Math.min(50, Math.max(1, Math.trunc(value ?? 12)));
}

// Graph status can reach the settings UI and plugin API. Do not surface a
// storage/provider exception there because it may contain host diagnostics.
const GRAPH_DEGRADED_MESSAGE = '关系图谱协调暂时不可用。';

function emptyStatus(chatKey: string, enabled: boolean): MemoryGraphStatus {
  return {
    chatKey,
    enabled,
    phase: enabled ? 'idle' : 'disabled',
    nodeCount: 0,
    edgeCount: 0,
    updatedAt: Date.now(),
  };
}

/**
 * Coordinates a reconstructible graph cache outside fact transactions. A graph
 * failure is recorded here and intentionally never rejects fact capture.
 */
export class MemoryGraphService implements GraphRecallCandidateProvider {
  private readonly statuses = new Map<string, MemoryGraphStatus>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly dirtyChats = new Set<string>();
  private readonly disabledChats = new Set<string>();
  private readonly statusListeners = new Set<(status: MemoryGraphStatus) => void>();

  constructor(private readonly repository: MemoryRepository) {}

  onStatusChanged(listener: (status: MemoryGraphStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(chatKey: string, status: MemoryGraphStatus): void {
    this.statuses.set(chatKey, status);
    // Status observers are presentation-only. A UI subscriber must never be
    // able to make fact capture or graph reconciliation fail.
    for (const listener of this.statusListeners) {
      try { listener(structuredClone(status)); } catch { /* isolate observers */ }
    }
  }

  getStatus(chatKey: string, enabled = true): MemoryGraphStatus {
    const current = this.statuses.get(chatKey);
    if (!enabled) {
      // This is a read path used synchronously by settings status/field-state
      // adapters. Publishing from it re-enters those adapters through the
      // status listener and can spin the renderer before a chat is selected.
      // State transitions are published by schedule()/rebuild(), never reads.
      return structuredClone({ ...(current ?? emptyStatus(chatKey, false)), enabled: false, phase: 'disabled' as const });
    }
    return structuredClone(current ?? emptyStatus(chatKey, true));
  }

  schedule(chatKey: string, enabled = true): void {
    if (!enabled) {
      this.disabledChats.add(chatKey);
      this.dirtyChats.delete(chatKey);
      this.getStatus(chatKey, false);
      return;
    }
    this.disabledChats.delete(chatKey);
    const previous = this.pending.get(chatKey);
    if (previous) {
      // A fact transaction can finish while a projection snapshot is being
      // read. Coalesce it into one deterministic follow-up reconciliation.
      this.dirtyChats.add(chatKey);
      return;
    }
    this.setStatus(chatKey, { ...this.getStatus(chatKey, true), enabled: true, phase: 'queued', updatedAt: Date.now() });
    const task = Promise.resolve()
      .then(async () => { await this.rebuild(chatKey, !this.disabledChats.has(chatKey)); })
      .catch(() => {
        const current = this.getStatus(chatKey, true);
        this.setStatus(chatKey, {
          ...current,
          phase: 'degraded',
          updatedAt: Date.now(),
          lastError: GRAPH_DEGRADED_MESSAGE,
        });
      })
      .finally(() => {
        this.pending.delete(chatKey);
        if (this.dirtyChats.delete(chatKey) && !this.disabledChats.has(chatKey)) this.schedule(chatKey, true);
      });
    this.pending.set(chatKey, task);
  }

  async rebuild(chatKey: string, enabled = true): Promise<MemoryGraphStatus> {
    if (!enabled) return this.getStatus(chatKey, false);
    const before = this.getStatus(chatKey, true);
    this.setStatus(chatKey, { ...before, enabled: true, phase: 'rebuilding', updatedAt: Date.now(), lastError: undefined });
    try {
      const facts = await this.repository.listFacts(chatKey);
      const projection = deriveMemoryGraphProjection(facts);
      await this.repository.reconcileGraphProjection(chatKey, projection);
      if (this.disabledChats.has(chatKey)) return this.getStatus(chatKey, false);
      const ready: MemoryGraphStatus = {
        chatKey,
        enabled: true,
        phase: 'ready',
        nodeCount: projection.nodes.length,
        edgeCount: projection.edges.length,
        updatedAt: Date.now(),
        lastRebuiltAt: Date.now(),
      };
      this.setStatus(chatKey, ready);
      return structuredClone(ready);
    } catch (error) {
      const degraded: MemoryGraphStatus = {
        ...before,
        chatKey,
        enabled: true,
        phase: 'degraded',
        updatedAt: Date.now(),
        lastError: GRAPH_DEGRADED_MESSAGE,
      };
      this.setStatus(chatKey, degraded);
      throw error;
    }
  }

  /** Read only the fact-validated persisted projection; stale cache degrades to no graph signal. */
  private async loadVerifiedProjection(chatKey: string): Promise<MemoryGraphProjection> {
    const [facts, persisted] = await Promise.all([
      this.repository.listFacts(chatKey),
      this.repository.getGraphProjection(chatKey),
    ]);
    const expected = deriveMemoryGraphProjection(facts);
    const nodes = new Map(persisted.nodes.map((node) => [node.id, node]));
    const edges = new Map(persisted.edges.map((edge) => [edge.id, edge]));
    const verifiedNodes = expected.nodes.filter((node) => sameJson(nodes.get(node.id), node));
    const verifiedNodeIds = new Set(verifiedNodes.map((node) => node.id));
    const verifiedEdges = expected.edges.filter((edge) => sameJson(edges.get(edge.id), edge)
      && verifiedNodeIds.has(edge.fromNodeId) && verifiedNodeIds.has(edge.toNodeId));
    return { nodes: Object.freeze(verifiedNodes), edges: Object.freeze(verifiedEdges) };
  }

  async search(input: GraphRecallSearchInput): Promise<GraphRecallSearchResult> {
    const projection = await this.loadVerifiedProjection(input.chatKey);
    return new MemoryGraphRecallIndex(projection).search(input);
  }

  async preview(chatKey: string, query: string, limit?: number, enabled = true): Promise<MemoryGraphPreview> {
    if (!enabled) return { nodes: Object.freeze([]), edges: Object.freeze([]) };
    const projection = await this.loadVerifiedProjection(chatKey);
    const needle = query.normalize('NFKC').trim().toLocaleLowerCase();
    const matched = projection.edges.filter((edge) => {
      if (!needle) return true;
      const from = projection.nodes.find((node) => node.id === edge.fromNodeId)?.label ?? '';
      const to = projection.nodes.find((node) => node.id === edge.toNodeId)?.label ?? '';
      return [from, to, edge.predicateKey, edge.kind]
        .some((value) => value.normalize('NFKC').toLocaleLowerCase().includes(needle));
    }).slice(0, clampPreviewLimit(limit));
    const nodeIds = new Set(matched.flatMap((edge) => [edge.fromNodeId, edge.toNodeId]));
    return {
      nodes: Object.freeze(projection.nodes
        .filter((node) => nodeIds.has(node.id))
        .map((node) => Object.freeze({ id: node.id, label: node.label }))),
      edges: Object.freeze(matched.map((edge) => Object.freeze({
        id: edge.id,
        from: edge.fromNodeId,
        to: edge.toNodeId,
        predicate: edge.predicateKey,
        kind: edge.kind,
        status: edge.status,
        confidence: edge.confidence,
        backingFactId: edge.backingFactId,
      }))),
    };
  }
}
