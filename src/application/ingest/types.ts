import type { AutomaticIngestRejection, MemoryTokenUsage } from '../../domain';

export type SourceBlockKind = 'message' | 'state' | 'character' | 'persona' | 'worldbook';
export type SourceBlockRole = 'user' | 'assistant' | 'system' | 'tool' | 'metadata';

export interface SourceBlock {
  id: string;
  chatKey: string;
  kind: SourceBlockKind;
  role: SourceBlockRole;
  content: string;
  createdAt: number;
  floor?: number;
  hidden?: boolean;
  entityKeys?: string[];
}

export type FactKind = 'identity' | 'relationship' | 'location' | 'world_rule' | 'state' | 'goal' | 'commitment' | 'event' | 'preference';

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
  scope?: { characterKeys?: string[]; worldKeys?: string[]; sceneKeys?: string[] };
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
  };
  jobType?: 'initialize' | 'history' | 'incremental';
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

export interface MemoryExtractor {
  extract(input: { chatKey: string; sources: readonly SourceBlock[] }): Promise<ExtractedFactProposal[] | MemoryExtractionResult>;
}

export interface IngestCommitter {
  commit(input: IngestCommit): Promise<void>;
}
