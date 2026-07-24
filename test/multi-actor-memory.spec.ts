import { describe, expect, it } from 'vitest';
import { ActorRegistry, ActiveCastResolver, KnowledgeProjector, MultiActorCaptureService } from '../src/application/actors';
import { buildActorMemoryPromptResult } from '../src/application/prompt';
import { ActorRecallService } from '../src/application/recall';
import { RecallExposureTracker, buildMemoryRecallPacket, deterministicSeed } from '../src/application/recall';
import { auditKnowledgeLeakage, effectiveMemoryStrength } from '../src/application/recall';
import { ProfileCoordinator } from '../src/application/profile';
import { DreamCoordinator } from '../src/application/dream';
import type { ActorMemoryTrace, MemoryFact, MemoryObservation } from '../src/domain';

const source = (id: string, content: string, floor: number, extra: Record<string, unknown> = {}) => ({ id, chatKey: 'chat', kind: 'message' as const, role: 'assistant' as const, content, createdAt: floor, floor, ...extra });

function fact(id: string, content: string): MemoryFact {
  return { id, chatKey: 'chat', kind: 'event', subjectKey: 'A', predicateKey: '知道', canonicalKey: `${id}::知道`, content, entityKeys: [], confidence: 0.95, status: 'active', sourceRefs: ['m1'], evidenceIds: [`e:${id}`], freshestEvidenceAt: 1, origin: 'automatic', revision: 1, createdAt: 1, updatedAt: 1 };
}

describe('卡内多角色认知模型', () => {
  it('宿主卡只作为来源容器，正文自动发现人物并区分提及与在场', () => {
    const registry = new ActorRegistry('character:c1');
    const a = registry.discover({ displayName: 'A', sourceRef: 'card:1', sourceType: 'host_card', confidence: 0.95 });
    const b = registry.discover({ displayName: 'B', sourceRef: 'card:1', sourceType: 'host_card', confidence: 0.95 });
    const cast = new ActiveCastResolver(registry).resolve([
      source('m1', 'A说：我看见了B。', 1, { author: { kind: 'assistant', displayName: 'A' } }),
    ]).scene;
    expect(a.owner.kind).toBe('actor');
    expect(a.owner.id).not.toBe('character:c1');
    expect(cast.speakerOwnerIds).toContain(a.owner.id);
    expect(cast.mentionedOwnerIds).toEqual(expect.arrayContaining([a.owner.id, b.owner.id]));
    expect(cast.presentOwnerIds).toContain(a.owner.id);
    expect(cast.presentOwnerIds).not.toContain(b.owner.id);
  });

  it('助手首人称消息使用宿主作者作为说话者线索，但不把通用 assistant 建成人物', () => {
    const registry = new ActorRegistry('character:c1');
    const cast = new ActiveCastResolver(registry).resolve([
      source('m-first-person', '我把钥匙放在桌上。', 1, { author: { kind: 'assistant', displayName: 'A' } }),
    ]).scene;
    const actor = registry.resolveMention('A')?.owner;
    expect(actor?.kind).toBe('actor');
    expect(actor?.status).toBe('confirmed');
    expect(cast.speakerOwnerIds).toContain(actor?.id);
    expect(cast.presentOwnerIds).toContain(actor?.id);
    expect(registry.resolveMention('assistant')).toBeUndefined();
  });

  it('私密思想只投影给对应主体，世界书只写入世界主体', () => {
    const registry = new ActorRegistry('character:c1');
    const a = registry.discover({ displayName: 'A', sourceRef: 'm1', sourceType: 'message', confidence: 0.95 });
    const b = registry.discover({ displayName: 'B', sourceRef: 'm2', sourceType: 'message', confidence: 0.95 });
    const observations: MemoryObservation[] = [
      { id: 'o-thought', workspaceId: 'character:c1', episodeId: 'e1', sourceRef: 'm1', speakerOwnerId: a.owner.id, viewpointOwnerId: a.owner.id, observerOwnerIds: [], channel: 'private_thought', privacy: 'private', knowledgeMode: 'experienced', excerpt: 'A心想：秘密', mentionedOwnerIds: [b.owner.id], presentOwnerIds: [], factLocalIds: ['f-secret'], occurredAt: 1, createdAt: 1 },
      { id: 'o-world', workspaceId: 'character:c1', episodeId: 'e2', sourceRef: 'worldbook:1', speakerOwnerId: 'owner:world', viewpointOwnerId: 'owner:narrator', observerOwnerIds: [a.owner.id, b.owner.id], channel: 'worldbook', privacy: 'public', knowledgeMode: 'asserted', excerpt: '世界规则', mentionedOwnerIds: [], presentOwnerIds: [a.owner.id, b.owner.id], factLocalIds: ['f-rule'], occurredAt: 1, createdAt: 1 },
    ];
    const projected = new KnowledgeProjector().project({ workspaceId: 'character:c1', facts: [{ ...fact('f-secret', 'A知道秘密内容'), entityKeys: [a.owner.id, b.owner.id] }, { ...fact('f-rule', '世界规则成立'), kind: 'world_rule' }], episodes: [], observations, owners: registry.listOwners() });
    expect(projected.traces.find(trace => trace.factId === 'f-secret')?.ownerId).toBe(a.owner.id);
    expect(projected.traces.filter(trace => trace.factId === 'f-secret').map(trace => trace.ownerId)).not.toContain(b.owner.id);
    expect(projected.traces.find(trace => trace.factId === 'f-rule')?.ownerId).toBe('owner:world');
    expect(projected.traces.filter(trace => trace.factId === 'f-rule').map(trace => trace.ownerId)).not.toEqual(expect.arrayContaining([a.owner.id, b.owner.id]));
  });

  it('传闻和推断只给说话者及明确听见者信念，不生成世界确认', () => {
    const a = 'owner:actor:a';
    const b = 'owner:actor:b';
    const c = 'owner:actor:c';
    const rumor: MemoryObservation = { id: 'o-rumor', workspaceId: 'w', episodeId: 'e-rumor', sourceRef: 'm-rumor', speakerOwnerId: a, viewpointOwnerId: a, observerOwnerIds: [b], channel: 'rumor', privacy: 'public', knowledgeMode: 'believed', excerpt: 'B可能藏了钥匙', mentionedOwnerIds: [c], presentOwnerIds: [a, b], factLocalIds: ['f-rumor'], occurredAt: 1, createdAt: 1 };
    const projected = new KnowledgeProjector().project({ workspaceId: 'w', facts: [fact('f-rumor', 'B可能藏了钥匙')], episodes: [{ id: 'e-rumor', workspaceId: 'w', chatKey: 'chat', floorStart: 1, floorEnd: 1, sourceRefs: ['m-rumor'], participantIds: [a, b], presentOwnerIds: [a, b], mentionedOwnerIds: [c], occurredAt: 1, createdAt: 1 }], observations: [rumor] });
    expect(projected.traces.map(trace => trace.ownerId)).toEqual(expect.arrayContaining([a, b]));
    expect(projected.traces.find(trace => trace.ownerId === a)?.knowledgeMode).toBe('believed');
    expect(projected.traces.find(trace => trace.ownerId === b)?.knowledgeMode).toBe('believed');
    expect(projected.traces.map(trace => trace.ownerId)).not.toContain('owner:world');
  });

  it('合并同一主体的多来源认知时保留最严格隐私并合并全部观察', () => {
    const ownerId = 'owner:actor:a';
    const memory = fact('f-privacy-merge', 'A知道地下室的银钥匙位置');
    const observations: MemoryObservation[] = [
      { id: 'o-public', workspaceId: 'w', episodeId: 'e', sourceRef: 'm-public', speakerOwnerId: ownerId, viewpointOwnerId: ownerId, observerOwnerIds: [ownerId], channel: 'public_speech', privacy: 'public', knowledgeMode: 'self_reported', excerpt: 'A知道地下室的银钥匙位置', mentionedOwnerIds: [], presentOwnerIds: [ownerId], factLocalIds: [memory.id], occurredAt: 1, createdAt: 1 },
      { id: 'o-secret', workspaceId: 'w', episodeId: 'e', sourceRef: 'm-secret', speakerOwnerId: ownerId, viewpointOwnerId: ownerId, observerOwnerIds: [], channel: 'private_thought', privacy: 'secret', knowledgeMode: 'experienced', excerpt: 'A在心中确认银钥匙位置', mentionedOwnerIds: [], presentOwnerIds: [ownerId], factLocalIds: [memory.id], occurredAt: 2, createdAt: 2 },
    ];
    const projected = new KnowledgeProjector().project({ workspaceId: 'w', facts: [memory], episodes: [], observations });
    const trace = projected.traces.find(item => item.ownerId === ownerId && item.factId === memory.id);
    expect(trace).toMatchObject({ knowledgeMode: 'self_reported', privacy: 'secret' });
    expect(new Set(trace?.sourceObservationIds)).toEqual(new Set(['o-public', 'o-secret']));
  });

  it('卡片/世界书明确绑定主体时只播种该主体的画像', () => {
    const registry = new ActorRegistry('character:c1');
    const a = registry.discover({ displayName: 'A', sourceRef: 'card:1', sourceType: 'host_card', confidence: 0.95 });
    const seededFact = { ...fact('f-seed', 'A的核心身份是守门人'), kind: 'identity' as const, entityKeys: [a.owner.id], scope: { hostCardKeys: ['card:1'] } };
    const episode = { id: 'e-seed', workspaceId: 'character:c1', chatKey: 'chat', floorStart: 1, floorEnd: 1, sourceRefs: ['card:1'], participantIds: [a.owner.id], presentOwnerIds: [], mentionedOwnerIds: [a.owner.id], occurredAt: 1, createdAt: 1 };
    const observation: MemoryObservation = { id: 'o-seed', workspaceId: 'character:c1', episodeId: episode.id, sourceRef: 'card:1', speakerOwnerId: 'owner:world', viewpointOwnerId: 'owner:narrator', observerOwnerIds: [], channel: 'worldbook', privacy: 'public', knowledgeMode: 'asserted', excerpt: 'A的核心身份是守门人', mentionedOwnerIds: [a.owner.id], presentOwnerIds: [], factLocalIds: [seededFact.id], occurredAt: 1, createdAt: 1 };
    const projected = new KnowledgeProjector().project({ workspaceId: 'character:c1', facts: [seededFact], episodes: [episode], observations: [observation], owners: registry.listOwners() });
    expect(projected.traces.map(trace => trace.ownerId)).toEqual(expect.arrayContaining(['owner:world', a.owner.id]));
    const profile = new ProfileCoordinator().update(a.owner.id, projected.traces.filter(trace => trace.ownerId === a.owner.id), [seededFact], [], 'character:c1');
    expect(profile.claims[0]?.claim).toBe(seededFact.content);
  });

  it('单次分区 Prompt 不把 A 的私密记忆复制到 B', async () => {
    const a = 'owner:actor:a';
    const b = 'owner:actor:b';
    const facts = new Map([['fa', fact('fa', 'A的秘密是蓝色钥匙')], ['fb', fact('fb', 'B听见了公开消息')]]);
    const traces: ActorMemoryTrace[] = [
      { id: 'ta', workspaceId: 'w', ownerId: a, factId: 'fa', sourceObservationIds: ['oa'], knowledgeMode: 'experienced', privacy: 'private', strength: 90, clarity: 90, beliefConfidence: 1, emotionalSalience: 20, rehearsalCount: 0, traceRevision: 1, createdAt: Date.now(), updatedAt: Date.now() },
      { id: 'tb', workspaceId: 'w', ownerId: b, factId: 'fb', sourceObservationIds: ['ob'], knowledgeMode: 'heard', privacy: 'public', strength: 60, clarity: 60, beliefConfidence: 0.8, emotionalSalience: 10, rehearsalCount: 0, traceRevision: 1, createdAt: Date.now(), updatedAt: Date.now() },
    ];
    const response = await new ActorRecallService({
      recallObjective: () => ({ chatKey: 'chat', query: '钥匙', maxItems: 12, createdAt: 1, items: [...facts.values()].map(item => ({ fact: item, score: 1, reason: { lexical: true, entity: false, context: false, stableAnchor: false } })), candidates: [], diagnostics: { candidateCount: 2, eligibleCount: 2, selectedCount: 2, llmCalls: 0 } }),
      listTraces: () => traces,
      getFact: id => facts.get(id),
      getOwner: id => ({ id, workspaceId: 'w', kind: 'actor', displayName: id === a ? 'A' : 'B', aliases: [], status: 'confirmed', discoverySources: ['message'], confidence: 1, createdAt: 1, updatedAt: 1 }),
    }).recall({ workspaceId: 'w', chatKey: 'chat', query: '钥匙', scene: { id: 's', workspaceId: 'w', chatKey: 'chat', floor: 1, members: [], viewpointOwnerId: a, speakerOwnerIds: [a, b], presentOwnerIds: [a, b], mentionedOwnerIds: [a, b], createdAt: 1 } });
    const prompt = buildActorMemoryPromptResult(response, { maxChars: 4_000 }).prompt;
    expect(prompt).toContain('A的秘密');
    const bSection = prompt.slice(prompt.indexOf(`owner="B"`));
    expect(bSection).not.toContain('A的秘密');
  });

  it('多主体 Prompt 分区预算不超过全局上限，并尊重显式当前视角', () => {
    const a = 'owner:actor:a';
    const b = 'owner:actor:b';
    const traceA: ActorMemoryTrace = { id: 'budget-trace-a', workspaceId: 'w', ownerId: a, factId: 'budget-fact-a', sourceObservationIds: ['oa'], knowledgeMode: 'experienced', privacy: 'public', strength: 90, clarity: 90, beliefConfidence: 1, emotionalSalience: 0, rehearsalCount: 0, traceRevision: 1, createdAt: 1, updatedAt: 1 };
    const traceB: ActorMemoryTrace = { ...traceA, id: 'budget-trace-b', ownerId: b, factId: 'budget-fact-b', sourceObservationIds: ['ob'] };
    const packetA = buildMemoryRecallPacket(traceA, fact('budget-fact-a', 'A记得北门附近有一条安全通道'), 1, 'budget-scene')!;
    const packetB = buildMemoryRecallPacket(traceB, fact('budget-fact-b', 'B记得南侧仓库仍保存着维修工具'), 1, 'budget-scene')!;
    const response = {
      request: {
        workspaceId: 'w', chatKey: 'chat', query: '路线和工具', mode: 'multi_actor' as const,
        scene: { id: 'budget-scene', workspaceId: 'w', chatKey: 'chat', floor: 1, members: [], viewpointOwnerId: a, speakerOwnerIds: [], presentOwnerIds: [a, b], mentionedOwnerIds: [a, b], createdAt: 1 },
      },
      world: { ownerId: 'owner:world', ownerName: '世界', role: 'world' as const, packets: [] },
      narrator: { ownerId: 'owner:narrator', ownerName: '旁白', role: 'narrator' as const, packets: [] },
      actors: [
        { ownerId: a, ownerName: 'A', role: 'actor' as const, packets: [packetA] },
        { ownerId: b, ownerName: 'B', role: 'actor' as const, packets: [packetB] },
      ],
      diagnostics: { candidateCount: 2, selectedCount: 2, partitions: 2, mode: 'multi_actor' as const, elapsedMs: 1 },
    } satisfies import('../src/domain').ActorRecallResponse;

    const result = buildActorMemoryPromptResult(response, { maxChars: 1_000, currentViewpointOwnerId: b });
    const budgetTotal = Object.values(result.diagnostics.partitionBudgets).reduce((sum, value) => sum + value, 0);
    expect(budgetTotal).toBeLessThanOrEqual(1_000);
    expect(result.diagnostics.partitionBudgets[b]).toBeGreaterThan(result.diagnostics.partitionBudgets[a]!);
    expect(result.includedTraceIds).toEqual(expect.arrayContaining([traceA.id, traceB.id]));
  });

  it('强度衰减与模糊包使用稳定种子，候选曝光不会自动 rehearsal', () => {
    const trace: ActorMemoryTrace = { id: 't', workspaceId: 'w', ownerId: 'owner:actor:a', factId: 'f', sourceObservationIds: ['o'], knowledgeMode: 'experienced', privacy: 'private', strength: 90, clarity: 90, beliefConfidence: 1, emotionalSalience: 10, rehearsalCount: 0, traceRevision: 1, createdAt: 1, updatedAt: Date.now() };
    const memory = fact('f', '这是一条需要保留来源的秘密事实');
    const recallNow = Date.now();
    const first = buildMemoryRecallPacket(trace, memory, recallNow, 'scene-1');
    const second = buildMemoryRecallPacket(trace, memory, recallNow, 'scene-1');
    expect(first?.deterministicSeed).toBe(deterministicSeed(trace.ownerId, trace.factId, trace.traceRevision, 'scene-1'));
    expect(first).toEqual(second);
    const tracker = new RecallExposureTracker([trace]);
    const exposure = tracker.expose({ workspaceId: 'w', chatKey: 'chat', ownerId: trace.ownerId, traceId: trace.id, sceneEpoch: 'scene-1', included: true, used: false, confidence: 0.5 });
    expect(tracker.markUsed(exposure.id, 0.4).trace?.rehearsalCount).toBe(0);
    expect(tracker.markUsed(exposure.id, 0.9, true).trace?.rehearsalCount).toBe(1);
  });

  it('按主体记忆特质计算强度，并用显式说话标签审计跨角色泄漏', () => {
    const trace: ActorMemoryTrace = { id: 'trait-trace', workspaceId: 'w', ownerId: 'owner:actor:a', factId: 'trait-fact', sourceObservationIds: ['o'], knowledgeMode: 'experienced', privacy: 'private', strength: 80, clarity: 100, beliefConfidence: 1, emotionalSalience: 0, rehearsalCount: 0, traceRevision: 1, createdAt: 1, updatedAt: 1 };
    const defaultStrength = effectiveMemoryStrength(trace, 1 + 24 * 60 * 60 * 1000);
    const durableStrength = effectiveMemoryStrength(trace, 1 + 24 * 60 * 60 * 1000, { traits: { halfLifeMs: 365 * 24 * 60 * 60 * 1000, rehearsalGain: 0, emotionalGain: 0, interference: 0 } });
    expect(durableStrength).toBeGreaterThan(defaultStrength);

    const packet = buildMemoryRecallPacket(trace, fact('trait-fact', 'A的私密蓝色钥匙'), 1, 'scene-1', { traits: { halfLifeMs: 365 * 24 * 60 * 60 * 1000, rehearsalGain: 0, emotionalGain: 0, interference: 0 } });
    const safePartitions = [
      { ownerId: 'owner:actor:a', ownerName: 'A', role: 'actor' as const, packets: packet ? [packet] : [] },
      { ownerId: 'owner:actor:b', ownerName: 'B', role: 'actor' as const, packets: [] },
    ];
    expect(auditKnowledgeLeakage('B: 我不知道那把钥匙。', safePartitions).violationCount).toBe(0);
    const leaked = auditKnowledgeLeakage(`B: ${packet?.gist ?? ''}`, safePartitions);
    expect(leaked.violationCount).toBe(1);
    expect(leaked.violations[0]).toMatchObject({ ownerId: 'owner:actor:b', leakedFromOwnerId: 'owner:actor:a' });
  });

  it('多主体客观候选池按场景主体扩展，避免高分主体饿死其他分区', async () => {
    const a = 'owner:actor:a';
    const b = 'owner:actor:b';
    const facts = [fact('fa-pool', 'A知道蓝色钥匙'), fact('fb-pool', 'B知道红色钥匙')];
    const traces: ActorMemoryTrace[] = [a, b].map((ownerId, index) => ({ id: `trace-pool-${index}`, workspaceId: 'w', ownerId, factId: facts[index]!.id, sourceObservationIds: [`o-pool-${index}`], knowledgeMode: 'experienced', privacy: 'public', strength: 80, clarity: 80, beliefConfidence: 1, emotionalSalience: 0, rehearsalCount: 0, traceRevision: 1, createdAt: 1, updatedAt: 1 }));
    let objectiveQuery: { maxItems?: number; candidateLimit?: number } | undefined;
    const response = await new ActorRecallService({
      recallObjective: (query) => {
        objectiveQuery = query;
        const limit = query.candidateLimit ?? query.maxItems ?? 1;
        const items = facts.slice(0, limit).map(item => ({ fact: item, score: 1, reason: { lexical: true, entity: false, context: false, stableAnchor: false } }));
        return { chatKey: 'chat', query: query.query, maxItems: query.maxItems ?? 1, createdAt: 1, items, candidates: [], diagnostics: { candidateCount: facts.length, eligibleCount: facts.length, selectedCount: items.length, llmCalls: 0 } };
      },
      listTraces: () => traces,
      getFact: id => facts.find(item => item.id === id),
      getOwner: id => ({ id, workspaceId: 'w', kind: 'actor', displayName: id === a ? 'A' : 'B', aliases: [], status: 'confirmed', discoverySources: ['message'], confidence: 1, createdAt: 1, updatedAt: 1 }),
    }).recall({ workspaceId: 'w', chatKey: 'chat', query: '钥匙', maxItems: 1, scene: { id: 'pool-scene', workspaceId: 'w', chatKey: 'chat', floor: 1, members: [], viewpointOwnerId: a, speakerOwnerIds: [a, b], presentOwnerIds: [a, b], mentionedOwnerIds: [a, b], createdAt: 1 } });
    expect(objectiveQuery?.candidateLimit).toBeGreaterThan(2);
    expect(response.actors.find(partition => partition.ownerId === a)?.packets).toHaveLength(1);
    expect(response.actors.find(partition => partition.ownerId === b)?.packets).toHaveLength(1);
  });

  it('ActorRegistry 局部更新记忆特质时保留未提供字段', () => {
    const registry = new ActorRegistry('w');
    const actor = registry.discover({ displayName: 'A', sourceRef: 'm', sourceType: 'message', confidence: 0.95 }).owner;
    registry.updateMemoryTraits(actor.id, { halfLifeMs: 86_400_000, rehearsalGain: 0.2 });
    expect(registry.getOwner(actor.id)?.memoryTraits).toEqual(expect.objectContaining({ halfLifeMs: 86_400_000, rehearsalGain: 0.2, emotionalGain: 0.15, interference: 0 }));
  });

  it('画像只在重复证据或高显著度事件后生成，并保留合法 Trace 引用', () => {
    const coordinator = new ProfileCoordinator();
    const base = fact('profile-fact', 'A长期信任B');
    const traces: ActorMemoryTrace[] = [1, 2, 3].map((index) => ({
      id: `profile-trace-${index}`, workspaceId: 'w', ownerId: 'owner:actor:a', factId: base.id, sourceObservationIds: [`observation-${index}`],
      knowledgeMode: 'experienced', privacy: 'public', strength: 80, clarity: 80, beliefConfidence: 0.9, emotionalSalience: 20,
      rehearsalCount: 0, traceRevision: 1, createdAt: index, updatedAt: index,
    }));
    const result = coordinator.update('owner:actor:a', traces, [{ ...base, kind: 'relationship', subjectEntityId: 'owner:actor:a', objectEntityId: 'owner:actor:b' }], [], 'w');
    expect(result.claims[0]?.supportingTraceIds).toHaveLength(3);
    expect(result.claims[0]?.supportingTraceIds.every(id => traces.some(trace => trace.id === id))).toBe(true);
    expect(result.relationships[0]?.fromOwnerId).toBe('owner:actor:a');
    expect(result.relationships[0]?.toOwnerId).toBe('owner:actor:b');
  });

  it('画像新增无关声明时不会错误替代已有活跃声明', () => {
    const coordinator = new ProfileCoordinator();
    const ownerId = 'owner:actor:a';
    const oldClaim = {
      id: 'claim-old', ownerId, claim: 'A是守门人', level: 3 as const,
      supportingTraceIds: ['trace-old'], confidence: 0.9, status: 'active' as const,
      createdAt: 1, updatedAt: 1,
    };
    const oldFact = { ...fact('profile-old', oldClaim.claim), kind: 'identity' as const, predicateKey: '身份', canonicalKey: 'profile-old::身份' };
    const oldTrace: ActorMemoryTrace = {
      id: 'trace-old', workspaceId: 'w', ownerId, factId: oldFact.id,
      sourceObservationIds: ['profile-old-observation'], knowledgeMode: 'experienced', privacy: 'public',
      strength: 80, clarity: 80, beliefConfidence: 0.9, emotionalSalience: 0,
      rehearsalCount: 0, traceRevision: 1, createdAt: 1, updatedAt: 1,
    };
    const newFact = { ...fact('profile-new', 'A长期偏好先观察再行动'), kind: 'preference' as const, predicateKey: '行动偏好', canonicalKey: 'profile-new::行动偏好' };
    const newTraces: ActorMemoryTrace[] = [1, 2, 3].map(index => ({
      id: `profile-new-trace-${index}`, workspaceId: 'w', ownerId, factId: newFact.id,
      sourceObservationIds: [`profile-new-observation-${index}`], knowledgeMode: 'experienced', privacy: 'public',
      strength: 80, clarity: 80, beliefConfidence: 0.9, emotionalSalience: 20,
      rehearsalCount: 0, traceRevision: 1, createdAt: index, updatedAt: index,
    }));
    const result = coordinator.update(ownerId, [oldTrace, ...newTraces], [oldFact, newFact], [oldClaim], 'w');
    expect(result.claims.find(item => item.id === oldClaim.id)?.status).toBe('active');
    expect(result.claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ claim: oldClaim.claim, status: 'active' }),
      expect.objectContaining({ claim: newFact.content, status: 'active' }),
    ]));
  });

  it('Dream 默认按主体自动 Apply，文学梦境强制 fictional 且可回滚', async () => {
    const dream = new DreamCoordinator();
    const job = dream.enqueue({ workspaceId: 'w', chatKey: 'chat', ownerId: 'owner:actor:a', traceIds: ['trace-a'], trigger: 'manual' });
    let applied = false;
    const result = await dream.run(job.id, [], () => { applied = true; }, { narrative: true });
    expect(applied).toBe(true);
    expect(result.audit.applied).toBe(true);
    expect(result.narrative?.fictional).toBe(true);
    await dream.rollback(result.audit.id, () => undefined);
    expect(dream.listJobs().find(item => item.id === job.id)?.status).toBe('rolled-back');
  });
});
