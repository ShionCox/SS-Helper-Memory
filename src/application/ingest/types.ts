import type { AutomaticIngestRejection, MemoryTokenUsage } from '../../domain';

export type SourceBlockKind = 'message' | 'state' | 'host_card' | 'persona' | 'worldbook';
export type SourceBlockRole = 'user' | 'assistant' | 'system' | 'tool' | 'metadata';
export type SourceMessageType = 'conversation' | 'narrator' | 'system' | 'tool' | 'reasoning';

export interface SourceAuthor {
  readonly kind: 'user' | 'assistant' | 'narrator' | 'system';
  readonly displayName?: string;
  readonly avatar?: string;
  readonly originalAvatar?: string;
}

export interface SourcePerspective {
  readonly viewpointOwnerRef?: string;
  readonly speakerOwnerRef?: string;
  readonly observerOwnerRefs?: readonly string[];
  readonly mentionedOwnerRefs?: readonly string[];
  readonly presentOwnerRefs?: readonly string[];
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
  perspective?: SourcePerspective;
  visibility?: 'visible' | 'hidden' | 'control';
  sceneRefs?: string[];
}

export type FactKind = 'identity' | 'relationship' | 'location' | 'world_rule' | 'state' | 'goal' | 'commitment' | 'event' | 'preference' | 'capability';

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
  usage?: MemoryTokenUsage | null;
}

export interface MemoryExtractionResult {
  facts: ExtractedFactProposal[];
  audit?: MemoryExtractionAudit;
}

/** One-call structured capture output. All refs are local to the request. */
export interface StructuredCaptureResult {
  actorCandidates: Array<{
    localId: string;
    displayName: string;
    aliases?: string[];
    sourceRefs: string[];
    evidenceExcerpts: string[];
    confidence: number;
    status?: 'confirmed' | 'pending' | 'unknown';
  }>;
  episodes: Array<Record<string, unknown>>;
  observations: Array<Record<string, unknown>>;
  facts: Array<Record<string, unknown>>;
  audit?: MemoryExtractionAudit;
}

/**
 * A read-only, opaque reference to an already-persisted fact.  It exists only
 * to help the extractor distinguish duplicates, additions, and state changes;
 * it deliberately carries neither sourceRef nor evidence text.
 */
export interface ExistingMemoryContextItem {
  /** Sequential prompt-local identifier, never a persistence record id. */
  referenceId: string;
  kind: string;
  subjectKey: string;
  predicateKey: string;
  objectKey?: string;
  content: string;
  validFrom?: number;
  validUntil?: number;
  stable?: boolean;
}

export interface MemoryExtractionInput {
  chatKey: string;
  sources: readonly SourceBlock[];
  /** Read-only facts relevant to this batch; never valid evidence for output. */
  existingMemoryContext?: readonly ExistingMemoryContextItem[];
  /** Enables source-grounded relation-fact guidance in the existing single call. */
  graphLlmRelationEnabled?: boolean;
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
