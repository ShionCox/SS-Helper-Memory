import { describe, expect, it, vi } from 'vitest';
import { GenerationCastPlanner, type CastDirector, type CastCandidateResolution } from '../src/application/actors';
import { DEFAULT_CAST_SETTINGS, type GenerationCastCandidate, type SceneState } from '../src/domain';

function scene(presentOwnerIds = ['actor:a']): SceneState {
  return {
    id: 'state', workspaceId: 'workspace', chatKey: 'chat', sceneId: 'scene:1', sceneEpoch: 1,
    locationKeys: [], viewpointOwnerId: 'actor:a', presentOwnerIds, nearbyOwnerIds: [], exitedOwnerIds: [],
    recentSpeakerOwnerIds: ['actor:a'], mentionedOwnerIds: [], startedAtFloor: 1, updatedAtFloor: 10,
    confidence: 0.9, revision: 1, sourceRefs: [], createdAt: 1, updatedAt: 10,
  };
}

function candidate(ownerId: string, score: number, extra: Partial<GenerationCastCandidate> = {}): GenerationCastCandidate {
  return {
    ownerId, displayName: ownerId.split(':').at(-1)?.toUpperCase() ?? ownerId, score,
    reasonCodes: ['scene_presence'], sourceRefs: [], explicitlyAddressed: false, hostSelected: false,
    viewpoint: ownerId === 'actor:a', present: true, mentionedOnly: false, exited: false, ...extra,
  };
}

function resolution(candidates: GenerationCastCandidate[], explicitAddressOwnerIds: string[] = []): CastCandidateResolution {
  return { candidates, explicitAddressOwnerIds, directFollowUp: false, confidence: candidates[0]?.score ?? 0 };
}

function input(candidateResolution: CastCandidateResolution, message = '继续') {
  return {
    workspaceId: 'workspace', chatKey: 'chat', currentFloor: 10, userMessage: message,
    sceneState: scene(candidateResolution.candidates.map((item) => item.ownerId)), candidateResolution,
    settings: { ...DEFAULT_CAST_SETTINGS }, now: 10,
  };
}

describe('GenerationCastPlanner', () => {
  it('does not call the director for one explicitly addressed actor and gives no token budget to others', async () => {
    const planDirector = vi.fn<CastDirector['plan']>();
    const planner = new GenerationCastPlanner({ plan: planDirector });
    const a = candidate('actor:a', 1, { explicitlyAddressed: true, reasonCodes: ['explicit_address'] });
    const b = candidate('actor:b', 0.8);
    const plan = await planner.plan(input(resolution([a, b], ['actor:a']), 'A，你还记得加油站吗？'));
    expect(planDirector).not.toHaveBeenCalled();
    expect(plan.requiredOwnerIds).toEqual(['actor:a']);
    expect(plan.likelyOwnerIds).toEqual([]);
    expect(plan.backgroundOwnerIds).toEqual([]);
    expect(plan.permissionByOwner['actor:a']).toBe('full');
    expect(plan.permissionByOwner['actor:b']).toBeUndefined();
  });

  it('runs the hybrid director once for an ambiguous group turn and rejects stable owners outside the candidate set', async () => {
    const planDirector = vi.fn<CastDirector['plan']>().mockResolvedValue({
      mode: 'multi_actor', requiredOwnerIds: ['actor:a', 'actor:outside'], likelyOwnerIds: ['actor:b'],
      backgroundOwnerIds: ['actor:c'], mentionedOnlyOwnerIds: [], excludedOwnerIds: [], confidence: 0.88,
    });
    const planner = new GenerationCastPlanner({ plan: planDirector });
    const candidates = [candidate('actor:a', 0.8), candidate('actor:b', 0.78), candidate('actor:c', 0.72)];
    const plan = await planner.plan(input(resolution(candidates), '继续'));
    const repeated = await planner.plan(input(resolution(candidates), '继续'));
    expect(planDirector).toHaveBeenCalledTimes(1);
    expect(repeated.id).toBe(plan.id);
    expect(plan.plannerMode).toBe('llm_assisted');
    expect(plan.requiredOwnerIds).toContain('actor:a');
    expect(plan.requiredOwnerIds).not.toContain('actor:outside');
    expect(plan.likelyOwnerIds).toContain('actor:b');
  });

  it('falls back to the deterministic plan when the director fails', async () => {
    const planDirector = vi.fn<CastDirector['plan']>().mockRejectedValue(new Error('timeout'));
    const planner = new GenerationCastPlanner({ plan: planDirector });
    const candidates = [candidate('actor:a', 0.7), candidate('actor:b', 0.69), candidate('actor:c', 0.65)];
    const plan = await planner.plan(input(resolution(candidates), '继续'));
    expect(planDirector).toHaveBeenCalledTimes(1);
    expect(plan.plannerMode).toBe('deterministic');
    expect(plan.evidence.some((item) => item.reasonCode === 'director_fallback')).toBe(true);
  });
});
