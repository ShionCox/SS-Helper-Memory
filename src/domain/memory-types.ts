export const MEMORY_SETTINGS_NAMESPACE = 'stx_memory' as const;
export const ACTIVE_CONFIDENCE_THRESHOLD = 0.75;
export const MIN_FACT_CONTENT_LENGTH = 6;
export const MAX_FACT_CONTENT_LENGTH = 240;

export type FactStatus = 'active' | 'pending' | 'superseded' | 'invalid';

export type MemoryFactKind =
  | 'identity'
  | 'relationship'
  | 'location'
  | 'world_rule'
  | 'state'
  | 'goal'
  | 'commitment'
  | 'preference'
  | 'capability'
  | 'event'
  | 'other';

export type FactOrigin = 'automatic' | 'manual' | 'import';

export interface FactScope {
  /** Applicability/canon scope only; never an owner/knowledge grant. */
  hostCardKeys?: string[];
  worldKeys?: string[];
  sceneKeys?: string[];
}

export interface MemoryFact {
  id: string;
  chatKey: string;
  kind: MemoryFactKind;
  subjectKey: string;
  /** Canonical entity ids resolved by ActorRegistry/knowledge projection. */
  subjectEntityId?: string;
  predicateKey: string;
  objectKey?: string;
  objectEntityId?: string;
  /** Full normalized key. Used for exact duplicate detection. */
  canonicalKey: string;
  /** Subject/predicate slot. Used to detect mutually exclusive replacements. */
  slotKey?: string;
  content: string;
  entityKeys: string[];
  confidence: number;
  status: FactStatus;
  sourceRefs: string[];
  evidenceIds: string[];
  freshestEvidenceAt: number;
  validFrom?: number;
  validUntil?: number;
  stableAnchor?: boolean;
  scope?: FactScope;
  origin: FactOrigin;
  revision: number;
  supersedesId?: string;
  supersededById?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 事实的可再生成向量缓存。该记录不属于备份契约，恢复备份后应重新生成。
 */
export interface MemoryFactVector {
  factId: string;
  chatKey: string;
  /** 对实际 embedding 输入 UTF-8 字节计算得到的小写 SHA-256。 */
  contentHash: string;
  resourceId: string;
  model: string;
  dimensions: number;
  vector: ArrayBuffer;
  createdAt: number;
  updatedAt: number;
}

/** 写入向量缓存所需的原始数据；content 是实际 embedding 输入，hash 和 dimensions 由基础设施层生成。 */
export interface UpsertMemoryFactVectorInput {
  factId: string;
  chatKey: string;
  content: string;
  resourceId: string;
  model: string;
  vector: readonly number[] | Float32Array;
  updatedAt?: number;
}

/** 判断现有向量能否被当前 embedding 路由复用。 */
export interface MemoryFactVectorTarget {
  resourceId: string;
  model: string;
  dimensions?: number;
}

/** 向量覆盖率及重建队列所需的事实分类。 */
export interface MemoryFactVectorCoverage {
  chatKey: string;
  totalFacts: number;
  ready: number;
  missing: number;
  stale: number;
  orphaned: number;
  coverage: number;
  readyFactIds: string[];
  missingFactIds: string[];
  staleFactIds: string[];
  orphanedFactIds: string[];
}

export type MemorySourceType = 'message' | 'state' | 'host_card' | 'persona' | 'worldbook' | 'manual';

export interface MemorySourceBlock {
  id: string;
  chatKey: string;
  type: MemorySourceType;
  content: string;
  occurredAt: number;
  messageId?: string;
  floor?: number;
  title?: string;
}

export interface FactEvidenceInput {
  sourceRef: string;
  excerpt: string;
}

export interface AutomaticFactProposal {
  kind: MemoryFactKind;
  subjectKey: string;
  predicateKey: string;
  objectKey?: string;
  content: string;
  entityKeys: string[];
  confidence: number;
  evidence: FactEvidenceInput[];
  validFrom?: number;
  validUntil?: number;
  stableAnchor?: boolean;
  scope?: FactScope;
}

export interface ValidatedAutomaticFact extends AutomaticFactProposal {
  canonicalKey: string;
  slotKey: string;
  status: 'active' | 'pending';
  sourceRefs: string[];
  freshestEvidenceAt: number;
}

export interface MemoryEvidence {
  id: string;
  factId: string;
  chatKey: string;
  sourceRef: string;
  sourceType: MemorySourceType;
  excerpt: string;
  messageId?: string;
  floor?: number;
  occurredAt: number;
  createdAt: number;
}

export type MemoryJobType = 'initialize' | 'incremental';
export type MemoryJobStatus = 'queued' | 'running' | 'repairing' | 'needs_repair' | 'needs_review' | 'paused' | 'completed' | 'failed';
export type MemoryJobOutcome = 'complete' | 'partial';
export type MemoryInitializationPhase = 'capture' | 'repair';
export type RepairResolutionMode = 'repaired' | 'degraded' | 'ignored';

export interface RepairFieldAction {
  path: string;
  action: 'clear' | 'filter';
  reason: string;
}

export interface MemoryJobCheckpoint {
  batchIndex: number;
  lastScannedBatch?: number;
  completedBatchCount?: number;
  pendingRepairCount?: number;
  retryableRepairCount?: number;
  exhaustedRepairCount?: number;
  quarantinedCount?: number;
  reviewRequiredCount?: number;
  unresolvedRejectionCount?: number;
  repairedCount?: number;
  degradedCount?: number;
  ignoredCount?: number;
  totalBatches?: number;
  processedCount: number;
  lastSourceRef?: string;
  overlapSourceRefs?: string[];
  metadataSourceRefs?: string[];
  selectedSourceGroupIds?: string[];
  /** 初始化任务是否包含酒馆中已隐藏的普通用户/助手楼层。 */
  includeHiddenMessageFloors?: boolean;
  /** 总结窗口的聊天楼层边界；用于断点恢复和进度诊断。 */
  summaryStartFloor?: number;
  summaryEndFloor?: number;
  summaryEndMessageId?: string;
  phase?: MemoryInitializationPhase;
}

export interface CaptureRepairQueueRecord {
  id: string;
  workspaceId: string;
  chatKey: string;
  jobId: string;
  batchIndex: number;
  collection: 'actorCandidates' | 'locationCandidates' | 'itemCandidates' | 'episodes' | 'claims' | 'inventoryOperations' | 'batch';
  itemIndex: number;
  issues: Array<{ path: string; keyword: string; expected: string }>;
  sourceRefs: string[];
  fallbackSourceRefs: string[];
  originalRequestId?: string;
  originalResourceId?: string;
  originalModel?: string;
  rejectionId?: string;
  rejectionIds?: string[];
  repairRequestId?: string;
  status: 'queued' | 'running' | 'resolved' | 'unresolved' | 'ignored';
  attemptCount: number;
  maxAttempts?: number;
  candidateSetHash?: string;
  evidenceSetHash?: string;
  /** First semantic review failed; do not retry until the source window changes. */
  waitingForEvidenceChange?: boolean;
  /** The one evidence-change retry has already been released. */
  evidenceRetryUsed?: boolean;
  repairPolicyVersion?: number;
  resolutionMode?: RepairResolutionMode;
  fieldActions?: RepairFieldAction[];
  resolvedAt?: number;
  failure?: SSHelperFailureContext;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryJob {
  id: string;
  chatKey: string;
  type: MemoryJobType;
  status: MemoryJobStatus;
  outcome?: MemoryJobOutcome;
  rejectionCount?: number;
  rejections?: readonly AutomaticIngestRejection[];
  checkpoint: MemoryJobCheckpoint;
  failure?: SSHelperFailureContext;
  createdAt: number;
  updatedAt: number;
}

/** LLM 用量；宿主或供应商未返回的字段必须保留为 null，不用 0 冒充。 */
export interface MemoryTokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
}

/** 单个整理批次的可审计结果。 */
export interface MemoryJobBatchAudit {
  id: string;
  chatKey: string;
  jobId: string;
  batchIndex: number;
  sourceRefs: string[];
  accepted: number;
  rejected: number;
  outcome?: MemoryJobOutcome;
  duplicated: number;
  pending: number;
  superseded: number;
  rejections: AutomaticIngestRejection[];
  startedAt: number;
  completedAt: number;
  usage: MemoryTokenUsage | null;
  requestId?: string;
  resourceId?: string;
  model?: string;
  latencyMs?: number;
  rolledBackAt?: number;
}

/** 主聊天生成的真实用量记录；缺失的宿主字段显式记录为 null。 */
export interface MainChatUsage {
  id: string;
  chatKey: string;
  messageId: string;
  /** 与本次生成前最近一次 recall_log 关联；没有注入时可缺省。 */
  recallLogId?: string;
  /** 与本条 AI 回复原子提交的完整召回审计。 */
  generationRecallDetailId?: string;
  promptTokens: number | null;
  completionTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  provider?: string;
  model?: string;
  capturedAt: number;
}

export interface MemorySettingRecord {
  id: string;
  namespace: typeof MEMORY_SETTINGS_NAMESPACE;
  key: string;
  value: unknown;
  updatedAt: number;
}

export interface RecallCandidateLog {
  factId: string;
  score: number;
  selected: boolean;
  reasonCodes: string[];
  omittedReason?: string;
  lexicalScore?: number;
  vectorScore?: number;
  graphScore?: number;
  lexicalRank?: number;
  vectorRank?: number;
  graphRank?: number;
  fusionScore?: number;
  rerankScore?: number;
}

export interface MemoryRecallDiagnosticsLog {
  candidateCount: number;
  eligibleCount: number;
  selectedCount: number;
  llmCalls: number;
  requestedMode?: string;
  resolvedMode?: string;
  lexicalCandidateCount?: number;
  vectorCandidateCount?: number;
  graphCandidateCount?: number;
  graphHitCount?: number;
  graphSeedNodeCount?: number;
  graphLatencyMs?: number;
  graphDegradedReason?: string;
  fusedCandidateCount?: number;
  degradedReason?: string;
  embedding?: unknown;
  rerank?: unknown;
  totalExtraLatencyMs?: number;
}

export interface MemoryRecallLog {
  id: string;
  chatKey: string;
  query: string;
  maxItems: number;
  candidates: RecallCandidateLog[];
  selectedFactIds: string[];
  diagnostics?: MemoryRecallDiagnosticsLog;
  /** 宿主实际注入的完整文本；预览召回不生成该字段。 */
  injectedPrompt?: string;
  /** Prompt 构建器对实际注入文本给出的预算与回答模式诊断。 */
  promptDiagnostics?: {
    maxChars: number;
    usedChars: number;
    includedCount: number;
    omittedCount: number;
    omittedReason?: string;
    answerMode: 'roleplay' | 'diagnostic';
  };
  createdAt: number;
}

export interface AutomaticIngestRejection {
  /** Stable within a Capture batch; older audit rows may omit it. */
  id?: string;
  index: number;
  code: AutomaticProposalErrorCode;
  message: string;
  recordType?: 'batch' | 'actor' | 'location' | 'item' | 'episode' | 'claim' | 'inventory' | 'observation' | 'fact';
  fieldPath?: string;
  issues?: Array<{
    path: string;
    keyword: string;
    expected: string;
  }>;
  sourceRefs?: string[];
  allowedValues?: string[];
  /** Only known Capture fields are retained; no prompt/provider payloads. */
  requestId?: string;
  parentRequestId?: string;
  resourceId?: string;
  model?: string;
  batchIndex?: number;
  status?: 'unresolved' | 'repairing' | 'repaired' | 'ignored';
  repairAttempts?: number;
  lastAttemptAt?: number;
  repairedAt?: number;
  ignoredAt?: number;
  /** Non-blocking quarantine: the record is retried only after evidence changes. */
  waitingForEvidenceChange?: boolean;
}

export interface AutomaticIngestResult {
  facts: MemoryFact[];
  accepted: number;
  duplicated: number;
  pending: number;
  superseded: number;
  rejected: AutomaticIngestRejection[];
}

export type AutomaticProposalErrorCode =
  | 'invalid_shape'
  | 'invalid_enum'
  | 'invalid_reference'
  | 'entity_ref_unsupported'
  | 'schema_validation_failed'
  | 'dependency_invalid'
  | 'unknown_field'
  | 'batch_invalid_json'
  | 'content_length'
  | 'invalid_confidence'
  | 'missing_evidence'
  | 'missing_source'
  | 'cross_chat_source'
  | 'empty_excerpt'
  | 'excerpt_mismatch'
  | 'non_chinese_key'
  | 'duplicate_proposal'
  | 'quality_below_threshold';

/** Source-locatable validation failures that an independent AI review may re-extract. */
export const AI_REPAIRABLE_PROPOSAL_CODES = Object.freeze([
  'invalid_shape',
  'invalid_enum',
  'invalid_reference',
  'entity_ref_unsupported',
  'schema_validation_failed',
  'dependency_invalid',
  'unknown_field',
  'content_length',
  'invalid_confidence',
  'missing_evidence',
  'empty_excerpt',
  'excerpt_mismatch',
  'non_chinese_key',
] satisfies readonly AutomaticProposalErrorCode[]);

/** Fail-closed outcomes that must never block Capture or spend an AI review call. */
export const AUTO_IGNORED_PROPOSAL_CODES = Object.freeze([
  'batch_invalid_json',
  'missing_source',
  'cross_chat_source',
  'duplicate_proposal',
  'quality_below_threshold',
] satisfies readonly AutomaticProposalErrorCode[]);

export function isAiRepairableProposalCode(code: AutomaticProposalErrorCode): boolean {
  return (AI_REPAIRABLE_PROPOSAL_CODES as readonly AutomaticProposalErrorCode[]).includes(code);
}

export function isAutoIgnoredProposalCode(code: AutomaticProposalErrorCode): boolean {
  return (AUTO_IGNORED_PROPOSAL_CODES as readonly AutomaticProposalErrorCode[]).includes(code);
}

export type AutomaticProposalValidation =
  | { ok: true; value: ValidatedAutomaticFact }
  | { ok: false; code: AutomaticProposalErrorCode; message: string };

export type ReconciliationDecision = 'insert' | 'duplicate' | 'supersede' | 'pending';

export interface ReconciliationCandidate {
  kind: MemoryFactKind;
  canonicalKey: string;
  slotKey?: string;
  content: string;
  confidence: number;
  freshestEvidenceAt: number;
}

export interface FactListOptions {
  status?: FactStatus;
  kind?: MemoryFactKind;
  limit?: number;
}

export interface ManualFactInput {
  id?: string;
  kind: MemoryFactKind;
  subjectKey: string;
  predicateKey: string;
  objectKey?: string;
  content: string;
  entityKeys?: string[];
  confidence?: number;
  status?: FactStatus;
  validFrom?: number;
  validUntil?: number;
  stableAnchor?: boolean;
  scope?: FactScope;
}
import type { SSHelperFailureContext } from '@ss-helper/sdk';
