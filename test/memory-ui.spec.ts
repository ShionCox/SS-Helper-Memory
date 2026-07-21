// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  EXPECTED_SQLITE_SCHEMA_VERSION,
  filterAndSortFacts,
  formatAuditResource,
  formatChatIdentity,
  formatSourceReference,
  formatRollbackConfirmation,
  MEMORY_CAPABILITY_BOUNDARIES,
  readSafeLlmErrorDetails,
  translateChatBinding,
  translateFactKind,
  translateFactStatus,
  translateOverviewStatus,
  translateRecallMode,
  renderMemoryWorkbench,
} from '../src/ui/memory-ui';
import type { MemoryUiController, MemoryUiFact } from '../src/ui/memory-ui';

function workbenchController(overrides: Partial<MemoryUiController> = {}): MemoryUiController {
  const facts: MemoryUiFact[] = [{ id: 'fact-1', kind: 'state', status: 'active', content: '当前状态稳定', confidence: 0.9, sourceRefs: ['message:1'], evidence: [{ sourceRef: 'message:1', excerpt: '证据摘录' }], updatedAt: 10 }];
  return {
    getSettings: () => ({ enabled: true, autoOrganize: true, summaryBatchMode: 'floors' as const, summaryBatchFloors: 5, summaryBatchChars: 12_000, summaryIntervalFloors: 5, summaryOverlapFloors: 2, maxRecallItems: 12, promptMaxChars: 9000, answerMode: 'auto', recallMode: 'hybrid', rerankMode: 'adaptive', preExtractReferenceEnabled: true, preExtractReferenceItems: 8, preExtractReferenceMode: 'auto' as const, preExtractReferenceMaxChars: 2_400, graphEnabled: true, graphLlmRelationEnabled: true, graphMaxHops: 1 as const, graphMaxEdges: 12, chatMode: 'enabled' }),
    saveSettings: async () => undefined,
    getOverview: async () => ({ status: 'ready', bound: true, chatName: 'Assistant', chatKey: 'Assistant - 2026-07-18@03h29m55s201ms', factCount: facts.length, currentChatSizeBytes: 2048, currentChatUsageRatio: 0.25, lastOrganizedAt: 10, pendingJobs: 0, llmAvailable: true }),
    getInitializationEstimate: async () => ({ messageCount: 1, batchCount: 1, tokenLow: 10, tokenHigh: 20 }),
    getInitializationSources: async () => [{ kind: 'message', label: '聊天记录', count: 1, selected: true }],
    getInitializationState: async () => ({ initialized: false, lastCompletedAt: null, selectedSourceKinds: [], attempts: [] }),
    initialize: async () => undefined,
    reinitialize: async () => undefined,
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
    getGraphStatus: () => ({ chatKey: 'chat:1', enabled: true, phase: 'ready' as const, nodeCount: 2, edgeCount: 1, updatedAt: 10, lastRebuiltAt: 10 }),
    getRelationshipGraph: async () => ({ nodes: [{ id: 'node-a', label: '艾琳' }, { id: 'node-b', label: '雷暴' }], edges: [{ id: 'edge-a', from: 'node-a', to: 'node-b', predicate: '害怕', kind: 'relationship' as const, status: 'active' as const, confidence: 0.9, backingFactId: 'fact-1' }] }),
    rebuildGraph: async () => undefined,
    rollbackBatch: async () => undefined,
    getSqliteStatus: async () => ({ connected: true, serverVersion: '1', nodeVersion: 'v22.17.0', protocolVersion: 1, sqliteVersion: '3', schemaVersion: 4, databasePath: 'memory.db', databaseSizeBytes: 4096, workspaceSizeBytes: 8192, currentChatSizeBytes: 2048, currentChatUsageRatio: 0.25, walMode: 'wal', tableCounts: {}, tableBytes: {}, vectorCoverage: { indexedFacts: 1, eligibleFacts: 1, ratio: 1 } }),
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
    expect(translateOverviewStatus('unselected')).toBe('未选择');
    expect(translateChatBinding(true)).toBe('已绑定');
    expect(translateChatBinding(false)).toBe('未绑定');
    expect(translateChatBinding(undefined)).toBe('待确认');
    expect(translateRecallMode('lexical')).toBe('关键词检索');
    expect(translateRecallMode('vector')).toBe('向量检索');
    expect(translateRecallMode('hybrid')).toBe('混合检索');
  });

  it('同名聊天展示不同的中文可读标识且不暴露内部聊天键', async () => {
    const first = formatChatIdentity({ bound: true, chatName: 'Assistant', chatKey: 'Assistant - 2026-07-18@03h29m55s201ms' });
    const second = formatChatIdentity({ bound: true, chatName: 'Assistant', chatKey: 'Assistant - 2026-07-18@03h30m01s622ms' });
    expect(first.label).not.toBe(second.label);
    expect(first.label).toBe('助手 · 2026年7月18日 03:29:55');
    expect(first.fullKey).toBe('Assistant - 2026-07-18@03h29m55s201ms');
    expect(formatChatIdentity({ bound: true, chatName: 'Assistant', chatKey: 'Assistant - 2026-07-18@03h30m01s622ms imported' }).label).toBe('助手 · 2026年7月18日 03:30:01');

    const container = document.createElement('div');
    const dispose = renderMemoryWorkbench(container, workbenchController());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const identity = container.querySelector('.stx-memory-chat-identity strong');
    expect(identity?.textContent).toBe(first.label);
    expect(identity?.hasAttribute('title')).toBe(false);
    expect(container.textContent).not.toContain(first.fullKey);
    dispose();
  });

  it('将内部来源标识格式化为中文审阅标签', () => {
    expect(formatSourceReference('message:272')).toBe('聊天消息 #272');
    expect(formatSourceReference('state:272:hash')).toBe('聊天状态 · 消息 #272');
    expect(formatSourceReference('worldbook:book-a:entry-3:hash')).toBe('世界书条目 #entry-3');
    expect(formatSourceReference('message:272:summary-part:1')).toBe('聊天消息 #272（第 2 段）');
  });

  it('将审计资源格式化为中文，并以紧凑指标格展示批次', async () => {
    expect(formatAuditResource('__builtin_tavern__')).toBe('酒馆内置');
    expect(formatAuditResource('custom-resource')).toBe('custom-resource');

    const container = document.createElement('div');
    document.body.append(container);
    const dispose = renderMemoryWorkbench(container, workbenchController({
      listAuditRecords: async () => [{
        jobId: 'job:audit', batchIndex: 1, status: 'completed', accepted: 0,
        sourceRefs: Array.from({ length: 6 }, (_, index) => `message:${index}`),
        rejected: Array.from({ length: 12 }, () => ({})), resource: '__builtin_tavern__',
      }],
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    (container.querySelector('[data-page="audit"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const metrics = container.querySelector('.stx-memory-audit-metrics');
    expect(metrics?.children).toHaveLength(4);
    expect(metrics?.querySelectorAll('dd')[0]?.textContent).toBe('6 项');
    expect(metrics?.querySelectorAll('dd')[1]?.textContent).toBe('12 项');
    expect(metrics?.querySelectorAll('dd')[2]?.textContent).toBe('酒馆内置');
    expect(container.textContent).toContain('查看技术明细');
    dispose();
  });

  it('将初始化最终写入展示为全局整理，而不是虚假的额外提取批次', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const dispose = renderMemoryWorkbench(container, workbenchController({
      listAuditRecords: async () => [{
        id: 'initialization-finalization:job-a', kind: 'initialization-finalization-v1', jobId: 'job:a', batchIndex: 7, status: 'completed', accepted: 33,
        sourceRefs: Array.from({ length: 35 }, (_, index) => `message:${index}`), rejected: Array.from({ length: 29 }, () => ({})),
        finalization: { stagedBatchCount: 7, extractedFactCount: 33, acceptedFactCount: 33, mergedDuplicateCount: 0, conflictBucketCount: 0 },
        routeSummary: { requestCount: 7, resourceIds: ['__builtin_tavern__'], models: ['deepseek-chat'] },
      }],
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    (container.querySelector('[data-page="audit"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container.textContent).toContain('初始化最终写入');
    expect(container.textContent).toContain('全局归约已完成');
    expect(container.textContent).toContain('汇总 7 批 · 35 项');
    expect(container.textContent).toContain('这不是额外的第 7 个提取批次');
    expect(container.textContent).not.toContain('提取批次 8');
    expect(container.querySelector('.stx-memory-audit-metrics')?.children).toHaveLength(6);
    dispose();
  });

  it('按类型与状态筛选，并支持确定性排序', () => {
    const facts: MemoryUiFact[] = [
      { id: 'a', kind: 'state', status: 'active', content: 'a', confidence: 0.8, sourceRefs: [], evidence: [], updatedAt: 10 },
      { id: 'b', kind: 'event', status: 'active', content: 'b', confidence: 0.95, sourceRefs: [], evidence: [], updatedAt: 20 },
      { id: 'c', kind: 'state', status: 'superseded', content: 'c', confidence: 0.9, sourceRefs: [], evidence: [], updatedAt: 30 },
    ];

    expect(filterAndSortFacts(facts, { kind: '', status: 'active', sort: 'confidence_desc' }).map((fact) => fact.id)).toEqual(['b', 'a']);
    expect(filterAndSortFacts(facts, { kind: 'state', status: '', sort: 'updated_desc' }).map((fact) => fact.id)).toEqual(['c', 'a']);
    expect(filterAndSortFacts(facts, { kind: ['state', 'event'], status: ['active'], sort: 'updated_desc' }).map((fact) => fact.id)).toEqual(['b', 'a']);
    expect(filterAndSortFacts(facts, { kind: [], status: ['active'], sort: 'updated_desc' })).toEqual([]);
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
      '证据优先整理', '向量召回', '混合召回与重排序', '关系图谱', '类型工坊', '遗忘与失真', '世界风格',
    ]);
    expect(MEMORY_CAPABILITY_BOUNDARIES.every((item) => item.detail.length > 20)).toBe(true);
    expect(MEMORY_CAPABILITY_BOUNDARIES.some((item) => item.status === '停止')).toBe(true);
    expect(MEMORY_CAPABILITY_BOUNDARIES.some((item) => item.status === '替代')).toBe(true);
    expect(MEMORY_CAPABILITY_BOUNDARIES.some((item) => item.status === '可用')).toBe(true);
    expect(MEMORY_CAPABILITY_BOUNDARIES.find((item) => item.name === '关系图谱')?.status).toBe('可用');
  });

  it('明确 SQLite schema v4 与级联批次回滚语义', () => {
    const confirmation = formatRollbackConfirmation('job:test', 3);

    expect(EXPECTED_SQLITE_SCHEMA_VERSION).toBe(4);
    expect(confirmation).toContain('第 3 批及其后续批次');
    expect(confirmation).toContain('之后批次的整理结果也会一并撤销');
  });

  it('渲染六个工作台页面并支持内联事实编辑', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const updates: string[] = [];
    const controller = workbenchController({ updateFact: async (_id, content) => { updates.push(content); } });
    const dispose = renderMemoryWorkbench(container, controller);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container.querySelectorAll('[data-action="navigate"]')).toHaveLength(6);
    expect(container.querySelector('[data-action="select-fact"]')).not.toBeNull();
    expect(container.querySelector('[data-action="select-fact"]')?.getAttribute('data-ss-helper-control')).toBe('button');
    expect(container.querySelector('[data-action="refresh"]')?.getAttribute('data-ss-helper-tone')).toBe('neutral');
    expect(container.querySelectorAll('select[data-ss-helper-control="select"][aria-label]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-action="toggle-filter-menu"]')).toHaveLength(2);
    expect(container.querySelector('[data-filter="query"]')?.getAttribute('data-ss-helper-control')).toBe('input');
    expect(container.querySelector('.stx-memory-page-heading .stx-memory-kicker')).toBeNull();
    expect(container.querySelector('.stx-memory-status-storage')?.textContent).toContain('2.00 KB');
    expect(container.querySelector('.stx-memory-status-storage')?.textContent).toContain('25%');
    expect(container.querySelector('.stx-memory-content-card')).not.toBeNull();
    expect(container.textContent).toContain('聊天消息 #1');
    expect(container.textContent).not.toContain('chat:1');
    (container.querySelector('[data-action="edit-fact"]') as HTMLButtonElement).click();
    const textarea = container.querySelector('[data-edit-content]') as HTMLTextAreaElement;
    expect(textarea.getAttribute('data-ss-helper-control')).toBe('textarea');
    textarea.value = '更新后的事实';
    (container.querySelector('[data-action="save-fact"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updates).toEqual(['更新后的事实']);
    dispose();
    expect(container.textContent).toBe('');
  });

  it('以只读方式展示当前聊天的关系图谱、背书事实和重建入口', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const rebuildGraph = vi.fn(async () => undefined);
    const dispose = renderMemoryWorkbench(container, workbenchController({ rebuildGraph }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    (container.querySelector('[data-page="graph"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container.textContent).toContain('关系图谱');
    expect(container.textContent).toContain('艾琳 — 害怕 → 雷暴');
    expect(container.textContent).toContain('当前状态稳定');
    expect(container.textContent).toContain('证据摘录');
    expect(container.textContent).toContain('视觉聚类只用于浏览');
    expect(container.querySelector('[data-action="rebuild-graph"]')?.getAttribute('data-ss-helper-control')).toBe('button');
    (container.querySelector('[data-action="rebuild-graph"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rebuildGraph).toHaveBeenCalledOnce();
    dispose();
  });

  it('关系图谱提供可操作画布工作区、视图控制与邻接聚焦，且不暴露编辑图边操作', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const dispose = renderMemoryWorkbench(container, workbenchController());
    await new Promise((resolve) => setTimeout(resolve, 0));
    (container.querySelector('[data-page="graph"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container.querySelector('[data-relationship-graph-three-host]')).not.toBeNull();
    expect(container.querySelector('.stx-memory-graph-shell')).not.toBeNull();
    expect(container.querySelector('[data-action="graph-command"][data-graph-command="fit"]')).not.toBeNull();
    expect(container.textContent).toContain('拖动旋转');
    expect(container.textContent).toContain('类型');
    expect(container.textContent).toContain('边列表');
    expect(container.querySelector('[data-action="graph-command"][data-graph-command="fit"]')?.getAttribute('data-ss-helper-control')).toBe('button');
    const focus = container.querySelector('[data-action="toggle-graph-neighbor-focus"]') as HTMLButtonElement;
    expect(focus.disabled).toBe(false);
    focus.click();
    expect(container.querySelector('[data-action="toggle-graph-neighbor-focus"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.textContent).toContain('显示全部关系');
    expect(container.querySelector('[data-action="create-graph-edge"]')).toBeNull();
    expect(container.querySelector('[data-action="edit-graph-edge"]')).toBeNull();
    dispose();
  });

  it('从设置页的重建操作打开关系图谱并立即执行当前聊天的重建', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const rebuildGraph = vi.fn(async () => undefined);
    const dispose = renderMemoryWorkbench(
      container,
      workbenchController({ rebuildGraph }),
      () => undefined,
      undefined,
      'rebuild-relationship-graph',
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container.querySelector('.stx-memory-page-heading h2')?.textContent).toBe('关系图谱');
    expect(rebuildGraph).toHaveBeenCalledOnce();
    dispose();
  });

  it('每次重绘刷新 SDK 控件并让多选筛选立即驱动列表', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const facts: MemoryUiFact[] = [
      { id: 'state-1', kind: 'state', status: 'active', content: '状态事实', confidence: 0.9, sourceRefs: [], evidence: [], updatedAt: 20 },
      { id: 'event-1', kind: 'event', status: 'active', content: '事件事实', confidence: 0.8, sourceRefs: [], evidence: [], updatedAt: 10 },
    ];
    const refreshed: HTMLElement[] = [];
    const dispose = renderMemoryWorkbench(
      container,
      workbenchController({
        getOverview: async () => ({ status: 'ready', bound: true, factCount: facts.length, lastOrganizedAt: 20, pendingJobs: 0, llmAvailable: true }),
        listFacts: async () => facts,
      }),
      () => undefined,
      { close: () => undefined, refreshControls: (root) => { if (root) refreshed.push(root); } },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(refreshed.length).toBeGreaterThan(1);
    (container.querySelector('[data-filter-menu="kind"]') as HTMLButtonElement).click();
    const stateOption = container.querySelector<HTMLInputElement>('[data-filter-option="kind"][value="state"]')!;
    expect(stateOption.checked).toBe(true);
    stateOption.checked = false;
    stateOption.dispatchEvent(new Event('change', { bubbles: true }));
    expect(container.querySelectorAll('[data-action="select-fact"]')).toHaveLength(1);
    expect(container.textContent).toContain('事件事实');
    expect(container.textContent).not.toContain('状态事实');
    expect(container.querySelector('[data-filter-menu="kind"]')?.textContent).toContain('已选 9 项');
    expect((container.querySelector('[data-filter-all="kind"]') as HTMLInputElement).indeterminate).toBe(true);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    container.querySelector('#stx-memory-kind-filter-trigger')?.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(container.querySelector('#stx-memory-kind-filter-menu')).toBeNull();
    expect(container.querySelector('.stx-memory-workbench')).not.toBeNull();
    dispose();
  });

  it('导航到初始化和召回页面时加载已有控制器能力', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const dispose = renderMemoryWorkbench(container, workbenchController());
    await new Promise((resolve) => setTimeout(resolve, 0));
    (container.querySelector('[data-page="initialize"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toContain('初始化当前聊天');
    expect(container.textContent).toContain('按每批 5 层可见用户/助手消息拆分');
    expect(container.querySelector('[data-source-kind]')?.getAttribute('data-ss-helper-control')).toBe('checkbox');
    expect(container.querySelector('.stx-memory-estimate-grid')).not.toBeNull();
    (container.querySelector('[data-page="recall"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toContain('重建向量索引');
    expect(container.textContent).toContain('混合检索');
    expect(container.textContent).toContain('向量模型');
    expect(container.textContent).toContain('重排序模型');
    (container.querySelector('[data-page="data"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toContain('/ v1 / v4');
    expect(container.textContent).not.toContain('Schema 版本不匹配');
    expect(container.textContent).toContain('v22.17.0');
    expect(container.textContent).toContain('4.00 KB');
    expect(container.querySelectorAll('.stx-memory-maintenance-action')).toHaveLength(3);
    expect(container.querySelectorAll('.stx-memory-maintenance-icon')).toHaveLength(3);
    expect(container.querySelectorAll('.stx-memory-maintenance-chevron')).toHaveLength(3);
    expect(container.querySelectorAll('.stx-memory-danger-action-icon')).toHaveLength(2);
    expect(container.querySelector('[data-action="clear-current"] .fa-eraser')).not.toBeNull();
    expect(container.querySelector('.stx-memory-chat-storage')?.textContent).toContain('25%');
    expect(container.querySelector('[data-action="import-file"]')?.parentElement?.getAttribute('data-ss-helper-control')).toBe('file-trigger');
    expect(container.querySelector('[data-action="clear-all"]')?.getAttribute('data-ss-helper-tone')).toBe('danger');
    dispose();
  });

  it('选择事实后保留记忆列表的滚动位置', async () => {
    const facts: MemoryUiFact[] = Array.from({ length: 8 }, (_, index) => ({
      id: `fact-${index + 1}`,
      kind: 'state',
      status: 'active',
      content: `第 ${index + 1} 条记忆`,
      confidence: 0.9,
      sourceRefs: [],
      evidence: [],
      updatedAt: 100 - index,
    }));
    const container = document.createElement('div');
    document.body.append(container);
    const dispose = renderMemoryWorkbench(container, workbenchController({
      getOverview: async () => ({ status: 'ready', bound: true, factCount: facts.length, currentChatSizeBytes: 1024, currentChatUsageRatio: 0.5, lastOrganizedAt: 10, pendingJobs: 0, llmAvailable: true }),
      listFacts: async () => facts,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const list = container.querySelector<HTMLElement>('.stx-memory-fact-list')!;
    list.scrollTop = 240;
    (container.querySelectorAll('[data-action="select-fact"]')[4] as HTMLButtonElement).click();
    expect(container.querySelector<HTMLElement>('.stx-memory-fact-list')?.scrollTop).toBe(240);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelector<HTMLElement>('.stx-memory-fact-list')?.scrollTop).toBe(240);
    expect(container.querySelector('[data-fact-id="fact-5"]')?.getAttribute('aria-selected')).toBe('true');
    dispose();
  });

  it('点击初始化后立即显示 LLM 等待状态，并在任务完成前持续刷新进度', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    let started = false;
    let progressCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const dispose = renderMemoryWorkbench(container, workbenchController({
      initialize: async () => { started = true; await gate; },
      getCaptureProgress: async () => {
        progressCalls += 1;
        return started
          ? { status: 'running', jobId: 'job:init', batchIndex: 1, totalBatches: 2, processedCount: 0, elapsedMs: 120 }
          : { status: 'idle', batchIndex: 0, totalBatches: 0, processedCount: 0, elapsedMs: 0 };
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    (container.querySelector('[data-page="initialize"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const startButton = container.querySelector('[data-action="initialize-start"]') as HTMLButtonElement;
    expect(startButton?.disabled).toBe(false);
    startButton.click();
    expect(started).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container.textContent).toMatch(/正在提交 LLM 请求|正在提取记忆/u);
    expect(container.textContent).toMatch(/正在读取当前聊天来源并提交 LLM 请求|LLM 正在提取结构化记忆/u);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(progressCalls).toBeGreaterThan(1);
    expect(container.textContent).toContain('LLM 正在提取结构化记忆');

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    dispose();
  });

  it('成功初始化保持为主状态，最近失败只出现在活动列表', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const dispose = renderMemoryWorkbench(container, workbenchController({
      getInitializationState: async () => ({
        initialized: true,
        lastCompletedAt: 20,
        selectedSourceKinds: ['message'],
        attempts: [
          { jobId: 'init-failed', status: 'failed', updatedAt: 30, totalBatches: 2, selectedSourceKinds: ['message'], error: 'SCHEMA_VALIDATION_FAILED: unsafe details' },
          { jobId: 'init-ok', status: 'completed', updatedAt: 20, totalBatches: 3, selectedSourceKinds: ['message'] },
        ],
      }),
      getCaptureProgress: async () => ({ status: 'failed', jobId: 'init-failed', batchIndex: 1, totalBatches: 2, processedCount: 2, elapsedMs: 100, error: 'SCHEMA_VALIDATION_FAILED' }),
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    (container.querySelector('[data-page="initialize"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container.querySelector('.stx-memory-initialize-summary')?.textContent).toContain('已初始化');
    expect(container.querySelector('.stx-memory-initialize-summary')?.textContent).toContain('召回可用');
    expect(container.querySelector('.stx-memory-activity-list')?.textContent).toContain('失败');
    expect(container.querySelector('.stx-memory-activity-list')?.textContent).toContain('已完成');
    dispose();
  });

  it('重新初始化抽屉支持来源估算、Esc 关闭和焦点恢复', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const estimateKinds: string[][] = [];
    const dispose = renderMemoryWorkbench(container, workbenchController({
      getInitializationSources: async () => [
        { kind: 'message', label: '聊天消息', count: 8, selected: true },
        { kind: 'character', label: '角色卡', count: 1, selected: false },
      ],
      getInitializationEstimate: async (kinds) => {
        estimateKinds.push([...(kinds ?? [])]);
        return { messageCount: 8, batchCount: kinds?.length ?? 0, tokenLow: 100, tokenHigh: 200 };
      },
      getInitializationState: async () => ({ initialized: true, lastCompletedAt: 20, selectedSourceKinds: ['message'], attempts: [{ jobId: 'init-ok', status: 'completed', updatedAt: 20, totalBatches: 2, selectedSourceKinds: ['message'] }] }),
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    (container.querySelector('[data-page="initialize"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    (container.querySelector('[data-action="open-reinitialize"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(document.activeElement?.id).toBe('stx-memory-reinitialize-cancel');
    expect(container.textContent).toContain('聊天原文与消息');
    const character = container.querySelector<HTMLInputElement>('[data-source-kind="character"]')!;
    character.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(estimateKinds.at(-1)).toEqual(['message', 'character']);

    container.querySelector('.stx-memory-workbench')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement?.id).toBe('stx-memory-reinitialize-trigger');
    dispose();
  });

  it('确认重新初始化仅提交一次，完成后停留初始化页并显示已初始化', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const notifications: Array<{ code?: string }> = [];
    let completed = false;
    let calls = 0;
    const dispose = renderMemoryWorkbench(container, workbenchController({
      getInitializationState: async () => completed
        ? { initialized: true, lastCompletedAt: 40, selectedSourceKinds: ['message'], attempts: [{ jobId: 'init-new', status: 'completed', updatedAt: 40, totalBatches: 1, selectedSourceKinds: ['message'] }] }
        : { initialized: true, lastCompletedAt: 20, selectedSourceKinds: ['message'], attempts: [{ jobId: 'init-old', status: 'completed', updatedAt: 20, totalBatches: 1, selectedSourceKinds: ['message'] }] },
      reinitialize: async () => { calls += 1; completed = true; },
      getCaptureProgress: async () => completed
        ? { status: 'completed', jobId: 'init-new', batchIndex: 1, totalBatches: 1, processedCount: 1, elapsedMs: 20 }
        : { status: 'completed', jobId: 'init-old', batchIndex: 1, totalBatches: 1, processedCount: 1, elapsedMs: 20 },
    }), (notification) => notifications.push(notification));
    await new Promise((resolve) => setTimeout(resolve, 0));
    (container.querySelector('[data-page="initialize"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    (container.querySelector('[data-action="open-reinitialize"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    (container.querySelector('[data-action="confirm-reinitialize"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toBe(1);
    expect(container.querySelector('[data-page="initialize"]')?.getAttribute('aria-current')).toBe('page');
    expect(container.querySelector('.stx-memory-initialize-summary')?.textContent).toContain('已初始化');
    expect(notifications.some((notification) => notification.code === 'MEMORY_REINITIALIZE_COMPLETED')).toBe(true);
    dispose();
  });

  it('未配置向量和重排序资源时显示不可用并阻止重建索引', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const dispose = renderMemoryWorkbench(container, workbenchController({
      getLastRecall: async () => null,
      getRecallStatus: async () => ({
        resolvedMode: 'lexical',
        embedding: { available: false, blockedReason: 'LLM 中尚未配置向量资源' },
        rerank: { available: false, blockedReason: 'LLM 中尚未配置重排序资源' },
        indexedFacts: 0, eligibleFacts: 0, pendingFacts: 0, rebuilding: false, batches: [],
      }),
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    (container.querySelector('[data-page="recall"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container.textContent).toContain('关键词检索');
    expect(container.querySelectorAll('.stx-memory-route [data-ss-helper-tone="error"]')).toHaveLength(2);
    expect(container.querySelector<HTMLButtonElement>('[data-action="rebuild-index"]')?.disabled).toBe(true);
    expect(container.textContent).toContain('请先在 LLM 中配置可用的向量模型');
    expect(container.textContent).toContain('暂无召回诊断');
    expect(container.textContent).not.toContain('null');
    dispose();
  });

  it('未绑定聊天时展示空状态且不会请求当前聊天事实', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    let listCalls = 0;
    const controller = workbenchController({
      getOverview: async () => ({ status: 'unselected', bound: false, factCount: 0, lastOrganizedAt: null, pendingJobs: 0, llmAvailable: false }),
      listFacts: async () => { listCalls += 1; throw new Error('chat key required'); },
    });
    const dispose = renderMemoryWorkbench(container, controller);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listCalls).toBe(0);
    expect(container.textContent).toContain('未绑定');
    expect(container.textContent).toContain('未选择');
    expect(container.textContent).not.toContain('已停用');
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
    expect(container.textContent).not.toContain('大语言模型服务不可用');
    expect(container.textContent).not.toContain('当前聊天的记忆工作区初始化失败');
    dispose();
  });

  it('仅在 LLM API 不可用时显示 LLMHub 故障提示', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const dispose = renderMemoryWorkbench(container, workbenchController({
      getOverview: async () => ({ status: 'ready', bound: true, factCount: 1, lastOrganizedAt: 10, pendingJobs: 0, llmAvailable: false }),
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toContain('大语言模型服务不可用');
    expect(container.textContent).toContain('LLM_SERVICE_UNAVAILABLE');
    dispose();
  });

  it('持久展示当前错误、错误码、原因和处理建议', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const dispose = renderMemoryWorkbench(container, workbenchController({
      getOverview: async () => ({
        status: 'error', bound: false, factCount: 0, lastOrganizedAt: null, pendingJobs: 0, llmAvailable: true,
        errorDiagnostic: {
          code: 'WORKSPACE_NOT_FOUND',
          title: '当前聊天的记忆工作区初始化失败',
          reason: '当前聊天的数据集合尚未创建。',
          action: '点击重新检查以自动补建。',
          retryable: true,
        },
      }),
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toContain('当前聊天的记忆工作区初始化失败');
    expect(container.textContent).toContain('WORKSPACE_NOT_FOUND');
    expect(container.textContent).toContain('原因：当前聊天的数据集合尚未创建。');
    expect(container.textContent).toContain('处理建议：点击重新检查以自动补建。');
    dispose();
  });
});
