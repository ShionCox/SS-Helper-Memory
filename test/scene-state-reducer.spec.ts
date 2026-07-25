import { describe, expect, it } from 'vitest';
import { ActorRegistry, SceneStateReducer, type SceneStateStore } from '../src/application/actors';
import type { SceneState, SceneTransition } from '../src/domain';
import type { SourceBlock } from '../src/application/ingest/types';

function message(id: string, floor: number, content: string, extra: Partial<SourceBlock> = {}): SourceBlock {
  return { id, chatKey: 'chat', kind: 'message', role: 'assistant', content, floor, createdAt: floor, ...extra };
}

function memoryStore(): SceneStateStore & { state?: SceneState; transitions: SceneTransition[] } {
  return {
    state: undefined,
    transitions: [],
    getSceneState() { return this.state; },
    listSceneCasts() { return []; },
    saveSceneState(state, transition) {
      this.state = state;
      if (transition) this.transitions.push(transition);
    },
  };
}

describe('SceneStateReducer', () => {
  it('keeps quiet actors present past the scan window and removes only explicit exits', async () => {
    const registry = new ActorRegistry('workspace');
    const a = registry.discover({ displayName: 'A', sourceRef: 'card:a', sourceType: 'host_card', confidence: 0.99 }).owner;
    const b = registry.discover({ displayName: 'B', sourceRef: 'card:b', sourceType: 'host_card', confidence: 0.99 }).owner;
    const c = registry.discover({ displayName: 'C', sourceRef: 'card:c', sourceType: 'host_card', confidence: 0.99 }).owner;
    const store = memoryStore();
    const reducer = new SceneStateReducer(registry, store);

    const entered = await reducer.resolve({
      workspaceId: 'workspace', chatKey: 'chat', currentFloor: 1,
      sources: [message('message:1', 1, 'A、B、C 一起进入加油站。', {
        transition: { enteredOwnerRefs: [a.id, b.id, c.id], locationKeys: ['加油站'], confidence: 1 },
      })],
    });
    expect(entered.state.presentOwnerIds).toEqual(expect.arrayContaining([a.id, b.id, c.id]));
    expect(entered.state.locationKeys).toEqual(['加油站']);

    const quiet = await reducer.resolve({
      workspaceId: 'workspace', chatKey: 'chat', currentFloor: 15,
      sources: [message('message:15', 15, 'A继续检查入口。', { perspective: { speakerOwnerRef: a.id, presentOwnerRefs: [a.id] } })],
      actorScanLookbackFloors: 12,
    });
    expect(quiet.state.presentOwnerIds).toEqual(expect.arrayContaining([a.id, b.id, c.id]));
    expect(quiet.state.exitedOwnerIds).not.toContain(b.id);

    const exited = await reducer.resolve({
      workspaceId: 'workspace', chatKey: 'chat', currentFloor: 16,
      sources: [message('message:16', 16, 'B离开加油站，回到车上。', {
        transition: { exitedOwnerRefs: [b.id], confidence: 1 },
      })],
    });
    expect(exited.state.presentOwnerIds).not.toContain(b.id);
    expect(exited.state.exitedOwnerIds).toContain(b.id);
    expect(exited.transition?.reason).toBe('explicit_exit');
  });

  it('keeps mentioned actors outside the present set and advances epoch on location changes', async () => {
    const registry = new ActorRegistry('workspace');
    const a = registry.discover({ displayName: 'A', sourceRef: 'card:a', sourceType: 'host_card', confidence: 0.99 }).owner;
    const b = registry.discover({ displayName: 'B', sourceRef: 'card:b', sourceType: 'host_card', confidence: 0.99 }).owner;
    const store = memoryStore();
    const reducer = new SceneStateReducer(registry, store);
    await reducer.resolve({
      workspaceId: 'workspace', chatKey: 'chat', currentFloor: 1,
      sources: [message('message:1', 1, 'A进入便利店。', { transition: { enteredOwnerRefs: [a.id], locationKeys: ['便利店'] } })],
    });

    const mentioned = await reducer.resolve({
      workspaceId: 'workspace', chatKey: 'chat', currentFloor: 2,
      sources: [message('message:2', 2, 'A说：“我们应该去找B。”', { perspective: { speakerOwnerRef: a.id, presentOwnerRefs: [a.id] } })],
    });
    expect(mentioned.state.presentOwnerIds).toContain(a.id);
    expect(mentioned.state.presentOwnerIds).not.toContain(b.id);
    expect(mentioned.state.mentionedOwnerIds).toContain(b.id);

    const moved = await reducer.resolve({
      workspaceId: 'workspace', chatKey: 'chat', currentFloor: 3,
      sources: [message('message:3', 3, 'A来到停车场。', { transition: { locationKeys: ['停车场'] } })],
    });
    expect(moved.state.sceneEpoch).toBeGreaterThan(mentioned.state.sceneEpoch);
    expect(moved.transition?.reason).toBe('location_change');
  });

  it('migrates the latest SceneCast together with current evidence and does not let a user message steal the actor viewpoint', async () => {
    const registry = new ActorRegistry('workspace');
    const a = registry.discover({ displayName: 'A', sourceRef: 'card:a', sourceType: 'host_card', confidence: 0.99 }).owner;
    const b = registry.discover({ displayName: 'B', sourceRef: 'card:b', sourceType: 'host_card', confidence: 0.99 }).owner;
    const c = registry.discover({ displayName: 'C', sourceRef: 'card:c', sourceType: 'host_card', confidence: 0.99 }).owner;
    const backing = memoryStore();
    backing.listSceneCasts = () => [{
      id: 'old-cast', workspaceId: 'workspace', chatKey: 'chat', floor: 8,
      members: [
        { ownerId: a.id, role: 'viewpoint', confidence: 1, sourceRefs: ['message:8'] },
        { ownerId: b.id, role: 'present', confidence: 1, sourceRefs: ['message:8'] },
      ],
      viewpointOwnerId: a.id, speakerOwnerIds: [a.id], presentOwnerIds: [a.id, b.id],
      mentionedOwnerIds: [], createdAt: 8,
    }];
    const reducer = new SceneStateReducer(registry, backing);
    const current = await reducer.resolve({
      workspaceId: 'workspace', chatKey: 'chat', currentFloor: 10,
      sources: [
        message('message:9', 9, 'C推门而入。', { perspective: { speakerOwnerRef: c.id, presentOwnerRefs: [c.id] } }),
        message('message:10', 10, '你们觉得这里安全吗？', { role: 'user' }),
      ],
    });
    expect(current.state.presentOwnerIds).toEqual(expect.arrayContaining([a.id, b.id, c.id]));
    expect(current.state.viewpointOwnerId).toBe(c.id);
    expect(current.state.recentSpeakerOwnerIds).toContain(c.id);
    expect(current.state.recentSpeakerOwnerIds).not.toContain('owner:player');
  });

  it('does not move the whole scene when one actor exits to another place without group or scene metadata', async () => {
    const registry = new ActorRegistry('workspace');
    const a = registry.discover({ displayName: 'A', sourceRef: 'card:a', sourceType: 'host_card', confidence: 0.99 }).owner;
    const b = registry.discover({ displayName: 'B', sourceRef: 'card:b', sourceType: 'host_card', confidence: 0.99 }).owner;
    const backing = memoryStore();
    const reducer = new SceneStateReducer(registry, backing);
    await reducer.resolve({
      workspaceId: 'workspace', chatKey: 'chat', currentFloor: 1,
      sources: [message('message:1', 1, 'A和B一起进入加油站。', { transition: { enteredOwnerRefs: [a.id, b.id], locationKeys: ['加油站'] } })],
    });
    const result = await reducer.resolve({
      workspaceId: 'workspace', chatKey: 'chat', currentFloor: 2,
      sources: [message('message:2', 2, 'B离开加油站，回到车上。')],
    });
    expect(result.state.locationKeys).toEqual(['加油站']);
    expect(result.state.sceneEpoch).toBe(0);
    expect(result.transition?.reason).toBe('explicit_exit');
  });

  it('records a manual correction with highest-priority user_corrected semantics', async () => {
    const registry = new ActorRegistry('workspace');
    const a = registry.discover({ displayName: 'A', sourceRef: 'card:a', sourceType: 'host_card', confidence: 0.99 }).owner;
    const b = registry.discover({ displayName: 'B', sourceRef: 'card:b', sourceType: 'host_card', confidence: 0.99 }).owner;
    const backing = memoryStore();
    const reducer = new SceneStateReducer(registry, backing);
    await reducer.resolve({
      workspaceId: 'workspace', chatKey: 'chat', currentFloor: 1,
      sources: [message('message:1', 1, 'A在仓库里。', { transition: { enteredOwnerRefs: [a.id], locationKeys: ['仓库'] } })],
    });
    const corrected = await reducer.resolve({
      workspaceId: 'workspace', chatKey: 'chat', currentFloor: 1, sources: [],
      correction: {
        presentOwnerIds: [a.id, b.id], nearbyOwnerIds: [], exitedOwnerIds: [],
        locationKeys: ['仓库'], viewpointOwnerId: b.id,
      },
    });
    expect(corrected.state.presentOwnerIds).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(corrected.state.viewpointOwnerId).toBe(b.id);
    expect(corrected.transition?.reason).toBe('user_corrected');
    expect(corrected.transition?.confidence).toBe(1);
  });
});
