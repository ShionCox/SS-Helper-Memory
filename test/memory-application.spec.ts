import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryFact, MemoryJob, MemoryRecallLog } from '../src/domain';
import type { ExistingMemoryContextItem, SourceBlock } from '../src/application/ingest/types';
import { MEMORY_DEFAULT_SETTINGS } from '../src/ss-helper/settings';

type TestRecallRoutes = {
  embedding: { available: boolean; resourceId?: string; model?: string; blockedReason?: string };
  rerank: { available: boolean; resourceId?: string; model?: string; blockedReason?: string };
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
  readMemoryLlmApi: () => ({}),
  readMemoryLlmRouteDiagnostic: async () => ({ available: true, resourceId: 'test-resource', model: 'test-model' }),
  readMemoryRecallRouteDiagnostics: () => state.recallRoutePromise ?? Promise.resolve({
    embedding: { available: false, blockedReason: 'test route disabled' },
    rerank: { available: false, blockedReason: 'test route disabled' },
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

    await expect(app.importSqliteBackup(new File(['{}'], 'memory-backup.json', { type: 'application/json' }))).rejects.toMatchObject({ code: 'MEMORY_ARCHIVE_IMPORT_DISABLED' });
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
    repository.open = async () => { throw Object.assign(new Error('MEMORY_RETIRED_STORAGE_DETECTED'), { code: 'MEMORY_RETIRED_STORAGE_DETECTED' }); };
    const app = new MemoryApplication(repository as never);
    connectHost(app);
    await app.start();

    await expect(app.initialize(['message'])).rejects.toMatchObject({ code: 'MEMORY_RETIRED_STORAGE_DETECTED' });
    expect(state.extractCalls).toBe(0);
    app.stop();
  });

  it('总览不等待召回路由探测，并在聊天读取失败后发布最终路由状态', async () => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const repository = new FakeRepository();
    vi.spyOn(repository, 'listFacts').mockRejectedValue(new Error('chat read failed'));
    state.recallRoutePromise = new Promise<TestRecallRoutes>((resolve) => { state.recallRouteRelease = resolve; });
    const app = new MemoryApplication(repository as never);
    connectHost(app);
    await app.start();
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
      rerank: { available: false, blockedReason: 'LLMHub 未加载或版本过旧' },
    });
    await vi.waitFor(() => expect(overviewChanged).toBe(1));
    await expect(app.getOverview()).resolves.toMatchObject({
      embedding: { available: true, resourceId: 'embed-route' },
      rerank: { available: false, blockedReason: 'LLMHub 未加载或版本过旧' },
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
    const app = new MemoryApplication(new FakeRepository() as never);
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

    await expect(app.getInitializationEstimate(['message'])).resolves.toMatchObject({ messageCount: 8, batchCount: 3 });
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
    app.stop();
  });

  it('默认只统计 AI 可见消息，显式开启后纳入 system 历史正文但仍排除工具输出', async () => {
    state.sources = [
      message(0),
      { id: 'message:system', chatKey: 'chat-a', kind: 'message', role: 'system', messageType: 'system', hidden: false, content: '历史系统正文', createdAt: 1, floor: 1 },
      { id: 'message:tool', chatKey: 'chat-a', kind: 'message', role: 'tool', messageType: 'tool', hidden: true, content: '工具输出', createdAt: 2, floor: 2 },
    ];
    const { MemoryApplication } = await import('../src/application/memory-application');
    const app = new MemoryApplication(new FakeRepository() as never);
    connectHost(app);
    await app.start();

    await expect(app.getInitializationSources()).resolves.toEqual([
      expect.objectContaining({ kind: 'message', count: 1, rawCount: 3, defaultCount: 1, excludedCount: 2, invisibleCount: 1 }),
    ]);
    await expect(app.getInitializationSources({ includeInvisibleHistory: true })).resolves.toEqual([
      expect.objectContaining({ kind: 'message', count: 2, rawCount: 3, defaultCount: 1, excludedCount: 1, invisibleCount: 1 }),
    ]);
    await expect(app.getInitializationEstimate()).resolves.toMatchObject({ messageCount: 1 });
    await expect(app.getInitializationEstimate(undefined, { includeInvisibleHistory: true })).resolves.toMatchObject({ messageCount: 2 });
    app.stop();
  });

  it('显示批次进度，并在停止后保存 paused checkpoint', async () => {
    state.sources = Array.from({ length: 21 }, (_, index) => message(index));
    const { MemoryApplication } = await import('../src/application/memory-application');
    const repository = new FakeRepository();
    const app = new MemoryApplication(repository as never);
    connectHost(app);
    await app.start();
    const initialize = app.initialize(['message'], { includeInvisibleHistory: true });
    for (let index = 0; index < 20 && !state.release; index += 1) await Promise.resolve();

    expect(await app.getCaptureProgress()).toMatchObject({ status: 'running', batchIndex: 1, totalBatches: 5 });
    const cancel = app.cancelCapture();
    state.release?.();
    await Promise.all([initialize, cancel]);

    expect(repository.commit).not.toHaveBeenCalled();
    expect(repository.jobs.at(-1)).toMatchObject({ status: 'paused', checkpoint: { batchIndex: 0, totalBatches: 5, selectedSourceGroupIds: ['message'], includeInvisibleHistory: true } });
    expect(await app.getCaptureProgress()).toMatchObject({ status: 'cancelled', totalBatches: 5 });
    expect((await app.getInitializationState()).attempts[0]).toMatchObject({ status: 'cancelled', selectedSourceKinds: ['message'], includeInvisibleHistory: true });
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
      { id: 'incremental-failed', chatKey: 'chat-a', type: 'incremental', status: 'failed', checkpoint: { batchIndex: 0, totalBatches: 1, processedCount: 0 }, error: 'later incremental failure', createdAt: 25, updatedAt: 30 },
      { id: 'init-failed', chatKey: 'chat-a', type: 'initialize', status: 'failed', checkpoint: { batchIndex: 1, totalBatches: 2, processedCount: 3, selectedSourceGroupIds: ['message', 'host_card'] }, error: 'latest initialize failure', createdAt: 35, updatedAt: 40 },
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
      ...(index === 4 ? {} : { error: `failure-${index}` }),
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

    expect(repository.clearCurrentChatData).toHaveBeenCalledWith('chat-a');
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
});
