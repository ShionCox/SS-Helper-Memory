import { ACTIVE_CONFIDENCE_THRESHOLD, type MemoryFact, type ReconciliationCandidate, type ReconciliationDecision } from './memory-types';
import { createFactSlotKey, normalizeFactContent } from './fact-validation';

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

  const hasNewerEvidence = incoming.freshestEvidenceAt > existing.freshestEvidenceAt;
  const isConfident = incoming.confidence >= ACTIVE_CONFIDENCE_THRESHOLD;
  return hasNewerEvidence && isConfident ? 'supersede' : 'pending';
}
