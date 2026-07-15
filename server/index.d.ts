export interface MemorySqliteStatus {
  connected: boolean;
  serverVersion: string;
  nodeVersion: string;
  protocolVersion: number;
  sqliteVersion: string;
  schemaVersion: number;
  databasePath: '_memory/memory.sqlite3';
  databaseSizeBytes: number;
  walMode: string;
  tableCounts: Record<string, number>;
  tableBytes: Record<string, number | null>;
  vectorCoverage: MemoryVectorCoverage | null;
  lastError: { code: string; message: string; at: number } | null;
}

export interface MemoryVectorCoverage {
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

export declare const info: Readonly<{ id: 'ss-helper-memory'; name: string; description: string }>;
export declare const SCHEMA_VERSION: 2;
export declare const PROTOCOL_VERSION: 1;
export declare const BUSINESS_TABLES: readonly string[];

export declare class MemorySqliteWorkerClient {
  constructor(dbPath: string);
  readonly dbPath: string;
  readonly failed: boolean;
  readonly closed: boolean;
  call<T = any>(method: string, payload?: unknown): Promise<T>;
  close(): Promise<void>;
}

export declare class MemorySqliteService {
  resolveUserDatabase(userRoot: string): string;
  forUser(userRoot: string): MemorySqliteWorkerClient;
  call<T = any>(userRoot: string, method: string, payload?: unknown): Promise<T>;
  close(): Promise<void>;
}

export declare function init(router: unknown): Promise<void>;
export declare function exit(): Promise<void>;
