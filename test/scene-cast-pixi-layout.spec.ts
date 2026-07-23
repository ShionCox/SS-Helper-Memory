import { describe, expect, it } from 'vitest';
import type { SceneCast } from '../src/domain';
import { buildSceneCastLayout } from '../src/ui/scene-cast-pixi';

const scene: SceneCast = {
  id: 'scene:test',
  workspaceId: 'workspace:test',
  chatKey: 'chat:test',
  floor: 9,
  viewpointOwnerId: 'owner:viewpoint',
  speakerOwnerIds: ['owner:viewpoint', 'owner:speaker'],
  presentOwnerIds: ['owner:present'],
  mentionedOwnerIds: ['owner:mentioned'],
  members: [
    { ownerId: 'owner:viewpoint', role: 'viewpoint', confidence: 1, sourceRefs: ['message:9'] },
    { ownerId: 'owner:speaker', role: 'speaker', confidence: .9, sourceRefs: ['message:9'] },
    { ownerId: 'owner:present', role: 'present', confidence: .8, sourceRefs: ['message:8'] },
    { ownerId: 'owner:mentioned', role: 'mentioned', confidence: .7, sourceRefs: ['worldbook:book:entry'] },
  ],
  createdAt: 9,
};

describe('PixiJS SceneCast 确定性布局', () => {
  it('稳定输出同心角色优先级、来源节点和固定画布边界', () => {
    const first = buildSceneCastLayout(scene);
    const second = buildSceneCastLayout(scene);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ width: 720, height: 520 });
    expect(first.nodes.find((node) => node.id === 'owner:viewpoint')).toMatchObject({
      role: 'viewpoint',
      x: first.center.x,
      y: first.center.y,
    });
    expect(first.nodes.find((node) => node.id === 'owner:speaker')?.role).toBe('speaker');
    expect(first.nodes.find((node) => node.id === 'owner:present')?.role).toBe('present');
    expect(first.nodes.find((node) => node.id === 'owner:mentioned')?.role).toBe('mentioned');
    expect(first.sources.map((source) => source.id)).toEqual(['message:9', 'message:8', 'worldbook:book:entry']);
    expect(first.sources.every((source) => source.x === 650)).toBe(true);
    expect(first.sources.map((source) => source.y)).toEqual([76, 134, 192]);
  });
});
