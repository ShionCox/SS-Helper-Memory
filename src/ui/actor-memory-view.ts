import {
  UI_CONTROL_ATTRIBUTE,
  UI_CONTROL_ICON_ONLY_ATTRIBUTE,
  UI_CONTROL_SIZE_ATTRIBUTE,
  UI_CONTROL_TONE_ATTRIBUTE,
  type UiControlKind,
  type UiControlSize,
  type UiControlTone,
} from '@ss-helper/sdk';
import {
  buildMemoryRecallPacket,
  buildMemoryRecallPacketAtStrength,
  effectiveMemoryStrength,
  MEMORY_STRENGTH_LEVELS,
} from '../application/recall';
import {
  DEFAULT_MEMORY_TRAITS,
  type ActorMemoryTrace,
  type MemoryKnowledgeMode,
  type MemoryObservation,
  type MemoryObservationChannel,
  type MemoryOwner,
  type MemoryPrivacy,
  type MemoryRecallPacket,
} from '../domain';

export interface ActorMemoryFact {
  id: string;
  content: string;
  evidence: Array<{ sourceRef: string; excerpt: string }>;
  sourceRefs: string[];
  updatedAt: number;
}

export type ActorMemoryLevel = 'forgotten' | 'fragment' | 'gist' | 'clear' | 'exact';
export type ActorMemorySort = 'updated_desc' | 'effective_desc' | 'clarity_desc' | 'confidence_desc' | 'emotion_desc' | 'rehearsal_desc';
export type ActorMemoryTab = 'overview' | 'source' | 'technical';
export type ActorMemoryGroup = 'people' | 'system';

export interface ActorMemoryViewState {
  actors: readonly MemoryOwner[];
  traces: readonly ActorMemoryTrace[];
  facts: readonly ActorMemoryFact[];
  observations: readonly MemoryObservation[];
  query: string;
  knowledgeMode: '' | MemoryKnowledgeMode;
  privacy: '' | MemoryPrivacy;
  level: '' | ActorMemoryLevel;
  sort: ActorMemorySort;
  selectedOwnerId: string;
  selectedTraceId: string;
  tab: ActorMemoryTab;
  collapsedGroups: readonly ActorMemoryGroup[];
  now: number;
}

export interface ActorMemoryViewOptions {
  formatTime(value: number): string;
  renderSourceReference(value: string, mode?: 'reference' | 'evidence'): string;
}

interface ActorMemoryOwnerView {
  id: string;
  displayName: string;
  aliases: readonly string[];
  kind: MemoryOwner['kind'];
  memoryTraits: MemoryOwner['memoryTraits'];
}

export interface ActorMemorySelection {
  owners: ActorMemoryOwnerView[];
  selectedOwner?: ActorMemoryOwnerView;
  visibleTraces: ActorMemoryTrace[];
  selectedTrace?: ActorMemoryTrace;
  selectedFact?: ActorMemoryFact;
  selectedObservations: MemoryObservation[];
  effectiveStrengths: ReadonlyMap<string, number>;
  metrics: { traces: number; owners: number; averageStrength: number; privateCount: number };
}

interface MemoryStage {
  key: ActorMemoryLevel;
  start: number;
  end: number;
  preview: number;
  label: string;
  range: string;
}

const KNOWLEDGE_LABELS: Readonly<Record<MemoryKnowledgeMode, string>> = Object.freeze({
  asserted: '规范确认', self_reported: '本人陈述', heard: '听闻', experienced: '亲历',
  inferred: '推断', believed: '相信', suspected: '怀疑', unknown: '未知',
});
const PRIVACY_LABELS: Readonly<Record<MemoryPrivacy, string>> = Object.freeze({ public: '公开', limited: '有限', private: '私密', secret: '秘密' });
const CHANNEL_LABELS: Readonly<Record<MemoryObservationChannel, string>> = Object.freeze({
  public_speech: '公开发言', private_thought: '私密思想', narration: '旁白叙述', worldbook: '世界书', state: '状态信息', rumor: '传闻', inference: '推断',
});
const LEVEL_LABELS: Readonly<Record<ActorMemoryLevel, string>> = Object.freeze({ forgotten: '接近遗忘', fragment: '模糊片段', gist: '大意记忆', clear: '清晰记忆', exact: '完整细节' });
const SORT_LABELS: Readonly<Record<ActorMemorySort, string>> = Object.freeze({ updated_desc: '最近更新', effective_desc: '有效强度', clarity_desc: '清晰度', confidence_desc: '信念置信度', emotion_desc: '情绪显著度', rehearsal_desc: '复述次数' });
const MEMORY_STAGES: readonly MemoryStage[] = Object.freeze([
  { key: 'forgotten', start: 0, end: 25, preview: 12, label: '接近遗忘', range: '0–24' },
  { key: 'fragment', start: 25, end: 45, preview: 35, label: '模糊片段', range: '25–44' },
  { key: 'gist', start: 45, end: 65, preview: 55, label: '大意记忆', range: '45–64' },
  { key: 'clear', start: 65, end: 85, preview: 75, label: '清晰记忆', range: '65–84' },
  { key: 'exact', start: 85, end: 100, preview: 92, label: '完整细节', range: '85–100' },
]);

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>'"]/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!);
}
function control(kind: UiControlKind, tone?: UiControlTone, size?: UiControlSize, iconOnly = false): string {
  return [`${UI_CONTROL_ATTRIBUTE}="${kind}"`, tone ? `${UI_CONTROL_TONE_ATTRIBUTE}="${tone}"` : '', size ? `${UI_CONTROL_SIZE_ATTRIBUTE}="${size}"` : '', iconOnly ? `${UI_CONTROL_ICON_ONLY_ATTRIBUTE}="true"` : ''].filter(Boolean).join(' ');
}
function clamp(value: number, min = 0, max = 100): number { return Math.max(min, Math.min(max, value)); }
function normalizedRatio(value: number): number { return clamp(value > 1 ? value : value * 100); }

function fallbackOwner(ownerId: string): ActorMemoryOwnerView {
  const key = ownerId.toLowerCase();
  const kind: MemoryOwner['kind'] = key.includes('player') ? 'player' : key.includes('narrator') ? 'narrator' : key.includes('world') ? 'world' : key.includes('unknown') ? 'unknown' : 'actor';
  const displayName = kind === 'player' ? '玩家' : kind === 'narrator' ? '旁白' : kind === 'world' ? '世界' : kind === 'unknown' ? '未知主体' : ownerId.split(':').filter(Boolean).at(-1) || ownerId;
  return { id: ownerId, displayName, aliases: [], kind, memoryTraits: undefined };
}
function ownerOrder(owner: ActorMemoryOwnerView): number { return owner.kind === 'actor' ? 0 : owner.kind === 'player' ? 1 : owner.kind === 'narrator' ? 2 : owner.kind === 'world' ? 3 : 4; }
function resolveOwners(state: ActorMemoryViewState): ActorMemoryOwnerView[] {
  const actorMap = new Map(state.actors.map(actor => [actor.id, actor] as const));
  return [...new Set(state.traces.map(trace => trace.ownerId))].map(ownerId => {
    const actor = actorMap.get(ownerId);
    return actor ? { id: actor.id, displayName: actor.displayName, aliases: actor.aliases, kind: actor.kind, memoryTraits: actor.memoryTraits } : fallbackOwner(ownerId);
  }).sort((left, right) => ownerOrder(left) - ownerOrder(right) || left.displayName.localeCompare(right.displayName, 'zh-CN'));
}
function effectiveStrengthFor(trace: ActorMemoryTrace, owner: ActorMemoryOwnerView | undefined, now: number): number {
  return effectiveMemoryStrength(trace, now, { traits: { ...DEFAULT_MEMORY_TRAITS, ...(owner?.memoryTraits ?? {}) } });
}
export function actorMemoryLevel(strength: number): ActorMemoryLevel {
  return strength >= MEMORY_STRENGTH_LEVELS.exact ? 'exact' : strength >= MEMORY_STRENGTH_LEVELS.clear ? 'clear' : strength >= MEMORY_STRENGTH_LEVELS.gist ? 'gist' : strength >= MEMORY_STRENGTH_LEVELS.fragment ? 'fragment' : 'forgotten';
}
function badgeTone(mode: MemoryKnowledgeMode, privacy: MemoryPrivacy): string {
  if (privacy === 'private' || privacy === 'secret') return 'is-private';
  if (mode === 'asserted' || mode === 'experienced' || mode === 'self_reported') return 'is-success';
  if (mode === 'heard' || mode === 'believed') return 'is-info';
  if (mode === 'suspected' || mode === 'inferred') return 'is-warning';
  return '';
}
function packetLine(packet: MemoryRecallPacket | null): string {
  if (!packet) return '当前有效强度低于 1，不生成召回包。';
  const detail = packet.details.map(unit => unit.text).filter(Boolean).join('；');
  return detail ? `${packet.gist}（${detail}）` : packet.gist;
}
function previewDetails(packet: MemoryRecallPacket | null): string {
  if (!packet?.details.length) return '无可用细节单元';
  return packet.details.map(detail => `${detail.sensitivity === 'exact' ? '完整细节' : '大意'}：${detail.text}`).join('；');
}
export function buildActorMemoryGaugePreview(trace: ActorMemoryTrace, fact: ActorMemoryFact, strength: number): MemoryRecallPacket | null {
  return buildMemoryRecallPacketAtStrength(trace, fact, strength, 'actor-memory-gauge');
}
export function updateActorMemoryGaugeZone(zone: HTMLElement, trace: ActorMemoryTrace, fact: ActorMemoryFact, strength: number): void {
  const packet = buildActorMemoryGaugePreview(trace, fact, strength);
  const set = (selector: string, value: string): void => { const target = zone.querySelector<HTMLElement>(selector); if (target) target.textContent = value; };
  set('[data-actor-memory-preview-strength]', String(Math.round(clamp(strength))));
  set('[data-actor-memory-preview-gist]', packet?.gist ?? '不生成召回包');
  set('[data-actor-memory-preview-details]', previewDetails(packet));
  set('[data-actor-memory-preview-clarity]', String(packet ? Math.round(packet.clarity) : 0));
  set('[data-actor-memory-preview-omitted]', `${packet?.omittedDetailCount ?? 2} 项`);
}

function visibleTraces(state: ActorMemoryViewState, owners: readonly ActorMemoryOwnerView[], strengths: ReadonlyMap<string, number>): ActorMemoryTrace[] {
  const factMap = new Map(state.facts.map(fact => [fact.id, fact] as const));
  const observationMap = new Map(state.observations.map(observation => [observation.id, observation] as const));
  const owner = owners.find(item => item.id === state.selectedOwnerId);
  const query = state.query.trim().toLocaleLowerCase('zh-CN');
  return state.traces.filter(trace => trace.ownerId === owner?.id).filter(trace => {
    if (state.knowledgeMode && trace.knowledgeMode !== state.knowledgeMode) return false;
    if (state.privacy && trace.privacy !== state.privacy) return false;
    if (state.level && actorMemoryLevel(strengths.get(trace.id) ?? 0) !== state.level) return false;
    if (!query) return true;
    const fact = factMap.get(trace.factId);
    const observations = trace.sourceObservationIds.map(id => observationMap.get(id)).filter((item): item is MemoryObservation => Boolean(item));
    return [owner?.displayName ?? '', ...(owner?.aliases ?? []), fact?.content ?? '', KNOWLEDGE_LABELS[trace.knowledgeMode], PRIVACY_LABELS[trace.privacy], ...observations.flatMap(observation => [observation.excerpt, observation.sourceRef])].join(' ').toLocaleLowerCase('zh-CN').includes(query);
  }).sort((left, right) => {
    if (state.sort === 'effective_desc') return (strengths.get(right.id) ?? 0) - (strengths.get(left.id) ?? 0);
    if (state.sort === 'clarity_desc') return right.clarity - left.clarity || right.updatedAt - left.updatedAt;
    if (state.sort === 'confidence_desc') return right.beliefConfidence - left.beliefConfidence || right.updatedAt - left.updatedAt;
    if (state.sort === 'emotion_desc') return normalizedRatio(right.emotionalSalience) - normalizedRatio(left.emotionalSalience) || right.updatedAt - left.updatedAt;
    if (state.sort === 'rehearsal_desc') return right.rehearsalCount - left.rehearsalCount || right.updatedAt - left.updatedAt;
    return right.updatedAt - left.updatedAt;
  });
}

export function selectActorMemoryView(state: ActorMemoryViewState): ActorMemorySelection {
  const owners = resolveOwners(state);
  const selectedOwner = owners.find(owner => owner.id === state.selectedOwnerId) ?? owners[0];
  const ownerMap = new Map(owners.map(owner => [owner.id, owner] as const));
  const strengths = new Map(state.traces.map(trace => [trace.id, effectiveStrengthFor(trace, ownerMap.get(trace.ownerId), state.now)] as const));
  const traces = visibleTraces({ ...state, selectedOwnerId: selectedOwner?.id ?? '' }, owners, strengths);
  const selectedTrace = traces.find(trace => trace.id === state.selectedTraceId) ?? traces[0];
  const selectedFact = selectedTrace ? state.facts.find(fact => fact.id === selectedTrace.factId) : undefined;
  const observationMap = new Map(state.observations.map(observation => [observation.id, observation] as const));
  const selectedObservations = selectedTrace ? selectedTrace.sourceObservationIds.map(id => observationMap.get(id)).filter((item): item is MemoryObservation => Boolean(item)) : [];
  const averageStrength = state.traces.length ? state.traces.reduce((sum, trace) => sum + (strengths.get(trace.id) ?? 0), 0) / state.traces.length : 0;
  return {
    owners, selectedOwner, visibleTraces: traces, selectedTrace, selectedFact, selectedObservations, effectiveStrengths: strengths,
    metrics: { traces: state.traces.length, owners: owners.length, averageStrength: Math.round(averageStrength), privateCount: state.traces.filter(trace => trace.privacy === 'private' || trace.privacy === 'secret').length },
  };
}
export function normalizeActorMemorySelection(state: ActorMemoryViewState): void {
  const selection = selectActorMemoryView(state);
  state.selectedOwnerId = selection.selectedOwner?.id ?? '';
  state.selectedTraceId = selection.selectedTrace?.id ?? '';
}

function renderMetric(icon: string, label: string, value: number, note: string): string {
  return `<article class="stx-memory-actor-memory-metric"><span class="stx-memory-actor-memory-metric-icon"><ss-helper-icon name="${icon}" decorative></ss-helper-icon></span><div><small>${escapeHtml(label)}</small><strong>${value}</strong></div><span>${escapeHtml(note)}</span></article>`;
}
function renderOwnerList(state: ActorMemoryViewState, selection: ActorMemorySelection): string {
  const groups: Array<{ key: ActorMemoryGroup; label: string; owners: ActorMemoryOwnerView[] }> = [
    { key: 'people', label: '人物', owners: selection.owners.filter(owner => owner.kind === 'actor') },
    { key: 'system', label: '系统主体', owners: selection.owners.filter(owner => owner.kind !== 'actor') },
  ];
  return groups.filter(group => group.owners.length > 0).map((group) => {
    const collapsed = state.collapsedGroups.includes(group.key);
    const traceCount = group.owners.reduce((sum, owner) => sum + state.traces.filter(trace => trace.ownerId === owner.id).length, 0);
    const rows = group.owners.map(owner => {
    const traces = state.traces.filter(trace => trace.ownerId === owner.id);
    const average = traces.length ? Math.round(traces.reduce((sum, trace) => sum + (selection.effectiveStrengths.get(trace.id) ?? 0), 0) / traces.length) : 0;
    const privateCount = traces.filter(trace => trace.privacy === 'private' || trace.privacy === 'secret').length;
    return `<button class="stx-memory-actor-memory-owner-row" ${control('button', 'neutral')} type="button" data-action="actor-memory-select-owner" data-owner-id="${escapeHtml(owner.id)}" aria-selected="${owner.id === selection.selectedOwner?.id}"><span class="stx-memory-actor-memory-owner-avatar">${escapeHtml([...owner.displayName][0] ?? '人')}</span><span class="stx-memory-actor-memory-owner-main"><strong>${escapeHtml(owner.displayName)}</strong><small>${traces.length} 条痕迹${privateCount ? ` · ${privateCount} 条私密` : ''}</small></span><span class="stx-memory-actor-memory-owner-stat"><strong>${average}</strong><small>平均强度</small></span></button>`;
    }).join('');
    return `<section class="stx-memory-actor-memory-owner-group"><button class="stx-memory-actor-memory-owner-group-toggle" ${control('button', 'neutral')} type="button" data-action="actor-memory-toggle-group" data-group="${group.key}" aria-expanded="${!collapsed}" aria-controls="stx-memory-owner-group-${group.key}"><ss-helper-icon name="chevron-down" decorative></ss-helper-icon><span class="stx-memory-actor-memory-owner-group-copy"><strong>${group.label}</strong><small>${traceCount} 条认知痕迹</small></span><span class="stx-memory-actor-memory-owner-group-count">${group.owners.length}</span></button><div class="stx-memory-actor-memory-owner-group-items" id="stx-memory-owner-group-${group.key}" ${collapsed ? 'hidden' : ''}>${rows}</div></section>`;
  }).join('');
}
function renderTraceList(state: ActorMemoryViewState, selection: ActorMemorySelection, options: ActorMemoryViewOptions): string {
  const factMap = new Map(state.facts.map(fact => [fact.id, fact] as const));
  if (!selection.visibleTraces.length) return `<div class="stx-memory-empty"><strong>没有匹配的角色记忆</strong><p>请清除搜索词，或调整知情方式、隐私和记忆层级筛选。</p></div>`;
  return selection.visibleTraces.map(trace => {
    const fact = factMap.get(trace.factId);
    const strength = selection.effectiveStrengths.get(trace.id) ?? 0;
    const level = actorMemoryLevel(strength);
    return `<button class="stx-memory-actor-memory-trace-row" ${control('button', 'neutral')} type="button" data-action="actor-memory-select-trace" data-trace-id="${escapeHtml(trace.id)}" aria-selected="${trace.id === selection.selectedTrace?.id}"><span class="stx-memory-actor-memory-trace-top"><span><span class="stx-memory-actor-memory-badge ${badgeTone(trace.knowledgeMode, trace.privacy)}">${KNOWLEDGE_LABELS[trace.knowledgeMode]}</span><span class="stx-memory-actor-memory-badge">${PRIVACY_LABELS[trace.privacy]}</span><span class="stx-memory-actor-memory-badge is-accent">${LEVEL_LABELS[level]}</span></span><time datetime="${new Date(trace.updatedAt).toISOString()}">${escapeHtml(options.formatTime(trace.updatedAt))}</time></span><span class="stx-memory-actor-memory-trace-content">${escapeHtml(fact?.content ?? '关联事实不可用')}</span><span class="stx-memory-actor-memory-trace-bottom"><span>${trace.floor === undefined ? '' : `第 ${trace.floor} 层 · `}${trace.sourceObservationIds.length} 条观察</span><span class="stx-memory-actor-memory-mini-metric"><span>有效强度</span><span class="stx-memory-actor-memory-mini-track"><span style="width:${clamp(strength)}%"></span></span><strong>${Math.round(strength)}</strong></span></span></button>`;
  }).join('');
}
function renderGaugeTooltip(trace: ActorMemoryTrace, fact: ActorMemoryFact, stage: MemoryStage, current: boolean): string {
  const packet = buildActorMemoryGaugePreview(trace, fact, stage.preview);
  return `<span class="stx-memory-actor-memory-gauge-tooltip" role="tooltip"><header><strong>${stage.label}</strong><span>${stage.range}</span></header><dl><dt>模拟强度</dt><dd><strong data-actor-memory-preview-strength>${stage.preview}</strong></dd><dt>召回包主旨</dt><dd data-actor-memory-preview-gist>${escapeHtml(packet?.gist ?? '不生成召回包')}</dd><dt>可用细节</dt><dd data-actor-memory-preview-details>${escapeHtml(previewDetails(packet))}</dd><dt>输出清晰度</dt><dd data-actor-memory-preview-clarity>${packet ? Math.round(packet.clarity) : 0}</dd><dt>省略细节</dt><dd data-actor-memory-preview-omitted>${packet?.omittedDetailCount ?? 2} 项</dd></dl><footer>${current ? '当前记忆正处于这一阶段。' : '按实际召回包规则预览，不会改变真实强度。'}</footer></span>`;
}
function nextLevelInfo(strength: number): { target: number; label: string } | undefined {
  if (strength < 25) return { target: 25, label: '模糊片段' }; if (strength < 45) return { target: 45, label: '大意记忆' }; if (strength < 65) return { target: 65, label: '清晰记忆' }; if (strength < 85) return { target: 85, label: '完整细节' }; return undefined;
}
function renderMemoryGauge(trace: ActorMemoryTrace, fact: ActorMemoryFact, strength: number): string {
  const safe = clamp(strength); const level = actorMemoryLevel(safe); const next = nextLevelInfo(safe);
  const descriptions: Readonly<Record<ActorMemoryLevel, string>> = { forgotten: '仅产生模糊主旨，强度低于 1 时不会生成召回包', fragment: '召回包开始携带大意细节，但主旨仍可能模糊', gist: '主旨变为事实大意，并保留大意细节', clear: '主旨与大意保持清晰，但仍不输出完整事实细节', exact: '召回包可以同时携带大意与完整事实细节' };
  return `<div class="stx-memory-actor-memory-indicator" role="group" aria-label="当前记忆强度指示器"><div class="stx-memory-actor-memory-indicator-head"><div><strong>记忆召回指示器</strong><small>悬浮进度条分段，按对应强度实时预览召回包</small></div><div><b>${Math.round(safe)}</b><span>${LEVEL_LABELS[level]}</span></div></div><div class="stx-memory-actor-memory-gauge" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(safe)}" aria-valuetext="${LEVEL_LABELS[level]}" style="--stx-actor-memory-strength:${safe.toFixed(2)}%"><div class="stx-memory-actor-memory-gauge-track"><span class="stx-memory-actor-memory-gauge-fill"></span><div class="stx-memory-actor-memory-gauge-zones">${MEMORY_STAGES.map((stage, index) => `<button class="stx-memory-actor-memory-gauge-zone ${stage.key === level ? 'is-current' : ''} ${index === 0 ? 'is-first' : index === MEMORY_STAGES.length - 1 ? 'is-last' : ''}" type="button" data-action="actor-memory-toggle-gauge-zone" data-actor-memory-zone="${stage.key}" data-trace-id="${escapeHtml(trace.id)}" data-fact-id="${escapeHtml(fact.id)}" data-start="${stage.start}" data-end="${stage.end}" aria-label="${stage.label}，强度 ${stage.range}，查看真实召回预览" style="left:${stage.start}%;width:${stage.end - stage.start}%">${renderGaugeTooltip(trace, fact, stage, stage.key === level)}</button>`).join('')}</div>${[25,45,65,85].map(value => `<span class="stx-memory-actor-memory-threshold" style="left:${value}%" data-value="${value}"></span>`).join('')}<span class="stx-memory-actor-memory-gauge-marker"></span><span class="stx-memory-actor-memory-gauge-bubble">${Math.round(safe)}</span><span class="stx-memory-actor-memory-gauge-end is-start">0</span><span class="stx-memory-actor-memory-gauge-end is-end">100</span></div><div class="stx-memory-actor-memory-gauge-labels">${MEMORY_STAGES.map(stage => `<span class="${stage.key === level ? 'is-current' : ''}">${stage.label}</span>`).join('')}</div></div><div class="stx-memory-actor-memory-indicator-result"><span><strong>${LEVEL_LABELS[level]}</strong>：${descriptions[level]}。</span><span>${next ? `距“${next.label}”还差 ${Math.max(1, Math.ceil(next.target-safe))} 点` : '已达到最高细节层级'}</span></div></div>`;
}
function renderOverviewTab(selection: ActorMemorySelection, options: ActorMemoryViewOptions, now: number): string {
  const trace = selection.selectedTrace!; const fact = selection.selectedFact!; const owner = selection.selectedOwner!; const strength = selection.effectiveStrengths.get(trace.id) ?? 0; const level = actorMemoryLevel(strength);
  const packet = buildMemoryRecallPacket(trace, fact, now, `actor-memory:${trace.floor ?? 'default'}`, { traits: { ...DEFAULT_MEMORY_TRAITS, ...(owner.memoryTraits ?? {}) } });
  const cards = [['原始强度', trace.strength, 'is-accent'], ['当前有效强度', strength, 'is-success'], ['清晰度', trace.clarity, 'is-info'], ['信念置信度', trace.beliefConfidence*100, 'is-belief']] as const;
  return `<div class="stx-memory-actor-memory-tab-panel"><section class="stx-memory-actor-memory-section"><div class="stx-memory-actor-memory-section-title"><div><h3>当前能够回忆到的内容</h3><p>展示实际会写入角色记忆分区的召回包文本</p></div><span class="stx-memory-actor-memory-badge is-accent">${LEVEL_LABELS[level]}</span></div><div class="stx-memory-actor-memory-recall-preview"><div><strong>${escapeHtml(owner.displayName)} 当前的召回包</strong><p>${escapeHtml(packetLine(packet))}</p></div><div><b>${Math.round(strength)}</b><small>当前有效强度<br>${LEVEL_LABELS[level]}</small></div></div>${renderMemoryGauge(trace, fact, strength)}</section><section class="stx-memory-actor-memory-section"><div class="stx-memory-actor-memory-section-title"><div><h3>记忆状态</h3><p>原始痕迹和当前有效结果分开显示</p></div></div><div class="stx-memory-actor-memory-strength-grid">${cards.map(([label,value,tone]) => `<article><header><span>${label}</span><strong>${Math.round(value)}${label === '信念置信度' ? '%' : ''}</strong></header><div class="stx-memory-actor-memory-meter ${tone}"><span style="width:${clamp(value)}%"></span></div></article>`).join('')}</div></section><section class="stx-memory-actor-memory-section"><div class="stx-memory-actor-memory-section-title"><div><h3>关联事实</h3><p>角色记忆痕迹指向记忆块中的客观事实</p></div></div><div class="stx-memory-actor-memory-content-card"><p>${escapeHtml(fact.content)}</p></div><small class="stx-memory-actor-memory-updated">事实更新：${escapeHtml(options.formatTime(fact.updatedAt))}</small></section></div>`;
}
function renderSourceTab(selection: ActorMemorySelection, options: ActorMemoryViewOptions): string {
  const trace = selection.selectedTrace!; const fact = selection.selectedFact!; const owner = selection.selectedOwner!; const ownerMap = new Map(selection.owners.map(item => [item.id,item.displayName] as const));
  return `<div class="stx-memory-actor-memory-tab-panel"><section class="stx-memory-actor-memory-section"><div class="stx-memory-actor-memory-section-title"><div><h3>认知边界</h3><p>说明这个主体通过什么方式知道这条内容</p></div></div><div class="stx-memory-actor-memory-knowledge-grid"><article><h4>认知属性</h4><dl><div><dt>主体</dt><dd>${escapeHtml(owner.displayName)}</dd></div><div><dt>知情方式</dt><dd>${KNOWLEDGE_LABELS[trace.knowledgeMode]}</dd></div><div><dt>隐私级别</dt><dd>${PRIVACY_LABELS[trace.privacy]}</dd></div><div><dt>来源观察</dt><dd>${selection.selectedObservations.length} 条</dd></div></dl></article><article><h4>强化因素</h4><dl><div><dt>情绪显著度</dt><dd>${Math.round(normalizedRatio(trace.emotionalSalience))}%</dd></div><div><dt>复述次数</dt><dd>${trace.rehearsalCount}</dd></div><div><dt>最后复述</dt><dd>${trace.lastRehearsedAt ? escapeHtml(options.formatTime(trace.lastRehearsedAt)) : '无'}</dd></div><div><dt>痕迹修订</dt><dd>第 ${trace.traceRevision} 版</dd></div></dl></article></div></section><section class="stx-memory-actor-memory-section"><div class="stx-memory-actor-memory-section-title"><div><h3>来源观察</h3><p>观察记录决定亲历、听闻、传闻或私密思想的归属</p></div><span>${selection.selectedObservations.length} 条</span></div><div class="stx-memory-actor-memory-observation-list">${selection.selectedObservations.length ? selection.selectedObservations.map(observation => `<article><div class="stx-memory-actor-memory-observation-head"><span><span class="stx-memory-actor-memory-badge ${badgeTone(observation.knowledgeMode, observation.privacy)}">${CHANNEL_LABELS[observation.channel]}</span><span class="stx-memory-actor-memory-badge">${PRIVACY_LABELS[observation.privacy]}</span></span><time datetime="${new Date(observation.occurredAt).toISOString()}">${escapeHtml(options.formatTime(observation.occurredAt))}</time></div><p>${escapeHtml(observation.excerpt)}</p><footer><span>说话者：${escapeHtml(ownerMap.get(observation.speakerOwnerId) ?? fallbackOwner(observation.speakerOwnerId).displayName)} · 视角：${escapeHtml(ownerMap.get(observation.viewpointOwnerId) ?? fallbackOwner(observation.viewpointOwnerId).displayName)}</span>${options.renderSourceReference(observation.sourceRef,'evidence')}</footer></article>`).join('') : '<p class="stx-memory-muted">该痕迹没有可展示的观察来源。</p>'}</div></section><section class="stx-memory-actor-memory-section"><div class="stx-memory-actor-memory-section-title"><div><h3>事实证据</h3><p>用于核对关联事实是否忠于来源原文</p></div><span>${fact.evidence.length} 条</span></div><div class="stx-memory-actor-memory-evidence-list">${fact.evidence.length ? fact.evidence.map(evidence => `<article><div><strong>证据来源</strong>${options.renderSourceReference(evidence.sourceRef,'evidence')}</div><blockquote>${escapeHtml(evidence.excerpt)}</blockquote></article>`).join('') : '<p class="stx-memory-muted">关联事实暂无可展示证据。</p>'}</div></section></div>`;
}
function renderTechnicalTab(selection: ActorMemorySelection, options: ActorMemoryViewOptions): string {
  const trace=selection.selectedTrace!; const fact=selection.selectedFact!; const owner=selection.selectedOwner!; const strength=selection.effectiveStrengths.get(trace.id) ?? 0; const traits={...DEFAULT_MEMORY_TRAITS,...(owner.memoryTraits??{})};
  const cards: Array<[string,Array<[string,string]>]>=[['痕迹标识',[['Trace ID',trace.id],['Owner ID',trace.ownerId],['Fact ID',trace.factId],['聊天键',trace.chatKey??'当前工作区共享'],['来源楼层',trace.floor===undefined?'无':String(trace.floor)]]],['时间与版本',[['创建时间',options.formatTime(trace.createdAt)],['更新时间',options.formatTime(trace.updatedAt)],['最后复述',trace.lastRehearsedAt?options.formatTime(trace.lastRehearsedAt):'无'],['痕迹版本',String(trace.traceRevision)],['观察 ID',trace.sourceObservationIds.join('、')||'无']]],['主体记忆特性',[['记忆半衰期',`${Math.round(traits.halfLifeMs/86_400_000)} 天`],['复述增益',String(traits.rehearsalGain)],['情绪增益',String(traits.emotionalGain)],['干扰惩罚',String(traits.interference)]]],['当前计算结果',[['原始强度',String(trace.strength)],['有效强度',strength.toFixed(2)],['记忆层级',LEVEL_LABELS[actorMemoryLevel(strength)]],['情绪显著度',`${Math.round(normalizedRatio(trace.emotionalSalience))}%`],['事实更新时间',options.formatTime(fact.updatedAt)]]]];
  return `<div class="stx-memory-actor-memory-tab-panel"><section class="stx-memory-actor-memory-section"><div class="stx-memory-actor-memory-section-title"><div><h3>技术信息</h3><p>用于调试痕迹、事实和强度计算</p></div><span class="stx-memory-actor-memory-badge">只读</span></div><div class="stx-memory-actor-memory-technical-grid">${cards.map(([title,rows])=>`<article><h4>${title}</h4><dl>${rows.map(([label,value])=>`<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl></article>`).join('')}</div></section></div>`;
}
function renderInspector(state: ActorMemoryViewState, selection: ActorMemorySelection, options: ActorMemoryViewOptions): string {
  const trace=selection.selectedTrace; const fact=selection.selectedFact; const owner=selection.selectedOwner;
  if(!trace||!owner)return `<div class="stx-memory-empty"><strong>选择一条角色记忆</strong><p>这里会显示当前主体能够回忆到的内容、来源认知和技术状态。</p></div>`;
  if(!fact)return `<div class="stx-memory-empty"><strong>关联事实不可用</strong><p>痕迹仍然存在，但对应事实可能已经删除或不属于当前聊天。</p></div>`;
  const strength=selection.effectiveStrengths.get(trace.id)??0; const level=actorMemoryLevel(strength);
  return `<div class="stx-memory-actor-memory-detail-head"><div><span class="stx-memory-kicker">角色认知痕迹 · 只读</span><h2>${escapeHtml(owner.displayName)}</h2><p>${KNOWLEDGE_LABELS[trace.knowledgeMode]} · ${PRIVACY_LABELS[trace.privacy]} · 更新于 ${escapeHtml(options.formatTime(trace.updatedAt))}</p></div><div class="stx-memory-actor-memory-detail-actions" role="group" aria-label="关联入口"><button class="is-primary" ${control('button','neutral','sm')} type="button" data-action="actor-memory-open-fact" data-fact-id="${escapeHtml(fact.id)}"><ss-helper-icon name="book-open" decorative></ss-helper-icon><span>记忆块</span></button><button ${control('button','neutral','sm')} type="button" data-action="actor-memory-open-owner" data-owner-id="${escapeHtml(owner.id)}"><ss-helper-icon name="address-card" decorative></ss-helper-icon><span>人物主档</span></button></div></div><dl class="stx-memory-actor-memory-detail-metrics"><div><dt>记忆层级</dt><dd>${LEVEL_LABELS[level]}</dd></div><div><dt>有效强度</dt><dd>${Math.round(strength)}</dd></div><div><dt>清晰度</dt><dd>${Math.round(trace.clarity)}</dd></div><div><dt>信念置信度</dt><dd>${Math.round(trace.beliefConfidence*100)}%</dd></div><div><dt>情绪显著度</dt><dd>${Math.round(normalizedRatio(trace.emotionalSalience))}%</dd></div><div><dt>复述次数</dt><dd>${trace.rehearsalCount}</dd></div></dl><div class="stx-memory-actor-memory-tabs" ${control('segmented')} role="tablist" aria-label="角色记忆详情"><button ${control('button','neutral','sm')} type="button" role="tab" data-action="actor-memory-set-tab" data-tab="overview" aria-selected="${state.tab==='overview'}">回忆预览</button><button ${control('button','neutral','sm')} type="button" role="tab" data-action="actor-memory-set-tab" data-tab="source" aria-selected="${state.tab==='source'}">来源认知</button><button ${control('button','neutral','sm')} type="button" role="tab" data-action="actor-memory-set-tab" data-tab="technical" aria-selected="${state.tab==='technical'}">技术信息</button></div>${state.tab==='overview'?renderOverviewTab(selection,options,state.now):state.tab==='source'?renderSourceTab(selection,options):renderTechnicalTab(selection,options)}`;
}
function optionEntries<T extends string>(labels: Readonly<Record<T,string>>, current: string): string { return Object.entries<string>(labels).map(([value,label])=>`<option value="${escapeHtml(value)}" ${current===value?'selected':''}>${escapeHtml(label)}</option>`).join(''); }

export function renderActorMemoryPage(state: ActorMemoryViewState, options: ActorMemoryViewOptions): string {
  const selection=selectActorMemoryView(state); const selectedStrength=selection.selectedTrace?selection.effectiveStrengths.get(selection.selectedTrace.id)??0:0; const selectedLevel=actorMemoryLevel(selectedStrength);
  return `<div class="stx-memory-actor-memory-shell"><section class="stx-memory-actor-memory-metrics" aria-label="角色记忆统计">${renderMetric('brain','记忆痕迹',selection.metrics.traces,'当前聊天')}${renderMetric('users','包含主体',selection.metrics.owners,'人物与系统主体')}${renderMetric('gauge-high','平均有效强度',selection.metrics.averageStrength,'随时间变化')}${renderMetric('lock','私密或秘密',selection.metrics.privateCount,'严格主体隔离')}</section><div class="stx-memory-actor-memory-toolbar"><label class="stx-memory-actor-memory-search"><span class="stx-memory-sr-only">搜索角色记忆</span><ss-helper-icon name="magnifying-glass" decorative></ss-helper-icon><input ${control('input')} data-actor-memory-input="query" value="${escapeHtml(state.query)}" placeholder="搜索记忆内容、人物或来源"></label><label><span class="stx-memory-sr-only">知情方式</span><select ${control('select')} data-actor-memory-select="knowledge" aria-label="知情方式"><option value="">全部知情方式</option>${optionEntries(KNOWLEDGE_LABELS,state.knowledgeMode)}</select></label><label><span class="stx-memory-sr-only">隐私级别</span><select ${control('select')} data-actor-memory-select="privacy" aria-label="隐私级别"><option value="">全部隐私级别</option>${optionEntries(PRIVACY_LABELS,state.privacy)}</select></label><label><span class="stx-memory-sr-only">记忆层级</span><select ${control('select')} data-actor-memory-select="level" aria-label="记忆层级"><option value="">全部记忆层级</option>${optionEntries(LEVEL_LABELS,state.level)}</select></label><label><span class="stx-memory-sr-only">排序</span><select ${control('select')} data-actor-memory-select="sort" aria-label="排序">${optionEntries(SORT_LABELS,state.sort)}</select></label><button ${control('button','neutral')} type="button" data-action="actor-memory-refresh"><ss-helper-icon name="rotate" decorative></ss-helper-icon>刷新</button></div><div class="stx-memory-actor-memory-grid"><aside class="stx-memory-actor-memory-panel stx-memory-actor-memory-owner-panel" aria-label="主体列表"><div class="stx-memory-actor-memory-panel-header"><div><h2>主体</h2><p>按人物查看独立认知</p></div><span>${selection.owners.length} 个</span></div><div class="stx-memory-actor-memory-owner-list">${selection.owners.length?renderOwnerList(state,selection):'<div class="stx-memory-empty"><strong>暂无记忆主体</strong><p>只有存在角色记忆痕迹的主体才会显示。</p></div>'}</div></aside><section class="stx-memory-actor-memory-panel stx-memory-actor-memory-trace-panel" aria-label="记忆痕迹列表"><div class="stx-memory-actor-memory-panel-header"><div><h2>认知痕迹</h2><p>同一事实在不同主体中可以具有不同认知</p></div><span>${selection.visibleTraces.length} 条</span></div><div class="stx-memory-actor-memory-result-line"><span>${escapeHtml(selection.selectedOwner?.displayName??'全部主体')} · ${selection.visibleTraces.length} 条</span><span>${SORT_LABELS[state.sort]}</span></div><div class="stx-memory-actor-memory-trace-list">${renderTraceList(state,selection,options)}</div></section><section class="stx-memory-actor-memory-panel stx-memory-actor-memory-inspector-panel" id="stx-memory-actor-memory-inspector" aria-label="角色记忆详情" tabindex="-1"><div class="stx-memory-actor-memory-panel-header"><div><h2>记忆审阅</h2><p>召回结果、来源认知和技术状态</p></div><span>${selection.selectedTrace?LEVEL_LABELS[selectedLevel]:'未选择'}</span></div><div class="stx-memory-actor-memory-inspector">${renderInspector(state,selection,options)}</div></section></div></div>`;
}

export const ACTOR_MEMORY_LABELS = Object.freeze({ knowledge: KNOWLEDGE_LABELS, privacy: PRIVACY_LABELS, level: LEVEL_LABELS, sort: SORT_LABELS });
