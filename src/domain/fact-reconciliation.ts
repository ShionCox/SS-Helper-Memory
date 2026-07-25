import {
  ACTIVE_CONFIDENCE_THRESHOLD,
  type MemoryFact,
  type MemoryFactKind,
  type ReconciliationCandidate,
  type ReconciliationDecision,
} from './memory-types';
import { createFactSlotKey, normalizeFactContent } from './fact-validation';

/**
 * These rows describe occurrences or declarations, not a single mutable value.
 * They remain append-only so a later command/goal never erases an earlier
 * command/goal that is still required by historical recall.
 */
const APPEND_ONLY_FACT_KINDS = new Set<MemoryFactKind>([
  'identity',
  'relationship',
  'world_rule',
  'goal',
  'commitment',
  'event',
  'preference',
  'capability',
  'other',
]);

export function isAppendOnlyFactKind(kind: string | undefined): boolean {
  return APPEND_ONLY_FACT_KINDS.has((kind ?? '').trim().toLocaleLowerCase() as MemoryFactKind);
}

function slotKeyFromCanonical(canonicalKey: string): string {
  return canonicalKey.split('::').slice(0, 2).join('::');
}

export function decideFactReconciliation(
  existing: MemoryFact | undefined,
  incoming: ReconciliationCandidate,
): ReconciliationDecision {
  if (!existing) return 'insert';

  const existingSlot = existing.slotKey ?? createFactSlotKey(existing.subjectKey, existing.predicateKey);
  const incomingSlot = incoming.slotKey ?? slotKeyFromCanonical(incoming.canonicalKey);
  if (existingSlot !== incomingSlot) return 'insert';

  if (
    incoming.canonicalKey === existing.canonicalKey
    && normalizeFactContent(incoming.content).toLocaleLowerCase()
      === normalizeFactContent(existing.content).toLocaleLowerCase()
  ) {
    return 'duplicate';
  }

  // Event-sourced rows can share a subject/predicate without contradicting
  // each other. Current state is derived at query time instead of overwriting
  // the historical occurrence.
  if (isAppendOnlyFactKind(existing.kind) || isAppendOnlyFactKind(incoming.kind)) return 'insert';

  const hasNewerEvidence = incoming.freshestEvidenceAt > existing.freshestEvidenceAt;
  const isConfident = incoming.confidence >= ACTIVE_CONFIDENCE_THRESHOLD;
  return hasNewerEvidence && isConfident ? 'supersede' : 'pending';
}
