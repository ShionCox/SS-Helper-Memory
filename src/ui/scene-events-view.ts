import {
  UI_CONTROL_ATTRIBUTE,
  UI_CONTROL_ICON_ONLY_ATTRIBUTE,
  UI_CONTROL_SIZE_ATTRIBUTE,
  UI_CONTROL_TONE_ATTRIBUTE,
  type UiControlKind,
  type UiControlSize,
  type UiControlTone,
} from '@ss-helper/sdk';
import type {
  ActorAlias,
  MemoryEpisode,
  MemoryObservation,
  MemoryOwner,
  SceneCast,
  SceneCastMember,
} from '../domain';

export type SceneEventCategory = 'scene' | 'event' | 'observation';

export interface SceneEventsState {
  category: SceneEventCategory;
  query: string;
  filter: string;
  scenes: SceneCast[];
  episodes: MemoryEpisode[];
  observations: MemoryObservation[];
  actors: MemoryOwner[];
  actorAliases: ActorAlias[];
  selectedSceneId: string;
  selectedEpisodeId: string;
  selectedObservationId: string;
  selectedSceneOwnerId: string;
  showSceneBoundaries: boolean;
  showSceneSources: boolean;
  showSceneConfidence: boolean;
}

export interface SceneEventsHeader {
  description: string;
  count: string;
}

interface OwnerDirectory {
  name(ownerId: string): string;
  kind(ownerId: string): string;
  aliases(ownerId: string): string[];
}

interface SceneEventVisibleRecords {
  scenes: SceneCast[];
  episodes: MemoryEpisode[];
  observations: MemoryObservation[];
}

const ROLE_LABELS: Readonly<Record<SceneCastMember['role'], string>> = Object.freeze({
  viewpoint: '视角',
  speaker: '发言者',
  present: '明确在场',
  mentioned: '仅提及',
  narrator: '旁白',
  world: '世界来源',
});

const CHANNEL_LABELS: Readonly<Record<MemoryObservation['channel'], string>> = Object.freeze({
  public_speech: '公开发言',
  private_thought: '私密思想',
  narration: '旁白叙述',
  worldbook: '世界书',
  state: '状态信息',
  rumor: '传闻',
  inference: '推断',
});

const PRIVACY_LABELS: Readonly<Record<MemoryObservation['privacy'], string>> = Object.freeze({
  public: '公开',
  limited: '有限',
  private: '私密',
  secret: '秘密',
});

const KNOWLEDGE_LABELS: Readonly<Record<MemoryObservation['knowledgeMode'], string>> = Object.freeze({
  asserted: '确定陈述',
  self_reported: '本人陈述',
  heard: '听闻',
  experienced: '亲历',
  inferred: '推断',
  believed: '相信',
  suspected: '怀疑',
  unknown: '未知',
});

const FIXED_OWNER_NAMES: Readonly<Record<string, { name: string; kind: string }>> = Object.freeze({
  'owner:player': { name: '玩家', kind: '玩家' },
  'owner:narrator': { name: '旁白', kind: '旁白' },
  'owner:world': { name: '世界', kind: '世界' },
  'owner:unknown': { name: '未知主体', kind: '未知' },
});

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function ownerDirectory(state: Pick<SceneEventsState, 'actors' | 'actorAliases'>): OwnerDirectory {
  const actors = new Map(state.actors.map((actor) => [actor.id, actor]));
  const aliases = new Map<string, string[]>();
  for (const alias of state.actorAliases) {
    const list = aliases.get(alias.ownerId) ?? [];
    if (alias.value && !list.includes(alias.value)) list.push(alias.value);
    aliases.set(alias.ownerId, list);
  }
  return {
    name(ownerId) {
      return actors.get(ownerId)?.displayName ?? FIXED_OWNER_NAMES[ownerId]?.name ?? ownerId;
    },
    kind(ownerId) {
      const kind = actors.get(ownerId)?.kind ?? FIXED_OWNER_NAMES[ownerId]?.kind;
      return kind === 'actor' ? '人物' : kind === 'player' ? '玩家' : kind === 'narrator' ? '旁白' : kind === 'world' ? '世界' : kind === 'unknown' ? '未知' : kind ?? '主体';
    },
    aliases(ownerId) {
      return unique([...(actors.get(ownerId)?.aliases ?? []), ...(aliases.get(ownerId) ?? [])])
        .filter((alias) => alias !== actors.get(ownerId)?.displayName);
    },
  };
}

export function sceneSourceLabel(ref: string): string {
  if (ref.startsWith('message:')) {
    const [, floor, segment, part] = ref.split(':');
    return `聊天消息 #${floor}${segment === 'summary-part' && part !== undefined ? `（第 ${Number(part) + 1} 段）` : ''}`;
  }
  if (ref.startsWith('worldbook:')) return `世界书条目 #${ref.split(':')[2] ?? '未知'}`;
  if (ref.startsWith('state:')) return `聊天状态 · 消息 #${ref.split(':')[1] ?? '未知'}`;
  if (ref.startsWith('host_card:')) return '角色卡';
  return ref;
}

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function sceneSources(scene: SceneCast): string[] {
  return unique(scene.members.flatMap((member) => [...member.sourceRefs]));
}

function mentionedOnly(scene: SceneCast): string[] {
  const active = new Set([...scene.speakerOwnerIds, ...scene.presentOwnerIds]);
  return unique(scene.mentionedOwnerIds).filter((ownerId) => !active.has(ownerId));
}

function sceneOwnerRoles(scene: SceneCast, ownerId: string): SceneCastMember['role'][] {
  return unique(scene.members.filter((member) => member.ownerId === ownerId).map((member) => member.role)) as SceneCastMember['role'][];
}

function sceneOwnerConfidence(scene: SceneCast, ownerId: string): number {
  return Math.max(0, ...scene.members.filter((member) => member.ownerId === ownerId).map((member) => member.confidence));
}

function sceneOwnerSources(scene: SceneCast, ownerId: string): string[] {
  return unique(scene.members.filter((member) => member.ownerId === ownerId).flatMap((member) => [...member.sourceRefs]));
}

function sceneOwnerIds(scene: SceneCast): string[] {
  return unique([
    scene.viewpointOwnerId,
    ...scene.speakerOwnerIds,
    ...scene.presentOwnerIds,
    ...scene.mentionedOwnerIds,
    ...scene.members.map((member) => member.ownerId),
  ]);
}

export function primarySceneRole(scene: SceneCast, ownerId: string): SceneCastMember['role'] {
  const roles = sceneOwnerRoles(scene, ownerId);
  if (ownerId === scene.viewpointOwnerId || roles.includes('viewpoint')) return 'viewpoint';
  if (roles.includes('speaker') || scene.speakerOwnerIds.includes(ownerId)) return 'speaker';
  if (roles.includes('present') || scene.presentOwnerIds.includes(ownerId)) return 'present';
  if (roles.includes('mentioned') || scene.mentionedOwnerIds.includes(ownerId)) return 'mentioned';
  if (roles.includes('world')) return 'world';
  return 'narrator';
}

function sceneRecallDescription(scene: SceneCast, ownerId: string): string {
  const inSingle = ownerId === scene.viewpointOwnerId;
  const inMulti = scene.speakerOwnerIds.includes(ownerId) || scene.presentOwnerIds.includes(ownerId);
  if (inSingle && inMulti) return '进入单视角召回，也进入多角色召回';
  if (inSingle) return '只进入单视角召回';
  if (inMulti) return '进入多角色召回';
  return '不进入当前召回范围';
}

function sceneTitle(scene: SceneCast): string {
  return `第 ${scene.floor} 层即时场景`;
}

function sceneSummary(scene: SceneCast, owners: OwnerDirectory): string {
  const viewpoint = owners.name(scene.viewpointOwnerId);
  const speakers = unique(scene.speakerOwnerIds).map((id) => owners.name(id)).join('、') || '无明确发言者';
  const present = unique(scene.presentOwnerIds).map((id) => owners.name(id)).join('、') || '无明确在场者';
  const mentioned = mentionedOnly(scene).map((id) => owners.name(id)).join('、') || '无仅提及主体';
  return `视角为${viewpoint}；发言：${speakers}；在场：${present}；仅提及：${mentioned}。`;
}

function floorRange(episode: MemoryEpisode): string {
  const start = episode.floorStart;
  const end = episode.floorEnd;
  if (start === undefined && end === undefined) return '楼层未知';
  if (start === undefined || end === undefined || start === end) return `第 ${start ?? end} 层`;
  return `第 ${start}–${end} 层`;
}

function eventTitle(episode: MemoryEpisode): string {
  const summary = episode.summary?.trim();
  if (!summary) return `${floorRange(episode)}事件`;
  const separator = summary.search(/[，。；]/u);
  const title = separator > 5 ? summary.slice(0, separator) : summary.slice(0, 26);
  return title.length < summary.length ? `${title}…` : title;
}

function observationsFor(state: SceneEventsState, episodeId: string): MemoryObservation[] {
  return state.observations
    .filter((observation) => observation.episodeId === episodeId)
    .sort((left, right) => right.occurredAt - left.occurredAt || left.id.localeCompare(right.id));
}

function relatedEventsForScene(state: SceneEventsState, scene: SceneCast): MemoryEpisode[] {
  const sources = new Set(sceneSources(scene));
  return state.episodes.filter((episode) => {
    const start = episode.floorStart ?? Number.NEGATIVE_INFINITY;
    const end = episode.floorEnd ?? Number.POSITIVE_INFINITY;
    return scene.floor >= start && scene.floor <= end || episode.sourceRefs.some((source) => sources.has(source));
  });
}

function relatedScenesForEvent(state: SceneEventsState, episode: MemoryEpisode): SceneCast[] {
  const sources = new Set(episode.sourceRefs);
  return state.scenes.filter((scene) => {
    const start = episode.floorStart ?? Number.NEGATIVE_INFINITY;
    const end = episode.floorEnd ?? Number.POSITIVE_INFINITY;
    return scene.floor >= start && scene.floor <= end || sceneSources(scene).some((source) => sources.has(source));
  });
}

function includesQuery(values: readonly unknown[], query: string): boolean {
  if (!query) return true;
  return values.map((value) => String(value ?? '')).join(' ').toLocaleLowerCase('zh-CN').includes(query);
}

export function getVisibleSceneEventRecords(state: SceneEventsState): SceneEventVisibleRecords {
  const owners = ownerDirectory(state);
  const query = state.query.trim().toLocaleLowerCase('zh-CN');
  const filter = state.filter;
  const scenes = [...state.scenes]
    .sort((left, right) => right.floor - left.floor || right.createdAt - left.createdAt || left.id.localeCompare(right.id))
    .filter((scene) => {
      const ownerIds = sceneOwnerIds(scene);
      const matches = includesQuery([
        sceneTitle(scene),
        sceneSummary(scene, owners),
        scene.floor,
        ...ownerIds.flatMap((id) => [owners.name(id), ...owners.aliases(id)]),
        ...sceneSources(scene).flatMap((source) => [source, sceneSourceLabel(source)]),
      ], query);
      const filterMatches = !filter
        || filter === 'speaker' && scene.speakerOwnerIds.length > 0
        || filter === 'present' && scene.presentOwnerIds.length > 0
        || filter === 'mentioned' && mentionedOnly(scene).length > 0
        || filter === 'world' && scene.members.some((member) => member.role === 'world');
      return matches && filterMatches;
    });
  const episodes = [...state.episodes]
    .sort((left, right) => right.occurredAt - left.occurredAt || (right.floorEnd ?? -1) - (left.floorEnd ?? -1) || left.id.localeCompare(right.id))
    .filter((episode) => {
      const observations = observationsFor(state, episode.id);
      const ownerIds = unique([...episode.participantIds, ...episode.presentOwnerIds, ...episode.mentionedOwnerIds]);
      const matches = includesQuery([
        episode.summary,
        episode.location,
        floorRange(episode),
        ...ownerIds.flatMap((id) => [owners.name(id), ...owners.aliases(id)]),
        ...episode.sourceRefs.flatMap((source) => [source, sceneSourceLabel(source)]),
      ], query);
      const filterMatches = !filter
        || filter === 'multi-floor' && episode.floorStart !== undefined && episode.floorEnd !== undefined && episode.floorStart !== episode.floorEnd
        || filter === 'location' && Boolean(episode.location)
        || filter === 'cause' && Boolean(episode.causalParentIds?.length)
        || filter === 'private' && observations.some((observation) => observation.privacy === 'private' || observation.privacy === 'secret');
      return matches && filterMatches;
    });
  const observations = [...state.observations]
    .sort((left, right) => right.occurredAt - left.occurredAt || left.id.localeCompare(right.id))
    .filter((observation) => {
      const episode = state.episodes.find((item) => item.id === observation.episodeId);
      const ownerIds = unique([
        observation.speakerOwnerId,
        observation.viewpointOwnerId,
        ...observation.observerOwnerIds,
        ...observation.presentOwnerIds,
        ...observation.mentionedOwnerIds,
      ]);
      return includesQuery([
        observation.excerpt,
        CHANNEL_LABELS[observation.channel],
        PRIVACY_LABELS[observation.privacy],
        KNOWLEDGE_LABELS[observation.knowledgeMode],
        episode?.summary,
        ...ownerIds.flatMap((id) => [owners.name(id), ...owners.aliases(id)]),
        observation.sourceRef,
        sceneSourceLabel(observation.sourceRef),
      ], query) && (!filter || observation.channel === filter);
    });
  return { scenes, episodes, observations };
}

export function normalizeSceneEventsSelection(state: SceneEventsState): void {
  const visible = getVisibleSceneEventRecords(state);
  if (!visible.scenes.some((scene) => scene.id === state.selectedSceneId)) {
    state.selectedSceneId = visible.scenes[0]?.id ?? '';
    state.selectedSceneOwnerId = '';
  }
  if (!visible.episodes.some((episode) => episode.id === state.selectedEpisodeId)) state.selectedEpisodeId = visible.episodes[0]?.id ?? '';
  if (!visible.observations.some((observation) => observation.id === state.selectedObservationId)) state.selectedObservationId = visible.observations[0]?.id ?? '';
}

export function getSceneEventsHeader(state: SceneEventsState): SceneEventsHeader {
  const visible = getVisibleSceneEventRecords(state);
  if (state.category === 'event') return {
    description: '结构化事件描述一段完整发生内容，可以跨多个楼层，并记录地点、参与者、来源以及相关观察。',
    count: `${visible.episodes.length} 个结构化事件`,
  };
  if (state.category === 'observation') return {
    description: '观察记录说明某个主体通过什么渠道、以什么隐私级别和知情方式获得了一段信息。',
    count: `${visible.observations.length} 条观察记录`,
  };
  return {
    description: '即时场景记录某一楼层当下的视角、发言者、明确在场者和仅提及者，用于限制角色记忆召回范围。',
    count: `${visible.scenes.length} 个即时场景`,
  };
}

function renderSourceButton(source: string): string {
  return `<button class="stx-memory-scene-source-link" ${uiButton('neutral', 'xs')} type="button" data-action="scene-open-source" data-source-ref="${escapeHtml(source)}">${escapeHtml(sceneSourceLabel(source))}</button>`;
}

function renderOwnerButton(ownerId: string, owners: OwnerDirectory, tone: UiControlTone = 'neutral'): string {
  return `<button class="stx-memory-scene-owner-chip" ${uiButton(tone, 'xs')} type="button" data-action="scene-open-owner" data-owner-id="${escapeHtml(ownerId)}">${escapeHtml(owners.name(ownerId))}</button>`;
}

function renderRoleCard(title: string, ownerIds: readonly string[], description: string, owners: OwnerDirectory, tone: UiControlTone): string {
  const values = unique(ownerIds);
  return `<article class="stx-memory-scene-role-card"><div class="stx-memory-scene-role-head"><strong>${escapeHtml(title)}</strong><span>${values.length}</span></div><div class="stx-memory-scene-owner-list">${values.length ? values.map((ownerId) => renderOwnerButton(ownerId, owners, tone)).join('') : statusChip('无')}</div><p>${escapeHtml(description)}</p></article>`;
}

function headingWithIcon(icon: string, title: string): string {
  return `<span class="stx-memory-scene-heading-label"><ss-helper-icon name="${icon}" decorative></ss-helper-icon><span>${escapeHtml(title)}</span></span>`;
}

function renderRecordLink(category: SceneEventCategory, id: string, title: string, detail: string): string {
  const icon = category === 'event' ? 'timeline' : category === 'observation' ? 'eye' : 'location-crosshairs';
  return `<button class="stx-memory-scene-link-card" ${uiControl('button', 'neutral')} type="button" data-action="scene-open-record" data-category="${category}" data-record-id="${escapeHtml(id)}"><span class="stx-memory-scene-link-icon" aria-hidden="true"><ss-helper-icon name="${icon}" decorative></ss-helper-icon></span><span class="stx-memory-scene-link-copy"><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></span><ss-helper-icon class="stx-memory-scene-link-arrow" name="chevron-right" decorative></ss-helper-icon></button>`;
}

function renderCategorySwitch(state: SceneEventsState): string {
  const cards: Array<{ category: SceneEventCategory; icon: string; title: string; detail: string; count: number }> = [
    { category: 'scene', icon: 'location-crosshairs', title: '即时场景', detail: '某一楼层当下的视角、发言、在场与提及边界', count: state.scenes.length },
    { category: 'event', icon: 'timeline', title: '结构化事件', detail: '跨楼层的一段完整发生内容、地点与参与关系', count: state.episodes.length },
    { category: 'observation', icon: 'eye', title: '观察记录', detail: '主体通过发言、思想、旁白或传闻获得的信息', count: state.observations.length },
  ];
  return `<div class="stx-memory-scene-category-switch" ${uiControl('segmented')} role="group" aria-label="选择场景与事件数据类别">${cards.map((card) => `<button class="stx-memory-scene-category-button" ${uiControl('button', 'neutral')} type="button" data-action="scene-set-category" data-category="${card.category}" aria-pressed="${state.category === card.category}"><span class="stx-memory-scene-category-icon" aria-hidden="true"><ss-helper-icon name="${card.icon}" decorative></ss-helper-icon></span><span class="stx-memory-scene-category-copy"><strong>${card.title}</strong><small>${card.detail}</small></span><span class="stx-memory-scene-category-count">${card.count} 条</span></button>`).join('')}</div>`;
}

function filterOptions(category: SceneEventCategory, selected: string): string {
  const options = category === 'scene'
    ? [['', '全部角色边界'], ['speaker', '有明确发言者'], ['present', '有明确在场者'], ['mentioned', '有仅提及者'], ['world', '来自世界设定']]
    : category === 'event'
      ? [['', '全部事件'], ['multi-floor', '跨多个楼层'], ['location', '已记录地点'], ['cause', '存在前置事件'], ['private', '包含私密观察']]
      : [['', '全部观察渠道'], ...Object.entries(CHANNEL_LABELS)];
  return options.map(([value, label]) => `<option value="${escapeHtml(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('');
}

function searchPlaceholder(category: SceneEventCategory): string {
  return category === 'scene' ? '搜索场景、人物、楼层或来源'
    : category === 'event' ? '搜索事件摘要、地点、人物或来源'
      : '搜索观察原文、人物、事件或来源';
}

function categoryMetrics(state: SceneEventsState, visible: SceneEventVisibleRecords): Array<[number, string]> {
  if (state.category === 'event') {
    return [
      [visible.episodes.length, '事件'],
      [visible.episodes.flatMap((episode) => observationsFor(state, episode.id)).length, '观察'],
      [unique(visible.episodes.flatMap((episode) => [...episode.participantIds])).length, '参与主体'],
    ];
  }
  if (state.category === 'observation') {
    return [
      [visible.observations.length, '观察'],
      [visible.observations.filter((observation) => observation.privacy === 'private' || observation.privacy === 'secret').length, '私密'],
      [unique(visible.observations.flatMap((observation) => [...observation.factLocalIds])).length, '事实引用'],
    ];
  }
  return [
    [visible.scenes.length, '场景'],
    [unique(visible.scenes.flatMap((scene) => [...scene.presentOwnerIds])).length, '在场主体'],
    [unique(visible.scenes.flatMap((scene) => sceneSources(scene))).length, '来源'],
  ];
}

function renderToolbar(state: SceneEventsState, visible: SceneEventVisibleRecords): string {
  const metrics = categoryMetrics(state, visible);
  return `<div class="stx-memory-scene-toolbar"><label class="stx-memory-scene-search"><span class="stx-memory-sr-only">搜索当前类别</span><ss-helper-icon name="magnifying-glass" decorative></ss-helper-icon><input ${uiControl('input')} type="search" data-scene-input="query" value="${escapeHtml(state.query)}" placeholder="${escapeHtml(searchPlaceholder(state.category))}" aria-label="搜索当前类别"></label><label class="stx-memory-scene-filter"><span class="stx-memory-sr-only">筛选当前类别</span><select ${uiControl('select')} data-scene-select="filter" aria-label="筛选当前类别">${filterOptions(state.category, state.filter)}</select></label><div class="stx-memory-scene-metrics" aria-label="当前类别统计">${metrics.map(([value, label]) => `<span><strong>${value}</strong>${escapeHtml(label)}</span>`).join('')}</div><button ${uiButton('neutral', 'md')} type="button" data-action="scene-refresh"><ss-helper-icon name="rotate" decorative></ss-helper-icon>刷新</button></div>`;
}

function renderSceneList(state: SceneEventsState, visible: SceneCast[], owners: OwnerDirectory): string {
  if (visible.length === 0) return `<div class="stx-memory-scene-empty"><strong>没有匹配的即时场景</strong><p>请清除搜索词或角色边界筛选。</p></div>`;
  return visible.map((scene) => `<button class="stx-memory-scene-record-row" ${uiControl('button', 'neutral')} type="button" data-action="scene-select-record" data-category="scene" data-record-id="${escapeHtml(scene.id)}" aria-selected="${scene.id === state.selectedSceneId}"><span class="stx-memory-scene-record-top"><span><strong>${sceneTitle(scene)}</strong><small>视角 ${escapeHtml(owners.name(scene.viewpointOwnerId))}</small></span><time datetime="${new Date(scene.createdAt).toISOString()}">${escapeHtml(formatTime(scene.createdAt))}</time></span><span class="stx-memory-scene-record-summary">${escapeHtml(sceneSummary(scene, owners))}</span><span class="stx-memory-scene-chip-list">${statusChip(`${scene.presentOwnerIds.length} 在场`, 'success')}${statusChip(`${mentionedOnly(scene).length} 仅提及`, 'warning')}${statusChip(`${sceneSources(scene).length} 来源`)}</span><span class="stx-memory-scene-record-foot"><span>第 ${scene.floor} 层</span><span>单楼层边界</span></span></button>`).join('');
}

function renderEventList(state: SceneEventsState, visible: MemoryEpisode[]): string {
  if (visible.length === 0) return `<div class="stx-memory-scene-empty"><strong>没有匹配的结构化事件</strong><p>请清除搜索词或事件筛选。</p></div>`;
  return visible.map((episode) => {
    const observations = observationsFor(state, episode.id);
    return `<button class="stx-memory-scene-record-row" ${uiControl('button', 'neutral')} type="button" data-action="scene-select-record" data-category="event" data-record-id="${escapeHtml(episode.id)}" aria-selected="${episode.id === state.selectedEpisodeId}"><span class="stx-memory-scene-record-top"><span><strong>${escapeHtml(eventTitle(episode))}</strong><small>${escapeHtml(floorRange(episode))} · ${escapeHtml(episode.location ?? '未记录地点')}</small></span><time datetime="${new Date(episode.occurredAt).toISOString()}">${escapeHtml(formatTime(episode.occurredAt))}</time></span><span class="stx-memory-scene-record-summary">${escapeHtml(episode.summary ?? '当前事件没有可展示的摘要。')}</span><span class="stx-memory-scene-chip-list">${statusChip(`${episode.participantIds.length} 参与者`)}${statusChip(`${observations.length} 观察`, 'success')}${statusChip(`${episode.sourceRefs.length} 来源`)}</span><span class="stx-memory-scene-record-foot"><span>${episode.floorStart !== undefined && episode.floorEnd !== undefined && episode.floorStart !== episode.floorEnd ? '跨楼层事件' : '单楼层事件'}</span><span>${episode.causalParentIds?.length ? '有前置事件' : '独立事件'}</span></span></button>`;
  }).join('');
}

function renderObservationList(state: SceneEventsState, visible: MemoryObservation[], owners: OwnerDirectory): string {
  if (visible.length === 0) return `<div class="stx-memory-scene-empty"><strong>没有匹配的观察记录</strong><p>请清除搜索词或观察渠道筛选。</p></div>`;
  return visible.map((observation) => {
    const episode = state.episodes.find((item) => item.id === observation.episodeId);
    return `<button class="stx-memory-scene-record-row" ${uiControl('button', 'neutral')} type="button" data-action="scene-select-record" data-category="observation" data-record-id="${escapeHtml(observation.id)}" aria-selected="${observation.id === state.selectedObservationId}"><span class="stx-memory-scene-record-top"><span><strong>${escapeHtml(CHANNEL_LABELS[observation.channel])} · ${escapeHtml(owners.name(observation.speakerOwnerId))}</strong><small>${escapeHtml(PRIVACY_LABELS[observation.privacy])} · ${escapeHtml(KNOWLEDGE_LABELS[observation.knowledgeMode])}</small></span><time datetime="${new Date(observation.occurredAt).toISOString()}">${escapeHtml(formatTime(observation.occurredAt))}</time></span><span class="stx-memory-scene-record-summary">${escapeHtml(observation.excerpt)}</span><span class="stx-memory-scene-chip-list">${statusChip(PRIVACY_LABELS[observation.privacy], observation.privacy === 'private' || observation.privacy === 'secret' ? 'error' : 'success')}${statusChip(KNOWLEDGE_LABELS[observation.knowledgeMode])}${statusChip(`${observation.observerOwnerIds.length} 观察者`)}</span><span class="stx-memory-scene-record-foot"><span>${escapeHtml(episode ? eventTitle(episode) : '未关联事件')}</span><span>${escapeHtml(sceneSourceLabel(observation.sourceRef))}</span></span></button>`;
  }).join('');
}

function renderSceneGraphDetail(scene: SceneCast, ownerId: string, owners: OwnerDirectory): string {
  if (!ownerId) {
    return `<div class="stx-memory-scene-viz-detail-head"><small>当前场景</small><strong>${sceneTitle(scene)}</strong></div><div class="stx-memory-scene-viz-detail-grid"><div class="stx-memory-scene-viz-detail-row"><span>当前视角</span><strong>${escapeHtml(owners.name(scene.viewpointOwnerId))}</strong></div><div class="stx-memory-scene-viz-detail-row"><span>多角色召回范围</span><strong>${escapeHtml(unique([...scene.speakerOwnerIds, ...scene.presentOwnerIds]).map((id) => owners.name(id)).join('、') || '无')}</strong></div><div class="stx-memory-scene-viz-detail-row"><span>仅被提及</span><strong>${escapeHtml(mentionedOnly(scene).map((id) => owners.name(id)).join('、') || '无')}</strong></div></div><div class="stx-memory-scene-viz-help">使用画布或下方角色按钮选择主体，查看其角色、置信度、来源和召回边界。</div>`;
  }
  const roles = sceneOwnerRoles(scene, ownerId);
  const sources = sceneOwnerSources(scene, ownerId);
  return `<div class="stx-memory-scene-viz-detail-head"><small>${escapeHtml(owners.kind(ownerId))}</small><strong>${escapeHtml(owners.name(ownerId))}</strong></div><div class="stx-memory-scene-viz-detail-grid"><div class="stx-memory-scene-viz-detail-row"><span>场景角色</span><strong>${escapeHtml(roles.map((role) => ROLE_LABELS[role]).join('、') || '未分类')}</strong></div><div class="stx-memory-scene-viz-detail-row"><span>最高置信度</span><strong>${Math.round(sceneOwnerConfidence(scene, ownerId) * 100)}%</strong></div><div class="stx-memory-scene-viz-detail-row"><span>召回边界</span><strong>${escapeHtml(sceneRecallDescription(scene, ownerId))}</strong></div><div class="stx-memory-scene-viz-detail-row"><span>判定来源</span><strong>${escapeHtml(sources.map(sceneSourceLabel).join('、') || '无')}</strong></div></div><div class="stx-memory-scene-viz-help">${primarySceneRole(scene, ownerId) === 'mentioned' ? '该主体只是被文本提到，不代表其处于现场或知道当前内容。' : '该主体位于当前场景的有效角色边界内。'}</div>`;
}

export function renderSelectedSceneGraphDetail(state: SceneEventsState): string {
  const owners = ownerDirectory(state);
  const scene = state.scenes.find((item) => item.id === state.selectedSceneId);
  return scene ? renderSceneGraphDetail(scene, state.selectedSceneOwnerId, owners) : '';
}

function renderSceneInspector(state: SceneEventsState, owners: OwnerDirectory): string {
  const scene = state.scenes.find((item) => item.id === state.selectedSceneId);
  if (!scene) return `<div class="stx-memory-scene-empty"><strong>选择一个即时场景</strong><p>这里会显示角色边界与来源。</p></div>`;
  const sources = sceneSources(scene);
  const relatedEvents = relatedEventsForScene(state, scene);
  const members = scene.members.map((member) => `<div class="stx-memory-scene-member-row"><span><strong>${escapeHtml(owners.name(member.ownerId))}</strong><small>${escapeHtml(owners.kind(member.ownerId))}</small></span><span class="stx-memory-scene-chip-list">${statusChip(ROLE_LABELS[member.role], member.role === 'present' ? 'success' : member.role === 'mentioned' ? 'warning' : 'neutral')}${statusChip(`${Math.round(member.confidence * 100)}%`)}</span><span class="stx-memory-scene-source-list">${member.sourceRefs.map(renderSourceButton).join('')}</span></div>`).join('');
  const graphOwners = sceneOwnerIds(scene);
  return `<div class="stx-memory-scene-detail-head"><div><span class="stx-memory-kicker">即时场景 · 角色知情边界</span><h3>${sceneTitle(scene)}</h3><p>${escapeHtml(sceneSummary(scene, owners))}</p></div>${statusChip(`第 ${scene.floor} 层`, 'success')}</div><dl class="stx-memory-scene-detail-summary"><div><dt>当前视角</dt><dd>${escapeHtml(owners.name(scene.viewpointOwnerId))}</dd></div><div><dt>发言主体</dt><dd>${scene.speakerOwnerIds.length}</dd></div><div><dt>明确在场</dt><dd>${scene.presentOwnerIds.length}</dd></div><div><dt>仅提及</dt><dd>${mentionedOnly(scene).length}</dd></div></dl>
    <section class="stx-memory-scene-viz-section" aria-labelledby="stx-memory-scene-viz-title"><div class="stx-memory-scene-viz-heading"><div><h4 id="stx-memory-scene-viz-title">${headingWithIcon('circle-nodes', '场景关系图')}</h4><p>滚轮缩放、拖拽移动；点击角色会平滑聚焦，文字列表提供等价的键盘操作。</p></div><div class="stx-memory-scene-viz-controls" role="group" aria-label="场景关系图显示选项"><button ${uiButton('neutral', 'sm', true)} type="button" data-action="scene-graph-command" data-command="zoom-out" aria-label="缩小视图"><ss-helper-icon name="magnifying-glass-minus" decorative></ss-helper-icon></button><button ${uiButton('neutral', 'sm', true)} type="button" data-action="scene-graph-command" data-command="zoom-in" aria-label="放大视图"><ss-helper-icon name="magnifying-glass-plus" decorative></ss-helper-icon></button><button ${uiButton('neutral', 'sm')} type="button" data-action="scene-graph-command" data-command="fit">适应视图</button><button ${uiButton('neutral', 'sm')} type="button" data-action="scene-graph-command" data-command="focus-viewpoint">聚焦视角</button><button ${uiButton('neutral', 'sm')} type="button" data-action="scene-graph-toggle" data-option="boundaries" aria-pressed="${state.showSceneBoundaries}">范围</button><button ${uiButton('neutral', 'sm')} type="button" data-action="scene-graph-toggle" data-option="sources" aria-pressed="${state.showSceneSources}">来源</button><button ${uiButton('neutral', 'sm')} type="button" data-action="scene-graph-toggle" data-option="confidence" aria-pressed="${state.showSceneConfidence}">置信度</button><button ${uiButton('neutral', 'sm')} type="button" data-action="scene-graph-command" data-command="clear-focus">清除聚焦</button></div></div><div class="stx-memory-scene-viz-layout"><div class="stx-memory-scene-viz-main"><div class="stx-memory-scene-viz-stage" data-scene-pixi-host data-scene-id="${escapeHtml(scene.id)}" aria-label="${escapeHtml(sceneTitle(scene))}的交互式角色关系图"><div class="stx-memory-scene-viz-fallback" data-scene-pixi-fallback><strong>正在绘制场景关系图</strong><span>若图形无法启动，下方文字角色边界与来源列表仍可正常使用。</span></div><div class="stx-memory-scene-viz-hud" aria-hidden="true"><span data-scene-zoom-label>100%</span></div><div class="stx-memory-scene-viz-tooltip" data-scene-pixi-tooltip aria-hidden="true"></div></div><div class="stx-memory-scene-viz-legend" aria-label="场景关系图图例"><span class="is-viewpoint">当前视角</span><span class="is-speaker">明确发言</span><span class="is-present">明确在场</span><span class="is-mentioned">仅被提及</span><span>实线：可进入召回范围</span><span>虚线：只存在文本关联</span></div><div class="stx-memory-scene-node-actions" role="group" aria-label="选择场景主体">${graphOwners.map((ownerId) => `<button ${uiButton(primarySceneRole(scene, ownerId) === 'mentioned' ? 'neutral' : 'primary', 'xs')} type="button" data-action="scene-focus-owner" data-owner-id="${escapeHtml(ownerId)}" aria-pressed="${state.selectedSceneOwnerId === ownerId}">${escapeHtml(owners.name(ownerId))}</button>`).join('')}</div></div><aside class="stx-memory-scene-viz-detail" data-scene-viz-detail aria-live="polite">${renderSceneGraphDetail(scene, state.selectedSceneOwnerId, owners)}</aside></div></section>
    <section class="stx-memory-scene-section"><div class="stx-memory-scene-section-title"><div><h4>${headingWithIcon('user-group', '场景角色边界')}</h4><p>区分真正参与当前场景与只是被文字提到</p></div><span>${scene.members.length} 条成员记录</span></div><div class="stx-memory-scene-role-grid">${renderRoleCard('当前视角', [scene.viewpointOwnerId], '决定单视角召回以谁为中心。', owners, 'primary')}${renderRoleCard('明确发言', scene.speakerOwnerIds, '发言者会进入多角色召回范围。', owners, 'primary')}${renderRoleCard('明确在场', scene.presentOwnerIds, '明确在场者可能听见公开内容。', owners, 'neutral')}${renderRoleCard('仅被提及', mentionedOnly(scene), '名字出现不代表在场，也不代表知情。', owners, 'neutral')}</div></section>
    <section class="stx-memory-scene-section"><div class="stx-memory-scene-section-title"><div><h4>${headingWithIcon('list', '成员、角色与来源')}</h4><p>每一种角色判定保留独立置信度和来源</p></div><span>${sources.length} 个来源</span></div><div class="stx-memory-scene-member-list">${members}</div></section>
    <section class="stx-memory-scene-section"><div class="stx-memory-scene-section-title"><div><h4>${headingWithIcon('timeline', '关联的结构化事件')}</h4><p>按楼层范围和共享来源推导</p></div><span>${relatedEvents.length}</span></div><div class="stx-memory-scene-link-list">${relatedEvents.length ? relatedEvents.map((episode) => renderRecordLink('event', episode.id, eventTitle(episode), `${floorRange(episode)} · ${episode.location ?? '未记录地点'}`)).join('') : '<p class="stx-memory-muted">该场景尚未落入已整理事件。</p>'}</div></section>
    <details class="stx-memory-scene-section"><summary>查看技术标识</summary><p class="stx-memory-muted">底层类型：SceneCast<br>记录标识：${escapeHtml(scene.id)}<br>创建时间：${escapeHtml(formatTime(scene.createdAt))}</p></details>`;
}

function renderEventInspector(state: SceneEventsState, owners: OwnerDirectory): string {
  const episode = state.episodes.find((item) => item.id === state.selectedEpisodeId);
  if (!episode) return `<div class="stx-memory-scene-empty"><strong>选择一个结构化事件</strong><p>这里会显示事件经过、参与关系与相关观察。</p></div>`;
  const observations = observationsFor(state, episode.id);
  const relatedScenes = relatedScenesForEvent(state, episode);
  const parents = (episode.causalParentIds ?? []).map((id) => state.episodes.find((item) => item.id === id)).filter((item): item is MemoryEpisode => Boolean(item));
  return `<div class="stx-memory-scene-detail-head"><div><span class="stx-memory-kicker">结构化事件 · 完整发生内容</span><h3>${escapeHtml(eventTitle(episode))}</h3><p>${escapeHtml(episode.summary ?? '当前事件没有可展示的摘要。')}</p></div>${statusChip(floorRange(episode), 'success')}</div><dl class="stx-memory-scene-detail-summary"><div><dt>发生地点</dt><dd>${escapeHtml(episode.location ?? '未记录')}</dd></div><div><dt>参与主体</dt><dd>${episode.participantIds.length}</dd></div><div><dt>观察记录</dt><dd>${observations.length}</dd></div><div><dt>来源引用</dt><dd>${episode.sourceRefs.length}</dd></div></dl><section class="stx-memory-scene-hero"><strong>结构化事件负责什么？</strong><p>它把多个楼层中属于同一段剧情的来源整理为一件完整事件。事件说明发生了什么，具体知情方式仍由观察记录决定。</p></section><section class="stx-memory-scene-section"><div class="stx-memory-scene-section-title"><div><h4>参与关系</h4><p>参与事件、明确在场与仅被提及是不同关系</p></div></div><div class="stx-memory-scene-role-grid">${renderRoleCard('参与者', episode.participantIds, '参与事件经过的主体。', owners, 'primary')}${renderRoleCard('明确在场', episode.presentOwnerIds, '事件发生时明确处于现场。', owners, 'neutral')}${renderRoleCard('仅被提及', episode.mentionedOwnerIds, '事件内容涉及，但不代表在场或知情。', owners, 'neutral')}<article class="stx-memory-scene-role-card"><div class="stx-memory-scene-role-head"><strong>前置事件</strong><span>${parents.length}</span></div><div class="stx-memory-scene-link-list">${parents.length ? parents.map((item) => renderRecordLink('event', item.id, eventTitle(item), floorRange(item))).join('') : statusChip('无')}</div><p>当前事件由这些事件触发或承接。</p></article></div></section><section class="stx-memory-scene-section"><div class="stx-memory-scene-section-title"><div><h4>观察记录</h4><p>事件被记录不代表所有人物都知道</p></div><button ${uiButton('primary', 'sm')} type="button" data-action="scene-show-event-observations" data-event-id="${escapeHtml(episode.id)}" ${observations.length ? '' : 'disabled'}>查看全部观察</button></div><div class="stx-memory-scene-quick-grid">${unique(observations.map((item) => item.channel)).map((channel) => `<article><strong>${escapeHtml(CHANNEL_LABELS[channel as MemoryObservation['channel']])}</strong><p>${observations.filter((item) => item.channel === channel).length} 条记录</p></article>`).join('') || '<p class="stx-memory-muted">当前事件尚无观察记录。</p>'}</div></section><section class="stx-memory-scene-section"><div class="stx-memory-scene-section-title"><div><h4>相关即时场景</h4><p>按事件楼层范围和共享来源推导</p></div><span>${relatedScenes.length}</span></div><div class="stx-memory-scene-link-list">${relatedScenes.map((scene) => renderRecordLink('scene', scene.id, sceneTitle(scene), `视角 ${owners.name(scene.viewpointOwnerId)}`)).join('') || '<p class="stx-memory-muted">没有匹配场景。</p>'}</div></section><section class="stx-memory-scene-section"><div class="stx-memory-scene-section-title"><div><h4>事件来源</h4><p>摘要必须能够回溯到聊天或设定来源</p></div></div><div class="stx-memory-scene-source-list">${episode.sourceRefs.map(renderSourceButton).join('')}</div></section><details class="stx-memory-scene-section"><summary>查看技术标识</summary><p class="stx-memory-muted">底层类型：MemoryEpisode<br>事件标识：${escapeHtml(episode.id)}<br>创建时间：${escapeHtml(formatTime(episode.createdAt))}</p></details>`;
}

function renderObservationInspector(state: SceneEventsState, owners: OwnerDirectory): string {
  const observation = state.observations.find((item) => item.id === state.selectedObservationId);
  if (!observation) return `<div class="stx-memory-scene-empty"><strong>选择一条观察记录</strong><p>这里会显示谁通过什么渠道知道了什么。</p></div>`;
  const episode = state.episodes.find((item) => item.id === observation.episodeId);
  return `<div class="stx-memory-scene-detail-head"><div><span class="stx-memory-kicker">观察记录 · 角色知情来源</span><h3>${escapeHtml(CHANNEL_LABELS[observation.channel])} · ${escapeHtml(owners.name(observation.speakerOwnerId))}</h3><p>${escapeHtml(observation.excerpt)}</p></div>${statusChip(PRIVACY_LABELS[observation.privacy], observation.privacy === 'private' || observation.privacy === 'secret' ? 'error' : 'success')}</div><dl class="stx-memory-scene-detail-summary"><div><dt>观察渠道</dt><dd>${escapeHtml(CHANNEL_LABELS[observation.channel])}</dd></div><div><dt>知情方式</dt><dd>${escapeHtml(KNOWLEDGE_LABELS[observation.knowledgeMode])}</dd></div><div><dt>说话主体</dt><dd>${escapeHtml(owners.name(observation.speakerOwnerId))}</dd></div><div><dt>来源</dt><dd>${escapeHtml(sceneSourceLabel(observation.sourceRef))}</dd></div></dl><section class="stx-memory-scene-hero"><strong>这条观察记录说明什么？</strong><p>它只按照渠道、隐私级别和明确观察者形成角色记忆，不会把事件内容广播给所有人物。</p></section><section class="stx-memory-scene-section"><div class="stx-memory-scene-section-title"><div><h4>知情角色结构</h4><p>说话者、视角、观察者、在场者和被提及者分别保存</p></div></div><div class="stx-memory-scene-role-grid">${renderRoleCard('说话主体', [observation.speakerOwnerId], '产生这条表达或认知的主体。', owners, 'primary')}${renderRoleCard('当前视角', [observation.viewpointOwnerId], '这条观察发生时的视角主体。', owners, 'primary')}${renderRoleCard('明确观察者', observation.observerOwnerIds, '可能通过该渠道获得信息的其他主体。', owners, 'neutral')}${renderRoleCard('明确在场', observation.presentOwnerIds, '公开发言时只有明确在场的观察者可获得听闻。', owners, 'neutral')}${renderRoleCard('仅被提及', observation.mentionedOwnerIds, '只是信息内容涉及，不代表其知道信息。', owners, 'neutral')}</div></section><section class="stx-memory-scene-section"><div class="stx-memory-scene-section-title"><div><h4>所属结构化事件</h4><p>观察记录通过事件标识直接归属于一个事件</p></div></div>${episode ? renderRecordLink('event', episode.id, eventTitle(episode), `${floorRange(episode)} · ${episode.location ?? '未记录地点'}`) : '<p class="stx-memory-muted">所属事件当前不可用。</p>'}</section><section class="stx-memory-scene-section"><div class="stx-memory-scene-section-title"><div><h4>来源原文</h4><p>点击可回溯对应聊天楼层或查看来源说明</p></div></div>${renderSourceButton(observation.sourceRef)}</section><section class="stx-memory-scene-section"><div class="stx-memory-scene-section-title"><div><h4>关联事实</h4><p>由当前观察支撑或引用的事实标识</p></div><span>${observation.factLocalIds.length}</span></div><div class="stx-memory-scene-reference-list">${observation.factLocalIds.map((id) => `<span>${escapeHtml(id)}</span>`).join('') || statusChip('无')}</div></section><details class="stx-memory-scene-section"><summary>查看技术标识</summary><p class="stx-memory-muted">底层类型：MemoryObservation<br>观察标识：${escapeHtml(observation.id)}<br>事件标识：${escapeHtml(observation.episodeId)}<br>创建时间：${escapeHtml(formatTime(observation.createdAt))}</p></details>`;
}

function asideCard(title: string, count: string, note: string, body: string): string {
  const icon = title.includes('来源') ? 'link'
    : title.includes('事件') ? 'timeline'
      : title.includes('观察') ? 'eye'
        : title.includes('主体') ? 'user-group'
          : title.includes('场景') ? 'location-crosshairs'
            : 'circle-info';
  return `<section class="stx-memory-scene-aside-card"><div class="stx-memory-scene-aside-head"><h4>${headingWithIcon(icon, title)}</h4><span>${escapeHtml(count)}</span></div><div class="stx-memory-scene-aside-body">${note ? `<p>${escapeHtml(note)}</p>` : ''}${body}</div></section>`;
}

function summaryRow(title: string, value: string, detail: string): string {
  return `<div class="stx-memory-scene-summary-row"><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></span>${statusChip(value)}</div>`;
}

function renderAside(state: SceneEventsState, owners: OwnerDirectory): string {
  if (state.category === 'event') {
    const episode = state.episodes.find((item) => item.id === state.selectedEpisodeId);
    if (!episode) return '';
    const observations = observationsFor(state, episode.id);
    const relatedScenes = relatedScenesForEvent(state, episode);
    const sources = unique([...episode.sourceRefs, ...observations.map((item) => item.sourceRef)]);
    return `${asideCard('事件来源', `${sources.length} 项`, '事件摘要和观察记录都必须能够回溯来源。', `<div class="stx-memory-scene-source-summary">${sources.map((source) => renderSourceButton(source)).join('')}</div>`)}${asideCard('事件速览', floorRange(episode), '', `<div class="stx-memory-scene-source-summary">${summaryRow('地点', episode.location ?? '未记录', '事件发生位置')}${summaryRow('参与主体', String(episode.participantIds.length), '完整事件参与者')}${summaryRow('观察记录', String(observations.length), '不同知情渠道')}${summaryRow('相关场景', String(relatedScenes.length), '按楼层和来源推导')}</div>`)}${asideCard('观察分布', `${observations.length} 条`, '事件被记录不代表所有人物都知道。', `<div class="stx-memory-scene-source-summary">${unique(observations.map((item) => item.channel)).map((channel) => summaryRow(CHANNEL_LABELS[channel as MemoryObservation['channel']], String(observations.filter((item) => item.channel === channel).length), '按观察渠道归类')).join('') || '<p class="stx-memory-muted">暂无观察。</p>'}</div>`)}`;
  }
  if (state.category === 'observation') {
    const observation = state.observations.find((item) => item.id === state.selectedObservationId);
    if (!observation) return '';
    const episode = state.episodes.find((item) => item.id === observation.episodeId);
    const relatedOwners = unique([observation.speakerOwnerId, observation.viewpointOwnerId, ...observation.observerOwnerIds, ...observation.presentOwnerIds, ...observation.mentionedOwnerIds]);
    return `${asideCard('所属事件', episode ? floorRange(episode) : '未关联', '观察记录通过事件标识归属于结构化事件。', episode ? renderRecordLink('event', episode.id, eventTitle(episode), episode.summary ?? floorRange(episode)) : '<p class="stx-memory-muted">事件不可用。</p>')}${asideCard('知情边界', PRIVACY_LABELS[observation.privacy], '', `<div class="stx-memory-scene-source-summary">${summaryRow('观察渠道', CHANNEL_LABELS[observation.channel], '信息获得方式')}${summaryRow('隐私级别', PRIVACY_LABELS[observation.privacy], '决定信息传播范围')}${summaryRow('知情方式', KNOWLEDGE_LABELS[observation.knowledgeMode], '决定角色记忆性质')}${summaryRow('明确观察者', String(observation.observerOwnerIds.length), '可获得该信息的其他主体')}</div>`)}${asideCard('相关主体', `${relatedOwners.length} 个`, '这些主体参与了当前观察的角色判定。', `<div class="stx-memory-scene-owner-list">${relatedOwners.map((ownerId) => renderOwnerButton(ownerId, owners, 'primary')).join('')}</div>`)}${asideCard('来源与事实', `${observation.factLocalIds.length} 条事实`, '', `<div class="stx-memory-scene-source-summary">${renderSourceButton(observation.sourceRef)}${observation.factLocalIds.map((id) => summaryRow('事实引用', id, '由当前观察支撑')).join('')}</div>`)}`;
  }
  const scene = state.scenes.find((item) => item.id === state.selectedSceneId);
  if (!scene) return '';
  const relatedEvents = relatedEventsForScene(state, scene);
  return `${asideCard('场景速览', `${sceneOwnerIds(scene).length} 个主体`, '', `<div class="stx-memory-scene-source-summary">${summaryRow('当前视角', owners.name(scene.viewpointOwnerId), '单视角召回中心')}${summaryRow('多角色范围', String(unique([...scene.speakerOwnerIds, ...scene.presentOwnerIds]).length), '发言者与明确在场者')}${summaryRow('仅提及主体', String(mentionedOnly(scene).length), '不自动知情')}${summaryRow('关联事件', String(relatedEvents.length), '按楼层和来源推导')}</div>`)}${asideCard('场景边界说明', '只读', '', `<div class="stx-memory-scene-source-summary">${summaryRow('视角', '单视角', '只围绕当前视角主体')}${summaryRow('明确在场', '可召回', '可能听见公开内容')}${summaryRow('仅提及', '不召回', '名字出现不代表知情')}</div>`)}`;
}

export function renderSceneEventsPage(state: SceneEventsState): string {
  normalizeSceneEventsSelection(state);
  const visible = getVisibleSceneEventRecords(state);
  const owners = ownerDirectory(state);
  const list = state.category === 'event'
    ? renderEventList(state, visible.episodes)
    : state.category === 'observation'
      ? renderObservationList(state, visible.observations, owners)
      : renderSceneList(state, visible.scenes, owners);
  const inspector = state.category === 'event'
    ? renderEventInspector(state, owners)
    : state.category === 'observation'
      ? renderObservationInspector(state, owners)
      : renderSceneInspector(state, owners);
  const title = state.category === 'event' ? '结构化事件' : state.category === 'observation' ? '观察记录' : '即时场景';
  const count = state.category === 'event' ? visible.episodes.length : state.category === 'observation' ? visible.observations.length : visible.scenes.length;
  const listIcon = state.category === 'event' ? 'timeline' : state.category === 'observation' ? 'eye' : 'list';
  return `<div class="stx-memory-scenes-shell">${renderCategorySwitch(state)}${renderToolbar(state, visible)}<div class="stx-memory-scene-record-grid"><section class="stx-memory-scene-panel stx-memory-scene-list-panel" aria-label="${title}列表"><div class="stx-memory-scene-panel-head"><div><h3>${headingWithIcon(listIcon, title)}</h3></div><span>${count} 条</span></div><div class="stx-memory-scene-record-list">${list}</div></section><section class="stx-memory-scene-panel stx-memory-scene-inspector" aria-label="${title}详情">${inspector}</section><aside class="stx-memory-scene-panel stx-memory-scene-aside" aria-label="辅助信息">${renderAside(state, owners)}</aside></div></div>`;
}

export function sceneGraphOwnerLabel(state: SceneEventsState, ownerId: string): string {
  return ownerDirectory(state).name(ownerId);
}

export function sceneGraphOwnerKind(state: SceneEventsState, ownerId: string): string {
  return ownerDirectory(state).kind(ownerId);
}

export function sceneGraphOwnerConfidence(scene: SceneCast, ownerId: string): number {
  return sceneOwnerConfidence(scene, ownerId);
}

export function sceneGraphOwnerSources(scene: SceneCast, ownerId: string): string[] {
  return sceneOwnerSources(scene, ownerId);
}

export function sceneGraphOwnerIds(scene: SceneCast): string[] {
  return sceneOwnerIds(scene);
}
