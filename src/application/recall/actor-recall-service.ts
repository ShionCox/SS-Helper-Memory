import { FIXED_OWNER_IDS, type ActorMemoryPartition, type ActorMemoryTrace, type ActorRecallRequest, type ActorRecallResponse, type MemoryFact, type MemoryOwner, type MemoryRecallPacket, type SceneCast } from '../../domain';
import type { RecallItem, RecallQuery, RecallResult } from './memory-recall-index';
import { buildMemoryRecallPacket } from './memory-strength';

export interface ActorRecallDependencies {
  readonly recallObjective: (query: RecallQuery) => Promise<RecallResult> | RecallResult;
  readonly listTraces: (workspaceId: string, chatKey: string) => Promise<readonly ActorMemoryTrace[]> | readonly ActorMemoryTrace[];
  readonly getFact: (factId: string) => Promise<MemoryFact | undefined> | MemoryFact | undefined;
  readonly getOwner?: (ownerId: string) => Promise<MemoryOwner | undefined> | MemoryOwner | undefined;
}

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
  const present = scene.presentOwnerIds.filter(ownerId => ownerId !== FIXED_OWNER_IDS.unknown);
  const speakers = scene.speakerOwnerIds;
  return [...new Set([...speakers, ...present])];
}

/** Objective recall is shared; ownership and privacy are applied afterwards. */
export class ActorRecallService {
  constructor(private readonly dependencies: ActorRecallDependencies) {}

  async recall(request: ActorRecallRequest): Promise<ActorRecallResponse> {
    const startedAt = Date.now();
    const mode = request.mode ?? 'multi_actor';
    // A scene supplies the stable clock for a recall when the caller does not
    // explicitly pin `now`. This keeps repeated recalls in one scene bit-for-
    // bit stable instead of letting millisecond jitter alter S_eff.
    const recallNow = request.now ?? request.scene.createdAt;
    const sceneOwnerIds = mode === 'omniscient'
      ? []
      : [...new Set([FIXED_OWNER_IDS.world, FIXED_OWNER_IDS.narrator, ...activeOwnerIds(request.scene, mode)])];
    const perOwnerBudget = Math.max(1, request.maxItems ?? 12);
    const candidateLimit = mode === 'omniscient'
      ? 120
      : Math.min(120, Math.max(perOwnerBudget, perOwnerBudget * Math.max(1, sceneOwnerIds.length)));
    const objective = await this.dependencies.recallObjective({
      chatKey: request.chatKey,
      query: request.query,
      maxItems: request.maxItems,
      candidateLimit,
      now: recallNow,
      entityKeys: request.scene.members.map(member => member.ownerId),
    });
    const traces = [...await this.dependencies.listTraces(request.workspaceId, request.chatKey)];
    const resolvedSceneOwnerIds = mode === 'omniscient'
      ? [...new Set(traces.map(trace => trace.ownerId))]
      : sceneOwnerIds;
    const partitions = new Map<string, MemoryRecallPacket[]>();
    const itemsByFact = new Map<string, RecallItem>();
    for (const item of objective.items) itemsByFact.set(item.fact.id, item);
    const factsById = new Map<string, MemoryFact>();
    const ownersById = new Map<string, MemoryOwner>();
    const ownerFor = async (ownerId: string): Promise<MemoryOwner> => {
      const cached = ownersById.get(ownerId);
      if (cached) return cached;
      const owner = await this.dependencies.getOwner?.(ownerId) ?? defaultOwner(ownerId);
      ownersById.set(ownerId, owner);
      return owner;
    };
    await Promise.all([...itemsByFact.keys()].map(async (factId) => {
      const fact = await this.dependencies.getFact(factId);
      if (fact) factsById.set(factId, fact);
    }));
    for (const trace of traces) {
      if (!resolvedSceneOwnerIds.includes(trace.ownerId)) continue;
      if (trace.privacy === 'private' || trace.privacy === 'secret') {
        // A private trace is visible only to its owner. The partition owner is
        // always the trace owner here, so it never crosses to another actor.
      }
      const item = itemsByFact.get(trace.factId);
      if (!item) continue;
      const fact = factsById.get(trace.factId);
      if (!fact) continue;
      const owner = await ownerFor(trace.ownerId);
      const packet = buildMemoryRecallPacket(trace, fact, recallNow, request.sceneEpoch ?? String(request.scene.floor), {
        cueMatch: Math.max(0.25, Math.min(1, item.score)),
        traits: owner.memoryTraits,
      });
      if (!packet) continue;
      const list = partitions.get(trace.ownerId) ?? [];
      list.push(packet);
      partitions.set(trace.ownerId, list);
    }
    const makePartition = async (ownerId: string): Promise<ActorMemoryPartition> => {
      const owner = await ownerFor(ownerId);
      const packets = [...(partitions.get(ownerId) ?? [])].sort((left, right) => right.effectiveStrength - left.effectiveStrength || left.factId.localeCompare(right.factId)).slice(0, request.maxItems ?? 12);
      return { ownerId, ownerName: owner.displayName, role: roleOf(ownerId, owner), packets };
    };
    const world = await makePartition(FIXED_OWNER_IDS.world);
    const narrator = await makePartition(FIXED_OWNER_IDS.narrator);
    const actors: ActorMemoryPartition[] = [];
    for (const ownerId of resolvedSceneOwnerIds) {
      if (([FIXED_OWNER_IDS.world, FIXED_OWNER_IDS.narrator] as string[]).includes(ownerId)) continue;
      actors.push(await makePartition(ownerId));
    }
    return {
      request,
      world,
      narrator,
      actors,
      diagnostics: { candidateCount: objective.candidates.length, selectedCount: [...partitions.values()].reduce((sum, items) => sum + items.length, 0), partitions: actors.length + 2, mode, elapsedMs: Date.now() - startedAt },
    };
  }
}
