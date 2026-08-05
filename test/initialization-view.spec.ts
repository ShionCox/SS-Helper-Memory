import { describe, expect, it } from 'vitest';
import {
  deriveInitializationStage,
  renderInitializationView,
  type InitializationViewModel,
} from '../src/ui/initialization-view';

function model(overrides: Partial<InitializationViewModel> = {}): InitializationViewModel {
  return {
    chatLabel: '测试聊天',
    chatBound: true,
    workspaceAvailable: true,
    llmAvailable: true,
    sources: [
      { kind: 'message', label: '聊天消息', count: 18, rawCount: 20, defaultCount: 18, excludedCount: 2, invisibleCount: 2 },
      { kind: 'host_card', label: '角色卡世界容器', count: 1, rawCount: 1, defaultCount: 1, excludedCount: 0 },
    ],
    selectedSourceKinds: ['message'],
    includeHiddenMessageFloors: true,
    extractionMode: 'single',
    runtimeExtractionMode: 'single',
    agentConcurrency: 2,
    agentToolPolicy: 'off',
    summaryBatchMode: 'floors',
    summaryBatchFloors: 5,
    summaryBatchChars: 12_000,
    batchRangeStart: 1,
    batchRangeEnd: 4,
    estimate: { messageCount: 18, batchCount: 4, conversationFloorCount: 18, logicalBatchCount: 4, tokenLow: 900, tokenHigh: 1400 },
    progress: { status: 'idle', batchIndex: 0, totalBatches: 0, processedCount: 0, elapsedMs: 0 },
    initialized: false,
    lastCompletedAt: null,
    successfulSourceKinds: [],
    attempts: [],
    factCount: 0,
    storageBytes: 0,
    submitting: false,
    busy: false,
    reinitializeOpen: false,
    ...overrides,
  };
}

describe('initialization view', () => {
  it('derives deterministic pipeline stages from real task state', () => {
    expect(deriveInitializationStage(undefined, true, false)).toEqual({ activeIndex: 0, allDone: false, halted: false });
    expect(deriveInitializationStage({ status: 'running', batchIndex: 2, totalBatches: 4, processedCount: 8, elapsedMs: 2000 }, false, false)).toEqual({ activeIndex: 1, allDone: false, halted: false });
    expect(deriveInitializationStage({ status: 'paused', batchIndex: 4, totalBatches: 4, processedCount: 18, elapsedMs: 6000 }, false, false)).toEqual({ activeIndex: 2, allDone: false, halted: true });
    expect(deriveInitializationStage({ status: 'completed', batchIndex: 4, totalBatches: 4, processedCount: 18, elapsedMs: 6000 }, false, false)).toEqual({ activeIndex: 3, allDone: false, halted: false });
    expect(deriveInitializationStage(undefined, false, true)).toEqual({ activeIndex: -1, allDone: true, halted: false });
  });

  it('renders setup with SDK controls and a real estimate without redundant safety copy', () => {
    const html = renderInitializationView(model());
    expect(html).toContain('初始化当前聊天');
    expect(html).toContain('来源项目');
    expect(html).not.toContain('初始化不会改写');
    expect(html).toContain('stx-memory-init-scroll');
    expect(html).toContain('data-source-kind="message"');
    expect(html).not.toContain('data-option="include-invisible-history"');
    expect(html).toContain('data-option="include-hidden-message-floors"');
    expect(html).toContain('处理隐藏楼层');
    expect(html).toMatch(/data-option="include-hidden-message-floors"[^>]*checked/u);
    expect(html).toContain('stx-memory-init-option is-selected');
    expect(html).toContain('data-option="batch-range-start"');
    expect(html).toContain('data-option="batch-range-end"');
    expect(html).toContain('楼层分组</dt><dd>4');
    expect(html).toContain('本次批次</dt><dd>4 / 4');
    expect(html).toContain('预计输入 Token</dt><dd>900–1,400');
    expect(html).toContain('<b>18 / 20</b><small>项</small>');
    expect(html).toContain('data-ss-helper-control="checkbox"');
    expect(html).toContain('class="stx-memory-init-source-checkbox"');
    expect(html).toContain('aria-label="选择聊天消息"');
    expect(html).not.toContain('class="stx-memory-sr-only" data-ss-helper-control="checkbox"');
    expect(html).toContain('data-action="initialize-start"');
    expect(html).not.toContain('原型预览状态');
  });

  it('highlights only selected source cards and renders a bounded batch range', () => {
    const html = renderInitializationView(model({
      includeHiddenMessageFloors: false,
      selectedSourceKinds: ['message'],
      batchRangeStart: 1,
      batchRangeEnd: 3,
      estimate: { messageCount: 55, batchCount: 11, conversationFloorCount: 55, logicalBatchCount: 11, tokenLow: 900, tokenHigh: 1400 },
    }));

    expect(html).toContain('class="stx-memory-init-option"');
    expect(html).not.toContain('class="stx-memory-init-option is-selected"');
    expect(html).toMatch(/class="stx-memory-init-source-card is-selected"[\s\S]*data-source-kind="message"/u);
    expect(html).toMatch(/class="stx-memory-init-source-card"[\s\S]*data-source-kind="host_card"/u);
    expect(html).toContain('max="11" value="1" data-option="batch-range-start"');
    expect(html).toContain('max="11" value="3" data-option="batch-range-end"');
    expect(html).toContain('本次批次</dt><dd>3 / 11');
    expect(html).toContain('1–3 / 11');
  });

  it('uses the configured floor groups as the real selectable batches', () => {
    const html = renderInitializationView(model({
      summaryBatchFloors: 10,
      summaryBatchChars: 12_000,
      batchRangeEnd: 28,
      estimate: {
        messageCount: 275,
        batchCount: 28,
        conversationFloorCount: 275,
        logicalBatchCount: 28,
        tokenLow: 768_500,
        tokenHigh: 1_280_900,
      },
    }));

    expect(html).toContain('聊天楼层</dt><dd>275');
    expect(html).toContain('楼层分组</dt><dd>28');
    expect(html).toContain('本次批次</dt><dd>28 / 28');
    expect(html).toContain('按每组最多 10 层形成 28 批');
    expect(html).toContain('初始化批次范围');
  });

  it('marks a runnable Agent pipeline and renders its current fixed flow', () => {
    const html = renderInitializationView(model({
      extractionMode: 'agent',
      runtimeExtractionMode: 'agent',
      agentConcurrency: 2,
      agentToolPolicy: 'read_only',
    }));

    expect(html).toContain('Agent · 正式写入');
    expect(html).toContain('开始 Agent 初始化');
    expect(html).toContain('确定性预取');
    expect(html).toContain('实体优先与联合提取');
    expect(html).toContain('本地合并、强校验与裁决');
    expect(html).toContain('原子提交并召回');
    expect(html).not.toContain('影子');
  });

  it('blocks initialization instead of silently falling back when Agent is unavailable', () => {
    const html = renderInitializationView(model({
      extractionMode: 'agent',
      runtimeExtractionMode: 'single',
      agentToolPolicy: 'read_only',
    }));

    expect(html).toContain('Agent 未就绪');
    expect(html).toContain('不会静默回退到单次提取');
    expect(html).toMatch(/data-action="initialize-start"[^>]*disabled/u);
  });

  it('renders running and paused states with locked sources and matching actions', () => {
    const running = renderInitializationView(model({
      progress: { status: 'running', jobId: 'job-1', batchIndex: 2, totalBatches: 4, processedCount: 9, elapsedMs: 5000 },
    }));
    expect(running).toContain('正在提取并写入结构化记忆');
    expect(running).toContain('已锁定来源');
    expect(running).toContain('stx-memory-init-step-working');
    expect(running).toContain('data-action="initialize-cancel"');
    expect(running).toContain('已完成批次 2 / 4');

    const paused = renderInitializationView(model({
      progress: { status: 'paused', jobId: 'job-1', batchIndex: 2, totalBatches: 4, processedCount: 9, elapsedMs: 5000 },
      attempts: [{ jobId: 'job-1', status: 'paused', updatedAt: 10, totalBatches: 4, selectedSourceKinds: ['message'] }],
    }));
    expect(paused).toContain('断点已保留');
    expect(paused).toContain('stx-memory-init-alert is-paused');
    expect(paused).toContain('stx-memory-init-pipeline-step is-stopped');
    expect(paused).not.toContain('stx-memory-init-step-working');
    expect(paused).toContain('data-action="initialize-resume"');
    expect(paused).toContain('data-action="open-reinitialize"');
    expect(paused).toContain('已完成批次 2 / 4 · 第 3 批未完成');
    expect(paused).not.toContain('data-action="initialize-cancel"');
  });

  it('renders a two-line failure hierarchy with the request id as right-aligned metadata', () => {
    const html = renderInitializationView(model({
      progress: {
        status: 'paused',
        jobId: 'job-1',
        batchIndex: 0,
        totalBatches: 4,
        processedCount: 0,
        elapsedMs: 1200,
        failure: {
          reasonCode: 'STRUCTURED_OUTPUT_EMPTY',
          stage: 'llm.structured.validate',
          requestId: 'ss-helper.memory:1:request-1',
          batchIndex: 0,
          collection: 'claims',
          path: '$.claims[0].evidenceSpanId',
          keyword: 'enum',
          expected: 'supported evidence span',
        },
      },
    }));
    expect(html).toContain('stx-memory-init-alert is-danger stx-memory-init-failure');
    expect(html).toContain('stx-memory-init-error-head');
    expect(html).toContain('<strong>模型没有返回结构化内容</strong><code>STRUCTURED_OUTPUT_EMPTY</code>');
    expect(html).toContain('stx-memory-init-error-detail');
    expect(html).toContain('<span>批次</span><code>1</code>');
    expect(html).toContain('<span>集合</span><code>claims</code>');
    expect(html).toContain('<span>字段</span><code>$.claims[0].evidenceSpanId</code>');
    expect(html).toContain('<span>规则</span><code>enum</code>');
    expect(html).toContain('<span>要求</span><code>supported evidence span</code>');
    expect(html).toContain('<span>请求 ID</span><code>ss-helper.memory:1:request-1</code>');
  });

  it('renders needs_repair as partial recall instead of a retryable pause', () => {
    const html = renderInitializationView(model({
      progress: {
        status: 'needs_repair',
        jobId: 'job-1',
        batchIndex: 4,
        totalBatches: 4,
        processedCount: 18,
        elapsedMs: 5000,
        phase: 'repair',
        outcome: 'partial',
        rejectedCount: 12,
        pendingRepairCount: 3,
      },
      attempts: [{ jobId: 'job-1', status: 'needs_repair', updatedAt: 10, totalBatches: 4, selectedSourceKinds: ['message'] }],
    }));
    expect(html).toContain('部分记忆已可召回');
    expect(html).toContain('部分可召回 · 仍有 3 项待修复');
    expect(html).toContain('待修复 3 项');
    expect(html).toContain('未解决项将由 AI 自动复核');
    expect(html).toContain('继续处理');
    expect(html).toContain('data-action="open-reinitialize"');
    expect(html).not.toContain('任务因可重试错误暂停');
    expect(html).not.toContain('初始化已暂停');
  });

  it('normalizes legacy review state with no pending repair into non-blocking partial completion', () => {
    const html = renderInitializationView(model({
      progress: {
        status: 'needs_review',
        jobId: 'job-review',
        batchIndex: 8,
        totalBatches: 8,
        processedCount: 79,
        elapsedMs: 6000,
        phase: 'repair',
        outcome: 'partial',
        pendingRepairCount: 0,
        retryableRepairCount: 0,
        repairedCount: 13,
        degradedCount: 55,
        exhaustedRepairCount: 4,
        quarantinedCount: 22,
        reviewRequiredCount: 0,
        unresolvedRejectionCount: 22,
        ignoredCount: 3,
      },
      attempts: [{ jobId: 'job-review', status: 'needs_review', updatedAt: 10, totalBatches: 8, selectedSourceKinds: ['message'] }],
    }));
    expect(html).toContain('部分完成 · 召回可用');
    expect(html).toContain('已隔离 22 项等待证据变化');
    expect(html).toContain('也不需要人工处理');
    expect(html).toContain('stx-memory-init-activity is-completed');
    expect(html).toContain('1970/1/1');
    expect(html).not.toContain('尚未完成');
    expect(html).not.toContain('待审阅');
    expect(html).not.toContain('需人工审阅');
    expect(html).not.toContain('data-action="view-audit"');
    expect(html).not.toContain('data-action="initialize-resume"');
  });

  it('normalizes a stale needs_repair job with zero pending items into completed recall', () => {
    const html = renderInitializationView(model({
      progress: {
        status: 'needs_repair',
        jobId: 'job-stale',
        batchIndex: 4,
        totalBatches: 4,
        processedCount: 18,
        elapsedMs: 5000,
        outcome: 'partial',
        pendingRepairCount: 0,
        retryableRepairCount: 0,
        quarantinedCount: 2,
      },
      attempts: [{ jobId: 'job-stale', status: 'needs_repair', updatedAt: 10, totalBatches: 4, selectedSourceKinds: ['message'] }],
    }));
    expect(html).toContain('当前聊天已初始化');
    expect(html).toContain('已隔离 2 项等待证据变化');
    expect(html).toContain('stx-memory-init-activity is-completed');
    expect(html).not.toContain('仍有 0 项待修复');
    expect(html).not.toContain('data-action="initialize-resume"');
  });

  it('renders completed metrics, used sources and at most five real activities', () => {
    const attempts = Array.from({ length: 7 }, (_, index) => ({
      jobId: `job-${index}`,
      status: index === 0 ? 'completed' as const : 'failed' as const,
      updatedAt: 100 - index,
      totalBatches: index + 1,
      selectedSourceKinds: ['message'],
    }));
    const html = renderInitializationView(model({
      initialized: true,
      lastCompletedAt: 100,
      successfulSourceKinds: ['message'],
      progress: { status: 'completed', batchIndex: 4, totalBatches: 4, processedCount: 18, elapsedMs: 6000, degradedCount: 2 },
      attempts,
      factCount: 28,
      storageBytes: 2048,
    }));
    expect(html).toContain('当前聊天已初始化');
    expect(html).toContain('记忆事实');
    expect(html).toContain('2.00 KB');
    expect(html).toContain('已使用来源');
    expect(html).toContain('data-action="open-reinitialize"');
    expect((html.match(/stx-memory-init-activity is-/g) ?? [])).toHaveLength(5);
    expect(html).toContain('已安全降级 2 项');
    expect(html).toContain('没有猜测或改绑实体');
  });

  it('keeps completed partial tasks visibly marked as partial', () => {
    const html = renderInitializationView(model({
      initialized: true,
      progress: {
        status: 'completed',
        jobId: 'job-partial',
        batchIndex: 4,
        totalBatches: 4,
        processedCount: 18,
        elapsedMs: 6000,
        outcome: 'partial',
        quarantinedCount: 2,
      },
      attempts: [{ jobId: 'job-partial', status: 'completed', updatedAt: 10, totalBatches: 4, selectedSourceKinds: ['message'] }],
    }));

    expect(html).toContain('部分完成 · 召回可用');
    expect(html).toContain('已隔离 2 项等待证据变化');
  });

  it('does not flash back to setup when a completed repair snapshot arrives before initialization state refresh', () => {
    const html = renderInitializationView(model({
      initialized: false,
      progress: {
        status: 'completed', jobId: 'job-repair-completed', batchIndex: 4, totalBatches: 4, processedCount: 18, elapsedMs: 6000,
        phase: 'repair', outcome: 'partial', quarantinedCount: 2,
      },
      attempts: [{ jobId: 'job-repair-completed', status: 'completed', updatedAt: 10, totalBatches: 4, selectedSourceKinds: ['message'] }],
    }));
    expect(html).toContain('当前聊天已初始化');
    expect(html).not.toContain('初始化当前聊天');
  });

  it('shows Provider-reported Token usage without replacing missing fields with zero', () => {
    const html = renderInitializationView(model({
      progress: {
        status: 'running', jobId: 'job-1', batchIndex: 2, totalBatches: 4, processedCount: 9, elapsedMs: 5000,
        usageRequestCount: 3,
        usageReportedCount: 2,
        actualUsage: { promptTokens: 1200, completionTokens: 340, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null },
      },
    }));

    expect(html).toContain('Provider 实际 Token 用量');
    expect(html).toContain('API 响应</dt><dd>3');
    expect(html).toContain('返回用量</dt><dd>2');
    expect(html).toContain('输入 Token</dt><dd>1,200');
    expect(html).toContain('输出 Token</dt><dd>340');
    expect(html).toContain('总 Token</dt><dd>API 未返回');
  });

  it('uses a looping repair bar and switches the estimate card to actual total usage', () => {
    const html = renderInitializationView(model({
      progress: {
        status: 'repairing', jobId: 'job-repair', batchIndex: 0, totalBatches: 307, processedCount: 0, elapsedMs: 5000,
        phase: 'repair',
        actualUsage: { promptTokens: 2_519_748, completionTokens: 908_213, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: 3_427_961 },
        usageRequestCount: 122,
        usageReportedCount: 122,
      },
    }));
    expect(html).toContain('class="stx-memory-init-progress-loop"');
    expect(html).toContain('aria-label="修复进行中"');
    expect(html).not.toContain('<progress');
    expect(html).toContain('实际累计 Token</dt><dd>3,427,961');
    expect(html).toContain('包含本任务的输出、工具回合、重试和定向修复');
  });

  it('keeps chat batch progress separate from active repair task progress', () => {
    const html = renderInitializationView(model({
      progress: {
        status: 'repairing',
        jobId: 'job-repair',
        batchIndex: 3,
        totalBatches: 26,
        processedCount: 3,
        elapsedMs: 76_000,
        phase: 'repair',
        batchRangeStart: 1,
        batchRangeEnd: 2,
        availableBatchCount: 28,
      },
    }));
    expect(html).toContain('已完成批次 2 / 2 · 第 1–2 批 / 共 28 批');
    expect(html).toContain('修复任务 3 / 26 · 76 秒');
    expect(html).not.toContain('已完成批次 3 / 26');
  });

  it('keeps sources browseable but disables submission when capabilities are unavailable', () => {
    const html = renderInitializationView(model({
      workspaceAvailable: false,
      workspaceReason: 'SQLITE_SERVICE_UNAVAILABLE',
      llmAvailable: false,
      llmReason: 'LLM_SERVICE_UNAVAILABLE',
    }));
    expect(html).toContain('初始化能力当前不可用');
    expect(html).toContain('SQLITE_SERVICE_UNAVAILABLE');
    expect(html).toContain('LLM_SERVICE_UNAVAILABLE');
    expect(html).toContain('stx-memory-init-source-card');
    expect(html).toMatch(/data-action="initialize-start"[^>]*disabled/);
  });

  it('renders the reinitialize drawer with danger and preserved scopes', () => {
    const html = renderInitializationView(model({
      initialized: true,
      successfulSourceKinds: ['message'],
      reinitializeOpen: true,
    }));
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('将清理');
    expect(html).toContain('不会影响');
    expect(html).toContain('data-action="confirm-reinitialize"');
    expect(html).toContain('id="stx-memory-reinitialize-cancel"');
  });
});
