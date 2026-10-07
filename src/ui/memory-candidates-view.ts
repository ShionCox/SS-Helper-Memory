import {
  UI_CONTROL_ATTRIBUTE, UI_CONTROL_SIZE_ATTRIBUTE, UI_CONTROL_TONE_ATTRIBUTE,
  describeSSHelperFailure, type UiControlKind, type UiControlSize, type UiControlTone, type SSHelperDiagnostic,
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
  readonly sourceError?: SSHelperDiagnostic;
  readonly loading: boolean;
  readonly missingSnapshot: boolean;
  readonly chatBound?: boolean;
  readonly virtualized?: boolean;
}

const STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  accepted: '已写入', duplicate_noop: '去重忽略', pending_review: '待审核',
  rejected: '已拒绝', ignored: '已忽略', superseded_attempt: '被重跑替代',
});
const COLLECTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  actorCandidates: '人物', locationCandidates: '地点', itemCandidates: '物品',
  episodes: '叙事', claims: '事实主张', inventoryOperations: '库存操作',
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
function sourceKindLabel(value: string): string {
  return ({ message: '聊天', state: '聊天状态', host_card: '角色卡', persona: '用户设定', worldbook: '世界书', manual: '手工记录' } as Record<string, string>)[value] ?? '来源';
}
function candidateReasonCode(candidate: MemoryCandidateRecord): string | undefined { return candidate.reasonCode ?? candidate.failure?.reasonCode; }
function reasonLabel(value?: string): string {
  if (!value) return '未记录详细原因';
  const diagnostic = describeSSHelperFailure({ reasonCode: value }, { reasonCode: 'INTERNAL_ERROR', stage: 'memory.ui.candidate' });
  return diagnostic.reasonCode === value ? `${diagnostic.title}：${diagnostic.reason}` : value;
}
function sourceLabel(candidate: MemoryCandidateRecord): string {
  const floors = candidate.evidence.map(span => span.floor).filter((value): value is number => Number.isInteger(value));
  return floors.length ? [...new Set(floors)].map(value => `第 ${value} 层`).join('、') : candidate.sourceRefs.length ? `${candidate.sourceRefs.length} 个来源` : '无来源';
}
function domId(value: string): string { return `stx-memory-candidate-option-${value.replace(/[^a-zA-Z0-9_-]/g, '-')}`; }
function renderStatus(status: string): string {
  const tone = status === 'accepted' ? 'success' : status === 'pending_review' ? 'warning' : status === 'rejected' ? 'error' : 'neutral';
  return `<span ${control('status', tone)} class="stx-memory-candidate-status is-${tone}">${escapeHtml(statusLabel(status))}</span>`;
}
function renderHighlightedText(text: string, highlights: readonly { readonly start: number; readonly end: number; readonly text: string }[]): string {
  const sorted = [...highlights].filter(item => item.start >= 0 && item.end > item.start && item.end <= text.length).sort((left, right) => left.start - right.start);
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
  const id = domId(candidate.id);
  return `<button ${control('button', 'neutral', 'md')} type="button" id="${id}" class="stx-memory-candidate-row${selected ? ' is-selected' : ''}" data-action="select-memory-candidate" data-candidate-id="${escapeHtml(candidate.id)}" role="option" aria-selected="${selected}" aria-describedby="${id}-summary ${id}-meta">
    <span class="stx-memory-candidate-row-top"><strong id="${id}-summary" class="stx-memory-candidate-summary">${escapeHtml(candidate.summary || candidate.candidateLocalId)}</strong>${renderStatus(candidate.status)}</span>
    <span id="${id}-meta" class="stx-memory-candidate-row-bottom"><span>${escapeHtml(collectionLabel(candidate.collection))}</span><span>${candidate.batchIndex === undefined ? '未分批' : `第 ${candidate.batchIndex + 1} 批`}</span><span>${escapeHtml(sourceLabel(candidate))} · ${candidate.evidence.length} 处证据</span></span>
  </button>`;
}

function renderStatusFilter(status: string, count: number, active: boolean): string {
  return `<button ${control('button', 'neutral', 'sm')} type="button" class="stx-memory-candidate-status-filter${active ? ' is-active' : ''}" data-action="filter-memory-candidates" data-status="${escapeHtml(status)}" aria-pressed="${active}"><span>${escapeHtml(status ? statusLabel(status) : '全部')}</span><strong>${formatNumber(count)}</strong></button>`;
}

function renderEmpty(state: MemoryCandidatesViewState): string {
  const filtered = Boolean(state.query.trim() || state.batch || state.collection || state.status || state.floor);
  const [icon, title, description, action] = state.loading
    ? ['rotate', '正在读取候选', '正在同步当前聊天的候选快照。', '']
    : state.chatBound === false
      ? ['comments', '尚未绑定聊天', '打开聊天后，即可对照候选与原文。', '']
      : filtered
        ? ['magnifying-glass', '没有匹配候选', '调整筛选条件，或清除筛选。', `<button ${control('button', 'neutral', 'sm')} type="button" data-action="clear-candidate-filters">清除筛选</button>`]
        : state.missingSnapshot
          ? ['inbox', '没有可追溯快照', '重新初始化后，新的候选与原文证据会保留在这里。', `<button ${control('button', 'primary', 'sm')} type="button" data-action="navigate" data-page="initialize">前往初始化</button>`]
          : ['inbox', '尚未产生候选', '完成初始化后，即可查看提取结果。', `<button ${control('button', 'primary', 'sm')} type="button" data-action="navigate" data-page="initialize">开始初始化</button>`];
  return `<section class="stx-memory-candidate-empty" role="status"><ss-helper-icon name="${icon}" decorative></ss-helper-icon><h3>${title}</h3><p>${description}</p>${action}</section>`;
}

function renderCandidateDetail(state: MemoryCandidatesViewState, selected: MemoryCandidateRecord | undefined): string {
  if (!selected) return renderEmpty(state);
  const reason = candidateReasonCode(selected);
  const evidence = selected.evidence;
  return `<section class="stx-memory-candidate-detail" aria-labelledby="stx-memory-candidate-detail-title">
    <header class="stx-memory-candidate-panel-head"><h3 id="stx-memory-candidate-detail-title">候选内容</h3>${renderStatus(selected.status)}</header>
    <div class="stx-memory-candidate-detail-scroll" data-candidate-scroll="detail">
      <dl class="stx-memory-candidate-meta"><div><dt>类型</dt><dd>${escapeHtml(collectionLabel(selected.collection))}</dd></div><div><dt>来源</dt><dd>${selected.batchIndex === undefined ? '未分批' : `第 ${selected.batchIndex + 1} 批`} · ${escapeHtml(sourceLabel(selected))}</dd></div><div><dt>证据</dt><dd>${formatNumber(evidence.length)} 处</dd></div></dl>
      <section class="stx-memory-candidate-content"><h4>候选摘要</h4><p>${escapeHtml(selected.summary || selected.candidateLocalId)}</p></section>
      <section class="stx-memory-candidate-decision"><h4>本地检查结果</h4><strong>${selected.status === 'accepted' ? '已通过本地校验并写入正式记忆' : escapeHtml(statusLabel(selected.status))}</strong><p>${escapeHtml(reasonLabel(reason))}</p></section>
      <section class="stx-memory-candidate-excerpts"><h4>相关证据 <small>${formatNumber(evidence.length)} 处</small></h4>${evidence.length ? evidence.map(span => `<button ${control('button', 'neutral', 'sm')} type="button" data-action="select-memory-candidate-source" data-source-ref="${escapeHtml(span.sourceRef)}" class="stx-memory-candidate-excerpt${span.sourceRef === state.selectedSourceRef || (!state.selectedSourceRef && span === evidence[0]) ? ' is-selected' : ''}"><span>${span.floor === undefined ? escapeHtml(sourceKindLabel(span.sourceKind)) : `第 ${span.floor} 层`}</span><q>${escapeHtml(span.text)}</q><small>在右侧原文中定位<ss-helper-icon name="arrow-right" decorative></ss-helper-icon></small></button>`).join('') : '<p class="stx-memory-muted">没有可用证据片段</p>'}</section>
      <details class="stx-memory-candidate-collapsible"><summary>规范化候选</summary><pre>${escapeHtml(JSON.stringify(selected.normalizedCandidate, null, 2))}</pre></details>
      <details class="stx-memory-candidate-collapsible stx-memory-candidate-technical"><summary>技术详情</summary><dl class="stx-memory-candidate-meta"><div><dt>候选 ID</dt><dd><code>${escapeHtml(selected.candidateLocalId)}</code></dd></div><div><dt>裁决</dt><dd>${escapeHtml(selected.decision || '未记录')}</dd></div><div><dt>原因码</dt><dd><code>${escapeHtml(reason || '未记录')}</code></dd></div><div><dt>阶段 / 尝试</dt><dd>${escapeHtml(selected.stage)} · 第 ${formatNumber(selected.attemptIndex + 1)} 次</dd></div>${selected.rejectionId ? `<div><dt>拒绝记录</dt><dd><code>${escapeHtml(selected.rejectionId)}</code></dd></div>` : ''}${selected.reviewItemId ? `<div><dt>审核记录</dt><dd><code>${escapeHtml(selected.reviewItemId)}</code></dd></div>` : ''}<div><dt>正式记录</dt><dd>${escapeHtml(selected.committedRecordRefs.join('、') || '尚未写入')}</dd></div><div><dt>初始化任务</dt><dd><code>${escapeHtml(selected.jobId || state.stats?.jobId || '未记录')}</code></dd></div><div><dt>流水线</dt><dd><code>${escapeHtml(selected.pipelineRunId)}</code></dd></div><div><dt>阶段尝试</dt><dd><code>${escapeHtml(selected.stageAttemptId)}</code></dd></div>${selected.failure?.requestId ? `<div><dt>请求 ID</dt><dd><code>${escapeHtml(selected.failure.requestId)}</code></dd></div>` : ''}<div><dt>创建时间</dt><dd>${new Date(selected.createdAt).toLocaleString('zh-CN')}</dd></div></dl></details>
    </div>
  </section>`;
}

function renderCandidateSource(state: MemoryCandidatesViewState, selected: MemoryCandidateRecord | undefined): string {
  const evidence = selected?.evidence ?? [];
  const source = evidence.find(span => span.sourceRef === state.selectedSourceRef) ?? evidence[0];
  const preview = state.sourcePreview?.candidateId === selected?.id && state.sourcePreview?.sourceRef === source?.sourceRef ? state.sourcePreview : undefined;
  const warning = preview?.warning;
  const error = state.sourceError;
  return `<section class="stx-memory-candidate-source" aria-labelledby="stx-memory-candidate-source-title">
    <header class="stx-memory-candidate-panel-head"><h3 id="stx-memory-candidate-source-title">${source ? escapeHtml(sourceKindLabel(source.sourceKind)) : '聊天'}原文</h3>${preview ? `<span class="stx-memory-candidate-source-state${warning || preview.sourceChanged ? ' is-warning' : ''}">${warning ? '证据需核对' : preview.sourceChanged ? '来源已更新' : '来源一致'}</span>` : ''}</header>
    ${source ? `<div class="stx-memory-candidate-source-tabs" ${control('segmented')} role="tablist" aria-label="候选来源">${evidence.map(span => `<button ${control('button', 'neutral', 'xs')} type="button" data-action="select-memory-candidate-source" data-source-ref="${escapeHtml(span.sourceRef)}" role="tab" aria-selected="${span.sourceRef === source.sourceRef}" class="${span.sourceRef === source.sourceRef ? 'is-selected' : ''}">${span.floor === undefined ? escapeHtml(sourceKindLabel(span.sourceKind)) : `第 ${span.floor} 层`}</button>`).join('')}</div>` : ''}
    <div class="stx-memory-candidate-source-preview" data-candidate-scroll="source" data-source-ready="${Boolean(preview)}" tabindex="0" role="region" aria-label="来源原文">
      ${error ? `<div class="stx-memory-candidate-source-error" role="alert"><h4>${escapeHtml(error.title)}</h4><code>${escapeHtml(error.reasonCode)}</code><p>${escapeHtml(error.reason)}</p><p>${escapeHtml(error.action)}</p>${error.requestId ? `<small>请求 ID ${escapeHtml(error.requestId)}</small>` : ''}${source ? `<button ${control('button', 'neutral', 'sm')} type="button" data-action="select-memory-candidate-source" data-source-ref="${escapeHtml(source.sourceRef)}">重新读取原文</button>` : ''}</div>` : preview ? `${warning || preview.sourceChanged ? `<p class="stx-memory-candidate-source-note" role="status">${warning === 'ambiguous_match' ? '证据出现多处，未猜测高亮位置。' : warning === 'no_match' ? '未找到匹配文本，保留保存片段。' : warning === 'source_missing' ? '原文已缺失，保留保存片段。' : '来源已更新，已尝试唯一定位。'}</p>` : ''}<pre>${renderHighlightedText(preview.text, preview.highlights)}</pre>${preview.savedText ? `<details class="stx-memory-candidate-collapsible"><summary>保存的证据片段</summary><p>${escapeHtml(preview.savedText)}</p></details>` : ''}` : `<div class="stx-memory-candidate-source-placeholder">${source ? '正在读取原文并定位证据…' : selected ? '该候选没有可用原文证据' : '选择候选后查看原文'}</div>`}
    </div>
  </section>`;
}

export function renderMemoryCandidatesView(state: MemoryCandidatesViewState): string {
  const candidates = state.candidates;
  const selectedIndex = candidates.findIndex(candidate => candidate.id === state.selectedId);
  const selected = candidates[selectedIndex];
  const stats = state.stats;
  const total = stats?.total ?? candidates.length;
  const batchCount = stats?.batchCount ?? new Set(candidates.map(item => item.batchIndex).filter(Number.isInteger)).size;
  const countForStatus = (status: string): number => stats?.byStatus?.[status] ?? candidates.filter(item => item.status === status).length;
  const activeFilters = Boolean(state.query.trim() || state.batch || state.collection || state.status || state.floor);
  const batchOptions = [...new Set([...(stats?.batchIndices ?? []), ...candidates.map(item => item.batchIndex).filter((value): value is number => Number.isInteger(value))])].sort((left, right) => left - right);
  // ponytail: footer walks the loaded snapshot; add cursor navigation if review extends beyond the queue cache.
  const previous = candidates[selectedIndex - 1];
  const next = selected ? candidates[selectedIndex + 1] : undefined;
  const source = selected?.evidence.find(span => span.sourceRef === state.selectedSourceRef) ?? selected?.evidence[0];
  const listAttributes = state.virtualized ? '' : `role="listbox" aria-label="记忆候选列表" aria-activedescendant="${selected ? domId(selected.id) : ''}"`;
  return `<div class="stx-memory-candidates-page" data-selected-id="${escapeHtml(state.selectedId)}" data-source-ref="${escapeHtml(state.selectedSourceRef)}">
    <header class="stx-memory-candidate-status-rail"><div class="stx-memory-candidate-status-filters" ${control('segmented')} role="group" aria-label="候选处理状态">${renderStatusFilter('', total, !state.status)}${STATUS_ORDER.map(status => renderStatusFilter(status, countForStatus(status), state.status === status)).join('')}</div><span>${formatNumber(batchCount)} 批来源</span></header>
    <section class="stx-memory-candidates-toolbar" aria-label="候选筛选"><label class="stx-memory-candidate-search"><ss-helper-icon name="magnifying-glass" decorative></ss-helper-icon><input ${control('input')} type="search" aria-label="搜索候选" data-candidate-filter="query" value="${escapeHtml(state.query)}" placeholder="搜索候选、关键词或 ID"></label><label><span>类型</span><select ${control('select')} aria-label="候选类型" data-candidate-filter="collection"><option value="">全部类型</option>${Object.keys(COLLECTION_LABELS).map(value => `<option value="${value}" ${state.collection === value ? 'selected' : ''}>${collectionLabel(value)}</option>`).join('')}</select></label><label><span>批次</span><select ${control('select')} aria-label="来源批次" data-candidate-filter="batch"><option value="">全部批次</option>${batchOptions.map(value => `<option value="${value}" ${state.batch === String(value) ? 'selected' : ''}>第 ${value + 1} 批</option>`).join('')}</select></label><label><span>楼层</span><input ${control('input')} type="number" min="0" aria-label="来源楼层" data-candidate-filter="floor" value="${escapeHtml(state.floor)}" placeholder="全部"></label><button ${control('button', 'neutral', 'sm')} type="button" data-action="clear-candidate-filters" ${activeFilters ? '' : 'disabled'}>清除筛选</button></section>
    <section class="stx-memory-candidates-split" aria-label="候选与原文对照"><section class="stx-memory-candidates-list" aria-label="候选队列"><header class="stx-memory-candidate-panel-head"><h3>候选列表</h3><span>${formatNumber(total)} 条${activeFilters ? ' · 已筛选' : ''}</span></header><div data-memory-candidates-list="true" data-candidate-scroll="queue" ${listAttributes}>${state.loading ? '<div class="stx-memory-loading">正在读取候选…</div>' : state.virtualized && state.chatBound !== false ? '' : candidates.length ? candidates.map(candidate => renderCandidateRow(candidate, candidate.id === state.selectedId)).join('') : '<div class="stx-memory-empty">暂无匹配候选</div>'}</div></section>${renderCandidateDetail(state, selected)}${renderCandidateSource(state, selected)}</section>
    <footer class="stx-memory-candidate-footer"><span>对照原文，查看处理原因</span><div><button ${control('button', 'neutral', 'sm')} type="button" data-action="select-memory-candidate" data-candidate-id="${escapeHtml(previous?.id)}" ${previous ? '' : 'disabled'}><ss-helper-icon name="chevron-left" decorative></ss-helper-icon>上一条</button><span>${selected ? `第 ${selectedIndex + 1} 条 · 当前加载 ${formatNumber(candidates.length)} 条` : '未选择候选'}</span><button ${control('button', 'neutral', 'sm')} type="button" data-action="select-memory-candidate" data-candidate-id="${escapeHtml(next?.id)}" ${next ? '' : 'disabled'}>下一条<ss-helper-icon name="chevron-right" decorative></ss-helper-icon></button><button ${control('button', 'primary', 'sm')} type="button" data-action="jump-to-message" data-message-index="${source?.floor ?? ''}" ${source?.floor === undefined ? 'disabled' : ''} aria-label="${source?.floor === undefined ? '没有可跳转的聊天消息' : `跳转到聊天消息 #${source.floor}`}"><ss-helper-icon name="arrow-up-right-from-square" decorative></ss-helper-icon>查看原文</button></div></footer>
  </div>`;
}

export { COLLECTION_LABELS, STATUS_LABELS, renderCandidateRow };
