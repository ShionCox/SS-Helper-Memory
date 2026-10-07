import {
  UI_CONTROL_ATTRIBUTE,
  UI_CONTROL_ICON_ONLY_ATTRIBUTE,
  UI_CONTROL_SIZE_ATTRIBUTE,
  UI_CONTROL_TONE_ATTRIBUTE,
  describeSSHelperFailure,
  type SSHelperFailureContext,
  type UiControlKind,
  type UiControlSize,
  type UiControlTone,
} from '@ss-helper/sdk';

export type InitializationProgressStatus = 'idle' | 'queued' | 'running' | 'repairing' | 'needs_repair' | 'needs_review' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface InitializationViewSource {
  kind: string;
  label: string;
  count: number;
  rawCount: number;
  defaultCount: number;
  excludedCount: number;
  invisibleCount?: number;
}

export interface InitializationViewEstimate {
  messageCount: number;
  batchCount: number;
  conversationFloorCount?: number;
  logicalBatchCount?: number;
  tokenLow: number;
  tokenHigh: number;
}

export interface InitializationViewProgress {
  status: InitializationProgressStatus;
  jobId?: string;
  batchIndex: number;
  totalBatches: number;
  completedBatchCount?: number;
  batchRangeStart?: number;
  batchRangeEnd?: number;
  availableBatchCount?: number;
  processedCount: number;
  elapsedMs: number;
  failure?: SSHelperFailureContext;
  phase?: 'capture' | 'repair';
  outcome?: 'complete' | 'partial';
  rejectedCount?: number;
  pendingRepairCount?: number;
  retryableRepairCount?: number;
  exhaustedRepairCount?: number;
  quarantinedCount?: number;
  reviewRequiredCount?: number;
  unresolvedRejectionCount?: number;
  repairedCount?: number;
  degradedCount?: number;
  ignoredCount?: number;
  actualUsage?: import('../domain').MemoryTokenUsage;
  usageRequestCount?: number;
  usageReportedCount?: number;
}

export interface InitializationViewAttempt {
  jobId: string;
  status: InitializationProgressStatus;
  updatedAt: number;
  totalBatches: number;
  batchRangeStart?: number;
  batchRangeEnd?: number;
  availableBatchCount?: number;
  selectedSourceKinds: readonly string[];
  includeHiddenMessageFloors?: boolean;
  failure?: SSHelperFailureContext;
}

export interface InitializationViewModel {
  chatLabel: string;
  chatBound: boolean;
  workspaceAvailable: boolean;
  workspaceReason?: string;
  llmAvailable: boolean;
  llmReason?: string;
  sources: readonly InitializationViewSource[];
  selectedSourceKinds: readonly string[];
  includeHiddenMessageFloors: boolean;
  extractionMode: 'single' | 'agent';
  runtimeExtractionMode: 'single' | 'agent';
  agentToolPolicy: 'off' | 'read_only';
  summaryBatchMode: 'floors' | 'chars';
  summaryBatchFloors: number;
  summaryBatchChars: number;
  batchRangeStart: number;
  batchRangeEnd: number;
  estimate?: InitializationViewEstimate;
  progress?: InitializationViewProgress;
  initialized: boolean;
  lastCompletedAt: number | null;
  successfulSourceKinds: readonly string[];
  attempts: readonly InitializationViewAttempt[];
  factCount: number;
  storageBytes: number;
  submitting: boolean;
  busy: boolean;
  reinitializeOpen: boolean;
}

export interface InitializationStage {
  activeIndex: number;
  allDone: boolean;
  halted: boolean;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(Number.isFinite(value) ? value : 0);
}

function formatTime(value: number | null | undefined): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '尚未完成';
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return 'N/A';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let amount = value / 1024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024;
    unit = units[index]!;
  }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${unit}`;
}

function uiControl(kind: UiControlKind, tone?: UiControlTone): string {
  return `${UI_CONTROL_ATTRIBUTE}="${kind}"${tone === undefined ? '' : ` ${UI_CONTROL_TONE_ATTRIBUTE}="${tone}"`}`;
}

function uiButton(tone: UiControlTone = 'neutral', size: UiControlSize = 'md', iconOnly = false): string {
  return `${uiControl('button', tone)} ${UI_CONTROL_SIZE_ATTRIBUTE}="${size}"${iconOnly ? ` ${UI_CONTROL_ICON_ONLY_ATTRIBUTE}` : ''}`;
}

function statusChip(label: string, tone: 'neutral' | 'success' | 'warning' | 'error' = 'neutral'): string {
  return `<span ${uiControl('status', tone)}>${escapeHtml(label)}</span>`;
}

function sourceIcon(kind: string): string {
  if (kind === 'message') return 'comments';
  if (kind === 'state') return 'sliders';
  if (kind === 'host_card') return 'id-card';
  if (kind === 'persona') return 'user';
  if (kind.startsWith('worldbook:')) return 'book-open';
  return 'file-lines';
}

function sourceDetail(source: InitializationViewSource): string {
  if (source.kind === 'message') return '用户与助手的聊天正文';
  if (source.kind === 'state') return '当前聊天的最新状态快照';
  if (source.kind === 'host_card') return '当前角色卡的规范设定来源';
  if (source.kind === 'persona') return '当前用户身份与个人设定';
  if (source.kind.startsWith('worldbook:')) return '已启用的世界规则与设定';
  return '当前聊天可读取的初始化来源';
}

function recordStatusLabel(status: InitializationProgressStatus): string {
  return ({
    idle: '空闲',
    queued: '已排队',
    running: '进行中',
    repairing: '修复中',
    needs_repair: '部分完成',
    needs_review: '已隔离',
    paused: '已暂停',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  } satisfies Record<InitializationProgressStatus, string>)[status];
}

export function deriveInitializationStage(
  progress: InitializationViewProgress | undefined,
  submitting: boolean,
  initialized: boolean,
): InitializationStage {
  if (initialized) return { activeIndex: -1, allDone: true, halted: false };
  if (progress?.status === 'running' || progress?.status === 'repairing' || progress?.status === 'needs_repair' || progress?.status === 'needs_review' || progress?.status === 'paused' || progress?.status === 'failed') {
    const halted = progress.status === 'paused' || progress.status === 'failed';
    if (progress.phase === 'repair') return { activeIndex: 2, allDone: false, halted: progress.status === 'needs_repair' || progress.status === 'needs_review' || halted };
    if (progress.totalBatches > 0 && progress.batchIndex >= progress.totalBatches) {
      return { activeIndex: 2, allDone: false, halted };
    }
    return { activeIndex: progress.batchIndex > 0 ? 1 : 0, allDone: false, halted };
  }
  if (progress?.status === 'completed') return { activeIndex: 3, allDone: false, halted: false };
  if (submitting || progress?.status === 'queued') return { activeIndex: 0, allDone: false, halted: false };
  return { activeIndex: -1, allDone: false, halted: false };
}

function agentModeBlocked(model: InitializationViewModel): boolean {
  return model.extractionMode === 'agent'
    && (model.runtimeExtractionMode !== 'agent' || model.agentToolPolicy !== 'read_only');
}

function formatReportedToken(value: number | null | undefined): string {
  return value === null || value === undefined ? 'API 未返回' : formatNumber(value);
}

function actualTotalTokens(progress: InitializationViewProgress | undefined): number | undefined {
  const value = progress?.actualUsage?.totalTokens;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function renderActualUsage(progress: InitializationViewProgress | undefined): string {
  if (!progress || (progress.usageRequestCount ?? 0) === 0) return '';
  const usage = progress.actualUsage;
  return `<dl class="stx-memory-init-estimate stx-memory-init-actual-usage" aria-label="Provider 实际 Token 用量">
    <div><dt>API 响应</dt><dd>${formatNumber(progress.usageRequestCount ?? 0)}</dd></div>
    <div><dt>返回用量</dt><dd>${formatNumber(progress.usageReportedCount ?? 0)}</dd></div>
    <div><dt>输入 Token</dt><dd>${formatReportedToken(usage?.promptTokens)}</dd></div>
    <div><dt>输出 Token</dt><dd>${formatReportedToken(usage?.completionTokens)}</dd></div>
    <div><dt>总 Token</dt><dd>${formatReportedToken(usage?.totalTokens)}</dd></div>
  </dl>`;
}

function runningAgentMode(model: InitializationViewModel): boolean {
  return model.extractionMode === 'agent' && model.runtimeExtractionMode === 'agent';
}

function extractionModeLabel(model: InitializationViewModel): string {
  if (agentModeBlocked(model)) return 'Agent 未就绪';
  if (!runningAgentMode(model)) return '单次提取';
  return 'Agent · 正式写入';
}

function extractionModeDescription(model: InitializationViewModel): string {
  if (model.extractionMode === 'agent' && model.agentToolPolicy !== 'read_only') return 'Agent 模式要求开启按需只读工具；基础工具调用是硬要求，初始化已阻止。';
  if (agentModeBlocked(model)) return 'Agent 路由或工具能力当前未通过验证；初始化已阻止，不会静默回退到单次提取。';
  if (!runningAgentMode(model)) return '每批进行一次结构化提取，再通过硬校验、定向修复和原子提交。';
  const tools = model.agentToolPolicy === 'read_only' ? '按需只读工具' : '工具关闭';
  return `实体阶段优先，随后运行一次内容与库存联合提取（${tools}）；通过本地合并、强校验与裁决后原子写入正式记忆。`;
}

function renderModeSummary(model: InitializationViewModel): string {
  const blocked = agentModeBlocked(model);
  const agent = runningAgentMode(model);
  const tone = blocked ? 'warning' : agent ? 'success' : 'neutral';
  const icon = blocked ? 'triangle-exclamation' : agent ? 'robot' : 'wand-magic-sparkles';
  return `<div class="stx-memory-init-mode is-${blocked ? 'blocked' : agent ? 'agent' : 'single'}" role="status">
    <span class="stx-memory-init-mode-icon"><ss-helper-icon name="${icon}" decorative></ss-helper-icon></span>
    <span class="stx-memory-init-mode-copy"><strong>${escapeHtml(extractionModeLabel(model))}</strong><small>${escapeHtml(extractionModeDescription(model))}</small></span>
    ${statusChip(blocked ? '请先验证路由' : agent ? (model.agentToolPolicy === 'read_only' ? '只读工具' : '无工具') : '单阶段', tone)}
  </div>`;
}

function renderPipeline(stage: InitializationStage, model: InitializationViewModel): string {
  const steps = [['读取来源', 'filter'], ['提取记忆', 'wand-magic-sparkles'], ['校验整理', 'shield-halved'], ['保存记忆', 'database']] as const;
  return `<div class="stx-memory-init-pipeline" aria-label="${runningAgentMode(model) ? 'Agent' : '单次'}初始化阶段">${steps.map(([title, icon], index) => {
    const done = stage.allDone || (stage.activeIndex >= 0 && index < stage.activeIndex);
    const active = !stage.allDone && index === stage.activeIndex;
    const stopped = active && stage.halted;
    return `<article class="stx-memory-init-pipeline-step${done ? ' is-done' : ''}${active && !stopped ? ' is-active' : ''}${stopped ? ' is-stopped' : ''}"${active ? ' aria-current="step"' : ''}><span class="stx-memory-init-step-icon"><ss-helper-icon name="${done ? 'check' : stopped ? 'stop' : icon}" decorative></ss-helper-icon></span><span><strong>${title}</strong><small>${done ? '已完成' : stopped ? '已暂停' : active ? '进行中' : '等待中'}</small></span></article>`;
  }).join('')}</div>`;
}

function renderSourceCards(model: InitializationViewModel, kinds: readonly string[], locked: boolean, onlySelected = false): string {
  if (model.sources.length === 0) {
    return '<div class="stx-memory-init-empty"><ss-helper-icon name="inbox" decorative></ss-helper-icon><strong>当前没有可初始化来源</strong><p>请先选择角色或打开聊天。</p></div>';
  }
  const selected = new Set(kinds);
  const sources = onlySelected ? model.sources.filter((source) => selected.has(source.kind)) : model.sources;
  return `<div class="stx-memory-init-source-grid">${sources.map((source) => {
    const checked = selected.has(source.kind);
    const disabled = locked || source.count === 0;
    const excluded = Math.max(0, source.excludedCount);
    return `<div class="stx-memory-init-source-card${checked ? ' is-selected' : ''}${disabled ? ' is-disabled' : ''}"><label class="stx-memory-init-source-main">
      <span class="stx-memory-init-source-icon"><ss-helper-icon name="${sourceIcon(source.kind)}" decorative></ss-helper-icon></span>
      <span class="stx-memory-init-source-copy" title="${escapeHtml(sourceDetail(source))}${excluded ? ` · 当前排除 ${formatNumber(excluded)} 项` : ''}"><strong>${escapeHtml(source.label)}</strong><small>${formatNumber(source.count)} ${source.kind === 'message' ? '条' : '项'}${excluded ? ` · 已排除 ${formatNumber(excluded)} 项` : ''}</small></span>
      <input class="stx-memory-init-source-checkbox" ${uiControl('checkbox')} type="checkbox" data-source-kind="${escapeHtml(source.kind)}" aria-label="${escapeHtml(`选择${source.label}`)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
    </label>${source.kind === 'message' ? renderHiddenFloorOption(model, locked) : ''}</div>`;
  }).join('')}</div>`;
}

function renderHiddenFloorOption(model: InitializationViewModel, locked: boolean): string {
  return `<label class="stx-memory-init-option${model.includeHiddenMessageFloors ? ' is-selected' : ''}${locked ? ' is-disabled' : ''}">
    <span class="stx-memory-init-option-copy"><strong>包含隐藏楼层</strong></span>
    <input class="stx-memory-init-option-checkbox" ${uiControl('checkbox')} type="checkbox" data-option="include-hidden-message-floors" aria-label="处理隐藏楼层" ${model.includeHiddenMessageFloors ? 'checked' : ''} ${locked ? 'disabled' : ''}>
  </label>`;
}

function totalSelectedItems(model: InitializationViewModel, kinds: readonly string[] = model.selectedSourceKinds): number {
  const selected = new Set(kinds);
  return model.sources.reduce((sum, source) => sum + (selected.has(source.kind) ? source.count : 0), 0);
}

function sourceNames(model: InitializationViewModel, kinds: readonly string[]): string[] {
  const sourceMap = new Map(model.sources.map((source) => [source.kind, source.label] as const));
  return kinds.map((kind) => sourceMap.get(kind) ?? kind);
}

function selectedBatchRange(model: InitializationViewModel): { start: number; end: number; available: number; count: number } {
  const available = Math.max(0, Math.trunc(model.estimate?.batchCount ?? 0));
  if (available === 0) return { start: 0, end: 0, available: 0, count: 0 };
  const start = Math.min(available, Math.max(1, Math.trunc(model.batchRangeStart || 1)));
  const end = Math.min(available, Math.max(start, Math.trunc(model.batchRangeEnd || available)));
  return { start, end, available, count: end - start + 1 };
}

function batchScopeLabel(start: number | undefined, end: number | undefined, available: number | undefined, fallbackTotal: number): string {
  const safeAvailable = Math.max(fallbackTotal, Math.trunc(available ?? fallbackTotal));
  if (!start || !end || safeAvailable <= 0) return `${formatNumber(fallbackTotal)} 批`;
  return `第 ${formatNumber(start)}–${formatNumber(end)} 批 / 共 ${formatNumber(safeAvailable)} 批`;
}

function renderEstimate(model: InitializationViewModel, kinds: readonly string[] = model.selectedSourceKinds): string {
  const estimate = model.estimate;
  const range = selectedBatchRange(model);
  const floorCount = Math.max(0, Math.trunc(estimate?.conversationFloorCount ?? estimate?.messageCount ?? 0));
  const logicalBatchCount = Math.max(0, Math.trunc(estimate?.logicalBatchCount ?? estimate?.batchCount ?? 0));
  const actualTotal = actualTotalTokens(model.progress);
  const tokenLabel = actualTotal === undefined ? '预计输入 Token' : '实际累计 Token';
  const tokenValue = actualTotal === undefined
    ? `${formatNumber(estimate?.tokenLow ?? 0)}–${formatNumber(estimate?.tokenHigh ?? 0)}`
    : formatNumber(actualTotal);
  const tokenNote = actualTotal === undefined
    ? '执行前估算仅统计来源正文和基础提示；输出、工具回合、重试与修复会计入实际用量。'
    : '实际累计来自 Provider 响应，包含本任务的输出、工具回合、重试和定向修复。';
  return `<dl class="stx-memory-init-estimate">
    <div><dt>来源项目</dt><dd>${formatNumber(totalSelectedItems(model, kinds))}</dd></div>
    <div><dt>聊天楼层</dt><dd>${formatNumber(floorCount)}</dd></div>
    <div><dt>${model.summaryBatchMode === 'floors' ? '楼层分组' : '字数分组'}</dt><dd>${formatNumber(logicalBatchCount)}</dd></div>
    <div><dt>本次批次</dt><dd>${formatNumber(range.count)} / ${formatNumber(range.available)}</dd></div>
    <div><dt>${tokenLabel}</dt><dd>${tokenValue}</dd></div>
  </dl><p class="stx-memory-init-estimate-note">${tokenNote}</p>`;
}

function renderBatchExplanation(model: InitializationViewModel): string {
  const estimate = model.estimate;
  return model.summaryBatchMode === 'floors'
    ? `当前 ${formatNumber(estimate?.conversationFloorCount ?? estimate?.messageCount ?? 0)} 个聊天楼层按每组最多 ${formatNumber(model.summaryBatchFloors)} 层形成 ${formatNumber(estimate?.batchCount ?? 0)} 批；范围选择和进度均按这些楼层批次计算。`
    : `当前按每批最多 ${formatNumber(model.summaryBatchChars)} 字符拆分。`;
}

function renderBatchRange(model: InitializationViewModel, locked: boolean): string {
  const range = selectedBatchRange(model);
  const disabled = locked || range.available === 0;
  const id = locked ? 'stx-memory-init-locked-batch' : 'stx-memory-init-batch';
  return `<div class="stx-memory-init-batch-range" role="group" aria-labelledby="${id}-range-title">
    <span class="stx-memory-init-batch-range-copy"><strong id="${id}-range-title">初始化批次范围</strong><small id="${id}-range-note">选择本次要处理的连续批次，共 ${formatNumber(range.available)} 批。</small></span>
    <label><span>从</span><input id="${id}-start" ${uiControl('input')} type="number" inputmode="numeric" min="1" max="${range.available || 1}" value="${range.start || 1}" data-option="batch-range-start" aria-describedby="${id}-range-note" ${disabled ? 'disabled' : ''}></label>
    <label><span>至</span><input id="${id}-end" ${uiControl('input')} type="number" inputmode="numeric" min="1" max="${range.available || 1}" value="${range.end || 1}" data-option="batch-range-end" aria-describedby="${id}-range-note" ${disabled ? 'disabled' : ''}></label>
    ${statusChip(`${formatNumber(range.count)} 批次`)}
  </div>`;
}

function renderSection(title: string, description: string, content: string, badge = ''): string {
  return `<section class="stx-memory-init-section"><div class="stx-memory-init-section-title"><div><h3>${title}</h3><p>${description}</p></div>${badge}</div>${content}</section>`;
}

function renderActivities(model: InitializationViewModel): string {
  const items = model.attempts.slice(0, 5);
  if (!items.length) {
    return '<div class="stx-memory-init-empty is-activity"><ss-helper-icon name="clock-rotate-left" decorative></ss-helper-icon><span>暂无初始化记录</span></div>';
  }
  return items.map((attempt, index) => {
    const pendingCount = index === 0 || model.progress?.jobId === attempt.jobId
      ? Math.max(0, model.progress?.retryableRepairCount ?? model.progress?.pendingRepairCount ?? 0)
      : undefined;
    const status = (attempt.status === 'needs_repair' || attempt.status === 'needs_review') && pendingCount === 0
      ? 'completed'
      : attempt.status;
    const icon = status === 'completed' ? 'circle-check' : status === 'failed' ? 'circle-xmark' : status === 'paused' ? 'circle-pause' : status === 'cancelled' ? 'ban' : 'clock';
    return `<article class="stx-memory-init-activity is-${status}">
      <span class="stx-memory-init-activity-icon"><ss-helper-icon name="${icon}" decorative></ss-helper-icon></span>
      <div><div class="stx-memory-init-activity-head"><strong>${recordStatusLabel(status)}</strong><time datetime="${new Date(attempt.updatedAt).toISOString()}">${escapeHtml(formatTime(attempt.updatedAt))}</time></div>
      <p>${batchScopeLabel(attempt.batchRangeStart, attempt.batchRangeEnd, attempt.availableBatchCount, attempt.totalBatches)} · ${escapeHtml(sourceNames(model, attempt.selectedSourceKinds).join('、') || '全部可用来源')}</p>
      ${attempt.failure ? `<small>${escapeHtml(describeSSHelperFailure(attempt.failure).reasonCode)}</small>` : ''}</div>
    </article>`;
  }).join('');
}

function renderReadiness(model: InitializationViewModel): string {
  const ready = model.chatBound && model.workspaceAvailable && model.llmAvailable && !agentModeBlocked(model);
  return `<div class="stx-memory-init-readiness" aria-label="初始化准备状态"><span>当前聊天 · ${escapeHtml(model.chatLabel)}</span>${statusChip(ready ? '系统就绪' : '需要处理', ready ? 'success' : 'warning')}</div>`;
}

function renderUnavailable(model: InitializationViewModel): string {
  const reasons = [
    !model.workspaceAvailable ? `工作区：${model.workspaceReason ?? 'SQLite 服务不可用'}` : '',
    !model.llmAvailable ? `LLM：${model.llmReason ?? '服务或资源不可用'}` : '',
    !model.chatBound ? '当前聊天：尚未绑定' : '',
  ].filter(Boolean);
  return `<div class="stx-memory-init-alert is-danger" role="alert"><span><ss-helper-icon name="triangle-exclamation" decorative></ss-helper-icon></span><div><strong>初始化能力当前不可用</strong><p>${escapeHtml(reasons.join('；') || '记忆工作区或大语言模型未就绪。')}。来源仍可浏览，但不能开始初始化。</p></div></div>`;
}

function renderSetup(model: InitializationViewModel): string {
  const latest = model.attempts[0];
  const failed = latest?.status === 'failed';
  const cancelled = latest?.status === 'cancelled';
  const unavailable = !model.chatBound || !model.workspaceAvailable || !model.llmAvailable;
  const range = selectedBatchRange(model);
  return `<div class="stx-memory-init-task-head"><div><h2>${failed ? '上次初始化未完成' : cancelled ? '任务已取消' : '准备初始化'}</h2><p>${failed ? '检查来源后可重新开始。' : '选好来源，开始建立当前聊天的记忆。'}</p></div></div>
    ${unavailable ? renderUnavailable(model) : ''}
    ${agentModeBlocked(model) ? renderModeSummary(model) : ''}
    <div class="stx-memory-init-task-summary"><span><small>已选来源</small><strong>${model.selectedSourceKinds.length} 组 · ${formatNumber(totalSelectedItems(model))} 项</strong></span><span><small>本次批次</small><strong>${range.start}–${range.end} / ${range.available}</strong></span></div>
    ${renderPipeline({ activeIndex: -1, allDone: false, halted: false }, model)}`;
}

function renderConfiguration(model: InitializationViewModel, locked: boolean, actions: string): string {
  const unavailable = !model.chatBound || !model.workspaceAvailable || !model.llmAvailable;
  const kinds = model.initialized && model.successfulSourceKinds.length ? model.successfulSourceKinds : model.selectedSourceKinds;
  return `<aside class="stx-memory-init-configuration" aria-label="初始化配置"><div class="stx-memory-init-scroll" data-init-scroll="configuration">
    <h3>本次来源</h3>${locked ? '<p class="stx-memory-init-config-note">已锁定来源</p>' : ''}
    ${renderSourceCards(model, kinds, locked || unavailable, locked)}
    ${renderBatchRange(model, locked || unavailable || agentModeBlocked(model))}
    <details class="stx-memory-init-details" data-init-details="estimate"><summary>估算与高级选项</summary><div>${renderEstimate(model)}<p class="stx-memory-init-estimate-note">${escapeHtml(renderBatchExplanation(model))}</p>${renderModeSummary(model)}</div></details>
    </div><div class="stx-memory-init-actions">${actions}</div></aside>`;
}

function renderProgress(model: InitializationViewModel, paused: boolean, needsRepair = false): string {
  const progress = model.progress;
  const repairing = progress?.phase === 'repair' || progress?.status === 'repairing' || progress?.status === 'needs_repair';
  const repairTotal = Math.max(0, progress?.totalBatches ?? 0);
  const repairCompleted = Math.min(Math.max(0, progress?.batchIndex ?? 0), repairTotal);
  const rangedBatchCount = progress?.batchRangeStart && progress?.batchRangeEnd
    ? Math.max(0, progress.batchRangeEnd - progress.batchRangeStart + 1)
    : 0;
  const totalBatches = repairing && rangedBatchCount > 0
    ? rangedBatchCount
    : Math.max(0, progress?.totalBatches ?? model.estimate?.batchCount ?? 0);
  const batchScope = batchScopeLabel(progress?.batchRangeStart, progress?.batchRangeEnd, progress?.availableBatchCount, totalBatches);
  const batchIndex = Math.max(0, progress?.batchIndex ?? 0);
  const completedBatches = repairing
    ? totalBatches
    : Math.min(Math.max(0, progress?.completedBatchCount ?? batchIndex), totalBatches);
  const incompleteBatch = paused && completedBatches < totalBatches ? completedBatches + 1 : undefined;
  const percent = repairing && repairTotal > 0
    ? Math.max(0, Math.min(100, Math.round(repairCompleted / repairTotal * 100)))
    : totalBatches > 0 ? Math.max(0, Math.min(100, Math.round(completedBatches / totalBatches * 100))) : 0;
  const queued = progress?.status === 'queued' || !progress || progress.status === 'idle';
  const stage = deriveInitializationStage(progress, model.submitting, false);
  const lockedKinds = model.selectedSourceKinds.length ? model.selectedSourceKinds : model.attempts[0]?.selectedSourceKinds ?? [];
  const heading = needsRepair ? '部分记忆已可召回' : paused ? progress?.status === 'failed' ? '初始化未完成' : '初始化已暂停' : repairing ? '正在修复失败项' : queued ? '正在准备来源' : '正在提取记忆';
  const heroCopy = needsRepair
    ? '正常批次已经保存；未解决项将由 AI 自动复核，仍不合法的内容会被隔离。'
      : paused
        ? '已保留完成批次和整理进度，无需重复提取。'
        : repairing
          ? '仅发送安全校验位置和相关来源楼层，不会重发整个失败 JSON。'
        : '从所选来源中提取并整理可用记忆。';
  const pendingCount = Math.max(0, progress?.retryableRepairCount ?? progress?.pendingRepairCount ?? 0);
  const repairedCount = Math.max(0, progress?.repairedCount ?? 0);
  const degradedCount = Math.max(0, progress?.degradedCount ?? 0);
  const exhaustedCount = Math.max(0, progress?.exhaustedRepairCount ?? 0);
  const quarantinedCount = Math.max(0, progress?.quarantinedCount ?? progress?.unresolvedRejectionCount ?? progress?.reviewRequiredCount ?? 0);
  const ignoredCount = Math.max(0, progress?.ignoredCount ?? 0);
  const degradedNotice = degradedCount > 0
    ? `<div class="stx-memory-init-alert is-paused" role="status"><span><ss-helper-icon name="shield-halved" decorative></ss-helper-icon></span><div><strong>已安全降级 ${formatNumber(degradedCount)} 项</strong><p>仅省略了缺少来源支持的可选引用；没有猜测或改绑实体。</p></div></div>`
    : '';
  const repairSummary = needsRepair
    ? `<dl class="stx-memory-init-estimate"><div><dt>可继续处理</dt><dd>${formatNumber(pendingCount)}</dd></div><div><dt>已直接修复</dt><dd>${formatNumber(repairedCount)}</dd></div><div><dt>已安全降级</dt><dd>${formatNumber(degradedCount)}</dd></div><div><dt>已达上限</dt><dd>${formatNumber(exhaustedCount)}</dd></div><div><dt>已隔离</dt><dd>${formatNumber(quarantinedCount)}</dd></div><div><dt>已忽略</dt><dd>${formatNumber(ignoredCount)}</dd></div></dl>`
    : '';
  const progressBar = repairing || queued
    ? `<div class="stx-memory-init-progress-loop" role="progressbar" aria-label="${repairing ? '修复进行中' : '准备来源中'}" aria-valuetext="${repairing ? '正在修复格式失败项' : '正在准备来源'}"><span></span></div>`
    : `<progress ${uiControl('progress')} aria-label="初始化批次进度" max="100" value="${percent}">${percent}%</progress>`;
  const seconds = Math.max(0, Math.floor((progress?.elapsedMs ?? 0) / 1000));
  return `<div class="stx-memory-init-task-head"><div><h2>${heading}</h2><p>${heroCopy}</p></div><div class="stx-memory-init-percent"><strong>${queued || repairing ? '处理中' : `${percent}%`}</strong><small>${paused ? '断点已保留' : needsRepair ? `待修复 ${formatNumber(pendingCount)} 项` : `已完成批次 ${formatNumber(completedBatches)} / ${formatNumber(totalBatches)}`}</small></div></div>
    ${needsRepair ? `<div class="stx-memory-init-alert is-paused" role="status"><span><ss-helper-icon name="triangle-exclamation" decorative></ss-helper-icon></span><div><strong>部分可召回 · 仍有 ${formatNumber(pendingCount)} 项待修复</strong><p>合法记忆已持久化；继续处理不会重复扫描已经完成的批次。</p></div></div>` : paused ? '<div class="stx-memory-init-alert is-paused" role="status"><span><ss-helper-icon name="triangle-exclamation" decorative></ss-helper-icon></span><div><strong>初始化断点已保留</strong><p>继续后会从断点恢复，并沿用本次来源范围。</p></div></div>' : ''}
    ${degradedNotice}
    ${repairSummary}
    ${progressBar}
    ${repairing ? `<p class="stx-memory-init-config-note">已完成批次 ${completedBatches} / ${totalBatches} · ${batchScope}<br>修复任务 ${repairCompleted} / ${repairTotal} · ${Math.round((progress?.elapsedMs ?? 0) / 1000)} 秒</p>` : ''}
    <div class="stx-memory-init-task-summary"><span><small>已用时</small><strong>${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}</strong></span><span><small>${lockedKinds.length} 组来源</small><strong>${escapeHtml(sourceNames(model, lockedKinds).join('、') || '无')}</strong></span></div>
    ${incompleteBatch === undefined ? '' : `<p class="stx-memory-init-config-note">已完成批次 ${completedBatches} / ${totalBatches} · 第 ${incompleteBatch} 批未完成</p>`}
    ${progress?.failure ? (() => {
      const diagnostic = describeSSHelperFailure(progress.failure);
      const safeDetails = [
        diagnostic.batchIndex === undefined ? undefined : ['批次', String(diagnostic.batchIndex + 1)],
        diagnostic.collection ? ['集合', diagnostic.collection] : undefined,
        diagnostic.path ? ['字段', diagnostic.path] : undefined,
        diagnostic.keyword ? ['规则', diagnostic.keyword] : undefined,
        diagnostic.expected ? ['要求', diagnostic.expected] : undefined,
        diagnostic.requestId ? ['请求 ID', diagnostic.requestId] : undefined,
      ].filter((item): item is string[] => item !== undefined);
      return `<div class="stx-memory-init-alert is-danger stx-memory-init-failure" role="alert"><span><ss-helper-icon name="circle-xmark" decorative></ss-helper-icon></span><div class="stx-memory-init-error-copy"><div class="stx-memory-init-error-head"><strong>${escapeHtml(diagnostic.title)}</strong><code>${escapeHtml(diagnostic.reasonCode)}</code></div><div class="stx-memory-init-error-detail"><p>${escapeHtml(diagnostic.reason)} ${escapeHtml(diagnostic.action)}</p>${safeDetails.map(([label, value]) => `<small><span>${escapeHtml(label)}</span><code>${escapeHtml(value)}</code></small>`).join('')}</div></div></div>`;
    })() : ''}
    ${renderPipeline(stage, model)}
    <details class="stx-memory-init-details" data-init-details="usage"><summary>本次用量与详情</summary><div><p>${batchScope} · 已处理 ${formatNumber(progress?.processedCount ?? 0)} 项</p>${renderActualUsage(progress)}</div></details>`;
}

function renderCompleted(model: InitializationViewModel, partial = false): string {
  const successfulKinds = model.successfulSourceKinds.length ? model.successfulSourceKinds : model.selectedSourceKinds;
  const completedAttempt = model.attempts.find((attempt) => attempt.status === 'completed');
  const completedBatchScope = completedAttempt
    ? batchScopeLabel(completedAttempt.batchRangeStart, completedAttempt.batchRangeEnd, completedAttempt.availableBatchCount, completedAttempt.totalBatches)
    : `${formatNumber(model.estimate?.batchCount ?? 0)} 批`;
  const degradedCount = Math.max(0, model.progress?.degradedCount ?? 0);
  const quarantinedCount = Math.max(0, model.progress?.quarantinedCount ?? model.progress?.unresolvedRejectionCount ?? model.progress?.reviewRequiredCount ?? 0);
  const ignoredCount = Math.max(0, model.progress?.ignoredCount ?? 0);
  const completedAt = model.lastCompletedAt ?? (partial ? model.attempts[0]?.updatedAt : undefined);
  const completedTitle = '当前聊天已初始化';
  const completedCopy = `完成于 ${formatTime(completedAt)}，记忆召回已经可用。`;
  const completedStatus = partial ? '部分完成 · 召回可用' : '召回可用';
  return `<div class="stx-memory-init-success-hero"><span class="stx-memory-init-success-icon"><ss-helper-icon name="check" decorative></ss-helper-icon></span><div><h2>${completedTitle}</h2><p>${escapeHtml(completedCopy)}</p></div>${statusChip(completedStatus, 'success')}</div>
    <dl class="stx-memory-init-estimate is-completed"><div><dt>来源覆盖</dt><dd>${successfulKinds.length} / ${model.sources.length}</dd></div><div><dt>记忆事实</dt><dd>${formatNumber(model.factCount)}</dd></div><div><dt>占用空间</dt><dd>${escapeHtml(formatBytes(model.storageBytes))}</dd></div><div><dt>完成批次</dt><dd>${completedBatchScope}</dd></div></dl>
    ${partial || quarantinedCount > 0 || ignoredCount > 0 ? `<div class="stx-memory-init-alert is-paused" role="status"><span><ss-helper-icon name="shield-halved" decorative></ss-helper-icon></span><div><strong>未采纳项处理结果</strong><p>已隔离 ${formatNumber(quarantinedCount)} 项等待证据变化，已忽略 ${formatNumber(ignoredCount)} 项。以上仅统计未采纳项，不代表全部记忆；不会进入召回或 Prompt。</p></div></div>` : ''}
    ${degradedCount > 0 ? `<div class="stx-memory-init-alert is-paused" role="status"><span><ss-helper-icon name="shield-halved" decorative></ss-helper-icon></span><div><strong>已安全降级 ${formatNumber(degradedCount)} 项</strong><p>仅省略缺少来源支持的可选引用；核心记忆已通过完整校验，没有猜测或改绑实体。</p></div></div>` : ''}
    ${renderPipeline({ activeIndex: -1, allDone: true, halted: false }, model)}
    <details class="stx-memory-init-details" data-init-details="usage"><summary>本次用量与详情</summary><div>${renderActualUsage(model.progress)}<p>当前聊天可以使用记忆召回。</p></div></details>`;
}

function renderDrawer(model: InitializationViewModel): string {
  if (!model.reinitializeOpen) return '';
  const disabled = model.busy || !model.workspaceAvailable || !model.llmAvailable || model.selectedSourceKinds.length === 0
    || Boolean(model.progress && ['queued', 'running', 'repairing'].includes(model.progress.status));
  return `<div class="stx-memory-reinitialize-layer">
    <button class="stx-memory-drawer-backdrop" type="button" data-action="cancel-reinitialize" aria-label="关闭重新初始化确认"></button>
    <aside class="stx-memory-reinitialize-drawer" role="alertdialog" aria-modal="true" aria-labelledby="stx-memory-reinitialize-title" aria-describedby="stx-memory-reinitialize-description">
      <header><div><span class="stx-memory-kicker">危险操作确认</span><h3 id="stx-memory-reinitialize-title">重新初始化当前聊天</h3></div><button ${uiButton('neutral', 'sm', true)} type="button" data-action="cancel-reinitialize" aria-label="关闭"><ss-helper-icon name="xmark" decorative></ss-helper-icon></button></header>
      <div class="stx-memory-drawer-body">
        <div class="stx-memory-init-alert is-danger"><span><ss-helper-icon name="triangle-exclamation" decorative></ss-helper-icon></span><div><strong id="stx-memory-reinitialize-description">这会清空当前聊天的全部记忆派生数据</strong><p>清空后立即按下方来源重新开始初始化。如果新任务失败，旧数据无法恢复。</p></div></div>
        ${renderSection('选择重新整理的来源', '估算会随勾选结果实时更新。', renderSourceCards(model, model.selectedSourceKinds, false), statusChip(`${model.selectedSourceKinds.length} / ${model.sources.length}`))}
        ${renderSection('重新初始化估算', '范围按当前分批设置计算。', `${renderModeSummary(model)}${renderEstimate(model)}${renderBatchRange(model, agentModeBlocked(model))}`)}
        <section class="stx-memory-init-section"><div class="stx-memory-init-scope-grid"><div class="stx-memory-init-scope is-clear"><h3>将清理</h3><ul><li>事实、证据和角色记忆痕迹</li><li>即时场景、事件、观察和派生索引</li><li>当前聊天的捕获任务与审计记录</li></ul></div><div class="stx-memory-init-scope is-safe"><h3>不会影响</h3><ul><li>聊天原文与消息</li><li>角色卡、世界书和用户 Persona</li><li>其他聊天与工作区</li></ul></div></div></section>
      </div>
      <footer><button id="stx-memory-reinitialize-cancel" ${uiControl('button', 'neutral')} type="button" data-action="cancel-reinitialize">取消</button><button ${uiControl('button', 'danger')} type="button" data-action="confirm-reinitialize" ${disabled ? 'disabled' : ''}><ss-helper-icon name="trash-can-arrow-up" decorative></ss-helper-icon>清空并重新初始化</button></footer>
    </aside>
  </div>`;
}

export function renderInitializationView(model: InitializationViewModel): string {
  const pendingRepairCount = Math.max(0, model.progress?.retryableRepairCount ?? model.progress?.pendingRepairCount ?? 0);
  const legacyRepairTerminal = model.progress?.status === 'needs_repair' || model.progress?.status === 'needs_review'
    || (!model.initialized && (model.attempts[0]?.status === 'needs_repair' || model.attempts[0]?.status === 'needs_review'));
  const needsRepair = legacyRepairTerminal && pendingRepairCount > 0;
  const completedWithIsolation = legacyRepairTerminal && pendingRepairCount === 0;
  const completedRepair = model.progress?.status === 'completed' && model.progress.phase === 'repair';
  const completedPartial = model.progress?.status === 'completed' && model.progress.outcome === 'partial';
  const failedWithCheckpoint = !model.initialized && model.progress?.status === 'failed'
    && (model.progress.completedBatchCount ?? model.progress.batchIndex) > 0;
  const paused = failedWithCheckpoint || model.progress?.status === 'paused'
    || (!model.initialized && model.attempts[0]?.status === 'paused');
  const running = model.submitting || Boolean(model.progress && ['queued', 'running', 'repairing'].includes(model.progress.status));
  const primary = running ? renderProgress(model, false)
    : needsRepair ? renderProgress(model, false, true)
      : paused ? renderProgress(model, true)
      : completedWithIsolation ? renderCompleted(model, true)
      : completedRepair ? renderCompleted(model, completedPartial)
      : model.initialized ? renderCompleted(model, completedPartial)
        : renderSetup(model);
  const completed = !running && !needsRepair && !paused && (model.initialized || completedWithIsolation || completedRepair);
  const unavailable = model.busy || !model.chatBound || !model.llmAvailable || !model.workspaceAvailable || agentModeBlocked(model);
  const restart = `<button id="stx-memory-reinitialize-trigger" ${uiControl('button', 'neutral')} type="button" data-action="open-reinitialize" ${unavailable ? 'disabled' : ''}><ss-helper-icon name="rotate" decorative></ss-helper-icon>重新初始化</button>`;
  const actions = running
    ? `<button ${uiControl('button', 'primary')} type="button" disabled><ss-helper-icon name="spinner" decorative></ss-helper-icon>初始化中</button><button ${uiControl('button', 'neutral')} type="button" data-action="initialize-cancel">取消任务</button>`
    : needsRepair || paused
      ? `<button ${uiControl('button', 'primary')} type="button" data-action="initialize-resume" ${unavailable ? 'disabled' : ''}><ss-helper-icon name="play" decorative></ss-helper-icon>${needsRepair ? '继续处理' : '继续初始化'}</button>${restart}`
      : completed
        ? `<button ${uiControl('button', 'primary')} type="button" data-action="view-library"><ss-helper-icon name="book-open" decorative></ss-helper-icon>查看记忆库</button>${restart}`
        : `<button ${uiControl('button', 'primary')} type="button" data-action="initialize-start" ${unavailable || !model.selectedSourceKinds.length || selectedBatchRange(model).count === 0 ? 'disabled' : ''}><ss-helper-icon name="play" decorative></ss-helper-icon>开始初始化</button>`;
  return `<div class="stx-memory-initialize-shell" data-running="${running}" data-job-id="${escapeHtml(model.progress?.jobId ?? '')}">
    ${renderReadiness(model)}
    <div class="stx-memory-init-layout" data-init-scroll="layout">
      ${renderConfiguration(model, running || paused || needsRepair || completed, actions)}
      <section class="stx-memory-init-primary stx-memory-init-scroll" data-init-scroll="task" aria-label="当前任务与记录"><div class="stx-memory-init-current" aria-live="polite">${primary}</div>
        <div class="stx-memory-init-activity-area"><div class="stx-memory-init-panel-head"><h3>最近记录</h3><span>${model.attempts.length ? `${Math.min(model.attempts.length, 5)} 条` : ''}</span></div><div class="stx-memory-init-activity-list">${renderActivities(model)}</div></div>
      </section>
    </div>
    ${renderDrawer(model)}
  </div>`;
}
