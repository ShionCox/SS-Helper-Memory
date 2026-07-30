import {
  createSSHelperError,
  type PlainData,
  type WorkspaceCollectionSchema,
  type WorkspacePort,
  type WorkspaceQueryOptions,
  type WorkspaceRecord as BoundWorkspaceRecord,
  type WorkspaceSession,
  type WorkspaceVectorInfo as BoundWorkspaceVectorInfo,
} from '@ss-helper/sdk';

const SHARED_STORES = new WeakMap<WorkspacePort, MemoryStore>();

export interface StoreRecord extends BoundWorkspaceRecord {
  /** Domain-facing identifier; the SDK transport uses id. */
  readonly recordId: string;
  /** Domain code historically called the monotonic revision “version”. */
  readonly version: number;
}

export interface StoreVectorInfo extends BoundWorkspaceVectorInfo {
  readonly recordId: string;
}

export type StoreOperation =
  | {
      readonly action: 'upsert';
      readonly collection?: string;
      readonly recordId: string;
      readonly value: PlainData;
      readonly expectedVersion?: number;
      readonly expectedRevision?: number;
    }
  | {
      readonly action: 'delete';
      readonly collection?: string;
      readonly recordId: string;
      readonly expectedVersion?: number;
      readonly expectedRevision?: number;
    };

function requestId(prefix: string): string {
  return `${prefix}:${globalThis.crypto.randomUUID()}`;
}

function invalidCommitResult(stage: string): Error {
  return createSSHelperError('INVALID_PAYLOAD', { stage });
}

export class MemoryStore {
  readonly #sessions = new Map<string, WorkspaceSession>();
  readonly #schemaSignatures = new Map<string, string>();
  readonly #bindings = new Map<string, { readonly signature: string; readonly promise: Promise<WorkspaceSession> }>();

  constructor(private readonly port: WorkspacePort) {}

  async bind(
    id: string,
    collections: readonly WorkspaceCollectionSchema[],
    metadata?: PlainData,
  ): Promise<WorkspaceSession> {
    const signature = JSON.stringify(collections);
    const existing = this.#sessions.get(id);
    if (existing && this.#schemaSignatures.get(id) === signature) return existing;
    const binding = this.#bindings.get(id);
    if (binding?.signature === signature) return binding.promise;
    const promise = this.port.open({
      id,
      schema: { collections },
      ...(metadata === undefined ? {} : { metadata }),
    }).then((session) => {
      this.#sessions.set(id, session);
      this.#schemaSignatures.set(id, signature);
      return session;
    }).finally(() => {
      if (this.#bindings.get(id)?.promise === promise) this.#bindings.delete(id);
    });
    this.#bindings.set(id, { signature, promise });
    return promise;
  }

  session(id: string): WorkspaceSession {
    const session = this.#sessions.get(id);
    if (session === undefined) throw createSSHelperError('MEMORY_CAPTURE_NOT_BOUND', {
      stage: 'memory.store.session',
    });
    return session;
  }

  hasSession(id: string): boolean {
    return this.#sessions.has(id);
  }

  async health() {
    return this.port.admin.health();
  }

  async integrity() {
    return this.port.admin.integrity();
  }

  async reset(preserveIds: readonly string[] = []): Promise<number> {
    const removed = await this.port.admin.reset({
      preserveIds,
      idempotencyKey: requestId('memory-reset'),
    });
    for (const id of [...this.#sessions.keys()]) {
      if (!preserveIds.includes(id)) {
        this.#sessions.delete(id);
        this.#schemaSignatures.delete(id);
        this.#bindings.delete(id);
      }
    }
    return removed;
  }

  async read(input: { readonly workspaceId: string; readonly collection?: string; readonly recordId: string }): Promise<StoreRecord | null> {
    const record = await this.session(input.workspaceId).get(input.collection ?? 'default', input.recordId);
    return record === null ? null : { ...record, recordId: record.id, version: record.revision };
  }

  async scan(input: { readonly workspaceId: string; readonly collection?: string } & WorkspaceQueryOptions) {
    const { workspaceId, collection = 'default', ...options } = input;
    const page = await this.session(workspaceId).query(collection, options);
    return {
      records: page.records.map(record => ({ ...record, recordId: record.id, version: record.revision })),
      nextCursor: page.nextCursor,
      ...(page.total === undefined ? {} : { total: page.total }),
    };
  }

  async apply(input: {
    readonly workspaceId: string;
    readonly idempotencyKey?: string;
    readonly operations: readonly StoreOperation[];
  }) {
    const result = await this.session(input.workspaceId).commit({
      idempotencyKey: input.idempotencyKey ?? requestId('memory-commit'),
      operations: input.operations.map(operation => operation.action === 'upsert'
        ? {
            action: 'put' as const,
            collection: operation.collection ?? 'default',
            id: operation.recordId,
            value: operation.value,
            ...((operation.expectedRevision ?? operation.expectedVersion) === undefined
              ? {}
              : { expectedRevision: operation.expectedRevision ?? operation.expectedVersion }),
          }
        : {
            action: 'delete' as const,
            collection: operation.collection ?? 'default',
            id: operation.recordId,
            ...((operation.expectedRevision ?? operation.expectedVersion) === undefined
              ? {}
              : { expectedRevision: operation.expectedRevision ?? operation.expectedVersion }),
          }),
    });
    return {
      ...result,
      operationCount: result.results.length,
      results: result.results.map(item => ({
        ...item,
        recordId: item.id,
        action: item.action === 'put' ? 'upsert' as const : 'delete' as const,
        version: item.revision,
      })),
    };
  }

  async write(input: {
    readonly workspaceId: string;
    readonly collection?: string;
    readonly recordId: string;
    readonly value: PlainData;
    readonly expectedVersion?: number;
    readonly expectedRevision?: number;
  }): Promise<StoreRecord> {
    const result = await this.apply({
      workspaceId: input.workspaceId,
      operations: [{
        action: 'upsert',
        collection: input.collection,
        recordId: input.recordId,
        value: input.value,
        expectedRevision: input.expectedRevision ?? input.expectedVersion,
      }],
    });
    const item = result.results[0];
    if (result.results.length !== 1
      || item?.action !== 'upsert'
      || item.recordId !== input.recordId
      || !Number.isSafeInteger(item.revision)
      || item.revision <= 0) {
      throw invalidCommitResult('memory.store.write.result');
    }
    const stored = await this.read({
      workspaceId: input.workspaceId,
      collection: input.collection,
      recordId: input.recordId,
    });
    if (stored === null || stored.revision !== item.revision) {
      throw invalidCommitResult('memory.store.write.readback');
    }
    return stored;
  }

  async remove(input: {
    readonly workspaceId: string;
    readonly collection?: string;
    readonly recordId: string;
    readonly expectedVersion?: number;
    readonly expectedRevision?: number;
  }): Promise<boolean> {
    const result = await this.apply({
      workspaceId: input.workspaceId,
      operations: [{
        action: 'delete',
        collection: input.collection,
        recordId: input.recordId,
        expectedRevision: input.expectedRevision ?? input.expectedVersion,
      }],
    });
    const item = result.results[0];
    if (result.results.length !== 1
      || item?.action !== 'delete'
      || item.recordId !== input.recordId
      || !Number.isSafeInteger(item.revision)
      || item.revision < 0
      || typeof item.removed !== 'boolean') {
      throw invalidCommitResult('memory.store.remove.result');
    }
    return item.removed;
  }

  readonly vectors = {
    upsert: async (input: { readonly workspaceId: string; readonly collection?: string; readonly recordId: string; readonly vector: readonly number[]; readonly model?: string; readonly metadata?: PlainData }): Promise<void> => {
      await this.session(input.workspaceId).vectors.upsert({
        collection: input.collection ?? 'default',
        id: input.recordId,
        vector: input.vector,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      });
    },
    search: async (input: { readonly workspaceId: string; readonly collection?: string; readonly vector: readonly number[]; readonly limit?: number; readonly model?: string; readonly metadata?: Readonly<Record<string, PlainData>> }) => {
      const hits = await this.session(input.workspaceId).vectors.search({
        ...(input.collection === undefined ? {} : { collection: input.collection }),
        vector: input.vector,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      });
      return hits.map(hit => ({ ...hit, recordId: hit.id }));
    },
    delete: async (input: { readonly workspaceId: string; readonly collection?: string; readonly recordId: string }): Promise<boolean> =>
      this.session(input.workspaceId).vectors.delete(input.collection ?? 'default', input.recordId),
    list: async (input: { readonly workspaceId: string; readonly collection?: string; readonly cursor?: string; readonly limit?: number; readonly model?: string; readonly metadata?: Readonly<Record<string, PlainData>> }) => {
      const page = await this.session(input.workspaceId).vectors.list({
        ...(input.collection === undefined ? {} : { collection: input.collection }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      });
      return {
        vectors: page.vectors.map(vector => ({ ...vector, recordId: vector.id })),
        nextCursor: page.nextCursor,
      };
    },
    clear: async (input: { readonly workspaceId: string; readonly collection?: string; readonly model?: string; readonly metadata?: Readonly<Record<string, PlainData>> }): Promise<number> => {
      return this.session(input.workspaceId).vectors.clear({
        ...(input.collection === undefined ? {} : { collection: input.collection }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      });
    },
  };
}

export function memoryStoreFor(port: WorkspacePort): MemoryStore {
  let store = SHARED_STORES.get(port);
  if (!store) {
    store = new MemoryStore(port);
    SHARED_STORES.set(port, store);
  }
  return store;
}
