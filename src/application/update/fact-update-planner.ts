import type { MemoryFact } from '../../domain';
import type { StructuredClaim } from '../ingest/types';
import type { TemporalState } from '../extraction/extraction-types';

export type FactUpdateDecision = 'create' | 'duplicate_noop' | 'supersede' | 'append_history' | 'pending_review' | 'reject';

export interface FactUpdatePlan {
  readonly decision: FactUpdateDecision;
  readonly reasonCode: string;
  readonly current?: MemoryFact;
}

function comparable(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase('zh-CN');
}

export class FactUpdatePlanner {
  plan(claim: StructuredClaim, facts: readonly MemoryFact[], temporal: TemporalState, readSetValid = true): FactUpdatePlan {
    if (!readSetValid) return { decision: 'pending_review', reasonCode: 'MEMORY_AGENT_TOOL_STALE_REVISION' };
    if (!claim.sourceRef || !claim.evidenceExcerpt.trim()) return { decision: 'reject', reasonCode: 'MEMORY_CAPTURE_EVIDENCE_MISMATCH' };
    const current = facts
      .filter(fact => fact.status === 'active'
        && comparable(fact.subjectKey) === comparable(claim.subjectRef ?? claim.subjectText ?? '')
        && comparable(fact.predicateKey) === comparable(claim.predicateKey)
        && comparable(fact.objectKey ?? '') === comparable(claim.objectRef ?? claim.objectText ?? ''))
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (!current) return { decision: claim.kind === 'event' ? 'append_history' : 'create', reasonCode: 'MEMORY_UPDATE_CREATE' };
    if (comparable(current.content) === comparable(claim.content)) return { decision: 'duplicate_noop', reasonCode: 'MEMORY_UPDATE_DUPLICATE', current };
    if (claim.kind === 'event' || (temporal.validFrom !== undefined && temporal.validFrom < current.freshestEvidenceAt)) {
      return { decision: 'append_history', reasonCode: 'MEMORY_UPDATE_APPEND_HISTORY', current };
    }
    if (claim.confidence < 0.6 || claim.knowledge.mode === 'unknown') return { decision: 'pending_review', reasonCode: 'MEMORY_UPDATE_CONFLICT', current };
    return { decision: 'supersede', reasonCode: 'MEMORY_UPDATE_SUPERSEDE', current };
  }
}
