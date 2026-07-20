import {
  ACTIVE_CONFIDENCE_THRESHOLD,
  type FactStatus,
  type MemoryFact,
  type MemoryFactKind,
} from './memory-types';

/**
 * A graph node is a literal entity key scoped to one chat.  `entityKey` is
 * deliberately not an alias key: only NFKC and whitespace normalization are
 * applied, so semantically similar names never become the same entity here.
 */
export interface MemoryGraphNode {
  id: string;
  chatKey: string;
  entityKey: string;
  label: string;
  createdAt: number;
  updatedAt: number;
}

/** A cache edge whose sole source of truth is its backing verified fact. */
export interface MemoryGraphEdge {
  id: string;
  chatKey: string;
  fromNodeId: string;
  toNodeId: string;
  predicateKey: string;
  kind: MemoryFactKind;
  confidence: number;
  status: FactStatus;
  validFrom?: number;
  validUntil?: number;
  backingFactId: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryGraphProjection {
  nodes: readonly MemoryGraphNode[];
  edges: readonly MemoryGraphEdge[];
}

export type MemoryGraphPhase = 'disabled' | 'idle' | 'queued' | 'rebuilding' | 'ready' | 'degraded';

/** Runtime-only coordination state. It deliberately carries no prompt/evidence. */
export interface MemoryGraphStatus {
  chatKey: string;
  enabled: boolean;
  phase: MemoryGraphPhase;
  nodeCount: number;
  edgeCount: number;
  updatedAt: number;
  lastRebuiltAt?: number;
  lastError?: string;
}

export interface MemoryGraphPreviewNode {
  id: string;
  label: string;
}

export interface MemoryGraphPreviewEdge {
  id: string;
  from: string;
  to: string;
  predicate: string;
  kind: MemoryFactKind;
  status: FactStatus;
  confidence: number;
  backingFactId: string;
}

export interface MemoryGraphPreview {
  nodes: readonly MemoryGraphPreviewNode[];
  edges: readonly MemoryGraphPreviewEdge[];
}

export const GRAPH_FACT_KINDS = Object.freeze(new Set<MemoryFactKind>([
  'relationship',
  'location',
  'world_rule',
  'goal',
  'commitment',
  'event',
]));

/** Literal-only normalization used both for deterministic ids and lookup. */
export function normalizeGraphEntityKey(value: string | undefined): string {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

export function graphNodeId(chatKey: string, entityKey: string): string {
  // chatKey is an opaque isolation boundary.  Unlike entity keys it must not
  // be normalized, otherwise two host-provided keys which differ only by
  // whitespace could collide in the shared Workspace collection.
  return `graph-node:${encodeURIComponent(chatKey)}:${encodeURIComponent(normalizeGraphEntityKey(entityKey))}`;
}

/** One backing fact can own at most one derived edge. */
export function graphEdgeId(backingFactId: string): string {
  return `graph-edge:${encodeURIComponent(backingFactId)}`;
}

function hasVerifiedEvidence(fact: MemoryFact): boolean {
  return fact.sourceRefs.length > 0 || fact.evidenceIds.length > 0;
}

/**
 * The graph intentionally indexes only active, evidence-backed, confident
 * relation facts. Pending/superseded/invalid facts remain facts but never
 * create live graph links.
 */
export function isGraphBackedFact(fact: MemoryFact): boolean {
  return GRAPH_FACT_KINDS.has(fact.kind)
    && fact.status === 'active'
    && fact.confidence >= ACTIVE_CONFIDENCE_THRESHOLD
    && hasVerifiedEvidence(fact)
    && Boolean(normalizeGraphEntityKey(fact.subjectKey))
    && Boolean(normalizeGraphEntityKey(fact.predicateKey))
    && Boolean(normalizeGraphEntityKey(fact.objectKey));
}

function mergeNode(nodes: Map<string, MemoryGraphNode>, node: MemoryGraphNode): void {
  const current = nodes.get(node.id);
  if (!current) {
    nodes.set(node.id, node);
    return;
  }
  nodes.set(node.id, {
    ...current,
    createdAt: Math.min(current.createdAt, node.createdAt),
    updatedAt: Math.max(current.updatedAt, node.updatedAt),
  });
}

/** Build an idempotent projection from facts without semantic entity merging. */
export function deriveMemoryGraphProjection(facts: readonly MemoryFact[]): MemoryGraphProjection {
  const nodes = new Map<string, MemoryGraphNode>();
  const edges: MemoryGraphEdge[] = [];
  for (const fact of facts) {
    if (!isGraphBackedFact(fact)) continue;
    const subject = normalizeGraphEntityKey(fact.subjectKey);
    const object = normalizeGraphEntityKey(fact.objectKey);
    const predicate = normalizeGraphEntityKey(fact.predicateKey);
    if (!subject || !object || !predicate) continue;
    const fromNodeId = graphNodeId(fact.chatKey, subject);
    const toNodeId = graphNodeId(fact.chatKey, object);
    mergeNode(nodes, {
      id: fromNodeId,
      chatKey: fact.chatKey,
      entityKey: subject,
      label: subject,
      createdAt: fact.createdAt,
      updatedAt: fact.updatedAt,
    });
    mergeNode(nodes, {
      id: toNodeId,
      chatKey: fact.chatKey,
      entityKey: object,
      label: object,
      createdAt: fact.createdAt,
      updatedAt: fact.updatedAt,
    });
    edges.push({
      id: graphEdgeId(fact.id),
      chatKey: fact.chatKey,
      fromNodeId,
      toNodeId,
      predicateKey: predicate,
      kind: fact.kind,
      confidence: fact.confidence,
      status: fact.status,
      ...(fact.validFrom === undefined ? {} : { validFrom: fact.validFrom }),
      ...(fact.validUntil === undefined ? {} : { validUntil: fact.validUntil }),
      backingFactId: fact.id,
      createdAt: fact.createdAt,
      updatedAt: fact.updatedAt,
    });
  }
  return Object.freeze({
    nodes: Object.freeze([...nodes.values()].sort((left, right) => left.id.localeCompare(right.id))),
    edges: Object.freeze(edges.sort((left, right) => left.id.localeCompare(right.id))),
  });
}
