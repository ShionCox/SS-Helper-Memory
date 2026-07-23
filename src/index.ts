import type {
  FactListOptions,
  MainChatUsage,
  ManualFactInput,
  MemoryFact,
  MemoryGraphPreview,
  MemoryGraphStatus,
  MemoryRecallLog,
} from './domain';
import type { RecallQuery, RecallResult } from './application/recall';
import type { MemoryCaptureProgress, MemoryInitializationOptions } from './ui/memory-ui';

export interface MemorySqliteStatus {
  connected: boolean;
  serverVersion: string;
  nodeVersion: string;
  protocolVersion: number;
  sqliteVersion: string;
  schemaVersion: number;
  databasePath: string;
  databaseSizeBytes: number;
  workspaceSizeBytes: number;
  currentChatSizeBytes: number;
  currentChatUsageRatio: number;
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
  graph: {
    /** Returns an empty graph when chatKey is not the currently bound chat. */
    preview(input: { chatKey: string; query: string; limit?: number }): Promise<MemoryGraphPreview>;
    getStatus(): MemoryGraphStatus;
    rebuild(): Promise<void>;
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
  getInitializationState(): Promise<import('./ui/memory-ui').MemoryInitializationState>;
  reinitialize(selectedKinds?: string[], options?: MemoryInitializationOptions): Promise<void>;
  cancelCapture(): Promise<void>;
  listAuditRecords(): Promise<Array<Record<string, unknown>>>;
  getMainChatUsage(): Promise<MainChatUsage[]>;
  rollbackBatch(jobId: string, batchIndex: number): Promise<void>;
  getSqliteStatus(): Promise<MemorySqliteStatus>;
  clearCurrentChatData(): Promise<void>;
  clearAllMemoryData(): Promise<void>;
  captureActors?(): Promise<import('./application/actors').MultiActorCaptureResult>;
  recallActors?(input: import('./domain').ActorRecallRequest): Promise<import('./domain').ActorRecallResponse>;
  updateActorProfile?(ownerId: string): Promise<readonly import('./domain').ProfileClaim[]>;
  enqueueActorDream?(ownerId: string, traceIds?: readonly string[]): Promise<import('./domain').DreamJob>;
  runActorDream?(jobId: string, options?: { readonly dryRun?: boolean; readonly narrative?: boolean }): Promise<import('./application/dream').DreamAudit>;
  auditActorOutput?(output: string): import('./application/recall').KnowledgeLeakageAudit | null;
  listActors?(): Promise<readonly import('./domain').MemoryOwner[]>;
  listActorAliases?(): Promise<readonly import('./domain').ActorAlias[]>;
  listSceneCasts?(): Promise<readonly import('./domain').SceneCast[]>;
  listEpisodes?(): Promise<readonly import('./domain').MemoryEpisode[]>;
  listObservations?(): Promise<readonly import('./domain').MemoryObservation[]>;
  listActorTraces?(ownerId?: string): Promise<readonly import('./domain').ActorMemoryTrace[]>;
  listActorProfiles?(ownerId?: string): Promise<readonly Record<string, unknown>[]>;
  listActorDreams?(ownerId?: string): Promise<readonly Record<string, unknown>[]>;
  rollbackActorDream?(auditId: string): Promise<void>;
}

export * from './domain';
export * from './application/recall';
export * from './application/graph';
export * from './application/prompt';
export * from './application/actors';
export * from './application/profile';
export * from './application/dream';
export * from './application/evaluation/multi-actor-offline-evaluator';
export type { SourceBlock, ExtractedFactProposal } from './application/ingest/types';
