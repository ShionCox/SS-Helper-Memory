import type {
  AutomaticIngestRejection,
  MemoryTokenUsage,
} from '../../domain';
import type {
  ExtractionPipelineAudit,
  ExtractionStageKey,
  MemoryReviewItem,
} from '../extraction/extraction-types';
import type { PlainData } from '@ss-helper/sdk';

export type { RepairFieldAction, RepairResolutionMode } from '../../domain';
export type { SupportedEvidenceDirectory, SupportedEvidenceSpan } from './supported-evidence-directory';

export type SourceBlockKind = 'message' | 'state' | 'host_card' | 'persona' | 'worldbook';
export type SourceBlockRole = 'user' | 'assistant' | 'system' | 'tool' | 'metadata';
export type SourceMessageType = 'conversation' | 'narrator' | 'system' | 'tool' | 'reasoning';

export interface SourceAuthor {
  readonly kind: 'user' | 'assistant' | 'narrator' | 'system';
  readonly displayName?: string;
  readonly avatar?: string;
  readonly originalAvatar?: string;
}

export interface KnownLocationContextItem {
  referenceId: string;
  /** Internal deterministic mapping; never serialized to the model. */
  locationId?: string;
  /** Internal snapshot revision; never serialized to the model. */
  recordRevision?: number;
  canonicalName: string;
  aliases: string[];
  status: 'confirmed' | 'pending';
}

export interface SourcePerspective {
  readonly viewpointOwnerRef?: string;
  readonly speakerOwnerRef?: string;
  readonly observerOwnerRefs?: readonly string[];
  readonly mentionedOwnerRefs?: readonly string[];
  readonly presentOwnerRefs?: readonly string[];
  readonly confidence?: number;
}

export interface SourceSceneTransition {
  readonly enteredOwnerRefs?: readonly string[];
  readonly exitedOwnerRefs?: readonly string[];
  readonly nearbyOwnerRefs?: readonly string[];
  readonly locationKeys?: readonly string[];
  readonly timeJump?: boolean;
  readonly sceneReset?: boolean;
  readonly confidence?: number;
}

export interface SourceBlock {
  id: string;
  chatKey: string;
  kind: SourceBlockKind;
  role: SourceBlockRole;
  content: string;
  createdAt: number;
  floor?: number;
  messageType?: SourceMessageType;
  hidden?: boolean;
  entityKeys?: string[];
  /** Host author provenance; never treated as an in-world owner by itself. */
  author?: SourceAuthor;
  /** Prompt-local entity references discovered by ActorRegistry. */
  actorRefs?: string[];
  /** Prompt-local location references discovered by LocationRegistry. */
  locationRefs?: string[];
  /** SillyTavern message section classification used by Capture quality gates. */
  semanticSection?: 'narrative' | 'cast_manifest' | 'state_snapshot' | 'control';
  perspective?: SourcePerspective;
  /** Explicit host/model scene metadata. Textual cues are resolved separately. */
  transition?: SourceSceneTransition;
  visibility?: 'visible' | 'hidden' | 'control';
  sceneRefs?: string[];
}

export type FactKind = 'identity' | 'relationship' | 'location' | 'world_rule' | 'state' | 'goal' | 'commitment' | 'event' | 'preference' | 'capability' | 'other';

export interface ExtractedFactProposal {
  kind: FactKind;
  subjectKey: string;
  predicateKey: string;
  objectKey?: string;
  content: string;
  entityKeys: string[];
  confidence: number;
  sourceRef: string;
  evidenceExcerpt: string;
  actionHint: 'upsert' | 'supersede';
  validFrom?: number;
  validTo?: number;
  stable?: boolean;
}

export interface ValidatedFactProposal extends ExtractedFactProposal {
  canonicalKey: string;
  scope?: { worldKeys?: string[]; sceneKeys?: string[] };
  ownerRefs?: string[];
  observationRefs?: string[];
  privacy?: 'public' | 'limited' | 'private' | 'secret';
  knowledgeMode?: 'asserted' | 'self_reported' | 'heard' | 'experienced' | 'inferred' | 'believed' | 'suspected' | 'unknown';
}

export interface IngestCommit {
  chatKey: string;
  jobId: string;
  facts: ValidatedFactProposal[];
  sources: SourceBlock[];
  checkpoint: {
    sourceIds: string[];
    completedAt: number;
    batchIndex?: number;
    totalBatches?: number;
    processedCount?: number;
    overlapSourceRefs?: string[];
    metadataSourceRefs?: string[];
    selectedSourceGroupIds?: string[];
    /** 总结窗口的聊天楼层边界；仅写入 JSON 检查点，不改变存储表结构。 */
    summaryStartFloor?: number;
    summaryEndFloor?: number;
    summaryEndMessageId?: string;
  };
  jobType?: 'initialize' | 'incremental';
  jobStatus?: 'queued' | 'running' | 'paused' | 'completed' | 'failed';
  /** LLM 输出在应用层被拒绝的明细，持久层会与事务校验拒绝合并进批次审计。 */
  rejections?: AutomaticIngestRejection[];
  /** 本批真实 LLM 路由、延迟与 usage；供应商未返回的字段保持缺省/null。 */
  audit?: MemoryExtractionAudit;
}

export interface MemoryExtractionAudit {
  requestId?: string;
  resourceId?: string;
  model?: string;
  latencyMs?: number;
  fallbackUsed?: boolean;
  usage?: MemoryTokenUsage | null;
  pipeline?: ExtractionPipelineAudit;
}

export interface MemoryExtractionResult {
  facts: ExtractedFactProposal[];
  audit?: MemoryExtractionAudit;
}

export interface StructuredActorCandidate {
  localId: string;
  displayName: string;
  aliases: string[];
  sourceRef: string;
  evidenceExcerpt: string;
  confidence: number;
}

export interface StructuredLocationCandidate {
  localId: string;
  displayName: string;
  aliases: string[];
  sourceRef: string;
  evidenceExcerpt: string;
  confidence: number;
}

export interface StructuredItemCandidate {
  localId: string;
  displayName: string;
  aliases: string[];
  category: import('../../domain').InventoryItemCategory;
  sourceRef: string;
  evidenceExcerpt: string;
  confidence: number;
}

export interface StructuredInventoryOperation {
  localId: string;
  itemRef: string;
  operation: import('../../domain').InventoryOperation;
  measureKind: import('../../domain').InventoryMeasureKind;
  amount?: number;
  rawAmount?: string;
  unit: string;
  precision: import('../../domain').InventoryPrecision;
  reason: import('../../domain').InventoryReason;
  /** Deterministic snapshot-only condition text, for example “已使用”. */
  stateNote?: string;
  sourceRef: string;
  evidenceExcerpt: string;
  confidence: number;
  /** Server-owned planner result; never accepted from model output. */
  updateDecision?: 'append_history';
  /** Explicit review approval; server-owned and never accepted from model output. */
  reviewApproved?: boolean;
}

export interface StructuredEpisode {
  localId: string;
  sourceRefs: string[];
  /** Required by the AI schema; optional only for trusted in-process producers/tests. */
  evidenceSpanIds?: string[];
  /** Server-owned exact excerpts resolved from evidenceSpanIds. */
  evidenceExcerpts?: string[];
  participantRefs: string[];
  presentRefs: string[];
  mentionedRefs: string[];
  locationRef?: string;
  storyTimeText?: string;
  summary: string;
}

export interface StructuredClaimKnowledge {
  mode: 'asserted' | 'self_reported' | 'heard' | 'experienced' | 'inferred' | 'believed' | 'suspected' | 'unknown';
  privacy: 'public' | 'limited' | 'private' | 'secret';
  ownerRefs: string[];
  speakerRef?: string;
  viewpointRef?: string;
  observerRefs: string[];
  presentRefs: string[];
  mentionedRefs: string[];
}

export interface StructuredClaim {
  localId: string;
  sourceRef: string;
  episodeLocalId?: string;
  kind: FactKind;
  /** Stable actor/location reference when the subject belongs to a directory. */
  subjectRef?: string;
  /** Natural subject for ordinary objects, groups, rules and unnamed entities. */
  subjectText?: string;
  predicateKey: string;
  /** Stable actor/location reference for a relationship or location object. */
  objectRef?: string;
  objectText?: string;
  content: string;
  evidenceExcerpt: string;
  knowledge: StructuredClaimKnowledge;
  confidence: number;
  stableAnchor?: boolean;
  /** Explicit review approval; server-owned and never accepted from model output. */
  reviewApproved?: boolean;
}

/** One-call Claim capture output. Machine times and persistence IDs are server-owned. */
export interface StructuredCaptureResult {
  actorCandidates: StructuredActorCandidate[];
  locationCandidates: StructuredLocationCandidate[];
  /** Required and normalized to [] at the LLM boundary. */
  itemCandidates?: StructuredItemCandidate[];
  episodes: StructuredEpisode[];
  claims: StructuredClaim[];
  /** Required and normalized to [] at the LLM boundary. */
  inventoryOperations?: StructuredInventoryOperation[];
  /** AI review decisions. `emit` candidates still pass the normal hard validators. */
  repairDecisions?: StructuredRepairDecision[];
  rejections?: AutomaticIngestRejection[];
  diagnostics?: {
    parser?: string;
    deterministicRepairs?: number;
    schemaRepairCalls?: number;
    transportMode?: 'native_strict' | 'json_object_validated' | 'prompt_json' | 'unknown';
  };
  audit?: MemoryExtractionAudit;
  /** Shadow runs persist only their controlled audit and never enter domain materialization. */
  shadowOnly?: boolean;
  /** Active runs commit review items atomically with the accepted domain subset. */
  reviewItems?: readonly MemoryReviewItem[];
}

/**
 * A read-only, opaque reference to an already-persisted fact.  It exists only
 * to help the extractor distinguish duplicates, additions, and state changes;
 * it deliberately carries neither sourceRef nor evidence text.
 */
export interface ExistingMemoryContextItem {
  /** Sequential prompt-local identifier, never a persistence record id. */
  referenceId: string;
  /** Internal deterministic mapping; never serialized to the model. */
  factId?: string;
  /** Internal snapshot revision; never serialized to the model. */
  recordRevision?: number;
  kind: string;
  subjectKey: string;
  predicateKey: string;
  objectKey?: string;
  content: string;
  validFrom?: number;
  validUntil?: number;
  stable?: boolean;
}

/**
 * Prompt-local actor directory supplied to every structured Capture batch.
 * It deliberately carries natural names rather than persistence ids so the
 * model can reuse a stable canonical name without learning database keys.
 */
export interface KnownActorContextItem {
  /** Sequential prompt-local reference, never a persistence record id. */
  referenceId: string;
  /** Internal deterministic mapping; never serialized to the model. */
  ownerId?: string;
  /** Internal snapshot revision; never serialized to the model. */
  recordRevision?: number;
  canonicalName: string;
  aliases: string[];
  status: 'confirmed' | 'pending';
}

export interface StructuredRepairDecision {
  repairId: string;
  action: 'emit' | 'drop';
  /** Present only for emit; used to match the accepted candidate after validation. */
  localId?: string;
  /** Server-derived index in the normalized target collection. */
  itemIndex?: number;
  /** Server-derived sources of the emitted candidate; never trusted from model output. */
  sourceRefs?: string[];
}

export interface StructuredRepairTarget {
  repairId: string;
  issues: Array<{ path: string; keyword: string; expected: string }>;
}

export interface KnownInventoryContextItem {
  referenceId: string;
  /** Internal deterministic mapping; never serialized to the model. */
  itemId?: string;
  /** Internal aggregate revision; never serialized to the model. */
  recordRevision?: number;
  canonicalName: string;
  aliases: string[];
  category: import('../../domain').InventoryItemCategory;
  states: Array<Pick<import('../../domain').InventoryState, 'measureKind' | 'amount' | 'unit' | 'precision' | 'availability' | 'updatedAtFloor'>>;
}

export interface SupportedReferenceItem {
  referenceId: string;
  canonicalName: string;
  aliases: string[];
  sourceRefs: string[];
}

export interface SupportedEpisodeReference {
  referenceId: string;
  summary: string;
  sourceRefs: string[];
}

/**
 * A repair-local closed set. It contains only references supported by the
 * current source window; it is shared by the prompt, dynamic schema and final
 * business validation.
 */
export interface SupportedReferenceDirectory {
  allowedActorRefs: SupportedReferenceItem[];
  allowedLocationRefs: SupportedReferenceItem[];
  allowedEpisodeRefs: SupportedEpisodeReference[];
  candidateSetHash: string;
}

export interface RepairAttemptContext {
  attempt?: number;
  maxAttempts?: number;
  mode?: 'targeted' | 'conservative';
  referenceDirectory?: SupportedReferenceDirectory;
}

export interface MemoryExtractionInput {
  workspaceId?: string;
  chatKey: string;
  /** Capture/job metadata used to build one LLM workflow trace per pipeline. */
  workflow?: {
    label?: string;
    kind?: string;
    jobId?: string;
    batchIndex?: number;
    batchCount?: number;
  };
  /** Stage-local trace produced by the extraction coordinator. */
  llmTrace?: import('@ss-helper/sdk').LlmWorkflowTrace;
  sources: readonly SourceBlock[];
  /**
   * Source ids allowed to create new persisted records. Omitted means every
   * source in this request is writable. Overlap/context sources remain visible
   * to the model but must never be emitted as new evidence.
   */
  writableSourceRefs?: readonly string[];
  /** Read-only facts relevant to this batch; never valid evidence for output. */
  existingMemoryContext?: readonly ExistingMemoryContextItem[];
  /** Stable actor names/aliases already known by ActorRegistry for this card. */
  knownActorContext?: readonly KnownActorContextItem[];
  /** Stable location names/aliases already known by LocationRegistry. */
  knownLocationContext?: readonly KnownLocationContextItem[];
  /** Exact-name matched current inventory. Context only; never evidence. */
  knownInventoryContext?: readonly KnownInventoryContextItem[];
  /** Enables source-grounded relation-fact guidance in the existing single call. */
  graphLlmRelationEnabled?: boolean;
  /** One-shot human review instruction scoped to one regenerated candidate. */
  reviewOverride?: {
    candidateLocalId: string;
    action: 'accept' | 'edit' | 'merge';
    payload?: PlainData;
  };
  /** Internal fixed Stage selection; never accepted from model output or settings text. */
  stage?: Exclude<ExtractionStageKey, 'repair'>;
  /** Job-scoped runtime settings. They override mutable UI settings for resume safety. */
  runtimeExtraction?: {
    extractionMode: 'single' | 'agent';
    agentConcurrency: 1 | 2;
    agentToolPolicy: 'off' | 'read_only';
    agentWriteMode: 'shadow' | 'active';
  };
  signal?: AbortSignal;
  /** Receives each completed Provider response usage without inventing absent fields. */
  onUsage?: (usage: import('./llm-extractor').MemoryLlmUsage | undefined) => void | Promise<void>;
  repair?: RepairAttemptContext & {
    collection: 'actorCandidates' | 'locationCandidates' | 'itemCandidates' | 'episodes' | 'claims' | 'inventoryOperations';
    issues: Array<{ path: string; keyword: string; expected: string }>;
    /** One to four source-overlapping records reviewed in the same request. */
    targets?: StructuredRepairTarget[];
    parentRequestId?: string;
    resourceId?: string;
    model?: string;
    maxItems: number;
  };
}

/** Validated extraction output that can either be staged or committed. */
export interface PreparedMemoryIngest {
  sources: SourceBlock[];
  facts: ValidatedFactProposal[];
  rejections: AutomaticIngestRejection[];
  audit?: MemoryExtractionAudit;
  skipped: boolean;
}

export interface MemoryExtractor {
  extract(input: MemoryExtractionInput): Promise<ExtractedFactProposal[] | MemoryExtractionResult>;
}

export interface IngestCommitter {
  commit(input: IngestCommit): Promise<void>;
}
