import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryJob, MemoryRecallLog } from '../src/domain';
import type { SourceBlock } from '../src/application/ingest/types';
import { MEMORY_DEFAULT_SETTINGS } from '../src/ss-helper/settings';

const state = vi.hoisted(() => ({
  sources: [] as SourceBlock[],
  release: null as null | (() => void),
  extractCalls: 0,
  lastExtractSources: [] as SourceBlock[],
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
    extract(input: { sources: SourceBlock[] }): Promise<[]> {
      state.extractCalls += 1;
      state.lastExtractSources = [...input.sources];
      return new Promise((resolve) => { state.release = () => resolve([]); });
    }
  },
}));

class FakeRepository {
  readonly jobs: MemoryJob[] = [];
  readonly audits: Array<{ sourceRefs: string[] }> = [];
  recallLog: MemoryRecallLog | undefined;
  readonly putJob = vi.fn(async (job: MemoryJob) => {
    const index = this.jobs.findIndex((item) => item.id === job.id);
    if (index >= 0) this.jobs[index] = structuredClone(job);
    else this.jobs.push(structuredClone(job));
  });
  readonly commit = vi.fn(async () => undefined);
  readonly settings = new Map<string, unknown>();
  async open(): Promise<void> {}
  close(): void {}
  async getSetting<T>(key: string): Promise<T | undefined> { return this.settings.get(key) as T | undefined; }
  async setSetting(): Promise<void> {}
  async setSettings(values: Record<string, unknown>): Promise<void> { Object.entries(values).forEach(([key, value]) => this.settings.set(key, structuredClone(value))); }
  async listFacts(): Promise<[]> { return []; }
  async bootstrap(): Promise<{ facts: []; vectorFacts: [] }> { return { facts: [], vectorFacts: [] }; }
  async listJobs(): Promise<MemoryJob[]> { return [...this.jobs].sort((a, b) => b.updatedAt - a.updatedAt); }
  async listJobBatchAudits(): Promise<Array<{ sourceRefs: string[] }>> { return structuredClone(this.audits); }
  async listEvidence(): Promise<[]> { return []; }
  async addRecallLog(log: MemoryRecallLog): Promise<void> { this.recallLog = structuredClone(log); }
  async getLastRecall(): Promise<MemoryRecallLog | undefined> { return structuredClone(this.recallLog); }
}

function message(index: number): SourceBlock {
  return { id: `message:${index}`, chatKey: 'chat-a', kind: 'message', role: index % 2 ? 'assistant' : 'user', content: `第 ${index} 条可见消息正文`, createdAt: index };
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

    expect(await app.getCaptureProgress()).toMatchObject({ status: 'running', batchIndex: 1, totalBatches: 2 });
    const cancel = app.cancelCapture();
    state.release?.();
    await Promise.all([initialize, cancel]);

    expect(repository.commit).not.toHaveBeenCalled();
    expect(repository.jobs.at(-1)).toMatchObject({ status: 'paused', checkpoint: { batchIndex: 0, totalBatches: 2, selectedSourceGroupIds: ['message'] } });
    expect(await app.getCaptureProgress()).toMatchObject({ status: 'cancelled', totalBatches: 2 });
    app.stop();
  });

  it('增量整理按全部已提交批次去重，不被最新的状态快照任务覆盖历史检查点', async () => {
    state.sources = [message(0), message(1), message(2)];
    const { MemoryApplication } = await import('../src/application/memory-application');
    const repository = new FakeRepository();
    repository.audits.push({ sourceRefs: ['message:0', 'message:1'] });
    const app = new MemoryApplication(repository as never);
    connectHost(app);
    await app.start();

    const flush = app.capture.flush();
    for (let index = 0; index < 20 && !state.release; index += 1) await Promise.resolve();
    state.release?.();
    await flush;

    expect(state.lastExtractSources.map(source => source.id)).toEqual(['message:2']);
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
    expect(repository.settings.get('chatOverrides')).toEqual({ '["character:c1","chat-a"]': true });

    chatKey = 'chat-b'; chatName = 'Bob';
    await app.bindCurrentChat();
    expect(app.getCurrentChatInfo()).toMatchObject({ name: 'Bob', key: 'chat-b', mode: 'inherit', effectiveEnabled: false });
    await app.saveSettings({ ...app.getSettings(), chatMode: 'disabled' });
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
    app.stop();
  });
});
