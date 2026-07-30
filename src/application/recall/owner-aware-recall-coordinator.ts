import {
  FIXED_OWNER_IDS,
  type ActorMemoryPartition,
  type ActorRecallCandidateAudit,
  type ActorRecallCandidatePartition,
  type ActorMemoryTrace,
  type ActorRecallRequest,
  type ActorRecallResponse,
  type CastRecallPermission,
  type GenerationCastPlan,
  type MemoryFact,
  type MemoryOwner,
  type MemoryRecallPacket,
  type SceneCast,
} from '../../domain';
import type { RecallItem, RecallQuery, RecallResult } from './memory-recall-index';
import { buildMemoryRecallPacket, buildMemoryRecallPacketAtStrength } from './memory-strength';

export interface OwnerAwareRecallDependencies {
  readonly recallObjective: (query: RecallQuery) => Promise<RecallResult> | RecallResult;
  readonly listTraces: (workspaceId: string, chatKey: string) => Promise<readonly ActorMemoryTrace[]> | readonly ActorMemoryTrace[];
  readonly getFact: (factId: string) => Promise<MemoryFact | undefined> | MemoryFact | undefined;
  readonly getOwner?: (ownerId: string) => Promise<MemoryOwner | undefined> | MemoryOwner | undefined;
}

function initialRetrievalLevel(request: ActorRecallRequest): 1 | 2 | 3 | 4 {
  const planned = request.intentPlan
    ? request.intentPlan.complexity === 'direct'
      ? 1
      : 4
    : 4;
  return Math.max(planned, request.minimumRetrievalLevel ?? 1) as 1 | 2 | 3 | 4;
}

function retrievalStages(level: 1 | 2 | 3 | 4): string[] {
  const stages = ['场景缓存与稳定锚点', '关键词与精确实体'];
  if (level >= 2) stages.push('向量语义召回');
  if (level >= 3) stages.push('图谱扩展');
  if (level >= 4) stages.push('重排序');
  return stages;
}

function directResultIsSufficient(result: RecallResult): boolean {
  const top = result.items[0];
  return Boolean(top && top.reason.lexical && top.score >= 0.58);
}

const FOCUSED_KINDS = new Set(['relationship', 'event', 'state', 'goal', 'commitment', 'preference']);
const IDENTITY_KINDS = new Set(['identity', 'location', 'state']);

function unique(values: Iterable<string>): string[] { return [...new Set([...values].filter(Boolean))]; }

function roleOf(ownerId: string, owner?: MemoryOwner): ActorMemoryPartition['role'] {
  if (ownerId === FIXED_OWNER_IDS.world) return 'world';
  if (ownerId === FIXED_OWNER_IDS.narrator) return 'narrator';
  if (ownerId === FIXED_OWNER_IDS.player) return 'player';
  if (ownerId === FIXED_OWNER_IDS.unknown) return 'unknown';
  return owner?.kind === 'actor' ? 'actor' : 'unknown';
}

function defaultOwner(ownerId: string): MemoryOwner {
  const displayName = ownerId === FIXED_OWNER_IDS.world ? '世界' : ownerId === FIXED_OWNER_IDS.narrator ? '旁白' : ownerId === FIXED_OWNER_IDS.player ? '玩家' : '未知主体';
  return { id: ownerId, workspaceId: '', kind: roleOf(ownerId) as MemoryOwner['kind'], displayName, canonicalName: displayName, aliases: [displayName], ...(ownerId === FIXED_OWNER_IDS.narrator ? { narratorMode: 'limited' as const } : {}), status: 'confirmed', discoverySources: ['system'], confidence: 1, createdAt: 0, updatedAt: 0 };
}

function activeOwnerIds(scene: SceneCast, mode: ActorRecallRequest['mode']): string[] {
  if (mode === 'strict_pov') return [scene.viewpointOwnerId];
  return unique([...scene.speakerOwnerIds, ...scene.presentOwnerIds]).filter(ownerId => ownerId !== FIXED_OWNER_IDS.unknown);
}

function deterministicDirectCastPlan(request: ActorRecallRequest): GenerationCastPlan {
  const mode = request.mode ?? 'multi_actor';
  const actors = mode === 'omniscient' ? [] : activeOwnerIds(request.scene, mode);
  const permissionByOwner: Record<string, CastRecallPermission> = {
    [FIXED_OWNER_IDS.world]: 'full',
    [FIXED_OWNER_IDS.narrator]: 'focused',
  };
  actors.forEach(ownerId => { permissionByOwner[ownerId] = 'full'; });
  return {
    id: `cast-plan:direct:${encodeURIComponent(request.chatKey)}:${request.scene.floor}`,
    workspaceId: request.workspaceId,
    chatKey: request.chatKey,
    sceneId: request.sceneEpoch ?? String(request.scene.floor),
    basedOnFloor: request.scene.floor,
    mode: actors.length <= 1 ? 'single_actor' : 'multi_actor',
    viewpointOwnerId: request.scene.viewpointOwnerId,
    requiredOwnerIds: actors,
    likelyOwnerIds: [],
    backgroundOwnerIds: [],
    mentionedOnlyOwnerIds: request.scene.mentionedOwnerIds.filter(ownerId => !actors.includes(ownerId)),
    excludedOwnerIds: [],
    permissionByOwner,
    plannerMode: 'deterministic',
    confidence: 1,
    evidence: [],
    newActorProposals: [],
    createdAt: request.scene.createdAt,
  };
}

function ownerBudget(ownerId: string, request: ActorRecallRequest, plan: GenerationCastPlan, fallbackOwners: ReadonlySet<string> = new Set()): number {
  const requested = Math.max(1, request.maxItems ?? 12);
  let budget = ownerId === FIXED_OWNER_IDS.world
    ? 4
    : ownerId === FIXED_OWNER_IDS.narrator
      ? 2
      : ownerId === plan.viewpointOwnerId
        ? 6
        : plan.requiredOwnerIds.includes(ownerId)
          ? 5
          : plan.likelyOwnerIds.includes(ownerId)
            ? 2
            : 0;
  const permission = plan.permissionByOwner[ownerId];
  if (permission === 'focused') budget = Math.min(budget || 3, 3);
  if (permission === 'identity_only') budget = Math.min(budget || 1, 1);
  if (permission === 'none') budget = 0;
  if (budget === 0 && request.intentPlan?.ownerScope?.ownerIds.includes(ownerId)) budget = 4;
  if (budget === 0 && fallbackOwners.has(ownerId)) budget = 4;
  return Math.min(requested, budget);
}

function traceAllowed(trace: ActorMemoryTrace, fact: MemoryFact | undefined, permission: CastRecallPermission, recallNow: number): boolean {
  if (!fact || permission === 'none') return false;
  if (trace.learnedAt !== undefined && trace.learnedAt > recallNow) return false;
  if (permission === 'public_only' && trace.privacy !== 'public') return false;
  if (permission === 'identity_only' && (trace.privacy !== 'public' || !IDENTITY_KINDS.has(fact.kind))) return false;
  if (permission === 'focused' && !FOCUSED_KINDS.has(fact.kind) && !fact.stableAnchor) return false;
  return true;
}

function queryForOwner(request: ActorRecallRequest, ownerId: string): string {
  const targeted = request.intentPlan?.subQueries.filter(subQuery => subQuery.targetOwnerIds.length === 0 || subQuery.targetOwnerIds.includes(ownerId)) ?? [];
  return targeted.length > 0 ? targeted.map(subQuery => subQuery.query).join('；') : request.query;
}

function normalizeSearch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, '');
}

function factMatchesTopic(fact: MemoryFact | undefined, terms: readonly string[]): boolean {
  if (!fact || terms.length === 0) return false;
  const values = [fact.content, fact.subjectKey, fact.predicateKey, fact.objectKey ?? '', ...fact.entityKeys].map(normalizeSearch);
  return terms.some(term => {
    const normalized = normalizeSearch(term);
    return normalized.length >= 2 && values.some(value => value.length >= 2 && (value.includes(normalized) || normalized.includes(value)));
  });
}

function strictTopicIntent(request: ActorRecallRequest): boolean {
  return request.intentPlan?.complexity === 'direct'
    && ['world_knowledge', 'actor_entity', 'actor_knowledge'].includes(request.intentPlan.intentKind ?? '');
}

function factAnswersDefinition(fact: MemoryFact | undefined, request: ActorRecallRequest): boolean {
  if (!fact || request.intentPlan?.intentKind !== 'world_knowledge'
    || !/(?:是什么|是什麼|何谓|何謂|定义|定義|含义|含義|本质|本質)/u.test(request.query)) return true;
  const text = fact.content.normalize('NFKC').replace(/\s+/gu, '');
  return (request.intentPlan.topicTerms ?? []).some(term => {
    const topic = term.normalize('NFKC').replace(/\s+/gu, '');
    const index = text.indexOf(topic);
    if (topic.length < 2 || index < 0) return false;
    const definitionWindow = text.slice(index + topic.length, index + topic.length + 32);
    return /^(?:[，,:：]?)(?:是|指|属于|屬於|全称为|全稱為|本质是|本質是|由.{0,16}(?:构成|構成|组成|組成))/u.test(definitionWindow);
  });
}

function factMatchesRequestedKinds(fact: MemoryFact | undefined, request: ActorRecallRequest): boolean {
  const requestedKinds = request.intentPlan?.requestedKinds ?? [];
  if (!strictTopicIntent(request)) return true;
  return Boolean(fact && (requestedKinds.length === 0 || requestedKinds.includes(fact.kind)) && factAnswersDefinition(fact, request));
}

function filterObjectiveByTopic(result: RecallResult, request: ActorRecallRequest, factsById: ReadonlyMap<string, MemoryFact>): RecallResult {
  const terms = request.intentPlan?.topicTerms ?? [];
  if (!strictTopicIntent(request) || terms.length === 0) return result;
  const accepted = new Set(result.candidates.filter(candidate => {
    const fact = factsById.get(candidate.factId);
    return factMatchesRequestedKinds(fact, request) && (factMatchesTopic(fact, terms)
      || ((candidate.vectorScore ?? 0) >= 0.58 && (candidate.rerankScore ?? 0) >= 0.72));
  }).map(candidate => candidate.factId));
  const candidates = result.candidates.filter(candidate => accepted.has(candidate.factId));
  const items = result.items.filter(item => accepted.has(item.fact.id));
  return {
    ...result,
    items,
    candidates,
    diagnostics: {
      ...result.diagnostics,
      candidateCount: candidates.length,
      eligibleCount: candidates.length,
      selectedCount: items.length,
    },
  };
}

function fallbackOwnerIds(
  request: ActorRecallRequest,
  traces: readonly ActorMemoryTrace[],
  factsById: ReadonlyMap<string, MemoryFact>,
  recallNow: number,
): string[] {
  if (!request.coverageExpansion || request.intentPlan?.ownerScope?.fallback !== 'public_relevance') return [];
  const primary = new Set(request.intentPlan.ownerScope.ownerIds);
  const scores = new Map<string, number>();
  for (const trace of traces) {
    if (primary.has(trace.ownerId) || isFixedOwner(trace.ownerId) || trace.privacy !== 'public' || trace.learnedAt > recallNow) continue;
    const fact = factsById.get(trace.factId);
    if (!factMatchesRequestedKinds(fact, request) || !factMatchesTopic(fact, request.intentPlan.topicTerms ?? [])) continue;
    scores.set(trace.ownerId, (scores.get(trace.ownerId) ?? 0) + 1);
  }
  return [...scores].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 2).map(([ownerId]) => ownerId);
}

function isFixedOwner(ownerId: string): boolean {
  return Object.values(FIXED_OWNER_IDS).includes(ownerId as never);
}

function permissionForOwner(ownerId: string, request: ActorRecallRequest, plan: GenerationCastPlan, fallbackOwners: ReadonlySet<string>): CastRecallPermission {
  if (ownerId === FIXED_OWNER_IDS.world) return 'full';
  if (ownerId === FIXED_OWNER_IDS.narrator) return request.intentPlan?.ownerScope?.ownerIds.includes(ownerId) ? 'full' : 'focused';
  if (fallbackOwners.has(ownerId) || request.intentPlan?.intentKind === 'actor_entity') return 'public_only';
  if (request.intentPlan?.namedOwnerIds.includes(ownerId)) return 'full';
  const planned = plan.permissionByOwner[ownerId];
  if (planned) return planned;
  if (request.intentPlan?.ownerScope?.ownerIds.includes(ownerId)) return 'full';
  return 'none';
}

function finalPacketLimit(request: ActorRecallRequest): number {
  if (request.intentPlan?.recentContextSatisfied) return 0;
  if (['world_knowledge', 'actor_entity', 'actor_knowledge'].includes(request.intentPlan?.intentKind ?? '')) return Math.min(request.maxItems ?? 12, 4);
  if (['relationship', 'timeline'].includes(request.intentPlan?.intentKind ?? '')) return Math.min(request.maxItems ?? 12, 6);
  return Math.max(1, request.maxItems ?? 12);
}

function ownerPriority(ownerId: string, request: ActorRecallRequest, plan: GenerationCastPlan): number {
  if (request.intentPlan?.namedOwnerIds.includes(ownerId)) return 60;
  if (plan.requiredOwnerIds.includes(ownerId)) return 50;
  if (ownerId === plan.viewpointOwnerId) return 40;
  if (ownerId === FIXED_OWNER_IDS.world) return 30;
  if (ownerId === FIXED_OWNER_IDS.narrator) return 20;
  return plan.likelyOwnerIds.includes(ownerId) ? 10 : 0;
}

/**
 * Retrieves each owner's candidate pool independently. The allow-list reaches
 * the index before TopK, so one actor can never consume another actor's quota.
 */
export class OwnerAwareRecallCoordinator {
  constructor(private readonly dependencies: OwnerAwareRecallDependencies) {}

  async recall(request: ActorRecallRequest): Promise<ActorRecallResponse> {
    const startedAt = Date.now();
    const mode = request.mode ?? 'multi_actor';
    const recallNow = request.now ?? request.scene.createdAt;
    const plan = request.castPlan ?? deterministicDirectCastPlan(request);
    const traces = [...await this.dependencies.listTraces(request.workspaceId, request.chatKey)];
    const factsById = new Map<string, MemoryFact>();
    await Promise.all(unique(traces.map(trace => trace.factId)).map(async (factId) => {
      const fact = await this.dependencies.getFact(factId);
      if (fact) factsById.set(factId, fact);
    }));
    const fallbackOwners = fallbackOwnerIds(request, traces, factsById, recallNow);
    const ownerIds = request.intentPlan?.ownerScope
      ? unique([...request.intentPlan.ownerScope.ownerIds, ...fallbackOwners])
      : mode === 'omniscient'
        ? unique(traces.map(trace => trace.ownerId))
        : unique([
          FIXED_OWNER_IDS.world,
          FIXED_OWNER_IDS.narrator,
          ...plan.requiredOwnerIds,
          ...plan.likelyOwnerIds,
          ...(plan.viewpointOwnerId ? [plan.viewpointOwnerId] : []),
        ]);
    const fallbackOwnerSet = new Set(fallbackOwners);
    const excludedFactIds = new Set(request.excludedFactIds ?? []);
    const ownersById = new Map<string, MemoryOwner>();
    const ownerFor = async (ownerId: string): Promise<MemoryOwner> => {
      const cached = ownersById.get(ownerId);
      if (cached) return cached;
      const owner = await this.dependencies.getOwner?.(ownerId) ?? defaultOwner(ownerId);
      ownersById.set(ownerId, owner);
      return owner;
    };
    const packetsByOwner = new Map<string, MemoryRecallPacket[]>();
    const candidateAuditsByOwner = new Map<string, readonly ActorRecallCandidateAudit[]>();
    const ownerCandidateCounts: Record<string, number> = {};
    const retrievalLevelByOwner: Record<string, 1 | 2 | 3 | 4> = {};
    const retrievalStagesByOwner: Record<string, readonly string[]> = {};
    const eligibleTracesByOwner = new Map<string, ActorMemoryTrace[]>();
    const publicOwnerIdsByFact = new Map<string, string[]>();
    for (const ownerId of ownerIds) {
      if (ownerBudget(ownerId, request, plan, fallbackOwnerSet) <= 0) continue;
      const permission = permissionForOwner(ownerId, request, plan, fallbackOwnerSet);
      const eligible = traces.filter(trace => trace.ownerId === ownerId && traceAllowed(trace, factsById.get(trace.factId), permission, recallNow));
      eligibleTracesByOwner.set(ownerId, eligible);
      for (const trace of eligible) {
        if (trace.privacy !== 'public') continue;
        const owners = publicOwnerIdsByFact.get(trace.factId) ?? [];
        if (!owners.includes(ownerId)) owners.push(ownerId);
        publicOwnerIdsByFact.set(trace.factId, owners);
      }
    }
    const publicCanonicalOwnerByFact = new Map<string, string>();
    const fixedRank = (ownerId: string): number => ownerId === FIXED_OWNER_IDS.world ? 2 : ownerId === FIXED_OWNER_IDS.narrator ? 1 : 0;
    for (const [factId, applicableOwnerIds] of publicOwnerIdsByFact) {
      const potential = (ownerId: string): number => Math.max(0, ...(eligibleTracesByOwner.get(ownerId) ?? [])
        .filter(trace => trace.factId === factId)
        .map(trace => trace.strength * trace.clarity));
      const canonical = [...applicableOwnerIds].sort((left, right) => fixedRank(right) - fixedRank(left)
        || ownerPriority(right, request, plan) - ownerPriority(left, request, plan)
        || potential(right) - potential(left)
        || left.localeCompare(right))[0];
      if (canonical) publicCanonicalOwnerByFact.set(factId, canonical);
    }
    let totalCandidates = 0;
    for (const ownerId of ownerIds) {
      const budget = ownerBudget(ownerId, request, plan, fallbackOwnerSet);
      if (budget <= 0) {
        packetsByOwner.set(ownerId, []);
        candidateAuditsByOwner.set(ownerId, []);
        ownerCandidateCounts[ownerId] = 0;
        continue;
      }
      const ownerTraces = (eligibleTracesByOwner.get(ownerId) ?? []).filter(trace => trace.privacy !== 'public'
        || publicCanonicalOwnerByFact.get(trace.factId) === ownerId);
      const allowedFactIds = unique(ownerTraces.map(trace => trace.factId)).filter(factId => !excludedFactIds.has(factId));
      if (allowedFactIds.length === 0) {
        packetsByOwner.set(ownerId, []);
        candidateAuditsByOwner.set(ownerId, []);
        ownerCandidateCounts[ownerId] = 0;
        continue;
      }
      let retrievalLevel = initialRetrievalLevel(request);
      const recallAtLevel = (level: 1 | 2 | 3 | 4) => this.dependencies.recallObjective({
        chatKey: request.chatKey,
        query: queryForOwner(request, ownerId),
        maxItems: budget,
        candidateLimit: Math.min(120, Math.max(budget * 4, 8)),
        allowedFactIds,
        retrievalLevel: level,
        now: recallNow,
        entityKeys: unique([ownerId, ...request.scene.members.map(member => member.ownerId), ...(request.intentPlan?.entityKeys ?? [])]),
      });
      let objective = filterObjectiveByTopic(await recallAtLevel(retrievalLevel), request, factsById);
      if (retrievalLevel === 1 && !directResultIsSufficient(objective)) {
        retrievalLevel = 2;
        const semantic = await recallAtLevel(retrievalLevel);
        objective = filterObjectiveByTopic(semantic, request, factsById);
        if (strictTopicIntent(request) && objective.items.length === 0 && semantic.candidates.some(candidate => (candidate.vectorScore ?? 0) >= 0.58)) {
          retrievalLevel = 4;
          objective = filterObjectiveByTopic(await recallAtLevel(retrievalLevel), request, factsById);
        }
      }
      retrievalLevelByOwner[ownerId] = retrievalLevel;
      retrievalStagesByOwner[ownerId] = retrievalStages(retrievalLevel);
      ownerCandidateCounts[ownerId] = objective.candidates.length;
      totalCandidates += objective.candidates.length;
      candidateAuditsByOwner.set(ownerId, objective.candidates.map((candidate) => {
        const fact = factsById.get(candidate.factId);
        const factTraces = ownerTraces.filter(trace => trace.factId === candidate.factId);
        return {
          factId: candidate.factId,
          ...(publicOwnerIdsByFact.get(candidate.factId)?.length ? { applicableOwnerIds: [...publicOwnerIdsByFact.get(candidate.factId)!] } : {}),
          ...(fact?.kind ? { factKind: fact.kind } : {}),
          traceIds: unique(factTraces.map(trace => trace.id)),
          sourceFloors: [...new Set(factTraces
            .map(trace => trace.floor)
            .filter((floor): floor is number => floor !== undefined))]
            .sort((left, right) => left - right),
          summary: fact?.content ?? '',
          score: candidate.score,
          selected: candidate.selected,
          reasonCodes: [...candidate.reasonCodes],
          ...(candidate.omittedReason === undefined ? {} : { omittedReason: candidate.omittedReason }),
          ...(candidate.lexicalScore === undefined ? {} : { lexicalScore: candidate.lexicalScore }),
          ...(candidate.vectorScore === undefined ? {} : { vectorScore: candidate.vectorScore }),
          ...(candidate.graphScore === undefined ? {} : { graphScore: candidate.graphScore }),
          ...(candidate.lexicalRank === undefined ? {} : { lexicalRank: candidate.lexicalRank }),
          ...(candidate.vectorRank === undefined ? {} : { vectorRank: candidate.vectorRank }),
          ...(candidate.graphRank === undefined ? {} : { graphRank: candidate.graphRank }),
          ...(candidate.fusionScore === undefined ? {} : { fusionScore: candidate.fusionScore }),
          ...(candidate.rerankScore === undefined ? {} : { rerankScore: candidate.rerankScore }),
        };
      }));
      const itemByFact = new Map<string, RecallItem>(objective.items.map(item => [item.fact.id, item]));
      const owner = await ownerFor(ownerId);
      const packets: MemoryRecallPacket[] = [];
      for (const trace of ownerTraces) {
        const item = itemByFact.get(trace.factId);
        const fact = factsById.get(trace.factId);
        if (!item || !fact) continue;
        const builtPacket = isFixedOwner(ownerId)
          ? buildMemoryRecallPacketAtStrength(trace, fact, 100, request.sceneEpoch ?? plan.sceneId)
          : buildMemoryRecallPacket(trace, fact, recallNow, request.sceneEpoch ?? plan.sceneId, {
            cueMatch: Math.max(0.25, Math.min(1, item.score)),
            traits: owner.memoryTraits,
          });
        const packet = builtPacket && isFixedOwner(ownerId)
          ? { ...builtPacket, effectiveStrength: 100, clarity: 100 }
          : builtPacket;
        if (packet) packets.push(packet);
      }
      packetsByOwner.set(ownerId, packets.sort((left, right) => right.effectiveStrength - left.effectiveStrength || left.factId.localeCompare(right.factId)).slice(0, budget));
    }
    const traceById = new Map(traces.map(trace => [trace.id, trace]));
    const chosenPackets = new Map<string, { dedupeKey: string; ownerId: string; packet: MemoryRecallPacket; score: number; priority: number }>();
    for (const [ownerId, packets] of packetsByOwner) {
      const scoreByFact = new Map((candidateAuditsByOwner.get(ownerId) ?? []).map(candidate => [candidate.factId, candidate.score]));
      for (const packet of packets) {
        const privacy = traceById.get(packet.traceId)?.privacy;
        const key = privacy === 'public' ? `fact:${packet.factId}` : `owner:${ownerId}:fact:${packet.factId}`;
        const candidate = { dedupeKey: key, ownerId, packet, score: scoreByFact.get(packet.factId) ?? 0, priority: ownerPriority(ownerId, request, plan) };
        const existing = chosenPackets.get(key);
        if (!existing || candidate.priority > existing.priority
          || (candidate.priority === existing.priority && candidate.score > existing.score)
          || (candidate.priority === existing.priority && candidate.score === existing.score && candidate.packet.effectiveStrength > existing.packet.effectiveStrength)) {
          chosenPackets.set(key, candidate);
        }
      }
    }
    const rankedPackets = [...chosenPackets.values()]
      .sort((left, right) => right.score - left.score || right.priority - left.priority || right.packet.effectiveStrength - left.packet.effectiveStrength || left.packet.factId.localeCompare(right.packet.factId));
    const protectedOwners = unique([...(request.intentPlan?.namedOwnerIds ?? []), ...plan.requiredOwnerIds]);
    const limit = Math.max(finalPacketLimit(request), protectedOwners.filter(ownerId => rankedPackets.some(candidate => candidate.ownerId === ownerId)).length);
    const finalPackets: typeof rankedPackets = [];
    const selectedKeys = new Set<string>();
    for (const ownerId of protectedOwners) {
      const item = rankedPackets.find(candidate => candidate.ownerId === ownerId && !selectedKeys.has(candidate.dedupeKey));
      if (!item || finalPackets.length >= limit) continue;
      finalPackets.push(item);
      selectedKeys.add(item.dedupeKey);
    }
    for (const item of rankedPackets) {
      if (finalPackets.length >= limit) break;
      if (selectedKeys.has(item.dedupeKey)) continue;
      finalPackets.push(item);
      selectedKeys.add(item.dedupeKey);
    }
    for (const ownerId of packetsByOwner.keys()) packetsByOwner.set(ownerId, []);
    for (const item of finalPackets) {
      packetsByOwner.get(item.ownerId)?.push(item.packet);
    }
    const makePartition = async (ownerId: string): Promise<ActorMemoryPartition> => {
      const owner = await ownerFor(ownerId);
      return { ownerId, ownerName: owner.displayName, role: roleOf(ownerId, owner), packets: packetsByOwner.get(ownerId) ?? [] };
    };
    const world = await makePartition(FIXED_OWNER_IDS.world);
    const narrator = await makePartition(FIXED_OWNER_IDS.narrator);
    const actors: ActorMemoryPartition[] = [];
    for (const ownerId of ownerIds) {
      if (ownerId === FIXED_OWNER_IDS.world || ownerId === FIXED_OWNER_IDS.narrator) continue;
      actors.push(await makePartition(ownerId));
    }
    const candidatePartitions: ActorRecallCandidatePartition[] = [];
    for (const ownerId of ownerIds) {
      const owner = await ownerFor(ownerId);
      candidatePartitions.push({
        ownerId,
        ownerName: owner.displayName,
        role: roleOf(ownerId, owner),
        candidates: candidateAuditsByOwner.get(ownerId) ?? [],
      });
    }
    const selectedCount = finalPackets.length;
    const uniqueCandidateCount = new Set([...candidateAuditsByOwner.values()].flatMap(candidates => candidates.map(candidate => candidate.factId))).size;
    return {
      request: { ...request, castPlan: plan },
      world,
      narrator,
      actors,
      candidatePartitions,
      diagnostics: {
        candidateCount: totalCandidates,
        uniqueCandidateCount,
        duplicateCandidateCount: Math.max(0, totalCandidates - uniqueCandidateCount),
        selectedCount,
        partitions: actors.length + 2,
        mode,
        elapsedMs: Date.now() - startedAt,
        ownerCandidateCounts,
        permissionByOwner: plan.permissionByOwner,
        retrievalLevelByOwner,
        retrievalStagesByOwner,
      },
    };
  }
}
