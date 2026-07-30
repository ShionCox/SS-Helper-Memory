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
    estimate: { messageCount: 18, batchCount: 4, tokenLow: 900, tokenHigh: 1400 },
    progress: { status: 'idle', batchIndex: 0, totalBatches: 0, processedCount: 0, elapsedMs: 0 },
    initialized: false,
    lastCompletedAt: null,
    successfulSourceKinds: [],
    attempts: [],
    factCount: 0,
    storageBytes: 0,
    summaryNote: '按每批 5 层可见消息拆分。',
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
    expect(html).toContain('<b>18 / 20</b><small>项</small>');
    expect(html).toContain('data-ss-helper-control="checkbox"');
    expect(html).toContain('class="stx-memory-init-source-checkbox"');
    expect(html).toContain('aria-label="选择聊天消息"');
    expect(html).not.toContain('class="stx-memory-sr-only" data-ss-helper-control="checkbox"');
    expect(html).toContain('data-action="initialize-start"');
    expect(html).not.toContain('原型预览状态');
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
