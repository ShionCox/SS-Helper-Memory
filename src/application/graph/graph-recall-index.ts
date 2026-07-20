import {
  graphNodeId,
  normalizeGraphEntityKey,
  type MemoryGraphEdge,
  type MemoryGraphProjection,
} from '../../domain';

export interface GraphRecallSearchInput {
  chatKey: string;
  query: string;
  /** Entity keys from the already-produced lexical/vector candidate set. */
  seedEntityKeys: readonly string[];
  maxHops: 1 | 2;
  maxEdges: number;
}

export interface GraphRecallCandidate {
  factId: string;
  score: number;
  rank: number;
}

export interface GraphRecallSearchResult {
  candidates: readonly GraphRecallCandidate[];
  seedNodeCount: number;
  edgeHitCount: number;
  latencyMs: number;
}

/** A small abstraction keeps the recall orchestration independent of storage. */
export interface GraphRecallCandidateProvider {
  search(input: GraphRecallSearchInput): Promise<GraphRecallSearchResult>;
}

function clampEdges(value: number): number {
  return Math.min(24, Math.max(4, Math.trunc(value)));
}

function queryTokens(value: string): readonly string[] {
  return value.normalize('NFKC').toLocaleLowerCase()
    .split(/[^\p{L}\p{N}_:-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function edgeOrder(left: MemoryGraphEdge, right: MemoryGraphEdge): number {
  return right.confidence - left.confidence
    || right.updatedAt - left.updatedAt
    || left.id.localeCompare(right.id);
}

/**
 * Pure in-memory literal graph traversal. It does not infer aliases or create
 * facts; it only nominates backing fact ids for the normal recall hard filters.
 */
export class MemoryGraphRecallIndex implements GraphRecallCandidateProvider {
  private readonly nodes;
  private readonly edges;
  private readonly adjacency = new Map<string, MemoryGraphEdge[]>();

  constructor(projection: MemoryGraphProjection) {
    this.nodes = new Map(projection.nodes.map((node) => [node.id, node]));
    this.edges = projection.edges.filter((edge) => {
      const from = this.nodes.get(edge.fromNodeId);
      const to = this.nodes.get(edge.toNodeId);
      return from?.chatKey === edge.chatKey && to?.chatKey === edge.chatKey
        && edge.status === 'active' && Number.isFinite(edge.confidence) && edge.confidence >= 0.75;
    });
    for (const edge of this.edges) {
      const from = this.adjacency.get(edge.fromNodeId) ?? [];
      from.push(edge);
      this.adjacency.set(edge.fromNodeId, from);
      const to = this.adjacency.get(edge.toNodeId) ?? [];
      to.push(edge);
      this.adjacency.set(edge.toNodeId, to);
    }
    for (const values of this.adjacency.values()) values.sort(edgeOrder);
  }

  async search(input: GraphRecallSearchInput): Promise<GraphRecallSearchResult> {
    const startedAt = Date.now();
    const maxEdges = clampEdges(input.maxEdges);
    const normalizedQuery = input.query.normalize('NFKC').toLocaleLowerCase();
    const tokens = queryTokens(input.query);
    const seedIds = new Set<string>();
    for (const value of input.seedEntityKeys) {
      const entityKey = normalizeGraphEntityKey(value);
      if (!entityKey) continue;
      const id = graphNodeId(input.chatKey, entityKey);
      if (this.nodes.get(id)?.chatKey === input.chatKey) seedIds.add(id);
    }
    // When lexical/vector facts did not expose an entity key, a literal query
    // match remains useful. This is string matching, never semantic matching.
    for (const node of this.nodes.values()) {
      if (node.chatKey !== input.chatKey || seedIds.size >= 8) continue;
      const label = node.label.normalize('NFKC').toLocaleLowerCase();
      if (label && (normalizedQuery.includes(label) || tokens.some((token) => label.includes(token)))) {
        seedIds.add(node.id);
      }
    }
    const seeds = [...seedIds].sort().slice(0, 8);
    if (seeds.length === 0) {
      return { candidates: Object.freeze([]), seedNodeCount: 0, edgeHitCount: 0, latencyMs: Date.now() - startedAt };
    }

    const candidateScores = new Map<string, number>();
    const visitedNodes = new Set(seeds);
    const visitedEdges = new Set<string>();
    let frontier = seeds;
    let edgeHitCount = 0;
    for (let hop = 1; hop <= input.maxHops && frontier.length > 0 && edgeHitCount < maxEdges; hop += 1) {
      const next = new Set<string>();
      const candidates = frontier.flatMap((nodeId) => this.adjacency.get(nodeId) ?? [])
        .filter((edge) => edge.chatKey === input.chatKey && !visitedEdges.has(edge.id))
        .sort(edgeOrder);
      for (const edge of candidates) {
        if (edgeHitCount >= maxEdges) break;
        visitedEdges.add(edge.id);
        edgeHitCount += 1;
        const previous = candidateScores.get(edge.backingFactId) ?? 0;
        const score = (1 / hop) * Math.max(0.01, Math.min(1, edge.confidence));
        candidateScores.set(edge.backingFactId, Math.max(previous, score));
        const other = frontier.includes(edge.fromNodeId) ? edge.toNodeId : edge.fromNodeId;
        if (!visitedNodes.has(other)) {
          visitedNodes.add(other);
          next.add(other);
        }
      }
      frontier = [...next].sort();
    }
    const candidates = [...candidateScores.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([factId, score], index) => Object.freeze({ factId, score, rank: index + 1 }));
    return {
      candidates: Object.freeze(candidates),
      seedNodeCount: seeds.length,
      edgeHitCount,
      latencyMs: Date.now() - startedAt,
    };
  }
}
