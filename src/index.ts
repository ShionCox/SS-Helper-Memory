import type {
  FactListOptions,
  MainChatUsage,
  ManualFactInput,
  MemoryFact,
  MemoryRecallLog,
} from './domain';
import type { RecallQuery, RecallResult } from './application/recall';
import type { MemoryCaptureProgress } from './ui/memory-ui';

export interface MemorySqliteStatus {
  connected: boolean;
  serverVersion: string;
  nodeVersion: string;
  protocolVersion: number;
  sqliteVersion: string;
  schemaVersion: number;
  databasePath: string;
  databaseSizeBytes: number;
  walMode: string;
  tableCounts: Record<string, number>;
  tableBytes: Record<string, number | null>;
  vectorCoverage: {
    indexedFacts: number;
    eligibleFacts: number;
    ratio: number;
  };
  lastError?: string;
}

export interface MemoryPluginApi {
  getChatKey(): string;
  listChatKeys(): Promise<string[]>;
  facts: {
    list(options?: FactListOptions): Promise<MemoryFact[]>;
    search(query: string, options?: FactListOptions): Promise<MemoryFact[]>;
    upsert(input: ManualFactInput): Promise<MemoryFact>;
    remove(id: string): Promise<void>;
  };
  capture: {
    flush(): Promise<void>;
  };
  recall: {
    preview(input: Omit<RecallQuery, 'chatKey'> & { query: string }): Promise<RecallResult>;
  };
  backup: {
    export(): Promise<Blob>;
    import(file: File): Promise<void>;
    checkIntegrity(): Promise<{ ok: boolean; message: string }>;
  };
  diagnostics: {
    getLastRecall(): Promise<MemoryRecallLog | RecallResult | null>;
  };
  getCaptureProgress(): Promise<MemoryCaptureProgress>;
  cancelCapture(): Promise<void>;
  listAuditRecords(): Promise<Array<Record<string, unknown>>>;
  getMainChatUsage(): Promise<MainChatUsage[]>;
  rollbackBatch(jobId: string, batchIndex: number): Promise<void>;
  getSqliteStatus(): Promise<MemorySqliteStatus>;
  clearCurrentChatData(): Promise<void>;
}

export * from './domain';
export * from './application/recall';
export * from './application/prompt';
export type { SourceBlock, ExtractedFactProposal } from './application/ingest/types';
