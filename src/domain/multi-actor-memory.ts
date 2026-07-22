/**
 * Multi-actor memory primitives.
 *
 * A Tavern character card or group is deliberately modelled as a workspace
 * container.  The records below describe the in-world subjects that live in
 * that container and the evidence that explains what each subject knows.
 */

export const MEMORY_MODEL_VERSION = 0 as const;

export type MemoryOwnerKind = 'actor' | 'world' | 'narrator' | 'player' | 'unknown';
export type ActorResolutionStatus = 'confirmed' | 'pending' | 'unknown' | 'merged';
export type ActorDiscoverySource = 'host_card' | 'worldbook' | 'message' | 'prompt' | 'manual' | 'system';

/** Per-owner memory characteristics used by deterministic recall strength. */
export interface MemoryTraits {
  /** Exponential half-life for this owner's memories. */
  readonly halfLifeMs?: number;
  /** Rehearsal gain applied after a successful recall. */
  readonly rehearsalGain?: number;
  /** Emotional-salience gain applied during recall. */
  readonly emotionalGain?: number;
  /** Fixed interference penalty. */
  readonly interference?: number;
}

export const DEFAULT_MEMORY_TRAITS: Readonly<Required<MemoryTraits>> = Object.freeze({
  halfLifeMs: 1000 * 60 * 60 * 24 * 30,
  rehearsalGain: 0.04,
  emotionalGain: 0.15,
  interference: 0,
});

export interface MemoryOwner {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: MemoryOwnerKind;
  readonly displayName: string;
  readonly canonicalName?: string;
  readonly aliases: readonly string[];
  /** Optional per-owner memory characteristics; omitted rows use defaults. */
  readonly memoryTraits?: MemoryTraits;
  /** Narrator is limited by default; only an explicit mode may elevate it. */
  readonly narratorMode?: 'omniscient' | 'limited' | 'unreliable';
  readonly status: ActorResolutionStatus;
  readonly discoverySources: readonly ActorDiscoverySource[];
  readonly confidence: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly mergedIntoId?: string;
}

export interface ActorAlias {
  readonly id: string;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly value: string;
  readonly normalizedValue: string;
  readonly sourceRef: string;
  readonly confidence: number;
  readonly status: ActorResolutionStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ActorCandidate {
  readonly localId: string;
  readonly displayName: string;
  readonly aliases?: readonly string[];
  readonly sourceRefs: readonly string[];
  readonly evidenceExcerpts: readonly string[];
  readonly confidence: number;
  readonly status?: ActorResolutionStatus;
  readonly ownerRef?: string;
}

export type MemoryObservationChannel = 'public_speech' | 'private_thought' | 'narration' | 'worldbook' | 'state' | 'rumor' | 'inference';
export type MemoryPrivacy = 'public' | 'limited' | 'private' | 'secret';
export type MemoryKnowledgeMode = 'asserted' | 'self_reported' | 'heard' | 'experienced' | 'inferred' | 'believed' | 'suspected' | 'unknown';

export interface MemoryEpisode {
  readonly id: string;
  readonly workspaceId: string;
  readonly chatKey: string;
  readonly floorStart?: number;
  readonly floorEnd?: number;
  readonly sourceRefs: readonly string[];
  readonly participantIds: readonly string[];
  readonly presentOwnerIds: readonly string[];
  readonly mentionedOwnerIds: readonly string[];
  readonly location?: string;
  readonly occurredAt: number;
  readonly validFrom?: number;
  readonly validUntil?: number;
  readonly summary?: string;
  readonly causalParentIds?: readonly string[];
  readonly createdAt: number;
}

export interface MemoryObservation {
  readonly id: string;
  readonly workspaceId: string;
  readonly episodeId: string;
  readonly sourceRef: string;
  readonly speakerOwnerId: string;
  readonly viewpointOwnerId: string;
  readonly observerOwnerIds: readonly string[];
  readonly channel: MemoryObservationChannel;
  readonly privacy: MemoryPrivacy;
  readonly knowledgeMode: MemoryKnowledgeMode;
  readonly excerpt: string;
  readonly mentionedOwnerIds: readonly string[];
  readonly presentOwnerIds: readonly string[];
  readonly factLocalIds: readonly string[];
  readonly occurredAt: number;
  readonly createdAt: number;
}

export interface ActorMemoryTrace {
  readonly id: string;
  readonly workspaceId: string;
  /** Chat provenance is persisted by the repository; traces may be shared by a workspace. */
  readonly chatKey?: string;
  readonly ownerId: string;
  readonly factId: string;
  readonly sourceObservationIds: readonly string[];
  readonly knowledgeMode: MemoryKnowledgeMode;
  readonly privacy: MemoryPrivacy;
  readonly strength: number;
  readonly clarity: number;
  readonly beliefConfidence: number;
  readonly emotionalSalience: number;
  readonly rehearsalCount: number;
  readonly traceRevision: number;
  /** Source timeline floor used by profile lookback; optional for older v0 rows. */
  readonly floor?: number;
  readonly lastRehearsedAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface MemoryDetailUnit {
  readonly id: string;
  readonly traceId: string;
  readonly text: string;
  readonly sensitivity: 'gist' | 'detail' | 'exact';
  readonly minStrength: number;
  readonly sourceFactId: string;
}

export interface MemoryRecallPacket {
  readonly traceId: string;
  readonly factId: string;
  readonly ownerId: string;
  readonly gist: string;
  readonly details: readonly MemoryDetailUnit[];
  readonly effectiveStrength: number;
  readonly clarity: number;
  readonly deterministicSeed: string;
  readonly omittedDetailCount: number;
}

export type ActorRecallMode = 'strict_pov' | 'multi_actor' | 'omniscient';

export interface SceneCastMember {
  readonly ownerId: string;
  readonly role: 'speaker' | 'viewpoint' | 'present' | 'mentioned' | 'narrator' | 'world';
  readonly confidence: number;
  readonly sourceRefs: readonly string[];
}

export interface SceneCast {
  readonly id: string;
  readonly workspaceId: string;
  readonly chatKey: string;
  readonly floor: number;
  readonly members: readonly SceneCastMember[];
  readonly viewpointOwnerId: string;
  readonly speakerOwnerIds: readonly string[];
  readonly presentOwnerIds: readonly string[];
  readonly mentionedOwnerIds: readonly string[];
  readonly createdAt: number;
}

export interface ActorRecallRequest {
  readonly workspaceId: string;
  readonly chatKey: string;
  readonly query: string;
  readonly scene: SceneCast;
  readonly mode?: ActorRecallMode;
  readonly maxItems?: number;
  readonly now?: number;
  readonly sceneEpoch?: string;
}

export interface ActorMemoryPartition {
  readonly ownerId: string;
  readonly ownerName: string;
  readonly role: 'world' | 'narrator' | 'actor' | 'player' | 'unknown';
  readonly packets: readonly MemoryRecallPacket[];
}

export interface ActorRecallResponse {
  readonly request: ActorRecallRequest;
  readonly world: ActorMemoryPartition;
  readonly narrator: ActorMemoryPartition;
  readonly actors: readonly ActorMemoryPartition[];
  readonly diagnostics: {
    readonly candidateCount: number;
    readonly selectedCount: number;
    readonly partitions: number;
    readonly mode: ActorRecallMode;
    readonly elapsedMs: number;
  };
}

export interface ProfileClaim {
  readonly id: string;
  readonly ownerId: string;
  readonly claim: string;
  readonly level: 0 | 1 | 2 | 3 | 4 | 5;
  readonly supportingTraceIds: readonly string[];
  readonly confidence: number;
  readonly status: 'active' | 'superseded' | 'invalid';
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface RelationshipClaim {
  readonly id: string;
  readonly workspaceId: string;
  readonly fromOwnerId: string;
  readonly toOwnerId: string;
  readonly claim: string;
  readonly supportingTraceIds: readonly string[];
  readonly confidence: number;
  readonly status: 'active' | 'superseded' | 'invalid';
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface DreamJob {
  readonly id: string;
  readonly workspaceId: string;
  readonly chatKey: string;
  readonly ownerId: string;
  readonly status: 'queued' | 'running' | 'dry-run' | 'applied' | 'failed' | 'rolled-back';
  readonly phase: 'gather' | 'sws' | 'rem' | 'consolidation' | 'compaction' | 'apply';
  readonly trigger: 'trace-count' | 'floor-count' | 'salience' | 'manual';
  readonly traceIds: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly appliedAt?: number;
  readonly error?: string;
}

export interface DreamNarrative {
  readonly id: string;
  readonly workspaceId?: string;
  readonly dreamJobId: string;
  readonly ownerId: string;
  readonly fictional: true;
  readonly content: string;
  readonly createdAt: number;
}

export interface RecallExposure {
  readonly id: string;
  readonly workspaceId: string;
  readonly chatKey: string;
  readonly ownerId: string;
  readonly traceId: string;
  readonly sceneEpoch: string;
  readonly included: boolean;
  readonly used: boolean;
  readonly confidence: number;
  readonly createdAt: number;
}

export interface CaptureEnvelope {
  readonly workspaceId: string;
  readonly chatKey: string;
  readonly sourceRefs: readonly string[];
  readonly actorCandidates: readonly ActorCandidate[];
  readonly episodes: readonly (MemoryEpisode & { readonly localId?: string })[];
  readonly observations: readonly (MemoryObservation & { readonly localId?: string; readonly episodeLocalId?: string })[];
  readonly facts: readonly (Omit<import('./memory-types').AutomaticFactProposal, 'evidence'> & {
    readonly localId?: string;
    readonly ownerRefs?: readonly string[];
    readonly observationLocalIds?: readonly string[];
    readonly privacy?: MemoryPrivacy;
    readonly knowledgeMode?: MemoryKnowledgeMode;
    readonly scope?: import('./memory-types').FactScope;
    readonly validFrom?: number;
    readonly validUntil?: number;
    readonly stableAnchor?: boolean;
    readonly evidence: readonly import('./memory-types').FactEvidenceInput[];
  })[];
  readonly capturedAt: number;
}

export const FIXED_OWNER_IDS = Object.freeze({
  world: 'owner:world',
  narrator: 'owner:narrator',
  player: 'owner:player',
  unknown: 'owner:unknown',
} as const);

export function isFixedOwnerId(value: string): boolean {
  return Object.values(FIXED_OWNER_IDS).includes(value as never);
}

export function actorOwnerId(workspaceId: string, canonicalName: string): string {
  const normalized = canonicalName.normalize('NFKC').trim().toLocaleLowerCase();
  const parts: string[] = [];
  for (let variant = 0; variant < 4; variant += 1) {
    let hash = 2166136261;
    for (const char of `${workspaceId}\0${normalized}\0${variant}`) {
      hash ^= char.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 16777619);
    }
    parts.push((hash >>> 0).toString(16).padStart(8, '0'));
  }
  const hex = parts.join('');
  // Stable UUID-shaped identity: names are aliases, while the owner id is
  // immutable and remains independent from the host card/group identifier.
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((Number.parseInt(hex.slice(16, 20), 16) & 0x3fff) | 0x8000).toString(16).padStart(4, '0')}-${hex.slice(20, 32)}`;
  return `owner:actor:${uuid}`;
}

export function normalizeActorName(value: string): string {
  return value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/gu, '').replace(/[“”‘’「」『』【】()[\]{}<>]/gu, ' ').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
}
