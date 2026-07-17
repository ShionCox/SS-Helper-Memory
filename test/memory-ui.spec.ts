// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  EXPECTED_SQLITE_SCHEMA_VERSION,
  filterAndSortFacts,
  estimateInitializationCost,
  formatRollbackConfirmation,
  MEMORY_CAPABILITY_BOUNDARIES,
  readSafeLlmErrorDetails,
  translateChatBinding,
  translateFactKind,
  translateFactStatus,
  translateOverviewStatus,
  renderMemoryWorkbench,
} from '../src/ui/memory-ui';
import type { MemoryUiController, MemoryUiFact } from '../src/ui/memory-ui';

function workbenchController(overrides: Partial<MemoryUiController> = {}): MemoryUiController {
  const facts: MemoryUiFact[] = [{ id: 'fact-1', kind: 'state', status: 'active', content: '当前状态稳定', confidence: 0.9, sourceRefs: ['chat:1'], evidence: [{ sourceRef: 'chat:1', excerpt: '证据摘录' }], updatedAt: 10 }];
  return {
    getSettings: () => ({ enabled: true, autoOrganize: true, maxRecallItems: 12, promptMaxChars: 9000, answerMode: 'auto', recallMode: 'hybrid', rerankMode: 'adaptive', chatMode: 'enabled' }),
    saveSettings: async () => undefined,
    getOverview: async () => ({ status: 'ready', bound: true, factCount: facts.length, lastOrganizedAt: 10, pendingJobs: 0, llmAvailable: true }),
    getInitializationEstimate: async () => ({ messageCount: 1, batchCount: 1, tokenLow: 10, tokenHigh: 20 }),
    getInitializationSources: async () => [{ kind: 'message', label: '聊天记录', count: 1, selected: true }],
    initialize: async () => undefined,
    getCaptureProgress: async () => ({ status: 'idle', batchIndex: 0, totalBatches: 0, processedCount: 0, elapsedMs: 0 }),
    cancelCapture: async () => undefined,
    retry: async () => undefined,
    listFacts: async () => facts,
    updateFact: async () => undefined,
    removeFact: async () => undefined,
    getLastRecall: async () => ({ resolvedMode: 'hybrid' }),
    listAuditRecords: async () => [],
    getMainChatUsage: async () => [],
    getRecallStatus: async () => ({ resolvedMode: 'hybrid', embedding: { available: true, resourceId: 'embed' }, rerank: { available: true, resourceId: 'rerank' }, indexedFacts: 1, eligibleFacts: 1, pendingFacts: 0, rebuilding: false, batches: [] }),
    rebuildVectorIndex: async () => undefined,
    rollbackBatch: async () => undefined,
    getSqliteStatus: async () => ({ connected: true, serverVersion: '1', nodeVersion: '20', protocolVersion: 1, sqliteVersion: '3', schemaVersion: 4, databasePath: 'memory.db', databaseSizeBytes: 1, walMode: 'wal', tableCounts: {}, tableBytes: {}, vectorCoverage: { indexedFacts: 1, eligibleFacts: 1, ratio: 1 } }),
    exportSqliteBackup: async () => new Blob(['{}'], { type: 'application/json' }),
    importSqliteBackup: async () => undefined,
    checkSqliteIntegrity: async () => ({ ok: true, message: 'ok' }),
    clearCurrentChatData: async () => undefined,
    clearAllMemoryData: async () => undefined,
    ...overrides,
  } as MemoryUiController;
}

describe('Memory UI 展示适配', () => {
  it('仅翻译展示术语，不改变未知底层扩展值', () => {
    expect(translateFactKind('world_rule')).toBe('世界规则');
    expect(translateFactKind('custom_kind')).toBe('custom_kind');
    expect(translateFactStatus('superseded')).toBe('已替代');
    expect(translateFactStatus('custom_status')).toBe('custom_status');
    expect(translateOverviewStatus('working')).toBe('整理中');
    expect(translateChatBinding(true)).toBe('已绑定');
    expect(translateChatBinding(false)).toBe('未绑定');
    expect(translateChatBinding(undefined)).toBe('待确认');
  });

  it('成本预览按历史批次上限与重叠规则估算', () => {
    const estimate = estimateInitializationCost(Array.from({ length: 38 }, (_, index) => `第${index}条消息`));

    expect(estimate.messageCount).toBe(38);
    expect(estimate.batchCount).toBe(2);
    expect(estimate.tokenLow).toBeGreaterThan(0);
    expect(estimate.tokenHigh).toBeGreaterThan(estimate.tokenLow);
  });

  it('空聊天不会虚构 Token 消耗', () => {
    expect(estimateInitializationCost(['', '  '])).toEqual({
      messageCount: 0,
      batchCount: 0,
      tokenLow: 0,
      tokenHigh: 0,
    });
  });

  it('超长消息拆批时仍保持可见消息数量', () => {
    const estimate = estimateInitializationCost(['甲'.repeat(24_001)]);

    expect(estimate.messageCount).toBe(1);
    expect(estimate.batchCount).toBe(3);
  });

  it('按类型与状态筛选，并支持确定性排序', () => {
    const facts: MemoryUiFact[] = [
      { id: 'a', kind: 'state', status: 'active', content: 'a', confidence: 0.8, sourceRefs: [], evidence: [], updatedAt: 10 },
      { id: 'b', kind: 'event', status: 'active', content: 'b', confidence: 0.95, sourceRefs: [], evidence: [], updatedAt: 20 },
      { id: 'c', kind: 'state', status: 'superseded', content: 'c', confidence: 0.9, sourceRefs: [], evidence: [], updatedAt: 30 },
    ];

    expect(filterAndSortFacts(facts, { kind: '', status: 'active', sort: 'confidence_desc' }).map((fact) => fact.id)).toEqual(['b', 'a']);
    expect(filterAndSortFacts(facts, { kind: 'state', status: '', sort: 'updated_desc' }).map((fact) => fact.id)).toEqual(['c', 'a']);
    expect(facts.map((fact) => fact.id)).toEqual(['a', 'b', 'c']);
  });

  it('鉴权错误只提取安全诊断字段且不会要求展示密钥', () => {
    expect(readSafeLlmErrorDetails({
      status: 'error', factCount: 0, lastOrganizedAt: null, pendingJobs: 0, llmAvailable: true,
      error: 'HTTP 401 resource:openai-main model:gpt-test credential=sk-secret',
    })).toEqual({ code: '401', resource: 'openai-main', model: 'gpt-test' });
  });

  it('设置页明确展示当前功能边界与实现状态', () => {
    expect(MEMORY_CAPABILITY_BOUNDARIES.map((item) => item.name)).toEqual([
      '证据优先整理', '向量召回', '混合召回与 rerank', '关系图谱', '类型工坊', '遗忘与失真', '世界风格',
    ]);
    expect(MEMORY_CAPABILITY_BOUNDARIES.every((item) => item.detail.length > 20)).toBe(true);
    expect(MEMORY_CAPABILITY_BOUNDARIES.some((item) => item.status === '停止')).toBe(true);
    expect(MEMORY_CAPABILITY_BOUNDARIES.some((item) => item.status === '替代')).toBe(true);
    expect(MEMORY_CAPABILITY_BOUNDARIES.some((item) => item.status === '可用')).toBe(true);
    expect(MEMORY_CAPABILITY_BOUNDARIES.find((item) => item.name === '关系图谱')?.status).toBe('未实现');
  });

  it('明确 SQLite schema v4 与级联批次回滚语义', () => {
    const confirmation = formatRollbackConfirmation('job:test', 3);

    expect(EXPECTED_SQLITE_SCHEMA_VERSION).toBe(4);
    expect(confirmation).toContain('第 3 批及其后续批次');
    expect(confirmation).toContain('之后批次的整理结果也会一并撤销');
  });

  it('渲染五个工作台页面并支持内联事实编辑', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const updates: string[] = [];
    const controller = workbenchController({ updateFact: async (_id, content) => { updates.push(content); } });
    const dispose = renderMemoryWorkbench(container, controller);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container.querySelectorAll('[data-action="navigate"]')).toHaveLength(5);
    expect(container.querySelector('[data-action="select-fact"]')).not.toBeNull();
    (container.querySelector('[data-action="edit-fact"]') as HTMLButtonElement).click();
    const textarea = container.querySelector('[data-edit-content]') as HTMLTextAreaElement;
    textarea.value = '更新后的事实';
    (container.querySelector('[data-action="save-fact"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updates).toEqual(['更新后的事实']);
    dispose();
    expect(container.textContent).toBe('');
  });

  it('导航到初始化和召回页面时加载已有控制器能力', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const dispose = renderMemoryWorkbench(container, workbenchController());
    await new Promise((resolve) => setTimeout(resolve, 0));
    (container.querySelector('[data-page="initialize"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toContain('初始化当前聊天');
    (container.querySelector('[data-page="recall"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toContain('重建向量索引');
    (container.querySelector('[data-page="data"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toContain('/ v1 / v4');
    expect(container.textContent).not.toContain('Schema 版本不匹配');
    dispose();
  });

  it('未绑定聊天时展示空状态且不会请求当前聊天事实', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    let listCalls = 0;
    const controller = workbenchController({
      getOverview: async () => ({ status: 'ready', bound: false, factCount: 0, lastOrganizedAt: null, pendingJobs: 0, llmAvailable: false }),
      listFacts: async () => { listCalls += 1; throw new Error('chat key required'); },
    });
    const dispose = renderMemoryWorkbench(container, controller);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listCalls).toBe(0);
    expect(container.textContent).toContain('未绑定');
    expect(container.textContent).toContain('当前聊天还没有可展示的事实');
    dispose();
  });

  it('不会把普通 Memory 状态说明误报成 LLMHub 故障', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const dispose = renderMemoryWorkbench(container, workbenchController({
      getOverview: async () => ({ status: 'disabled', bound: false, factCount: 0, lastOrganizedAt: null, pendingJobs: 0, llmAvailable: true, error: '当前没有绑定聊天。' }),
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).not.toContain('LLMHub 当前不可用');
    expect(container.textContent).not.toContain('Memory 当前异常');
    dispose();
  });

  it('仅在 LLM API 不可用时显示 LLMHub 故障提示', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const dispose = renderMemoryWorkbench(container, workbenchController({
      getOverview: async () => ({ status: 'ready', bound: true, factCount: 1, lastOrganizedAt: 10, pendingJobs: 0, llmAvailable: false }),
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toContain('LLMHub 当前不可用');
    expect(container.textContent).toContain('LLM_SERVICE_UNAVAILABLE');
    dispose();
  });
});
