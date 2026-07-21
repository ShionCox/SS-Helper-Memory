import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryFact, MemoryJob, MemoryRecallLog } from '../src/domain';
import type { ExistingMemoryContextItem, SourceBlock } from '../src/application/ingest/types';
import { MEMORY_DEFAULT_SETTINGS } from '../src/ss-helper/settings';

const state = vi.hoisted(() => ({
  sources: [] as SourceBlock[],
  release: null as null | (() => void),
  extractCalls: 0,
  lastExtractSources: [] as SourceBlock[],
  lastExtractExistingMemoryContext: [] as readonly ExistingMemoryContextItem[],
}));

vi.mock('../src/host/source-adapter', async () => {
  const actual = await vi.importActual<typeof import('../src/host/source-adapter')>('../src/host/source-adapter');
  return { ...actual, collectCurrentChatSources: async () => state.sources };
});

vi.mock('../src/application/ingest/llm-extractor', () => ({
  readMemoryLlmApi: () => ({}),
  readMemoryLlmRouteDiagnostic: async () => ({ available: true, resourceId: 'test-resource', model: 'test-model' }),
  readMemoryRecallRouteDiagnostics: async () => ({
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
  readonly staged: Array<Record<string, unknown>> = [];
  resolution: Record<string, unknown> | undefined;
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
  readonly putInitializationStagingBatch = vi.fn(async (batch: Record<string, unknown>) => {
    const index = this.staged.findIndex((item) => item.id === batch.id || (item.jobId === batch.jobId && item.batchIndex === batch.batchIndex));
    if (index >= 0) this.staged[index] = structuredClone(batch);
    else this.staged.push(structuredClone(batch));
  });
  async listInitializationStagingBatches(_chatKey: string, jobId: string): Promise<any[]> { return this.staged.filter((item) => item.jobId === jobId).map((item) => structuredClone(item)); }
  readonly putInitializationResolution = vi.fn(async (value: Record<string, unknown>) => { this.resolution = structuredClone(value); });
  async getInitializationResolution(): Promise<undefined> { return undefined; }
  readonly applyInitializationFinalization = vi.fn(async (input: { job: MemoryJob; reduction: { stats: Record<string, unknown> } }) => {
    await this.putJob({ ...input.job, status: 'completed', checkpoint: { ...input.job.checkpoint, ...input.reduction.stats } });
    return input.reduction.stats;
  });
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

  it('导入归档后为当前工作区的聊天排队图谱回填', async () => {
    const { MemoryApplication } = await import('../src/application/memory-application');
    const repository = new FakeRepository();
    repository.getChatKeys.mockResolvedValue(['chat-a', 'chat-b']);
    const app = new MemoryApplication(repository as never);
    connectHost(app);
    await app.start();

    await app.importSqliteBackup(new File(['{}'], 'memory-backup.json', { type: 'application/json' }));
    await vi.waitFor(() => expect(repository.getChatKeys).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(repository.reconcileGraphProjection).toHaveBeenCalled());
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

  it('显示批次进度，并在停止后保存 paused checkpoint', async () => {
    state.sources = Array.from({ length: 21 }, (_, index) => message(index));
    const { MemoryApplication } = await import('../src/application/memory-application');
    const repository = new FakeRepository();
    const app = new MemoryApplication(repository as never);
    connectHost(app);
    await app.start();
    const initialize = app.initialize(['message']);
    for (let index = 0; index < 20 && !state.release; index += 1) await Promise.resolve();

    expect(await app.getCaptureProgress()).toMatchObject({ status: 'running', batchIndex: 1, totalBatches: 5 });
    const cancel = app.cancelCapture();
    state.release?.();
    await Promise.all([initialize, cancel]);

    expect(repository.commit).not.toHaveBeenCalled();
    expect(repository.jobs.at(-1)).toMatchObject({ status: 'paused', checkpoint: { batchIndex: 0, totalBatches: 5, selectedSourceGroupIds: ['message'] } });
    expect(await app.getCaptureProgress()).toMatchObject({ status: 'cancelled', totalBatches: 5 });
    expect((await app.getInitializationState()).attempts[0]).toMatchObject({ status: 'cancelled', selectedSourceKinds: ['message'] });
    app.stop();
  });

  it('初始化先暂存批次，再统一应用而不走增量逐批提交', async () => {
    state.sources = [message(0), message(1)];
    const { MemoryApplication } = await import('../src/application/memory-application');
    const repository = new FakeRepository();
    const app = new MemoryApplication(repository as never);
    connectHost(app);
    await app.start();

    const initialize = app.initialize(['message']);
    for (let index = 0; index < 20 && !state.release; index += 1) await Promise.resolve();
    state.release?.();
    await initialize;

    expect(repository.commit).not.toHaveBeenCalled();
    expect(repository.putInitializationStagingBatch).toHaveBeenCalledTimes(1);
    expect(repository.applyInitializationFinalization).toHaveBeenCalledTimes(1);
    expect(await app.getInitializationState()).toMatchObject({ initialized: true, qualityStatus: 'ready' });
    expect(await app.getCaptureProgress()).toMatchObject({ status: 'completed', phase: 'apply', stagedBatchCount: 1 });
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
      { id: 'init-failed', chatKey: 'chat-a', type: 'initialize', status: 'failed', checkpoint: { batchIndex: 1, totalBatches: 2, processedCount: 3, selectedSourceGroupIds: ['message', 'character'] }, error: 'latest initialize failure', createdAt: 35, updatedAt: 40 },
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
      { id: 'character:c1', chatKey: 'chat-a', kind: 'character', role: 'metadata', content: '角色卡正文', createdAt: 1 },
    ];
    const { MemoryApplication } = await import('../src/application/memory-application');
    const repository = new FakeRepository();
    repository.jobs.push(...Array.from({ length: 7 }, (_, index): MemoryJob => ({
      id: `init-${index}`,
      chatKey: 'chat-a',
      type: 'initialize',
      status: index === 4 ? 'completed' : 'failed',
      checkpoint: { batchIndex: index + 1, totalBatches: index + 1, processedCount: index, selectedSourceGroupIds: index === 4 ? ['character'] : ['message'] },
      ...(index === 4 ? {} : { error: `failure-${index}` }),
      createdAt: index,
      updatedAt: index,
    })));
    const app = new MemoryApplication(repository as never);
    connectHost(app);
    await app.start();

    expect(await app.getInitializationSources()).toEqual([
      expect.objectContaining({ kind: 'message', selected: false }),
      expect.objectContaining({ kind: 'character', selected: true }),
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

    await app.reinitialize(['message', 'character']);

    expect(order).toEqual(['cancel', 'clear', 'initialize:message,character']);
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
