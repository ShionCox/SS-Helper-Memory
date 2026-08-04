/**
 * Multi-actor memory primitives.
 *
 * A Tavern character card or group is deliberately modelled as a workspace
 * container.  The records below describe the in-world subjects that live in
 * that container and the evidence that explains what each subject knows.
 */
import type { SSHelperFailureContext } from '@ss-helper/sdk';

export const MEMORY_MODEL_VERSION = 0 as const;

export type MemoryOwnerKind = 'actor' | 'world' | 'narrator' | 'player' | 'unknown';
export type ActorResolutionStatus = 'confirmed' | 'pending' | 'unknown' | 'merged';
export type ActorDiscoverySource = 'host_card' | 'worldbook' | 'message' | 'prompt' | 'manual' | 'system';
export type LocationResolutionStatus = 'confirmed' | 'pending' | 'merged';

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

/** Deterministic 128-bit, record-id-safe key for arbitrary Unicode input. */
export function stableMemoryRecordKey(value: string): string {
  const parts: string[] = [];
  for (let variant = 0; variant < 4; variant += 1) {
    let hash = 2166136261;
    for (const char of `${variant}\0${value.normalize('NFKC')}`) {
      hash ^= char.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 16777619);
    }
    parts.push((hash >>> 0).toString(16).padStart(8, '0'));
  }
  return parts.join('');
}

export interface MemoryLocation {
  readonly id: string;
  readonly workspaceId: string;
  readonly displayName: string;
  readonly canonicalName: string;
  readonly aliases: readonly string[];
  readonly status: LocationResolutionStatus;
  readonly confidence: number;
  readonly sourceRefs: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly mergedIntoId?: string;
}

export interface LocationAlias {
  readonly id: string;
  readonly workspaceId: string;
  readonly locationId: string;
  readonly value: string;
  readonly normalizedValue: string;
  readonly sourceRef: string;
  readonly confidence: number;
  readonly status: LocationResolutionStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface LocationCandidate {
  readonly localId: string;
  readonly displayName: string;
  readonly aliases?: readonly string[];
  readonly sourceRef: string;
  readonly evidenceExcerpt: string;
  readonly confidence: number;
  readonly status?: LocationResolutionStatus;
  readonly locationRef?: string;
}

export type InventoryItemCategory = 'weapon' | 'medicine' | 'food' | 'armor' | 'special' | 'core' | 'material' | 'other';
export type InventoryMeasureKind = 'quantity' | 'coverage_days';
export type InventoryPrecision = 'exact' | 'approximate' | 'unknown';
export type InventoryAvailability = 'active' | 'absent' | 'unknown';
export type InventoryOperation = 'set' | 'increase' | 'decrease' | 'remove';
export type InventoryReason = 'acquire' | 'consume' | 'discard' | 'lose' | 'recount' | 'manual_correction' | 'other';

/** Workspace-wide fungible item identity. Per-chat quantities live in InventoryState. */
export interface InventoryItem {
  readonly id: string;
  readonly workspaceId: string;
  readonly canonicalName: string;
  readonly aliases: readonly string[];
  readonly category: InventoryItemCategory;
  readonly status: 'confirmed' | 'pending' | 'invalid';
  readonly confidence: number;
  readonly sourceRefs: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Current materialized measure for one item in one chat branch. */
export interface InventoryState {
  readonly id: string;
  readonly workspaceId: string;
  readonly chatKey: string;
  readonly itemId: string;
  readonly measureKind: InventoryMeasureKind;
  readonly amount?: number;
  readonly unit: string;
  readonly unitKey: string;
  readonly precision: InventoryPrecision;
  readonly availability: InventoryAvailability;
  readonly stateNote?: string;
  readonly lastEventId: string;
  readonly sourceRefs: readonly string[];
  readonly updatedAtFloor?: number;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly validFrom?: number;
  readonly validUntil?: number;
  readonly observedAt?: number;
  readonly ingestedAt?: number;
  readonly supersededAt?: number;
}

/** Append-only inventory ledger row. before/after are server-computed. */
export interface InventoryEvent {
  readonly id: string;
  readonly workspaceId: string;
  readonly chatKey: string;
  readonly itemId: string;
  readonly operation: InventoryOperation;
  readonly measureKind: InventoryMeasureKind;
  readonly amount?: number;
  readonly rawAmount?: string;
  readonly unit: string;
  readonly unitKey: string;
  readonly precision: InventoryPrecision;
  readonly reason: InventoryReason;
  readonly beforeAmount?: number;
  readonly afterAmount?: number;
  readonly availability: InventoryAvailability;
  readonly sourceRef?: string;
  readonly evidenceExcerpt?: string;
  readonly floor?: number;
  readonly occurredAt: number;
  readonly recordedAt: number;
  readonly validFrom?: number;
  readonly validUntil?: number;
  readonly observedAt?: number;
  readonly ingestedAt?: number;
  readonly supersededAt?: number;
  readonly origin: 'automatic' | 'manual' | 'import';
  readonly confidence: number;
  readonly jobId?: string;
  readonly requestId?: string;
  readonly batchIndex?: number;
}

export interface InventoryCommand {
  readonly itemId: string;
  readonly operation: InventoryOperation;
  readonly measureKind: InventoryMeasureKind;
  readonly amount?: number;
  readonly rawAmount?: string;
  readonly unit: string;
  readonly precision: InventoryPrecision;
  readonly reason: InventoryReason;
  readonly stateNote?: string;
  readonly sourceRef?: string;
  readonly evidenceExcerpt?: string;
  readonly floor?: number;
  readonly occurredAt?: number;
  readonly origin: 'automatic' | 'manual' | 'import';
  readonly confidence: number;
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

export type ActorCandidateResolution =
  | { readonly mode: 'existing'; readonly ownerId: string }
  | { readonly mode: 'new'; readonly canonicalName: string };

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
  readonly locationId?: string;
  readonly location?: string;
  /** In-world narrative time such as “灾变第十八日黄昏”. */
  readonly storyTimeText?: string;
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
  /** Exact chat provenance. A trace never floats across chats in the same workspace. */
  readonly chatKey: string;
  readonly ownerId: string;
  readonly factId: string;
  readonly sourceObservationIds: readonly string[];
  readonly knowledgeMode: MemoryKnowledgeMode;
  readonly privacy: MemoryPrivacy;
  readonly strength: number;
  readonly clarity: number;
  readonly beliefConfidence: number;
  /** Emotional salience normalized to the closed interval [0, 1]. */
  readonly emotionalSalience: number;
  readonly rehearsalCount: number;
  readonly traceRevision: number;
  /** Source timeline floor used by profile lookback; metadata-only facts may not map to a chat floor. */
  readonly floor?: number;
  /** Earliest point at which this owner could have learned the fact. */
  readonly learnedAt: number;
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
  /** Direct diagnostic recall may omit a plan; the coordinator derives a deterministic one. */
  readonly castPlan?: import('./generation-cast').GenerationCastPlan;
  readonly intentPlan?: import('./recall-plan').GenerationRecallIntentPlan;
  /** Controlled coverage expansion may raise, but never lower, this level. */
  readonly minimumRetrievalLevel?: 1 | 2 | 3 | 4;
  /** True only for the verifier's single controlled fallback pass. */
  readonly coverageExpansion?: boolean;
  readonly excludedFactIds?: readonly string[];
}

export interface ActorMemoryPartition {
  readonly ownerId: string;
  readonly ownerName: string;
  readonly role: 'world' | 'narrator' | 'actor' | 'player' | 'unknown';
  readonly packets: readonly MemoryRecallPacket[];
}

export interface ActorRecallCandidateAudit {
  readonly factId: string;
  /** Owners whose allowed public traces support this single, de-duplicated retrieval. */
  readonly applicableOwnerIds?: readonly string[];
  readonly factKind?: string;
  readonly traceIds: readonly string[];
  readonly sourceFloors: readonly number[];
  readonly summary: string;
  readonly score: number;
  readonly selected: boolean;
  readonly reasonCodes: readonly string[];
  readonly omittedReason?: string;
  readonly lexicalScore?: number;
  readonly vectorScore?: number;
  readonly graphScore?: number;
  readonly lexicalRank?: number;
  readonly vectorRank?: number;
  readonly graphRank?: number;
  readonly fusionScore?: number;
  readonly rerankScore?: number;
}

export interface ActorRecallCandidatePartition {
  readonly ownerId: string;
  readonly ownerName: string;
  readonly role: ActorMemoryPartition['role'];
  readonly candidates: readonly ActorRecallCandidateAudit[];
}

export interface ActorRecallResponse {
  readonly request: ActorRecallRequest & { readonly castPlan: import('./generation-cast').GenerationCastPlan };
  readonly world: ActorMemoryPartition;
  readonly narrator: ActorMemoryPartition;
  readonly actors: readonly ActorMemoryPartition[];
  /** Complete owner-isolated candidate pool retained for generation audit. */
  readonly candidatePartitions?: readonly ActorRecallCandidatePartition[];
  readonly diagnostics: {
    readonly candidateCount: number;
    readonly uniqueCandidateCount?: number;
    readonly duplicateCandidateCount?: number;
    readonly selectedCount: number;
    readonly partitions: number;
    readonly mode: ActorRecallMode;
    readonly elapsedMs: number;
    readonly ownerCandidateCounts?: Readonly<Record<string, number>>;
    readonly permissionByOwner?: Readonly<Record<string, import('./generation-cast').CastRecallPermission>>;
    readonly retrievalLevelByOwner?: Readonly<Record<string, 1 | 2 | 3 | 4>>;
    readonly retrievalStagesByOwner?: Readonly<Record<string, readonly string[]>>;
    readonly coverage?: import('./recall-plan').RecallCoverageResult;
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
  readonly validFrom?: number;
  readonly validUntil?: number;
  readonly observedAt?: number;
  readonly ingestedAt?: number;
  readonly supersededAt?: number;
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
  readonly failure?: SSHelperFailureContext;
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
  readonly locationCandidates: readonly LocationCandidate[];
  readonly episodes: readonly (MemoryEpisode & { readonly localId?: string })[];
  /** Prompt claims are retained for audit only; server records are derived. */
  readonly claimLocalIds: readonly string[];
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

export function locationEntityId(workspaceId: string, canonicalName: string): string {
  const normalized = normalizeLocationName(canonicalName);
  const parts: string[] = [];
  for (let variant = 0; variant < 4; variant += 1) {
    let hash = 2166136261;
    for (const char of `${workspaceId}\0location\0${normalized}\0${variant}`) {
      hash ^= char.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 16777619);
    }
    parts.push((hash >>> 0).toString(16).padStart(8, '0'));
  }
  const hex = parts.join('');
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((Number.parseInt(hex.slice(16, 20), 16) & 0x3fff) | 0x8000).toString(16).padStart(4, '0')}-${hex.slice(20, 32)}`;
  return `location:${uuid}`;
}

const TRADITIONAL_NAME_MAP: Readonly<Record<string, string>> = Object.freeze({
  時: '时', 葉: '叶', 體: '体', 門: '门', 車: '车', 廳: '厅', 樓: '楼', 區: '区',
  裡: '里', 裏: '里', 間: '间', 廠: '厂', 庫: '库', 館: '馆',
});

function normalizeCommonChineseVariants(value: string): string {
  return [...value].map(character => TRADITIONAL_NAME_MAP[character] ?? character).join('');
}

const TRANSIENT_ACTOR_STATE_SUFFIX = /[（(]\s*(?:在家|离家|外出|在场|不在场|暂离|离队|归队|休眠|沉睡|睡眠|待机|离线|在线|失联|恢复中|已恢复|恢复|受伤|重伤|昏迷|存活|死亡|已死亡|警戒中|战斗中|执行任务中|处理中|观察中)\s*[）)]\s*$/u;

/**
 * 去掉宿主状态栏附在姓名后的临时状态，但保留“重构体”等稳定身份限定。
 * 例如：角色甲（休眠）→ 角色甲；角色乙（稳定身份限定）保持不变。
 */
export function canonicalActorDisplayName(value: string): string {
  const original = value.trim();
  let canonical = original;
  while (TRANSIENT_ACTOR_STATE_SUFFIX.test(canonical)) {
    canonical = canonical.replace(TRANSIENT_ACTOR_STATE_SUFFIX, '').trim();
  }
  return canonical || original;
}

export function normalizeActorName(value: string): string {
  return normalizeCommonChineseVariants(canonicalActorDisplayName(value).normalize('NFKC'))
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/[“”‘’「」『』【】()[\]{}<>]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase();
}

export function normalizeLocationName(value: string): string {
  return normalizeCommonChineseVariants(value.normalize('NFKC'))
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/[“”‘’「」『』【】()[\]{}<>]/gu, ' ')
    .replace(/[·•]/gu, '·')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase();
}
