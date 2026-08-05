import {
  UI_CONTROL_ATTRIBUTE,
  UI_CONTROL_SIZE_ATTRIBUTE,
  UI_CONTROL_TONE_ATTRIBUTE,
  describeSSHelperFailure,
  type UiControlKind,
  type UiControlSize,
  type UiControlTone,
} from '@ss-helper/sdk';
import type { MemoryCandidateRecord } from '../domain';
import type { MemoryCandidateSourcePreview, MemoryCandidateStats } from './memory-ui';

export interface MemoryCandidatesViewState {
  readonly candidates: readonly MemoryCandidateRecord[];
  readonly stats?: MemoryCandidateStats;
  readonly selectedId: string;
  readonly selectedSourceRef: string;
  readonly query: string;
  readonly batch: string;
  readonly collection: string;
  readonly status: string;
  readonly floor: string;
  readonly sourcePreview?: MemoryCandidateSourcePreview;
  readonly loading: boolean;
  readonly missingSnapshot: boolean;
  readonly chatBound?: boolean;
  readonly virtualized?: boolean;
}

const STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  accepted: '已写入',
  duplicate_noop: '去重忽略',
  pending_review: '待审核',
  rejected: '已拒绝',
  ignored: '已忽略',
  superseded_attempt: '被重跑替代',
});
const COLLECTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  actorCandidates: '人物',
  locationCandidates: '地点',
  itemCandidates: '物品',
  episodes: '叙事',
  claims: '事实主张',
  inventoryOperations: '库存操作',
});
const STATUS_ORDER = ['pending_review', 'accepted', 'duplicate_noop', 'rejected', 'ignored', 'superseded_attempt'];

function control(kind: UiControlKind, tone?: UiControlTone, size?: UiControlSize): string {
  return [`${UI_CONTROL_ATTRIBUTE}="${kind}"`, tone ? `${UI_CONTROL_TONE_ATTRIBUTE}="${tone}"` : '', size ? `${UI_CONTROL_SIZE_ATTRIBUTE}="${size}"` : ''].filter(Boolean).join(' ');
}
function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!);
}
function formatNumber(value: number): string { return new Intl.NumberFormat('zh-CN').format(value); }
function statusLabel(value: string): string { return STATUS_LABELS[value] ?? value; }
function collectionLabel(value: string): string { return COLLECTION_LABELS[value] ?? value; }
function candidateReasonCode(candidate: MemoryCandidateRecord): string | undefined { return candidate.reasonCode ?? candidate.failure?.reasonCode; }
function reasonLabel(value?: string): string {
  if (!value) return '尚未记录裁决原因';
  const diagnostic = describeSSHelperFailure({ reasonCode: value }, { reasonCode: 'INTERNAL_ERROR', stage: 'memory.ui.candidate' });
  return diagnostic.reasonCode === value ? `${diagnostic.title}：${diagnostic.reason}` : value;
}
function sourceLabel(candidate: MemoryCandidateRecord): string {
  const floors = candidate.evidence.map(span => span.floor).filter((value): value is number => Number.isInteger(value));
  return floors.length ? [...new Set(floors)].map(value => `第 ${value} 层`).join('、') : candidate.sourceRefs.length ? `${candidate.sourceRefs.length} 个来源` : '无来源';
}
function domId(value: string): string { return `stx-memory-candidate-option-${value.replace(/[^a-zA-Z0-9_-]/g, '-')}`; }
function renderStatus(status: string): string {
  const tone = status === 'accepted' ? 'success' : status === 'pending_review' ? 'warning' : status === 'rejected' || status === 'ignored' ? 'error' : 'neutral';
  return `<span ${control('status', tone)} class="stx-memory-candidate-status is-${tone}">${escapeHtml(statusLabel(status))}</span>`;
}
function renderHighlightedText(text: string, highlights: readonly { readonly start: number; readonly end: number; readonly text: string }[]): string {
  const sorted = [...highlights].filter(item => item.start >= 0 && item.end > item.start && item.end <= text.length).sort((left, right) => left.start - right.start);
  if (!sorted.length) return escapeHtml(text);
  let cursor = 0;
  let html = '';
  for (const span of sorted) {
    if (span.start < cursor) continue;
    html += escapeHtml(text.slice(cursor, span.start));
    html += `<mark class="stx-memory-candidate-evidence-mark">${escapeHtml(text.slice(span.start, span.end))}</mark>`;
    cursor = span.end;
  }
  return html + escapeHtml(text.slice(cursor));
}

function renderCandidateRow(candidate: MemoryCandidateRecord, selected: boolean): string {
  const reason = candidateReasonCode(candidate);
  const id = domId(candidate.id);
  return `<button ${control('button', 'neutral', 'md')} type="button" id="${id}" class="stx-memory-candidate-row${selected ? ' is-selected' : ''}" data-action="select-memory-candidate" data-candidate-id="${escapeHtml(candidate.id)}" role="option" aria-selected="${selected}" aria-describedby="${id}-summary ${id}-meta"><span class="stx-memory-candidate-row-top"><span class="stx-memory-candidate-kind">${escapeHtml(collectionLabel(candidate.collection))}</span>${renderStatus(candidate.status)}<small>${candidate.batchIndex === undefined ? '未分批' : `第 ${candidate.batchIndex + 1} 批`} · ${escapeHtml(candidate.stage)}</small></span><strong id="${id}-summary" class="stx-memory-candidate-summary">${escapeHtml(candidate.summary || candidate.candidateLocalId)}</strong><span id="${id}-meta" class="stx-memory-candidate-row-bottom"><span>${candidate.evidence.length ? `${candidate.evidence.length} 处证据 · ` : ''}${escapeHtml(sourceLabel(candidate))}</span><span class="stx-memory-candidate-reason" title="${escapeHtml(reasonLabel(reason))}">${escapeHtml(reason ? reasonLabel(reason) : '待裁决')}</span></span></button>`;
}

function renderStatusFilter(status: string, count: number, active: boolean): string {
  return `<button ${control('button', 'neutral', 'sm')} type="button" class="stx-memory-candidate-status-filter${active ? ' is-active' : ''}" data-action="filter-memory-candidates" data-status="${escapeHtml(status)}" aria-pressed="${active}"><span>${escapeHtml(status ? statusLabel(status) : '全部')}</span><strong>${formatNumber(count)}</strong></button>`;
}

function renderCandidateDetail(state: MemoryCandidatesViewState, selected: MemoryCandidateRecord | undefined): string {
  if (!selected) {
    const hasFilters = Boolean(state.query.trim() || state.batch || state.collection || state.status || state.floor);
    if (state.loading) return '<section class="stx-memory-candidate-detail stx-memory-candidate-empty"><div class="stx-memory-empty-icon" aria-hidden="true"><ss-helper-icon name="rotate" decorative></ss-helper-icon></div><h3>正在读取候选</h3><p>正在同步当前聊天的候选快照。</p></section>';
    if (state.chatBound === false) return '<section class="stx-memory-candidate-detail stx-memory-candidate-empty"><div class="stx-memory-empty-icon" aria-hidden="true"><ss-helper-icon name="comments" decorative></ss-helper-icon></div><span class="stx-memory-kicker">当前聊天</span><h3>尚未绑定聊天</h3><p>选择一个角色或打开聊天后，才能读取对应的候选快照与原文证据。</p></section>';
    if (state.missingSnapshot) return '<section class="stx-memory-candidate-detail stx-memory-candidate-empty is-warning"><div class="stx-memory-empty-icon" aria-hidden="true"><ss-helper-icon name="triangle-exclamation" decorative></ss-helper-icon></div><span class="stx-memory-kicker">旧任务</span><h3>没有可追溯快照</h3><p>这次初始化没有保存候选快照，无法回溯到原文。重新初始化后，新的候选会在这里按批次保留。</p><button data-ss-helper-control="button" data-ss-helper-tone="primary" data-ss-helper-size="sm" type="button" class="stx-memory-candidate-empty-action" data-action="navigate" data-page="initialize">前往初始化</button></section>';
    if (hasFilters) return '<section class="stx-memory-candidate-detail stx-memory-candidate-empty"><div class="stx-memory-empty-icon" aria-hidden="true"><ss-helper-icon name="magnifying-glass" decorative></ss-helper-icon></div><h3>没有匹配候选</h3><p>试试清除一个筛选条件，或扩大批次与楼层范围。</p><button data-ss-helper-control="button" data-ss-helper-tone="neutral" data-ss-helper-size="sm" type="button" class="stx-memory-candidate-empty-action" data-action="clear-candidate-filters">清除筛选</button></section>';
    return '<section class="stx-memory-candidate-detail stx-memory-candidate-empty"><div class="stx-memory-empty-icon" aria-hidden="true"><ss-helper-icon name="inbox" decorative></ss-helper-icon></div><h3>尚未产生候选</h3><p>完成一次初始化后，人物、事实、叙事和库存候选会按来源出现在这里。</p><button data-ss-helper-control="button" data-ss-helper-tone="primary" data-ss-helper-size="sm" type="button" class="stx-memory-candidate-empty-action" data-action="navigate" data-page="initialize">开始初始化</button></section>';
  }

  const selectedEvidence = selected.evidence ?? [];
  const selectedSource = selectedEvidence.find(span => span.sourceRef === state.selectedSourceRef) ?? selectedEvidence[0];
  const detailPreview = state.sourcePreview;
  const reason = candidateReasonCode(selected);
  const decision = selected.decision ? escapeHtml(selected.decision) : selected.status === 'accepted' ? '已通过本地校验并写入正式记忆' : '等待本地裁决结果';
  return `<section class="stx-memory-candidate-detail" aria-labelledby="stx-memory-candidate-detail-title"><div class="stx-memory-candidate-detail-head"><div><span class="stx-memory-kicker">候选检查器</span><h3 id="stx-memory-candidate-detail-title">${escapeHtml(selected.summary || selected.candidateLocalId)}</h3><p>${escapeHtml(collectionLabel(selected.collection))} · ${selected.batchIndex === undefined ? '未分批' : `第 ${selected.batchIndex + 1} 批`} · ${escapeHtml(selected.stage)}</p></div>${renderStatus(selected.status)}</div><div class="stx-memory-candidate-decision"><span class="stx-memory-candidate-decision-icon" aria-hidden="true"><ss-helper-icon name="${selected.status === 'accepted' ? 'circle-check' : selected.status === 'pending_review' ? 'clock' : 'minus'}" decorative></ss-helper-icon></span><div><strong>${decision}</strong><span>${escapeHtml(reasonLabel(reason))}</span></div></div><dl class="stx-memory-candidate-meta"><div><dt>候选类型</dt><dd>${escapeHtml(collectionLabel(selected.collection))}</dd></div><div><dt>证据片段</dt><dd>${formatNumber(selectedEvidence.length)} 处 · ${escapeHtml(sourceLabel(selected))}</dd></div><div><dt>阶段 / 尝试</dt><dd>${escapeHtml(selected.stage)} · 第 ${formatNumber(selected.attemptIndex + 1)} 次</dd></div><div><dt>候选 ID</dt><dd><code>${escapeHtml(selected.candidateLocalId)}</code></dd></div>${selected.rejectionId ? `<div><dt>拒绝记录</dt><dd><code>${escapeHtml(selected.rejectionId)}</code></dd></div>` : ''}${selected.reviewItemId ? `<div><dt>审核记录</dt><dd><code>${escapeHtml(selected.reviewItemId)}</code></dd></div>` : ''}<div><dt>正式记录</dt><dd>${selected.committedRecordRefs.length ? escapeHtml(selected.committedRecordRefs.join('、')) : '尚未写入'}</dd></div></dl><details class="stx-memory-candidate-collapsible"><summary>查看规范化候选</summary><pre>${escapeHtml(JSON.stringify(selected.normalizedCandidate, null, 2))}</pre></details><section class="stx-memory-candidate-evidence"><div class="stx-memory-candidate-section-heading"><div><span class="stx-memory-kicker">SOURCE TRACE</span><h4>来源证据</h4></div><span>${formatNumber(selectedEvidence.length)} 处</span></div>${selectedEvidence.length ? `<div class="stx-memory-candidate-source-tabs" ${control('segmented')} role="tablist" aria-label="候选来源">${selectedEvidence.map((span, index) => { const active = (index === 0 && !state.selectedSourceRef) || span.sourceRef === state.selectedSourceRef; return `<button ${control('button', 'neutral', 'xs')} type="button" class="${active ? 'is-selected' : ''}" data-action="select-memory-candidate-source" data-source-ref="${escapeHtml(span.sourceRef)}" role="tab" aria-selected="${active}" tabindex="${active ? '0' : '-1'}">${span.floor === undefined ? escapeHtml(span.sourceKind) : `第 ${span.floor} 层`}</button>`; }).join('')}</div><div class="stx-memory-candidate-source-preview">${detailPreview ? `<p class="stx-memory-candidate-source-note">${detailPreview.sourceChanged ? '来源已更新，已尝试唯一定位。' : '来源与保存时一致。'}${detailPreview.warning ? ` ${detailPreview.warning === 'ambiguous_match' ? '证据文本出现多处，未猜测高亮位置。' : detailPreview.warning === 'no_match' ? '未找到匹配文本，保留保存的证据片段。' : '来源已缺失，保留保存的证据片段。'}` : ''}${detailPreview.savedText ? ` 保存片段：${escapeHtml(detailPreview.savedText)}` : ''}</p><pre>${renderHighlightedText(detailPreview.text, detailPreview.highlights)}</pre>` : '<p class="stx-memory-muted">正在读取原文并定位证据…</p>'}${selectedSource ? `<div class="stx-memory-candidate-source-actions"><span>${selectedSource.floor === undefined ? escapeHtml(selectedSource.sourceKind) : `聊天消息 #${selectedSource.floor}`}</span><button ${control('button', 'neutral', 'sm')} type="button" data-action="jump-to-message" data-message-index="${selectedSource.floor === undefined ? '' : selectedSource.floor}" ${selectedSource.floor === undefined ? 'disabled' : ''}>跳转到聊天消息${selectedSource.floor === undefined ? '' : ` #${selectedSource.floor}`}</button></div>` : ''}</div>` : '<p class="stx-memory-muted">该候选没有可用证据片段。</p>'}</section><details class="stx-memory-candidate-collapsible stx-memory-candidate-technical"><summary>技术定位</summary><dl class="stx-memory-candidate-meta"><div><dt>流水线</dt><dd><code>${escapeHtml(selected.pipelineRunId)}</code></dd></div><div><dt>阶段尝试</dt><dd><code>${escapeHtml(selected.stageAttemptId)}</code></dd></div><div><dt>创建时间</dt><dd>${new Date(selected.createdAt).toLocaleString('zh-CN')}</dd></div></dl></details></section>`;
}

export function renderMemoryCandidatesView(state: MemoryCandidatesViewState): string {
  const candidates = state.candidates;
  const selected = candidates.find(candidate => candidate.id === state.selectedId);
  const stats = state.stats;
  const total = stats?.total ?? candidates.length;
  const accepted = stats?.accepted ?? candidates.filter(item => item.status === 'accepted').length;
  const notWritten = stats?.notWritten ?? Math.max(0, total - accepted);
  const batchCount = stats?.batchCount ?? new Set(candidates.map(item => item.batchIndex).filter((value): value is number => Number.isInteger(value))).size;
  const countForStatus = (status: string): number => stats?.byStatus?.[status] ?? candidates.filter(item => item.status === status).length;
  const activeFilters = Boolean(state.query.trim() || state.batch || state.collection || state.status || state.floor);
  const progress = total > 0 ? Math.min(100, Math.round((accepted / total) * 100)) : 0;
  const collectionOptions = [...new Set(candidates.map(candidate => candidate.collection))];
  const statusOptions = [...new Set(candidates.map(candidate => candidate.status))];
  const batchOptions = [...new Set(candidates.map(candidate => candidate.batchIndex).filter((value): value is number => Number.isInteger(value)))].sort((left, right) => left - right);
  const jobLabel = stats?.jobId ? `<code title="${escapeHtml(stats.jobId)}">${escapeHtml(stats.jobId)}</code>` : '<span>尚未运行</span>';
  const listEmpty = state.chatBound === false ? '请先选择聊天后读取候选' : state.missingSnapshot ? '当前任务没有候选快照' : activeFilters ? '没有符合当前条件的候选' : '暂无候选';
  return `<div class="stx-memory-candidates-page"><header class="stx-memory-candidate-hero"><div class="stx-memory-candidate-hero-copy"><span class="stx-memory-kicker">MEMORY TRACE / CANDIDATE QUEUE</span><h3>候选检查</h3><p>从模型输出回到聊天原文，确认每一条候选为什么被写入、跳过或拒绝。</p></div><div class="stx-memory-candidate-hero-context"><span>当前初始化任务</span><strong>${jobLabel}</strong><small>${formatNumber(batchCount)} 批 · ${formatNumber(total)} 条候选</small></div></header><section class="stx-memory-candidate-overview" aria-label="候选处理概览"><div class="stx-memory-candidate-progress"><div class="stx-memory-candidate-progress-copy"><div><span class="stx-memory-kicker">写入进度</span><strong>${formatNumber(accepted)} <small>/ ${formatNumber(total)}</small></strong></div><span>${progress}% 已进入正式记忆</span></div><div class="stx-memory-candidate-progress-track" ${control('progress')} role="progressbar" aria-label="候选写入进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><span style="width:${progress}%"></span></div></div><div class="stx-memory-candidate-overview-item"><span>未写入</span><strong>${formatNumber(notWritten)}</strong><small>待审、去重或拒绝</small></div><div class="stx-memory-candidate-overview-item"><span>来源批次</span><strong>${formatNumber(batchCount)}</strong><small>按原始提取顺序</small></div></section><section class="stx-memory-candidate-status-rail" aria-label="按处理状态筛选"><div class="stx-memory-candidate-status-rail-heading"><div><span class="stx-memory-kicker">处理状态</span><strong>先看需要处理的候选</strong></div><span>${activeFilters ? '筛选已启用' : '全部候选'}</span></div><div class="stx-memory-candidate-status-filters" ${control('segmented')} role="group" aria-label="候选处理状态">${renderStatusFilter('', total, !state.status)}${STATUS_ORDER.map(status => renderStatusFilter(status, countForStatus(status), state.status === status)).join('')}</div></section><section class="stx-memory-candidates-toolbar" aria-label="候选筛选"><label class="stx-memory-candidate-search"><span>搜索候选</span><input ${control('input')} type="search" data-candidate-filter="query" value="${escapeHtml(state.query)}" placeholder="摘要、候选 ID 或裁决原因"></label><div class="stx-memory-candidate-selects"><label><span>批次</span><select ${control('select')} data-candidate-filter="batch"><option value="">全部批次</option>${batchOptions.map(value => `<option value="${value}" ${state.batch === String(value) ? 'selected' : ''}>第 ${value + 1} 批</option>`).join('')}</select></label><label><span>类型</span><select ${control('select')} data-candidate-filter="collection"><option value="">全部类型</option>${collectionOptions.map(value => `<option value="${escapeHtml(value)}" ${state.collection === value ? 'selected' : ''}>${escapeHtml(collectionLabel(value))}</option>`).join('')}</select></label><label><span>状态</span><select ${control('select')} data-candidate-filter="status"><option value="">全部状态</option>${statusOptions.map(value => `<option value="${escapeHtml(value)}" ${state.status === value ? 'selected' : ''}>${escapeHtml(statusLabel(value))}</option>`).join('')}</select></label><label><span>楼层</span><input ${control('input')} type="number" min="0" data-candidate-filter="floor" value="${escapeHtml(state.floor)}" placeholder="全部"></label></div><div class="stx-memory-candidate-toolbar-foot"><span>${activeFilters ? `已筛选 ${formatNumber(candidates.length)} 条` : `共 ${formatNumber(total)} 条候选`}</span>${activeFilters ? '<button data-ss-helper-control="button" data-ss-helper-tone="neutral" data-ss-helper-size="xs" type="button" class="stx-memory-candidate-clear" data-action="clear-candidate-filters">清除筛选</button>' : '<span>按批次、阶段和尝试顺序排列</span>'}</div></section><section class="stx-memory-candidates-split"><section class="stx-memory-candidates-list" aria-label="候选队列" role="region"><div class="stx-memory-candidates-list-head"><div><span class="stx-memory-kicker">QUEUE</span><strong>提取候选</strong></div><span>${formatNumber(candidates.length)} 条${activeFilters ? '匹配' : ''}</span></div><div class="stx-memory-candidates-list-hint">选择一条候选，右侧会显示裁决链和原文证据。</div><div data-memory-candidates-list="true" role="listbox" aria-label="记忆候选列表" aria-activedescendant="${selected ? domId(selected.id) : ''}">${state.loading ? '<div class="stx-memory-loading">正在读取候选…</div>' : state.virtualized && state.chatBound !== false ? '' : candidates.length ? candidates.map(candidate => renderCandidateRow(candidate, candidate.id === state.selectedId)).join('') : `<div class="stx-memory-empty">${listEmpty}</div>`}</div></section>${renderCandidateDetail(state, selected)}</section></div>`;
}

export { COLLECTION_LABELS, STATUS_LABELS, renderCandidateRow };
