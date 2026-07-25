import { describe, expect, it, vi } from 'vitest';
import { OwnerAwareRecallCoordinator } from '../src/application/recall';
import type { ActorMemoryTrace, GenerationCastPlan, GenerationRecallIntentPlan, MemoryFact, MemoryOwner, SceneCast } from '../src/domain';
import type { RecallFact, RecallQuery, RecallResult } from '../src/application/recall/memory-recall-index';

const A = 'owner:actor:a';
const B = 'owner:actor:b';

function fact(id: string, content: string, kind: MemoryFact['kind'] = 'event'): MemoryFact {
  return {
    id, chatKey: 'chat', kind, subjectKey: id.startsWith('a') ? A : B, predicateKey: '记得',
    canonicalKey: `${id}:记得`, content, entityKeys: [], confidence: 0.96, status: 'active',
    sourceRefs: [`message:${id}`], evidenceIds: [`evidence:${id}`], freshestEvidenceAt: 100,
    origin: 'automatic', revision: 1, createdAt: 100, updatedAt: 100,
  };
}

function directIntent(): GenerationRecallIntentPlan {
  return {
    query: '红色钥匙', timeMode: 'current', actorMode: 'single_pov', namedOwnerIds: [A], entityKeys: ['钥匙'],
    requestedKinds: ['event'], subQueries: [{ id: 'key', query: '红色钥匙', targetOwnerIds: [A], targetKinds: ['event'] }],
    complexity: 'direct', graphHops: 0, requireVerification: false, terms: ['红色钥匙'], source: 'rules',
  };
}

function trace(id: string, ownerId: string, factId: string, input: Partial<ActorMemoryTrace> = {}): ActorMemoryTrace {
  return {
    id, workspaceId: 'workspace', ownerId, factId, sourceObservationIds: [`observation:${id}`],
    knowledgeMode: 'experienced', privacy: 'public', strength: 80, clarity: 100,
    beliefConfidence: 1, emotionalSalience: 0, rehearsalCount: 0, traceRevision: 1,
    learnedAt: 100, createdAt: 100, updatedAt: 100, ...input,
  };
}

function owner(ownerId: string): MemoryOwner {
  return {
    id: ownerId, workspaceId: 'workspace', kind: 'actor', displayName: ownerId === A ? 'A' : 'B',
    aliases: [ownerId === A ? 'A' : 'B'], status: 'confirmed', discoverySources: ['message'],
    confidence: 1, createdAt: 1, updatedAt: 1,
  };
}

function scene(): SceneCast {
  return {
    id: 'scene', workspaceId: 'workspace', chatKey: 'chat', floor: 10, members: [], viewpointOwnerId: A,
    speakerOwnerIds: [A, B], presentOwnerIds: [A, B], mentionedOwnerIds: [A, B], createdAt: 100,
  };
}

function plan(permissionByOwner: GenerationCastPlan['permissionByOwner'] = { [A]: 'full', [B]: 'full' }): GenerationCastPlan {
  return {
    id: 'plan', workspaceId: 'workspace', chatKey: 'chat', sceneId: 'scene:1', basedOnFloor: 10,
    mode: 'multi_actor', viewpointOwnerId: A, requiredOwnerIds: [A, B], likelyOwnerIds: [],
    backgroundOwnerIds: [], mentionedOnlyOwnerIds: [], excludedOwnerIds: [], permissionByOwner,
    plannerMode: 'deterministic', confidence: 1, evidence: [], newActorProposals: [], createdAt: 100,
  };
}

function result(query: RecallQuery, facts: ReadonlyMap<string, MemoryFact>): RecallResult {
  const allowed = new Set(query.allowedFactIds ?? []);
  const selected = [...facts.values()].filter((item) => allowed.has(item.id)).slice(0, query.maxItems ?? 12);
  return {
    chatKey: query.chatKey, query: query.query, maxItems: query.maxItems ?? 12, createdAt: 100,
    items: selected.map((item, index) => ({
      fact: item as RecallFact, score: 1 - index * 0.01,
      reason: { lexical: true, entity: false, context: false, stableAnchor: false },
    })),
    candidates: selected.map((item, index) => ({ factId: item.id, score: 1 - index * 0.01, selected: true, reasonCodes: ['lexical'] })),
    diagnostics: { candidateCount: selected.length, eligibleCount: selected.length, selectedCount: selected.length, llmCalls: 0 },
  };
}

describe('OwnerAwareRecallCoordinator', () => {
  it('stops at lexical retrieval for a high-confidence direct hit', async () => {
    const item = fact('a-key', 'A记得红色钥匙放在抽屉里。');
    const facts = new Map([[item.id, item]]);
    const queries: RecallQuery[] = [];
    const singlePlan = { ...plan({ [A]: 'full' }), requiredOwnerIds: [A], viewpointOwnerId: A, mode: 'single_actor' as const };
    const response = await new OwnerAwareRecallCoordinator({
      recallObjective: (query) => { queries.push(query); return result(query, facts); },
      listTraces: () => [trace('trace-a-key', A, item.id)], getFact: (id) => facts.get(id), getOwner: (id) => owner(id),
    }).recall({ workspaceId: 'workspace', chatKey: 'chat', query: '红色钥匙', scene: scene(), castPlan: singlePlan, intentPlan: directIntent(), now: 100 });
    expect(queries.map((query) => query.retrievalLevel)).toEqual([1]);
    expect(response.diagnostics.retrievalLevelByOwner?.[A]).toBe(1);
    expect(response.diagnostics.retrievalStagesByOwner?.[A]).toEqual(['场景缓存与稳定锚点', '关键词与精确实体']);
  });

  it('expands a weak direct query once from lexical to vector retrieval', async () => {
    const item = fact('a-key', 'A记得红色钥匙放在抽屉里。');
    const facts = new Map([[item.id, item]]);
    const queries: RecallQuery[] = [];
    const singlePlan = { ...plan({ [A]: 'full' }), requiredOwnerIds: [A], viewpointOwnerId: A, mode: 'single_actor' as const };
    const response = await new OwnerAwareRecallCoordinator({
      recallObjective: (query) => {
        queries.push(query);
        return query.retrievalLevel === 1
          ? { ...result(query, new Map()), items: [], candidates: [], diagnostics: { candidateCount: 0, eligibleCount: 0, selectedCount: 0, llmCalls: 0 } }
          : result(query, facts);
      },
      listTraces: () => [trace('trace-a-key', A, item.id)], getFact: (id) => facts.get(id), getOwner: (id) => owner(id),
    }).recall({ workspaceId: 'workspace', chatKey: 'chat', query: '钥匙在哪', scene: scene(), castPlan: singlePlan, intentPlan: directIntent(), now: 100 });
    expect(queries.map((query) => query.retrievalLevel)).toEqual([1, 2]);
    expect(response.diagnostics.retrievalLevelByOwner?.[A]).toBe(2);
    expect(response.actors.find((partition) => partition.ownerId === A)?.packets).toHaveLength(1);
  });

  it('builds independent pre-TopK fact pools so A cannot starve B', async () => {
    const facts = new Map<string, MemoryFact>();
    const traces: ActorMemoryTrace[] = [];
    for (let index = 0; index < 12; index += 1) {
      const item = fact(`a-${index}`, `A 的高分记忆 ${index}`);
      facts.set(item.id, item);
      traces.push(trace(`trace-a-${index}`, A, item.id, { strength: 95 }));
    }
    const bFact = fact('b-only', 'B 独有的红色钥匙记忆');
    facts.set(bFact.id, bFact);
    traces.push(trace('trace-b', B, bFact.id, { strength: 90 }));
    const recallObjective = vi.fn((query: RecallQuery) => result(query, facts));
    const response = await new OwnerAwareRecallCoordinator({
      recallObjective, listTraces: () => traces, getFact: (id) => facts.get(id), getOwner: (id) => owner(id),
    }).recall({ workspaceId: 'workspace', chatKey: 'chat', query: '钥匙', scene: scene(), castPlan: plan(), maxItems: 5, now: 100 });

    const aCall = recallObjective.mock.calls.find(([query]) => query.allowedFactIds?.some((id) => id.startsWith('a-')))?.[0];
    const bCall = recallObjective.mock.calls.find(([query]) => query.allowedFactIds?.includes('b-only'))?.[0];
    expect(aCall?.allowedFactIds).toHaveLength(12);
    expect(bCall?.allowedFactIds).toEqual(['b-only']);
    expect(response.actors.find((partition) => partition.ownerId === A)?.packets).toHaveLength(5);
    expect(response.actors.find((partition) => partition.ownerId === B)?.packets.map((packet) => packet.factId)).toEqual(['b-only']);
    expect(response.diagnostics.ownerCandidateCounts?.[B]).toBe(1);
  });

  it('filters private and future knowledge before retrieval for public-only actors', async () => {
    const privateFact = fact('b-private', 'B 的私密计划');
    const futureFact = fact('b-future', 'B 在未来才知道的出口');
    const publicFact = fact('b-public', 'B 的公开身份是修理工', 'identity');
    const facts = new Map([[privateFact.id, privateFact], [futureFact.id, futureFact], [publicFact.id, publicFact]]);
    const traces = [
      trace('trace-private', B, privateFact.id, { privacy: 'private' }),
      trace('trace-future', B, futureFact.id, { learnedAt: 500 }),
      trace('trace-public', B, publicFact.id, { privacy: 'public', learnedAt: 90 }),
    ];
    const recallObjective = vi.fn((query: RecallQuery) => result(query, facts));
    const response = await new OwnerAwareRecallCoordinator({
      recallObjective, listTraces: () => traces, getFact: (id) => facts.get(id), getOwner: (id) => owner(id),
    }).recall({
      workspaceId: 'workspace', chatKey: 'chat', query: 'B是谁', scene: scene(),
      castPlan: { ...plan({ [A]: 'full', [B]: 'public_only' }), requiredOwnerIds: [A], likelyOwnerIds: [B] },
      now: 100,
    });
    const bCall = recallObjective.mock.calls.find(([query]) => query.allowedFactIds?.includes('b-public'))?.[0];
    expect(bCall?.allowedFactIds).toEqual(['b-public']);
    expect(response.actors.find((partition) => partition.ownerId === B)?.packets.map((packet) => packet.factId)).toEqual(['b-public']);
  });

  it('realizes the same fact differently for owners with strength 50 and 90 without changing the fact', async () => {
    const shared = fact('shared', '加油站有三台加油机，一台被汽车残骸压垮，另外两台覆盖紫色苔藓，整体破败。');
    const facts = new Map([[shared.id, shared]]);
    const traces = [
      trace('trace-a', A, shared.id, { strength: 50, clarity: 100 }),
      trace('trace-b', B, shared.id, { strength: 90, clarity: 100 }),
    ];
    const response = await new OwnerAwareRecallCoordinator({
      recallObjective: (query) => result(query, facts), listTraces: () => traces,
      getFact: (id) => facts.get(id), getOwner: (id) => owner(id),
    }).recall({ workspaceId: 'workspace', chatKey: 'chat', query: '加油站', scene: scene(), castPlan: plan(), now: 100 });
    const aPacket = response.actors.find((partition) => partition.ownerId === A)?.packets[0];
    const bPacket = response.actors.find((partition) => partition.ownerId === B)?.packets[0];
    expect(bPacket?.effectiveStrength).toBeGreaterThan(aPacket?.effectiveStrength ?? 0);
    expect(bPacket?.details.length).toBeGreaterThan(aPacket?.details.length ?? 0);
    expect(bPacket?.omittedDetailCount).toBeLessThan(aPacket?.omittedDetailCount ?? Number.POSITIVE_INFINITY);
    expect(shared.content).toContain('三台加油机');
  });
});
