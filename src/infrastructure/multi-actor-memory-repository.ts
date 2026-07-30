import { createSSHelperError, readSSHelperFailure, type PlainData, type WorkspacePort } from '@ss-helper/sdk';
import {
  memoryStoreFor,
  type MemoryStore,
  type StoreOperation,
  type StoreRecord as WorkspaceRecord,
} from './memory-store';
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
  type CaptureRepairQueueRecord,
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
import { MEMORY_WORKSPACE_COLLECTIONS } from './memory-workspace-schema';
import type { MemoryPage, MemoryPageRequest } from '../ui/memory-page';

const COLLECTIONS = MEMORY_WORKSPACE_COLLECTIONS;
const REPAIRABLE_REJECTION_CODES = new Set<AutomaticIngestRejection['code']>([
  'schema_validation_failed',
  'entity_ref_unsupported',
  'invalid_reference',
  'excerpt_mismatch',
  'dependency_invalid',
]);

function isRepairCaptureAudit(metadata: Record<string, unknown>, captureJobId: string): boolean {
  const baseTransactionKey = String(metadata.baseTransactionKey ?? metadata.transactionKey ?? '');
  return metadata.capturePhase === 'repair'
    || baseTransactionKey.startsWith(`capture:${captureJobId}:repair:`);
}

function repairCollection(item: AutomaticIngestRejection): CaptureRepairQueueRecord['collection'] {
  return item.recordType === 'actor' ? 'actorCandidates'
    : item.recordType === 'location' ? 'locationCandidates'
      : item.recordType === 'episode' ? 'episodes'
        : item.recordType === 'claim' ? 'claims'
          : 'batch';
}

function repairCollectionRank(collection: CaptureRepairQueueRecord['collection']): number {
  return ({ actorCandidates: 0, locationCandidates: 1, episodes: 2, claims: 3, batch: 4 })[collection];
}

function repairDependencyBlocker(
  record: CaptureRepairQueueRecord,
  queue: readonly CaptureRepairQueueRecord[],
): CaptureRepairQueueRecord | undefined {
  const sources = new Set([...record.sourceRefs, ...record.fallbackSourceRefs]);
  return queue.find(candidate =>
    candidate.id !== record.id
    && repairCollectionRank(candidate.collection) < repairCollectionRank(record.collection)
    && (candidate.status === 'queued' || candidate.status === 'running' || candidate.status === 'unresolved')
    && [...candidate.sourceRefs, ...candidate.fallbackSourceRefs].some(sourceRef => sources.has(sourceRef)));
}

function rejectionIssue(item: AutomaticIngestRejection): CaptureRepairQueueRecord['issues'] {
  if (item.issues?.length) return item.issues.map(issue => ({ ...issue }));
  const expected = item.code === 'excerpt_mismatch' ? 'a source-owned evidenceSpanId'
    : item.code === 'dependency_invalid' ? 'an existing optional episode reference or empty string'
      : item.code === 'schema_validation_failed' ? item.message
        : 'a source-supported prompt-local reference';
  return [{
    path: item.fieldPath ?? '$',
    keyword: item.code === 'schema_validation_failed' ? 'schema' : item.code,
    expected,
  }];
}

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

function isWorkspaceConflict(error: unknown): boolean {
  return readSSHelperFailure(error)?.reasonCode === 'WORKSPACE_CONFLICT';
}

const VOLATILE_CAPTURE_FIELDS = new Set(['createdAt', 'updatedAt', 'capturedAt']);

function captureSemanticPlain(value: PlainData): PlainData {
  if (Array.isArray(value)) return value.map(captureSemanticPlain);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !VOLATILE_CAPTURE_FIELDS.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, captureSemanticPlain(item)]));
  }
  return value;
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
  /** Distinguishes original extraction audits from field-level repair audits. */
  readonly capturePhase?: 'capture' | 'repair';
  /** Existing v0 progress record to fold into the Capture ChangeSet. */
  readonly captureJobId?: string;
  /** Next durable checkpoint, committed atomically with this batch's facts. */
  readonly captureJob?: Record<string, unknown>;
  readonly idempotencyKey?: string;
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

function staleGenerationScopeError(): Error {
  return createSSHelperError('MEMORY_STALE_GENERATION_SCOPE', {
    stage: 'memory.repository.generation-scope',
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

function migrationTooLargeError(operationCount: number): Error {
  return createSSHelperError('INVALID_PAYLOAD', {
    stage: 'memory.repository.actor-migration',
    expected: `operations<=${ATOMIC_TRANSACTION_MAX_OPERATIONS};actual=${operationCount}`,
  });
}
interface ChangeEntry { collection: string; recordId: string; before?: PlainData; after?: PlainData; }
export interface ChangeAudit { id: string; workspaceId: string; chatKey: string; kind: 'capture-change-set-v0' | 'derived-change-set-v0' | 'actor-registry-change-set-v0' | 'dream-change-set-v0'; createdAt: number; entries: readonly ChangeEntry[]; metadata?: PlainData; rolledBackAt?: number; }

function manualFactId(chatKey: string): string { return `fact:${encodeURIComponent(chatKey)}:manual:${crypto.randomUUID()}`; }
function factHeadId(chatKey: string, slotKey: string): string { return `fact-head:${encodeURIComponent(chatKey)}:${encodeURIComponent(slotKey)}`; }

function plainDataIssue(value: unknown, path = '$', active = new Set<object>()): { path: string; reason: string } | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? null : { path, reason: 'NON_FINITE_NUMBER' };
  if (typeof value !== 'object') return { path, reason: typeof value === 'undefined' ? 'UNDEFINED' : 'UNSUPPORTED_TYPE' };
  if (active.has(value)) return { path, reason: 'CYCLE' };
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null && Object.getPrototypeOf(prototype) !== null) {
      return { path, reason: 'CUSTOM_INSTANCE' };
    }
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (descriptor.get || descriptor.set) return { path: `${path}.${key}`, reason: 'ACCESSOR' };
    }
  }
  active.add(value);
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value as Record<string, unknown>);
  for (const [key, item] of entries) {
    const issue = plainDataIssue(item, Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`, active);
    if (issue) {
      active.delete(value);
      return issue;
    }
  }
  active.delete(value);
  return null;
}

function asPlain(value: unknown): PlainData {
  const issue = plainDataIssue(value);
  if (issue) {
    const safePath = issue.path.replace(/[^a-zA-Z0-9_.[\]-]/gu, '_').slice(0, 160);
    throw createSSHelperError('PLAIN_DATA_BOUNDARY_INVALID', {
      stage: 'memory.persistence',
      path: safePath,
      expected: issue.reason,
    });
  }
  return structuredClone(value) as PlainData;
}

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
function rows(page: { records?: readonly WorkspaceRecord[] } | undefined): WorkspaceRecord[] { return [...(page?.records ?? [])]; }
function stableKey(value: string): string {
  return stableRecordHash(value);
}

const KNOWLEDGE_MODE_RANK: Readonly<Record<ActorMemoryTrace['knowledgeMode'], number>> = Object.freeze({ unknown: 0, suspected: 1, believed: 2, inferred: 3, heard: 4, experienced: 5, self_reported: 6, asserted: 7 });
const PRIVACY_RANK: Readonly<Record<ActorMemoryTrace['privacy'], number>> = Object.freeze({ public: 0, limited: 1, private: 2, secret: 3 });
const QUERY_PAGE_SIZE = 500;
const TRANSACTION_BATCH_SIZE = 500;
const ATOMIC_TRANSACTION_MAX_OPERATIONS = 5_000;

function paginationStalledError(collection: string): Error {
  return createSSHelperError('WORKSPACE_CONFLICT', {
    stage: 'memory.persistence.pagination',
    collection,
  });
}

/** New v0 persistence surface; it never reads or migrates the retired model. */
export class MultiActorMemoryRepository {
  private workspaceId = '';
  private chatKey = '';
  private readonly unavailableOptionalCollections = new Set<string>();
  private readonly store: MemoryStore;
  private derivedWriteTail: Promise<void> = Promise.resolve();
  private readonly repairQueueWriteTails = new Map<string, Promise<void>>();
  private readonly repairReconcileRuns = new Map<string, Promise<CaptureRepairQueueRecord[]>>();
  constructor(readonly workspace: WorkspacePort) {
    this.store = memoryStoreFor(workspace);
  }

  bind(workspaceId: string, chatKey: string): void { this.workspaceId = workspaceId.trim(); this.chatKey = chatKey.trim(); }
  get boundWorkspaceId(): string { return this.workspaceId; }
  get boundChatKey(): string { return this.chatKey; }

  async open(): Promise<void> {
    if (!this.workspaceId) throw createSSHelperError('MEMORY_CAPTURE_NOT_BOUND', { stage: 'memory.repository.open' });
    this.unavailableOptionalCollections.clear();
    await this.store.bind(
      this.workspaceId,
      Object.entries(COLLECTIONS).map(([name, indexes]) => ({ name, indexes })),
      { kind: 'memory-multi-actor-v0' },
    );
  }

  private async list(collection: string, filter?: Readonly<Record<string, PlainData>>): Promise<WorkspaceRecord[]> {
    if (this.unavailableOptionalCollections.has(collection)) return [];
    const records: WorkspaceRecord[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const page = await this.store.scan({ workspaceId: this.workspaceId, collection, filter, ...(cursor ? { cursor } : {}), limit: QUERY_PAGE_SIZE });
      records.push(...rows(page));
      const nextCursor = page.nextCursor ?? undefined;
      if (nextCursor !== undefined && seenCursors.has(nextCursor)) throw paginationStalledError(collection);
      if (nextCursor !== undefined) seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);
    return records;
  }

  private async transactInBatches(operations: readonly StoreOperation[], idempotencyPrefix: string): Promise<void> {
    const safePrefix = `memory-batch:${stableRecordHash(idempotencyPrefix)}`;
    for (let offset = 0; offset < operations.length; offset += TRANSACTION_BATCH_SIZE) {
      await this.store.apply({
        workspaceId: this.workspaceId,
        idempotencyKey: `${safePrefix}:${offset / TRANSACTION_BATCH_SIZE}`,
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
    const record = await this.store.read({ workspaceId: this.workspaceId, collection: 'scene-states', recordId: sceneStateRecordId(this.workspaceId, this.chatKey) });
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
    const current = await this.store.read({ workspaceId: this.workspaceId, collection: 'scene-states', recordId: state.id });
    const operations: StoreOperation[] = [{ action: 'upsert', collection: 'scene-states', recordId: state.id, value: asPlain(state), expectedVersion: current?.version ?? 0 }];
    if (transition && !this.unavailableOptionalCollections.has('scene-transitions')) {
      const existingTransition = await this.store.read({ workspaceId: this.workspaceId, collection: 'scene-transitions', recordId: transition.id });
      operations.push({ action: 'upsert', collection: 'scene-transitions', recordId: transition.id, value: asPlain(transition), expectedVersion: existingTransition?.version ?? 0 });
    }
    await this.store.apply({ workspaceId: this.workspaceId, idempotencyKey: `scene-state:${stableRecordHash(state.id)}:${state.revision}`, operations });
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

    const operations: StoreOperation[] = [];
    const queue = async (collection: string, recordId: string, value: Persistable): Promise<void> => {
      if (this.unavailableOptionalCollections.has(collection)) return;
      assertCurrent();
      const current = await this.store.read({ workspaceId: this.workspaceId, collection, recordId });
      assertCurrent();
      operations.push({ action: 'upsert', collection, recordId, value: asPlain(value), expectedVersion: current?.version ?? 0 });
    };
    await queue('scene-states', state.id, state);
    if (transition) await queue('scene-transitions', transition.id, transition);
    await queue('generation-cast-plans', plan.id, plan);
    await queue('recall-coverage-logs', coverage.id, coverage);
    assertCurrent();
    if (operations.length === 0) return;
    await this.store.apply({
      workspaceId: this.workspaceId,
      idempotencyKey: `generation-preparation:${stableRecordHash(plan.id)}`,
      operations,
    });
  }
  async saveGenerationCastPlan(plan: GenerationCastPlan): Promise<void> {
    if (this.unavailableOptionalCollections.has('generation-cast-plans')) return;
    if (plan.workspaceId !== this.workspaceId || plan.chatKey !== this.chatKey) throw new Error('GenerationCastPlan 不属于当前工作区或聊天。');
    const current = await this.store.read({ workspaceId: this.workspaceId, collection: 'generation-cast-plans', recordId: plan.id });
    await this.store.write({ workspaceId: this.workspaceId, collection: 'generation-cast-plans', recordId: plan.id, value: asPlain(plan), expectedVersion: current?.version ?? 0 });
  }
  async getGenerationCastPlan(planId: string): Promise<GenerationCastPlan | undefined> {
    if (this.unavailableOptionalCollections.has('generation-cast-plans')) return undefined;
    const record = await this.store.read({ workspaceId: this.workspaceId, collection: 'generation-cast-plans', recordId: planId });
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
    const current = await this.store.read({ workspaceId: this.workspaceId, collection: 'cast-plan-audits', recordId: audit.id });
    await this.store.write({ workspaceId: this.workspaceId, collection: 'cast-plan-audits', recordId: audit.id, value: asPlain(audit), expectedVersion: current?.version ?? 0 });
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
    const current = await this.store.read({ workspaceId: this.workspaceId, collection: 'recall-coverage-logs', recordId: log.id });
    await this.store.write({ workspaceId: this.workspaceId, collection: 'recall-coverage-logs', recordId: log.id, value: asPlain(log), expectedVersion: current?.version ?? 0 });
  }
  async listRecallCoverageLogs(limit = 100): Promise<RecallCoverageLog[]> {
    return (await this.list('recall-coverage-logs', { workspaceId: this.workspaceId, chatKey: this.chatKey }))
      .map(record => record.value as unknown as RecallCoverageLog)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, Math.max(1, Math.trunc(limit)));
  }
  async recordMemoryUsage(logs: readonly MemoryUsageLog[]): Promise<void> {
    if (logs.length === 0 || this.unavailableOptionalCollections.has('memory-usage-logs')) return;
    const operations: StoreOperation[] = [];
    for (const log of logs) {
      if (log.workspaceId !== this.workspaceId || log.chatKey !== this.chatKey) throw new Error('MemoryUsageLog 不属于当前工作区或聊天。');
      const current = await this.store.read({ workspaceId: this.workspaceId, collection: 'memory-usage-logs', recordId: log.id });
      operations.push({ action: 'upsert', collection: 'memory-usage-logs', recordId: log.id, value: asPlain(log), expectedVersion: current?.version ?? 0 });
    }
    await this.store.apply({ workspaceId: this.workspaceId, idempotencyKey: `memory-usage:${stableRecordHash(this.chatKey)}:${crypto.randomUUID()}`, operations });
  }
  async listMemoryUsageLogs(limit = 200): Promise<MemoryUsageLog[]> {
    return (await this.list('memory-usage-logs', { workspaceId: this.workspaceId, chatKey: this.chatKey }))
      .map(record => record.value as unknown as MemoryUsageLog)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, Math.max(1, Math.trunc(limit)));
  }
  async listCaptureJobs(): Promise<Record<string, unknown>[]> { return (await this.list('capture-jobs', { workspaceId: this.workspaceId, chatKey: this.chatKey })).map(record => record.value as unknown as Record<string, unknown>); }
  async listCaptureRepairQueue(jobId?: string): Promise<CaptureRepairQueueRecord[]> {
    const rows = (await this.list('capture-repair-queue', { workspaceId: this.workspaceId, chatKey: this.chatKey }))
      .map((record) => {
        const value = record.value as unknown as CaptureRepairQueueRecord;
        return {
          ...value,
          rejectionIds: Array.isArray(value.rejectionIds)
            ? [...new Set(value.rejectionIds.filter(Boolean))]
            : value.rejectionId ? [value.rejectionId] : [],
          attemptCount: Number.isInteger(value.attemptCount) && value.attemptCount >= 0
            ? value.attemptCount
            : 0,
          maxAttempts: Number.isInteger(value.maxAttempts) && (value.maxAttempts ?? 0) > 0
            ? value.maxAttempts
            : 2,
          batchIndex: Number.isInteger(Number(value.batchIndex)) && Number(value.batchIndex) >= 0
            ? Math.trunc(Number(value.batchIndex))
            : 0,
          itemIndex: Number.isInteger(Number(value.itemIndex)) && Number(value.itemIndex) >= 0
            ? Math.trunc(Number(value.itemIndex))
            : 0,
          ...(value.originalRequestId?.trim() ? { originalRequestId: value.originalRequestId.trim() } : {}),
          ...(Array.isArray(value.fieldActions) ? { fieldActions: value.fieldActions } : {}),
          ...(value.status === 'resolved' && !value.resolutionMode ? { resolutionMode: 'repaired' as const } : {}),
        } satisfies CaptureRepairQueueRecord;
      })
      .filter(record => record.workspaceId === this.workspaceId && record.chatKey === this.chatKey);
    return rows
      .filter(record => jobId === undefined || record.jobId === jobId)
      .sort((left, right) => left.batchIndex - right.batchIndex || left.itemIndex - right.itemIndex);
  }

  async page<T>(
    collection: keyof typeof COLLECTIONS,
    request: MemoryPageRequest,
    scope: Readonly<Record<string, PlainData>> = {},
  ): Promise<MemoryPage<T>> {
    if (request.signal?.aborted) throw request.signal.reason;
    if (this.unavailableOptionalCollections.has(collection)) return { items: [], nextCursor: null, total: 0 };
    const page = await this.store.scan({
      workspaceId: this.workspaceId,
      collection,
      filter: { ...scope, ...request.filter },
      ...(request.where === undefined ? {} : { where: request.where }),
      ...(request.orderBy === undefined ? {} : { orderBy: request.orderBy }),
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      limit: Math.max(1, Math.min(500, Math.trunc(request.limit))),
      includeTotal: request.includeTotal === true,
    });
    if (request.signal?.aborted) throw request.signal.reason;
    return {
      items: rows(page).map(record => record.value as unknown as T),
      nextCursor: page.nextCursor,
      ...(page.total === undefined ? {} : { total: page.total }),
    };
  }
  async reconcileCaptureRepairQueue(jobId: string): Promise<CaptureRepairQueueRecord[]> {
    const running = this.repairReconcileRuns.get(jobId);
    if (running) return running;
    const task = this.reconcileCaptureRepairQueueOnce(jobId);
    this.repairReconcileRuns.set(jobId, task);
    try {
      return await task;
    } finally {
      if (this.repairReconcileRuns.get(jobId) === task) this.repairReconcileRuns.delete(jobId);
    }
  }
  private async reconcileCaptureRepairQueueOnce(jobId: string): Promise<CaptureRepairQueueRecord[]> {
    const existing = await this.listCaptureRepairQueue(jobId);
    const repairKey = (record: Pick<CaptureRepairQueueRecord, 'jobId' | 'originalRequestId' | 'batchIndex' | 'collection' | 'itemIndex'>): string =>
      [
        record.jobId.trim(),
        record.originalRequestId?.trim() ?? '',
        Math.max(0, Math.trunc(Number(record.batchIndex) || 0)),
        record.collection,
        Math.max(0, Math.trunc(Number(record.itemIndex) || 0)),
      ].join('\0');
    const existingGroups = new Map<string, CaptureRepairQueueRecord[]>();
    for (const record of existing) {
      const key = repairKey(record);
      const rows = existingGroups.get(key) ?? [];
      rows.push(record);
      existingGroups.set(key, rows);
    }
    const groups = new Map<string, {
      batchIndex: number;
      collection: CaptureRepairQueueRecord['collection'];
      itemIndex: number;
      sourceRefs: Set<string>;
      fallbackSourceRefs: Set<string>;
      rejectionIds: Set<string>;
      issues: Map<string, CaptureRepairQueueRecord['issues'][number]>;
      repairAttempts: number;
      originalRequestId?: string;
      originalResourceId?: string;
      originalModel?: string;
    }>();
    const captureAudits: Array<{ id: string; rejections: AutomaticIngestRejection[] }> = [];
    const repairAuditRejectionIds = new Set<string>();
    for (const row of await this.listChangeAudits()) {
      if (String(row.kind ?? '') !== 'capture-change-set-v0' || row.rolledBackAt) continue;
      const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? row.metadata as Record<string, unknown>
        : {};
      if (String(metadata.captureJobId ?? '') !== jobId) continue;
      const fallbackSourceRefs = Array.isArray(metadata.sourceRefs) ? metadata.sourceRefs.map(String) : [];
      const rejections = Array.isArray(metadata.rejections)
        ? metadata.rejections.filter((item): item is AutomaticIngestRejection => Boolean(item && typeof item === 'object'))
        : [];
      if (isRepairCaptureAudit(metadata, jobId)) {
        for (const item of rejections) {
          if (!REPAIRABLE_REJECTION_CODES.has(item.code)) continue;
          if (item.id) repairAuditRejectionIds.add(item.id);
        }
        continue;
      }
      captureAudits.push({ id: String(row.id ?? ''), rejections });
      for (const item of rejections) {
        if ((item.status ?? 'unresolved') !== 'unresolved' || !REPAIRABLE_REJECTION_CODES.has(item.code)) continue;
        const collection = repairCollection(item);
        const metadataBatchIndex = Number(metadata.batchIndex);
        const rejectionBatchIndex = Number((item as AutomaticIngestRejection & { batchIndex?: number }).batchIndex);
        // Capture checkpoints and queue rows use a zero-based batch index, while
        // response diagnostics expose a one-based batch number. Prefer the audit
        // checkpoint and normalize old audits that only persisted the diagnostic.
        const batchIndex = Number.isInteger(metadataBatchIndex) && metadataBatchIndex >= 0
          ? metadataBatchIndex
          : Math.max(0, Number.isInteger(rejectionBatchIndex) ? rejectionBatchIndex - 1 : 0);
        const originalRequestId = item.requestId?.trim();
        const key = repairKey({ jobId, originalRequestId, batchIndex, collection, itemIndex: item.index });
        const group = groups.get(key) ?? {
          batchIndex,
          collection,
          itemIndex: item.index,
          sourceRefs: new Set<string>(),
          fallbackSourceRefs: new Set<string>(),
          rejectionIds: new Set<string>(),
          issues: new Map<string, CaptureRepairQueueRecord['issues'][number]>(),
          repairAttempts: 0,
          ...(originalRequestId ? { originalRequestId } : {}),
          ...(item.resourceId ? { originalResourceId: item.resourceId } : {}),
          ...(item.model ? { originalModel: item.model } : {}),
        };
        for (const sourceRef of item.sourceRefs ?? []) group.sourceRefs.add(sourceRef);
        for (const sourceRef of fallbackSourceRefs) group.fallbackSourceRefs.add(sourceRef);
        if (item.id) group.rejectionIds.add(item.id);
        group.repairAttempts = Math.max(group.repairAttempts, Math.max(0, Math.trunc(item.repairAttempts ?? 0)));
        for (const issue of rejectionIssue(item)) {
          group.issues.set(`${issue.path}\0${issue.keyword}\0${issue.expected}`, issue);
        }
        groups.set(key, group);
      }
    }
    // Older builds did not mark repair audits, so reconciliation could create a
    // fresh queue row from each failed repair response. Those rows are derived
    // failures, not new source items. Remove them before selecting work.
    for (const [key, rows] of existingGroups) {
      const retained: CaptureRepairQueueRecord[] = [];
      for (const record of rows) {
        const linkedIds = record.rejectionIds?.length
          ? record.rejectionIds
          : record.rejectionId ? [record.rejectionId] : [];
        if (linkedIds.some(rejectionId => repairAuditRejectionIds.has(rejectionId))) {
          await this.removeCaptureRepairRecord(record.id);
        } else {
          retained.push(record);
        }
      }
      if (retained.length > 0) existingGroups.set(key, retained);
      else existingGroups.delete(key);
    }
    const records: CaptureRepairQueueRecord[] = [];
    for (const [key, group] of groups) {
      const matching = [...new Map([
        ...(existingGroups.get(key) ?? []),
        ...existing.filter((record) => {
          const linkedIds = record.rejectionIds?.length
            ? record.rejectionIds
            : record.rejectionId ? [record.rejectionId] : [];
          return linkedIds.some(rejectionId => group.rejectionIds.has(rejectionId));
        }),
      ].map(record => [record.id, record] as const)).values()];
      const previous = [...matching].sort((left, right) => {
        const terminal = (record: CaptureRepairQueueRecord): number =>
          record.status === 'resolved' || record.status === 'ignored' ? 1 : 0;
        return terminal(right) - terminal(left)
          || right.attemptCount - left.attemptCount
          || right.updatedAt - left.updatedAt;
      })[0];
      const timestamp = Date.now();
      const policyUpgrade = previous && (previous.repairPolicyVersion ?? 0) < 1;
      const record: CaptureRepairQueueRecord = {
        ...(previous ?? {
          id: `capture-repair:${stableRecordHash(key)}`,
          workspaceId: this.workspaceId,
          chatKey: this.chatKey,
          jobId,
          batchIndex: group.batchIndex,
          collection: group.collection,
          itemIndex: group.itemIndex,
          status: 'queued',
          attemptCount: group.repairAttempts,
          createdAt: timestamp,
        }),
        jobId,
        batchIndex: group.batchIndex,
        collection: group.collection,
        itemIndex: group.itemIndex,
        issues: [...new Map([
          ...matching.flatMap(candidate => candidate.issues)
            .map(issue => [`${issue.path}\0${issue.keyword}\0${issue.expected}`, issue] as const),
          ...group.issues,
        ]).values()],
        sourceRefs: [...new Set([...matching.flatMap(candidate => candidate.sourceRefs), ...group.sourceRefs])],
        fallbackSourceRefs: [...new Set([
          ...matching.flatMap(candidate => candidate.fallbackSourceRefs),
          ...group.fallbackSourceRefs,
        ])],
        rejectionIds: [...new Set([
          ...matching.flatMap(candidate => candidate.rejectionIds?.length
            ? candidate.rejectionIds
            : candidate.rejectionId ? [candidate.rejectionId] : []),
          ...group.rejectionIds,
        ])],
        ...(group.originalRequestId ? { originalRequestId: group.originalRequestId } : {}),
        ...(group.originalResourceId ? { originalResourceId: group.originalResourceId } : {}),
        ...(group.originalModel ? { originalModel: group.originalModel } : {}),
        repairPolicyVersion: 1,
        maxAttempts: policyUpgrade && (previous?.attemptCount ?? group.repairAttempts) >= (previous?.maxAttempts ?? 2)
          ? (previous?.attemptCount ?? group.repairAttempts) + 1
          : previous?.maxAttempts ?? (group.repairAttempts >= 2 ? group.repairAttempts + 1 : 2),
        ...(policyUpgrade && previous?.status === 'unresolved' ? { status: 'queued' as const } : {}),
        updatedAt: timestamp,
      };
      await this.updateCaptureRepairRecord(record);
      for (const duplicate of matching) {
        if (duplicate.id !== record.id) await this.removeCaptureRepairRecord(duplicate.id);
      }
      records.push(record);
    }
    const resolvedQueueByRejectionId = new Map<string, CaptureRepairQueueRecord>();
    for (const record of records) {
      if (record.status !== 'resolved' && record.status !== 'ignored') continue;
      for (const rejectionId of record.rejectionIds?.length
        ? record.rejectionIds
        : record.rejectionId ? [record.rejectionId] : []) {
        resolvedQueueByRejectionId.set(rejectionId, record);
      }
    }
    // Replaying each audit through the normal projection updater makes old jobs,
    // queue rows and UI counters converge before the application presents state.
    // It also repairs the legacy split-brain state where the queue was resolved
    // but its originating Change Audit was never updated.
    for (const audit of captureAudits) {
      if (!audit.id) continue;
      const rejections = audit.rejections.map((rejection) => {
        const repair = rejection.id ? resolvedQueueByRejectionId.get(rejection.id) : undefined;
        if (!repair) return rejection;
        return {
          ...rejection,
          status: repair.status === 'ignored' ? 'ignored' as const : 'repaired' as const,
          repairAttempts: repair.attemptCount,
          ...(repair.status === 'ignored'
            ? { ignoredAt: repair.resolvedAt ?? repair.updatedAt }
            : { repairedAt: repair.resolvedAt ?? repair.updatedAt }),
        };
      });
      await this.updateCaptureAuditRejections(audit.id, rejections);
    }
    return this.listCaptureRepairQueue(jobId);
  }
  async updateCaptureRepairRecord(record: CaptureRepairQueueRecord): Promise<void> {
    if (record.workspaceId !== this.workspaceId || record.chatKey !== this.chatKey) {
      throw createSSHelperError('WORKSPACE_ACCESS_DENIED', {
        stage: 'memory.repair.queue.ownership',
        collection: 'capture-repair-queue',
      });
    }
    await this.withRepairQueueWrite(record.id, async () => {
      const current = await this.store.read({ workspaceId: this.workspaceId, collection: 'capture-repair-queue', recordId: record.id });
      const { failure: _failure, ...withoutFailure } = record;
      const value = record.status === 'resolved' || record.status === 'ignored' ? withoutFailure : record;
      await this.store.write({
        workspaceId: this.workspaceId,
        collection: 'capture-repair-queue',
        recordId: record.id,
        value: asPlain({ ...value, updatedAt: Date.now() }),
        expectedVersion: current?.version ?? 0,
      });
    });
  }
  private async removeCaptureRepairRecord(recordId: string): Promise<void> {
    await this.withRepairQueueWrite(recordId, async () => {
      const current = await this.store.read({
        workspaceId: this.workspaceId,
        collection: 'capture-repair-queue',
        recordId,
      });
      if (!current) return;
      await this.store.remove({
        workspaceId: this.workspaceId,
        collection: 'capture-repair-queue',
        recordId,
        expectedVersion: current.version,
      });
    });
  }
  private async withRepairQueueWrite(recordId: string, operation: () => Promise<void>): Promise<void> {
    const key = `${this.workspaceId}\0${this.chatKey}\0${recordId}`;
    const previous = this.repairQueueWriteTails.get(key) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(operation);
    const tail = task.then(() => undefined, () => undefined);
    this.repairQueueWriteTails.set(key, tail);
    try {
      await task;
    } finally {
      if (this.repairQueueWriteTails.get(key) === tail) this.repairQueueWriteTails.delete(key);
    }
  }
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
    const current = await this.store.read({ workspaceId: this.workspaceId, collection: 'capture-jobs', recordId: id });
    await this.store.write({
      workspaceId: this.workspaceId,
      collection: 'capture-jobs',
      recordId: id,
      value: asPlain({ ...record, id, workspaceId, chatKey, updatedAt: Number(record.updatedAt ?? Date.now()) }),
      expectedVersion: current?.version ?? 0,
    });
  }
  async listChangeAudits(): Promise<Record<string, unknown>[]> { return (await this.list('change-audits', { workspaceId: this.workspaceId, chatKey: this.chatKey })).map(record => record.value as unknown as Record<string, unknown>); }
  async getChangeAudit(auditId: string): Promise<ChangeAudit | undefined> {
    const record = await this.store.read({ workspaceId: this.workspaceId, collection: 'change-audits', recordId: auditId });
    const audit = record?.value as unknown as ChangeAudit | undefined;
    return audit?.workspaceId === this.workspaceId && audit.chatKey === this.chatKey ? audit : undefined;
  }
  async updateCaptureAuditRejections(auditId: string, rejections: readonly AutomaticIngestRejection[]): Promise<void> {
    const current = await this.store.read({ workspaceId: this.workspaceId, collection: 'change-audits', recordId: auditId });
    const audit = current?.value as unknown as ChangeAudit | undefined;
    if (!current || !audit || audit.kind !== 'capture-change-set-v0' || audit.workspaceId !== this.workspaceId || audit.chatKey !== this.chatKey) throw new Error('找不到当前聊天的 Capture 审计记录。');
    if (audit.rolledBackAt) throw new Error('不能修改已回滚 Capture 的失败项。');
    const metadata = audit.metadata && typeof audit.metadata === 'object' && !Array.isArray(audit.metadata)
      ? audit.metadata as Record<string, PlainData>
      : {};
    const unresolvedCount = rejections.filter(item => (item.status ?? 'unresolved') === 'unresolved').length;
    const outcome = unresolvedCount > 0 ? 'partial' : 'complete';
    const operations: StoreOperation[] = [{
      action: 'upsert',
      collection: 'change-audits',
      recordId: auditId,
      value: asPlain({ ...audit, metadata: { ...metadata, outcome, rejections: [...rejections] } }),
      expectedVersion: current.version,
    }];
    const captureJobId = String(metadata.captureJobId ?? '').trim();
    if (captureJobId) {
      const rejectionStatusById = new Map(
        rejections
          .filter(item => Boolean(item.id))
          .map(item => [item.id!, item.status ?? 'unresolved'] as const),
      );
      const repairedQueue = await this.listCaptureRepairQueue(captureJobId);
      for (const repair of repairedQueue) {
        const linkedIds = repair.rejectionIds?.length ? repair.rejectionIds : repair.rejectionId ? [repair.rejectionId] : [];
        const linkedStatuses = linkedIds.map(id => rejectionStatusById.get(id)).filter(Boolean);
        if (!linkedStatuses.length || linkedStatuses.some(status => status === 'unresolved')) continue;
        const rejectionStatus = linkedStatuses.every(status => status === 'ignored') ? 'ignored' : 'repaired';
        const repairRecord = await this.store.read({
          workspaceId: this.workspaceId,
          collection: 'capture-repair-queue',
          recordId: repair.id,
        });
        if (!repairRecord) continue;
        const { failure: _failure, ...repairWithoutFailure } = repair;
        operations.push({
          action: 'upsert',
          collection: 'capture-repair-queue',
          recordId: repair.id,
          value: asPlain({
            ...repairWithoutFailure,
            status: rejectionStatus === 'ignored' ? 'ignored' : 'resolved',
            ...(rejectionStatus === 'ignored' ? { resolutionMode: 'ignored' } : {}),
            ...(rejectionStatus !== 'ignored' && !repair.resolutionMode ? { resolutionMode: 'repaired' } : {}),
            resolvedAt: Date.now(),
            updatedAt: Date.now(),
          }),
          expectedVersion: repairRecord.version,
        });
      }
      const captureJob = await this.store.read({ workspaceId: this.workspaceId, collection: 'capture-jobs', recordId: captureJobId });
      if (captureJob?.value && typeof captureJob.value === 'object') {
        const jobValue = captureJob.value as Record<string, unknown>;
        if (String(jobValue.workspaceId ?? '') !== this.workspaceId || String(jobValue.chatKey ?? '') !== this.chatKey) throw new Error('Capture job 不属于当前聊天。');
        // A job spans many batch ChangeSets. Updating one batch must
        // not erase unresolved rows that still belong to another batch.
        const aggregate = new Map<string, AutomaticIngestRejection>();
        for (const row of await this.listChangeAudits()) {
          if (String(row.kind ?? '') !== 'capture-change-set-v0' || row.rolledBackAt) continue;
          const rowMetadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
            ? row.metadata as Record<string, unknown>
            : {};
          if (String(rowMetadata.captureJobId ?? '') !== captureJobId) continue;
          // Repair-attempt audits preserve their own validation history, but
          // they are not new source rejections and must not inflate the parent
          // job's unresolved counters.
          if (isRepairCaptureAudit(rowMetadata, captureJobId)) continue;
          const rows = String(row.id ?? '') === auditId
            ? rejections
            : Array.isArray(rowMetadata.rejections)
              ? rowMetadata.rejections.filter((item): item is AutomaticIngestRejection => Boolean(item && typeof item === 'object'))
              : [];
          for (const item of rows) {
            const key = item.id ?? `${item.recordType ?? 'unknown'}:${item.index}:${item.code}:${item.fieldPath ?? ''}`;
            const previous = aggregate.get(key);
            const statusRank = (status: AutomaticIngestRejection['status']): number =>
              status === 'repaired' || status === 'ignored' ? 1 : 0;
            if (!previous || statusRank(item.status) >= statusRank(previous.status)) {
              aggregate.set(key, structuredClone(item));
            }
          }
        }
        const jobRejections = [...aggregate.values()];
        const jobUnresolvedCount = jobRejections.filter(item => (item.status ?? 'unresolved') === 'unresolved').length;
        const jobOutcome = jobUnresolvedCount > 0 ? 'partial' : 'complete';
        const queue = repairedQueue.map(record => {
          const linked = record.rejectionIds?.length ? record.rejectionIds : record.rejectionId ? [record.rejectionId] : [];
          const statuses = linked.map(id => rejectionStatusById.get(id)).filter(Boolean);
          if (!statuses.length || statuses.some(status => status === 'unresolved')) return record;
          return {
            ...record,
            status: statuses.every(status => status === 'ignored') ? 'ignored' as const : 'resolved' as const,
            resolutionMode: statuses.every(status => status === 'ignored') ? 'ignored' as const : record.resolutionMode ?? 'repaired' as const,
          };
        });
        const retryableRepairCount = queue.filter(item =>
          (item.status === 'queued' || item.status === 'running' || item.status === 'unresolved')
          && item.attemptCount < (item.maxAttempts ?? 2)
          && repairDependencyBlocker(item, queue) === undefined).length;
        const exhaustedRepairCount = queue.filter(item => item.status === 'unresolved' && item.attemptCount >= (item.maxAttempts ?? 2)).length;
        const dependencyReviewCount = queue.filter(item => {
          if (!((item.status === 'queued' || item.status === 'running' || item.status === 'unresolved')
            && item.attemptCount < (item.maxAttempts ?? 2))) return false;
          const blocker = repairDependencyBlocker(item, queue);
          return blocker?.status === 'unresolved' && blocker.attemptCount >= (blocker.maxAttempts ?? 2);
        }).length;
        const reviewRequiredCount = exhaustedRepairCount + dependencyReviewCount + jobRejections.filter(item =>
          (item.status ?? 'unresolved') === 'unresolved' && !REPAIRABLE_REJECTION_CODES.has(item.code)).length;
        const repairedCount = jobRejections.filter(item => item.status === 'repaired').length;
        const degradedCount = queue.filter(item => item.resolutionMode === 'degraded').length;
        const ignoredCount = jobRejections.filter(item => item.status === 'ignored').length;
        operations.push({
          action: 'upsert',
          collection: 'capture-jobs',
          recordId: captureJobId,
          // Keep the full history for audit display, but the progress badge
          // must count only work that still requires attention.
          value: asPlain({
            ...jobValue,
            status: retryableRepairCount > 0 ? 'needs_repair' : jobUnresolvedCount > 0 ? 'needs_review' : 'completed',
            outcome: jobOutcome,
            rejectionCount: jobUnresolvedCount,
            rejections: jobRejections,
            checkpoint: {
              ...((jobValue.checkpoint && typeof jobValue.checkpoint === 'object') ? jobValue.checkpoint : {}),
              phase: 'repair',
              pendingRepairCount: retryableRepairCount,
              retryableRepairCount,
              exhaustedRepairCount,
              reviewRequiredCount,
              unresolvedRejectionCount: jobUnresolvedCount,
              repairedCount,
              degradedCount,
              ignoredCount,
            },
            updatedAt: Date.now(),
          }),
          expectedVersion: captureJob.version,
        });
      }
    }
    await this.store.apply({ workspaceId: this.workspaceId, idempotencyKey: `capture-rejections:${auditId}:${crypto.randomUUID()}`, operations });
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
    await this.store.write({ workspaceId: this.workspaceId, collection: 'change-audits', recordId: id, value: asPlain(value) });
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
    const traces = records.map(record => record.value as unknown as ActorMemoryTrace);
    const invalid = traces.find(trace => !trace.chatKey || !Number.isFinite(trace.learnedAt));
    if (invalid) {
      throw createSSHelperError('SCHEMA_VALIDATION_FAILED', {
        stage: 'memory.repository.trace.read',
        collection: 'memory-traces',
        path: '$.chatKey|$.learnedAt',
      });
    }
    return traces.filter(trace => trace.chatKey === this.chatKey);
  }
  async getFact(factId: string): Promise<MemoryFact | undefined> {
    const record = await this.store.read({ workspaceId: this.workspaceId, collection: 'facts', recordId: factId });
    const fact = record?.value as unknown as MemoryFact | undefined;
    return fact?.chatKey === this.chatKey ? fact : undefined;
  }
  async getOwner(ownerId: string): Promise<MemoryOwner | undefined> { const record = await this.store.read({ workspaceId: this.workspaceId, collection: 'actors', recordId: ownerId }); return record?.value as unknown as MemoryOwner | undefined; }

  private async addDerivedInvalidations(
    factIdsInput: string | ReadonlySet<string>,
    traceIds: ReadonlySet<string>,
    entries: ChangeEntry[],
    operations: StoreOperation[],
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
    await Promise.all([...new Set(factIds)].map(factId => this.store.vectors.delete({
      workspaceId: this.workspaceId,
      collection: 'facts',
      recordId: factId,
    }).catch(() => false)));
  }

  /** Manual fact edits use the same v0 facts/evidence/head/trace transaction as Capture. */
  async upsertManualFact(input: ManualFactInput): Promise<MemoryFact> {
    const chatKey = this.chatKey;
    if (!chatKey) throw createSSHelperError('MEMORY_CAPTURE_NOT_BOUND', { stage: 'memory.repository.manual-fact.chat' });
    const content = normalizeFactContent(input.content);
    if (Array.from(content).length < 6 || Array.from(content).length > MAX_FACT_CONTENT_LENGTH) throw createSSHelperError('INVALID_PAYLOAD', { stage: 'memory.repository.manual-fact.content' });
    const confidence = input.confidence ?? 1;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw createSSHelperError('INVALID_PAYLOAD', { stage: 'memory.repository.manual-fact.confidence' });
    const id = input.id?.trim() || manualFactId(chatKey);
    const previousRecord = await this.store.read({ workspaceId: this.workspaceId, collection: 'facts', recordId: id });
    const previous = previousRecord?.value as unknown as MemoryFact | undefined;
    if (previous && previous.chatKey !== chatKey) throw createSSHelperError('WORKSPACE_NOT_FOUND', { stage: 'memory.repository.manual-fact.lookup' });
    const subjectKey = input.subjectKey.trim();
    const predicateKey = input.predicateKey.trim();
    if (!subjectKey || !predicateKey) throw createSSHelperError('INVALID_PAYLOAD', { stage: 'memory.repository.manual-fact.keys' });
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
    const operations: StoreOperation[] = [];
    const addUpsert = async (collection: string, recordId: string, value: PlainData): Promise<void> => {
      const before = await this.store.read({ workspaceId: this.workspaceId, collection, recordId });
      entries.push({ collection, recordId, ...(before ? { before: before.value } : {}), after: value });
      operations.push({ action: 'upsert', collection, recordId, value, expectedVersion: before?.version ?? 0 });
    };
    await addUpsert('facts', fact.id, asPlain({ ...fact, workspaceId: this.workspaceId }));
    const evidence: MemoryEvidence = { id: evidenceId, factId: fact.id, chatKey, sourceRef, sourceType: 'manual', excerpt: content, occurredAt: timestamp, createdAt: timestamp };
    await addUpsert('evidence', evidence.id, asPlain({ ...evidence, workspaceId: this.workspaceId }));
    if (conflicting) {
      const conflictRecord = await this.store.read({ workspaceId: this.workspaceId, collection: 'facts', recordId: conflicting.id });
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
      const currentHead = await this.store.read({ workspaceId: this.workspaceId, collection: 'fact-heads', recordId: headId });
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
    await this.store.apply({ workspaceId: this.workspaceId, idempotencyKey: audit.id, operations });
    await this.deleteFactVectors([fact.id, ...(conflicting ? [conflicting.id] : [])]);
    return fact;
  }

  async removeFact(factId: string): Promise<boolean> {
    const chatKey = this.chatKey;
    const targetRecord = await this.store.read({ workspaceId: this.workspaceId, collection: 'facts', recordId: factId });
    const target = targetRecord?.value as unknown as MemoryFact | undefined;
    if (!target || target.chatKey !== chatKey || !targetRecord) return false;
    const entries: ChangeEntry[] = [{ collection: 'facts', recordId: factId, before: asPlain(target) }];
    const operations: StoreOperation[] = [{ action: 'delete', collection: 'facts', recordId: factId, expectedVersion: targetRecord.version }];
    const declaredRelatedIds = [...new Set([target.supersedesId, target.supersededById].filter((value): value is string => Boolean(value)))];
    const related = (await Promise.all(declaredRelatedIds.map(async recordId => {
      const record = await this.store.read({ workspaceId: this.workspaceId, collection: 'facts', recordId });
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
    const head = await this.store.read({ workspaceId: this.workspaceId, collection: 'fact-heads', recordId: headId });
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
    await this.store.apply({ workspaceId: this.workspaceId, idempotencyKey: audit.id, operations });
    await this.deleteFactVectors([factId, ...relatedIds]);
    return true;
  }
  async listDerived(collection: 'profile-claims' | 'relationship-claims' | 'dream-jobs' | 'dream-audits' | 'recall-exposures', ownerId?: string): Promise<Record<string, unknown>[]> {
    return (await this.list(collection, { workspaceId: this.workspaceId, ...(ownerId ? { ownerId } : {}), ...(collection !== 'profile-claims' && collection !== 'relationship-claims' ? { chatKey: this.chatKey } : {}) })).map(record => record.value as unknown as Record<string, unknown>);
  }

  async listPendingActorCandidates(): Promise<ActorCandidate[]> { return this.listPendingCandidates(); }

  async commitCapture(commit: CaptureCommit): Promise<ChangeAudit> {
    try {
      return await this.commitCaptureOnce(commit);
    } catch (error) {
      if (!isWorkspaceConflict(error)) throw error;
      // The validated Capture result is immutable at this point. Rebuild the
      // transaction once from fresh revisions without repeating any LLM work.
      return this.commitCaptureOnce(commit);
    }
  }

  private async commitCaptureOnce(commit: CaptureCommit): Promise<ChangeAudit> {
    const baseTransactionKey = commit.idempotencyKey?.trim()
      || `capture:${commit.captureJobId ?? this.chatKey}:${commit.envelope.sourceRefs.join('|')}`;
    const requestDigest = stableRecordHash(JSON.stringify(captureSemanticPlain(asPlain({
      envelope: commit.envelope,
      outcome: commit.outcome ?? 'complete',
      rejections: commit.rejections ?? [],
      owners: commit.owners,
      aliases: commit.aliases,
      pendingCandidates: commit.pendingCandidates ?? [],
      locations: commit.locations,
      locationAliases: commit.locationAliases,
      pendingLocationCandidates: commit.pendingLocationCandidates ?? [],
      episodes: commit.episodes,
      observations: commit.observations,
      facts: commit.facts,
      evidence: commit.evidence,
      traces: commit.traces,
      sceneCasts: commit.sceneCasts ?? [],
    }))));
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
      return Boolean(persistedTransactionKey) && persistedTransactionKey === transactionKey;
    };

    // SDK workspace transactions are durably idempotent. A rolled-back
    // transaction cannot reuse the same key: the SDK would correctly replay
    // the original transaction result without applying the records again.
    // Walk the deterministic retry chain until reaching either an unapplied
    // key or an already-active retry. This remains stable across restarts and
    // preserves exactly-once behaviour for ordinary duplicate requests.
    while (true) {
      const existingRecord = await this.store.read({
        workspaceId: this.workspaceId,
        collection: 'change-audits',
        recordId: auditId,
      });
      const existingAudit = existingRecord?.value as unknown as ChangeAudit | undefined;
      if (!existingAudit) break;
      if (auditMatchesRequest(existingAudit, auditId)) {
        if (!existingAudit.rolledBackAt) {
          const metadata = existingAudit.metadata && typeof existingAudit.metadata === 'object' && !Array.isArray(existingAudit.metadata)
            ? existingAudit.metadata as Record<string, PlainData>
            : {};
          const persistedDigest = String(metadata.requestDigest ?? '');
          if (!persistedDigest) {
            throw createSSHelperError('MEMORY_CAPTURE_INTEGRITY_FAILED', {
              stage: 'memory.repository.capture.idempotency',
            });
          }
          if (persistedDigest !== requestDigest) {
            throw createSSHelperError('WORKSPACE_CONFLICT', {
              stage: 'memory.repository.capture.idempotency',
            });
          }
          return structuredClone(existingAudit);
        }
        retryAttempt += 1;
        collisionAttempt = 0;
        transactionKey = `${baseTransactionKey}:retry:${retryAttempt}`;
        auditId = `change-audit:${stableKey(transactionKey)}`;
        continue;
      }
      // Even a 128-bit deterministic key is not treated as proof of identity.
      // Never overwrite an unrelated audit; derive an alternate record id while
      // preserving the transaction's real idempotency key.
      collisionAttempt += 1;
      if (collisionAttempt > 1_024) throw createSSHelperError('INTERNAL_ERROR', { stage: 'memory.repository.capture.audit-id' });
      auditId = `change-audit:${stableKey(`${transactionKey}:collision:${collisionAttempt}`)}`;
    }

    const entries: ChangeEntry[] = [];
    const operations: StoreOperation[] = [];
    const mutationSlots = new Map<string, {
      readonly entryIndex: number;
      readonly operationIndex: number;
      readonly before?: PlainData;
      readonly expectedVersion: number;
    }>();
    const putMutation = (
      collection: string,
      recordId: string,
      before: PlainData | undefined,
      expectedVersion: number,
      after: PlainData,
    ): void => {
      const key = `${collection}\0${recordId}`;
      const existing = mutationSlots.get(key);
      if (existing) {
        entries[existing.entryIndex] = {
          collection,
          recordId,
          ...(existing.before !== undefined ? { before: existing.before } : {}),
          after,
        };
        operations[existing.operationIndex] = {
          action: 'upsert',
          collection,
          recordId,
          value: after,
          expectedVersion: existing.expectedVersion,
        };
        return;
      }
      const entryIndex = entries.length;
      const operationIndex = operations.length;
      entries.push({ collection, recordId, ...(before !== undefined ? { before } : {}), after });
      operations.push({ action: 'upsert', collection, recordId, value: after, expectedVersion });
      mutationSlots.set(key, { entryIndex, operationIndex, ...(before !== undefined ? { before } : {}), expectedVersion });
    };
    const deleteMutation = (
      collection: string,
      recordId: string,
      before: PlainData,
      expectedVersion: number,
    ): void => {
      const key = `${collection}\0${recordId}`;
      const existing = mutationSlots.get(key);
      if (existing) {
        entries[existing.entryIndex] = {
          collection,
          recordId,
          ...(existing.before !== undefined ? { before: existing.before } : {}),
        };
        operations[existing.operationIndex] = {
          action: 'delete',
          collection,
          recordId,
          expectedVersion: existing.expectedVersion,
        };
        return;
      }
      const entryIndex = entries.length;
      const operationIndex = operations.length;
      entries.push({ collection, recordId, before });
      operations.push({ action: 'delete', collection, recordId, expectedVersion });
      mutationSlots.set(key, { entryIndex, operationIndex, before, expectedVersion });
    };
    const add = async (collection: string, value: Persistable | Record<string, unknown>): Promise<void> => {
      const recordId = idOf(value);
      if (!recordId) throw new Error(`多角色记录缺少 id：${collection}`);
      const persisted = collection === 'facts' || collection === 'evidence'
          ? { ...value, workspaceId: this.workspaceId }
          : value;
      const existing = mutationSlots.get(`${collection}\0${recordId}`);
      if (existing) {
        putMutation(collection, recordId, existing.before, existing.expectedVersion, asPlain(persisted));
        return;
      }
      const before = await this.store.read({ workspaceId: this.workspaceId, collection, recordId });
      putMutation(collection, recordId, before?.value, before?.version ?? 0, asPlain(persisted));
    };
    const remove = (collection: string, row: WorkspaceRecord): void => {
      deleteMutation(collection, row.recordId, row.value, row.version);
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
      const currentHead = await this.store.read({ workspaceId: this.workspaceId, collection: 'fact-heads', recordId: headId });
      const currentHeadFactId = String((currentHead?.value as Record<string, unknown> | undefined)?.factId ?? '');
      const currentHeadFact = currentHeadFactId
        ? await this.store.read({ workspaceId: this.workspaceId, collection: 'facts', recordId: currentHeadFactId })
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
      const before = await this.store.read({ workspaceId: this.workspaceId, collection: 'memory-traces', recordId: value.id });
      if (before?.value) {
        const previous = before.value as unknown as ActorMemoryTrace;
        const incoming = value;
        if (previous.chatKey !== this.chatKey || incoming.chatKey !== this.chatKey) {
          throw createSSHelperError('WORKSPACE_ACCESS_DENIED', {
            stage: 'memory.repository.trace.scope',
            collection: 'memory-traces',
          });
        }
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
          chatKey: incoming.chatKey,
          learnedAt: Math.min(previous.learnedAt, incoming.learnedAt),
        };
        await add('memory-traces', merged);
      } else {
        await add('memory-traces', value);
      }
    }
    for (const value of commit.sceneCasts ?? []) await add('scene-casts', value);
    const captureJobId = commit.captureJobId ?? `capture-job:${auditId}`;
    if (commit.captureJob) {
      const priorRejections = Array.isArray(commit.captureJob.rejections)
        ? commit.captureJob.rejections as AutomaticIngestRejection[]
        : [];
      const jobRejections = [...priorRejections, ...(commit.rejections ?? [])];
      const unresolvedCount = jobRejections
        .filter(item => (item.status ?? 'unresolved') === 'unresolved').length;
      const checkpointValue = commit.captureJob.checkpoint && typeof commit.captureJob.checkpoint === 'object'
        ? commit.captureJob.checkpoint as Record<string, unknown>
        : {};
      const repairableCount = jobRejections.filter(item =>
        (item.status ?? 'unresolved') === 'unresolved'
        && REPAIRABLE_REJECTION_CODES.has(item.code)).length;
      const reviewRequiredCount = unresolvedCount - repairableCount;
      await add('capture-jobs', {
        ...commit.captureJob,
        id: captureJobId,
        workspaceId: this.workspaceId,
        chatKey: this.chatKey,
        outcome: unresolvedCount > 0 ? 'partial' : 'complete',
        rejectionCount: unresolvedCount,
        checkpoint: {
          ...checkpointValue,
          pendingRepairCount: repairableCount,
          retryableRepairCount: repairableCount,
          exhaustedRepairCount: 0,
          reviewRequiredCount,
          unresolvedRejectionCount: unresolvedCount,
          repairedCount: jobRejections.filter(item => item.status === 'repaired').length,
          ignoredCount: jobRejections.filter(item => item.status === 'ignored').length,
        },
        ...(jobRejections.length > 0 ? { rejections: jobRejections } : {}),
      });
      const checkpoint = checkpointValue;
      const batchIndex = Math.max(0, Number(checkpoint.lastScannedBatch ?? checkpoint.batchIndex ?? 1) - 1);
      const repairGroups = new Map<string, AutomaticIngestRejection[]>();
      for (const item of (commit.rejections ?? []).filter(item =>
        (item.status ?? 'unresolved') === 'unresolved' && REPAIRABLE_REJECTION_CODES.has(item.code))) {
        const collection = repairCollection(item);
        const groupKey = [captureJobId, item.requestId?.trim() ?? '', batchIndex, collection, item.index].join('\0');
        const rows = repairGroups.get(groupKey) ?? [];
        rows.push(item);
        repairGroups.set(groupKey, rows);
      }
      for (const [groupKey, items] of repairGroups) {
        const item = items[0]!;
        const collection = repairCollection(item);
        const repairId = `capture-repair:${stableRecordHash(groupKey)}`;
        const issues = new Map<string, CaptureRepairQueueRecord['issues'][number]>();
        for (const row of items) {
          for (const issue of rejectionIssue(row)) issues.set(`${issue.path}\0${issue.keyword}\0${issue.expected}`, issue);
        }
        await add('capture-repair-queue', {
          id: repairId,
          workspaceId: this.workspaceId,
          chatKey: this.chatKey,
          jobId: captureJobId,
          batchIndex,
          collection,
          itemIndex: item.index,
          issues: [...issues.values()],
          sourceRefs: [...new Set(items.flatMap(row => row.sourceRefs ?? []))],
          fallbackSourceRefs: [...commit.envelope.sourceRefs],
          ...(item.requestId?.trim() ? { originalRequestId: item.requestId.trim() } : {}),
          ...(item.resourceId ? { originalResourceId: item.resourceId } : {}),
          ...(item.model ? { originalModel: item.model } : {}),
          ...(item.id ? { rejectionId: item.id } : {}),
          rejectionIds: items.flatMap(row => row.id ? [row.id] : []),
          status: 'queued',
          attemptCount: 0,
          maxAttempts: 2,
          repairPolicyVersion: 1,
          failure: {
            reasonCode: item.code === 'schema_validation_failed'
              ? 'SCHEMA_VALIDATION_FAILED'
              : 'ENTITY_REF_UNSUPPORTED',
            stage: 'memory.capture.item',
            batchIndex,
            collection,
            path: item.fieldPath ?? '$',
          },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    }
    const audit: ChangeAudit = {
      id: auditId,
      workspaceId: this.workspaceId,
      chatKey: this.chatKey,
      kind: 'capture-change-set-v0',
      createdAt: Date.now(),
      entries,
      metadata: asPlain({
        captureJobId,
        capturePhase: commit.capturePhase ?? 'capture',
        transactionKey,
        baseTransactionKey,
        requestDigest,
        ...(retryAttempt > 0 ? { retryAttempt, retriedTransactionKey: baseTransactionKey } : {}),
        sourceRefs: [...commit.envelope.sourceRefs],
        batchIndex: Math.max(0, Number((commit.captureJob?.checkpoint as Record<string, unknown> | undefined)?.lastScannedBatch
          ?? (commit.captureJob?.checkpoint as Record<string, unknown> | undefined)?.batchIndex
          ?? 1) - 1),
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
    await this.store.apply({ workspaceId: this.workspaceId, idempotencyKey: transactionKey, operations });
    return audit;
  }

  private async rollbackOrder(auditId: string): Promise<ChangeAudit[]> {
    const rootRecord = await this.store.read({ workspaceId: this.workspaceId, collection: 'change-audits', recordId: auditId });
    const root = rootRecord?.value as unknown as ChangeAudit | undefined;
    const allowedKinds = new Set<ChangeAudit['kind']>(['capture-change-set-v0', 'derived-change-set-v0', 'actor-registry-change-set-v0', 'dream-change-set-v0']);
    if (!root || root.workspaceId !== this.workspaceId || root.chatKey !== this.chatKey || !allowedKinds.has(root.kind)) {
      throw createSSHelperError('WORKSPACE_NOT_FOUND', { stage: 'memory.repository.rollback.lookup' });
    }
    if (root.rolledBackAt) return [];
    return [root];
  }

  private async preflightRollback(order: readonly ChangeAudit[]): Promise<void> {
    const simulated = new Map<string, PlainData | undefined>();
    for (const audit of order) {
      for (const entry of [...audit.entries].reverse()) {
        const key = `${entry.collection}:${entry.recordId}`;
        let currentValue: PlainData | undefined;
        if (simulated.has(key)) currentValue = simulated.get(key);
        else {
          const current = await this.store.read({ workspaceId: this.workspaceId, collection: entry.collection, recordId: entry.recordId });
          currentValue = current?.value as PlainData | undefined;
        }
        if (!samePlain(currentValue, entry.after)) {
          throw createSSHelperError('WORKSPACE_CONFLICT', {
            stage: 'memory.repository.rollback.preflight',
            collection: entry.collection,
          });
        }
        simulated.set(key, entry.before);
      }
    }
  }

  private async rollbackSingleChangeSet(audit: ChangeAudit): Promise<string[]> {
    const currentByRecord = new Map<string, WorkspaceRecord | null>();
    for (const entry of audit.entries) {
      const current = await this.store.read({ workspaceId: this.workspaceId, collection: entry.collection, recordId: entry.recordId });
      currentByRecord.set(`${entry.collection}:${entry.recordId}`, current);
      const currentValue = current?.value as PlainData | undefined;
      if (!samePlain(currentValue, entry.after)) {
        throw createSSHelperError('WORKSPACE_CONFLICT', {
          stage: 'memory.repository.rollback.commit',
          collection: entry.collection,
        });
      }
    }
    const operations: StoreOperation[] = [];
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
          || traceExposureCreatedDuringCapture
          || dreamUsesAffectedTrace
          || belongsToInvalidDream;
        const recordKey = `${collection}:${record.recordId}`;
        if (shouldDelete
          && !auditedKeys.has(recordKey)
          && !queuedDeleteKeys.has(recordKey)) {
          const current = await this.store.read({ workspaceId: this.workspaceId, collection, recordId: record.recordId });
          operations.push({ action: 'delete', collection, recordId: record.recordId, ...(current ? { expectedVersion: current.version } : {}) });
          queuedDeleteKeys.add(recordKey);
          if (collection === 'dream-jobs') invalidatedDreamJobIds.add(record.recordId);
        }
      }
    }
    const currentAudit = await this.store.read({ workspaceId: this.workspaceId, collection: 'change-audits', recordId: audit.id });
    if (!currentAudit) throw createSSHelperError('WORKSPACE_NOT_FOUND', { stage: 'memory.repository.rollback.audit' });
    operations.push({
      action: 'upsert',
      collection: 'change-audits',
      recordId: audit.id,
      value: asPlain({ ...audit, rolledBackAt: Date.now() }),
      expectedVersion: currentAudit.version,
    });
    await this.store.apply({ workspaceId: this.workspaceId, idempotencyKey: `rollback:${audit.id}`, operations });
    // A rollback may restore an existing fact as well as delete a newly
    // captured one. In both cases the external vector must be invalidated;
    // callers that need the restored fact indexed can enqueue a rebuild after
    // this transaction completes.
    return [...affectedFactIds];
  }

  async rollbackChangeSet(auditId: string): Promise<string[]> {
    const order = await this.rollbackOrder(auditId);
    if (order.length === 0) return [];
    // A single root ChangeSet is the complete Undo unit. Rebuildable
    // projections are invalidated by sourceChangeSetId and regenerated later.
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
    const write = this.derivedWriteTail.then(() => this.upsertDerivedNow(collection, records));
    this.derivedWriteTail = write.then(() => undefined, () => undefined);
    return write;
  }

  private async upsertDerivedNow(collection: 'profiles' | 'profile-claims' | 'relationship-claims' | 'memory-details' | 'memory-links' | 'vector-index' | 'graph-nodes' | 'graph-edges' | 'recall-exposures' | 'dream-jobs' | 'dream-audits' | 'dream-narratives', records: readonly Record<string, unknown>[]): Promise<void> {
    if (records.length === 0) return;
    const uniqueRecords = new Map<string, Record<string, unknown>>();
    for (const record of records) {
      const recordId = String(record.id ?? '');
      if (!recordId) throw new Error(`派生记录缺少 id：${collection}`);
      if (record.workspaceId !== undefined && String(record.workspaceId) !== this.workspaceId) throw new Error(`派生记录不属于当前工作区：${collection}`);
      if (record.chatKey !== undefined && String(record.chatKey) !== this.chatKey) throw new Error(`派生记录不属于当前聊天：${collection}`);
      // A projection batch can derive the same entity through multiple source
      // paths. Keep its final deterministic value so one Workspace transaction
      // never validates the same old revision twice.
      uniqueRecords.set(recordId, record);
    }
    const operations: StoreOperation[] = [];
    for (const record of uniqueRecords.values()) {
      const recordId = String(record.id ?? '');
      const persisted = { ...record, workspaceId: this.workspaceId, chatKey: this.chatKey };
      // Derived records are rebuildable caches and this repository serializes
      // their writes. Omitting an optimistic precondition keeps the final queued
      // projection authoritative without racing another projection revision.
      operations.push({ action: 'upsert', collection, recordId, value: asPlain(persisted) });
    }
    await this.store.apply({ workspaceId: this.workspaceId, idempotencyKey: `derived:${collection}:${crypto.randomUUID()}`, operations });
  }

  async upsertDerivedWithAudit(
    recordsByCollection: readonly { readonly collection: 'profiles' | 'profile-claims' | 'relationship-claims' | 'memory-details' | 'memory-links' | 'vector-index' | 'graph-nodes' | 'graph-edges' | 'recall-exposures' | 'dream-jobs' | 'dream-audits' | 'dream-narratives'; readonly records: readonly Record<string, unknown>[] }[],
    kind: ChangeAudit['kind'] = 'derived-change-set-v0',
    metadata?: Record<string, unknown>,
  ): Promise<ChangeAudit> {
    const auditId = `change-audit:${crypto.randomUUID()}`;
    const entries: ChangeEntry[] = [];
    const operations: StoreOperation[] = [];
    for (const group of recordsByCollection) {
      for (const record of group.records) {
        const recordId = String(record.id ?? '');
        if (!recordId) throw new Error(`派生记录缺少 id：${group.collection}`);
        if (record.workspaceId !== undefined && String(record.workspaceId) !== this.workspaceId) throw new Error(`派生记录不属于当前工作区：${group.collection}`);
        if (record.chatKey !== undefined && String(record.chatKey) !== this.chatKey) throw new Error(`派生记录不属于当前聊天：${group.collection}`);
        const before = await this.store.read({ workspaceId: this.workspaceId, collection: group.collection, recordId });
        const persisted = { ...record, workspaceId: this.workspaceId, chatKey: this.chatKey, sourceChangeSetId: record.sourceChangeSetId ?? auditId };
        entries.push({ collection: group.collection, recordId, ...(before ? { before: before.value } : {}), after: asPlain(persisted) });
        operations.push({ action: 'upsert', collection: group.collection, recordId, value: asPlain(persisted), expectedVersion: before?.version ?? 0 });
      }
    }
    const audit: ChangeAudit = { id: auditId, workspaceId: this.workspaceId, chatKey: this.chatKey, kind, createdAt: Date.now(), entries, ...(metadata ? { metadata: asPlain(metadata) } : {}) };
    operations.push({ action: 'upsert', collection: 'change-audits', recordId: audit.id, value: asPlain(audit) });
    await this.store.apply({ workspaceId: this.workspaceId, idempotencyKey: audit.id, operations });
    return audit;
  }

  /** Add derived writes to an existing Capture ChangeSet so one Undo restores
   * both source records and their projections. */
  async upsertDerivedForChangeSet(
    auditId: string,
    recordsByCollection: readonly { readonly collection: 'profiles' | 'profile-claims' | 'relationship-claims' | 'memory-details' | 'memory-links' | 'vector-index' | 'graph-nodes' | 'graph-edges' | 'recall-exposures' | 'dream-jobs' | 'dream-audits' | 'dream-narratives'; readonly records: readonly Record<string, unknown>[] }[],
  ): Promise<void> {
    const auditRecord = await this.store.read({ workspaceId: this.workspaceId, collection: 'change-audits', recordId: auditId });
    const audit = auditRecord?.value as unknown as ChangeAudit | undefined;
    if (!audit || audit.workspaceId !== this.workspaceId || audit.chatKey !== this.chatKey) throw new Error('找不到当前聊天要附加派生记录的 ChangeSet。');
    if (audit.rolledBackAt) throw new Error('不能向已回滚的 Capture ChangeSet 附加派生记录。');

    // Projections are rebuildable caches, not nested undo units. Keep only the
    // root sourceChangeSetId and write bounded chunks without child audits.
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
          },
        });
      }
    }
    const rows = [...flattened.values()];
    const chunkSize = 128;
    for (let offset = 0; offset < rows.length; offset += chunkSize) {
      const chunk = rows.slice(offset, offset + chunkSize);
      const grouped = new Map<typeof chunk[number]['collection'], Record<string, unknown>[]>();
      for (const item of chunk) {
        const records = grouped.get(item.collection) ?? [];
        records.push(item.record);
        grouped.set(item.collection, records);
      }
      for (const [collection, records] of grouped) await this.upsertDerived(collection, records);
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
    const operations: StoreOperation[] = [];
    const groups: readonly [string, readonly Persistable[]][] = [['actors', owners], ['actor-aliases', aliases]];
    for (const [collection, values] of groups) {
      for (const value of values) {
        const recordId = String(value.id);
        const before = await this.store.read({ workspaceId: this.workspaceId, collection, recordId });
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
      const before = await this.store.read({ workspaceId: this.workspaceId, collection: 'actor-candidates', recordId });
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
        const current = await this.store.read({ workspaceId: this.workspaceId, collection: 'memory-traces', recordId: trace.id });
        if (trace.chatKey !== this.chatKey) throw new Error('人物迁移源 Trace 不属于当前聊天。');
        const next = { ...trace, id: `trace:${migration.toOwnerId}:${trace.factId}`, ownerId: migration.toOwnerId, traceRevision: trace.traceRevision + 1, updatedAt: Date.now() };
        const target = await this.store.read({ workspaceId: this.workspaceId, collection: 'memory-traces', recordId: next.id });
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
        const target = await this.store.read({ workspaceId: this.workspaceId, collection, recordId: migratedRecordId });
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
        'cast-plan-audits', 'recall-coverage-logs', 'memory-usage-logs', 'capture-jobs', 'capture-repair-queue', 'change-audits',
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
    await this.store.apply({ workspaceId: this.workspaceId, idempotencyKey: audit.id, operations });
    return audit;
  }

  async clearCurrentChatData(): Promise<void> {
    const chatScopedCollections = ['actor-candidates', 'location-candidates', 'episodes', 'observations', 'facts', 'evidence', 'fact-heads', 'memory-traces', 'scene-casts', 'scene-states', 'scene-transitions', 'generation-cast-plans', 'cast-plan-audits', 'recall-coverage-logs', 'memory-usage-logs', 'capture-jobs', 'capture-repair-queue', 'change-audits', 'memory-details', 'memory-links', 'vector-index', 'graph-nodes', 'graph-edges', 'recall-exposures', 'dream-jobs', 'dream-audits', 'dream-narratives', 'usage', 'recall-logs', 'generation-recall-details', 'generation-prompt-snapshots', 'generation-prompt-snapshot-chunks'] as const;
    const operations: StoreOperation[] = [];
    // Observations intentionally point at an Episode instead of duplicating
    // chat metadata. Resolve the current chat's episode ids before deleting so
    // a chat switch cannot leave orphaned observations behind.
    const episodeIds = new Set((await this.list('episodes', { workspaceId: this.workspaceId, chatKey: this.chatKey })).map(record => record.recordId));
    for (const collection of chatScopedCollections) {
      if (this.unavailableOptionalCollections.has(collection)) continue;
      const records = collection === 'observations'
        ? (await this.list(collection, { workspaceId: this.workspaceId })).filter(record => episodeIds.has(String((record.value as { episodeId?: unknown }).episodeId ?? '')))
        : await this.list(
          collection,
          collection === 'usage' || collection === 'recall-logs'
            ? { chatKey: this.chatKey }
            : { workspaceId: this.workspaceId, chatKey: this.chatKey },
        );
      for (const record of records) operations.push({ action: 'delete', collection, recordId: record.recordId, expectedVersion: record.version });
    }
    if (operations.length > ATOMIC_TRANSACTION_MAX_OPERATIONS) throw migrationTooLargeError(operations.length);
    if (operations.length > 0) {
      await this.store.apply({
        workspaceId: this.workspaceId,
        idempotencyKey: `multi-actor-clear:${stableRecordHash(`${this.chatKey}\0${operations.map(operation => `${operation.collection}:${operation.recordId}:${operation.expectedVersion}`).join('|')}`)}`,
        operations,
      });
    }
    await this.store.vectors.clear({ workspaceId: this.workspaceId, collection: 'facts', metadata: { chatKey: this.chatKey } });
  }

  async clearAllData(): Promise<void> {
    const operations: StoreOperation[] = [];
    for (const collection of Object.keys(COLLECTIONS)) {
      if (this.unavailableOptionalCollections.has(collection)) continue;
      for (const record of await this.list(collection, { workspaceId: this.workspaceId })) {
        operations.push({ action: 'delete', collection, recordId: record.recordId, expectedVersion: record.version });
      }
    }
    if (operations.length > 0) await this.transactInBatches(operations, `multi-actor-clear-all:${this.workspaceId}:${Date.now()}`);
    await this.store.vectors.clear({ workspaceId: this.workspaceId, collection: 'facts' });
  }

  async upsertTraces(records: readonly ActorMemoryTrace[]): Promise<void> {
    if (records.length === 0) return;
    const operations: StoreOperation[] = [];
    for (const record of records) {
      const current = await this.store.read({ workspaceId: this.workspaceId, collection: 'memory-traces', recordId: record.id });
      operations.push({
        action: 'upsert',
        collection: 'memory-traces',
        recordId: record.id,
        value: asPlain({ ...record, chatKey: record.chatKey ?? this.chatKey }),
        expectedVersion: current?.version ?? 0,
      });
    }
    await this.store.apply({ workspaceId: this.workspaceId, idempotencyKey: `traces:${crypto.randomUUID()}`, operations });
  }
}

export type { CaptureCommit };
