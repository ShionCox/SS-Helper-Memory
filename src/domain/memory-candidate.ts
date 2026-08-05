import type { PlainData, SSHelperFailureContext } from '@ss-helper/sdk';

export type MemoryCandidateCollection =
  | 'actorCandidates'
  | 'locationCandidates'
  | 'itemCandidates'
  | 'episodes'
  | 'claims'
  | 'inventoryOperations';

export type MemoryCandidateStatus =
  | 'accepted'
  | 'duplicate_noop'
  | 'pending_review'
  | 'rejected'
  | 'ignored'
  | 'superseded_attempt';

export interface MemoryCandidateEvidenceSpan {
  readonly evidenceSpanId: string;
  readonly sourceRef: string;
  readonly sourceKind: 'message' | 'state' | 'host_card' | 'persona' | 'worldbook' | 'manual';
  readonly floor?: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly sourceDigest: string;
}

export interface MemoryCandidateRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly chatKey: string;
  readonly jobId?: string;
  readonly batchIndex?: number;
  readonly pipelineRunId: string;
  readonly stageAttemptId: string;
  readonly attemptIndex: number;
  readonly stage: string;
  readonly collection: MemoryCandidateCollection;
  readonly status: MemoryCandidateStatus;
  readonly candidateLocalId: string;
  readonly summary: string;
  readonly normalizedCandidate: PlainData;
  readonly decision?: string;
  readonly reasonCode?: string;
  readonly failure?: SSHelperFailureContext;
  readonly rejectionId?: string;
  readonly reviewItemId?: string;
  readonly committedRecordRefs: readonly string[];
  readonly evidence: readonly MemoryCandidateEvidenceSpan[];
  readonly sourceRefs: readonly string[];
  readonly createdAt: number;
  readonly rolledBackAt?: number;
}
