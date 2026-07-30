import { describe, expect, it, vi } from 'vitest';
import { RecallCoverageVerifier, buildMemoryRecallPacket } from '../src/application/recall';
import type { ActorMemoryTrace, ActorRecallResponse, GenerationCastPlan, GenerationRecallIntentPlan, MemoryFact } from '../src/domain';

const A = 'owner:actor:a';
const B = 'owner:actor:b';

function fact(id: string, content: string): MemoryFact {
  return { id, chatKey: 'chat', kind: 'event', subjectKey: A, predicateKey: '记得', canonicalKey: `${id}:记得`, content, entityKeys: [], confidence: 1, status: 'active', sourceRefs: ['m'], evidenceIds: ['e'], freshestEvidenceAt: 1, origin: 'automatic', revision: 1, createdAt: 1, updatedAt: 1 };
}

function trace(id: string, ownerId: string, factId: string, privacy: ActorMemoryTrace['privacy'] = 'public'): ActorMemoryTrace {
  return { id, workspaceId: 'workspace', chatKey: 'chat', ownerId, factId, sourceObservationIds: ['o'], knowledgeMode: 'experienced', privacy, strength: 90, clarity: 100, beliefConfidence: 1, emotionalSalience: 0, rehearsalCount: 0, traceRevision: 1, learnedAt: 1, createdAt: 1, updatedAt: 1 };
}

function castPlan(): GenerationCastPlan {
  return { id: 'plan', workspaceId: 'workspace', chatKey: 'chat', sceneId: 'scene', basedOnFloor: 1, mode: 'multi_actor', viewpointOwnerId: A, requiredOwnerIds: [A, B], likelyOwnerIds: [], backgroundOwnerIds: [], mentionedOnlyOwnerIds: [], excludedOwnerIds: [], permissionByOwner: { [A]: 'full', [B]: 'public_only' }, plannerMode: 'deterministic', confidence: 1, evidence: [], newActorProposals: [], createdAt: 1 };
}

function intent(): GenerationRecallIntentPlan {
  return { query: 'A为什么害怕加油站，B知不知道原因？', timeMode: 'historical', actorMode: 'planned_cast', namedOwnerIds: [A, B], entityKeys: ['加油站'], requestedKinds: ['event'], subQueries: [
    { id: 'a-reason', query: 'A害怕加油站的原因', targetOwnerIds: [A], targetKinds: ['event'] },
    { id: 'b-knows', query: 'B是否知道加油站原因', targetOwnerIds: [B], targetKinds: ['event'] },
  ], complexity: 'multi_hop', graphHops: 2, requireVerification: true, terms: ['加油站'], source: 'rules' };
}

function response(includeB: boolean, bPrivate = false): { response: ActorRecallResponse; traces: ActorMemoryTrace[] } {
  const factA = fact('fact-a', 'A在加油站遭遇过事故，因此害怕加油站。');
  const factB = fact('fact-b', 'B听说过A害怕加油站的原因。');
  const traceA = trace('trace-a', A, factA.id);
  const traceB = trace('trace-b', B, factB.id, bPrivate ? 'private' : 'public');
  const packetA = buildMemoryRecallPacket(traceA, factA, 1, 'scene')!;
  const packetB = buildMemoryRecallPacket(traceB, factB, 1, 'scene')!;
  return {
    response: {
      request: { workspaceId: 'workspace', chatKey: 'chat', query: intent().query, scene: { id: 'scene', workspaceId: 'workspace', chatKey: 'chat', floor: 1, members: [], viewpointOwnerId: A, speakerOwnerIds: [A], presentOwnerIds: [A, B], mentionedOwnerIds: [], createdAt: 1 }, castPlan: castPlan(), intentPlan: intent() },
      world: { ownerId: 'owner:world', ownerName: '世界', role: 'world', packets: [] },
      narrator: { ownerId: 'owner:narrator', ownerName: '旁白', role: 'narrator', packets: [] },
      actors: [
        { ownerId: A, ownerName: 'A', role: 'actor', packets: [packetA] },
        { ownerId: B, ownerName: 'B', role: 'actor', packets: includeB ? [packetB] : [] },
      ],
      diagnostics: { candidateCount: includeB ? 2 : 1, selectedCount: includeB ? 2 : 1, partitions: 4, mode: 'multi_actor', elapsedMs: 1 },
    },
    traces: [traceA, traceB],
  };
}

describe('RecallCoverageVerifier', () => {
  it('reports missing owners and sub-queries, then performs at most one controlled expansion', async () => {
    const verifier = new RecallCoverageVerifier();
    const first = response(false);
    const expanded = response(true);
    const expand = vi.fn().mockResolvedValue(expanded.response);
    const result = await verifier.verifyWithExpansion({ castPlan: castPlan(), intent: intent(), response: first.response, traces: first.traces }, expand);
    expect(expand).toHaveBeenCalledTimes(1);
    expect(result.expanded).toBe(true);
    expect(result.coverage.covered).toBe(true);
    expect(result.results.diagnostics.coverage?.covered).toBe(true);
    expect(result.attempts.map(attempt => attempt.kind)).toEqual(['primary', 'coverage_expansion']);
  });

  it('fails closed on a private trace in a public-only partition and does not request expansion', () => {
    const data = response(true, true);
    const coverage = new RecallCoverageVerifier().verify({ castPlan: castPlan(), intent: intent(), response: data.response, traces: data.traces });
    expect(coverage.covered).toBe(false);
    expect(coverage.privacyViolations).toEqual([expect.objectContaining({ ownerId: B, traceId: 'trace-b' })]);
    expect(coverage.requiresExpansion).toBe(false);
  });

  it('does not require the viewpoint actor for a world-scoped question', () => {
    const data = response(false);
    const actorPacket = data.response.actors[0]!.packets[0]!;
    const worldIntent: GenerationRecallIntentPlan = {
      ...intent(), intentKind: 'world_knowledge', topicTerms: ['加油站'],
      ownerScope: { ownerIds: ['owner:world', 'owner:narrator'], requiredOwnerIds: [], fallback: 'public_relevance' },
      subQueries: [{ id: 'world', query: '加油站是什么', targetOwnerIds: ['owner:world', 'owner:narrator'], targetKinds: ['world_rule'] }],
    };
    const worldResponse: ActorRecallResponse = {
      ...data.response,
      request: { ...data.response.request, intentPlan: worldIntent },
      world: { ...data.response.world, packets: [actorPacket] },
      actors: [],
    };
    const coverage = new RecallCoverageVerifier().verify({ castPlan: castPlan(), intent: worldIntent, response: worldResponse, traces: data.traces });
    expect(coverage.missingOwnerIds).toEqual([]);
    expect(coverage.covered).toBe(true);
  });

  it('skips a coverage pass that produces no new facts', async () => {
    const first = response(false);
    const result = await new RecallCoverageVerifier().verifyWithExpansion({ castPlan: castPlan(), intent: intent(), response: first.response, traces: first.traces }, async () => first.response);
    expect(result.expanded).toBe(false);
    expect(result.expansionSkippedReason).toBe('no_new_candidates');
    expect(result.attempts).toHaveLength(1);
  });
});
