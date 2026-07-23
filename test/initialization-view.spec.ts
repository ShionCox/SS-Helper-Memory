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
    includeInvisibleHistory: false,
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
    expect(deriveInitializationStage(undefined, true, false)).toEqual({ activeIndex: 0, allDone: false });
    expect(deriveInitializationStage({ status: 'running', batchIndex: 2, totalBatches: 4, processedCount: 8, elapsedMs: 2000 }, false, false)).toEqual({ activeIndex: 1, allDone: false });
    expect(deriveInitializationStage({ status: 'paused', batchIndex: 4, totalBatches: 4, processedCount: 18, elapsedMs: 6000 }, false, false)).toEqual({ activeIndex: 2, allDone: false });
    expect(deriveInitializationStage({ status: 'completed', batchIndex: 4, totalBatches: 4, processedCount: 18, elapsedMs: 6000 }, false, false)).toEqual({ activeIndex: 3, allDone: false });
    expect(deriveInitializationStage(undefined, false, true)).toEqual({ activeIndex: -1, allDone: true });
  });

  it('renders setup with SDK controls, real estimate and safety boundary', () => {
    const html = renderInitializationView(model());
    expect(html).toContain('初始化当前聊天');
    expect(html).toContain('来源项目');
    expect(html).toContain('初始化不会改写');
    expect(html).toContain('data-source-kind="message"');
    expect(html).toContain('data-option="include-invisible-history"');
    expect(html).toContain('data-ss-helper-control="checkbox"');
    expect(html).toContain('data-action="initialize-start"');
    expect(html).not.toContain('原型预览状态');
  });

  it('renders running and paused states with locked sources and matching actions', () => {
    const running = renderInitializationView(model({
      progress: { status: 'running', jobId: 'job-1', batchIndex: 2, totalBatches: 4, processedCount: 9, elapsedMs: 5000 },
    }));
    expect(running).toContain('正在提取并写入结构化记忆');
    expect(running).toContain('已锁定来源');
    expect(running).toContain('data-action="initialize-cancel"');

    const paused = renderInitializationView(model({
      progress: { status: 'paused', jobId: 'job-1', batchIndex: 2, totalBatches: 4, processedCount: 9, elapsedMs: 5000 },
      attempts: [{ jobId: 'job-1', status: 'paused', updatedAt: 10, totalBatches: 4, selectedSourceKinds: ['message'] }],
    }));
    expect(paused).toContain('断点已保留');
    expect(paused).toContain('data-action="initialize-resume"');
    expect(paused).not.toContain('data-action="initialize-cancel"');
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
