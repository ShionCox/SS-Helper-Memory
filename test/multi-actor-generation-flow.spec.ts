import { describe, expect, it, vi } from 'vitest';
import { ActorRegistry, CastCandidateResolver, GenerationCastPlanner, SceneStateReducer, type CastDirector, type SceneStateStore } from '../src/application/actors';
import { GenerationMemoryCoordinator } from '../src/application/generation';
import { buildActorMemoryPromptResult } from '../src/application/prompt';
import { RecallCoverageVerifier, buildMemoryRecallPacket } from '../src/application/recall';
import { DEFAULT_CAST_SETTINGS, type ActorMemoryTrace, type ActorRecallResponse, type MemoryFact, type SceneState, type SceneTransition } from '../src/domain';
import type { SourceBlock } from '../src/application/ingest/types';

function source(id: string, floor: number, content: string, extra: Partial<SourceBlock> = {}): SourceBlock {
  return { id, chatKey: 'chat', kind: 'message', role: 'assistant', content, floor, createdAt: floor, ...extra };
}

function store(): SceneStateStore & { state?: SceneState; transitions: SceneTransition[] } {
  return {
    state: undefined,
    transitions: [],
    getSceneState() { return this.state; },
    listSceneCasts() { return []; },
    saveSceneState(state, transition) { this.state = state; if (transition) this.transitions.push(transition); },
  };
}

function fact(id: string, content: string): MemoryFact {
  return { id, chatKey: 'chat', kind: 'event', subjectKey: 'A', predicateKey: '记得', canonicalKey: `${id}:记得`, content, entityKeys: ['加油站'], confidence: 1, status: 'active', sourceRefs: ['message:1'], evidenceIds: ['evidence:1'], freshestEvidenceAt: 1, origin: 'automatic', revision: 1, createdAt: 1, updatedAt: 1 };
}

describe('multi-actor generation memory flow', () => {
  it('runs SceneState → deterministic cast → owner recall → coverage → partitioned prompt for an explicit target', async () => {
    const registry = new ActorRegistry('workspace');
    const a = registry.discover({ displayName: 'A', sourceRef: 'card:a', sourceType: 'host_card', confidence: 0.99 }).owner;
    const b = registry.discover({ displayName: 'B', sourceRef: 'card:b', sourceType: 'host_card', confidence: 0.99 }).owner;
    const sources = [
      source('message:1', 1, 'A和B一起进入加油站。', { transition: { enteredOwnerRefs: [a.id, b.id], locationKeys: ['加油站'] } }),
      source('message:2', 2, 'A，你还记得那个加油站吗？', { role: 'user' }),
    ];
    const memory = fact('fact:a', 'A记得加油站有三台加油机，其中一台被汽车残骸压垮。');
    const trace: ActorMemoryTrace = {
      id: 'trace:a', workspaceId: 'workspace', ownerId: a.id, factId: memory.id,
      sourceObservationIds: ['observation:a'], knowledgeMode: 'experienced', privacy: 'private', strength: 90,
      clarity: 100, beliefConfidence: 1, emotionalSalience: 20, rehearsalCount: 0, traceRevision: 1,
      learnedAt: 1, createdAt: 1, updatedAt: 1,
    };
    const packet = buildMemoryRecallPacket(trace, memory, 2, 'scene:1')!;
    const directorPlan = vi.fn<CastDirector['plan']>();
    const commitPrepared = vi.fn(async () => undefined);
    const recall = vi.fn(async ({ query, scene, castPlan, intentPlan }: Parameters<ConstructorParameters<typeof GenerationMemoryCoordinator>[4]['recall']>[0]): Promise<ActorRecallResponse> => ({
      request: { workspaceId: 'workspace', chatKey: 'chat', query, scene, castPlan, intentPlan, now: 2 },
      world: { ownerId: 'owner:world', ownerName: '世界', role: 'world', packets: [] },
      narrator: { ownerId: 'owner:narrator', ownerName: '旁白', role: 'narrator', packets: [] },
      actors: [{ ownerId: a.id, ownerName: 'A', role: 'actor', packets: [packet] }],
      diagnostics: { candidateCount: 1, selectedCount: 1, partitions: 3, mode: 'strict_pov', elapsedMs: 1, ownerCandidateCounts: { [a.id]: 1 }, permissionByOwner: castPlan.permissionByOwner },
    }));
    const coordinator = new GenerationMemoryCoordinator(
      new SceneStateReducer(registry, store()),
      new CastCandidateResolver(registry),
      new GenerationCastPlanner({ plan: directorPlan }),
      new RecallCoverageVerifier(),
      {
        collectSources: async () => sources,
        listEpisodes: async () => [],
        listFacts: async () => [memory],
        listTraces: async () => [trace],
        resolveOwnerName: (name) => registry.resolveMention(name)?.owner.id,
        recall,
        buildPrompt: (response, castPlan, maxChars) => buildActorMemoryPromptResult(response, { castPlan, maxChars }),
        commitPrepared,
      },
    );

    const prepared = await coordinator.prepareGenerationMemory({
      workspaceId: 'workspace', chatKey: 'chat', currentFloor: 2, userMessage: 'A，你还记得那个加油站吗？',
      maxItems: 12, maxChars: 8_000, settings: { ...DEFAULT_CAST_SETTINGS }, now: 2,
    });
    expect(directorPlan).not.toHaveBeenCalled();
    expect(prepared.sceneState.presentOwnerIds).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(prepared.castPlan.requiredOwnerIds).toEqual([a.id]);
    expect(prepared.castPlan.likelyOwnerIds).toEqual([]);
    expect(prepared.castPlan.backgroundOwnerIds).toEqual([]);
    expect(prepared.coverage.covered).toBe(true);
    expect(prepared.prompt.prompt).toContain('<generation_cast>');
    expect(prepared.prompt.prompt).toContain('确定参与：A');
    expect(prepared.prompt.prompt).toContain('permission="full"');
    expect(prepared.prompt.prompt).toContain('三台加油机');
    expect(prepared.prompt.prompt).not.toContain(`owner_id="${b.id}"`);
    expect(commitPrepared).toHaveBeenCalledWith(expect.objectContaining({
      plan: expect.objectContaining({ id: prepared.castPlan.id }),
      coverage: expect.objectContaining({ covered: true, expanded: false }),
    }));
    expect(recall).toHaveBeenCalledTimes(1);
  });
});
