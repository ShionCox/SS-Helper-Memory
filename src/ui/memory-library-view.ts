import {
  UI_CONTROL_ATTRIBUTE,
  UI_CONTROL_ICON_ONLY_ATTRIBUTE,
  UI_CONTROL_SIZE_ATTRIBUTE,
  UI_CONTROL_TONE_ATTRIBUTE,
  type UiControlKind,
  type UiControlSize,
  type UiControlTone,
} from '@ss-helper/sdk';

export interface MemoryLibraryFact {
  id: string;
  content: string;
  kind: string;
  status: string;
  confidence: number;
  sourceRefs: string[];
  evidence: Array<{ sourceRef: string; excerpt: string }>;
  supersedesId?: string;
  supersededById?: string;
  auditBatches?: Array<{ jobId: string; batchIndex: number; status: string; kind?: string }>;
  updatedAt: number;
}

export type MemoryLibrarySort = 'updated_desc' | 'confidence_desc' | 'kind_asc';

export interface MemoryLibraryViewState {
  allFacts: readonly MemoryLibraryFact[];
  queryFacts: readonly MemoryLibraryFact[];
  query: string;
  selectedKinds: readonly string[];
  selectedStatuses: readonly string[];
  openFilter: '' | 'kind' | 'status';
  sort: MemoryLibrarySort;
  selectedFactId: string;
  editingFactId: string;
  confirmFactId: string;
  busyAction: string;
  chatLabel: string;
}

export interface MemoryLibraryViewOptions {
  kindLabels: Readonly<Record<string, string>>;
  statusLabels: Readonly<Record<string, string>>;
  formatTime(value: number): string;
  formatSource(value: string, mode?: 'reference' | 'evidence'): string;
  translateRecordStatus(value: string): string;
}

export interface MemoryLibrarySelection {
  visibleFacts: MemoryLibraryFact[];
  selected?: MemoryLibraryFact;
  previous?: MemoryLibraryFact;
  next?: MemoryLibraryFact;
  metrics: {
    total: number;
    active: number;
    pending: number;
    evidenceCoverage: number;
  };
  kindCounts: Readonly<Record<string, number>>;
  statusCounts: Readonly<Record<string, number>>;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character]!);
}

function control(
  kind: UiControlKind,
  tone?: UiControlTone,
  size?: UiControlSize,
  iconOnly = false,
): string {
  return [
    `${UI_CONTROL_ATTRIBUTE}="${kind}"`,
    tone ? `${UI_CONTROL_TONE_ATTRIBUTE}="${tone}"` : '',
    size ? `${UI_CONTROL_SIZE_ATTRIBUTE}="${size}"` : '',
    iconOnly ? `${UI_CONTROL_ICON_ONLY_ATTRIBUTE}="true"` : '',
  ].filter(Boolean).join(' ');
}

function statusTone(status: string): UiControlTone {
  if (status === 'active') return 'success';
  if (status === 'pending') return 'warning';
  if (status === 'invalid') return 'error';
  return 'neutral';
}

function statusChip(label: string, status: string): string {
  return `<span ${control('status', statusTone(status))}>${escapeHtml(label)}</span>`;
}

function sortFacts(facts: readonly MemoryLibraryFact[], sort: MemoryLibrarySort): MemoryLibraryFact[] {
  return [...facts].sort((left, right) => {
    if (sort === 'confidence_desc') return right.confidence - left.confidence || right.updatedAt - left.updatedAt;
    if (sort === 'kind_asc') return left.kind.localeCompare(right.kind, 'zh-CN') || right.updatedAt - left.updatedAt;
    return right.updatedAt - left.updatedAt;
  });
}

export function selectMemoryLibraryView(state: MemoryLibraryViewState): MemoryLibrarySelection {
  const visibleFacts = sortFacts(state.queryFacts.filter(fact => (
    state.selectedKinds.includes(fact.kind) && state.selectedStatuses.includes(fact.status)
  )), state.sort);
  const selected = visibleFacts.find(fact => fact.id === state.selectedFactId) ?? visibleFacts[0];
  const selectedIndex = selected ? visibleFacts.findIndex(fact => fact.id === selected.id) : -1;
  const total = state.allFacts.length;
  const kindCounts: Record<string, number> = {};
  const statusCounts: Record<string, number> = {};
  for (const fact of state.allFacts) {
    kindCounts[fact.kind] = (kindCounts[fact.kind] ?? 0) + 1;
    statusCounts[fact.status] = (statusCounts[fact.status] ?? 0) + 1;
  }
  return {
    visibleFacts,
    selected,
    previous: selectedIndex > 0 ? visibleFacts[selectedIndex - 1] : undefined,
    next: selectedIndex >= 0 && selectedIndex < visibleFacts.length - 1 ? visibleFacts[selectedIndex + 1] : undefined,
    metrics: {
      total,
      active: statusCounts.active ?? 0,
      pending: statusCounts.pending ?? 0,
      evidenceCoverage: total === 0
        ? 0
        : Math.round((state.allFacts.filter(fact => fact.evidence.length > 0).length / total) * 100),
    },
    kindCounts,
    statusCounts,
  };
}

function renderMetric(icon: string, label: string, value: string | number, note: string): string {
  return `<article class="stx-memory-library-metric"><span class="stx-memory-library-metric-icon"><ss-helper-icon name="${icon}" decorative></ss-helper-icon></span><div><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></div><span>${escapeHtml(note)}</span></article>`;
}

function renderMultiFilter(
  filter: 'kind' | 'status',
  allLabel: string,
  selectedValues: readonly string[],
  labels: Readonly<Record<string, string>>,
  counts: Readonly<Record<string, number>>,
  open: boolean,
): string {
  const entries = Object.entries(labels);
  const allSelected = selectedValues.length === entries.length;
  const partiallySelected = selectedValues.length > 0 && !allSelected;
  const selectedLabel = allSelected
    ? allLabel
    : selectedValues.length === 0
      ? `未选择${filter === 'kind' ? '类型' : '状态'}`
      : selectedValues.length === 1
        ? labels[selectedValues[0]!] ?? selectedValues[0]!
        : `已选 ${selectedValues.length} 项`;
  const triggerId = `stx-memory-${filter}-filter-trigger`;
  const menuId = `stx-memory-${filter}-filter-menu`;
  const allMark = allSelected
    ? '<ss-helper-icon name="check" decorative></ss-helper-icon>'
    : partiallySelected ? '<ss-helper-icon name="minus" decorative></ss-helper-icon>' : '';
  return `<div class="stx-memory-library-filter" data-multi-filter="${filter}">
    <button id="${triggerId}" class="stx-memory-library-filter-trigger" ${control('button', 'neutral')} type="button" data-action="toggle-filter-menu" data-filter-menu="${filter}" aria-haspopup="true" aria-expanded="${open}" aria-controls="${menuId}"><span>${escapeHtml(selectedLabel)}</span><ss-helper-icon name="chevron-${open ? 'up' : 'down'}" decorative></ss-helper-icon></button>
    ${open ? `<div id="${menuId}" class="stx-memory-library-filter-menu" role="group" aria-labelledby="${triggerId}">
      <label class="stx-memory-library-filter-option stx-memory-library-filter-all ${allSelected ? 'is-selected' : partiallySelected ? 'is-partial' : ''}"><span><strong>${escapeHtml(allLabel)}</strong><small>${selectedValues.length} / ${entries.length}</small></span><span class="stx-memory-library-filter-mark" aria-hidden="true">${allMark}</span><input class="stx-memory-library-filter-native stx-memory-sr-only" ${control('checkbox')} type="checkbox" data-filter-all="${filter}" data-selected-count="${selectedValues.length}" data-option-count="${entries.length}" aria-checked="${partiallySelected ? 'mixed' : allSelected}" ${allSelected ? 'checked' : ''}></label>
      ${entries.map(([value, label]) => {
        const selected = selectedValues.includes(value);
        return `<label class="stx-memory-library-filter-option ${selected ? 'is-selected' : ''}"><span><strong>${escapeHtml(label)}</strong><small>${counts[value] ?? 0}</small></span><span class="stx-memory-library-filter-mark" aria-hidden="true">${selected ? '<ss-helper-icon name="check" decorative></ss-helper-icon>' : ''}</span><input class="stx-memory-library-filter-native stx-memory-sr-only" ${control('checkbox')} type="checkbox" data-filter-option="${filter}" value="${escapeHtml(value)}" ${selected ? 'checked' : ''}></label>`;
      }).join('')}
    </div>` : ''}
  </div>`;
}

function renderScopeButtons(
  filter: 'kind' | 'status',
  labels: Readonly<Record<string, string>>,
  counts: Readonly<Record<string, number>>,
  selectedValues: readonly string[],
  total: number,
): string {
  const allSelected = selectedValues.length === Object.keys(labels).length;
  const items = Object.entries(labels).filter(([value]) => (counts[value] ?? 0) > 0);
  return `<button class="stx-memory-library-scope-button" ${control('button', 'neutral')} type="button" data-action="library-scope" data-scope-filter="${filter}" data-scope-value="" aria-pressed="${allSelected}"><strong>${filter === 'kind' ? '全部类型' : '全部状态'}</strong><span>${total}</span></button>${items.map(([value, label]) => {
    const active = selectedValues.length === 1 && selectedValues[0] === value;
    return `<button class="stx-memory-library-scope-button" ${control('button', 'neutral')} type="button" data-action="library-scope" data-scope-filter="${filter}" data-scope-value="${escapeHtml(value)}" aria-pressed="${active}"><strong>${escapeHtml(label)}</strong><span>${counts[value] ?? 0}</span></button>`;
  }).join('')}`;
}

function renderVersionNode(
  fact: MemoryLibraryFact | undefined,
  role: string,
  options: MemoryLibraryViewOptions,
  current = false,
): string {
  if (!fact) return `<div class="stx-memory-library-version-node is-empty"><strong>${escapeHtml(role)}</strong><small>无记录</small></div>`;
  const body = `<strong>${escapeHtml(role)}</strong><small>${escapeHtml(options.kindLabels[fact.kind] ?? fact.kind)} · ${escapeHtml(options.statusLabels[fact.status] ?? fact.status)}</small><span>${escapeHtml(fact.content)}</span>`;
  return current
    ? `<div class="stx-memory-library-version-node is-current">${body}</div>`
    : `<button class="stx-memory-library-version-node" ${control('button', 'neutral')} type="button" data-action="select-fact" data-fact-id="${escapeHtml(fact.id)}">${body}</button>`;
}

function renderInspector(
  state: MemoryLibraryViewState,
  selection: MemoryLibrarySelection,
  options: MemoryLibraryViewOptions,
): string {
  const selected = selection.selected;
  if (!selected) return `<div class="stx-memory-library-empty"><ss-helper-icon name="book-open" decorative></ss-helper-icon><strong>选择一条记忆</strong><p>这里会显示内容、证据、版本关系和捕获记录。</p></div>`;
  const editing = state.editingFactId === selected.id;
  const confirming = state.confirmFactId === selected.id;
  const prior = selected.supersedesId ? state.allFacts.find(fact => fact.id === selected.supersedesId) : undefined;
  const after = selected.supersededById ? state.allFacts.find(fact => fact.id === selected.supersededById) : undefined;
  const confidence = Math.round(selected.confidence * 100);
  return `<div class="stx-memory-library-detail-head"><div><span class="stx-memory-kicker">记忆块 · 可追溯事实</span><h3>${escapeHtml(options.kindLabels[selected.kind] ?? selected.kind)}</h3><p>更新于 ${escapeHtml(options.formatTime(selected.updatedAt))}</p></div><div class="stx-memory-library-detail-nav"><button ${control('button', 'neutral', 'xs', true)} type="button" data-action="select-fact" data-fact-id="${escapeHtml(selection.previous?.id ?? '')}" aria-label="上一条记忆" ${selection.previous ? '' : 'disabled'}><ss-helper-icon name="arrow-up" decorative></ss-helper-icon></button><button ${control('button', 'neutral', 'xs', true)} type="button" data-action="select-fact" data-fact-id="${escapeHtml(selection.next?.id ?? '')}" aria-label="下一条记忆" ${selection.next ? '' : 'disabled'}><ss-helper-icon name="arrow-down" decorative></ss-helper-icon></button></div></div>
    <dl class="stx-memory-library-detail-metrics"><div><dt>状态</dt><dd>${escapeHtml(options.statusLabels[selected.status] ?? selected.status)}</dd></div><div><dt>置信度</dt><dd>${confidence}%</dd></div><div><dt>证据</dt><dd>${selected.evidence.length} 条</dd></div><div><dt>来源引用</dt><dd>${selected.sourceRefs.length} 项</dd></div></dl>
    <section class="stx-memory-library-detail-section"><div class="stx-memory-library-section-title"><div><h4>记忆内容</h4><p>编辑只会修改当前事实文本，不会改写聊天原文</p></div>${statusChip(options.statusLabels[selected.status] ?? selected.status, selected.status)}</div>
      ${editing
        ? `<textarea id="stx-memory-edit-content" class="stx-memory-library-editor" ${control('textarea')} data-edit-content>${escapeHtml(selected.content)}</textarea><div class="stx-memory-library-actions"><button ${control('button', 'primary')} type="button" data-action="save-fact" data-fact-id="${escapeHtml(selected.id)}" ${state.busyAction === 'save-fact' ? 'disabled' : ''}><ss-helper-icon name="floppy-disk" decorative></ss-helper-icon>保存修改</button><button ${control('button', 'neutral')} type="button" data-action="cancel-edit">取消</button></div>`
        : `<div class="stx-memory-library-content-card"><p>${escapeHtml(selected.content)}</p></div><div class="stx-memory-library-actions"><button ${control('button', 'primary')} type="button" data-action="edit-fact" data-fact-id="${escapeHtml(selected.id)}"><ss-helper-icon name="pen" decorative></ss-helper-icon>编辑内容</button>${confirming ? `<span class="stx-memory-library-delete-confirm"><span>确认删除这条记忆？</span><button ${control('button', 'danger')} type="button" data-action="confirm-delete" data-fact-id="${escapeHtml(selected.id)}">确认</button><button ${control('button', 'neutral')} type="button" data-action="cancel-delete">取消</button></span>` : `<button ${control('button', 'danger')} type="button" data-action="delete-fact" data-fact-id="${escapeHtml(selected.id)}"><ss-helper-icon name="trash" decorative></ss-helper-icon>删除</button>`}</div>`}
    </section>
    <section class="stx-memory-library-detail-section"><div class="stx-memory-library-section-title"><div><h4>来源与证据</h4><p>核对记忆是否忠于聊天原文</p></div><span>${selected.evidence.length} 条</span></div><div class="stx-memory-library-evidence-list">${selected.evidence.length ? selected.evidence.map(item => `<blockquote class="stx-memory-library-evidence"><p>${escapeHtml(item.excerpt)}</p><footer>${options.formatSource(item.sourceRef, 'evidence')}</footer></blockquote>`).join('') : '<p class="stx-memory-muted">没有可展示的来源证据。</p>'}</div></section>
    <section class="stx-memory-library-detail-section"><div class="stx-memory-library-section-title"><div><h4>版本关系</h4><p>替代关系来自事实修订链</p></div></div><div class="stx-memory-library-version-flow">${renderVersionNode(prior, '上一版本', options)}<ss-helper-icon name="chevron-right" decorative></ss-helper-icon>${renderVersionNode(selected, '当前版本', options, true)}<ss-helper-icon name="chevron-right" decorative></ss-helper-icon>${renderVersionNode(after, '下一版本', options)}</div></section>
    <section class="stx-memory-library-detail-section stx-memory-library-reference-grid"><div><h4>来源引用</h4><div class="stx-memory-library-reference-list">${selected.sourceRefs.length ? selected.sourceRefs.map(source => options.formatSource(source)).join('') : '<span>无</span>'}</div></div><div><h4>捕获记录</h4><div class="stx-memory-library-reference-list">${selected.auditBatches?.length ? selected.auditBatches.map(item => `<button ${control('button', 'neutral', 'xs')} type="button" data-action="navigate" data-page="audit"><span>第 ${Math.max(1, Number(item.batchIndex) || 1)} 批 · ${escapeHtml(options.translateRecordStatus(item.status))}</span><small>${escapeHtml(item.jobId)}</small></button>`).join('') : '<span>暂无匹配批次</span>'}</div></div></section>`;
}

export function renderMemoryLibraryView(
  state: MemoryLibraryViewState,
  options: MemoryLibraryViewOptions,
): string {
  const selection = selectMemoryLibraryView(state);
  const { metrics } = selection;
  const sortLabels: Record<MemoryLibrarySort, string> = {
    updated_desc: '最近更新',
    confidence_desc: '置信度',
    kind_asc: '类型',
  };
  const list = selection.visibleFacts.length
    ? selection.visibleFacts.map(fact => {
      const confidence = Math.round(fact.confidence * 100);
      const hasVersion = Boolean(fact.supersedesId || fact.supersededById);
      return `<button class="stx-memory-library-fact-row" ${control('button', 'neutral')} type="button" data-action="select-fact" data-fact-id="${escapeHtml(fact.id)}" aria-selected="${fact.id === selection.selected?.id}"><span class="stx-memory-library-fact-top"><span class="stx-memory-library-kind">${escapeHtml(options.kindLabels[fact.kind] ?? fact.kind)}</span><time datetime="${new Date(fact.updatedAt).toISOString()}">${escapeHtml(options.formatTime(fact.updatedAt))}</time></span><span class="stx-memory-library-fact-content">${escapeHtml(fact.content)}</span><span class="stx-memory-library-fact-bottom"><span class="stx-memory-library-fact-marks">${statusChip(options.statusLabels[fact.status] ?? fact.status, fact.status)}<span class="stx-memory-library-mini-badge">${fact.evidence.length} 条证据</span>${hasVersion ? '<span class="stx-memory-library-mini-badge">版本链</span>' : ''}</span><span class="stx-memory-library-confidence"><span>置信度</span><progress ${control('progress')} max="100" value="${confidence}">${confidence}%</progress><strong>${confidence}%</strong></span></span></button>`;
    }).join('')
    : `<div class="stx-memory-library-empty"><ss-helper-icon name="magnifying-glass" decorative></ss-helper-icon><strong>${state.query ? '没有匹配的记忆' : '当前聊天还没有记忆块'}</strong><p>${state.query ? '尝试缩短关键词，或恢复类型和状态筛选。' : '完成初始化或捕获后，可在这里审阅真实事实。'}</p></div>`;
  return `<div class="stx-memory-library-shell">
    <section class="stx-memory-library-metrics" aria-label="记忆统计">${renderMetric('book-open', '全部记忆', metrics.total, '当前聊天')}${renderMetric('circle-check', '有效记忆', metrics.active, '可参与召回')}${renderMetric('list-check', '待审阅', metrics.pending, '待确认状态')}${renderMetric('link', '证据覆盖', `${metrics.evidenceCoverage}%`, '含来源证据')}</section>
    <div class="stx-memory-library-toolbar"><label class="stx-memory-library-search"><span class="stx-memory-sr-only">搜索记忆</span><ss-helper-icon name="magnifying-glass" decorative></ss-helper-icon><input ${control('input')} data-filter="query" value="${escapeHtml(state.query)}" placeholder="搜索记忆内容、人物或地点"></label>${renderMultiFilter('kind', '全部类型', state.selectedKinds, options.kindLabels, selection.kindCounts, state.openFilter === 'kind')}${renderMultiFilter('status', '全部状态', state.selectedStatuses, options.statusLabels, selection.statusCounts, state.openFilter === 'status')}<label class="stx-memory-library-sort"><span class="stx-memory-sr-only">记忆排序</span><select ${control('select')} aria-label="记忆排序" data-filter="sort"><option value="updated_desc" ${state.sort === 'updated_desc' ? 'selected' : ''}>最近更新</option><option value="confidence_desc" ${state.sort === 'confidence_desc' ? 'selected' : ''}>置信度</option><option value="kind_asc" ${state.sort === 'kind_asc' ? 'selected' : ''}>类型</option></select></label><button ${control('button', 'neutral')} type="button" data-action="refresh-library" ${state.busyAction ? 'disabled' : ''}><ss-helper-icon name="rotate" decorative></ss-helper-icon>刷新</button></div>
    <div class="stx-memory-library-grid">
      <aside class="stx-memory-library-panel stx-memory-library-scope-panel" aria-label="快速筛选"><div class="stx-memory-library-panel-head"><div><h3>快速范围</h3><p>点击后立即更新记忆列表</p></div><span>${selection.visibleFacts.length} 条</span></div><div class="stx-memory-library-scope-body"><section><div class="stx-memory-library-scope-title"><span>状态</span><span>STATUS</span></div>${renderScopeButtons('status', options.statusLabels, selection.statusCounts, state.selectedStatuses, metrics.total)}</section><section><div class="stx-memory-library-scope-title"><span>事实类型</span><span>KIND</span></div>${renderScopeButtons('kind', options.kindLabels, selection.kindCounts, state.selectedKinds, metrics.total)}</section><section class="stx-memory-library-coverage"><strong>证据覆盖率</strong><p>当前聊天中具有至少一条可追溯证据的记忆比例。</p><progress ${control('progress')} max="100" value="${metrics.evidenceCoverage}">${metrics.evidenceCoverage}%</progress></section></div></aside>
      <section class="stx-memory-library-panel stx-memory-library-list-panel" aria-label="记忆块列表"><div class="stx-memory-library-panel-head"><div><h3>记忆块列表</h3><p>每个块对应一条可追溯事实</p></div><span>${selection.visibleFacts.length} 条</span></div><div class="stx-memory-library-result-line"><span aria-live="polite">共 ${selection.visibleFacts.length} 条记忆</span><span>${sortLabels[state.sort]}</span></div><div class="stx-memory-fact-list stx-memory-library-fact-list">${list}</div></section>
      <section class="stx-memory-library-panel stx-memory-library-inspector-panel" aria-label="记忆块详情"><div class="stx-memory-library-panel-head"><div><h3>记忆审阅</h3><p>内容、证据、版本链和捕获记录</p></div><span>${selection.selected ? escapeHtml(options.statusLabels[selection.selected.status] ?? selection.selected.status) : '未选择'}</span></div><div class="stx-memory-library-inspector">${renderInspector(state, selection, options)}</div></section>
    </div>
  </div>`;
}
