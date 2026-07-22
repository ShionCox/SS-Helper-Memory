// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  EXPECTED_SQLITE_SCHEMA_VERSION,
  filterAndSortFacts,
  formatAuditResource,
  formatChatIdentity,
  formatSourceReference,
  formatRollbackConfirmation,
  localizeLegacyGraphPreview,
  MEMORY_CAPABILITY_BOUNDARIES,
  readSafeLlmErrorDetails,
  translateChatBinding,
  translateFactKind,
  translateFactStatus,
  translateOverviewStatus,
  translateRecallMode,
  renderMemoryWorkbench,
} from '../src/ui/memory-ui';
import type { MemoryInitializationOptions, MemoryUiController, MemoryUiFact } from '../src/ui/memory-ui';

function workbenchController(overrides: Partial<MemoryUiController> = {}): MemoryUiController {
  const facts: MemoryUiFact[] = [{ id: 'fact-1', kind: 'state', status: 'active', content: '当前状态稳定', confidence: 0.9, sourceRefs: ['message:1'], evidence: [{ sourceRef: 'message:1', excerpt: '证据摘录' }], updatedAt: 10 }];
  return {
    getSettings: () => ({ enabled: true, autoOrganize: true, summaryBatchMode: 'floors' as const, summaryBatchFloors: 5, summaryBatchChars: 12_000, summaryIntervalFloors: 5, summaryOverlapFloors: 2, maxRecallItems: 12, promptMaxChars: 9000, answerMode: 'auto', recallMode: 'hybrid', rerankMode: 'adaptive', preExtractReferenceEnabled: true, preExtractReferenceItems: 8, preExtractReferenceMode: 'auto' as const, preExtractReferenceMaxChars: 2_400, graphEnabled: true, graphLlmRelationEnabled: true, graphMaxHops: 1 as const, graphMaxEdges: 12, chatMode: 'enabled' }),
    saveSettings: async () => undefined,
    getOverview: async () => ({ status: 'ready', bound: true, chatName: 'Assistant', chatKey: 'Assistant - 2026-07-18@03h29m55s201ms', factCount: facts.length, currentChatSizeBytes: 2048, currentChatUsageRatio: 0.25, lastOrganizedAt: 10, pendingJobs: 0, llmAvailable: true }),
    getInitializationEstimate: async () => ({ messageCount: 1, batchCount: 1, tokenLow: 10, tokenHigh: 20 }),
    getInitializationSources: async () => [{ kind: 'message', label: '聊天记录', count: 1, rawCount: 1, defaultCount: 1, excludedCount: 0, selected: true }],
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
    getSqliteStatus: async () => ({ connected: true, serverVersion: '0.0.1', nodeVersion: 'v22.17.0', protocolVersion: 0, sqliteVersion: '3', schemaVersion: 0, databasePath: 'memory.db', databaseSizeBytes: 4096, workspaceSizeBytes: 8192, currentChatSizeBytes: 2048, currentChatUsageRatio: 0.25, walMode: 'wal', tableCounts: {}, tableBytes: {}, vectorCoverage: { indexedFacts: 1, eligibleFacts: 1, ratio: 1 } }),
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
    expect(metrics?.children).toHaveLength(5);
    expect(metrics?.querySelectorAll('dd')[0]?.textContent).toBe('6 项');
    expect(metrics?.querySelectorAll('dd')[1]?.textContent).toBe('0 条');
    expect(metrics?.querySelectorAll('dd')[2]?.textContent).toBe('12 项');
    expect(metrics?.querySelectorAll('dd')[3]?.textContent).toBe('酒馆内置');
    expect(container.textContent).toContain('查看技术明细');
    dispose();
  });

  it('将多主体 Capture 审计展示为可回滚的单次事务', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const dispose = renderMemoryWorkbench(container, workbenchController({
      listAuditRecords: async () => [{
        id: 'change-audit:capture-a', kind: 'capture-change-set-v0', status: 'completed', accepted: 33,
        sourceRefs: Array.from({ length: 35 }, (_, index) => `message:${index}`), rejected: Array.from({ length: 29 }, () => ({})),
        factCount: 33, resource: '__builtin_tavern__',
      }],
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    (container.querySelector('[data-page="audit"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container.textContent).toContain('多主体 Capture');
    expect(container.textContent).toContain('33 条事实');
    expect(container.textContent).toContain('酒馆内置');
    expect(container.textContent).not.toContain('初始化最终写入');
    expect(container.querySelector('.stx-memory-audit-metrics')?.children).toHaveLength(5);
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

    expect(EXPECTED_SQLITE_SCHEMA_VERSION).toBe(0);
    expect(confirmation).toContain('第 3 批及其后续批次');
    expect(confirmation).toContain('之后批次的整理结果也会一并撤销');
  });

  it('渲染多主体工作台页面并支持内联事实编辑', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const updates: string[] = [];
    const controller = workbenchController({ updateFact: async (_id, content) => { updates.push(content); } });
    const dispose = renderMemoryWorkbench(container, controller);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container.querySelectorAll('[data-action="navigate"]')).toHaveLength(9);
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

  it('以状态简报展示当前聊天、能力状态和现有工作台入口', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const getOverview = vi.fn(async () => ({
      status: 'ready' as const,
      bound: true,
      chatName: 'Assistant',
      chatKey: 'Assistant - 2026-07-18@03h29m55s201ms',
      factCount: 4,
      currentChatSizeBytes: 156_160,
      currentChatUsageRatio: 0.85,
      lastOrganizedAt: 10,
      pendingJobs: 0,
      llmAvailable: true,
      llmModel: 'test-llm',
      embedding: { available: false, blockedReason: '未配置向量资源' },
      rerank: { available: false, blockedReason: '未配置重排资源' },
    }));
    const dispose = renderMemoryWorkbench(container, workbenchController({ getOverview }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    (container.querySelector('[data-action="navigate"][data-page="overview"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const overview = container.querySelector('.stx-memory-overview');
    expect(overview).not.toBeNull();
    expect(overview?.textContent).toContain('状态简报');
    expect(overview?.textContent).toContain('当前聊天已就绪');
    expect(overview?.textContent).toContain('助手 · 2026年7月18日 03:29:55');
    expect(overview?.textContent).toContain('4 条事实');
    expect(overview?.textContent).toContain('152.5 KB');
    expect(overview?.textContent).toContain('占角色记忆 85%');
    expect(overview?.textContent).toContain('大语言模型（LLM）');
    expect(overview?.textContent).toContain('未配置向量资源');
    expect(overview?.querySelector('[data-action="view-library"]')).not.toBeNull();
    expect(overview?.querySelector('[data-action="navigate"][data-page="scenes"]')).not.toBeNull();
    expect(overview?.querySelector('[data-action="navigate"][data-page="recall"]')).not.toBeNull();
    expect(overview?.querySelector('[data-action="refresh-health"]')).not.toBeNull();

    (overview?.querySelector('[data-action="navigate"][data-page="scenes"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelector('.stx-memory-page-heading h2')?.textContent).toBe('场景与事件');
    dispose();
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
    expect(container.textContent).toContain('选择一个节点或关系');
    expect(container.querySelector('[data-graph-edge-list] [aria-selected="true"]')).toBeNull();
    (container.querySelector('[data-action="select-graph-edge"]') as HTMLButtonElement).click();
    expect(container.textContent).toContain('当前状态稳定');
    expect(container.textContent).toContain('证据摘录');
    expect(container.textContent).toContain('视觉聚类只用于浏览');
    expect(container.querySelector('[data-action="rebuild-graph"]')?.getAttribute('data-ss-helper-control')).toBe('button');
    expect(container.querySelector('[data-action="rebuild-graph"]')?.getAttribute('aria-label')).toBe('重建关系图谱');
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
    expect(focus.disabled).toBe(true);
    (container.querySelector('[data-action="select-graph-edge"]') as HTMLButtonElement).click();
    expect(focus.disabled).toBe(false);
    focus.click();
    expect(container.querySelector('[data-action="toggle-graph-neighbor-focus"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[data-action="toggle-graph-neighbor-focus"]')?.getAttribute('aria-label')).toBe('显示全部关系');
    expect(container.querySelector('[data-action="create-graph-edge"]')).toBeNull();
    expect(container.querySelector('[data-action="edit-graph-edge"]')).toBeNull();
    dispose();
  });

  it('在边列表与事件列表间切换，并让事件选择联动全部直接关系', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const eventFact: MemoryUiFact = { id: 'fact-event', kind: 'event', status: 'active', content: '艾琳在雷暴中抵达港口', confidence: .94, sourceRefs: ['message:2'], evidence: [{ sourceRef: 'message:2', excerpt: '事件证据' }], updatedAt: 20 };
    const dispose = renderMemoryWorkbench(container, workbenchController({
      listFacts: async () => [eventFact],
      getGraphStatus: () => ({ chatKey: 'chat:1', enabled: true, phase: 'ready' as const, nodeCount: 4, edgeCount: 3, updatedAt: 20, lastRebuiltAt: 20 }),
      getRelationshipGraph: async () => ({
        nodes: [{ id: 'node-a', label: '艾琳' }, { id: 'node-b', label: '雷暴' }, { id: 'node-c', label: '港口' }, { id: 'node-d', label: '北区' }],
        edges: [
          { id: 'edge-event', from: 'node-a', to: 'node-b', predicate: '遭遇', kind: 'event' as const, status: 'active' as const, confidence: .94, backingFactId: 'fact-event' },
          { id: 'edge-a', from: 'node-a', to: 'node-c', predicate: '抵达', kind: 'location' as const, status: 'active' as const, confidence: .9, backingFactId: 'fact-event' },
          { id: 'edge-b', from: 'node-b', to: 'node-d', predicate: '发生于', kind: 'location' as const, status: 'active' as const, confidence: .88, backingFactId: 'fact-event' },
        ],
      }),
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    (container.querySelector('[data-page="graph"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const inspector = container.querySelector('[data-relationship-graph-inspector]');
    const statusPanel = container.querySelector('.stx-memory-graph-status-panel');
    const detail = container.querySelector('[data-graph-inspector-detail]');
    const edgePane = container.querySelector<HTMLElement>('[data-graph-edge-list][data-graph-list-mode="edges"]');
    const eventPane = container.querySelector<HTMLElement>('[data-graph-edge-list][data-graph-list-mode="events"]');
    const edgeTab = container.querySelector('[data-action="set-graph-list-mode"][data-graph-list-mode="edges"]') as HTMLButtonElement;
    const eventTab = container.querySelector('[data-action="set-graph-list-mode"][data-graph-list-mode="events"]') as HTMLButtonElement;
    expect(edgePane?.hidden).toBe(false);
    expect(eventPane?.hidden).toBe(true);
    expect(edgeTab.getAttribute('aria-selected')).toBe('true');
    expect(eventTab.getAttribute('aria-selected')).toBe('false');
    eventTab.click();
    expect(container.querySelector('[data-relationship-graph-inspector]')).toBe(inspector);
    expect(container.querySelector('.stx-memory-graph-status-panel')).toBe(statusPanel);
    expect(container.querySelector('[data-graph-inspector-detail]')).toBe(detail);
    expect(container.querySelector('[data-graph-edge-list][data-graph-list-mode="edges"]')).toBe(edgePane);
    expect(container.querySelector('[data-graph-edge-list][data-graph-list-mode="events"]')).toBe(eventPane);
    expect(edgePane?.hidden).toBe(true);
    expect(eventPane?.hidden).toBe(false);
    expect(edgeTab.getAttribute('aria-selected')).toBe('false');
    expect(eventTab.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelectorAll('[data-action="select-graph-event"]')).toHaveLength(1);
    expect(container.textContent).toContain('艾琳在雷暴中抵达港口');
    expect(container.textContent).toContain('关联 3 条关系');

    const eventRow = container.querySelector('[data-action="select-graph-event"]') as HTMLButtonElement;
    eventRow.click();
    expect(eventRow.getAttribute('aria-selected')).toBe('true');
    expect(container.textContent).toContain('事件两端的全部直接关系会在画布中同步高亮');
    expect((container.querySelector('[data-action="toggle-graph-neighbor-focus"]') as HTMLButtonElement).disabled).toBe(false);
    eventTab.click();
    expect(eventRow.getAttribute('aria-selected')).toBe('true');
    edgeTab.click();
    expect(eventRow.getAttribute('aria-selected')).toBe('false');
    expect(detail?.textContent).toContain('选择一个节点或关系');
    expect((container.querySelector('[data-action="toggle-graph-neighbor-focus"]') as HTMLButtonElement).disabled).toBe(true);
    dispose();
  });

  it('选择关系时保留边列表 DOM，只局部更新选中态与详情', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const dispose = renderMemoryWorkbench(container, workbenchController({
      getGraphStatus: () => ({ chatKey: 'chat:1', enabled: true, phase: 'ready' as const, nodeCount: 3, edgeCount: 2, updatedAt: 10, lastRebuiltAt: 10 }),
      getRelationshipGraph: async () => ({
        nodes: [{ id: 'node-a', label: '艾琳' }, { id: 'node-b', label: '雷暴' }, { id: 'node-c', label: '月光' }],
        edges: [
          { id: 'edge-a', from: 'node-a', to: 'node-b', predicate: '害怕', kind: 'relationship' as const, status: 'active' as const, confidence: .9, backingFactId: 'fact-1' },
          { id: 'edge-b', from: 'node-a', to: 'node-c', predicate: '信任', kind: 'relationship' as const, status: 'active' as const, confidence: .8, backingFactId: 'fact-1' },
        ],
      }),
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    (container.querySelector('[data-page="graph"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const inspector = container.querySelector('[data-relationship-graph-inspector]');
    const edgeList = container.querySelector('[data-graph-edge-list]');
    const detail = container.querySelector('[data-graph-inspector-detail]');
    const secondEdge = container.querySelector('[data-graph-edge-list] [data-edge-id="edge-b"]') as HTMLButtonElement;
    secondEdge.click();

    expect(container.querySelector('[data-relationship-graph-inspector]')).toBe(inspector);
    expect(container.querySelector('[data-graph-edge-list]')).toBe(edgeList);
    expect(container.querySelector('[data-graph-inspector-detail]')).toBe(detail);
    expect(secondEdge.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[data-edge-id="edge-a"]')?.getAttribute('aria-selected')).toBe('false');
    expect(detail?.textContent).toContain('艾琳 — 信任 → 月光');
    dispose();
  });

  it('关系搜索等待 120ms 后才刷新边列表', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const dispose = renderMemoryWorkbench(container, workbenchController());
    await new Promise((resolve) => setTimeout(resolve, 0));
    (container.querySelector('[data-page="graph"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const input = container.querySelector('[data-filter="graph-query"]') as HTMLInputElement;
    vi.useFakeTimers();
    try {
      input.value = '不存在的关系';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      expect(container.querySelectorAll('[data-graph-edge-list] [data-edge-id]')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(119);
      expect(container.querySelectorAll('[data-graph-edge-list] [data-edge-id]')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(container.querySelectorAll('[data-graph-edge-list] [data-edge-id]')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      dispose();
    }
  });

  it('只给真实溢出的关系标题启用横向滚动', async () => {
    const scrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
    const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    const getBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get() { return this.textContent?.includes('非常长的关系标题') ? 360 : 80; } });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.matches?.('[data-graph-marquee]') ? 500 : 0; } });
    HTMLElement.prototype.getBoundingClientRect = function () {
      const width = this.matches('.stx-memory-graph-edge-top') ? 210
        : this.matches('.stx-memory-graph-edge-top > span:last-child') ? 70
          : this.matches('[data-graph-marquee] > span') ? this.scrollWidth : 0;
      return { x: 0, y: 0, top: 0, right: width, bottom: 20, left: 0, width, height: 20, toJSON: () => ({}) };
    };
    const container = document.createElement('div');
    document.body.append(container);
    const dispose = renderMemoryWorkbench(container, workbenchController({
      getGraphStatus: () => ({ chatKey: 'chat:1', enabled: true, phase: 'ready' as const, nodeCount: 4, edgeCount: 2, updatedAt: 10, lastRebuiltAt: 10 }),
      getRelationshipGraph: async () => ({
        nodes: [{ id: 'node-a', label: '甲' }, { id: 'node-b', label: '乙' }, { id: 'node-c', label: '这是一个非常长的关系标题起点' }, { id: 'node-d', label: '这是一个非常长的关系标题终点' }],
        edges: [
          { id: 'edge-short', from: 'node-a', to: 'node-b', predicate: '是', kind: 'relationship' as const, status: 'active' as const, confidence: .9, backingFactId: 'fact-1' },
          { id: 'edge-long', from: 'node-c', to: 'node-d', predicate: '连接到', kind: 'relationship' as const, status: 'active' as const, confidence: .8, backingFactId: 'fact-1' },
        ],
      }),
    }));
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      (container.querySelector('[data-page="graph"]') as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const shortTitle = container.querySelector('[data-edge-id="edge-short"] [data-graph-marquee]');
      const longTitle = container.querySelector('[data-edge-id="edge-long"] [data-graph-marquee]');
      expect(shortTitle?.getAttribute('data-overflow')).toBe('false');
      expect(longTitle?.getAttribute('data-overflow')).toBe('true');
      expect(Number.parseFloat(longTitle?.getAttribute('style')?.match(/distance:\s*([\d.]+)/u)?.[1] ?? '0')).toBeGreaterThan(0);
      expect((longTitle as HTMLElement | null)?.style.width).toBe('140px');
    } finally {
      dispose();
      if (scrollWidth) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', scrollWidth);
      if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth);
      HTMLElement.prototype.getBoundingClientRect = getBoundingClientRect;
    }
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
    const kindOptionCount = container.querySelectorAll('[data-filter-option="kind"]').length;
    const stateOption = container.querySelector<HTMLInputElement>('[data-filter-option="kind"][value="state"]')!;
    expect(stateOption.checked).toBe(true);
    stateOption.checked = false;
    stateOption.dispatchEvent(new Event('change', { bubbles: true }));
    expect(container.querySelectorAll('[data-action="select-fact"]')).toHaveLength(1);
    expect(container.textContent).toContain('事件事实');
    expect(container.textContent).not.toContain('状态事实');
    expect(container.querySelector('[data-filter-menu="kind"]')?.textContent).toContain(`已选 ${kindOptionCount - 1} 项`);
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
    expect(container.querySelector('[data-option="include-invisible-history"]')).toBeNull();
    expect(container.querySelector('.stx-memory-estimate-grid')).not.toBeNull();
    (container.querySelector('[data-page="recall"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toContain('重建向量索引');
    expect(container.textContent).toContain('混合检索');
    expect(container.textContent).toContain('向量模型');
    expect(container.textContent).toContain('重排序模型');
    (container.querySelector('[data-page="data"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toContain('/ v0 / v0');
    expect(container.textContent).not.toContain('Schema 版本不匹配');
    expect(container.textContent).toContain('v22.17.0');
    expect(container.textContent).toContain('4.00 KB');
    expect(container.querySelectorAll('.stx-memory-maintenance-action')).toHaveLength(2);
    expect(container.querySelectorAll('.stx-memory-maintenance-icon')).toHaveLength(2);
    expect(container.querySelectorAll('.stx-memory-maintenance-chevron')).toHaveLength(2);
    expect(container.querySelectorAll('.stx-memory-danger-action-icon')).toHaveLength(2);
    expect(container.querySelector('[data-action="clear-current"] ss-helper-icon[name="eraser"]')).not.toBeNull();
    expect(container.querySelector('.stx-memory-chat-storage')?.textContent).toContain('25%');
    expect(container.querySelector('[data-action="import-file"]')).toBeNull();
    expect(container.querySelector('[data-action="clear-all"]')?.getAttribute('data-ss-helper-tone')).toBe('danger');
    dispose();
  });

  it('不把遗留英文技术键直接显示在关系图谱中', async () => {
    const graph = {
      nodes: [{ id: 'node-a', label: '白夕小时' }, { id: 'node-b', label: 'tomorrow_outing_split' }],
      edges: [{ id: 'edge-a', from: 'node-a', to: 'node-b', predicate: 'plans_to', kind: 'goal' as const, status: 'active' as const, confidence: 0.9, backingFactId: 'fact-1' }],
    };
    expect(localizeLegacyGraphPreview(graph)).toMatchObject({
      nodes: [{ label: '白夕小时' }, { label: '相关对象' }],
      edges: [{ predicate: '目标' }],
    });

    const container = document.createElement('div');
    document.body.append(container);
    const dispose = renderMemoryWorkbench(container, workbenchController({ getRelationshipGraph: async () => graph }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    (container.querySelector('[data-page="graph"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container.textContent).toContain('当前状态稳定');
    expect(container.textContent).not.toContain('plans_to');
    expect(container.textContent).not.toContain('tomorrow_outing_split');
    dispose();
  });

  it('顶部状态栏显示大语言、向量和重排序模型状态', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const dispose = renderMemoryWorkbench(container, workbenchController({
      getOverview: async () => ({
        status: 'ready', bound: true, factCount: 1, lastOrganizedAt: 10, pendingJobs: 0, llmAvailable: true,
        embedding: { available: true, resourceId: 'embed-route', model: 'Embed-Test' },
        rerank: { available: false, blockedReason: 'LLMHub 未加载或版本过旧' },
      }),
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container.textContent).toContain('大语言模型');
    expect(container.textContent).toContain('向量模型');
    expect(container.textContent).toContain('重排序模型');
    expect(container.textContent).toContain('Embed-Test');
    expect(container.querySelectorAll('.stx-memory-statusbar > div')).toHaveLength(7);
    const routeChips = container.querySelectorAll<HTMLElement>('.stx-memory-status-route [data-ss-helper-control="status"]');
    expect(routeChips).toHaveLength(2);
    expect(routeChips[0]?.textContent).toBe('可用');
    expect(routeChips[0]?.getAttribute('data-ss-helper-tone')).toBe('success');
    expect(routeChips[1]?.textContent).toBe('不可用');
    expect(routeChips[1]?.getAttribute('data-ss-helper-tone')).toBe('error');
    expect(container.querySelectorAll('.stx-memory-status-route-detail')).toHaveLength(2);
    expect([...container.querySelectorAll('.stx-memory-status-route-detail')].some((node) => node.textContent?.includes('LLMHub 未加载或版本过旧'))).toBe(true);
    dispose();
  });

  it('后台路由诊断完成后刷新顶部状态并清理订阅', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    let overviewCalls = 0;
    let notifyOverviewChanged: (() => void) | undefined;
    let unsubscribed = false;
    const dispose = renderMemoryWorkbench(container, workbenchController({
      getOverview: async () => {
        overviewCalls += 1;
        return overviewCalls === 1
          ? { status: 'ready', bound: true, factCount: 1, lastOrganizedAt: 10, pendingJobs: 0, llmAvailable: true }
          : {
            status: 'ready', bound: true, factCount: 1, lastOrganizedAt: 10, pendingJobs: 0, llmAvailable: true,
            embedding: { available: true, model: 'Embed-Test' },
            rerank: { available: false, blockedReason: '暂时无法读取 LLM 资源状态' },
          };
      },
      onOverviewChanged: (listener) => { notifyOverviewChanged = listener; return () => { unsubscribed = true; }; },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelectorAll('.stx-memory-status-route [data-ss-helper-control="status"]')[0]?.textContent).toBe('读取中');

    notifyOverviewChanged?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.textContent).toContain('Embed-Test');
    expect(container.textContent).toContain('暂时无法读取 LLM 资源状态');
    dispose();
    expect(unsubscribed).toBe(true);
  });

  it('初始化开关默认关闭、实时刷新计数，并把本次选项传给控制器', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const sourceOptions: boolean[] = [];
    const estimateOptions: boolean[] = [];
    const initializeOptions: MemoryInitializationOptions[] = [];
    const dispose = renderMemoryWorkbench(container, workbenchController({
      getInitializationSources: async (options) => {
        const enabled = options?.includeInvisibleHistory === true;
        sourceOptions.push(enabled);
        return [{ kind: 'message', label: '聊天消息', count: enabled ? 2 : 1, rawCount: 3, defaultCount: 1, excludedCount: enabled ? 1 : 2, selected: true }];
      },
      getInitializationEstimate: async (_kinds, options) => {
        const enabled = options?.includeInvisibleHistory === true;
        estimateOptions.push(enabled);
        return { messageCount: enabled ? 2 : 1, batchCount: 1, tokenLow: 10, tokenHigh: 20 };
      },
      initialize: async (_kinds, options) => { initializeOptions.push({ ...options }); },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    (container.querySelector('[data-page="initialize"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const toggle = container.querySelector<HTMLInputElement>('[data-option="include-invisible-history"]')!;
    expect(toggle.checked).toBe(false);
    expect(container.textContent).toContain('1 / 3 条');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sourceOptions.at(-1)).toBe(true);
    expect(estimateOptions.at(-1)).toBe(true);
    expect(container.textContent).toContain('2 / 3 条');
    (container.querySelector('[data-action="initialize-start"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(initializeOptions).toEqual([{ includeInvisibleHistory: true }]);
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
    expect(container.textContent).toContain('正在提取并写入结构化记忆');

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
        { kind: 'message', label: '聊天消息', count: 8, rawCount: 10, defaultCount: 8, excludedCount: 2, selected: true },
        { kind: 'host_card', label: '角色卡世界容器', count: 1, rawCount: 1, defaultCount: 1, excludedCount: 0, selected: false },
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
    const hostCard = container.querySelector<HTMLInputElement>('[data-source-kind="host_card"]')!;
    hostCard.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(estimateKinds.at(-1)).toEqual(['message', 'host_card']);

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
