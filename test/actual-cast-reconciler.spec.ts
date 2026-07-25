import { describe, expect, it, vi } from 'vitest';
import { ActualCastReconciler, ActorRegistry, SceneStateReducer, type SceneStateStore } from '../src/application/actors';
import type { GenerationCastPlan, SceneState, SceneTransition } from '../src/domain';
import type { SourceBlock } from '../src/application/ingest/types';

function source(id: string, floor: number, content: string, extra: Partial<SourceBlock> = {}): SourceBlock {
  return { id, chatKey: 'chat', kind: 'message', role: 'assistant', content, floor, createdAt: floor, ...extra };
}

function store(initial?: SceneState): SceneStateStore & { state?: SceneState; transitions: SceneTransition[] } {
  return {
    state: initial,
    transitions: [],
    getSceneState() { return this.state; },
    listSceneCasts() { return []; },
    saveSceneState(state, transition) { this.state = state; if (transition) this.transitions.push(transition); },
  };
}

function plan(a: string, input: Partial<GenerationCastPlan> = {}): GenerationCastPlan {
  return {
    id: 'plan', workspaceId: 'workspace', chatKey: 'chat', sceneId: 'scene:1', basedOnFloor: 10,
    mode: 'single_actor', viewpointOwnerId: a, requiredOwnerIds: [a], likelyOwnerIds: [], backgroundOwnerIds: [],
    mentionedOnlyOwnerIds: [], excludedOwnerIds: [], permissionByOwner: { [a]: 'full' },
    plannerMode: 'deterministic', confidence: 1, evidence: [], newActorProposals: [], createdAt: 10, ...input,
  };
}

describe('ActualCastReconciler', () => {
  it('allows an unplanned actor to appear without retroactive private memory and adds it to the next SceneState', async () => {
    const registry = new ActorRegistry('workspace');
    const a = registry.discover({ displayName: 'A', sourceRef: 'card:a', sourceType: 'host_card', confidence: 0.99 }).owner;
    const c = registry.discover({ displayName: 'C', sourceRef: 'card:c', sourceType: 'host_card', confidence: 0.99 }).owner;
    const sceneStore = store({
      id: 'state', workspaceId: 'workspace', chatKey: 'chat', sceneId: 'scene:1', sceneEpoch: 1,
      locationKeys: ['加油站'], viewpointOwnerId: a.id, presentOwnerIds: [a.id], nearbyOwnerIds: [], exitedOwnerIds: [],
      recentSpeakerOwnerIds: [a.id], mentionedOwnerIds: [], startedAtFloor: 1, updatedAtFloor: 10,
      confidence: 1, revision: 1, sourceRefs: [], createdAt: 1, updatedAt: 10,
    });
    const saveAudit = vi.fn();
    const reconciler = new ActualCastReconciler(registry, new SceneStateReducer(registry, sceneStore), { saveAudit });
    const generated = source('message:11', 11, 'C推门而入，打断了A。', {
      perspective: { speakerOwnerRef: c.id, presentOwnerRefs: [a.id, c.id] },
      transition: { enteredOwnerRefs: [c.id] },
    });
    const result = await reconciler.reconcile({ plan: plan(a.id), sources: [generated], generatedSource: generated, currentFloor: 11, unplannedActorPolicy: 'allow_public_only', now: 11 });
    expect(result.unplannedOwnerIds).toContain(c.id);
    expect(result.state.presentOwnerIds).toEqual(expect.arrayContaining([a.id, c.id]));
    expect(result.audit).toMatchObject({ result: 'partial', leakageRisk: false });
    expect(saveAudit).toHaveBeenCalledTimes(1);
  });

  it('creates a provisional NPC only after official output, then merges it when the NPC states a name', async () => {
    const registry = new ActorRegistry('workspace');
    const a = registry.discover({ displayName: 'A', sourceRef: 'card:a', sourceType: 'host_card', confidence: 0.99 }).owner;
    const sceneStore = store();
    const reconciler = new ActualCastReconciler(registry, new SceneStateReducer(registry, sceneStore), { saveAudit: vi.fn() });
    const generated = source('message:21', 21, '一个黄色雨衣女孩站在便利店门口。她说：“我叫夏璃。”', {
      perspective: { speakerOwnerRef: '黄色雨衣女孩' },
      transition: { enteredOwnerRefs: ['黄色雨衣女孩'] },
    });
    const result = await reconciler.reconcile({
      plan: plan(a.id, {
        id: 'plan:npc', basedOnFloor: 20,
        newActorProposals: [{ localId: 'proposal:1', displayName: '黄色雨衣女孩', aliases: ['便利店门口的女孩'], sourceRefs: [], confidence: 0.8 }],
      }),
      sources: [generated], generatedSource: generated, currentFloor: 21, now: 21,
    });
    expect(result.promotions).toHaveLength(1);
    expect(result.promotions[0]).toMatchObject({ canonicalName: '夏璃' });
    const stable = registry.resolveMention('夏璃')?.owner;
    expect(stable).toMatchObject({ displayName: '夏璃', status: 'confirmed' });
    expect(registry.resolveMention('黄色雨衣女孩')?.owner.id).toBe(stable?.id);
    expect(registry.listOwners().some((owner) => owner.id === result.promotions[0]?.fromOwnerId)).toBe(false);
  });
});
