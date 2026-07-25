import {
  FIXED_OWNER_IDS,
  type ActorMemoryPartition,
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
import { buildMemoryRecallPacket } from './memory-strength';

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

function legacyCastPlan(request: ActorRecallRequest): GenerationCastPlan {
  const mode = request.mode ?? 'multi_actor';
  const actors = mode === 'omniscient' ? [] : activeOwnerIds(request.scene, mode);
  const permissionByOwner: Record<string, CastRecallPermission> = {
    [FIXED_OWNER_IDS.world]: 'full',
    [FIXED_OWNER_IDS.narrator]: 'focused',
  };
  actors.forEach(ownerId => { permissionByOwner[ownerId] = 'full'; });
  return {
    id: `cast-plan:legacy:${encodeURIComponent(request.chatKey)}:${request.scene.floor}`,
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

function ownerBudget(ownerId: string, request: ActorRecallRequest, plan: GenerationCastPlan): number {
  const requested = Math.max(1, request.maxItems ?? 12);
  if (!request.castPlan) return requested;
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
            : plan.backgroundOwnerIds.includes(ownerId)
              ? 1
              : 0;
  const permission = plan.permissionByOwner[ownerId];
  if (permission === 'focused') budget = Math.min(budget || 3, 3);
  if (permission === 'identity_only') budget = Math.min(budget || 1, 1);
  if (permission === 'none') budget = 0;
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
    const plan = request.castPlan ?? legacyCastPlan(request);
    const traces = [...await this.dependencies.listTraces(request.workspaceId, request.chatKey)];
    const ownerIds = mode === 'omniscient'
      ? unique(traces.map(trace => trace.ownerId))
      : unique([
        FIXED_OWNER_IDS.world,
        FIXED_OWNER_IDS.narrator,
        ...plan.requiredOwnerIds,
        ...plan.likelyOwnerIds,
        ...plan.backgroundOwnerIds,
        ...(plan.viewpointOwnerId ? [plan.viewpointOwnerId] : []),
      ]);
    const factsById = new Map<string, MemoryFact>();
    await Promise.all(unique(traces.map(trace => trace.factId)).map(async (factId) => {
      const fact = await this.dependencies.getFact(factId);
      if (fact) factsById.set(factId, fact);
    }));
    const ownersById = new Map<string, MemoryOwner>();
    const ownerFor = async (ownerId: string): Promise<MemoryOwner> => {
      const cached = ownersById.get(ownerId);
      if (cached) return cached;
      const owner = await this.dependencies.getOwner?.(ownerId) ?? defaultOwner(ownerId);
      ownersById.set(ownerId, owner);
      return owner;
    };
    const packetsByOwner = new Map<string, MemoryRecallPacket[]>();
    const ownerCandidateCounts: Record<string, number> = {};
    const retrievalLevelByOwner: Record<string, 1 | 2 | 3 | 4> = {};
    const retrievalStagesByOwner: Record<string, readonly string[]> = {};
    let totalCandidates = 0;
    for (const ownerId of ownerIds) {
      const budget = ownerBudget(ownerId, request, plan);
      if (budget <= 0) { packetsByOwner.set(ownerId, []); ownerCandidateCounts[ownerId] = 0; continue; }
      const permission = plan.permissionByOwner[ownerId] ?? (ownerId === FIXED_OWNER_IDS.world ? 'full' : ownerId === FIXED_OWNER_IDS.narrator ? 'focused' : 'none');
      const ownerTraces = traces.filter(trace => trace.ownerId === ownerId && traceAllowed(trace, factsById.get(trace.factId), permission, recallNow));
      const allowedFactIds = unique(ownerTraces.map(trace => trace.factId));
      if (allowedFactIds.length === 0) { packetsByOwner.set(ownerId, []); ownerCandidateCounts[ownerId] = 0; continue; }
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
      let objective = await recallAtLevel(retrievalLevel);
      if (retrievalLevel === 1 && !directResultIsSufficient(objective)) {
        retrievalLevel = 2;
        objective = await recallAtLevel(retrievalLevel);
      }
      retrievalLevelByOwner[ownerId] = retrievalLevel;
      retrievalStagesByOwner[ownerId] = retrievalStages(retrievalLevel);
      ownerCandidateCounts[ownerId] = objective.candidates.length;
      totalCandidates += objective.candidates.length;
      const itemByFact = new Map<string, RecallItem>(objective.items.map(item => [item.fact.id, item]));
      const owner = await ownerFor(ownerId);
      const packets: MemoryRecallPacket[] = [];
      for (const trace of ownerTraces) {
        const item = itemByFact.get(trace.factId);
        const fact = factsById.get(trace.factId);
        if (!item || !fact) continue;
        const packet = buildMemoryRecallPacket(trace, fact, recallNow, request.sceneEpoch ?? plan.sceneId, {
          cueMatch: Math.max(0.25, Math.min(1, item.score)),
          traits: owner.memoryTraits,
        });
        if (packet) packets.push(packet);
      }
      packetsByOwner.set(ownerId, packets.sort((left, right) => right.effectiveStrength - left.effectiveStrength || left.factId.localeCompare(right.factId)).slice(0, budget));
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
    const selectedCount = [...packetsByOwner.values()].reduce((sum, packets) => sum + packets.length, 0);
    return {
      request: { ...request, castPlan: plan },
      world,
      narrator,
      actors,
      diagnostics: {
        candidateCount: totalCandidates,
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
