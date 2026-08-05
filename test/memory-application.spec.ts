import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSHelperError, type SSHelperFailureContext } from '@ss-helper/sdk';
import type { ActorMemoryTrace, CaptureRepairQueueRecord, MemoryFact, MemoryJob, MemoryRecallLog } from '../src/domain';
import type { ExistingMemoryContextItem, SourceBlock } from '../src/application/ingest/types';
import { buildEvidenceWindowHash } from '../src/application/ingest/supported-evidence-directory';
import { MEMORY_DEFAULT_SETTINGS } from '../src/ss-helper/settings';

type TestRecallRoutes = {
  embedding: { available: boolean; resourceId?: string; model?: string; failure?: SSHelperFailureContext };
  rerank: { available: boolean; resourceId?: string; model?: string; failure?: SSHelperFailureContext };
};

const state = vi.hoisted(() => ({
  sources: [] as SourceBlock[],
  release: null as null | (() => void),
  extractCalls: 0,
  lastExtractSources: [] as SourceBlock[],
  lastExtractExistingMemoryContext: [] as readonly ExistingMemoryContextItem[],
  recallRoutePromise: null as Promise<TestRecallRoutes> | null,
  recallRouteRelease: null as ((routes: TestRecallRoutes) => void) | null,
}));

vi.mock('../src/host/source-adapter', async () => {
  const actual = await vi.importActual<typeof import('../src/host/source-adapter')>('../src/host/source-adapter');
  return { ...actual, collectCurrentChatSources: async () => state.sources };
});

vi.mock('../src/application/ingest/llm-extractor', () => ({
  readMemoryLlmClient: () => ({}),
  readMemoryLlmRouteDiagnostic: async () => ({ available: true, resourceId: 'test-resource', model: 'test-model' }),
  readMemoryRecallRouteDiagnostics: () => state.recallRoutePromise ?? Promise.resolve({
    embedding: { available: false, failure: { reasonCode: 'LLM_CAPABILITY_UNAVAILABLE', stage: 'test.route' } },
    rerank: { available: false, failure: { reasonCode: 'LLM_CAPABILITY_UNAVAILABLE', stage: 'test.route' } },
  }),
  MEMORY_PLUGIN_ID: 'stx_memory',
  MEMORY_EMBED_TASK: 'memory_embed',
  MEMORY_RERANK_TASK: 'memory_rerank',
  LlmMemoryExtractor: class {
    extract(input: { sources: SourceBlock[]; existingMemoryContext?: readonly ExistingMemoryContextItem[] }): Promise<[]> {
      state.extractCalls += 1;
      state.lastExtractSources = [...input.sources];
      state.lastExtractExistingMemoryContext = [...(input.existingMemoryContext ?? [])];
      return new Promise((resolve) => { state.release = () => resolve([]); });
    }
  },
  StructuredMemoryCaptureExtractor: class {
    extract(input: { sources: SourceBlock[]; existingMemoryContext?: readonly ExistingMemoryContextItem[] }): Promise<[]> {
      state.extractCalls += 1;
      state.lastExtractSources = [...input.sources];
      state.lastExtractExistingMemoryContext = [...(input.existingMemoryContext ?? [])];
      return Promise.resolve([]);
    }
  },
}));

class FakeRepository {
  readonly facts: MemoryFact[] = [];
  readonly jobs: MemoryJob[] = [];
  readonly audits: Array<{ sourceRefs: string[] }> = [];
  recallLog: MemoryRecallLog | undefined;
  readonly putJob = vi.fn(async (job: MemoryJob) => {
    const index = this.jobs.findIndex((item) => item.id === job.id);
    if (index >= 0) this.jobs[index] = structuredClone(job);
    else this.jobs.push(structuredClone(job));
  });
  readonly commit = vi.fn(async () => undefined);
  readonly importBackup = vi.fn(async () => undefined);
  readonly getChatKeys = vi.fn(async () => ['chat-a']);
  readonly reconcileGraphProjection = vi.fn(async () => undefined);
  readonly settings = new Map<string, unknown>();
  readonly workspace = {
    admin: {
      health: async () => ({ ready: true, status: 'ready' as const, database: 'memory', schemaVersion: 0 }),
      integrity: async () => ({ ok: true, messages: [] }),
      reset: async () => 0,
      backup: async () => ({ archive: {}, sha256: '' }),
    },
    open: async ({ id }: { id: string }) => ({
      id,
      get: async (collection: string, recordId: string) => {
        const value = collection === 'capture-jobs'
          ? this.jobs.find(job => job.id === recordId)
          : collection === 'facts'
            ? this.facts.find(fact => fact.id === recordId)
            : undefined;
        return value ? { id: recordId, value: structuredClone(value), revision: 1, updatedAt: Number((value as { updatedAt?: number }).updatedAt ?? 1) } : null;
      },
      query: async (collection: string, options: { filter?: Readonly<Record<string, unknown>> } = {}) => {
        const values: unknown[] = collection === 'capture-jobs' ? this.jobs : collection === 'facts' ? this.facts : [];
        const records = values
          .filter(value => Object.entries(options.filter ?? {}).every(([key, expected]) => {
            const actual = (value as Record<string, unknown>)[key];
            return key === 'workspaceId' && actual === undefined ? expected === id : actual === expected;
          }))
          .map(value => ({ id: String((value as { id: string }).id), value: structuredClone(value), revision: 1, updatedAt: Number((value as { updatedAt?: number }).updatedAt ?? 1) }));
        return { records, nextCursor: null };
      },
      commit: async ({ operations }: { operations: ReadonlyArray<{ action: 'put' | 'delete'; collection: string; id: string; value?: unknown }> }) => {
        for (const operation of operations) {
          if (operation.collection !== 'capture-jobs') continue;
          const index = this.jobs.findIndex(job => job.id === operation.id);
          if (operation.action === 'delete') {
            if (index >= 0) this.jobs.splice(index, 1);
          } else if (operation.value) {
            const value = structuredClone(operation.value) as MemoryJob;
            if (index >= 0) this.jobs[index] = value;
            else this.jobs.push(value);
          }
        }
        return { requestId: 'test', replayed: false, results: operations.map(operation => ({ collection: operation.collection, id: operation.id, action: operation.action, revision: 1 })) };
      },
      vectors: {
        upsert: async () => undefined,
        search: async () => [],
        delete: async () => false,
        list: async () => ({ vectors: [], nextCursor: null }),
        clear: async () => 0,
      },
    }),
  };
  async open(): Promise<void> {}
  close(): void {}
  async getSetting<T>(key: string): Promise<T | undefined> { return this.settings.get(key) as T | undefined; }
  async setSetting(): Promise<void> {}
  async setSettings(values: Record<string, unknown>): Promise<void> { Object.entries(values).forEach(([key, value]) => this.settings.set(key, structuredClone(value))); }
  async listFacts(): Promise<MemoryFact[]> { return structuredClone(this.facts); }
  async bootstrap(): Promise<{ facts: []; vectorFacts: [] }> { return { facts: [], vectorFacts: [] }; }
  async listJobs(): Promise<MemoryJob[]> { return [...this.jobs].sort((a, b) => b.updatedAt - a.updatedAt); }
  async listJobBatchAudits(): Promise<Array<{ sourceRefs: string[] }>> { return structuredClone(this.audits); }
  async listEvidence(): Promise<[]> { return []; }
  async addRecallLog(log: MemoryRecallLog): Promise<void> { this.recallLog = structuredClone(log); }
  async getLastRecall(): Promise<MemoryRecallLog | undefined> { return structuredClone(this.recallLog); }
  getHealthSnapshot(): undefined { return undefined; }
  readonly clearCurrentChatData = vi.fn(async (chatKey: string) => {
    for (let index = this.jobs.length - 1; index >= 0; index -= 1) {
      if (this.jobs[index]?.chatKey === chatKey) this.jobs.splice(index, 1);
    }
  });
}

function message(index: number): SourceBlock {
  return { id: `message:${index}`, chatKey: 'chat-a', kind: 'message', role: index % 2 ? 'assistant' : 'user', content: `第 ${index} 条可见消息正文`, createdAt: index };
}

function fact(id: string, content: string): MemoryFact {
  return {
    id, chatKey: 'chat-a', kind: 'preference', subjectKey: 'Aerin', predicateKey: 'fears', objectKey: 'thunder',
    canonicalKey: `preference|aerin|fears|thunder|${id}`, slotKey: 'aerin|fears', content, entityKeys: ['Aerin', 'thunder'],
    confidence: 0.95, status: 'active', sourceRefs: ['message:old'], evidenceIds: [], freshestEvidenceAt: 1,
    origin: 'automatic', revision: 1, createdAt: 1, updatedAt: 1,
  };
}

function connectHost(app: { useHostContext(context: { getChatKey(): string; getWorkspaceId(): string; collectSources(chatKey: string): Promise<SourceBlock[]> }): void }): void {
  app.useHostContext({ getChatKey: () => 'chat-a', getWorkspaceId: () => 'character:c1', collectSources: async () => state.sources });
}

function attachClaimCapture(
  app: object,
  repository: FakeRepository,
  options: { block?: boolean } = {},
): void {
  const actorRepository = {
    boundWorkspaceId: 'character:c1',
    boundChatKey: 'chat-a',
    bind: () => undefined,
    open: async () => undefined,
    listFacts: async () => structuredClone(repository.facts),
    listTraces: async () => [],
    listOwners: async () => [],
    listAliases: async () => [],
    listPendingCandidates: async () => [],
    listLocations: async () => [],
    listLocationAliases: async () => [],
    listPendingLocationCandidates: async () => [],
    listChangeAudits: async () => [],
    listCaptureJobs: async () => structuredClone(repository.jobs),
    listDerived: async () => [],
    upsertCaptureJob: async (job: MemoryJob) => repository.putJob(job),
    rollbackChangeSet: async () => undefined,
    upsertDerived: async () => undefined,
    upsertDerivedForChangeSet: async () => undefined,
    clearCurrentChatData: async () => undefined,
  };
  const actorCapture = {
    capture: async (input: {
      sources: readonly SourceBlock[];
      existingMemoryContext?: readonly ExistingMemoryContextItem[];
    }) => {
      state.extractCalls += 1;
      state.lastExtractSources = [...input.sources];
      state.lastExtractExistingMemoryContext = [...(input.existingMemoryContext ?? [])];
      if (options.block === true) {
        await new Promise<void>((resolve) => { state.release = resolve; });
      }
      const now = Date.now();
      return {
        envelope: {
          workspaceId: 'character:c1', chatKey: 'chat-a', sourceRefs: input.sources.map(source => source.id),
          actorCandidates: [], locationCandidates: [], episodes: [], claimLocalIds: [], capturedAt: now,
        },
        owners: [], pendingCandidates: [], locations: [], locationAliases: [], pendingLocationCandidates: [],
        episodes: [], observations: [], facts: [], traces: [],
        sceneCast: {
          id: `scene:test:${state.extractCalls}`, workspaceId: 'character:c1', chatKey: 'chat-a',
          floor: Math.max(0, ...input.sources.map(source => source.floor ?? 0)), members: [],
          viewpointOwnerId: 'owner:unknown', speakerOwnerIds: [], presentOwnerIds: [], mentionedOwnerIds: [], createdAt: now,
        },
        outcome: 'complete' as const,
        rejections: [],
        acceptedLocalIds: { actor: [], location: [], episode: [], claim: [] },
      };
    },
  };
  (app as { multiActorRepository: unknown }).multiActorRepository = actorRepository;
  (app as { actorCapture: unknown }).actorCapture = actorCapture;
}

describe('MemoryApplication 初始化范围与可取消进度', () => {
  beforeEach(() => {
    state.sources = [];
    state.release = null;
    state.extractCalls = 0;
    state.lastExtractSources = [];
    state.lastExtractExistingMemoryContext = [];
    state.recallRoutePromise = null;
    state.recallRouteRelease = null;
  });

  it('把 Capture change audit 与 repair queue 合并为安全必填读模型', async () => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const app = new MemoryApplication(new FakeRepository() as never);
    connectHost(app);
    const queue: CaptureRepairQueueRecord = {
      id: 'repair:1', workspaceId: 'character:c1', chatKey: 'chat-a', jobId: 'job:capture',
      batchIndex: 2, collection: 'claims', itemIndex: 0,
      issues: [{ path: '$.claims[0].kind', keyword: 'enum', expected: 'known fact kind' }],
      sourceRefs: ['message:7'], fallbackSourceRefs: ['message:6'],
      originalRequestId: 'request:safe', originalResourceId: 'memory_extract', originalModel: 'model-safe',
      rejectionId: 'rejection:1', status: 'unresolved', attemptCount: 1, maxAttempts: 2,
      waitingForEvidenceChange: true,
      failure: { reasonCode: 'SCHEMA_VALIDATION_FAILED', stage: 'memory.capture.item', requestId: 'request:safe', batchIndex: 2, collection: 'claims', path: '$.claims[0].kind' },
      createdAt: 10, updatedAt: 20,
    };
    (app as unknown as {
      multiActorRepository: {
        listChangeAudits(): Promise<Array<Record<string, unknown>>>;
        listCaptureRepairQueue(): Promise<CaptureRepairQueueRecord[]>;
      };
    }).multiActorRepository = {
      listChangeAudits: async () => [{
        id: 'change-audit:1', workspaceId: 'character:c1', chatKey: 'chat-a', kind: 'capture-change-set-v0', createdAt: 30,
        entries: [{ collection: 'facts', recordId: 'fact:secret', after: { content: '候选正文不得进入 UI' } }],
        metadata: {
          captureJobId: 'job:capture', batchIndex: 2, outcome: 'partial', requestId: 'request:safe', resourceId: 'memory_extract', model: 'model-safe', fallbackUsed: false,
          sourceRefs: ['message:7'], accepted: { facts: 3, observations: 1 },
          rejections: [{
            id: 'rejection:1', index: 0, code: 'schema_validation_failed', message: '原始错误消息不得进入 UI', recordType: 'claim', fieldPath: '$.claims[0].kind',
            sourceRefs: ['message:7'], requestId: 'request:safe', status: 'unresolved',
            candidateSnapshot: { content: '候选正文不得进入 UI' },
          }],
        },
      }],
      listCaptureRepairQueue: async () => [queue],
    };

    const records = await app.listAuditRecords();

    expect(records).toEqual([expect.objectContaining({
      id: 'change-audit:1', jobId: 'job:capture', batchIndex: 2, status: 'partial', outcome: 'partial',
      acceptedCount: 4, rejectedCount: 1, unresolvedCount: 1, repairedCount: 0, ignoredCount: 0,
      requestId: 'request:safe', resourceId: 'memory_extract', model: 'model-safe', fallbackUsed: false,
      issues: [expect.objectContaining({
        id: 'rejection:1', collection: 'claims', path: '$.claims[0].kind', status: 'unresolved',
        canIgnore: true, attemptCount: 1, waitingForEvidenceChange: true,
        failure: expect.objectContaining({ reasonCode: 'SCHEMA_VALIDATION_FAILED', requestId: 'request:safe' }),
      })],
    })]);
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('entries');
    expect(serialized).not.toContain('metadata');
    expect(serialized).not.toContain('candidateSnapshot');
    expect(serialized).not.toContain('原始错误消息');
    expect(serialized).not.toContain('候选正文');
  });

  it('按 Capture 批次隔离 repair queue，补齐安全上下文并展开全部字段问题', async () => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const app = new MemoryApplication(new FakeRepository() as never);
    connectHost(app);
    const repair = (overrides: Partial<CaptureRepairQueueRecord>): CaptureRepairQueueRecord => ({
      id: 'repair:default', workspaceId: 'character:c1', chatKey: 'chat-a', jobId: 'job:shared',
      batchIndex: 0, collection: 'claims', itemIndex: 0,
      issues: [{ path: '$.default', keyword: 'type', expected: 'string' }],
      sourceRefs: [], fallbackSourceRefs: [], rejectionId: 'rejection:default',
      status: 'unresolved', attemptCount: 0, createdAt: 1, updatedAt: 1,
      ...overrides,
    });
    const queue = [
      repair({
        id: 'repair:batch-0', batchIndex: 0, rejectionId: 'rejection:batch-0',
        originalRequestId: 'request:batch-0', originalResourceId: 'resource:batch-0', originalModel: 'model:batch-0',
        issues: [
          { path: '$.claims[0].kind', keyword: 'enum', expected: 'known kind' },
          { path: '$.claims[0].subjectRef', keyword: 'required', expected: 'owner ref' },
        ],
        failure: { reasonCode: 'SCHEMA_VALIDATION_FAILED', stage: 'memory.capture.schema' },
      }),
      repair({ id: 'repair:batch-1', batchIndex: 1, rejectionId: 'rejection:batch-1', issues: [{ path: '$.claims[1]', keyword: 'type', expected: 'claim' }] }),
      repair({ id: 'repair:other-job', jobId: 'job:other', batchIndex: 0, rejectionId: 'rejection:other', issues: [{ path: '$.other', keyword: 'type', expected: 'never' }] }),
    ];
    (app as unknown as {
      multiActorRepository: {
        listChangeAudits(): Promise<Array<Record<string, unknown>>>;
        listCaptureRepairQueue(): Promise<CaptureRepairQueueRecord[]>;
      };
    }).multiActorRepository = {
      listChangeAudits: async () => [0, 1].map(batchIndex => ({
        id: `change-audit:batch-${batchIndex}`,
        workspaceId: 'character:c1',
        chatKey: 'chat-a',
        kind: 'capture-change-set-v0',
        createdAt: 20 - batchIndex,
        entries: [],
        metadata: {
          captureJobId: 'job:shared',
          batchIndex,
          outcome: 'partial',
          accepted: { facts: 1 },
          rejections: [{
            id: `rejection:batch-${batchIndex}`,
            index: batchIndex,
            code: 'schema_validation_failed',
            message: '原始错误不得展示',
            recordType: 'claim',
            status: 'unresolved',
          }],
        },
      })),
      listCaptureRepairQueue: async () => queue,
    };

    const records = await app.listAuditRecords();
    const batch0 = records.find(record => record.batchIndex === 0)!;
    const batch1 = records.find(record => record.batchIndex === 1)!;
    expect(batch0.issues.map(issue => issue.path)).toEqual(['$.claims[0].kind', '$.claims[0].subjectRef']);
    expect(batch0.issues.map(issue => issue.failure.path)).toEqual(['$.claims[0].kind', '$.claims[0].subjectRef']);
    expect(batch0.issues.map(issue => issue.id)).toEqual(['rejection:batch-0:issue:0', 'rejection:batch-0:issue:1']);
    expect(batch0.issues.map(issue => issue.canIgnore)).toEqual([true, false]);
    expect(batch0.unresolvedCount).toBe(1);
    expect(batch0.issues[0]?.failure).toEqual(expect.objectContaining({
      reasonCode: 'SCHEMA_VALIDATION_FAILED',
      stage: 'memory.capture.schema',
      requestId: 'request:batch-0',
      resourceId: 'resource:batch-0',
      model: 'model:batch-0',
    }));
    expect(batch1.issues.map(issue => issue.path)).toEqual(['$.claims[1]']);
    expect(batch1.issues.every(issue => issue.batchIndex === 1)).toBe(true);
    expect(JSON.stringify(records)).not.toContain('$.other');
    expect(JSON.stringify(records)).not.toContain('rejection:other');
  });

  it('审计投影把已回滚 Capture 标记为 rolled_back', async () => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const app = new MemoryApplication(new FakeRepository() as never);
    connectHost(app);
    (app as unknown as { multiActorRepository: { listChangeAudits(): Promise<Array<Record<string, unknown>>>; listCaptureRepairQueue(): Promise<CaptureRepairQueueRecord[]> } }).multiActorRepository = {
      listChangeAudits: async () => [{
        id: 'change-audit:rolled-back', workspaceId: 'character:c1', chatKey: 'chat-a', kind: 'capture-change-set-v0', createdAt: 30, rolledBackAt: 40, entries: [],
        metadata: { captureJobId: 'job:rolled-back', batchIndex: 0, outcome: 'complete', accepted: { facts: 2 }, sourceRefs: [] },
      }],
      listCaptureRepairQueue: async () => [],
    };

    await expect(app.listAuditRecords()).resolves.toEqual([
      expect.objectContaining({ id: 'change-audit:rolled-back', status: 'rolled_back', rolledBackAt: 40, acceptedCount: 2 }),
    ]);
  });

  it('审计分页把后续 cursor 继续交给 SQLite，而不调用全量列表', async () => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const app = new MemoryApplication(new FakeRepository() as never);
    connectHost(app);
    const changeAudit = (id: string, createdAt: number) => ({
      id, workspaceId: 'character:c1', chatKey: 'chat-a', kind: 'capture-change-set-v0' as const,
      createdAt, entries: [], metadata: { captureJobId: id, batchIndex: 0, outcome: 'complete', accepted: {} },
    });
    const page = vi.fn(async (collection: string, request: { cursor?: string }) => {
      if (collection === 'capture-repair-queue') return { items: [], nextCursor: null };
      return request.cursor === 'cursor:next'
        ? { items: [changeAudit('audit:second', 10)], nextCursor: null, total: 2 }
        : { items: [changeAudit('audit:first', 20)], nextCursor: 'cursor:next', total: 2 };
    });
    const listChangeAudits = vi.fn(async () => { throw new Error('不应全量读取'); });
    const listCaptureRepairQueue = vi.fn(async () => { throw new Error('不应全量读取'); });
    (app as unknown as { multiActorRepository: unknown }).multiActorRepository = {
      boundWorkspaceId: 'character:c1',
      page,
      listChangeAudits,
      listCaptureRepairQueue,
    };

    const first = await app.listAuditRecordsPage({ limit: 1, includeTotal: true });
    const second = await app.listAuditRecordsPage({ limit: 1, cursor: first.nextCursor ?? undefined, includeTotal: true });

    expect(first.items.map(item => item.id)).toEqual(['audit:first']);
    expect(first.nextCursor).toBe('cursor:next');
    expect(second.items.map(item => item.id)).toEqual(['audit:second']);
    expect(page.mock.calls.filter(([collection]) => collection === 'change-audits').map(([, request]) => request.cursor)).toEqual([undefined, 'cursor:next']);
    expect(listChangeAudits).not.toHaveBeenCalled();
    expect(listCaptureRepairQueue).not.toHaveBeenCalled();
  });

  it('Token 用量分页保留 null，并把后续 cursor 限定在当前聊天', async () => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const repository = new FakeRepository();
    const usage = (id: string, totalTokens: number | null) => ({
      id, chatKey: 'chat-a', messageId: id, promptTokens: null, completionTokens: 1,
      cacheReadTokens: null, cacheWriteTokens: null, totalTokens, capturedAt: id === 'usage:first' ? 20 : 10,
    });
    const pageCollection = vi.fn(async (_collection: string, request: { cursor?: string }, scope: { chatKey: string }) => ({
      items: [request.cursor ? usage('usage:second', null) : usage('usage:first', 2)],
      nextCursor: request.cursor ? null : 'usage:next',
      total: 2,
      scope,
    }));
    (repository as unknown as { pageCollection: typeof pageCollection }).pageCollection = pageCollection;
    const app = new MemoryApplication(repository as never);
    connectHost(app);

    const first = await app.getMainChatUsagePage({ limit: 1, includeTotal: true });
    const second = await app.getMainChatUsagePage({ limit: 1, cursor: 'usage:next', includeTotal: true });

    expect(first.items[0]?.totalTokens).toBe(2);
    expect(second.items[0]?.totalTokens).toBeNull();
    expect(pageCollection.mock.calls.map(([, request]) => request.cursor)).toEqual([undefined, 'usage:next']);
    expect(pageCollection.mock.calls.every(([, , scope]) => scope.chatKey === 'chat-a')).toBe(true);
  });

  it('按当前 workspace 和 chatKey 读取指定召回详情', async () => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const repository = new FakeRepository();
    const getGenerationRecallDetail = vi.fn(async () => undefined);
    (repository as unknown as { getGenerationRecallDetail: typeof getGenerationRecallDetail }).getGenerationRecallDetail = getGenerationRecallDetail;
    const app = new MemoryApplication(repository as never);
    connectHost(app);

    await expect(app.getGenerationRecallDetail('generation-recall:1')).resolves.toBeUndefined();
    expect(getGenerationRecallDetail).toHaveBeenCalledWith('character:c1', 'chat-a', 'generation-recall:1');
    await expect(app.getGenerationRecallDetail(' ')).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
      details: { stage: 'memory.generation-recall.detail-scope' },
    });
  });

  it('场景工作台观察记录只返回当前聊天事件精确归属的数据', async () => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const app = new MemoryApplication(new FakeRepository() as never);
    const currentEpisode = { id: 'episode:chat-a', chatKey: 'chat-a' };
    const otherEpisode = { id: 'episode:chat-b', chatKey: 'chat-b' };
    const currentObservation = { id: 'observation:chat-a', episodeId: currentEpisode.id };
    const otherObservation = { id: 'observation:chat-b', episodeId: otherEpisode.id };
    (app as unknown as {
      multiActorRepository: {
        listEpisodes(): Promise<Array<typeof currentEpisode>>;
        listObservations(): Promise<Array<typeof currentObservation>>;
      };
    }).multiActorRepository = {
      listEpisodes: async () => [currentEpisode],
      listObservations: async () => [otherObservation, currentObservation],
    };

    await expect(app.listEpisodes()).resolves.toEqual([currentEpisode]);
    await expect(app.listObservations()).resolves.toEqual([currentObservation]);
  });

  it('当前聊天完成绑定后通知已打开的工作台刷新数据', async () => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const app = new MemoryApplication(new FakeRepository() as never);
    connectHost(app);
    const listener = vi.fn();
    const remove = app.onOverviewChanged(listener);

    await app.start();

    expect(listener).toHaveBeenCalled();
    remove();
    app.stop();
  });

  it('多角色仓库关键读取失败时报告绑定错误而不是伪装成健康空数据', async () => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const app = new MemoryApplication(new FakeRepository() as never);
    connectHost(app);
    await app.start();
    (app as unknown as {
      multiActorRepository: {
        bind(workspaceId: string, chatKey: string): void;
        listFacts(): Promise<MemoryFact[]>;
        listTraces(): Promise<ActorMemoryTrace[]>;
        listDerived(): Promise<Record<string, unknown>[]>;
      };
    }).multiActorRepository = {
      bind: () => undefined,
      listFacts: async () => { throw new Error('actor facts read failed'); },
      listTraces: async () => [],
      listDerived: async () => [],
    };

    const overview = await app.getOverview();

    expect(overview.status).toBe('error');
    expect(overview.bound).toBe(false);
    expect(overview.failure).toEqual(expect.objectContaining({
      reasonCode: 'MEMORY_CHAT_READ_FAILED',
      stage: 'memory.chat-bind',
    }));
    expect(JSON.stringify(overview.failure)).not.toContain('actor facts read failed');
    app.stop();
  });

  it('Dream Apply 失败后持久化 failed job，避免重启后丢失失败状态', async () => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const app = new MemoryApplication(new FakeRepository() as never);
    const ownerId = 'owner:actor:a';
    const memory = fact('dream-fact', 'A记得地下室的银钥匙');
    const trace: ActorMemoryTrace = {
      id: 'dream-trace', workspaceId: 'w', chatKey: 'chat-a', ownerId, factId: memory.id,
      sourceObservationIds: ['dream-observation'], knowledgeMode: 'experienced', privacy: 'private',
      strength: 90, clarity: 90, beliefConfidence: 1, emotionalSalience: 0.4,
      rehearsalCount: 0, traceRevision: 1, learnedAt: 1, createdAt: 1, updatedAt: 1,
    };
    const derived = new Map<string, Record<string, unknown>[]>();
    const upsertDerived = vi.fn(async (collection: string, records: readonly Record<string, unknown>[]) => {
      const current = derived.get(collection) ?? [];
      const byId = new Map(current.map(item => [String(item.id ?? ''), item]));
      records.forEach(record => byId.set(String(record.id ?? ''), structuredClone(record)));
      derived.set(collection, [...byId.values()]);
    });
    (app as unknown as {
      multiActorRepository: {
        boundWorkspaceId: string;
        boundChatKey: string;
        listTraces(ownerId?: string): Promise<ActorMemoryTrace[]>;
        listFacts(): Promise<MemoryFact[]>;
        listDerived(collection: string): Promise<Record<string, unknown>[]>;
        upsertDerived(collection: string, records: readonly Record<string, unknown>[]): Promise<void>;
        upsertDerivedWithAudit(): Promise<never>;
      };
    }).multiActorRepository = {
      boundWorkspaceId: 'w',
      boundChatKey: 'chat-a',
      listTraces: async () => [trace],
      listFacts: async () => [memory],
      listDerived: async (collection) => structuredClone(derived.get(collection) ?? []),
      upsertDerived,
      upsertDerivedWithAudit: async () => { throw new Error('dream write failed'); },
    };

    const job = await app.enqueueActorDream(ownerId, [trace.id]);
    await expect(app.runActorDream(job.id)).rejects.toMatchObject({
      code: 'INTERNAL',
      details: { reasonCode: 'INTERNAL_ERROR', stage: 'memory.dream.run' },
    });

    expect(upsertDerived).toHaveBeenLastCalledWith('dream-jobs', [expect.objectContaining({
      id: job.id,
      status: 'failed',
      failure: expect.objectContaining({ reasonCode: 'INTERNAL_ERROR', stage: 'memory.dream.run' }),
    })]);
  });

  it('候选归入其他人物时把临时 owner 迁移参数交给仓库并重新绑定', async () => {
    const [{ MemoryApplication }, { ActorRegistry }] = await Promise.all([
      import('../src/application/memory-application'),
      import('../src/application/actors/actor-registry'),
    ]);
    const app = new MemoryApplication(new FakeRepository() as never);
    connectHost(app);
    const registry = new ActorRegistry('character:c1');
    const provisional = registry.discover({ displayName: '店长', sourceRef: 'message:1', sourceType: 'prompt', excerpt: '店长站在门口。', confidence: 0.9, confirmed: false }).owner;
    const target = registry.discover({ displayName: '艾琳', sourceRef: 'host-card:1', sourceType: 'host_card', confidence: 1, confirmed: true }).owner;
    const candidate = registry.listPending()[0]!;
    const upsertActorRegistryState = vi.fn(async () => ({
      id: 'actor-registry-change', workspaceId: 'character:c1', chatKey: 'chat-a',
      kind: 'actor-registry-change-set-v0' as const, createdAt: 1, entries: [],
    }));
    (app as unknown as { actorRegistry: typeof registry }).actorRegistry = registry;
    (app as unknown as { multiActorRepository: { upsertActorRegistryState: typeof upsertActorRegistryState } }).multiActorRepository = { upsertActorRegistryState };
    const bind = vi.spyOn(app, 'bindCurrentChat').mockResolvedValue();

    await app.confirmActorCandidate(candidate.localId, { mode: 'existing', ownerId: target.id });

    expect(upsertActorRegistryState).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Array),
      expect.objectContaining({ operation: 'confirm' }),
      { fromOwnerId: provisional.id, toOwnerId: target.id },
      [],
    );
    expect(bind).toHaveBeenCalled();
  });

  it('Capture 结束和清空当前聊天都会发布工作台数据变更通知', async () => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const repository = new FakeRepository();
    const app = new MemoryApplication(repository as never);
    connectHost(app);
    await app.start();
    attachClaimCapture(app, repository);
    const listener = vi.fn();
    const remove = app.onOverviewChanged(listener);

    await app.capture.flush();
    expect(listener).toHaveBeenCalled();

    listener.mockClear();
    await app.clearCurrentChatData();
    expect(listener).toHaveBeenCalled();

    remove();
    app.stop();
  });

  it('旧设置缺失时启用旧记忆参考默认值，并收敛损坏的持久化范围', async () => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const repository = new FakeRepository();
    repository.settings.set('preExtractReferenceItems', 0);
    repository.settings.set('preExtractReferenceMode', 'unknown');
    repository.settings.set('preExtractReferenceMaxChars', 9_999);
    const app = new MemoryApplication(repository as never);
    connectHost(app);

    await app.start();

    expect(app.getSettings()).toMatchObject({
      preExtractReferenceEnabled: true,
      preExtractReferenceItems: 1,
      preExtractReferenceMode: 'auto',
      preExtractReferenceMaxChars: 4_000,
      graphEnabled: true,
      graphLlmRelationEnabled: true,
      graphMaxHops: 1,
      graphMaxEdges: 12,
    });
    app.stop();
  });

  it('图谱公共预览在没有当前聊天或聊天键不匹配时安全返回空结果', async () => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const app = new MemoryApplication(new FakeRepository() as never);

    await expect(app.graph.preview({ chatKey: 'other-chat', query: '艾琳' })).resolves.toEqual({ nodes: [], edges: [] });
    app.stop();
  });

  it('v0 明确拒绝旧归档导入而不触发迁移或图谱回填', async () => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const repository = new FakeRepository();
    const app = new MemoryApplication(repository as never);
    connectHost(app);
    await app.start();
    repository.reconcileGraphProjection.mockClear();

    await expect(app.importSqliteBackup(new File(['{}'], 'memory-backup.json', { type: 'application/json' }))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { reasonCode: 'MEMORY_ARCHIVE_IMPORT_DISABLED', stage: 'memory.archive.import' },
    });
    expect(repository.importBackup).not.toHaveBeenCalled();
    expect(repository.reconcileGraphProjection).not.toHaveBeenCalled();
    app.stop();
  });

  it('完整持久化每个业务设置键而不遗漏运行时链路输入', async () => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const repository = new FakeRepository();
    const app = new MemoryApplication(repository as never);
    connectHost(app);
    await app.start();
    const settings = {
      ...app.getSettings(),
      enabled: false,
      autoOrganize: false,
      summaryBatchMode: 'chars' as const,
      summaryBatchFloors: 7,
      summaryBatchChars: 9_500,
      summaryIntervalFloors: 9,
      summaryOverlapFloors: 3,
      maxRecallItems: 6,
      promptMaxChars: 6_000,
      answerMode: 'diagnostic' as const,
      recallMode: 'lexical' as const,
      rerankMode: 'off' as const,
      preExtractReferenceEnabled: false,
      preExtractReferenceItems: 4,
      preExtractReferenceMode: 'lexical' as const,
      preExtractReferenceMaxChars: 1_500,
      graphEnabled: false,
      graphLlmRelationEnabled: false,
      graphMaxHops: 2 as const,
      graphMaxEdges: 8,
      chatMode: 'disabled' as const,
    };

    await app.saveSettings(settings);

    const { chatMode: _chatMode, ...persistedSettings } = settings;
    expect(Object.fromEntries([...repository.settings.entries()].filter(([key]) => key !== 'chatOverrides'))).toMatchObject(persistedSettings);
    expect(repository.settings.get('chatOverrides')).toEqual({ '["character:c1","chat-a"]': false });
    expect(app.getSettings()).toMatchObject(settings);
    app.stop();
  });

  it('工作区不可用时在进入 LLM Capture 前安全失败', async () => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const repository = new FakeRepository();
    repository.open = async () => { throw { reasonCode: 'MEMORY_RETIRED_STORAGE_DETECTED', stage: 'memory.repository.open' }; };
    const app = new MemoryApplication(repository as never);
    connectHost(app);
    await app.start();

    await expect(app.initialize(['message'])).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reasonCode: 'MEMORY_RETIRED_STORAGE_DETECTED' },
    });
    expect(state.extractCalls).toBe(0);
    app.stop();
  });

  it('总览不等待召回路由探测，并在聊天读取失败后发布最终路由状态', async () => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const repository = new FakeRepository();
    state.recallRoutePromise = new Promise<TestRecallRoutes>((resolve) => { state.recallRouteRelease = resolve; });
    const app = new MemoryApplication(repository as never);
    connectHost(app);
    await app.start();
    (app as unknown as { multiActorRepository: { listFacts(): Promise<MemoryFact[]>; listCaptureJobs(): Promise<MemoryJob[]>; listDerived(): Promise<Record<string, unknown>[]> } }).multiActorRepository = {
      listFacts: async () => { throw new Error('chat read failed'); },
      listCaptureJobs: async () => [],
      listDerived: async () => [],
    };
    let overviewChanged = 0;
    const removeOverviewListener = app.onOverviewChanged(() => { overviewChanged += 1; });

    const overviewPromise = app.getOverview();
    await expect(Promise.race([
      overviewPromise.then(() => 'overview'),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ])).resolves.toBe('overview');
    const initialOverview = await overviewPromise;
    expect(initialOverview).toMatchObject({ status: 'error' });
    expect(initialOverview.embedding).toBeUndefined();
    expect(initialOverview.rerank).toBeUndefined();

    state.recallRouteRelease?.({
      embedding: { available: true, resourceId: 'embed-route', model: 'Embed-Test' },
      rerank: { available: false, failure: { reasonCode: 'MEMORY_LLM_CLIENT_UNAVAILABLE', stage: 'test.route' } },
    });
    await vi.waitFor(() => expect(overviewChanged).toBe(1));
    await expect(app.getOverview()).resolves.toMatchObject({
      embedding: { available: true, resourceId: 'embed-route' },
      rerank: { available: false, failure: { reasonCode: 'MEMORY_LLM_CLIENT_UNAVAILABLE', stage: 'test.route' } },
    });
    removeOverviewListener();
    app.stop();
  });

  it('按来源组裁剪后实时重算初始化批次', async () => {
    state.sources = [
      ...Array.from({ length: 21 }, (_, index) => message(index)),
      { id: 'worldbook:a:1', chatKey: 'chat-a', kind: 'worldbook', role: 'metadata', content: '世界书正文'.repeat(300), createdAt: 1, entityKeys: ['世界A'] },
    ];
    const { MemoryApplication } = await import('../src/application/memory-application');
    const repository = new FakeRepository();
    const app = new MemoryApplication(repository as never);
    connectHost(app);
    await app.start();

    expect(await app.getInitializationSources()).toEqual([
      expect.objectContaining({ kind: 'message', count: 21 }),
      expect.objectContaining({ kind: 'worldbook:世界A', count: 1 }),
    ]);
    const all = await app.getInitializationEstimate();
    const messagesOnly = await app.getInitializationEstimate(['message']);
    expect(all.tokenHigh).toBeGreaterThan(messagesOnly.tokenHigh);
    expect(messagesOnly.messageCount).toBe(21);
    app.stop();
  });

  it('多人物初始化实际消费总结批次、重叠、参考记忆和关系提取设置', async () => {
    state.sources = Array.from({ length: 8 }, (_, index): SourceBlock => ({
      ...message(index + 1),
      floor: index + 1,
      content: index === 0 ? '紫罗拥有银钥匙，正在守卫城门。' : `第 ${index + 1} 层继续讨论紫罗与银钥匙。`,
    }));
    const { MemoryApplication } = await import('../src/application/memory-application');
    const repository = new FakeRepository();
    const app = new MemoryApplication(repository as never);
    connectHost(app);
    await app.start();
    await app.saveSettings({
      ...app.getSettings(),
      summaryBatchMode: 'floors',
      summaryBatchFloors: 3,
      summaryOverlapFloors: 1,
      preExtractReferenceEnabled: true,
      preExtractReferenceItems: 1,
      preExtractReferenceMode: 'lexical',
      preExtractReferenceMaxChars: 500,
      graphEnabled: true,
      graphLlmRelationEnabled: false,
    });

    const captureJobs: MemoryJob[] = [];
    const baselineFact = fact('actor-baseline', '紫罗拥有银钥匙并负责守卫城门。');
    const actorRepository = {
      boundWorkspaceId: 'character:c1',
      listFacts: vi.fn(async () => [structuredClone(baselineFact)]),
      listTraces: vi.fn(async () => []),
      upsertCaptureJob: vi.fn(async (job: MemoryJob) => {
        const index = captureJobs.findIndex((item) => item.id === job.id);
        if (index >= 0) captureJobs[index] = structuredClone(job);
        else captureJobs.push(structuredClone(job));
      }),
      rollbackChangeSet: vi.fn(async () => undefined),
      upsertDerived: vi.fn(async () => undefined),
    };
    const captureCalls: Array<{
      sources: readonly SourceBlock[];
      writableSourceRefs?: readonly string[];
      existingMemoryContext?: readonly ExistingMemoryContextItem[];
      graphLlmRelationEnabled?: boolean;
      idempotencyKey?: string;
    }> = [];
    const actorCapture = {
      capture: vi.fn(async (input: (typeof captureCalls)[number]) => {
        captureCalls.push(structuredClone(input));
        const now = Date.now();
        return {
          envelope: { workspaceId: 'character:c1', chatKey: 'chat-a', sourceRefs: input.sources.map((source) => source.id), actorCandidates: [], episodes: [], observations: [], facts: [], capturedAt: now },
          owners: [],
          pendingCandidates: [],
          episodes: [],
          observations: [],
          facts: [],
          traces: [],
          sceneCast: { id: `scene:${captureCalls.length}`, workspaceId: 'character:c1', chatKey: 'chat-a', floor: Math.max(...input.sources.map((source) => source.floor ?? 0)), members: [], viewpointOwnerId: 'owner:unknown', speakerOwnerIds: [], presentOwnerIds: [], mentionedOwnerIds: [], createdAt: now },
        };
      }),
    };
    (app as unknown as { multiActorRepository: unknown }).multiActorRepository = actorRepository;
    (app as unknown as { actorCapture: unknown }).actorCapture = actorCapture;
    vi.spyOn(app, 'bindCurrentChat').mockResolvedValue();

    const fullEstimate = await app.getInitializationEstimate(['message']);
    const rangedEstimate = await app.getInitializationEstimate(['message'], { batchRange: { start: 1, end: 2 } });
    expect(fullEstimate).toMatchObject({ messageCount: 8, conversationFloorCount: 8, logicalBatchCount: 3, batchCount: 3 });
    expect(rangedEstimate).toMatchObject({ messageCount: 8, conversationFloorCount: 8, logicalBatchCount: 3, batchCount: 3 });
    expect(rangedEstimate.tokenHigh).toBeLessThan(fullEstimate.tokenHigh);
    await app.initialize(['message']);

    expect(captureCalls).toHaveLength(3);
    expect(captureCalls.map((call) => call.sources.map((source) => source.id))).toEqual([
      ['message:1', 'message:2', 'message:3'],
      ['message:3', 'message:4', 'message:5', 'message:6'],
      ['message:6', 'message:7', 'message:8'],
    ]);
    expect(captureCalls.map((call) => call.writableSourceRefs)).toEqual([
      ['message:1', 'message:2', 'message:3'],
      ['message:4', 'message:5', 'message:6'],
      ['message:7', 'message:8'],
    ]);
    expect(captureCalls.every((call) => call.graphLlmRelationEnabled === false)).toBe(true);
    expect(captureCalls.every((call) => call.existingMemoryContext?.[0]?.content === baselineFact.content)).toBe(true);
    expect(captureJobs.at(-1)).toMatchObject({
      status: 'completed',
      checkpoint: { batchIndex: 3, totalBatches: 3, processedCount: 8 },
    });
    expect(repository.settings.get('summaryProgressByChat')).toMatchObject({
      'chat-a': { completedFloor: 8, completedMessageId: 'message:8' },
    });

    await app.saveSettings({ ...app.getSettings(), summaryIntervalFloors: 2 });
    state.sources.push(...Array.from({ length: 2 }, (_, index): SourceBlock => ({
      ...message(index + 9),
      floor: index + 9,
      content: `第 ${index + 9} 层继续讨论紫罗与银钥匙。`,
    })));
    await app.capture.flush();
    expect(captureCalls).toHaveLength(3);
    state.sources.push({
      ...message(11),
      floor: 11,
      content: '第 11 层继续讨论紫罗与银钥匙。',
    });
    await app.capture.flush();

    expect(captureCalls.slice(3).map((call) => ({
      sources: call.sources.map((source) => source.id),
      writable: call.writableSourceRefs,
    }))).toEqual([
      { sources: ['message:7', 'message:8', 'message:9'], writable: ['message:9'] },
      { sources: ['message:9', 'message:10'], writable: ['message:10'] },
    ]);
    expect(captureJobs.at(-1)).toMatchObject({
      type: 'incremental',
      status: 'completed',
      checkpoint: { batchIndex: 2, totalBatches: 2, processedCount: 2 },
    });
    expect(repository.settings.get('summaryProgressByChat')).toMatchObject({
      'chat-a': { completedFloor: 10, completedMessageId: 'message:10' },
    });

    await app.initialize(['message'], { batchRange: { start: 2, end: 3 } });
    expect(captureCalls.slice(5).map((call) => call.sources.map((source) => source.id))).toEqual([
      ['message:3', 'message:4', 'message:5', 'message:6'],
      ['message:6', 'message:7', 'message:8', 'message:9'],
    ]);
    expect(captureCalls.slice(5).map((call) => call.idempotencyKey?.split(':').at(-1))).toEqual(['2', '3']);
    expect(captureJobs.at(-1)).toMatchObject({
      type: 'initialize',
      status: 'completed',
      checkpoint: {
        batchIndex: 2,
        lastScannedBatch: 3,
        completedBatchCount: 2,
        totalBatches: 2,
        batchRangeStart: 2,
        batchRangeEnd: 3,
        availableBatchCount: 4,
        processedCount: 6,
      },
    });
    expect(repository.settings.get('summaryProgressByChat')).toMatchObject({
      'chat-a': { completedFloor: 10, completedMessageId: 'message:10' },
    });
    app.stop();
  });

  it('初始化只有不可修复低质量项时自动忽略并正常完成', async () => {
    state.sources = [{ ...message(1), floor: 1, content: '白夕小时确认地下储油库仍有约百分之四十五燃油。' }];
    const { MemoryApplication } = await import('../src/application/memory-application');
    const repository = new FakeRepository();
    const app = new MemoryApplication(repository as never);
    connectHost(app);
    await app.start();

    const captureJobs: MemoryJob[] = [];
    const rollbackChangeSet = vi.fn(async () => undefined);
    const actorRepository = {
      boundWorkspaceId: 'character:c1',
      listFacts: vi.fn(async () => []),
      listTraces: vi.fn(async () => []),
      upsertCaptureJob: vi.fn(async (job: MemoryJob) => {
        const index = captureJobs.findIndex(item => item.id === job.id);
        if (index >= 0) captureJobs[index] = structuredClone(job);
        else captureJobs.push(structuredClone(job));
      }),
      rollbackChangeSet,
      upsertDerived: vi.fn(async () => undefined),
    };
    const now = Date.now();
    const actorCapture = {
      capture: vi.fn(async () => ({
        envelope: { workspaceId: 'character:c1', chatKey: 'chat-a', sourceRefs: ['message:1'], actorCandidates: [], episodes: [], observations: [], facts: [], capturedAt: now },
        owners: [], pendingCandidates: [], episodes: [], observations: [], facts: [], traces: [],
        sceneCast: { id: 'scene:failed', workspaceId: 'character:c1', chatKey: 'chat-a', floor: 1, members: [], viewpointOwnerId: 'owner:unknown', speakerOwnerIds: [], presentOwnerIds: [], mentionedOwnerIds: [], createdAt: now },
        outcome: 'partial' as const,
        rejections: [{ index: 0, recordType: 'claim' as const, code: 'quality_below_threshold' as const, message: '质量不足', status: 'unresolved' as const }],
        acceptedLocalIds: { actor: [], episode: [], observation: [], fact: [] },
        changeAudit: { id: 'change-audit:empty-facts' },
      })),
    };
    (app as unknown as { multiActorRepository: unknown }).multiActorRepository = actorRepository;
    (app as unknown as { actorCapture: unknown }).actorCapture = actorCapture;
    vi.spyOn(app, 'bindCurrentChat').mockResolvedValue();

    await expect(app.initialize(['message'])).resolves.toBeUndefined();
    expect(rollbackChangeSet).not.toHaveBeenCalled();
    expect(captureJobs.at(-1)).toMatchObject({
      status: 'completed',
      outcome: 'complete',
      checkpoint: {
        batchIndex: 1,
        lastScannedBatch: 1,
        completedBatchCount: 1,
        processedCount: 1,
        phase: 'capture',
        pendingRepairCount: 0,
      },
    });
    app.stop();
  });

  it('初始化包含普通隐藏楼层，同时始终排除 system 历史正文与工具输出', async () => {
    state.sources = [
      message(0),
      { ...message(1), id: 'message:hidden', hidden: true, visibility: 'hidden', content: '隐藏楼层正文' },
      { id: 'message:system', chatKey: 'chat-a', kind: 'message', role: 'system', messageType: 'system', hidden: false, content: '历史系统正文', createdAt: 1, floor: 1 },
      { id: 'message:tool', chatKey: 'chat-a', kind: 'message', role: 'tool', messageType: 'tool', hidden: true, content: '工具输出', createdAt: 2, floor: 2 },
    ];
    const { MemoryApplication } = await import('../src/application/memory-application');
    const repository = new FakeRepository();
    const app = new MemoryApplication(repository as never);
    connectHost(app);
    await app.start();

    await expect(app.getInitializationSources()).resolves.toEqual([
      expect.objectContaining({ kind: 'message', count: 2, rawCount: 4, defaultCount: 2, excludedCount: 2 }),
    ]);
    await expect(app.getInitializationEstimate()).resolves.toMatchObject({ messageCount: 2 });
    await expect(app.getInitializationSources({ includeHiddenMessageFloors: false })).resolves.toEqual([
      expect.objectContaining({ kind: 'message', count: 1, rawCount: 4, excludedCount: 3 }),
    ]);
    await expect(app.getInitializationEstimate(undefined, { includeHiddenMessageFloors: false })).resolves.toMatchObject({ messageCount: 1 });
    attachClaimCapture(app, repository);
    await app.initialize(['message'], { includeHiddenMessageFloors: false });
    expect(state.lastExtractSources.map(source => source.id)).toEqual(['message:0']);
    expect(repository.jobs.at(-1)?.checkpoint.includeHiddenMessageFloors).toBe(false);
    await app.initialize(['message']);
    expect(state.lastExtractSources.map(source => source.id)).toEqual(['message:0', 'message:hidden']);
    expect(repository.jobs.at(-1)?.checkpoint.includeHiddenMessageFloors).toBe(true);
    app.stop();
  });

  it.each(['repairing', 'needs_repair'] as const)('启动协调会把 %s 任务恢复为可继续处理并清除旧失败', async (status) => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const app = new MemoryApplication(new FakeRepository() as never);
    const rejection = {
      id: 'rejection:stale-repair',
      index: 0,
      code: 'schema_validation_failed' as const,
      message: 'safe issue',
      recordType: 'claim' as const,
      status: 'unresolved' as const,
      repairAttempts: 0,
    };
    const job = {
      id: 'job:stale-repair',
      workspaceId: 'character:c1',
      chatKey: 'chat-a',
      type: 'initialize' as const,
      status,
      outcome: 'partial' as const,
      rejectionCount: 1,
      rejections: [rejection],
      failure: {
        reasonCode: 'PLAIN_DATA_BOUNDARY_INVALID' as const,
        stage: 'memory.repository.capture',
      },
      checkpoint: {
        batchIndex: 12,
        totalBatches: 12,
        processedCount: 120,
        pendingRepairCount: 1,
        phase: 'repair' as const,
      },
      createdAt: 1,
      updatedAt: 1,
    };
    const queueRecord: CaptureRepairQueueRecord = {
      id: 'repair:stale',
      workspaceId: 'character:c1',
      chatKey: 'chat-a',
      jobId: job.id,
      batchIndex: 0,
      collection: 'claims',
      itemIndex: 0,
      issues: [{ path: '$.claims[0]', keyword: 'enum', expected: 'supported evidence span' }],
      sourceRefs: ['message:1'],
      fallbackSourceRefs: ['message:1'],
      rejectionIds: [rejection.id],
      status: 'queued',
      attemptCount: 0,
      maxAttempts: 2,
      createdAt: 1,
      updatedAt: 1,
    };
    const upsertCaptureJob = vi.fn(async (_job: unknown) => undefined);
    const repository = {
      listCaptureJobs: async () => [job],
      reconcileCaptureRepairQueue: vi.fn(async () => [queueRecord]),
      listCaptureRepairQueue: async () => [queueRecord],
      upsertCaptureJob,
    };

    await (app as unknown as {
      reconcileHistoricalCaptureRepairs(repository: unknown): Promise<void>;
    }).reconcileHistoricalCaptureRepairs(repository);

    expect(upsertCaptureJob).toHaveBeenCalledWith(expect.objectContaining({
      status: 'needs_repair',
      rejectionCount: 1,
      checkpoint: expect.objectContaining({
        phase: 'repair',
        pendingRepairCount: 1,
        retryableRepairCount: 1,
      }),
    }));
    expect(upsertCaptureJob.mock.calls[0]?.[0]).not.toHaveProperty('failure');
  });

  it.each(['queued', 'running'] as const)('启动协调会把遗留的 %s Capture 标记为已取消而不让界面永久卡住', async (status) => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const app = new MemoryApplication(new FakeRepository() as never);
    const job = {
      id: `job:stale-${status}`,
      workspaceId: 'character:c1',
      chatKey: 'chat-a',
      type: 'initialize' as const,
      status,
      checkpoint: { batchIndex: 0, totalBatches: 1, phase: 'capture' as const },
      createdAt: 1,
      updatedAt: 1,
    };
    const upsertCaptureJob = vi.fn(async (_job: unknown) => undefined);
    const repository = {
      listCaptureJobs: async () => [job],
      reconcileCaptureRepairQueue: vi.fn(async () => []),
      listCaptureRepairQueue: async () => [],
      upsertCaptureJob,
    };

    await (app as unknown as {
      reconcileHistoricalCaptureRepairs(repository: unknown): Promise<void>;
    }).reconcileHistoricalCaptureRepairs(repository);

    expect(upsertCaptureJob).toHaveBeenCalledWith(expect.objectContaining({
      id: job.id,
      status: 'cancelled',
      outcome: 'partial',
      failure: expect.objectContaining({
        reasonCode: 'MEMORY_EXTRACTION_PIPELINE_CANCELLED',
        stage: 'memory.capture.reconcile.stale',
      }),
      checkpoint: expect.objectContaining({ phase: 'cancelled' }),
    }));
    expect(repository.reconcileCaptureRepairQueue).not.toHaveBeenCalled();
  });

  it('显示批次进度，并在停止后保存 paused checkpoint', async () => {
    state.sources = Array.from({ length: 21 }, (_, index) => message(index));
    const { MemoryApplication } = await import('../src/application/memory-application');
    const repository = new FakeRepository();
    const app = new MemoryApplication(repository as never);
    connectHost(app);
    await app.start();
    attachClaimCapture(app, repository, { block: true });
    const initialize = app.initialize(['message'], { batchRange: { start: 2, end: 4 } });
    for (let index = 0; index < 20 && !state.release; index += 1) await Promise.resolve();

    expect(await app.getCaptureProgress()).toMatchObject({
      status: 'running',
      batchIndex: 1,
      totalBatches: 1,
      batchRangeStart: 2,
      batchRangeEnd: 2,
      availableBatchCount: 2,
    });
    const cancel = app.cancelCapture();
    state.release?.();
    await Promise.all([initialize, cancel]);

    expect(repository.commit).not.toHaveBeenCalled();
    expect(repository.jobs.at(-1)).toMatchObject({ status: 'paused', checkpoint: {
      batchIndex: 0,
      totalBatches: 1,
      batchRangeStart: 2,
      batchRangeEnd: 2,
      availableBatchCount: 2,
      selectedSourceGroupIds: ['message'],
    } });
    expect(await app.getCaptureProgress()).toMatchObject({ status: 'cancelled', totalBatches: 1, batchRangeStart: 2, batchRangeEnd: 2, availableBatchCount: 2 });
    expect((await app.getInitializationState()).attempts[0]).toMatchObject({ status: 'cancelled', selectedSourceKinds: ['message'], batchRangeStart: 2, batchRangeEnd: 2, availableBatchCount: 2 });
    app.stop();
  });

  it('增量整理使用当前聊天的独立游标，并保留前置上下文而不跳过下一层', async () => {
    state.sources = [message(0), message(1), message(2)];
    const { MemoryApplication } = await import('../src/application/memory-application');
    const repository = new FakeRepository();
    repository.settings.set('summaryProgressByChat', {
      'chat-a': { completedFloor: 1, completedMessageId: 'message:0', updatedAt: 1 },
    });
    repository.settings.set('summaryIntervalFloors', 1);
    const app = new MemoryApplication(repository as never);
    connectHost(app);
    await app.start();
    attachClaimCapture(app, repository, { block: true });

    const flush = app.capture.flush();
    for (let index = 0; index < 20 && !state.release; index += 1) await Promise.resolve();
    state.release?.();
    await flush;

    expect(state.lastExtractSources.map(source => source.id)).toEqual(['message:0', 'message:1']);
    app.stop();
  });

  it('提取前只参考 capture 开始时当前聊天的基线事实，且不写召回日志', async () => {
    state.sources = [
      { ...message(0), content: 'Aerin fears thunder when storms arrive.' },
      { ...message(1), content: 'Aerin still fears thunder after a storm.' },
      message(2),
    ];
    const { MemoryApplication } = await import('../src/application/memory-application');
    const repository = new FakeRepository();
    repository.facts.push(fact('fact-baseline', 'Aerin fears thunder because of a childhood storm.'));
    repository.settings.set('summaryProgressByChat', {
      'chat-a': { completedFloor: 1, completedMessageId: 'message:0', updatedAt: 1 },
    });
    repository.settings.set('summaryIntervalFloors', 1);
    const app = new MemoryApplication(repository as never);
    connectHost(app);
    await app.start();
    attachClaimCapture(app, repository, { block: true });

    const flush = app.capture.flush();
    for (let index = 0; index < 20 && !state.release; index += 1) await Promise.resolve();
    repository.facts.push(fact('fact-written-during-job', 'Aerin fears thunder during new jobs.'));
    state.release?.();
    await flush;

    expect(state.lastExtractExistingMemoryContext).toEqual([
      expect.objectContaining({ referenceId: 'M1', content: 'Aerin fears thunder because of a childhood storm.' }),
    ]);
    expect(state.lastExtractExistingMemoryContext.some((item) => item.content.includes('new jobs'))).toBe(false);
    expect(repository.recallLog).toBeUndefined();
    app.stop();
  });

  it('把宿主实际注入的完整 Prompt 回写到同一条召回日志', async () => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const repository = new FakeRepository();
    const app = new MemoryApplication(repository as never);
    connectHost(app);
    await app.start();

    const recall = await app.recall.preview({ query: '核验最早储备' });
    const prompt = '<memory_context>\n真实注入文本\n</memory_context>';
    await app.recordPromptInjection({
      injected: true,
      recall,
      prompt,
      promptDiagnostics: {
        maxChars: 8_000,
        usedChars: prompt.length,
        includedCount: 1,
        omittedCount: 0,
        answerMode: 'diagnostic',
      },
    });

    expect(repository.recallLog).toMatchObject({
      injectedPrompt: prompt,
      promptDiagnostics: { usedChars: prompt.length, answerMode: 'diagnostic' },
    });
    app.stop();
  });

  it('按 workspace/chatKey 隔离三态覆盖，聊天切换后刷新，并在恢复默认时清空全部覆盖', async () => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const repository = new FakeRepository();
    const app = new MemoryApplication(repository as never);
    let workspaceId = 'character:c1';
    let chatKey = 'chat-a';
    let chatName = 'Alice';
    app.useHostContext({
      getChatKey: () => chatKey,
      getWorkspaceId: () => workspaceId,
      getChatName: () => chatName,
      collectSources: async () => [],
    });
    await app.start();

    await app.saveSettings({ ...app.getSettings(), enabled: false, chatMode: 'enabled' });
    expect(app.getCurrentChatInfo()).toMatchObject({ name: 'Alice', key: 'chat-a', mode: 'enabled', effectiveEnabled: true });
    expect(app.isChatEnabled('character:c1', 'chat-a')).toBe(true);
    await expect(app.getOverview()).resolves.toMatchObject({ status: 'ready', bound: true });
    expect(repository.settings.get('chatOverrides')).toEqual({ '["character:c1","chat-a"]': true });

    chatKey = 'chat-b'; chatName = 'Bob';
    await app.bindCurrentChat();
    expect(app.getCurrentChatInfo()).toMatchObject({ name: 'Bob', key: 'chat-b', mode: 'inherit', effectiveEnabled: false });
    await expect(app.getOverview()).resolves.toMatchObject({ status: 'disabled', bound: true });
    await app.saveSettings({ ...app.getSettings(), chatMode: 'disabled' });
    expect(app.isChatEnabled('character:c1', 'chat-b')).toBe(false);
    expect(repository.settings.get('chatOverrides')).toEqual({
      '["character:c1","chat-a"]': true,
      '["character:c1","chat-b"]': false,
    });

    workspaceId = 'group:g1'; chatKey = 'chat-a'; chatName = 'Group chat';
    await app.bindCurrentChat();
    expect(app.getCurrentChatInfo()).toMatchObject({ mode: 'inherit', effectiveEnabled: false });

    await app.resetSettings();
    expect(repository.settings.get('chatOverrides')).toEqual({});
    expect(app.getSettings()).toMatchObject({ ...MEMORY_DEFAULT_SETTINGS, chatMode: 'inherit' });
    await expect(app.getOverview()).resolves.toMatchObject({ status: 'ready', bound: true });
    app.stop();
  });

  it('以最近成功的 initialize 任务判定初始化状态，后续失败不会覆盖有效结果', async () => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const repository = new FakeRepository();
    repository.jobs.push(
      { id: 'init-ok', chatKey: 'chat-a', type: 'initialize', status: 'completed', checkpoint: { batchIndex: 3, totalBatches: 3, processedCount: 12, selectedSourceGroupIds: ['message'] }, createdAt: 10, updatedAt: 20 },
      { id: 'incremental-failed', chatKey: 'chat-a', type: 'incremental', status: 'failed', checkpoint: { batchIndex: 0, totalBatches: 1, processedCount: 0 }, failure: { reasonCode: 'INTERNAL_ERROR', stage: 'memory.capture', batchIndex: 0 }, createdAt: 25, updatedAt: 30 },
      { id: 'init-failed', chatKey: 'chat-a', type: 'initialize', status: 'failed', checkpoint: { batchIndex: 1, totalBatches: 2, processedCount: 3, selectedSourceGroupIds: ['message', 'host_card'] }, failure: { reasonCode: 'SCHEMA_VALIDATION_FAILED', stage: 'memory.capture', batchIndex: 1 }, createdAt: 35, updatedAt: 40 },
    );
    const app = new MemoryApplication(repository as never);
    connectHost(app);
    await app.start();

    await expect(app.getInitializationState()).resolves.toEqual({
      initialized: true,
      lastCompletedAt: 20,
      selectedSourceKinds: ['message'],
      attempts: [
        expect.objectContaining({ jobId: 'init-failed', status: 'failed', totalBatches: 2 }),
        expect.objectContaining({ jobId: 'init-ok', status: 'completed', totalBatches: 3 }),
      ],
    });
    app.stop();
  });

  it('沿用最近成功初始化的来源，并把活动记录限制为最近 5 次', async () => {
    state.sources = [
      message(0),
      { id: 'host-card:c1', chatKey: 'chat-a', kind: 'host_card', role: 'metadata', content: '角色卡正文', createdAt: 1 },
    ];
    const { MemoryApplication } = await import('../src/application/memory-application');
    const repository = new FakeRepository();
    repository.jobs.push(...Array.from({ length: 7 }, (_, index): MemoryJob => ({
      id: `init-${index}`,
      chatKey: 'chat-a',
      type: 'initialize',
      status: index === 4 ? 'completed' : 'failed',
      checkpoint: { batchIndex: index + 1, totalBatches: index + 1, processedCount: index, selectedSourceGroupIds: index === 4 ? ['host_card'] : ['message'] },
      ...(index === 4 ? {} : { failure: { reasonCode: 'MEMORY_EXTRACTION_STAGE_FAILED', stage: 'test.capture' } }),
      createdAt: index,
      updatedAt: index,
    })));
    const app = new MemoryApplication(repository as never);
    connectHost(app);
    await app.start();

    expect(await app.getInitializationSources()).toEqual([
      expect.objectContaining({ kind: 'message', selected: false }),
      expect.objectContaining({ kind: 'host_card', selected: true }),
    ]);
    const initialization = await app.getInitializationState();
    expect(initialization.attempts).toHaveLength(5);
    expect(initialization.attempts.map((attempt) => attempt.jobId)).toEqual(['init-6', 'init-5', 'init-4', 'init-3', 'init-2']);
    app.stop();
  });

  it('重新初始化严格按取消、清空、启动顺序执行', async () => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const app = new MemoryApplication(new FakeRepository() as never);
    connectHost(app);
    const order: string[] = [];
    vi.spyOn(app, 'cancelCapture').mockImplementation(async () => { order.push('cancel'); });
    vi.spyOn(app, 'clearCurrentChatData').mockImplementation(async () => { order.push('clear'); });
    vi.spyOn(app, 'initialize').mockImplementation(async (kinds) => { order.push(`initialize:${kinds?.join(',')}`); });

    await app.reinitialize(['message', 'host_card']);

    expect(order).toEqual(['cancel', 'clear', 'initialize:message,host_card']);
  });

  it('清空当前聊天时同时重置该聊天的总结进度并保留其他聊天', async () => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const repository = new FakeRepository();
    repository.settings.set('summaryProgressByChat', {
      'chat-a': { completedFloor: 12, completedMessageId: 'message:12', updatedAt: 20 },
      'chat-b': { completedFloor: 8, completedMessageId: 'message:8', updatedAt: 10 },
    });
    const app = new MemoryApplication(repository as never);
    connectHost(app);
    await app.start();

    await app.clearCurrentChatData();

    expect(repository.clearCurrentChatData).not.toHaveBeenCalled();
    expect(repository.settings.get('summaryProgressByChat')).toEqual({
      'chat-b': { completedFloor: 8, completedMessageId: 'message:8', updatedAt: 10 },
    });
    app.stop();
  });

  it('聊天切换后忽略旧聊天迟到的绑定结果', async () => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const repository = new FakeRepository();
    const app = new MemoryApplication(repository as never);
    let chatKey = 'chat-a';
    app.useHostContext({
      getChatKey: () => chatKey,
      getWorkspaceId: () => 'character:c1',
      getChatName: () => '同名聊天',
      collectSources: async () => [],
    });
    await app.start();

    let releaseChatA: (() => void) | undefined;
    vi.spyOn(repository, 'bootstrap').mockImplementation(async (requestedChatKey?: string) => {
      if (requestedChatKey === 'chat-a') await new Promise<void>((resolve) => { releaseChatA = resolve; });
      return { facts: [], vectorFacts: [] };
    });
    const staleBind = app.bindCurrentChat();
    await Promise.resolve();
    chatKey = 'chat-b';
    const currentBind = app.bindCurrentChat();
    await currentBind;
    releaseChatA?.();
    await staleBind;

    expect(app.getCurrentChatInfo()).toMatchObject({ name: '同名聊天', key: 'chat-b' });
    await expect(app.getOverview()).resolves.toMatchObject({ bound: true, chatKey: 'chat-b', chatName: '同名聊天' });
    app.stop();
  });

  it('把同集合相邻失败项合并复核，并分别提交修复与隔离状态', async () => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const app = new MemoryApplication(new FakeRepository() as never);
    connectHost(app);
    const queue: CaptureRepairQueueRecord[] = [
      {
        id: 'repair:running', workspaceId: 'character:c1', chatKey: 'chat-a', jobId: 'job:repair',
        batchIndex: 0, collection: 'claims', itemIndex: 0,
        issues: [{ path: 'claims[0].kind', keyword: 'enum', expected: '允许的事实类型' }],
        sourceRefs: ['message:1'], fallbackSourceRefs: [], rejectionId: 'rejection:running',
        status: 'running', attemptCount: 0, createdAt: 1, updatedAt: 1,
      },
      {
        id: 'repair:queued', workspaceId: 'character:c1', chatKey: 'chat-a', jobId: 'job:repair',
        batchIndex: 0, collection: 'claims', itemIndex: 1,
        issues: [{ path: 'claims[1].content', keyword: 'minLength', expected: '非空正文' }],
        sourceRefs: ['message:2'], fallbackSourceRefs: [], rejectionId: 'rejection:queued',
        status: 'queued', attemptCount: 0, createdAt: 1, updatedAt: 1,
      },
    ];
    const repairRepository = {
      listCaptureRepairQueue: vi.fn(async () => structuredClone(queue)),
      updateCaptureRepairRecord: vi.fn(async (next: CaptureRepairQueueRecord) => {
        const index = queue.findIndex(record => record.id === next.id);
        queue[index] = structuredClone(next);
      }),
    };
    const executeActorCapture = vi.fn().mockResolvedValueOnce({
      acceptedLocalIds: { actor: [], location: [], item: [], episode: [], claim: ['claim:fixed'], inventory: [] },
      repairDecisions: [{ repairId: 'repair:running', action: 'emit', localId: 'claim:fixed', sourceRefs: ['message:1'] }],
      rejections: [{ index: 1, status: 'unresolved' }],
      audit: { requestId: 'request:grouped' },
    });
    const internal = app as unknown as {
      captureVersion: number;
      activeCaptureProgress?: {
        batchIndex: number;
        totalBatches: number;
        pendingRepairCount?: number;
      };
      executeActorCapture: typeof executeActorCapture;
      runDeferredCaptureRepairs(
        repository: typeof repairRepository,
        jobId: string,
        sources: readonly SourceBlock[],
        settings: typeof MEMORY_DEFAULT_SETTINGS,
        captureVersion: number,
        chatKey: string,
      ): Promise<{ resolvedRejectionIds: Set<string>; remaining: number }>;
      retryEvidenceChangedCaptureRepairs(
        repository: typeof repairRepository,
        sources: readonly SourceBlock[],
        settings: typeof MEMORY_DEFAULT_SETTINGS,
        captureVersion: number,
        chatKey: string,
        includeHiddenMessageFloors: boolean,
      ): Promise<void>;
    };
    internal.executeActorCapture = executeActorCapture;

    const outcome = await internal.runDeferredCaptureRepairs(
      repairRepository,
      'job:repair',
      [{ ...message(1), floor: 1 }, { ...message(2), floor: 2 }],
      { ...MEMORY_DEFAULT_SETTINGS, graphEnabled: false, graphLlmRelationEnabled: false },
      internal.captureVersion,
      'chat-a',
    );

    expect(executeActorCapture).toHaveBeenCalledTimes(1);
    expect(executeActorCapture.mock.calls.map(([, input]) => input)).toEqual([
      expect.objectContaining({
        idempotencyKey: 'capture:job:repair:repair:repair:queued,repair:running:1',
        repair: expect.objectContaining({ collection: 'claims', attempt: 1, maxAttempts: 1, mode: 'targeted', maxItems: 2 }),
      }),
    ]);
    expect(queue).toEqual([
      expect.objectContaining({ id: 'repair:running', status: 'resolved', attemptCount: 1, repairRequestId: 'request:grouped' }),
      expect.objectContaining({ id: 'repair:queued', status: 'unresolved', attemptCount: 1, waitingForEvidenceChange: true, repairRequestId: 'request:grouped' }),
    ]);
    expect(Object.hasOwn(queue[0]!, 'failure')).toBe(false);
    expect(internal.activeCaptureProgress).toMatchObject({
      batchIndex: 2,
      totalBatches: 2,
      pendingRepairCount: 0,
    });
    expect([...outcome.resolvedRejectionIds]).toEqual(['rejection:running']);
    expect(outcome.remaining).toBe(0);
    await internal.retryEvidenceChangedCaptureRepairs(
      repairRepository,
      [{ ...message(1), floor: 1 }, { ...message(2), floor: 2 }],
      MEMORY_DEFAULT_SETTINGS,
      internal.captureVersion,
      'chat-a',
      false,
    );
    expect(executeActorCapture).toHaveBeenCalledTimes(1);
  });

  it('修复结果的最终状态提交失败后保留 running，并用同一幂等键续跑', async () => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const app = new MemoryApplication(new FakeRepository() as never);
    connectHost(app);
    const queue: CaptureRepairQueueRecord[] = [{
      id: 'repair:commit-retry', workspaceId: 'character:c1', chatKey: 'chat-a', jobId: 'job:repair',
      batchIndex: 0, collection: 'claims', itemIndex: 0,
      issues: [{ path: 'claims[0].kind', keyword: 'enum', expected: '允许的事实类型' }],
      sourceRefs: ['message:1'], fallbackSourceRefs: [], rejectionId: 'rejection:commit-retry',
      status: 'queued', attemptCount: 0, createdAt: 1, updatedAt: 1,
    }];
    let failFinalCommit = true;
    const repairRepository = {
      listCaptureRepairQueue: vi.fn(async () => structuredClone(queue)),
      updateCaptureRepairRecord: vi.fn(async (next: CaptureRepairQueueRecord) => {
        if (next.status === 'resolved' && failFinalCommit) {
          failFinalCommit = false;
          throw new Error('temporary queue commit failure');
        }
        queue[0] = structuredClone(next);
      }),
    };
    const executeActorCapture = vi.fn(async (
      _sources: readonly SourceBlock[],
      _input: { readonly idempotencyKey: string },
    ) => ({
      acceptedLocalIds: { actor: [], location: [], episode: [], claim: ['claim:fixed'] },
      rejections: [],
      audit: { requestId: 'request:fixed' },
    }));
    const internal = app as unknown as {
      captureVersion: number;
      executeActorCapture: typeof executeActorCapture;
      runDeferredCaptureRepairs(
        repository: typeof repairRepository,
        jobId: string,
        sources: readonly SourceBlock[],
        settings: typeof MEMORY_DEFAULT_SETTINGS,
        captureVersion: number,
        chatKey: string,
      ): Promise<{ remaining: number }>;
    };
    internal.executeActorCapture = executeActorCapture;
    const run = () => internal.runDeferredCaptureRepairs(
      repairRepository,
      'job:repair',
      [{ ...message(1), floor: 1 }],
      { ...MEMORY_DEFAULT_SETTINGS, graphEnabled: false, graphLlmRelationEnabled: false },
      internal.captureVersion,
      'chat-a',
    );

    await expect(run()).rejects.toThrow('temporary queue commit failure');
    expect(queue[0]).toMatchObject({ status: 'queued', attemptCount: 0 });

    await expect(run()).resolves.toMatchObject({ remaining: 0 });
    expect(queue[0]).toMatchObject({ status: 'resolved', attemptCount: 1 });
    expect(executeActorCapture.mock.calls.map(([, input]) => input.idempotencyKey)).toEqual([
      'capture:job:repair:repair:repair:commit-retry:1',
      'capture:job:repair:repair:repair:commit-retry:1',
    ]);
  });

  it('取消和可重试网络中断不消耗修复机会，并在恢复后使用同一幂等键续跑', async () => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const app = new MemoryApplication(new FakeRepository() as never);
    connectHost(app);
    const queue: CaptureRepairQueueRecord[] = [{
      id: 'repair:cancelled', workspaceId: 'character:c1', chatKey: 'chat-a', jobId: 'job:repair',
      batchIndex: 0, collection: 'claims', itemIndex: 0,
      issues: [{ path: 'claims[0].kind', keyword: 'enum', expected: '允许的事实类型' }],
      sourceRefs: ['message:1'], fallbackSourceRefs: [], rejectionId: 'rejection:cancelled',
      status: 'queued', attemptCount: 0, createdAt: 1, updatedAt: 1,
    }];
    const repairRepository = {
      listCaptureRepairQueue: vi.fn(async () => structuredClone(queue)),
      updateCaptureRepairRecord: vi.fn(async (next: CaptureRepairQueueRecord) => {
        queue[0] = structuredClone(next);
      }),
    };
    const executeActorCapture = vi.fn()
      .mockRejectedValueOnce(createSSHelperError('CANCELLED', { stage: 'memory.capture.cancel' }))
      .mockRejectedValueOnce(createSSHelperError('HTTP_CONNECT_FAILED', { stage: 'llm.provider.connect' }))
      .mockResolvedValueOnce({
        acceptedLocalIds: { actor: [], location: [], episode: [], claim: ['claim:fixed'] },
        rejections: [],
        audit: { requestId: 'request:fixed' },
      });
    const internal = app as unknown as {
      captureVersion: number;
      executeActorCapture: typeof executeActorCapture;
      runDeferredCaptureRepairs(
        repository: typeof repairRepository,
        jobId: string,
        sources: readonly SourceBlock[],
        settings: typeof MEMORY_DEFAULT_SETTINGS,
        captureVersion: number,
        chatKey: string,
      ): Promise<{ remaining: number }>;
    };
    internal.executeActorCapture = executeActorCapture;
    const run = () => internal.runDeferredCaptureRepairs(
      repairRepository,
      'job:repair',
      [{ ...message(1), floor: 1 }],
      { ...MEMORY_DEFAULT_SETTINGS, graphEnabled: false, graphLlmRelationEnabled: false },
      internal.captureVersion,
      'chat-a',
    );

    await expect(run()).rejects.toMatchObject({
      details: expect.objectContaining({ reasonCode: 'CANCELLED' }),
    });
    expect(queue[0]).toMatchObject({ status: 'queued', attemptCount: 0 });

    await expect(run()).rejects.toMatchObject({
      details: expect.objectContaining({ reasonCode: 'HTTP_CONNECT_FAILED' }),
    });
    expect(queue[0]).toMatchObject({ status: 'queued', attemptCount: 0 });

    await expect(run()).resolves.toMatchObject({ remaining: 0 });
    expect(queue[0]).toMatchObject({ status: 'resolved', attemptCount: 1 });
    expect(executeActorCapture.mock.calls.map(([, input]) => input.idempotencyKey)).toEqual([
      'capture:job:repair:repair:repair:cancelled:1',
      'capture:job:repair:repair:repair:cancelled:1',
      'capture:job:repair:repair:repair:cancelled:1',
    ]);
  });

  it('前置实体已隔离时不阻断下游 AI 作出 drop 决策', async () => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const app = new MemoryApplication(new FakeRepository() as never);
    connectHost(app);
    const queue: CaptureRepairQueueRecord[] = [
      {
        id: 'repair:actor-exhausted', workspaceId: 'character:c1', chatKey: 'chat-a', jobId: 'job:repair',
        batchIndex: 0, collection: 'actorCandidates', itemIndex: 0,
        issues: [{ path: 'actorCandidates[0]', keyword: 'entityRef', expected: 'source-supported ref' }],
        sourceRefs: ['message:1'], fallbackSourceRefs: [], rejectionId: 'rejection:actor',
        status: 'unresolved', attemptCount: 1, maxAttempts: 1, waitingForEvidenceChange: true, createdAt: 1, updatedAt: 1,
      },
      {
        id: 'repair:claim-dependent', workspaceId: 'character:c1', chatKey: 'chat-a', jobId: 'job:repair',
        batchIndex: 0, collection: 'claims', itemIndex: 0,
        issues: [{ path: 'claims[0].subjectRef', keyword: 'entityRef', expected: 'source-supported ref' }],
        sourceRefs: ['message:1'], fallbackSourceRefs: [], rejectionId: 'rejection:claim',
        status: 'queued', attemptCount: 0, maxAttempts: 1, createdAt: 1, updatedAt: 1,
      },
    ];
    const repairRepository = {
      listCaptureRepairQueue: vi.fn(async () => structuredClone(queue)),
      updateCaptureRepairRecord: vi.fn(async (next: CaptureRepairQueueRecord) => {
        const index = queue.findIndex(record => record.id === next.id);
        queue[index] = structuredClone(next);
      }),
    };
    const executeActorCapture = vi.fn(async () => ({
      acceptedLocalIds: { actor: [], location: [], item: [], episode: [], claim: [], inventory: [] },
      repairDecisions: [{ repairId: 'repair:claim-dependent', action: 'drop' }],
      rejections: [],
    }));
    const internal = app as unknown as {
      captureVersion: number;
      executeActorCapture: typeof executeActorCapture;
      runDeferredCaptureRepairs(
        repository: typeof repairRepository,
        jobId: string,
        sources: readonly SourceBlock[],
        settings: typeof MEMORY_DEFAULT_SETTINGS,
        captureVersion: number,
        chatKey: string,
      ): Promise<{ remaining: number }>;
    };
    internal.executeActorCapture = executeActorCapture;

    await expect(internal.runDeferredCaptureRepairs(
      repairRepository,
      'job:repair',
      [{ ...message(1), floor: 1 }],
      { ...MEMORY_DEFAULT_SETTINGS, graphEnabled: false, graphLlmRelationEnabled: false },
      internal.captureVersion,
      'chat-a',
    )).resolves.toMatchObject({ remaining: 0 });
    expect(executeActorCapture).toHaveBeenCalledTimes(1);
    expect(queue[0]).toMatchObject({ status: 'unresolved', waitingForEvidenceChange: true });
    expect(queue[1]).toMatchObject({ status: 'ignored', attemptCount: 1, resolutionMode: 'ignored' });
  });

  it('硬校验已忽略的复核候选不会再次进入隔离队列', async () => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const app = new MemoryApplication(new FakeRepository() as never);
    connectHost(app);
    const queue: CaptureRepairQueueRecord[] = [{
      id: 'repair:duplicate', workspaceId: 'character:c1', chatKey: 'chat-a', jobId: 'job:repair',
      batchIndex: 0, collection: 'claims', itemIndex: 0,
      issues: [{ path: 'claims[0]', keyword: 'duplicate', expected: 'new supported claim' }],
      sourceRefs: ['message:1'], fallbackSourceRefs: [], rejectionId: 'rejection:duplicate',
      status: 'queued', attemptCount: 0, maxAttempts: 1, createdAt: 1, updatedAt: 1,
    }];
    const repairRepository = {
      listCaptureRepairQueue: vi.fn(async () => structuredClone(queue)),
      updateCaptureRepairRecord: vi.fn(async (next: CaptureRepairQueueRecord) => { queue[0] = structuredClone(next); }),
    };
    const executeActorCapture = vi.fn(async () => ({
      acceptedLocalIds: { actor: [], location: [], item: [], episode: [], claim: [], inventory: [] },
      repairDecisions: [{ repairId: 'repair:duplicate', action: 'emit', localId: 'claim:duplicate', itemIndex: 0, sourceRefs: ['message:1'] }],
      rejections: [{ index: 0, recordType: 'claim', code: 'duplicate_proposal', status: 'ignored' }],
      audit: { requestId: 'request:duplicate' },
    }));
    const internal = app as unknown as {
      captureVersion: number;
      executeActorCapture: typeof executeActorCapture;
      runDeferredCaptureRepairs(
        repository: typeof repairRepository,
        jobId: string,
        sources: readonly SourceBlock[],
        settings: typeof MEMORY_DEFAULT_SETTINGS,
        captureVersion: number,
        chatKey: string,
      ): Promise<{ remaining: number }>;
    };
    internal.executeActorCapture = executeActorCapture;

    await internal.runDeferredCaptureRepairs(
      repairRepository,
      'job:repair',
      [{ ...message(1), floor: 1 }],
      MEMORY_DEFAULT_SETTINGS,
      internal.captureVersion,
      'chat-a',
    );

    expect(queue[0]).toMatchObject({ status: 'ignored', attemptCount: 1, waitingForEvidenceChange: false, resolutionMode: 'ignored' });
  });

  it('隔离记录只在证据哈希变化后执行最后一次保守复核', async () => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const app = new MemoryApplication(new FakeRepository() as never);
    connectHost(app);
    const queue: CaptureRepairQueueRecord[] = [{
      id: 'repair:legacy-second', workspaceId: 'character:c1', chatKey: 'chat-a', jobId: 'job:repair',
      batchIndex: 0, collection: 'episodes', itemIndex: 0,
      issues: [{ path: 'episodes[0].locationRef', keyword: 'entityRef', expected: 'source-supported ref' }],
      sourceRefs: ['message:1'], fallbackSourceRefs: [], rejectionId: 'rejection:legacy-second',
      status: 'unresolved', attemptCount: 1, maxAttempts: 1,
      waitingForEvidenceChange: true, evidenceRetryUsed: false, evidenceSetHash: 'old-evidence',
      createdAt: 1, updatedAt: 1,
    }];
    const repairRepository = {
      listCaptureRepairQueue: vi.fn(async () => structuredClone(queue)),
      updateCaptureRepairRecord: vi.fn(async (next: CaptureRepairQueueRecord) => {
        queue[0] = structuredClone(next);
      }),
    };
    const executeActorCapture = vi.fn(async () => ({
      acceptedLocalIds: { actor: [], location: [], episode: ['episode:fixed'], claim: [] },
      rejections: [],
      resolutionMode: 'degraded' as const,
      fieldActions: [{ path: 'episodes[0].locationRef', action: 'clear' as const, reason: '无来源支持' }],
      candidateSetHash: 'candidate-hash',
      audit: { requestId: 'request:second' },
    }));
    const internal = app as unknown as {
      captureVersion: number;
      executeActorCapture: typeof executeActorCapture;
      finalizeActorCaptureResults: ReturnType<typeof vi.fn>;
      retryEvidenceChangedCaptureRepairs(
        repository: typeof repairRepository,
        sources: readonly SourceBlock[],
        settings: typeof MEMORY_DEFAULT_SETTINGS,
        captureVersion: number,
        chatKey: string,
        includeHiddenMessageFloors: boolean,
      ): Promise<void>;
    };
    internal.executeActorCapture = executeActorCapture;
    internal.finalizeActorCaptureResults = vi.fn(async () => undefined);

    await internal.retryEvidenceChangedCaptureRepairs(
      repairRepository,
      [{ ...message(1), floor: 1 }],
      { ...MEMORY_DEFAULT_SETTINGS, graphEnabled: false, graphLlmRelationEnabled: false },
      internal.captureVersion,
      'chat-a',
      false,
    );

    expect(executeActorCapture).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({
      idempotencyKey: 'capture:job:repair:repair:repair:legacy-second:2',
      repair: expect.objectContaining({ attempt: 2, maxAttempts: 2, mode: 'conservative' }),
    }));
    expect(queue[0]).toMatchObject({
      status: 'resolved',
      attemptCount: 2,
      maxAttempts: 2,
      evidenceRetryUsed: true,
      waitingForEvidenceChange: false,
      resolutionMode: 'degraded',
      candidateSetHash: 'candidate-hash',
      fieldActions: [{ path: 'episodes[0].locationRef', action: 'clear' }],
    });
    expect(internal.finalizeActorCaptureResults).toHaveBeenCalledTimes(1);
  });

  it('证据未变化不复核，变化后的最后一次硬校验失败会自动忽略', async () => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const app = new MemoryApplication(new FakeRepository() as never);
    connectHost(app);
    const source = { ...message(1), floor: 1 };
    const currentHash = buildEvidenceWindowHash([source], [source.id]);
    const queue: CaptureRepairQueueRecord[] = [{
      id: 'repair:quarantined', workspaceId: 'character:c1', chatKey: 'chat-a', jobId: 'job:repair',
      batchIndex: 0, collection: 'claims', itemIndex: 0,
      issues: [{ path: 'claims[0].evidenceSpanId', keyword: 'enum', expected: 'supported evidence span' }],
      sourceRefs: [source.id], fallbackSourceRefs: [], rejectionId: 'rejection:quarantined',
      status: 'unresolved', attemptCount: 1, maxAttempts: 1,
      waitingForEvidenceChange: true, evidenceRetryUsed: false,
      createdAt: 1, updatedAt: 1,
    }];
    const repairRepository = {
      listCaptureRepairQueue: vi.fn(async () => structuredClone(queue)),
      updateCaptureRepairRecord: vi.fn(async (next: CaptureRepairQueueRecord) => {
        queue[0] = structuredClone(next);
      }),
    };
    const executeActorCapture = vi.fn(async () => ({
      acceptedLocalIds: { actor: [], location: [], item: [], episode: [], claim: [], inventory: [] },
      repairDecisions: [{ repairId: 'repair:quarantined', action: 'emit', localId: 'claim:hallucinated', sourceRefs: ['message:1'] }],
      rejections: [{ index: 0, status: 'unresolved', code: 'excerpt_mismatch' }],
      audit: { requestId: 'request:final-failure' },
    }));
    const internal = app as unknown as {
      captureVersion: number;
      executeActorCapture: typeof executeActorCapture;
      finalizeActorCaptureResults: ReturnType<typeof vi.fn>;
      retryEvidenceChangedCaptureRepairs(
        repository: typeof repairRepository,
        sources: readonly SourceBlock[],
        settings: typeof MEMORY_DEFAULT_SETTINGS,
        captureVersion: number,
        chatKey: string,
        includeHiddenMessageFloors: boolean,
      ): Promise<void>;
    };
    internal.executeActorCapture = executeActorCapture;
    internal.finalizeActorCaptureResults = vi.fn(async () => undefined);

    await internal.retryEvidenceChangedCaptureRepairs(
      repairRepository, [source], MEMORY_DEFAULT_SETTINGS, internal.captureVersion, 'chat-a', false,
    );
    expect(executeActorCapture).not.toHaveBeenCalled();
    expect(queue[0]?.evidenceSetHash).toBe(currentHash);

    await internal.retryEvidenceChangedCaptureRepairs(
      repairRepository, [source], MEMORY_DEFAULT_SETTINGS, internal.captureVersion, 'chat-a', false,
    );
    expect(executeActorCapture).not.toHaveBeenCalled();

    await internal.retryEvidenceChangedCaptureRepairs(
      repairRepository,
      [source, { ...message(2), floor: 2, content: '相邻楼层补充了新的上下文证据。' }],
      MEMORY_DEFAULT_SETTINGS,
      internal.captureVersion,
      'chat-a',
      false,
    );
    expect(executeActorCapture).toHaveBeenCalledTimes(1);
    expect(queue[0]).toMatchObject({
      status: 'ignored',
      attemptCount: 2,
      evidenceRetryUsed: true,
      waitingForEvidenceChange: false,
      resolutionMode: 'ignored',
    });
  });
});
