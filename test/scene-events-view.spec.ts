import { describe, expect, it } from 'vitest';
import type { MemoryEpisode, MemoryObservation, MemoryOwner, SceneCast } from '../src/domain';
import {
  getSceneEventsHeader,
  getVisibleSceneEventRecords,
  normalizeSceneEventsSelection,
  renderSceneEventsPage,
  type SceneEventsState,
} from '../src/ui/scene-events-view';

const actor = (id: string, displayName: string, aliases: string[] = []): MemoryOwner => ({
  id,
  workspaceId: 'workspace:test',
  kind: 'actor',
  displayName,
  aliases,
  status: 'confirmed',
  discoverySources: [],
  confidence: 0.95,
  createdAt: 1,
  updatedAt: 1,
});

const scenes: SceneCast[] = [
  {
    id: 'scene:12',
    workspaceId: 'workspace:test',
    chatKey: 'chat:a',
    floor: 12,
    viewpointOwnerId: 'owner:a',
    speakerOwnerIds: ['owner:a'],
    presentOwnerIds: ['owner:a', 'owner:b'],
    mentionedOwnerIds: ['owner:c'],
    members: [
      { ownerId: 'owner:a', role: 'viewpoint', confidence: 1, sourceRefs: ['message:12'] },
      { ownerId: 'owner:a', role: 'speaker', confidence: 1, sourceRefs: ['message:12'] },
      { ownerId: 'owner:b', role: 'present', confidence: 0.9, sourceRefs: ['message:12'] },
      { ownerId: 'owner:c', role: 'mentioned', confidence: 0.7, sourceRefs: ['message:12'] },
    ],
    createdAt: 12,
  },
  {
    id: 'scene:8',
    workspaceId: 'workspace:test',
    chatKey: 'chat:a',
    floor: 8,
    viewpointOwnerId: 'owner:b',
    speakerOwnerIds: ['owner:b'],
    presentOwnerIds: ['owner:b'],
    mentionedOwnerIds: [],
    members: [{ ownerId: 'owner:b', role: 'speaker', confidence: 0.9, sourceRefs: ['message:8'] }],
    createdAt: 8,
  },
];

const episodes: MemoryEpisode[] = [{
  id: 'episode:gate',
  workspaceId: 'workspace:test',
  chatKey: 'chat:a',
  floorStart: 11,
  floorEnd: 12,
  sourceRefs: ['message:12'],
  participantIds: ['owner:a', 'owner:b'],
  presentOwnerIds: ['owner:a', 'owner:b'],
  mentionedOwnerIds: ['owner:c'],
  location: '北门',
  summary: '艾琳在北门向贝塔交付钥匙。',
  occurredAt: 12,
  createdAt: 12,
}];

const observations: MemoryObservation[] = [{
  id: 'observation:gate',
  workspaceId: 'workspace:test',
  episodeId: 'episode:gate',
  sourceRef: 'message:12',
  speakerOwnerId: 'owner:a',
  viewpointOwnerId: 'owner:a',
  observerOwnerIds: ['owner:b'],
  channel: 'public_speech',
  privacy: 'public',
  knowledgeMode: 'heard',
  excerpt: '钥匙交给你保管。',
  mentionedOwnerIds: [],
  presentOwnerIds: ['owner:a', 'owner:b'],
  factLocalIds: ['fact:key'],
  occurredAt: 12,
  createdAt: 12,
}];

function state(category: SceneEventsState['category'] = 'scene'): SceneEventsState {
  return {
    category,
    query: '',
    filter: '',
    scenes: [...scenes],
    episodes: [...episodes],
    observations: [...observations],
    actors: [actor('owner:a', '艾琳', ['琳']), actor('owner:b', '贝塔'), actor('owner:c', '希尔')],
    actorAliases: [],
    selectedSceneId: '',
    selectedEpisodeId: '',
    selectedObservationId: '',
    selectedSceneOwnerId: '',
    showSceneBoundaries: true,
    showSceneSources: true,
    showSceneConfidence: true,
  };
}

describe('场景与事件 v4 视图模型', () => {
  it('按楼层或时间倒序，并支持人物别名、地点和观察渠道筛选', () => {
    const model = state();
    expect(getVisibleSceneEventRecords(model).scenes.map((item) => item.id)).toEqual(['scene:12', 'scene:8']);

    model.query = '琳';
    expect(getVisibleSceneEventRecords(model).scenes.map((item) => item.id)).toEqual(['scene:12']);

    model.category = 'event';
    model.query = '北门';
    expect(getVisibleSceneEventRecords(model).episodes.map((item) => item.id)).toEqual(['episode:gate']);

    model.category = 'observation';
    model.query = '';
    model.filter = 'public_speech';
    expect(getVisibleSceneEventRecords(model).observations.map((item) => item.id)).toEqual(['observation:gate']);
  });

  it('为三类记录保持独立选中项，并生成动态页头', () => {
    const model = state();
    normalizeSceneEventsSelection(model);
    expect(model.selectedSceneId).toBe('scene:12');
    expect(model.selectedEpisodeId).toBe('episode:gate');
    expect(model.selectedObservationId).toBe('observation:gate');
    expect(getSceneEventsHeader(model)).toEqual(expect.objectContaining({ count: '2 个即时场景' }));

    model.category = 'event';
    expect(getSceneEventsHeader(model)).toEqual(expect.objectContaining({ count: '1 个结构化事件' }));
    expect(model.selectedSceneId).toBe('scene:12');
  });

  it('使用 SDK 控件契约渲染三类别、等高工具栏、三栏详情与真实字段', () => {
    const model = state();
    const markup = renderSceneEventsPage(model);
    expect(markup.match(/data-action="scene-set-category"/g)).toHaveLength(3);
    expect(markup).toContain('data-ss-helper-control="segmented"');
    expect(markup).toContain('data-scene-input="query"');
    expect(markup).toContain('data-ss-helper-control="input"');
    expect(markup).toContain('data-scene-select="filter"');
    expect(markup).toContain('data-ss-helper-control="select"');
    expect(markup).toContain('stx-memory-scene-record-grid');
    expect(markup).toContain('第 12 层即时场景');
    expect(markup).toContain('艾琳');
    expect(markup).toContain('data-scene-pixi-host');
    expect(markup).toContain('data-option="sources"');
    expect(markup).not.toContain('本场景来源');
    expect(markup).toContain('stx-memory-scene-heading-label');
    expect(markup).toContain('name="circle-nodes"');
    expect(markup).not.toContain('PixiJS');
    expect(markup).not.toContain('回答“这一刻谁在说');
    expect(markup).not.toContain('初始化与重新捕获');
  });

  it('空数据只显示安全空状态，不注入原型假记录', () => {
    const model = state();
    model.scenes = [];
    model.episodes = [];
    model.observations = [];
    const markup = renderSceneEventsPage(model);
    expect(markup).toContain('没有匹配的即时场景');
    expect(markup).not.toContain('北门');
    expect(markup).not.toContain('艾琳在北门');
  });
});
