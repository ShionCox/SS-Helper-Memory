import {
  UI_CONTROL_ATTRIBUTE,
  UI_CONTROL_ICON_ONLY_ATTRIBUTE,
  UI_CONTROL_SIZE_ATTRIBUTE,
  UI_CONTROL_TONE_ATTRIBUTE,
  type UiControlKind,
  type UiControlSize,
  type UiControlTone,
} from '@ss-helper/sdk';

export type InitializationProgressStatus = 'idle' | 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

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
  tokenLow: number;
  tokenHigh: number;
}

export interface InitializationViewProgress {
  status: InitializationProgressStatus;
  jobId?: string;
  batchIndex: number;
  totalBatches: number;
  processedCount: number;
  elapsedMs: number;
  error?: string;
}

export interface InitializationViewAttempt {
  jobId: string;
  status: InitializationProgressStatus;
  updatedAt: number;
  totalBatches: number;
  selectedSourceKinds: readonly string[];
  includeInvisibleHistory?: boolean;
  error?: string;
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
  includeInvisibleHistory: boolean;
  estimate?: InitializationViewEstimate;
  progress?: InitializationViewProgress;
  initialized: boolean;
  lastCompletedAt: number | null;
  successfulSourceKinds: readonly string[];
  attempts: readonly InitializationViewAttempt[];
  factCount: number;
  storageBytes: number;
  summaryNote: string;
  submitting: boolean;
  busy: boolean;
  reinitializeOpen: boolean;
}

export interface InitializationStage {
  activeIndex: number;
  allDone: boolean;
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

function safeCode(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  return value.match(/\b[A-Z][A-Z0-9_]{2,63}\b/u)?.[0]
    ?? (value.match(/\b([45]\d\d)\b/u)?.[1] ? `HTTP ${value.match(/\b([45]\d\d)\b/u)![1]}` : fallback);
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
  if (initialized) return { activeIndex: -1, allDone: true };
  if (progress?.status === 'running' || progress?.status === 'paused') {
    if (progress.totalBatches > 0 && progress.batchIndex >= progress.totalBatches) return { activeIndex: 2, allDone: false };
    return { activeIndex: progress.batchIndex > 0 ? 1 : 0, allDone: false };
  }
  if (progress?.status === 'completed') return { activeIndex: 3, allDone: false };
  if (submitting || progress?.status === 'queued') return { activeIndex: 0, allDone: false };
  return { activeIndex: -1, allDone: false };
}

function renderPipeline(stage: InitializationStage): string {
  const steps = [
    ['读取与清洗', '读取选中来源，过滤工具输出和空控制块', 'filter'],
    ['分批结构化捕获', '提取人物、事件、观察和事实', 'wand-magic-sparkles'],
    ['事务写入', '事实、证据和角色痕迹同批提交', 'database'],
    ['完成可召回', '更新当前聊天状态并开放记忆召回', 'circle-nodes'],
  ] as const;
  return `<div class="stx-memory-init-pipeline">${steps.map(([title, detail, icon], index) => {
    const done = stage.allDone || (stage.activeIndex >= 0 && index < stage.activeIndex);
    const active = !stage.allDone && index === stage.activeIndex;
    return `<article class="stx-memory-init-pipeline-step${done ? ' is-done' : ''}${active ? ' is-active' : ''}"><span class="stx-memory-init-step-icon"><ss-helper-icon name="${done ? 'check' : icon}" decorative></ss-helper-icon></span><span><strong>${title}</strong><small>${detail}</small></span></article>`;
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
    return `<label class="stx-memory-init-source-card${checked ? ' is-selected' : ''}${disabled ? ' is-disabled' : ''}">
      <span class="stx-memory-init-source-icon"><ss-helper-icon name="${sourceIcon(source.kind)}" decorative></ss-helper-icon></span>
      <span class="stx-memory-init-source-copy"><strong>${escapeHtml(source.label)}</strong><small>${escapeHtml(sourceDetail(source))}${excluded ? ` · 当前排除 ${formatNumber(excluded)} 项` : ''}</small></span>
      <span class="stx-memory-init-source-count"><b>${formatNumber(source.count)} / ${formatNumber(source.rawCount)}</b><small>项</small></span>
      <input class="stx-memory-sr-only" ${uiControl('checkbox')} type="checkbox" data-source-kind="${escapeHtml(source.kind)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
    </label>`;
  }).join('')}</div>`;
}

function renderInvisibleHistory(model: InitializationViewModel, locked: boolean): string {
  const message = model.sources.find((source) => source.kind === 'message');
  const invisibleCount = message?.invisibleCount ?? Math.max(0, (message?.rawCount ?? 0) - (message?.defaultCount ?? 0));
  if (!message || invisibleCount <= 0) return '<p class="stx-memory-init-muted">当前消息来源没有额外的 AI 不可见历史正文。</p>';
  return `<label class="stx-memory-init-invisible${locked ? ' is-disabled' : ''}">
    <input ${uiControl('checkbox')} type="checkbox" data-option="include-invisible-history" ${model.includeInvisibleHistory ? 'checked' : ''} ${locked ? 'disabled' : ''}>
    <span><strong>包含 AI 不可见历史正文（本次）</strong><small>${model.includeInvisibleHistory ? '已纳入被酒馆标记为不可见的历史正文；工具输出、隐藏推理和空控制块仍然排除。' : '默认只处理 AI 可见的用户与助手消息。该选项只对本次初始化生效。'}</small></span>
    <span class="stx-memory-init-invisible-count">${formatNumber(message.count)} / ${formatNumber(message.rawCount)} 条</span>
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

function renderEstimate(model: InitializationViewModel, kinds: readonly string[] = model.selectedSourceKinds): string {
  const estimate = model.estimate;
  return `<dl class="stx-memory-init-estimate">
    <div><dt>来源项目</dt><dd>${formatNumber(totalSelectedItems(model, kinds))}</dd></div>
    <div><dt>预计批次</dt><dd>${formatNumber(estimate?.batchCount ?? 0)}</dd></div>
    <div><dt>Token 下限</dt><dd>${formatNumber(estimate?.tokenLow ?? 0)}</dd></div>
    <div><dt>Token 上限</dt><dd>${formatNumber(estimate?.tokenHigh ?? 0)}</dd></div>
  </dl>`;
}

function renderSection(title: string, description: string, content: string, badge = ''): string {
  return `<section class="stx-memory-init-section"><div class="stx-memory-init-section-title"><div><h3>${title}</h3><p>${description}</p></div>${badge}</div>${content}</section>`;
}

function renderActivities(model: InitializationViewModel): string {
  const items = model.attempts.slice(0, 5);
  if (!items.length) {
    return '<div class="stx-memory-init-empty is-activity"><ss-helper-icon name="clock-rotate-left" decorative></ss-helper-icon><strong>暂无初始化记录</strong><p>完成初始化后会在这里保留最近 5 次活动。</p></div>';
  }
  return items.map((attempt) => {
    const tone = attempt.status === 'completed' ? 'success' : attempt.status === 'failed' ? 'error' : attempt.status === 'queued' || attempt.status === 'running' || attempt.status === 'paused' ? 'warning' : 'neutral';
    const icon = attempt.status === 'completed' ? 'circle-check' : attempt.status === 'failed' ? 'circle-xmark' : attempt.status === 'paused' ? 'circle-pause' : attempt.status === 'cancelled' ? 'ban' : 'clock';
    return `<article class="stx-memory-init-activity is-${attempt.status}">
      <span class="stx-memory-init-activity-icon"><ss-helper-icon name="${icon}" decorative></ss-helper-icon></span>
      <div><div class="stx-memory-init-activity-head"><strong>${recordStatusLabel(attempt.status)}</strong><time datetime="${new Date(attempt.updatedAt).toISOString()}">${escapeHtml(formatTime(attempt.updatedAt))}</time></div>
      <p>${formatNumber(attempt.totalBatches)} 批 · ${escapeHtml(sourceNames(model, attempt.selectedSourceKinds).join('、') || '全部可用来源')} · ${attempt.includeInvisibleHistory ? '含不可见历史正文' : '仅 AI 可见消息'}</p>
      ${attempt.error ? `<small title="${escapeHtml(attempt.error)}">${escapeHtml(safeCode(attempt.error, 'MEMORY_CAPTURE_FAILED'))}</small>` : ''}</div>
    </article>`;
  }).join('');
}

function renderReadiness(model: InitializationViewModel): string {
  const selectedItems = totalSelectedItems(model);
  const selectedCount = model.selectedSourceKinds.length;
  const workspaceTone = model.workspaceAvailable ? 'success' : 'error';
  const llmTone = model.llmAvailable ? 'success' : 'error';
  return `<section class="stx-memory-init-readiness" aria-label="初始化准备状态">
    <div class="stx-memory-init-ready-item"><span class="stx-memory-init-ready-icon is-${model.chatBound ? 'success' : 'warning'}"><ss-helper-icon name="comments" decorative></ss-helper-icon></span><span><strong>${model.chatBound ? '当前聊天已绑定' : '尚未进入聊天'}</strong><small>${escapeHtml(model.chatLabel)} · ${model.chatBound ? '可读取来源' : '等待选择聊天'}</small></span></div>
    <div class="stx-memory-init-ready-item"><span class="stx-memory-init-ready-icon is-${workspaceTone}"><ss-helper-icon name="${model.workspaceAvailable ? 'database' : 'triangle-exclamation'}" decorative></ss-helper-icon></span><span><strong>记忆工作区${model.workspaceAvailable ? '可用' : '不可用'}</strong><small>${escapeHtml(model.workspaceAvailable ? '可安全写入当前聊天' : model.workspaceReason ?? '请先恢复工作区连接')}</small></span></div>
    <div class="stx-memory-init-ready-item"><span class="stx-memory-init-ready-icon is-${llmTone}"><ss-helper-icon name="${model.llmAvailable ? 'sparkles' : 'triangle-exclamation'}" decorative></ss-helper-icon></span><span><strong>大语言模型${model.llmAvailable ? '可用' : '不可用'}</strong><small>${escapeHtml(model.llmAvailable ? '可执行结构化捕获' : model.llmReason ?? '初始化操作已禁用')}</small></span></div>
    <div class="stx-memory-init-ready-item"><span class="stx-memory-init-ready-icon is-warning"><ss-helper-icon name="layer-group" decorative></ss-helper-icon></span><span><strong>${formatNumber(model.sources.length)} 组来源</strong><small>${formatNumber(selectedCount)} 组已选择 · ${formatNumber(selectedItems)} 项</small></span></div>
  </section>`;
}

function renderActionBar(summary: string, detail: string, actions: string): string {
  return `<div class="stx-memory-init-action-bar"><div class="stx-memory-init-action-summary"><strong>${escapeHtml(summary)}</strong><small>${escapeHtml(detail)}</small></div><div class="stx-memory-init-actions">${actions}</div></div>`;
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
  const selectedNames = sourceNames(model, model.selectedSourceKinds);
  const startDisabled = unavailable || !model.selectedSourceKinds.length || model.busy;
  return `<div class="stx-memory-init-panel-head"><div><span class="stx-memory-kicker">${failed ? '需要重试' : cancelled ? '任务已取消' : '首次使用'}</span><h2>${failed ? '当前未初始化' : '初始化当前聊天'}</h2><p>选择用于建立记忆的来源。系统只读取内容，不会改写聊天原文、角色卡或世界书。</p></div>${statusChip(unavailable ? '暂不可用' : `${formatNumber(model.estimate?.messageCount ?? 0)} 条消息`, unavailable ? 'error' : 'neutral')}</div>
    ${unavailable ? renderUnavailable(model) : failed ? '<div class="stx-memory-init-alert is-danger" role="alert"><span><ss-helper-icon name="circle-xmark" decorative></ss-helper-icon></span><div><strong>上一次初始化未完成</strong><p>请选择来源后重新尝试；活动记录会保留安全错误码。</p></div></div>' : ''}
    ${renderSection('选择记忆来源', '世界书按书名分组；没有内容的来源会自动禁用。', renderSourceCards(model, model.selectedSourceKinds, unavailable), statusChip(`${model.selectedSourceKinds.length} / ${model.sources.length}`))}
    ${renderSection('消息可见范围', '不可见历史只影响聊天消息，不会改变其他来源。', renderInvisibleHistory(model, unavailable))}
    ${renderSection('成本与分批估算', '估算会随来源和消息可见范围实时更新。', `${renderEstimate(model)}<p class="stx-memory-init-estimate-note">${escapeHtml(model.summaryNote)} 实际批次会随清洗和长消息拆分变化。</p>`)}
    ${renderSection('初始化流程', '结构化结果在同一事务中提交，避免出现只有一半记忆写入的状态。', renderPipeline({ activeIndex: -1, allDone: false }))}
    ${renderActionBar(`${model.selectedSourceKinds.length} 组来源 · ${totalSelectedItems(model)} 项`, selectedNames.join('、') || '尚未选择来源', `<button ${uiControl('button', 'primary')} type="button" data-action="initialize-start" ${startDisabled ? 'disabled' : ''}><ss-helper-icon name="play" decorative></ss-helper-icon>${failed ? '重新尝试初始化' : '开始初始化'}</button>`)}`;
}

function renderProgress(model: InitializationViewModel, paused: boolean): string {
  const progress = model.progress;
  const totalBatches = Math.max(0, progress?.totalBatches ?? model.estimate?.batchCount ?? 0);
  const batchIndex = Math.max(0, progress?.batchIndex ?? 0);
  const percent = totalBatches > 0 ? Math.max(0, Math.min(100, Math.round(batchIndex / totalBatches * 100))) : model.submitting ? 4 : 0;
  const queued = progress?.status === 'queued' || !progress || progress.status === 'idle';
  const stage = deriveInitializationStage(progress, model.submitting, false);
  const lockedKinds = model.selectedSourceKinds.length ? model.selectedSourceKinds : model.attempts[0]?.selectedSourceKinds ?? [];
  const heading = paused ? '初始化已暂停' : queued ? '正在提交模型请求' : '正在提取并写入结构化记忆';
  return `<div class="stx-memory-init-progress-hero"><span class="stx-memory-init-progress-icon is-${paused ? 'paused' : 'running'}"><ss-helper-icon name="${paused ? 'pause' : 'wand-magic-sparkles'}" decorative></ss-helper-icon></span><div><span class="stx-memory-kicker">${paused ? '可继续' : '正在捕获记忆'}</span><h2>${heading}</h2><p>${paused ? '已保留完成批次和整理进度，无需重复提取。' : '人物、事件、观察、事实和主体痕迹会在同一事务中提交。'}</p></div>${statusChip(paused ? '断点已保留' : '任务进行中', paused ? 'warning' : 'neutral')}</div>
    ${paused ? '<div class="stx-memory-init-alert" role="status"><span><ss-helper-icon name="triangle-exclamation" decorative></ss-helper-icon></span><div><strong>任务因可重试错误暂停</strong><p>继续后会从断点恢复，并沿用本次来源与不可见历史设置。</p></div></div>' : ''}
    <div class="stx-memory-init-progress-copy"><span>当前批次 ${formatNumber(batchIndex)} / ${formatNumber(totalBatches)}</span><span>${formatNumber(progress?.processedCount ?? 0)} 项 · ${Math.round((progress?.elapsedMs ?? 0) / 1000)} 秒</span></div>
    <progress ${uiControl('progress')} max="100" value="${percent}">${percent}%</progress>
    ${progress?.error ? `<p class="stx-memory-init-error-code" role="alert">错误码：${escapeHtml(safeCode(progress.error, 'MEMORY_CAPTURE_FAILED'))}</p>` : ''}
    <div class="stx-memory-init-locked"><span>已锁定来源</span><strong>${escapeHtml(sourceNames(model, lockedKinds).join('、') || '无')}</strong></div>
    ${renderSection('处理阶段', '当前阶段会随批次进度更新。', renderPipeline(stage), statusChip(`${percent}%`))}
    ${renderSection('本次任务估算', '来源在任务开始后锁定。', renderEstimate(model, lockedKinds))}
    ${renderActionBar(paused ? '可以安全继续' : '正在后台处理当前聊天', paused ? '继续后从现有断点恢复' : '关闭页面不会改变聊天原文', paused
      ? `<button ${uiControl('button', 'primary')} type="button" data-action="initialize-resume" ${model.busy || !model.llmAvailable || !model.workspaceAvailable ? 'disabled' : ''}><ss-helper-icon name="play" decorative></ss-helper-icon>继续初始化</button>`
      : `<button ${uiControl('button', 'danger')} type="button" data-action="initialize-cancel" ${model.busy ? 'disabled' : ''}><ss-helper-icon name="stop" decorative></ss-helper-icon>取消任务</button>`)}`;
}

function renderCompleted(model: InitializationViewModel): string {
  const successfulKinds = model.successfulSourceKinds.length ? model.successfulSourceKinds : model.selectedSourceKinds;
  const completedAttempt = model.attempts.find((attempt) => attempt.status === 'completed');
  return `<div class="stx-memory-init-success-hero"><span class="stx-memory-init-success-icon"><ss-helper-icon name="check" decorative></ss-helper-icon></span><div><span class="stx-memory-kicker">初始化状态</span><h2>当前聊天已初始化</h2><p>完成于 ${escapeHtml(formatTime(model.lastCompletedAt))}，记忆召回已经可用。</p></div>${statusChip('召回可用', 'success')}</div>
    <dl class="stx-memory-init-estimate is-completed"><div><dt>来源覆盖</dt><dd>${successfulKinds.length} / ${model.sources.length}</dd></div><div><dt>记忆事实</dt><dd>${formatNumber(model.factCount)}</dd></div><div><dt>占用空间</dt><dd>${escapeHtml(formatBytes(model.storageBytes))}</dd></div><div><dt>完成批次</dt><dd>${formatNumber(completedAttempt?.totalBatches ?? model.estimate?.batchCount ?? 0)}</dd></div></dl>
    <div class="stx-memory-init-success-note"><ss-helper-icon name="circle-check" decorative></ss-helper-icon><span>最近失败的初始化任务只会保留在右侧活动记录，不会覆盖这次有效初始化。</span></div>
    ${renderSection('已完成的处理流程', '当前聊天已经具备结构化记忆和角色知情边界。', renderPipeline({ activeIndex: -1, allDone: true }))}
    ${renderSection('已使用来源', '重新初始化时会优先恢复这次成功使用的来源范围。', renderSourceCards(model, successfulKinds, true, true), statusChip(`${successfulKinds.length} 组`, 'success'))}
    ${renderActionBar('当前聊天可以使用记忆召回', '人物、场景、事件、观察和事实已经写入工作区', `<button ${uiControl('button', 'primary')} type="button" data-action="view-library"><ss-helper-icon name="book-open" decorative></ss-helper-icon>查看记忆库</button><button id="stx-memory-reinitialize-trigger" ${uiControl('button', 'neutral')} type="button" data-action="open-reinitialize" ${model.busy || !model.llmAvailable || !model.workspaceAvailable ? 'disabled' : ''}><ss-helper-icon name="rotate" decorative></ss-helper-icon>重新初始化</button>`)}`;
}

function renderDrawer(model: InitializationViewModel): string {
  if (!model.reinitializeOpen) return '';
  const disabled = model.busy || !model.workspaceAvailable || !model.llmAvailable || model.selectedSourceKinds.length === 0
    || Boolean(model.progress && ['queued', 'running', 'paused'].includes(model.progress.status));
  return `<div class="stx-memory-reinitialize-layer">
    <button class="stx-memory-drawer-backdrop" type="button" data-action="cancel-reinitialize" aria-label="关闭重新初始化确认"></button>
    <aside class="stx-memory-reinitialize-drawer" role="alertdialog" aria-modal="true" aria-labelledby="stx-memory-reinitialize-title" aria-describedby="stx-memory-reinitialize-description">
      <header><div><span class="stx-memory-kicker">危险操作确认</span><h3 id="stx-memory-reinitialize-title">重新初始化当前聊天</h3></div><button ${uiButton('neutral', 'sm', true)} type="button" data-action="cancel-reinitialize" aria-label="关闭"><ss-helper-icon name="xmark" decorative></ss-helper-icon></button></header>
      <div class="stx-memory-drawer-body">
        <div class="stx-memory-init-alert is-danger"><span><ss-helper-icon name="triangle-exclamation" decorative></ss-helper-icon></span><div><strong id="stx-memory-reinitialize-description">这会清空当前聊天的全部记忆派生数据</strong><p>清空后立即按下方来源重新开始初始化。如果新任务失败，旧数据无法恢复。</p></div></div>
        ${renderSection('选择重新整理的来源', '估算会随勾选结果实时更新。', renderSourceCards(model, model.selectedSourceKinds, false), statusChip(`${model.selectedSourceKinds.length} / ${model.sources.length}`))}
        ${renderSection('消息可见范围', '不可见历史只影响聊天消息，不会改变其他来源。', renderInvisibleHistory(model, false))}
        ${renderSection('重新初始化估算', '实际批次仍会随清洗和长消息拆分变化。', renderEstimate(model))}
        <section class="stx-memory-init-section"><div class="stx-memory-init-scope-grid"><div class="stx-memory-init-scope is-clear"><h3>将清理</h3><ul><li>事实、证据和角色记忆痕迹</li><li>即时场景、事件、观察和派生索引</li><li>当前聊天的捕获任务与审计记录</li></ul></div><div class="stx-memory-init-scope is-safe"><h3>不会影响</h3><ul><li>聊天原文与消息</li><li>角色卡、世界书和用户 Persona</li><li>其他聊天与工作区</li></ul></div></div></section>
      </div>
      <footer><button id="stx-memory-reinitialize-cancel" ${uiControl('button', 'neutral')} type="button" data-action="cancel-reinitialize">取消</button><button ${uiControl('button', 'danger')} type="button" data-action="confirm-reinitialize" ${disabled ? 'disabled' : ''}><ss-helper-icon name="trash-can-arrow-up" decorative></ss-helper-icon>清空并重新初始化</button></footer>
    </aside>
  </div>`;
}

export function renderInitializationView(model: InitializationViewModel): string {
  const paused = model.progress?.status === 'paused' || (!model.initialized && model.attempts[0]?.status === 'paused');
  const running = model.submitting || Boolean(model.progress && ['queued', 'running'].includes(model.progress.status));
  const primary = running ? renderProgress(model, false)
    : paused ? renderProgress(model, true)
      : model.initialized ? renderCompleted(model)
        : renderSetup(model);
  return `<div class="stx-memory-initialize-shell">
    ${renderReadiness(model)}
    <div class="stx-memory-init-layout">
      <section class="stx-memory-init-panel stx-memory-init-primary" aria-live="polite">${primary}</section>
      <aside class="stx-memory-init-panel stx-memory-init-aside">
        <div class="stx-memory-init-activity-area"><div class="stx-memory-init-panel-head"><div><span class="stx-memory-kicker">最近活动</span><h3>初始化记录</h3><p>最多保留最近 5 次初始化任务。</p></div>${statusChip(`${Math.min(model.attempts.length, 5)} / 5`)}</div><div class="stx-memory-init-activity-list">${renderActivities(model)}</div></div>
        <section class="stx-memory-init-safety"><h3><ss-helper-icon name="shield-halved" decorative></ss-helper-icon>初始化不会改写</h3><ul><li>聊天原文与消息</li><li>角色卡与用户 Persona</li><li>世界书及其他聊天</li></ul></section>
      </aside>
    </div>
    ${renderDrawer(model)}
  </div>`;
}
