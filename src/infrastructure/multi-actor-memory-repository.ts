import type { PlainData, WorkspacePort, WorkspaceRecord, WorkspaceTransactionOperation } from '@ss-helper/sdk';
import {
  ACTIVE_CONFIDENCE_THRESHOLD,
  MAX_FACT_CONTENT_LENGTH,
  createCanonicalKey,
  createFactSlotKey,
  isAppendOnlyFactKind,
  normalizeFactContent,
  type ActorAlias,
  type ActorCandidate,
  type ActorMemoryTrace,
  type AutomaticIngestRejection,
  type CaptureEnvelope,
  type LocationAlias,
  type LocationCandidate,
  type MemoryLocation,
  type FactListOptions,
  type ManualFactInput,
  type MemoryEpisode,
  type MemoryFact,
  type MemoryEvidence,
  type MemoryObservation,
  type MemoryOwner,
  type SceneCast,
  type SceneState,
  type SceneTransition,
  type GenerationCastPlan,
  type CastPlanAudit,
  type RecallCoverageLog,
  type MemoryUsageLog,
  sceneStateRecordId,
} from '../domain';

const CORE_COLLECTIONS = Object.freeze({
  actors: ['workspaceId', 'kind', 'canonicalName', 'status', 'updatedAt'],
  'actor-aliases': ['workspaceId', 'ownerId', 'normalizedValue', 'status', 'updatedAt'],
  'actor-candidates': ['workspaceId', 'chatKey', 'status', 'confidence', 'updatedAt'],
  locations: ['workspaceId', 'canonicalName', 'status', 'updatedAt'],
  'location-aliases': ['workspaceId', 'locationId', 'normalizedValue', 'status', 'updatedAt'],
  'location-candidates': ['workspaceId', 'chatKey', 'status', 'confidence', 'updatedAt'],
  episodes: ['workspaceId', 'chatKey', 'floorStart', 'occurredAt', 'createdAt'],
  observations: ['workspaceId', 'episodeId', 'sourceRef', 'speakerOwnerId', 'occurredAt'],
  facts: ['workspaceId', 'chatKey', 'status', 'kind', 'updatedAt'],
  evidence: ['workspaceId', 'chatKey', 'factId', 'occurredAt'],
  'fact-heads': ['workspaceId', 'chatKey', 'slotKey', 'factId'],
  'memory-traces': ['workspaceId', 'chatKey', 'ownerId', 'factId', 'updatedAt'],
  'scene-casts': ['workspaceId', 'chatKey', 'floor', 'createdAt'],
  'capture-jobs': ['workspaceId', 'chatKey', 'status', 'updatedAt'],
  'change-audits': ['workspaceId', 'chatKey', 'createdAt'],
  'memory-details': ['workspaceId', 'chatKey', 'ownerId', 'traceId'],
  'memory-links': ['workspaceId', 'chatKey', 'ownerId', 'updatedAt'],
  'vector-index': ['workspaceId', 'chatKey', 'recordId', 'updatedAt'],
  'graph-nodes': ['workspaceId', 'chatKey', 'entityKey', 'updatedAt'],
  'graph-edges': ['workspaceId', 'chatKey', 'fromNodeId', 'toNodeId', 'backingFactId', 'updatedAt'],
  profiles: ['workspaceId', 'ownerId', 'updatedAt'],
  'profile-claims': ['workspaceId', 'ownerId', 'level', 'updatedAt'],
  'relationship-claims': ['workspaceId', 'fromOwnerId', 'toOwnerId', 'updatedAt'],
  'recall-exposures': ['workspaceId', 'chatKey', 'ownerId', 'createdAt'],
  'dream-jobs': ['workspaceId', 'chatKey', 'ownerId', 'status', 'updatedAt'],
  'dream-audits': ['workspaceId', 'chatKey', 'ownerId', 'createdAt'],
  'dream-narratives': ['workspaceId', 'chatKey', 'ownerId', 'createdAt'],
} as const);

const CAST_COLLECTIONS = Object.freeze({
  'scene-states': ['workspaceId', 'chatKey', 'sceneId', 'updatedAtFloor', 'revision'],
  'scene-transitions': ['workspaceId', 'chatKey', 'sceneId', 'floor', 'reason'],
  'generation-cast-plans': ['workspaceId', 'chatKey', 'sceneId', 'basedOnFloor', 'plannerMode', 'confidence'],
  'cast-plan-audits': ['workspaceId', 'chatKey', 'planId', 'result', 'createdAt'],
  'recall-coverage-logs': ['workspaceId', 'chatKey', 'planId', 'covered', 'createdAt'],
  'memory-usage-logs': ['workspaceId', 'chatKey', 'ownerId', 'traceId', 'usage', 'createdAt'],
} as const);

const COLLECTIONS = Object.freeze({ ...CORE_COLLECTIONS, ...CAST_COLLECTIONS });

function stableRecordHash(value: string): string {
  const normalized = value.normalize('NFKC');
  const words: string[] = [];
  for (let variant = 0; variant < 4; variant += 1) {
    let result = 2166136261;
    for (const character of `${variant}\0${normalized}`) {
      result ^= character.codePointAt(0) ?? 0;
      result = Math.imul(result, 16777619);
    }
    words.push((result >>> 0).toString(16).padStart(8, '0'));
  }
  return words.join('');
}

function captureBatchOrdinal(audit: ChangeAudit): number | undefined {
  const metadata = audit.metadata && typeof audit.metadata === 'object' && !Array.isArray(audit.metadata)
    ? audit.metadata as Record<string, unknown>
    : {};
  const transactionKey = String(metadata.baseTransactionKey ?? metadata.transactionKey ?? '');
  const match = transactionKey.match(/:batch:(\d+)(?:$|:)/u);
  const value = Number(match?.[1]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function actorCandidateRecordId(candidate: Pick<ActorCandidate, 'localId' | 'ownerRef' | 'displayName'>): string {
  return `actor-candidate:${stableRecordHash(candidate.ownerRef ?? `${candidate.displayName}\0${candidate.localId}`)}`;
}

function locationCandidateRecordId(candidate: Pick<LocationCandidate, 'localId' | 'locationRef' | 'displayName' | 'sourceRef'>): string {
  // Keep distinct evidence-bearing proposals for the same unresolved location,
  // but make retries of the same proposal idempotent. LocationCandidate has a
  // single source/excerpt rather than ActorCandidate's arrays, so collapsing by
  // locationRef alone would both lose evidence and emit duplicate operations.
  return `location-candidate:${stableRecordHash(`${candidate.locationRef ?? candidate.displayName}\0${candidate.localId}\0${candidate.sourceRef}`)}`;
}

type Persistable = MemoryOwner | ActorAlias | MemoryLocation | LocationAlias | MemoryEpisode | MemoryObservation | MemoryFact | ActorMemoryTrace | SceneCast | SceneState | SceneTransition | GenerationCastPlan | CastPlanAudit | RecallCoverageLog | MemoryUsageLog | Record<string, unknown>;
interface CaptureCommit {
  readonly envelope: CaptureEnvelope;
  /** Existing v0 progress record to fold into the Capture ChangeSet. */
  readonly captureJobId?: string;
  readonly idempotencyKey?: string;
  /** Original Capture audit when this commit is a targeted repair child. */
  readonly parentChangeSetId?: string;
  readonly outcome?: 'complete' | 'partial';
  readonly rejections?: readonly AutomaticIngestRejection[];
  readonly owners: readonly MemoryOwner[];
  readonly aliases: readonly ActorAlias[];
  readonly pendingCandidates?: readonly ActorCandidate[];
  readonly locations: readonly MemoryLocation[];
  readonly locationAliases: readonly LocationAlias[];
  readonly pendingLocationCandidates?: readonly LocationCandidate[];
  readonly episodes: readonly MemoryEpisode[];
  readonly observations: readonly MemoryObservation[];
  readonly facts: readonly MemoryFact[];
  readonly evidence: readonly Record<string, unknown>[];
  readonly traces: readonly ActorMemoryTrace[];
  readonly sceneCasts?: readonly SceneCast[];
}

function staleGenerationScopeError(): Error & { code: string } {
  return Object.assign(new Error('生成前记忆准备所属聊天已变化，已丢弃旧结果。'), {
    code: 'MEMORY_STALE_GENERATION_SCOPE',
  });
}

function sceneStateFromRecord(value: unknown, workspaceId: string, chatKey: string): SceneState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Partial<SceneState>;
  if (row.workspaceId !== workspaceId || row.chatKey !== chatKey || typeof row.id !== 'string' || typeof row.sceneId !== 'string') return undefined;
  const arrays: Array<keyof Pick<SceneState, 'locationKeys' | 'presentOwnerIds' | 'nearbyOwnerIds' | 'exitedOwnerIds' | 'recentSpeakerOwnerIds' | 'mentionedOwnerIds' | 'sourceRefs'>> = [
    'locationKeys', 'presentOwnerIds', 'nearbyOwnerIds', 'exitedOwnerIds', 'recentSpeakerOwnerIds', 'mentionedOwnerIds', 'sourceRefs',
  ];
  if (arrays.some(key => !Array.isArray(row[key]) || !(row[key] as readonly unknown[]).every(item => typeof item === 'string'))) return undefined;
  const numbers: Array<keyof Pick<SceneState, 'sceneEpoch' | 'startedAtFloor' | 'updatedAtFloor' | 'confidence' | 'revision' | 'createdAt' | 'updatedAt'>> = [
    'sceneEpoch', 'startedAtFloor', 'updatedAtFloor', 'confidence', 'revision', 'createdAt', 'updatedAt',
  ];
  if (numbers.some(key => !Number.isFinite(row[key]))) return undefined;
  if (row.viewpointOwnerId !== undefined && typeof row.viewpointOwnerId !== 'string') return undefined;
  return structuredClone(row) as SceneState;
}

function replaceMigrationIdentifiers(value: string, replacements: ReadonlyMap<string, string>): string {
  let next = value;
  for (const [from, to] of [...replacements.entries()].sort(([left], [right]) => right.length - left.length)) {
    if (from && next.includes(from)) next = next.replaceAll(from, to);
  }
  return next;
}

function remapPlainData(value: PlainData, replacements: ReadonlyMap<string, string>): PlainData {
  if (typeof value === 'string') return replaceMigrationIdentifiers(value, replacements);
  if (Array.isArray(value)) return value.map(item => remapPlainData(item, replacements));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, remapPlainData(child, replacements)])) as PlainData;
  }
  return value;
}

function mergeMigratedPlainData(existing: PlainData, incoming: PlainData): PlainData {
  if (Array.isArray(existing) && Array.isArray(incoming)) {
    const values = new Map<string, PlainData>();
    for (const item of [...existing, ...incoming]) values.set(JSON.stringify(item), item);
    return [...values.values()];
  }
  if (existing && incoming && typeof existing === 'object' && typeof incoming === 'object' && !Array.isArray(existing) && !Array.isArray(incoming)) {
    const merged: Record<string, PlainData> = { ...(existing as Record<string, PlainData>) };
    for (const [key, value] of Object.entries(incoming as Record<string, PlainData>)) {
      merged[key] = key in merged ? mergeMigratedPlainData(merged[key]!, value) : value;
    }
    if (typeof (existing as Record<string, PlainData>).createdAt === 'number' && typeof (incoming as Record<string, PlainData>).createdAt === 'number') {
      merged.createdAt = Math.min(Number((existing as Record<string, PlainData>).createdAt), Number((incoming as Record<string, PlainData>).createdAt));
    }
    if (typeof (existing as Record<string, PlainData>).updatedAt === 'number' && typeof (incoming as Record<string, PlainData>).updatedAt === 'number') {
      merged.updatedAt = Math.max(Number((existing as Record<string, PlainData>).updatedAt), Number((incoming as Record<string, PlainData>).updatedAt));
    }
    return merged;
  }
  return incoming;
}

function migrationTooLargeError(operationCount: number): Error & { code: string } {
  return Object.assign(new Error(`人物迁移需要 ${operationCount} 个原子操作，超过 SDK 上限 ${ATOMIC_TRANSACTION_MAX_OPERATIONS}；未写入任何数据。`), {
    code: 'ACTOR_MIGRATION_TOO_LARGE',
  });
}
interface ChangeEntry { collection: string; recordId: string; before?: PlainData; after?: PlainData; }
export interface ChangeAudit { id: string; workspaceId: string; chatKey: string; kind: 'capture-change-set-v0' | 'derived-change-set-v0' | 'actor-registry-change-set-v0' | 'dream-change-set-v0'; createdAt: number; entries: readonly ChangeEntry[]; metadata?: PlainData; rolledBackAt?: number; }

function manualFactId(chatKey: string): string { return `fact:${encodeURIComponent(chatKey)}:manual:${crypto.randomUUID()}`; }
function factHeadId(chatKey: string, slotKey: string): string { return `fact-head:${encodeURIComponent(chatKey)}:${encodeURIComponent(slotKey)}`; }

function asPlain(value: unknown): PlainData { return structuredClone(value) as PlainData; }

function canonicalPlain(value: PlainData): PlainData {
  if (Array.isArray(value)) return value.map(canonicalPlain);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalPlain(item)]));
  }
  return value;
}

function samePlain(left: PlainData | undefined, right: PlainData | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return JSON.stringify(canonicalPlain(left)) === JSON.stringify(canonicalPlain(right));
}
function idOf(value: unknown): string { return String((value as { id?: unknown }).id ?? ''); }
function rows<T>(page: { records?: readonly WorkspaceRecord[] } | undefined): WorkspaceRecord[] { return [...(page?.records ?? [])]; }
function stableKey(value: string): string {
  return stableRecordHash(value);
}

const KNOWLEDGE_MODE_RANK: Readonly<Record<ActorMemoryTrace['knowledgeMode'], number>> = Object.freeze({ unknown: 0, suspected: 1, believed: 2, inferred: 3, heard: 4, experienced: 5, self_reported: 6, asserted: 7 });
const PRIVACY_RANK: Readonly<Record<ActorMemoryTrace['privacy'], number>> = Object.freeze({ public: 0, limited: 1, private: 2, secret: 3 });
const QUERY_PAGE_SIZE = 500;
const TRANSACTION_BATCH_SIZE = 500;
const ATOMIC_TRANSACTION_MAX_OPERATIONS = 5_000;

function paginationStalledError(collection: string): Error & { code: string } {
  return Object.assign(new Error(`多角色 Memory 集合 ${collection} 的分页游标未推进，已停止读取。`), {
    code: 'WORKSPACE_PAGINATION_STALLED',
  });
}

/** New v0 persistence surface; it never reads or migrates the retired model. */
export class MultiActorMemoryRepository {
  private workspaceId = '';
  private chatKey = '';
  private readonly unavailableOptionalCollections = new Set<string>();
  constructor(readonly workspace: WorkspacePort) {}

  bind(workspaceId: string, chatKey: string): void { this.workspaceId = workspaceId.trim(); this.chatKey = chatKey.trim(); }
  get boundWorkspaceId(): string { return this.workspaceId; }
  get boundChatKey(): string { return this.chatKey; }

  async open(): Promise<void> {
    if (!this.workspaceId) throw new Error('多角色 Memory 缺少 workspaceId。');
    await this.workspace.open({ workspaceId: this.workspaceId, create: true, metadata: { kind: 'memory-multi-actor-v0' } });
    for (const retiredCollection of ['fact-slots', 'jobs', 'job-audits', 'initialization-staging']) {
      try {
        // WorkspacePort already scopes reads to the bound workspace. Retired
        // rows may predate the workspaceId field, so filtering on that field
        // would silently miss exactly the data this fail-closed guard is meant
        // to detect.
        const page = await this.workspace.query({ workspaceId: this.workspaceId, collection: retiredCollection, limit: 1 });
        if ((page.records?.length ?? 0) > 0) {
          const error = new Error(`检测到已退休的 Memory 存储集合：${retiredCollection}。请删除旧 v0 之前数据库后再启动。`) as Error & { code?: string };
          error.code = 'MEMORY_RETIRED_STORAGE_DETECTED';
          throw error;
        }
      } catch (error) {
        if (error instanceof Error && (error as Error & { code?: string }).code === 'MEMORY_RETIRED_STORAGE_DETECTED') throw error;
        // A new WorkspacePort is allowed to report “collection not found” for
        // retired names; that is the expected clean-slate result.
      }
    }
    this.unavailableOptionalCollections.clear();
    for (const [name, indexes] of Object.entries(CORE_COLLECTIONS)) await this.workspace.defineCollection({ workspaceId: this.workspaceId, name, indexes });
    for (const [name, indexes] of Object.entries(CAST_COLLECTIONS)) {
      try {
        await this.workspace.defineCollection({ workspaceId: this.workspaceId, name, indexes });
      } catch {
        // The generation-planning surface is additive. A host that cannot yet
        // create one of these collections must retain the existing Capture,
        // fact, profile and Dream path instead of failing plugin startup.
        this.unavailableOptionalCollections.add(name);
      }
    }
  }

  private async list(collection: string, filter?: Readonly<Record<string, PlainData>>): Promise<WorkspaceRecord[]> {
    if (this.unavailableOptionalCollections.has(collection)) return [];
    const records: WorkspaceRecord[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const page = await this.workspace.query({ workspaceId: this.workspaceId, collection, filter, ...(cursor ? { cursor } : {}), limit: QUERY_PAGE_SIZE });
      records.push(...rows(page));
      const nextCursor = page.nextCursor ?? undefined;
      if (nextCursor !== undefined && seenCursors.has(nextCursor)) throw paginationStalledError(collection);
      if (nextCursor !== undefined) seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);
    return records;
  }

  private async transactInBatches(operations: readonly WorkspaceTransactionOperation[], idempotencyPrefix: string): Promise<void> {
    for (let offset = 0; offset < operations.length; offset += TRANSACTION_BATCH_SIZE) {
      await this.workspace.transaction({
        workspaceId: this.workspaceId,
        idempotencyKey: `${idempotencyPrefix}:${offset / TRANSACTION_BATCH_SIZE}`,
        operations: operations.slice(offset, offset + TRANSACTION_BATCH_SIZE),
      });
    }
  }

  async listOwners(): Promise<MemoryOwner[]> { return (await this.list('actors', { workspaceId: this.workspaceId })).map(record => record.value as unknown as MemoryOwner); }
  async listAliases(): Promise<ActorAlias[]> { return (await this.list('actor-aliases', { workspaceId: this.workspaceId })).map(record => record.value as unknown as ActorAlias); }
  async listPendingCandidates(): Promise<ActorCandidate[]> {
    return (await this.list('actor-candidates', { workspaceId: this.workspaceId, chatKey: this.chatKey, status: 'pending' }))
      .map(record => record.value as unknown as ActorCandidate);
  }
  async listLocations(): Promise<MemoryLocation[]> {
    return (await this.list('locations', { workspaceId: this.workspaceId }))
      .map(record => record.value as unknown as MemoryLocation);
  }
  async listLocationAliases(): Promise<LocationAlias[]> {
    return (await this.list('location-aliases', { workspaceId: this.workspaceId }))
      .map(record => record.value as unknown as LocationAlias);
  }
  async listPendingLocationCandidates(): Promise<LocationCandidate[]> {
    return (await this.list('location-candidates', { workspaceId: this.workspaceId, chatKey: this.chatKey, status: 'pending' }))
      .map(record => record.value as unknown as LocationCandidate);
  }
  async listEpisodes(): Promise<MemoryEpisode[]> { return (await this.list('episodes', { workspaceId: this.workspaceId, chatKey: this.chatKey })).map(record => record.value as unknown as MemoryEpisode); }
  async listSceneCasts(): Promise<SceneCast[]> { return (await this.list('scene-casts', { workspaceId: this.workspaceId, chatKey: this.chatKey })).map(record => record.value as unknown as SceneCast); }
  async getSceneState(): Promise<SceneState | undefined> {
    if (this.unavailableOptionalCollections.has('scene-states')) return undefined;
    const record = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'scene-states', recordId: sceneStateRecordId(this.workspaceId, this.chatKey) });
    return sceneStateFromRecord(record?.value, this.workspaceId, this.chatKey);
  }
  async listSceneStates(): Promise<SceneState[]> {
    return (await this.list('scene-states', { workspaceId: this.workspaceId, chatKey: this.chatKey }))
      .map(record => sceneStateFromRecord(record.value, this.workspaceId, this.chatKey))
      .filter((state): state is SceneState => Boolean(state));
  }
  async listSceneTransitions(): Promise<SceneTransition[]> {
    return (await this.list('scene-transitions', { workspaceId: this.workspaceId, chatKey: this.chatKey }))
      .map(record => record.value as unknown as SceneTransition)
      .sort((left, right) => right.floor - left.floor || right.createdAt - left.createdAt);
  }
  async saveSceneState(state: SceneState, transition?: SceneTransition): Promise<void> {
    if (this.unavailableOptionalCollections.has('scene-states')) return;
    if (state.workspaceId !== this.workspaceId || state.chatKey !== this.chatKey) throw new Error('SceneState 不属于当前工作区或聊天。');
    if (transition && (transition.workspaceId !== this.workspaceId || transition.chatKey !== this.chatKey || transition.sceneId !== state.sceneId)) throw new Error('SceneTransition 与当前 SceneState 不匹配。');
    const current = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'scene-states', recordId: state.id });
    const operations: WorkspaceTransactionOperation[] = [{ action: 'upsert', collection: 'scene-states', recordId: state.id, value: asPlain(state), expectedVersion: current?.version ?? 0 }];
    if (transition && !this.unavailableOptionalCollections.has('scene-transitions')) {
      const existingTransition = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'scene-transitions', recordId: transition.id });
      operations.push({ action: 'upsert', collection: 'scene-transitions', recordId: transition.id, value: asPlain(transition), expectedVersion: existingTransition?.version ?? 0 });
    }
    await this.workspace.transaction({ workspaceId: this.workspaceId, idempotencyKey: `scene-state:${state.id}:${state.revision}`, operations });
  }
  async commitGenerationPreparation(input: {
    readonly state: SceneState;
    readonly transition?: SceneTransition;
    readonly plan: GenerationCastPlan;
    readonly coverage: RecallCoverageLog;
    readonly isCurrent?: () => boolean;
  }): Promise<void> {
    const { state, transition, plan, coverage } = input;
    const assertCurrent = (): void => {
      if (input.isCurrent && !input.isCurrent()) throw staleGenerationScopeError();
    };
    assertCurrent();
    if (state.workspaceId !== this.workspaceId || state.chatKey !== this.chatKey) throw new Error('SceneState 不属于当前工作区或聊天。');
    if (plan.workspaceId !== this.workspaceId || plan.chatKey !== this.chatKey || plan.sceneId !== state.sceneId) throw new Error('GenerationCastPlan 与当前 SceneState 不匹配。');
    if (coverage.workspaceId !== this.workspaceId || coverage.chatKey !== this.chatKey || coverage.planId !== plan.id) throw new Error('RecallCoverageLog 与当前 GenerationCastPlan 不匹配。');
    if (transition && (transition.workspaceId !== this.workspaceId || transition.chatKey !== this.chatKey || transition.sceneId !== state.sceneId)) throw new Error('SceneTransition 与当前 SceneState 不匹配。');

    const operations: WorkspaceTransactionOperation[] = [];
    const queue = async (collection: string, recordId: string, value: Persistable): Promise<void> => {
      if (this.unavailableOptionalCollections.has(collection)) return;
      assertCurrent();
      const current = await this.workspace.get({ workspaceId: this.workspaceId, collection, recordId });
      assertCurrent();
      operations.push({ action: 'upsert', collection, recordId, value: asPlain(value), expectedVersion: current?.version ?? 0 });
    };
    await queue('scene-states', state.id, state);
    if (transition) await queue('scene-transitions', transition.id, transition);
    await queue('generation-cast-plans', plan.id, plan);
    await queue('recall-coverage-logs', coverage.id, coverage);
    assertCurrent();
    if (operations.length === 0) return;
    await this.workspace.transaction({
      workspaceId: this.workspaceId,
      idempotencyKey: `generation-preparation:${plan.id}`,
      operations,
    });
  }
  async saveGenerationCastPlan(plan: GenerationCastPlan): Promise<void> {
    if (this.unavailableOptionalCollections.has('generation-cast-plans')) return;
    if (plan.workspaceId !== this.workspaceId || plan.chatKey !== this.chatKey) throw new Error('GenerationCastPlan 不属于当前工作区或聊天。');
    const current = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'generation-cast-plans', recordId: plan.id });
    await this.workspace.upsert({ workspaceId: this.workspaceId, collection: 'generation-cast-plans', recordId: plan.id, value: asPlain(plan), expectedVersion: current?.version ?? 0 });
  }
  async getGenerationCastPlan(planId: string): Promise<GenerationCastPlan | undefined> {
    if (this.unavailableOptionalCollections.has('generation-cast-plans')) return undefined;
    const record = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'generation-cast-plans', recordId: planId });
    const plan = record?.value as unknown as GenerationCastPlan | undefined;
    return plan?.workspaceId === this.workspaceId && plan.chatKey === this.chatKey ? plan : undefined;
  }
  async listGenerationCastPlans(limit = 50): Promise<GenerationCastPlan[]> {
    return (await this.list('generation-cast-plans', { workspaceId: this.workspaceId, chatKey: this.chatKey }))
      .map(record => record.value as unknown as GenerationCastPlan)
      .sort((left, right) => right.basedOnFloor - left.basedOnFloor || right.createdAt - left.createdAt)
      .slice(0, Math.max(1, Math.trunc(limit)));
  }
  async recordCastPlanAudit(audit: CastPlanAudit): Promise<void> {
    if (this.unavailableOptionalCollections.has('cast-plan-audits')) return;
    if (audit.workspaceId !== this.workspaceId || audit.chatKey !== this.chatKey) throw new Error('CastPlanAudit 不属于当前工作区或聊天。');
    const current = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'cast-plan-audits', recordId: audit.id });
    await this.workspace.upsert({ workspaceId: this.workspaceId, collection: 'cast-plan-audits', recordId: audit.id, value: asPlain(audit), expectedVersion: current?.version ?? 0 });
  }
  async listCastPlanAudits(limit = 100): Promise<CastPlanAudit[]> {
    return (await this.list('cast-plan-audits', { workspaceId: this.workspaceId, chatKey: this.chatKey }))
      .map(record => record.value as unknown as CastPlanAudit)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, Math.max(1, Math.trunc(limit)));
  }
  async recordRecallCoverage(log: RecallCoverageLog): Promise<void> {
    if (this.unavailableOptionalCollections.has('recall-coverage-logs')) return;
    if (log.workspaceId !== this.workspaceId || log.chatKey !== this.chatKey) throw new Error('RecallCoverageLog 不属于当前工作区或聊天。');
    const current = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'recall-coverage-logs', recordId: log.id });
    await this.workspace.upsert({ workspaceId: this.workspaceId, collection: 'recall-coverage-logs', recordId: log.id, value: asPlain(log), expectedVersion: current?.version ?? 0 });
  }
  async listRecallCoverageLogs(limit = 100): Promise<RecallCoverageLog[]> {
    return (await this.list('recall-coverage-logs', { workspaceId: this.workspaceId, chatKey: this.chatKey }))
      .map(record => record.value as unknown as RecallCoverageLog)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, Math.max(1, Math.trunc(limit)));
  }
  async recordMemoryUsage(logs: readonly MemoryUsageLog[]): Promise<void> {
    if (logs.length === 0 || this.unavailableOptionalCollections.has('memory-usage-logs')) return;
    const operations: WorkspaceTransactionOperation[] = [];
    for (const log of logs) {
      if (log.workspaceId !== this.workspaceId || log.chatKey !== this.chatKey) throw new Error('MemoryUsageLog 不属于当前工作区或聊天。');
      const current = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'memory-usage-logs', recordId: log.id });
      operations.push({ action: 'upsert', collection: 'memory-usage-logs', recordId: log.id, value: asPlain(log), expectedVersion: current?.version ?? 0 });
    }
    await this.workspace.transaction({ workspaceId: this.workspaceId, idempotencyKey: `memory-usage:${this.chatKey}:${crypto.randomUUID()}`, operations });
  }
  async listMemoryUsageLogs(limit = 200): Promise<MemoryUsageLog[]> {
    return (await this.list('memory-usage-logs', { workspaceId: this.workspaceId, chatKey: this.chatKey }))
      .map(record => record.value as unknown as MemoryUsageLog)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, Math.max(1, Math.trunc(limit)));
  }
  async listCaptureJobs(): Promise<Record<string, unknown>[]> { return (await this.list('capture-jobs', { workspaceId: this.workspaceId, chatKey: this.chatKey })).map(record => record.value as unknown as Record<string, unknown>); }
  /**
   * Persist capture progress in the v0 capture-jobs collection.  The
   * application deliberately uses this surface for the multi-actor path so
   * progress never falls back to the retired generic job/audit APIs.
   */
  async upsertCaptureJob(record: Record<string, unknown>): Promise<void> {
    const id = String(record.id ?? '');
    if (!id) throw new Error('Capture job 缺少 id。');
    const chatKey = String(record.chatKey ?? this.chatKey).trim();
    if (!chatKey || chatKey !== this.chatKey) throw new Error('Capture job 不属于当前聊天。');
    const workspaceId = String(record.workspaceId ?? this.workspaceId).trim();
    if (!workspaceId || workspaceId !== this.workspaceId) throw new Error('Capture job 不属于当前工作区。');
    const current = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'capture-jobs', recordId: id });
    await this.workspace.upsert({
      workspaceId: this.workspaceId,
      collection: 'capture-jobs',
      recordId: id,
      value: asPlain({ ...record, id, workspaceId, chatKey, updatedAt: Number(record.updatedAt ?? Date.now()) }),
      expectedVersion: current?.version ?? 0,
    });
  }
  async listChangeAudits(): Promise<Record<string, unknown>[]> { return (await this.list('change-audits', { workspaceId: this.workspaceId, chatKey: this.chatKey })).map(record => record.value as unknown as Record<string, unknown>); }
  async getChangeAudit(auditId: string): Promise<ChangeAudit | undefined> {
    const record = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'change-audits', recordId: auditId });
    const audit = record?.value as unknown as ChangeAudit | undefined;
    return audit?.workspaceId === this.workspaceId && audit.chatKey === this.chatKey ? audit : undefined;
  }
  async updateCaptureAuditRejections(auditId: string, rejections: readonly AutomaticIngestRejection[]): Promise<void> {
    const current = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'change-audits', recordId: auditId });
    const audit = current?.value as unknown as ChangeAudit | undefined;
    if (!current || !audit || audit.kind !== 'capture-change-set-v0' || audit.workspaceId !== this.workspaceId || audit.chatKey !== this.chatKey) throw new Error('找不到当前聊天的 Capture 审计记录。');
    if (audit.rolledBackAt) throw new Error('不能修改已回滚 Capture 的失败项。');
    const metadata = audit.metadata && typeof audit.metadata === 'object' && !Array.isArray(audit.metadata)
      ? audit.metadata as Record<string, PlainData>
      : {};
    const unresolvedCount = rejections.filter(item => (item.status ?? 'unresolved') === 'unresolved').length;
    const outcome = unresolvedCount > 0 ? 'partial' : 'complete';
    const operations: WorkspaceTransactionOperation[] = [{
      action: 'upsert',
      collection: 'change-audits',
      recordId: auditId,
      value: asPlain({ ...audit, metadata: { ...metadata, outcome, rejections: [...rejections] } }),
      expectedVersion: current.version,
    }];
    const captureJobId = String(metadata.captureJobId ?? '').trim();
    if (captureJobId) {
      const captureJob = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'capture-jobs', recordId: captureJobId });
      if (captureJob?.value && typeof captureJob.value === 'object') {
        const jobValue = captureJob.value as Record<string, unknown>;
        if (String(jobValue.workspaceId ?? '') !== this.workspaceId || String(jobValue.chatKey ?? '') !== this.chatKey) throw new Error('Capture job 不属于当前聊天。');
        // A job spans many batch ChangeSets. Updating one repaired batch must
        // not erase unresolved rows that still belong to another batch.
        const aggregate = new Map<string, AutomaticIngestRejection>();
        for (const row of await this.listChangeAudits()) {
          if (String(row.kind ?? '') !== 'capture-change-set-v0' || row.rolledBackAt) continue;
          const rowMetadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
            ? row.metadata as Record<string, unknown>
            : {};
          if (String(rowMetadata.captureJobId ?? '') !== captureJobId) continue;
          // A targeted repair child may contain validation diagnostics for the
          // repair attempt itself. The original batch audit remains the single
          // user-facing issue, so including both would double-count failures.
          if (String(rowMetadata.attachmentKind ?? '') === 'capture-repair-v0') continue;
          const rows = String(row.id ?? '') === auditId
            ? rejections
            : Array.isArray(rowMetadata.rejections)
              ? rowMetadata.rejections.filter((item): item is AutomaticIngestRejection => Boolean(item && typeof item === 'object'))
              : [];
          for (const item of rows) {
            const key = item.id ?? `${item.recordType ?? 'unknown'}:${item.index}:${item.code}:${item.fieldPath ?? ''}`;
            aggregate.set(key, structuredClone(item));
          }
        }
        const jobRejections = [...aggregate.values()];
        const jobUnresolvedCount = jobRejections.filter(item => (item.status ?? 'unresolved') === 'unresolved').length;
        const jobOutcome = jobUnresolvedCount > 0 ? 'partial' : 'complete';
        operations.push({
          action: 'upsert',
          collection: 'capture-jobs',
          recordId: captureJobId,
          // Keep the full history for audit display, but the progress badge
          // must count only work that still requires attention.
          value: asPlain({
            ...jobValue,
            outcome: jobOutcome,
            rejectionCount: jobUnresolvedCount,
            rejections: jobRejections,
            updatedAt: Date.now(),
          }),
          expectedVersion: captureJob.version,
        });
      }
    }
    await this.workspace.transaction({ workspaceId: this.workspaceId, idempotencyKey: `capture-rejections:${auditId}:${crypto.randomUUID()}`, operations });
  }
  async recordKnowledgeLeakageAudit(audit: {
    readonly outputHash: string;
    readonly checkedOwners: readonly string[];
    readonly violationCount: number;
    readonly violations: readonly { readonly ownerId: string; readonly leakedFromOwnerId: string; readonly marker: string }[];
  }): Promise<void> {
    const id = `security-audit:${crypto.randomUUID()}`;
    const value: ChangeAudit = {
      id,
      workspaceId: this.workspaceId,
      chatKey: this.chatKey,
      kind: 'derived-change-set-v0',
      createdAt: Date.now(),
      entries: [],
      metadata: asPlain({
        diagnosticType: 'knowledge-leakage',
        outputHash: audit.outputHash,
        checkedOwnerCount: audit.checkedOwners.length,
        violationCount: audit.violationCount,
        violations: audit.violations.map(item => ({ ownerId: item.ownerId, leakedFromOwnerId: item.leakedFromOwnerId, marker: item.marker })),
      }),
    };
    await this.workspace.upsert({ workspaceId: this.workspaceId, collection: 'change-audits', recordId: id, value: asPlain(value) });
  }
  async listObservations(): Promise<MemoryObservation[]> {
    // Observation history is a workspace-level diagnostic view. Chat-scoped
    // callers use the episode/scene records to narrow it; keeping this method
    // global also lets cleanup tests verify that another chat was preserved.
    return (await this.list('observations', { workspaceId: this.workspaceId }))
      .map(record => record.value as unknown as MemoryObservation);
  }
  async listFacts(options: FactListOptions = {}): Promise<MemoryFact[]> {
    const facts = (await this.list('facts', { workspaceId: this.workspaceId, chatKey: this.chatKey }))
      .map(record => record.value as unknown as MemoryFact)
      .filter(fact => !options.status || fact.status === options.status)
      .filter(fact => !options.kind || fact.kind === options.kind);
    return options.limit === undefined ? facts : facts.slice(0, Math.max(1, Math.trunc(options.limit)));
  }
  async listEvidence(factId: string): Promise<MemoryEvidence[]> {
    return (await this.list('evidence', { workspaceId: this.workspaceId, chatKey: this.chatKey, factId }))
      .map(record => record.value as unknown as MemoryEvidence);
  }
  async listTraces(ownerId?: string): Promise<ActorMemoryTrace[]> {
    const records = await this.list('memory-traces', { workspaceId: this.workspaceId, ...(ownerId ? { ownerId } : {}) });
    const traces = records.map(record => record.value as unknown as ActorMemoryTrace & { readonly chatKey?: string });
    const needsLegacyScopeResolution = traces.some(trace => !trace.chatKey);
    const currentFactIds = needsLegacyScopeResolution
      ? new Set((await this.list('facts', { workspaceId: this.workspaceId, chatKey: this.chatKey })).map(record => record.recordId))
      : new Set<string>();
    return traces.filter(trace => trace.chatKey === this.chatKey || (!trace.chatKey && currentFactIds.has(trace.factId)));
  }
  async getFact(factId: string): Promise<MemoryFact | undefined> {
    const record = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'facts', recordId: factId });
    const fact = record?.value as unknown as MemoryFact | undefined;
    return fact?.chatKey === this.chatKey ? fact : undefined;
  }
  async getOwner(ownerId: string): Promise<MemoryOwner | undefined> { const record = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'actors', recordId: ownerId }); return record?.value as unknown as MemoryOwner | undefined; }

  private async addDerivedInvalidations(
    factIdsInput: string | ReadonlySet<string>,
    traceIds: ReadonlySet<string>,
    entries: ChangeEntry[],
    operations: WorkspaceTransactionOperation[],
  ): Promise<void> {
    const factIds = typeof factIdsInput === 'string' ? new Set([factIdsInput]) : factIdsInput;
    const collections = ['memory-details', 'memory-links', 'vector-index', 'graph-edges', 'recall-exposures', 'profile-claims', 'relationship-claims'] as const;
    for (const collection of collections) {
      for (const record of await this.list(collection, { workspaceId: this.workspaceId })) {
        const value = record.value as Record<string, unknown>;
        const matches = collection === 'memory-details'
          ? factIds.has(String(value.sourceFactId ?? '')) || traceIds.has(String(value.traceId ?? ''))
          : collection === 'memory-links'
            ? factIds.has(String(value.factId ?? '')) || traceIds.has(String(value.traceId ?? ''))
            : collection === 'vector-index'
              ? factIds.has(String(value.recordId ?? '')) || [...factIds].some(factId => record.recordId === `vector:${factId}`)
              : collection === 'graph-edges'
                ? factIds.has(String(value.backingFactId ?? ''))
                : collection === 'profile-claims' || collection === 'relationship-claims'
                  ? Array.isArray(value.supportingTraceIds) && value.supportingTraceIds.some(traceId => traceIds.has(String(traceId)))
                  : traceIds.has(String(value.traceId ?? ''));
        if (!matches) continue;
        entries.push({ collection, recordId: record.recordId, before: asPlain(record.value) });
        operations.push({ action: 'delete', collection, recordId: record.recordId, expectedVersion: record.version });
      }
    }
  }

  private async deleteFactVectors(factIds: readonly string[]): Promise<void> {
    await Promise.all([...new Set(factIds)].map(factId => this.workspace.vectorDelete({
      workspaceId: this.workspaceId,
      collection: 'facts',
      recordId: factId,
    }).catch(() => false)));
  }

  /** Manual fact edits use the same v0 facts/evidence/head/trace transaction as Capture. */
  async upsertManualFact(input: ManualFactInput): Promise<MemoryFact> {
    const chatKey = this.chatKey;
    if (!chatKey) throw new Error('当前聊天缺少稳定 ID，无法编辑多主体事实。');
    const content = normalizeFactContent(input.content);
    if (Array.from(content).length < 6 || Array.from(content).length > MAX_FACT_CONTENT_LENGTH) throw new Error(`手动记忆正文必须为 6–${MAX_FACT_CONTENT_LENGTH} 字。`);
    const confidence = input.confidence ?? 1;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('手动记忆置信度必须位于 0 到 1 之间。');
    const id = input.id?.trim() || manualFactId(chatKey);
    const previousRecord = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'facts', recordId: id });
    const previous = previousRecord?.value as unknown as MemoryFact | undefined;
    if (previous && previous.chatKey !== chatKey) throw Object.assign(new Error('当前聊天不存在该记忆，跨聊天编辑已阻止。'), { code: 'MEMORY_FACT_NOT_FOUND' });
    const subjectKey = input.subjectKey.trim();
    const predicateKey = input.predicateKey.trim();
    if (!subjectKey || !predicateKey) throw new Error('手动记忆必须包含主体和谓词。');
    const slotKey = createFactSlotKey(subjectKey, predicateKey, input.objectKey, input.kind);
    const existingFacts = await this.listFacts();
    const slotFacts = existingFacts.filter(fact => fact.slotKey === slotKey && (fact.status === 'active' || fact.status === 'pending') && fact.id !== id);
    const appendOnly = isAppendOnlyFactKind(input.kind);
    const requestedStatus = input.status ?? previous?.status ?? 'active';
    const status = requestedStatus === 'active' && confidence < ACTIVE_CONFIDENCE_THRESHOLD ? 'pending' : requestedStatus;
    // A pending proposal is useful audit material but cannot displace the last
    // confirmed state. Only a new Active mutable fact supersedes the current
    // slot candidate; append-only kinds never supersede by definition.
    const conflicting = previous || appendOnly || status !== 'active'
      ? undefined
      : slotFacts.sort((left, right) => Number(right.status === 'active') - Number(left.status === 'active')
        || right.freshestEvidenceAt - left.freshestEvidenceAt
        || right.updatedAt - left.updatedAt
        || left.id.localeCompare(right.id))[0];
    const timestamp = Date.now();
    const sourceRef = `manual:${id}`;
    const evidenceId = `evidence:${id}:manual:${timestamp}`;
    const fact: MemoryFact = {
      id,
      chatKey,
      kind: input.kind,
      subjectKey,
      predicateKey,
      ...(input.objectKey === undefined ? {} : { objectKey: input.objectKey.trim() }),
      canonicalKey: createCanonicalKey(subjectKey, predicateKey, input.objectKey),
      slotKey,
      content,
      entityKeys: [...new Set(input.entityKeys ?? [])],
      confidence,
      status,
      sourceRefs: [...new Set([...(previous?.sourceRefs ?? []), sourceRef])],
      evidenceIds: [...new Set([...(previous?.evidenceIds ?? []), evidenceId])],
      freshestEvidenceAt: timestamp,
      ...(input.validFrom === undefined ? {} : { validFrom: input.validFrom }),
      ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }),
      ...(input.stableAnchor === undefined ? {} : { stableAnchor: input.stableAnchor }),
      ...(input.scope === undefined ? {} : { scope: structuredClone(input.scope) }),
      origin: 'manual',
      revision: (previous?.revision ?? 0) + 1,
      ...(previous?.supersedesId ? { supersedesId: previous.supersedesId } : {}),
      ...(previous?.supersededById ? { supersededById: previous.supersededById } : {}),
      ...(conflicting ? { supersedesId: conflicting.id } : {}),
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    const entries: ChangeEntry[] = [];
    const operations: WorkspaceTransactionOperation[] = [];
    const addUpsert = async (collection: string, recordId: string, value: PlainData): Promise<void> => {
      const before = await this.workspace.get({ workspaceId: this.workspaceId, collection, recordId });
      entries.push({ collection, recordId, ...(before ? { before: before.value } : {}), after: value });
      operations.push({ action: 'upsert', collection, recordId, value, expectedVersion: before?.version ?? 0 });
    };
    await addUpsert('facts', fact.id, asPlain({ ...fact, workspaceId: this.workspaceId }));
    const evidence: MemoryEvidence = { id: evidenceId, factId: fact.id, chatKey, sourceRef, sourceType: 'manual', excerpt: content, occurredAt: timestamp, createdAt: timestamp };
    await addUpsert('evidence', evidence.id, asPlain({ ...evidence, workspaceId: this.workspaceId }));
    if (conflicting) {
      const conflictRecord = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'facts', recordId: conflicting.id });
      if (conflictRecord) {
        const superseded = { ...conflicting, status: 'superseded' as const, supersededById: fact.id, revision: conflicting.revision + 1, updatedAt: timestamp };
        await addUpsert('facts', superseded.id, asPlain({ ...superseded, workspaceId: this.workspaceId }));
      }
    }
    // Recompute every touched mutable slot from the effective post-transaction
    // facts. This also removes a stale head when an edit changes kind/slot and
    // keeps an existing Active head when the new manual row is only Pending.
    const effectiveFacts = new Map(existingFacts.map(existing => [existing.id, existing]));
    effectiveFacts.set(fact.id, fact);
    if (conflicting) effectiveFacts.set(conflicting.id, {
      ...conflicting,
      status: 'superseded',
      supersededById: fact.id,
      revision: conflicting.revision + 1,
      updatedAt: timestamp,
    });
    const touchedSlots = new Set<string>([
      slotKey,
      ...(previous?.slotKey ? [previous.slotKey] : []),
    ]);
    for (const touchedSlot of touchedSlots) {
      const headId = factHeadId(chatKey, touchedSlot);
      const currentHead = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'fact-heads', recordId: headId });
      const selected = [...effectiveFacts.values()]
        .filter(candidate => (candidate.slotKey ?? createFactSlotKey(candidate.subjectKey, candidate.predicateKey)) === touchedSlot)
        .filter(candidate => !isAppendOnlyFactKind(candidate.kind))
        .filter(candidate => candidate.status === 'active' || candidate.status === 'pending')
        .sort((left, right) => Number(right.status === 'active') - Number(left.status === 'active')
          || right.freshestEvidenceAt - left.freshestEvidenceAt
          || right.updatedAt - left.updatedAt
          || left.id.localeCompare(right.id))[0];
      if (selected) {
        await addUpsert('fact-heads', headId, asPlain({
          id: headId,
          workspaceId: this.workspaceId,
          chatKey,
          slotKey: touchedSlot,
          factId: selected.id,
          updatedAt: selected.updatedAt,
        }));
      } else if (currentHead) {
        entries.push({ collection: 'fact-heads', recordId: headId, before: asPlain(currentHead.value) });
        operations.push({ action: 'delete', collection: 'fact-heads', recordId: headId, expectedVersion: currentHead.version });
      }
    }
    const traces = await this.list('memory-traces', { workspaceId: this.workspaceId, chatKey, factId: fact.id });
    const conflictingTraces = conflicting
      ? await this.list('memory-traces', { workspaceId: this.workspaceId, chatKey, factId: conflicting.id })
      : [];
    for (const record of traces) {
      const trace = record.value as unknown as ActorMemoryTrace;
      await addUpsert('memory-traces', record.recordId, asPlain({ ...trace, traceRevision: trace.traceRevision + 1, updatedAt: timestamp }));
    }
    await this.addDerivedInvalidations(
      new Set([fact.id, ...(conflicting ? [conflicting.id] : [])]),
      new Set([...traces, ...conflictingTraces].map(record => record.recordId)),
      entries,
      operations,
    );
    const audit: ChangeAudit = { id: `change-audit:${crypto.randomUUID()}`, workspaceId: this.workspaceId, chatKey, kind: 'derived-change-set-v0', createdAt: timestamp, entries, metadata: asPlain({ operation: 'manual-fact-upsert', factId: fact.id }) };
    operations.push({ action: 'upsert', collection: 'change-audits', recordId: audit.id, value: asPlain(audit), expectedVersion: 0 });
    await this.workspace.transaction({ workspaceId: this.workspaceId, idempotencyKey: audit.id, operations });
    await this.deleteFactVectors([fact.id, ...(conflicting ? [conflicting.id] : [])]);
    return fact;
  }

  async removeFact(factId: string): Promise<boolean> {
    const chatKey = this.chatKey;
    const targetRecord = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'facts', recordId: factId });
    const target = targetRecord?.value as unknown as MemoryFact | undefined;
    if (!target || target.chatKey !== chatKey || !targetRecord) return false;
    const entries: ChangeEntry[] = [{ collection: 'facts', recordId: factId, before: asPlain(target) }];
    const operations: WorkspaceTransactionOperation[] = [{ action: 'delete', collection: 'facts', recordId: factId, expectedVersion: targetRecord.version }];
    const declaredRelatedIds = [...new Set([target.supersedesId, target.supersededById].filter((value): value is string => Boolean(value)))];
    const related = (await Promise.all(declaredRelatedIds.map(async recordId => {
      const record = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'facts', recordId });
      const value = record?.value as unknown as MemoryFact | undefined;
      return record && value?.chatKey === chatKey ? { record, value } : undefined;
    }))).filter((entry): entry is { record: WorkspaceRecord; value: MemoryFact } => Boolean(entry));
    const relatedIds = related.map(entry => entry.record.recordId);
    const replacementFacts: MemoryFact[] = [];
    for (const { record, value } of related) {
      const restored = { ...value, revision: value.revision + 1, updatedAt: Date.now() } as MemoryFact & { supersedesId?: string; supersededById?: string };
      if (restored.supersededById === factId) { delete restored.supersededById; restored.status = 'active'; }
      if (restored.supersedesId === factId) delete restored.supersedesId;
      if (!isAppendOnlyFactKind(restored.kind) && (restored.status === 'active' || restored.status === 'pending')) replacementFacts.push(restored);
      entries.push({ collection: 'facts', recordId: record.recordId, before: asPlain(record.value), after: asPlain(restored) });
      operations.push({ action: 'upsert', collection: 'facts', recordId: record.recordId, value: asPlain(restored), expectedVersion: record.version });
    }
    for (const record of await this.list('evidence', { workspaceId: this.workspaceId, chatKey, factId })) {
      entries.push({ collection: 'evidence', recordId: record.recordId, before: asPlain(record.value) });
      operations.push({ action: 'delete', collection: 'evidence', recordId: record.recordId, expectedVersion: record.version });
    }
    const traces = await this.list('memory-traces', { workspaceId: this.workspaceId, chatKey, factId });
    const relatedTraceRecords = (await Promise.all(relatedIds.map(relatedId => this.list('memory-traces', { workspaceId: this.workspaceId, chatKey, factId: relatedId })))).flat();
    for (const record of traces) {
      entries.push({ collection: 'memory-traces', recordId: record.recordId, before: asPlain(record.value) });
      operations.push({ action: 'delete', collection: 'memory-traces', recordId: record.recordId, expectedVersion: record.version });
    }
    const headId = factHeadId(chatKey, target.slotKey
      ?? createFactSlotKey(target.subjectKey, target.predicateKey, target.objectKey, target.kind));
    const head = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'fact-heads', recordId: headId });
    if (head && String((head.value as Record<string, unknown>).factId ?? '') === factId) {
      entries.push({ collection: 'fact-heads', recordId: headId, before: asPlain(head.value) });
      const replacement = replacementFacts.sort((left, right) => Number(right.status === 'active') - Number(left.status === 'active') || right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))[0];
      if (replacement) operations.push({ action: 'upsert', collection: 'fact-heads', recordId: headId, value: asPlain({ id: headId, workspaceId: this.workspaceId, chatKey, slotKey: target.slotKey ?? createFactSlotKey(target.subjectKey, target.predicateKey, target.objectKey, target.kind), factId: replacement.id, updatedAt: Date.now() }), expectedVersion: head.version });
      else operations.push({ action: 'delete', collection: 'fact-heads', recordId: headId, expectedVersion: head.version });
    }
    await this.addDerivedInvalidations(
      new Set([factId, ...relatedIds]),
      new Set([...traces, ...relatedTraceRecords].map(record => record.recordId)),
      entries,
      operations,
    );
    const audit: ChangeAudit = { id: `change-audit:${crypto.randomUUID()}`, workspaceId: this.workspaceId, chatKey, kind: 'derived-change-set-v0', createdAt: Date.now(), entries, metadata: asPlain({ operation: 'manual-fact-remove', factId }) };
    operations.push({ action: 'upsert', collection: 'change-audits', recordId: audit.id, value: asPlain(audit) });
    await this.workspace.transaction({ workspaceId: this.workspaceId, idempotencyKey: audit.id, operations });
    await this.deleteFactVectors([factId, ...relatedIds]);
    return true;
  }
  async listDerived(collection: 'profile-claims' | 'relationship-claims' | 'dream-jobs' | 'dream-audits' | 'recall-exposures', ownerId?: string): Promise<Record<string, unknown>[]> {
    return (await this.list(collection, { workspaceId: this.workspaceId, ...(ownerId ? { ownerId } : {}), ...(collection !== 'profile-claims' && collection !== 'relationship-claims' ? { chatKey: this.chatKey } : {}) })).map(record => record.value as unknown as Record<string, unknown>);
  }

  async listPendingActorCandidates(): Promise<ActorCandidate[]> { return this.listPendingCandidates(); }

  async commitCapture(commit: CaptureCommit): Promise<ChangeAudit> {
    const parentChangeSetId = commit.parentChangeSetId?.trim();
    if (parentChangeSetId) {
      const parentRecord = await this.workspace.get({
        workspaceId: this.workspaceId,
        collection: 'change-audits',
        recordId: parentChangeSetId,
      });
      const parent = parentRecord?.value as unknown as ChangeAudit | undefined;
      if (!parent
        || parent.kind !== 'capture-change-set-v0'
        || parent.workspaceId !== this.workspaceId
        || parent.chatKey !== this.chatKey
        || parent.rolledBackAt) {
        throw Object.assign(new Error('定向修复的父 Capture ChangeSet 不存在、已回滚或不属于当前聊天。'), {
          code: 'CAPTURE_REPAIR_PARENT_INVALID',
        });
      }
    }
    const baseTransactionKey = commit.idempotencyKey?.trim()
      || `capture:${commit.captureJobId ?? this.chatKey}:${commit.envelope.sourceRefs.join('|')}`;
    let retryAttempt = 0;
    let collisionAttempt = 0;
    let transactionKey = baseTransactionKey;
    let auditId = `change-audit:${stableKey(transactionKey)}`;
    const auditMatchesRequest = (existingAudit: ChangeAudit, existingAuditId: string): boolean => {
      if (existingAudit.kind !== 'capture-change-set-v0'
        || existingAudit.workspaceId !== this.workspaceId
        || existingAudit.chatKey !== this.chatKey) return false;
      const metadata = existingAudit.metadata && typeof existingAudit.metadata === 'object' && !Array.isArray(existingAudit.metadata)
        ? existingAudit.metadata as Record<string, PlainData>
        : {};
      const persistedTransactionKey = String(metadata.transactionKey ?? '');
      if (persistedTransactionKey) return persistedTransactionKey === transactionKey;
      // Compatibility with audits written before transactionKey was persisted.
      const persistedSources = Array.isArray(metadata.sourceRefs) ? metadata.sourceRefs.map(String) : [];
      const sameSources = persistedSources.length === commit.envelope.sourceRefs.length
        && persistedSources.every((sourceRef, index) => sourceRef === commit.envelope.sourceRefs[index]);
      const sameParent = String(metadata.parentChangeSetId ?? '') === (parentChangeSetId ?? '');
      const persistedJobId = String(metadata.captureJobId ?? '');
      const sameJob = commit.captureJobId
        ? persistedJobId === commit.captureJobId
        : persistedJobId === `capture-job:${existingAuditId}`;
      return sameSources && sameParent && sameJob;
    };

    // SDK workspace transactions are durably idempotent. A rolled-back
    // transaction cannot reuse the same key: the SDK would correctly replay
    // the original transaction result without applying the records again.
    // Walk the deterministic retry chain until reaching either an unapplied
    // key or an already-active retry. This remains stable across restarts and
    // preserves exactly-once behaviour for ordinary duplicate requests.
    while (true) {
      const existingRecord = await this.workspace.get({
        workspaceId: this.workspaceId,
        collection: 'change-audits',
        recordId: auditId,
      });
      const existingAudit = existingRecord?.value as unknown as ChangeAudit | undefined;
      if (!existingAudit) break;
      if (auditMatchesRequest(existingAudit, auditId)) {
        if (!existingAudit.rolledBackAt) return structuredClone(existingAudit);
        retryAttempt += 1;
        collisionAttempt = 0;
        transactionKey = `${baseTransactionKey}:retry:${retryAttempt}`;
        auditId = `change-audit:${stableKey(transactionKey)}`;
        continue;
      }
      // The short legacy hash can collide. Never overwrite an unrelated audit;
      // derive a deterministic alternate id while preserving the transaction's
      // real idempotency key.
      collisionAttempt += 1;
      if (collisionAttempt > 1_024) throw Object.assign(new Error('无法为 Capture 分配无冲突的审计 ID。'), { code: 'CHANGE_AUDIT_ID_EXHAUSTED' });
      auditId = `change-audit:${stableKey(`${transactionKey}:collision:${collisionAttempt}`)}`;
    }

    const entries: ChangeEntry[] = [];
    const operations: WorkspaceTransactionOperation[] = [];
    const add = async (collection: string, value: Persistable | Record<string, unknown>): Promise<void> => {
      const recordId = idOf(value);
      if (!recordId) throw new Error(`多角色记录缺少 id：${collection}`);
      const before = await this.workspace.get({ workspaceId: this.workspaceId, collection, recordId });
      const persisted = collection === 'memory-traces' && !(value as { chatKey?: unknown }).chatKey
        ? { ...value, chatKey: this.chatKey, workspaceId: this.workspaceId }
        : collection === 'facts' || collection === 'evidence'
          ? { ...value, workspaceId: this.workspaceId }
          : value;
      entries.push({ collection, recordId, ...(before ? { before: before.value } : {}), after: asPlain(persisted) });
      operations.push({ action: 'upsert', collection, recordId, value: asPlain(persisted), expectedVersion: before?.version ?? 0 });
    };
    const remove = (collection: string, row: WorkspaceRecord): void => {
      entries.push({ collection, recordId: row.recordId, before: row.value });
      operations.push({ action: 'delete', collection, recordId: row.recordId, expectedVersion: row.version });
    };
    for (const value of commit.owners) await add('actors', value);
    for (const value of commit.aliases) await add('actor-aliases', value);
    const pendingCandidates = commit.pendingCandidates ?? [];
    for (const candidate of pendingCandidates) {
      const recordId = actorCandidateRecordId(candidate);
      const persisted = { ...candidate, id: recordId, workspaceId: this.workspaceId, chatKey: this.chatKey, status: candidate.status ?? 'pending', updatedAt: Date.now() };
      await add('actor-candidates', persisted);
    }
    const confirmedOwnerIds = new Set(commit.owners.filter(owner => owner.status === 'confirmed').map(owner => owner.id));
    const pendingCandidateRecordIds = new Set(pendingCandidates.map(actorCandidateRecordId));
    for (const row of await this.list('actor-candidates', { workspaceId: this.workspaceId, chatKey: this.chatKey, status: 'pending' })) {
      const ownerRef = String((row.value as Record<string, unknown>).ownerRef ?? '');
      if (ownerRef && confirmedOwnerIds.has(ownerRef) && !pendingCandidateRecordIds.has(row.recordId)) {
        remove('actor-candidates', row);
      }
    }
    for (const value of commit.locations) await add('locations', value);
    for (const value of commit.locationAliases) await add('location-aliases', value);
    for (const candidate of commit.pendingLocationCandidates ?? []) {
      const recordId = locationCandidateRecordId(candidate);
      const persisted = {
        ...candidate,
        id: recordId,
        workspaceId: this.workspaceId,
        chatKey: this.chatKey,
        status: candidate.status ?? 'pending',
        updatedAt: Date.now(),
      };
      await add('location-candidates', persisted);
    }
    const confirmedLocationIds = new Set(commit.locations.filter(location => location.status === 'confirmed').map(location => location.id));
    const pendingLocationCandidates = commit.pendingLocationCandidates ?? [];
    const pendingLocationCandidateRecordIds = new Set(pendingLocationCandidates.map(locationCandidateRecordId));
    for (const row of await this.list('location-candidates', { workspaceId: this.workspaceId, chatKey: this.chatKey, status: 'pending' })) {
      const locationRef = String((row.value as Record<string, unknown>).locationRef ?? '');
      if (locationRef && confirmedLocationIds.has(locationRef) && !pendingLocationCandidateRecordIds.has(row.recordId)) {
        remove('location-candidates', row);
      }
    }
    // Candidates absent from this turn remain pending; only candidates whose
    // bound owner/location is now confirmed are removed automatically.
    for (const value of commit.episodes) await add('episodes', value);
    for (const value of commit.observations) await add('observations', value);
    for (const value of commit.facts) await add('facts', value);
    // Reconciliation can submit a superseded predecessor and its replacement
    // in the same Capture. Select the head from both the current persisted head
    // and this batch's overrides. This is essential when a low-confidence
    // proposal is stored as Pending: it must not replace an existing Active
    // state merely because it was the only fact written by this transaction.
    const factsByTouchedSlot = new Map<string, MemoryFact[]>();
    for (const fact of commit.facts) {
      // Occurrences/declarations form an event stream. They can share a
      // subject/predicate without representing one mutable current value, so
      // no single FactHead is valid for these kinds.
      if (isAppendOnlyFactKind(fact.kind)) continue;
      const slotKey = fact.slotKey ?? `${fact.subjectKey}::${fact.predicateKey}`;
      const rows = factsByTouchedSlot.get(slotKey) ?? [];
      rows.push(fact);
      factsByTouchedSlot.set(slotKey, rows);
    }
    for (const [slotKey, batchFacts] of factsByTouchedSlot) {
      const headId = `fact-head:${encodeURIComponent(this.chatKey)}:${encodeURIComponent(slotKey)}`;
      const currentHead = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'fact-heads', recordId: headId });
      const currentHeadFactId = String((currentHead?.value as Record<string, unknown> | undefined)?.factId ?? '');
      const currentHeadFact = currentHeadFactId
        ? await this.workspace.get({ workspaceId: this.workspaceId, collection: 'facts', recordId: currentHeadFactId })
        : null;
      const candidates = new Map<string, MemoryFact>();
      if (currentHeadFact?.value) candidates.set(currentHeadFactId, currentHeadFact.value as unknown as MemoryFact);
      // Batch values override the pre-transaction snapshot of the same fact.
      for (const fact of batchFacts) candidates.set(fact.id, fact);
      const selected = [...candidates.values()]
        .filter(fact => !isAppendOnlyFactKind(fact.kind)
          && (fact.status === 'active' || fact.status === 'pending'))
        .sort((left, right) => Number(right.status === 'active') - Number(left.status === 'active')
          || right.freshestEvidenceAt - left.freshestEvidenceAt
          || right.updatedAt - left.updatedAt
          || left.id.localeCompare(right.id))[0];
      if (selected) {
        await add('fact-heads', {
          id: headId,
          workspaceId: this.workspaceId,
          chatKey: this.chatKey,
          slotKey,
          factId: selected.id,
          updatedAt: selected.updatedAt,
        });
      } else if (currentHead) {
        remove('fact-heads', currentHead);
      }
    }
    for (const value of commit.evidence) await add('evidence', value);
    // Traces are append/merge semantics: a later capture must retain prior
    // observation provenance and advance the revision instead of replacing it.
    for (const value of commit.traces) {
      const before = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'memory-traces', recordId: value.id });
      if (before?.value) {
        const previous = before.value as unknown as ActorMemoryTrace & { chatKey?: string };
        const incoming = value as ActorMemoryTrace & { chatKey?: string };
        const novelObservation = (incoming.sourceObservationIds ?? []).some(id => !(previous.sourceObservationIds ?? []).includes(id));
        const mergedUpdatedAt = Date.now();
        const knowledgeMode = KNOWLEDGE_MODE_RANK[incoming.knowledgeMode] >= KNOWLEDGE_MODE_RANK[previous.knowledgeMode]
          ? incoming.knowledgeMode
          : previous.knowledgeMode;
        const privacy = PRIVACY_RANK[incoming.privacy] >= PRIVACY_RANK[previous.privacy]
          ? incoming.privacy
          : previous.privacy;
        const merged = {
          ...previous,
          ...incoming,
          sourceObservationIds: [...new Set([...(previous.sourceObservationIds ?? []), ...(incoming.sourceObservationIds ?? [])])],
          strength: Math.max(previous.strength ?? 0, incoming.strength ?? 0),
          clarity: Math.max(previous.clarity ?? 0, incoming.clarity ?? 0),
          beliefConfidence: Math.max(previous.beliefConfidence ?? 0, incoming.beliefConfidence ?? 0),
          emotionalSalience: Math.max(previous.emotionalSalience ?? 0, incoming.emotionalSalience ?? 0),
          knowledgeMode,
          privacy,
          // A genuinely new observation is a rehearsal signal. Repeating the
          // same source must remain idempotent and cannot self-reinforce.
          rehearsalCount: Math.max(previous.rehearsalCount ?? 0, incoming.rehearsalCount ?? 0) + (novelObservation ? 1 : 0),
          ...(novelObservation || previous.lastRehearsedAt !== undefined || incoming.lastRehearsedAt !== undefined
            ? { lastRehearsedAt: novelObservation ? mergedUpdatedAt : Math.max(previous.lastRehearsedAt ?? 0, incoming.lastRehearsedAt ?? 0) }
            : {}),
          traceRevision: Math.max(previous.traceRevision ?? 0, incoming.traceRevision ?? 0) + 1,
          createdAt: previous.createdAt ?? incoming.createdAt,
          updatedAt: mergedUpdatedAt,
          chatKey: incoming.chatKey ?? previous.chatKey ?? this.chatKey,
        };
        await add('memory-traces', merged);
      } else {
        await add('memory-traces', value);
      }
    }
    for (const value of commit.sceneCasts ?? []) await add('scene-casts', value);
    const captureJobId = commit.captureJobId ?? `capture-job:${auditId}`;
    const audit: ChangeAudit = {
      id: auditId,
      workspaceId: this.workspaceId,
      chatKey: this.chatKey,
      kind: 'capture-change-set-v0',
      createdAt: Date.now(),
      entries,
      metadata: asPlain({
        captureJobId,
        transactionKey,
        baseTransactionKey,
        ...(parentChangeSetId ? { parentChangeSetId, attachmentKind: 'capture-repair-v0' } : {}),
        ...(retryAttempt > 0 ? { retryAttempt, retriedTransactionKey: baseTransactionKey } : {}),
        sourceRefs: [...commit.envelope.sourceRefs],
        outcome: commit.outcome ?? 'complete',
        rejections: [...(commit.rejections ?? [])],
        accepted: {
          actors: commit.envelope.actorCandidates.length,
          locations: commit.envelope.locationCandidates.length,
          episodes: commit.episodes.length,
          observations: commit.observations.length,
          facts: commit.facts.length,
        },
        registrySnapshot: {
          owners: commit.owners.length,
          locations: commit.locations.length,
        },
      }),
    };
    operations.push({ action: 'upsert', collection: 'change-audits', recordId: audit.id, value: asPlain(audit) });
    await this.workspace.transaction({ workspaceId: this.workspaceId, idempotencyKey: transactionKey, operations });
    return audit;
  }

  private async rollbackOrder(auditId: string): Promise<ChangeAudit[]> {
    const rootRecord = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'change-audits', recordId: auditId });
    const root = rootRecord?.value as unknown as ChangeAudit | undefined;
    const allowedKinds = new Set<ChangeAudit['kind']>(['capture-change-set-v0', 'derived-change-set-v0', 'actor-registry-change-set-v0', 'dream-change-set-v0']);
    if (!root || root.workspaceId !== this.workspaceId || root.chatKey !== this.chatKey || !allowedKinds.has(root.kind)) {
      throw new Error('找不到当前聊天可回滚的多角色 ChangeSet。');
    }
    if (root.rolledBackAt) return [];
    const all = (await this.listChangeAudits())
      .map(record => record as unknown as ChangeAudit)
      .filter(record => record.workspaceId === this.workspaceId && record.chatKey === this.chatKey && allowedKinds.has(record.kind));
    const byId = new Map(all.map(record => [record.id, record]));
    byId.set(root.id, root);
    const childrenByParent = new Map<string, ChangeAudit[]>();
    for (const record of byId.values()) {
      const metadata = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
        ? record.metadata as Record<string, unknown>
        : undefined;
      const parentId = String(metadata?.parentChangeSetId ?? '');
      if (!parentId || parentId === record.id) continue;
      const children = childrenByParent.get(parentId) ?? [];
      children.push(record);
      childrenByParent.set(parentId, children);
    }
    for (const children of childrenByParent.values()) {
      children.sort((left, right) => Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0) || right.id.localeCompare(left.id));
    }
    const rootMetadata = root.metadata && typeof root.metadata === 'object' && !Array.isArray(root.metadata)
      ? root.metadata as Record<string, unknown>
      : {};
    const rootParentId = String(rootMetadata.parentChangeSetId ?? '');
    const captureJobId = String(rootMetadata.captureJobId ?? '');
    if (root.kind === 'capture-change-set-v0' && !rootParentId && captureJobId) {
      const rootOrdinal = captureBatchOrdinal(root);
      const newer = [...byId.values()]
        .filter(candidate => candidate.id !== root.id
          && candidate.kind === 'capture-change-set-v0'
          && !candidate.rolledBackAt)
        .filter(candidate => {
          const metadata = candidate.metadata && typeof candidate.metadata === 'object' && !Array.isArray(candidate.metadata)
            ? candidate.metadata as Record<string, unknown>
            : {};
          return !String(metadata.parentChangeSetId ?? '')
            && String(metadata.captureJobId ?? '') === captureJobId;
        })
        .filter(candidate => {
          const candidateOrdinal = captureBatchOrdinal(candidate);
          if (rootOrdinal !== undefined && candidateOrdinal !== undefined) return candidateOrdinal > rootOrdinal;
          return candidate.createdAt > root.createdAt
            || (candidate.createdAt === root.createdAt && candidate.id > root.id);
        })
        .sort((left, right) => (captureBatchOrdinal(right) ?? Number(right.createdAt ?? 0))
          - (captureBatchOrdinal(left) ?? Number(left.createdAt ?? 0)))[0];
      if (newer) {
        throw Object.assign(new Error('同一初始化任务存在更新的未回滚批次，请按从新到旧的顺序回滚。'), {
          code: 'CHANGESET_ROLLBACK_ORDER_REQUIRED',
          auditId: root.id,
          newerAuditId: newer.id,
        });
      }
    }
    const order: ChangeAudit[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) throw Object.assign(new Error('ChangeSet 父子关系存在循环，无法安全回滚。'), { code: 'CHANGESET_PARENT_CYCLE' });
      visiting.add(id);
      for (const child of childrenByParent.get(id) ?? []) visit(child.id);
      visiting.delete(id);
      visited.add(id);
      const audit = byId.get(id);
      if (audit && !audit.rolledBackAt) order.push(audit);
    };
    visit(root.id);
    return order;
  }

  private async preflightRollback(order: readonly ChangeAudit[]): Promise<void> {
    const simulated = new Map<string, PlainData | undefined>();
    for (const audit of order) {
      for (const entry of [...audit.entries].reverse()) {
        const key = `${entry.collection}:${entry.recordId}`;
        let currentValue: PlainData | undefined;
        if (simulated.has(key)) currentValue = simulated.get(key);
        else {
          const current = await this.workspace.get({ workspaceId: this.workspaceId, collection: entry.collection, recordId: entry.recordId });
          currentValue = current?.value as PlainData | undefined;
        }
        if (!samePlain(currentValue, entry.after)) {
          throw Object.assign(new Error(`ChangeSet 回滚冲突：${entry.collection}/${entry.recordId} 已被后续操作修改。请先回滚较新的关联记录。`), {
            code: 'CHANGESET_ROLLBACK_CONFLICT',
            collection: entry.collection,
            recordId: entry.recordId,
            auditId: audit.id,
          });
        }
        simulated.set(key, entry.before);
      }
    }
  }

  private async rollbackSingleChangeSet(audit: ChangeAudit): Promise<string[]> {
    const currentByRecord = new Map<string, WorkspaceRecord | null>();
    for (const entry of audit.entries) {
      const current = await this.workspace.get({ workspaceId: this.workspaceId, collection: entry.collection, recordId: entry.recordId });
      currentByRecord.set(`${entry.collection}:${entry.recordId}`, current);
      const currentValue = current?.value as PlainData | undefined;
      if (!samePlain(currentValue, entry.after)) {
        throw Object.assign(new Error(`ChangeSet 回滚冲突：${entry.collection}/${entry.recordId} 已在预检后被修改。`), {
          code: 'CHANGESET_ROLLBACK_CONFLICT',
          collection: entry.collection,
          recordId: entry.recordId,
          auditId: audit.id,
        });
      }
    }
    const operations: WorkspaceTransactionOperation[] = [];
    const auditedKeys = new Set(audit.entries.map(entry => `${entry.collection}:${entry.recordId}`));
    const affectedFactIds = new Set(audit.entries
      .filter(entry => entry.collection === 'facts')
      .map(entry => entry.recordId));
    const captureTraceIds = new Set(audit.kind === 'capture-change-set-v0'
      ? audit.entries.filter(entry => entry.collection === 'memory-traces' && entry.after !== undefined).map(entry => entry.recordId)
      : []);
    for (const entry of [...audit.entries].reverse()) {
      const current = currentByRecord.get(`${entry.collection}:${entry.recordId}`) ?? null;
      if (entry.before === undefined) {
        if (current) operations.push({ action: 'delete', collection: entry.collection, recordId: entry.recordId, expectedVersion: current.version });
      }
      else {
        const restored = entry.collection === 'capture-jobs' && typeof entry.before === 'object'
          ? {
            ...(entry.before as Record<string, unknown>),
            status: ['running', 'completed'].includes(String((entry.before as Record<string, unknown>).status ?? '')) ? 'paused' : (entry.before as Record<string, unknown>).status,
            updatedAt: Date.now(),
          }
          : entry.before;
        operations.push({ action: 'upsert', collection: entry.collection, recordId: entry.recordId, value: asPlain(restored), expectedVersion: current?.version ?? 0 });
      }
    }
    // Job-final projections may be rebuilt from all batches and therefore can
    // be attached to a newer Capture audit. Invalidate by objective fact/trace
    // dependency as well as sourceChangeSetId so rolling back an earlier batch
    // cannot leave stale details, links, vectors, graph edges or profiles.
    const invalidationEntries: ChangeEntry[] = [];
    await this.addDerivedInvalidations(affectedFactIds, captureTraceIds, invalidationEntries, operations);
    // Derived records carry their parent ChangeSet id. Remove them in the same
    // transaction so a Capture/Dream rollback cannot leave stale details,
    // links, profiles, vectors, graph nodes or exposures behind.
    const invalidatedDreamJobIds = new Set<string>();
    const queuedDeleteKeys = new Set(operations
      .filter(operation => operation.action === 'delete')
      .map(operation => `${operation.collection}:${operation.recordId}`));
    const derivedCollections = ['memory-details', 'memory-links', 'vector-index', 'graph-nodes', 'graph-edges', 'profiles', 'profile-claims', 'relationship-claims', 'recall-exposures', 'dream-jobs', 'dream-audits', 'dream-narratives'] as const;
    for (const collection of derivedCollections) {
      const records = await this.list(collection, { workspaceId: this.workspaceId });
      for (const record of records) {
        const value = record.value as Record<string, unknown>;
        const traceExposureCreatedDuringCapture = collection === 'recall-exposures'
          && captureTraceIds.has(String(value.traceId ?? ''))
          && Number(value.createdAt ?? 0) >= audit.createdAt;
        const dreamUsesAffectedTrace = collection === 'dream-jobs'
          && Array.isArray(value.traceIds)
          && value.traceIds.some(traceId => captureTraceIds.has(String(traceId)));
        const belongsToInvalidDream = (collection === 'dream-audits' || collection === 'dream-narratives')
          && invalidatedDreamJobIds.has(String(value.jobId ?? ''));
        const shouldDelete = value.sourceChangeSetId === audit.id
          || value.parentChangeSetId === audit.id
          || traceExposureCreatedDuringCapture
          || dreamUsesAffectedTrace
          || belongsToInvalidDream;
        const recordKey = `${collection}:${record.recordId}`;
        if (shouldDelete
          && !auditedKeys.has(recordKey)
          && !queuedDeleteKeys.has(recordKey)) {
          const current = await this.workspace.get({ workspaceId: this.workspaceId, collection, recordId: record.recordId });
          operations.push({ action: 'delete', collection, recordId: record.recordId, ...(current ? { expectedVersion: current.version } : {}) });
          queuedDeleteKeys.add(recordKey);
          if (collection === 'dream-jobs') invalidatedDreamJobIds.add(record.recordId);
        }
      }
    }
    const currentAudit = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'change-audits', recordId: audit.id });
    if (!currentAudit) throw Object.assign(new Error('ChangeSet 审计在回滚过程中消失。'), { code: 'CHANGESET_AUDIT_MISSING', auditId: audit.id });
    operations.push({
      action: 'upsert',
      collection: 'change-audits',
      recordId: audit.id,
      value: asPlain({ ...audit, rolledBackAt: Date.now() }),
      expectedVersion: currentAudit.version,
    });
    await this.workspace.transaction({ workspaceId: this.workspaceId, idempotencyKey: `rollback:${audit.id}`, operations });
    // A rollback may restore an existing fact as well as delete a newly
    // captured one. In both cases the external vector must be invalidated;
    // callers that need the restored fact indexed can enqueue a rebuild after
    // this transaction completes.
    return [...affectedFactIds];
  }

  async rollbackChangeSet(auditId: string): Promise<string[]> {
    const order = await this.rollbackOrder(auditId);
    if (order.length === 0) return [];
    // Validate the whole child-first rollback virtually before mutating any
    // record. This avoids the previous partial state where repair/derived
    // children were already undone and a parent conflict was discovered later.
    await this.preflightRollback(order);
    const invalidatedFactIds = new Set<string>();
    for (const audit of order) {
      for (const factId of await this.rollbackSingleChangeSet(audit)) invalidatedFactIds.add(factId);
    }
    const affected = [...invalidatedFactIds];
    await this.deleteFactVectors(affected);
    return affected;
  }

  async upsertDerived(collection: 'profiles' | 'profile-claims' | 'relationship-claims' | 'memory-details' | 'memory-links' | 'vector-index' | 'graph-nodes' | 'graph-edges' | 'recall-exposures' | 'dream-jobs' | 'dream-audits' | 'dream-narratives', records: readonly Record<string, unknown>[]): Promise<void> {
    if (records.length === 0) return;
    const operations: WorkspaceTransactionOperation[] = [];
    for (const record of records) {
      const recordId = String(record.id ?? '');
      if (!recordId) throw new Error(`派生记录缺少 id：${collection}`);
      if (record.workspaceId !== undefined && String(record.workspaceId) !== this.workspaceId) throw new Error(`派生记录不属于当前工作区：${collection}`);
      if (record.chatKey !== undefined && String(record.chatKey) !== this.chatKey) throw new Error(`派生记录不属于当前聊天：${collection}`);
      const current = await this.workspace.get({ workspaceId: this.workspaceId, collection, recordId });
      const persisted = { ...record, workspaceId: this.workspaceId, chatKey: this.chatKey };
      operations.push({ action: 'upsert', collection, recordId, value: asPlain(persisted), expectedVersion: current?.version ?? 0 });
    }
    await this.workspace.transaction({ workspaceId: this.workspaceId, idempotencyKey: `derived:${collection}:${crypto.randomUUID()}`, operations });
  }

  async upsertDerivedWithAudit(
    recordsByCollection: readonly { readonly collection: 'profiles' | 'profile-claims' | 'relationship-claims' | 'memory-details' | 'memory-links' | 'vector-index' | 'graph-nodes' | 'graph-edges' | 'recall-exposures' | 'dream-jobs' | 'dream-audits' | 'dream-narratives'; readonly records: readonly Record<string, unknown>[] }[],
    kind: ChangeAudit['kind'] = 'derived-change-set-v0',
    metadata?: Record<string, unknown>,
  ): Promise<ChangeAudit> {
    const auditId = `change-audit:${crypto.randomUUID()}`;
    const entries: ChangeEntry[] = [];
    const operations: WorkspaceTransactionOperation[] = [];
    for (const group of recordsByCollection) {
      for (const record of group.records) {
        const recordId = String(record.id ?? '');
        if (!recordId) throw new Error(`派生记录缺少 id：${group.collection}`);
        if (record.workspaceId !== undefined && String(record.workspaceId) !== this.workspaceId) throw new Error(`派生记录不属于当前工作区：${group.collection}`);
        if (record.chatKey !== undefined && String(record.chatKey) !== this.chatKey) throw new Error(`派生记录不属于当前聊天：${group.collection}`);
        const before = await this.workspace.get({ workspaceId: this.workspaceId, collection: group.collection, recordId });
        const persisted = { ...record, workspaceId: this.workspaceId, chatKey: this.chatKey, sourceChangeSetId: record.sourceChangeSetId ?? auditId };
        entries.push({ collection: group.collection, recordId, ...(before ? { before: before.value } : {}), after: asPlain(persisted) });
        operations.push({ action: 'upsert', collection: group.collection, recordId, value: asPlain(persisted), expectedVersion: before?.version ?? 0 });
      }
    }
    const audit: ChangeAudit = { id: auditId, workspaceId: this.workspaceId, chatKey: this.chatKey, kind, createdAt: Date.now(), entries, ...(metadata ? { metadata: asPlain(metadata) } : {}) };
    operations.push({ action: 'upsert', collection: 'change-audits', recordId: audit.id, value: asPlain(audit) });
    await this.workspace.transaction({ workspaceId: this.workspaceId, idempotencyKey: audit.id, operations });
    return audit;
  }

  /** Add derived writes to an existing Capture ChangeSet so one Undo restores
   * both source records and their projections. */
  async upsertDerivedForChangeSet(
    auditId: string,
    recordsByCollection: readonly { readonly collection: 'profiles' | 'profile-claims' | 'relationship-claims' | 'memory-details' | 'memory-links' | 'vector-index' | 'graph-nodes' | 'graph-edges' | 'recall-exposures' | 'dream-jobs' | 'dream-audits' | 'dream-narratives'; readonly records: readonly Record<string, unknown>[] }[],
  ): Promise<void> {
    const auditRecord = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'change-audits', recordId: auditId });
    const audit = auditRecord?.value as unknown as ChangeAudit | undefined;
    if (!audit || audit.workspaceId !== this.workspaceId || audit.chatKey !== this.chatKey) throw new Error('找不到当前聊天要附加派生记录的 ChangeSet。');
    if (audit.rolledBackAt) throw new Error('不能向已回滚的 Capture ChangeSet 附加派生记录。');

    // Do not append thousands of full before/after snapshots to the parent
    // audit. Workspace values are capped at 1 MiB and a full initialization can
    // easily produce more than two thousand projections. Bounded child audits
    // retain exact rollback snapshots while metadata links them to the parent.
    const flattened = new Map<string, {
      collection: 'profiles' | 'profile-claims' | 'relationship-claims' | 'memory-details' | 'memory-links' | 'vector-index' | 'graph-nodes' | 'graph-edges' | 'recall-exposures' | 'dream-jobs' | 'dream-audits' | 'dream-narratives';
      record: Record<string, unknown>;
    }>();
    for (const group of recordsByCollection) {
      for (const record of group.records) {
        const recordId = String(record.id ?? '');
        if (!recordId) throw new Error(`派生记录缺少 id：${group.collection}`);
        if (record.workspaceId !== undefined && String(record.workspaceId) !== this.workspaceId) throw new Error(`派生记录不属于当前工作区：${group.collection}`);
        if (record.chatKey !== undefined && String(record.chatKey) !== this.chatKey) throw new Error(`派生记录不属于当前聊天：${group.collection}`);
        flattened.set(`${group.collection}:${recordId}`, {
          collection: group.collection,
          record: {
            ...record,
            workspaceId: this.workspaceId,
            chatKey: this.chatKey,
            sourceChangeSetId: auditId,
            parentChangeSetId: auditId,
          },
        });
      }
    }
    const rows = [...flattened.values()];
    const chunkSize = 128;
    const chunkCount = Math.ceil(rows.length / chunkSize);
    for (let offset = 0; offset < rows.length; offset += chunkSize) {
      const chunk = rows.slice(offset, offset + chunkSize);
      const grouped = new Map<typeof chunk[number]['collection'], Record<string, unknown>[]>();
      for (const item of chunk) {
        const records = grouped.get(item.collection) ?? [];
        records.push(item.record);
        grouped.set(item.collection, records);
      }
      await this.upsertDerivedWithAudit(
        [...grouped].map(([collection, records]) => ({ collection, records })),
        'derived-change-set-v0',
        {
          parentChangeSetId: auditId,
          attachmentKind: 'capture-derived-chunk-v0',
          chunkIndex: Math.trunc(offset / chunkSize),
          chunkCount,
        },
      );
    }
  }

  async upsertActorRegistryState(
    owners: readonly MemoryOwner[],
    aliases: readonly ActorAlias[],
    metadata?: Record<string, unknown>,
    migration?: { readonly fromOwnerId: string; readonly toOwnerId: string },
    pendingCandidates: readonly ActorCandidate[] = [],
  ): Promise<ChangeAudit> {
    const entries: ChangeEntry[] = [];
    const operations: WorkspaceTransactionOperation[] = [];
    const groups: readonly [string, readonly Persistable[]][] = [['actors', owners], ['actor-aliases', aliases]];
    for (const [collection, values] of groups) {
      for (const value of values) {
        const recordId = String(value.id);
        const before = await this.workspace.get({ workspaceId: this.workspaceId, collection, recordId });
        entries.push({ collection, recordId, ...(before ? { before: before.value } : {}), after: asPlain(value) });
        operations.push({ action: 'upsert', collection, recordId, value: asPlain(value), expectedVersion: before?.version ?? 0 });
      }
    }
    const existingOwners = await this.list('actors', { workspaceId: this.workspaceId });
    const desiredOwnerIds = new Set(owners.map(owner => owner.id));
    for (const record of existingOwners) {
      if (!desiredOwnerIds.has(record.recordId)) {
        entries.push({ collection: 'actors', recordId: record.recordId, before: record.value });
        operations.push({ action: 'delete', collection: 'actors', recordId: record.recordId, expectedVersion: record.version });
      }
    }
    const existingAliases = await this.list('actor-aliases', { workspaceId: this.workspaceId });
    const desiredAliasIds = new Set(aliases.map(alias => alias.id));
    for (const record of existingAliases) {
      if (!desiredAliasIds.has(record.recordId)) {
        entries.push({ collection: 'actor-aliases', recordId: record.recordId, before: record.value });
        operations.push({ action: 'delete', collection: 'actor-aliases', recordId: record.recordId, expectedVersion: record.version });
      }
    }
    for (const candidate of pendingCandidates) {
      const recordId = actorCandidateRecordId(candidate);
      const persisted = { ...candidate, id: recordId, workspaceId: this.workspaceId, chatKey: this.chatKey, status: candidate.status ?? 'pending', updatedAt: Date.now() };
      const before = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'actor-candidates', recordId });
      entries.push({ collection: 'actor-candidates', recordId, ...(before ? { before: before.value } : {}), after: asPlain(persisted) });
      operations.push({ action: 'upsert', collection: 'actor-candidates', recordId, value: asPlain(persisted), expectedVersion: before?.version ?? 0 });
    }
    const existingCandidates = await this.list('actor-candidates', { workspaceId: this.workspaceId, chatKey: this.chatKey });
    const desiredCandidateIds = new Set(pendingCandidates.map(actorCandidateRecordId));
    for (const record of existingCandidates) {
      if (!desiredCandidateIds.has(record.recordId)) {
        entries.push({ collection: 'actor-candidates', recordId: record.recordId, before: record.value });
        operations.push({ action: 'delete', collection: 'actor-candidates', recordId: record.recordId, expectedVersion: record.version });
      }
    }
    if (migration) {
      if (migration.fromOwnerId === migration.toOwnerId) throw new Error('人物迁移源和目标不能相同。');
      const traceIdReplacements = new Map<string, string>();
      for (const trace of await this.listTraces(migration.fromOwnerId)) {
        const current = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'memory-traces', recordId: trace.id });
        const next = { ...trace, id: `trace:${migration.toOwnerId}:${trace.factId}`, ownerId: migration.toOwnerId, chatKey: trace.chatKey ?? this.chatKey, traceRevision: trace.traceRevision + 1, updatedAt: Date.now() };
        const target = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'memory-traces', recordId: next.id });
        const targetValue = target?.value as unknown as ActorMemoryTrace | undefined;
        if (targetValue?.chatKey && targetValue.chatKey !== this.chatKey) throw new Error('人物迁移目标 Trace 不属于当前聊天。');
        const merged = targetValue ? {
          ...targetValue,
          ...next,
          knowledgeMode: KNOWLEDGE_MODE_RANK[next.knowledgeMode] >= KNOWLEDGE_MODE_RANK[targetValue.knowledgeMode] ? next.knowledgeMode : targetValue.knowledgeMode,
          privacy: PRIVACY_RANK[next.privacy] >= PRIVACY_RANK[targetValue.privacy] ? next.privacy : targetValue.privacy,
          sourceObservationIds: [...new Set([...(targetValue.sourceObservationIds ?? []), ...(trace.sourceObservationIds ?? [])])],
          strength: Math.max(targetValue.strength ?? 0, trace.strength ?? 0),
          clarity: Math.max(targetValue.clarity ?? 0, trace.clarity ?? 0),
          beliefConfidence: Math.max(targetValue.beliefConfidence ?? 0, trace.beliefConfidence ?? 0),
          emotionalSalience: Math.max(targetValue.emotionalSalience ?? 0, trace.emotionalSalience ?? 0),
          rehearsalCount: Math.max(targetValue.rehearsalCount ?? 0, trace.rehearsalCount ?? 0),
          ...(targetValue.lastRehearsedAt !== undefined || trace.lastRehearsedAt !== undefined ? { lastRehearsedAt: Math.max(targetValue.lastRehearsedAt ?? 0, trace.lastRehearsedAt ?? 0) } : {}),
          traceRevision: Math.max(targetValue.traceRevision ?? 0, trace.traceRevision ?? 0) + 1,
          createdAt: Math.min(targetValue.createdAt ?? trace.createdAt, trace.createdAt),
          updatedAt: Date.now(),
        } : next;
        entries.push({ collection: 'memory-traces', recordId: trace.id, ...(current ? { before: current.value } : {}) });
        entries.push({ collection: 'memory-traces', recordId: next.id, ...(target ? { before: target.value } : {}), after: asPlain(merged) });
        operations.push({ action: 'delete', collection: 'memory-traces', recordId: trace.id, ...(current ? { expectedVersion: current.version } : {}) });
        operations.push({ action: 'upsert', collection: 'memory-traces', recordId: next.id, value: asPlain(merged), expectedVersion: target?.version ?? 0 });
        traceIdReplacements.set(trace.id, next.id);
      }

      const replacements = new Map<string, string>([
        [migration.fromOwnerId, migration.toOwnerId],
        [encodeURIComponent(migration.fromOwnerId), encodeURIComponent(migration.toOwnerId)],
        ...traceIdReplacements.entries(),
      ]);
      const queueRecordMigration = async (collection: string, record: WorkspaceRecord): Promise<void> => {
        const migratedValue = remapPlainData(record.value, replacements);
        const migratedRecordId = replaceMigrationIdentifiers(record.recordId, replacements);
        if (migratedRecordId === record.recordId && JSON.stringify(migratedValue) === JSON.stringify(record.value)) return;
        if (migratedRecordId === record.recordId) {
          entries.push({ collection, recordId: record.recordId, before: record.value, after: migratedValue });
          operations.push({ action: 'upsert', collection, recordId: record.recordId, value: migratedValue, expectedVersion: record.version });
          return;
        }
        const target = await this.workspace.get({ workspaceId: this.workspaceId, collection, recordId: migratedRecordId });
        const targetChatKey = target?.value && typeof target.value === 'object' && !Array.isArray(target.value)
          ? String((target.value as Record<string, PlainData>).chatKey ?? '')
          : '';
        if (targetChatKey && targetChatKey !== this.chatKey) throw new Error(`人物迁移目标记录不属于当前聊天：${collection}/${migratedRecordId}`);
        const mergedValue = target ? mergeMigratedPlainData(target.value, migratedValue) : migratedValue;
        entries.push({ collection, recordId: record.recordId, before: record.value });
        entries.push({ collection, recordId: migratedRecordId, ...(target ? { before: target.value } : {}), after: mergedValue });
        operations.push({ action: 'delete', collection, recordId: record.recordId, expectedVersion: record.version });
        operations.push({ action: 'upsert', collection, recordId: migratedRecordId, value: mergedValue, expectedVersion: target?.version ?? 0 });
      };

      const episodeRecords = await this.list('episodes', { workspaceId: this.workspaceId, chatKey: this.chatKey });
      const episodeIds = new Set(episodeRecords.map(record => record.recordId));
      const observationRecords = (await this.list('observations', { workspaceId: this.workspaceId }))
        .filter(record => episodeIds.has(String((record.value as Record<string, PlainData>).episodeId ?? '')));
      const chatScopedCollections = [
        'facts', 'scene-casts', 'scene-states', 'scene-transitions', 'generation-cast-plans',
        'cast-plan-audits', 'recall-coverage-logs', 'memory-usage-logs', 'capture-jobs', 'change-audits',
        'memory-details', 'memory-links', 'vector-index', 'graph-nodes', 'graph-edges',
        'recall-exposures', 'dream-jobs', 'dream-audits', 'dream-narratives',
      ] as const;
      const workspaceScopedDerivedCollections = ['profiles', 'profile-claims', 'relationship-claims'] as const;
      for (const record of episodeRecords) await queueRecordMigration('episodes', record);
      for (const record of observationRecords) await queueRecordMigration('observations', record);
      for (const collection of chatScopedCollections) {
        if (this.unavailableOptionalCollections.has(collection)) continue;
        for (const record of await this.list(collection, { workspaceId: this.workspaceId, chatKey: this.chatKey })) {
          await queueRecordMigration(collection, record);
        }
      }
      for (const collection of workspaceScopedDerivedCollections) {
        const records = (await this.list(collection, { workspaceId: this.workspaceId }))
          .filter(record => String((record.value as Record<string, PlainData>).chatKey ?? '') === this.chatKey);
        for (const record of records) await queueRecordMigration(collection, record);
      }
    }
    const audit: ChangeAudit = { id: `change-audit:${crypto.randomUUID()}`, workspaceId: this.workspaceId, chatKey: this.chatKey, kind: 'actor-registry-change-set-v0', createdAt: Date.now(), entries, ...(metadata ? { metadata: asPlain(metadata) } : {}) };
    operations.push({ action: 'upsert', collection: 'change-audits', recordId: audit.id, value: asPlain(audit) });
    if (operations.length > ATOMIC_TRANSACTION_MAX_OPERATIONS) throw migrationTooLargeError(operations.length);
    await this.workspace.transaction({ workspaceId: this.workspaceId, idempotencyKey: audit.id, operations });
    return audit;
  }

  async clearCurrentChatData(): Promise<void> {
    const chatScopedCollections = ['actor-candidates', 'location-candidates', 'episodes', 'observations', 'facts', 'evidence', 'fact-heads', 'memory-traces', 'scene-casts', 'scene-states', 'scene-transitions', 'generation-cast-plans', 'cast-plan-audits', 'recall-coverage-logs', 'memory-usage-logs', 'capture-jobs', 'change-audits', 'memory-details', 'memory-links', 'vector-index', 'graph-nodes', 'graph-edges', 'recall-exposures', 'dream-jobs', 'dream-audits', 'dream-narratives'] as const;
    const operations: WorkspaceTransactionOperation[] = [];
    // Observations intentionally point at an Episode instead of duplicating
    // chat metadata. Resolve the current chat's episode ids before deleting so
    // a chat switch cannot leave orphaned observations behind.
    const episodeIds = new Set((await this.list('episodes', { workspaceId: this.workspaceId, chatKey: this.chatKey })).map(record => record.recordId));
    for (const collection of chatScopedCollections) {
      if (this.unavailableOptionalCollections.has(collection)) continue;
      const records = collection === 'observations'
        ? (await this.list(collection, { workspaceId: this.workspaceId })).filter(record => episodeIds.has(String((record.value as { episodeId?: unknown }).episodeId ?? '')))
        : await this.list(collection, { workspaceId: this.workspaceId, chatKey: this.chatKey });
      for (const record of records) operations.push({ action: 'delete', collection, recordId: record.recordId, expectedVersion: record.version });
    }
    if (operations.length > 0) await this.transactInBatches(operations, `multi-actor-clear:${this.chatKey}:${Date.now()}`);
    await this.workspace.vectorClear({ workspaceId: this.workspaceId, collection: 'facts', metadata: { chatKey: this.chatKey } });
  }

  async clearAllData(): Promise<void> {
    const operations: WorkspaceTransactionOperation[] = [];
    for (const collection of Object.keys(COLLECTIONS)) {
      if (this.unavailableOptionalCollections.has(collection)) continue;
      for (const record of await this.list(collection, { workspaceId: this.workspaceId })) {
        operations.push({ action: 'delete', collection, recordId: record.recordId, expectedVersion: record.version });
      }
    }
    if (operations.length > 0) await this.transactInBatches(operations, `multi-actor-clear-all:${this.workspaceId}:${Date.now()}`);
    await this.workspace.vectorClear({ workspaceId: this.workspaceId, collection: 'facts' });
  }

  async upsertTraces(records: readonly ActorMemoryTrace[]): Promise<void> {
    if (records.length === 0) return;
    const operations: WorkspaceTransactionOperation[] = [];
    for (const record of records) {
      const current = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'memory-traces', recordId: record.id });
      operations.push({
        action: 'upsert',
        collection: 'memory-traces',
        recordId: record.id,
        value: asPlain({ ...record, chatKey: record.chatKey ?? this.chatKey }),
        expectedVersion: current?.version ?? 0,
      });
    }
    await this.workspace.transaction({ workspaceId: this.workspaceId, idempotencyKey: `traces:${crypto.randomUUID()}`, operations });
  }
}

export type { CaptureCommit };
