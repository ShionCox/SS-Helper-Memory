import type {
  ActorMemoryPartition,
  ActorRecallCandidatePartition,
  MemoryRecallPacket,
} from './multi-actor-memory';
import type { GenerationRecallIntentKind, RecallCoverageResult } from './recall-plan';

export type GenerationRecallAttemptKind = 'primary' | 'coverage_expansion';
export type GenerationRecallCandidateState = 'injected' | 'selected_not_injected' | 'not_selected';
export type GenerationRecallInvalidationReason = 'message_deleted' | 'message_edited' | 'swipe_deleted';

export interface GenerationRecallCandidateDetail {
  readonly factId: string;
  readonly applicableOwnerIds?: readonly string[];
  readonly traceIds: readonly string[];
  readonly sourceFloors: readonly number[];
  readonly summary: string;
  readonly score: number;
  readonly selected: boolean;
  readonly state: GenerationRecallCandidateState;
  readonly reasonCodes: readonly string[];
  readonly omittedReason?: string;
  readonly lexicalScore?: number;
  readonly vectorScore?: number;
  readonly graphScore?: number;
  readonly fusionScore?: number;
  readonly rerankScore?: number;
  /** Optional for records created before the recall preview window. */
  readonly factKind?: string;
}

export interface GenerationRecallOwnerDetail {
  readonly ownerId: string;
  readonly ownerName: string;
  readonly role: ActorMemoryPartition['role'];
  readonly candidates: readonly GenerationRecallCandidateDetail[];
  readonly packets: readonly MemoryRecallPacket[];
  readonly permission?: string;
  readonly retrievalLevel?: 1 | 2 | 3 | 4;
  readonly retrievalStages?: readonly string[];
}

export type GenerationPromptSnapshotCaptureStatus = 'available' | 'unavailable' | 'too_large';

export interface GenerationPromptSnapshotMetadata {
  readonly snapshotId: string;
  readonly kind: 'chat' | 'text' | 'unknown';
  readonly messageCount?: number;
  readonly byteLength: number;
  readonly sha256: string;
  readonly chunkCount: number;
  readonly captureStatus: GenerationPromptSnapshotCaptureStatus;
  readonly verifiedIncludesMemory: boolean;
}

export interface GenerationPromptSnapshotManifest extends GenerationPromptSnapshotMetadata {
  readonly id: string;
  readonly workspaceId: string;
  readonly chatKey: string;
  readonly detailId: string;
  readonly memoryInjection: string;
  readonly createdAt: number;
}

export interface GenerationPromptSnapshotChunk {
  readonly id: string;
  readonly workspaceId: string;
  readonly chatKey: string;
  readonly snapshotId: string;
  readonly index: number;
  readonly content: string;
}

export interface GenerationPromptSnapshotPayload {
  readonly manifest: GenerationPromptSnapshotManifest;
  readonly request?:
    | { readonly kind: 'chat'; readonly messages: readonly import('@ss-helper/sdk').PromptMessageSnapshot[] }
    | { readonly kind: 'text'; readonly prompt: string };
}

export interface GenerationRecallAttemptDetail {
  readonly kind: GenerationRecallAttemptKind;
  readonly final: boolean;
  readonly candidateCount: number;
  readonly uniqueCandidateCount?: number;
  readonly duplicateCandidateCount?: number;
  readonly selectedCount: number;
  readonly elapsedMs: number;
  readonly owners: readonly GenerationRecallOwnerDetail[];
}

export interface GenerationRecallDetail {
  readonly id: string;
  readonly workspaceId: string;
  readonly chatKey: string;
  readonly planId: string;
  readonly messageId: string;
  /** Present only when the host had no stable message id and the floor index was used instead. */
  readonly messageIdIsSynthetic?: true;
  readonly messageIndex: number;
  readonly messageCreatedAt?: string;
  readonly variantId?: string;
  readonly outputFingerprint: string;
  readonly triggerFloor: number;
  readonly createdAt: number;
  readonly viewpointOwnerId: string;
  readonly coverage: RecallCoverageResult;
  readonly expanded: boolean;
  readonly intentKind?: GenerationRecallIntentKind;
  readonly topicTermsHash?: string;
  readonly candidateOccurrenceCount?: number;
  readonly uniqueCandidateCount?: number;
  readonly duplicateCandidateCount?: number;
  readonly injectedUniqueCount?: number;
  readonly recallSkippedReason?: 'recent_context_sufficient' | 'no_relevant_memory';
  readonly expansionSkippedReason?: 'no_new_candidates';
  readonly querySummary?: string;
  readonly promptSnapshot?: GenerationPromptSnapshotMetadata;
  readonly previewState?: 'invalidated';
  readonly invalidatedAt?: number;
  readonly invalidationReason?: GenerationRecallInvalidationReason;
  readonly prompt: {
    readonly maxChars: number;
    readonly usedChars: number;
    readonly includedCount: number;
    readonly omittedCount: number;
    readonly includedTraceIds: readonly string[];
    readonly omittedTraceIds: readonly string[];
  };
  readonly attempts: readonly GenerationRecallAttemptDetail[];
}

export interface GenerationRecallLookupTarget {
  readonly messageIds: readonly string[];
  readonly messageIndex: number;
  readonly messageCreatedAt?: string;
  readonly variantId?: string;
}

export interface PreparedRecallAttempt {
  readonly kind: GenerationRecallAttemptKind;
  readonly response: {
    readonly world: ActorMemoryPartition;
    readonly narrator: ActorMemoryPartition;
    readonly actors: readonly ActorMemoryPartition[];
    readonly candidatePartitions?: readonly ActorRecallCandidatePartition[];
    readonly diagnostics: {
      readonly candidateCount: number;
      readonly uniqueCandidateCount?: number;
      readonly duplicateCandidateCount?: number;
      readonly selectedCount: number;
      readonly elapsedMs: number;
      readonly permissionByOwner?: Readonly<Record<string, string>>;
      readonly retrievalLevelByOwner?: Readonly<Record<string, 1 | 2 | 3 | 4>>;
      readonly retrievalStagesByOwner?: Readonly<Record<string, readonly string[]>>;
    };
  };
}
