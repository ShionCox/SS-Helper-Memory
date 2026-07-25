import { describe, expect, it } from 'vitest';
import { ActorRegistry, CastCandidateResolver } from '../src/application/actors';
import type { SceneState } from '../src/domain';

function state(input: Partial<SceneState> = {}): SceneState {
  return {
    id: 'scene-state', workspaceId: 'workspace', chatKey: 'chat', sceneId: 'scene:1', sceneEpoch: 1,
    locationKeys: ['加油站'], presentOwnerIds: [], nearbyOwnerIds: [], exitedOwnerIds: [],
    recentSpeakerOwnerIds: [], mentionedOwnerIds: [], startedAtFloor: 1, updatedAtFloor: 10,
    confidence: 0.9, revision: 1, sourceRefs: [], createdAt: 1, updatedAt: 10, ...input,
  };
}

describe('CastCandidateResolver', () => {
  it('prioritizes an explicitly addressed actor without treating mentions as presence', () => {
    const registry = new ActorRegistry('workspace');
    const a = registry.discover({ displayName: 'A', aliases: ['队长'], sourceRef: 'card:a', sourceType: 'host_card', confidence: 0.99 }).owner;
    const b = registry.discover({ displayName: 'B', sourceRef: 'card:b', sourceType: 'host_card', confidence: 0.99 }).owner;
    const resolver = new CastCandidateResolver(registry);
    const result = resolver.resolve({
      userMessage: '队长，你还记得那个加油站吗？', currentFloor: 10,
      sceneState: state({ viewpointOwnerId: a.id, presentOwnerIds: [a.id], mentionedOwnerIds: [b.id] }),
      sources: [],
    });
    expect(result.explicitAddressOwnerIds).toEqual([a.id]);
    expect(result.candidates[0]).toMatchObject({ ownerId: a.id, explicitlyAddressed: true, mentionedOnly: false });
    expect(result.candidates.find((candidate) => candidate.ownerId === b.id)).toMatchObject({ mentionedOnly: true, present: false });
  });

  it('hard-excludes actors that explicitly exited even when recently mentioned', () => {
    const registry = new ActorRegistry('workspace');
    const a = registry.discover({ displayName: 'A', sourceRef: 'card:a', sourceType: 'host_card', confidence: 0.99 }).owner;
    const b = registry.discover({ displayName: 'B', sourceRef: 'card:b', sourceType: 'host_card', confidence: 0.99 }).owner;
    const result = new CastCandidateResolver(registry).resolve({
      userMessage: 'B刚才去了哪里？', currentFloor: 20,
      sceneState: state({ viewpointOwnerId: a.id, presentOwnerIds: [a.id], exitedOwnerIds: [b.id], mentionedOwnerIds: [b.id] }),
      sources: [],
    });
    const candidate = result.candidates.find((item) => item.ownerId === b.id);
    expect(candidate).toMatchObject({ exited: true });
    expect(candidate?.score).toBeLessThan(0);
  });
});
