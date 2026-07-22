import { describe, expect, it } from 'vitest';
import { ActorRecallService } from '../src/application/recall';
import type { ActorMemoryTrace, MemoryFact } from '../src/domain';

describe('actor pipeline performance budget', () => {
  it('recalls 50k traces over 10k facts within the v0 300ms pipeline budget', async () => {
    const now = Date.now();
    const facts = new Map<string, MemoryFact>();
    for (let i = 0; i < 10_000; i++) facts.set(`f${i}`, { id: `f${i}`, chatKey: 'chat', kind: 'event', subjectKey: 'A', predicateKey: 'knows', canonicalKey: `f${i}`, content: `fact ${i} copper key`, entityKeys: [], confidence: 1, status: 'active', sourceRefs: ['s'], evidenceIds: ['e'], freshestEvidenceAt: now, origin: 'automatic', revision: 1, createdAt: now, updatedAt: now });
    const traces: ActorMemoryTrace[] = Array.from({ length: 50_000 }, (_, i) => ({ id: `t${i}`, workspaceId: 'w', ownerId: 'owner:actor:a', factId: `f${i % 10_000}`, sourceObservationIds: ['o'], knowledgeMode: 'experienced', privacy: 'public', strength: 80, clarity: 80, beliefConfidence: 1, emotionalSalience: 1, rehearsalCount: 0, traceRevision: 1, createdAt: now, updatedAt: now }));
    const service = new ActorRecallService({ recallObjective: () => ({ chatKey: 'chat', query: 'copper', maxItems: 20, items: [...facts.values()].slice(0, 20).map(fact => ({ fact, score: 1, reason: { lexical: true, entity: false, context: false, stableAnchor: false } })), candidates: [], diagnostics: { candidateCount: 20, eligibleCount: 20, selectedCount: 20, llmCalls: 0 }, createdAt: now }), listTraces: () => traces, getFact: id => facts.get(id) });
    const request = { workspaceId: 'w', chatKey: 'chat', query: 'copper', scene: { id: 's', workspaceId: 'w', chatKey: 'chat', floor: 1, members: [], viewpointOwnerId: 'owner:actor:a', speakerOwnerIds: ['owner:actor:a'], presentOwnerIds: ['owner:actor:a'], mentionedOwnerIds: [], createdAt: 1 } } as const;
    const durations: number[] = [];
    let response = await service.recall(request);
    for (let run = 0; run < 5; run += 1) {
      const start = performance.now();
      response = await service.recall(request);
      durations.push(performance.now() - start);
    }
    durations.sort((left, right) => left - right);
    const elapsed = durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)] ?? 0;
    expect(response.actors[0]?.packets.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(300);
  });
});
