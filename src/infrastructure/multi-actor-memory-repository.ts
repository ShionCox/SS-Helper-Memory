import type { PlainData, WorkspacePort, WorkspaceRecord, WorkspaceTransactionOperation } from '@ss-helper/sdk';
import {
  ACTIVE_CONFIDENCE_THRESHOLD,
  MAX_FACT_CONTENT_LENGTH,
  createCanonicalKey,
  createFactSlotKey,
  normalizeFactContent,
  type ActorAlias,
  type ActorCandidate,
  type ActorMemoryTrace,
  type CaptureEnvelope,
  type FactListOptions,
  type ManualFactInput,
  type MemoryEpisode,
  type MemoryFact,
  type MemoryEvidence,
  type MemoryObservation,
  type MemoryOwner,
  type SceneCast,
} from '../domain';

const COLLECTIONS = Object.freeze({
  actors: ['workspaceId', 'kind', 'canonicalName', 'status', 'updatedAt'],
  'actor-aliases': ['workspaceId', 'ownerId', 'normalizedValue', 'status', 'updatedAt'],
  'actor-candidates': ['workspaceId', 'chatKey', 'status', 'confidence', 'updatedAt'],
  episodes: ['workspaceId', 'chatKey', 'floorStart', 'occurredAt', 'createdAt'],
  observations: ['workspaceId', 'episodeId', 'sourceRef', 'speakerOwnerId', 'occurredAt'],
  facts: ['workspaceId', 'chatKey', 'status', 'kind', 'updatedAt'],
  evidence: ['workspaceId', 'chatKey', 'factId', 'occurredAt'],
  'fact-heads': ['workspaceId', 'chatKey', 'slotKey', 'factId'],
  'memory-traces': ['workspaceId', 'chatKey', 'ownerId', 'factId', 'updatedAt'],
  'scene-casts': ['workspaceId', 'chatKey', 'floor', 'createdAt'],
  'capture-jobs': ['workspaceId', 'chatKey', 'status', 'updatedAt'],
  'change-audits': ['workspaceId', 'chatKey', 'createdAt'],
  'memory-details': ['workspaceId', 'ownerId', 'traceId'],
  'memory-links': ['workspaceId', 'ownerId', 'updatedAt'],
  'vector-index': ['workspaceId', 'chatKey', 'recordId', 'updatedAt'],
  'graph-nodes': ['workspaceId', 'chatKey', 'entityKey', 'updatedAt'],
  'graph-edges': ['workspaceId', 'chatKey', 'fromNodeId', 'toNodeId', 'backingFactId', 'updatedAt'],
  profiles: ['workspaceId', 'ownerId', 'updatedAt'],
  'profile-claims': ['workspaceId', 'ownerId', 'level', 'updatedAt'],
  'relationship-claims': ['workspaceId', 'fromOwnerId', 'toOwnerId', 'updatedAt'],
  'recall-exposures': ['workspaceId', 'chatKey', 'ownerId', 'createdAt'],
  'dream-jobs': ['workspaceId', 'chatKey', 'ownerId', 'status', 'updatedAt'],
  'dream-audits': ['workspaceId', 'chatKey', 'ownerId', 'createdAt'],
  'dream-narratives': ['workspaceId', 'ownerId', 'createdAt'],
} as const);

type Persistable = MemoryOwner | ActorAlias | MemoryEpisode | MemoryObservation | MemoryFact | ActorMemoryTrace | SceneCast | Record<string, unknown>;
interface CaptureCommit {
  readonly envelope: CaptureEnvelope;
  /** Existing v0 progress record to fold into the Capture ChangeSet. */
  readonly captureJobId?: string;
  readonly owners: readonly MemoryOwner[];
  readonly aliases: readonly ActorAlias[];
  readonly pendingCandidates?: readonly ActorCandidate[];
  readonly episodes: readonly MemoryEpisode[];
  readonly observations: readonly MemoryObservation[];
  readonly facts: readonly MemoryFact[];
  readonly evidence: readonly Record<string, unknown>[];
  readonly traces: readonly ActorMemoryTrace[];
  readonly sceneCasts?: readonly SceneCast[];
}
interface ChangeEntry { collection: string; recordId: string; before?: PlainData; after?: PlainData; }
interface ChangeAudit { id: string; workspaceId: string; chatKey: string; kind: 'capture-change-set-v0' | 'derived-change-set-v0' | 'actor-registry-change-set-v0' | 'dream-change-set-v0'; createdAt: number; entries: readonly ChangeEntry[]; metadata?: PlainData; rolledBackAt?: number; }

function manualFactId(chatKey: string): string { return `fact:${encodeURIComponent(chatKey)}:manual:${crypto.randomUUID()}`; }
function factHeadId(chatKey: string, slotKey: string): string { return `fact-head:${encodeURIComponent(chatKey)}:${encodeURIComponent(slotKey)}`; }

function asPlain(value: unknown): PlainData { return structuredClone(value) as PlainData; }
function idOf(value: unknown): string { return String((value as { id?: unknown }).id ?? ''); }
function rows<T>(page: { records?: readonly WorkspaceRecord[] } | undefined): WorkspaceRecord[] { return [...(page?.records ?? [])]; }

const KNOWLEDGE_MODE_RANK: Readonly<Record<ActorMemoryTrace['knowledgeMode'], number>> = Object.freeze({ unknown: 0, suspected: 1, believed: 2, inferred: 3, heard: 4, experienced: 5, self_reported: 6, asserted: 7 });
const PRIVACY_RANK: Readonly<Record<ActorMemoryTrace['privacy'], number>> = Object.freeze({ public: 0, limited: 1, private: 2, secret: 3 });

/** New v0 persistence surface; it never reads or migrates the retired model. */
export class MultiActorMemoryRepository {
  private workspaceId = '';
  private chatKey = '';
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
    for (const [name, indexes] of Object.entries(COLLECTIONS)) await this.workspace.defineCollection({ workspaceId: this.workspaceId, name, indexes });
  }

  private async list(collection: string, filter?: Readonly<Record<string, PlainData>>): Promise<WorkspaceRecord[]> {
    const records: WorkspaceRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.workspace.query({ workspaceId: this.workspaceId, collection, filter, cursor, limit: 500 });
      records.push(...rows(page));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return records;
  }

  async listOwners(): Promise<MemoryOwner[]> { return (await this.list('actors', { workspaceId: this.workspaceId })).map(record => record.value as unknown as MemoryOwner); }
  async listAliases(): Promise<ActorAlias[]> { return (await this.list('actor-aliases', { workspaceId: this.workspaceId })).map(record => record.value as unknown as ActorAlias); }
  async listPendingCandidates(): Promise<ActorCandidate[]> {
    return (await this.list('actor-candidates', { workspaceId: this.workspaceId, chatKey: this.chatKey, status: 'pending' }))
      .map(record => record.value as unknown as ActorCandidate);
  }
  async listEpisodes(): Promise<MemoryEpisode[]> { return (await this.list('episodes', { workspaceId: this.workspaceId, chatKey: this.chatKey })).map(record => record.value as unknown as MemoryEpisode); }
  async listSceneCasts(): Promise<SceneCast[]> { return (await this.list('scene-casts', { workspaceId: this.workspaceId, chatKey: this.chatKey })).map(record => record.value as unknown as SceneCast); }
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
    return records
      .map(record => record.value as unknown as ActorMemoryTrace & { readonly chatKey?: string })
      .filter(trace => !trace.chatKey || trace.chatKey === this.chatKey);
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
    const slotKey = createFactSlotKey(subjectKey, predicateKey);
    const slotFacts = (await this.listFacts()).filter(fact => fact.slotKey === slotKey && (fact.status === 'active' || fact.status === 'pending') && fact.id !== id);
    const conflicting = previous ? undefined : slotFacts.sort((left, right) => Number(right.status === 'active') - Number(left.status === 'active') || right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))[0];
    const requestedStatus = input.status ?? previous?.status ?? 'active';
    const status = requestedStatus === 'active' && confidence < ACTIVE_CONFIDENCE_THRESHOLD ? 'pending' : requestedStatus;
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
    const headId = factHeadId(chatKey, slotKey);
    if (status === 'active' || status === 'pending') await addUpsert('fact-heads', headId, asPlain({ id: headId, workspaceId: this.workspaceId, chatKey, slotKey, factId: fact.id, updatedAt: timestamp }));
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
    operations.push({ action: 'upsert', collection: 'change-audits', recordId: audit.id, value: asPlain(audit) });
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
    const relatedIds = [target.supersedesId, target.supersededById].filter((value): value is string => Boolean(value));
    const related = await Promise.all(relatedIds.map(recordId => this.workspace.get({ workspaceId: this.workspaceId, collection: 'facts', recordId })));
    const replacementFacts: MemoryFact[] = [];
    for (const record of related) {
      if (!record) continue;
      const value = record.value as unknown as MemoryFact;
      const restored = { ...value, revision: value.revision + 1, updatedAt: Date.now() } as MemoryFact & { supersedesId?: string; supersededById?: string };
      if (restored.supersededById === factId) { delete restored.supersededById; restored.status = 'active'; }
      if (restored.supersedesId === factId) delete restored.supersedesId;
      if (restored.status === 'active' || restored.status === 'pending') replacementFacts.push(restored);
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
    const headId = factHeadId(chatKey, target.slotKey ?? createFactSlotKey(target.subjectKey, target.predicateKey));
    const head = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'fact-heads', recordId: headId });
    if (head && String((head.value as Record<string, unknown>).factId ?? '') === factId) {
      entries.push({ collection: 'fact-heads', recordId: headId, before: asPlain(head.value) });
      const replacement = replacementFacts.sort((left, right) => Number(right.status === 'active') - Number(left.status === 'active') || right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))[0];
      if (replacement) operations.push({ action: 'upsert', collection: 'fact-heads', recordId: headId, value: asPlain({ id: headId, workspaceId: this.workspaceId, chatKey, slotKey: target.slotKey ?? createFactSlotKey(target.subjectKey, target.predicateKey), factId: replacement.id, updatedAt: Date.now() }), expectedVersion: head.version });
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
    for (const value of commit.owners) await add('actors', value);
    for (const value of commit.aliases) await add('actor-aliases', value);
    const pendingCandidates = commit.pendingCandidates ?? [];
    for (const candidate of pendingCandidates) {
      const persisted = { ...candidate, id: candidate.localId, workspaceId: this.workspaceId, chatKey: this.chatKey, status: candidate.status ?? 'pending', updatedAt: Date.now() };
      await add('actor-candidates', persisted);
    }
    // Capture is append/merge work, not a review decision. A candidate that is
    // absent from this turn may simply have fallen outside the current scene;
    // retain it until the user explicitly confirms/corrects it through the
    // ActorRegistry transaction, which is the only operation allowed to prune
    // pending candidates.
    for (const value of commit.episodes) await add('episodes', value);
    for (const value of commit.observations) await add('observations', value);
    for (const value of commit.facts) await add('facts', value);
    // Reconciliation can submit a superseded predecessor and its replacement
    // in the same Capture. A slot has exactly one head, so collapse the batch
    // before building transaction operations; emitting two upserts for one id
    // would otherwise reuse the same expected version and conflict in a real
    // WorkspacePort transaction.
    const headBySlot = new Map<string, MemoryFact>();
    for (const fact of commit.facts) {
      if (fact.status !== 'active' && fact.status !== 'pending') continue;
      const slotKey = fact.slotKey ?? `${fact.subjectKey}::${fact.predicateKey}`;
      // `commit.facts` is already ordered by the reconciliation service, with
      // a replacement following its superseded predecessor. Last eligible
      // fact therefore wins the slot head even when both timestamps are from
      // the same Capture transaction.
      headBySlot.set(slotKey, fact);
    }
    for (const [slotKey, fact] of headBySlot) {
      await add('fact-heads', {
        id: `fact-head:${encodeURIComponent(this.chatKey)}:${encodeURIComponent(slotKey)}`,
        workspaceId: this.workspaceId,
        chatKey: this.chatKey,
        slotKey,
        factId: fact.id,
        updatedAt: fact.updatedAt,
      });
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
    const auditId = `change-audit:${crypto.randomUUID()}`;
    const captureJobId = commit.captureJobId ?? `capture-job:${auditId}`;
    const previousCaptureJob = commit.captureJobId
      ? await this.workspace.get({ workspaceId: this.workspaceId, collection: 'capture-jobs', recordId: commit.captureJobId })
      : undefined;
    const captureJob = {
      ...(previousCaptureJob?.value && typeof previousCaptureJob.value === 'object' ? previousCaptureJob.value as Record<string, unknown> : {}),
      id: captureJobId,
      workspaceId: this.workspaceId,
      chatKey: this.chatKey,
      status: 'completed',
      sourceRefs: [...commit.envelope.sourceRefs],
      actorCount: commit.owners.length,
      episodeCount: commit.episodes.length,
      observationCount: commit.observations.length,
      factCount: commit.facts.length,
      traceCount: commit.traces.length,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await add('capture-jobs', captureJob);
    const audit: ChangeAudit = { id: auditId, workspaceId: this.workspaceId, chatKey: this.chatKey, kind: 'capture-change-set-v0', createdAt: Date.now(), entries };
    operations.push({ action: 'upsert', collection: 'change-audits', recordId: audit.id, value: asPlain(audit) });
    await this.workspace.transaction({ workspaceId: this.workspaceId, idempotencyKey: audit.id, operations });
    return audit;
  }

  async rollbackChangeSet(auditId: string): Promise<void> {
    const auditRecord = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'change-audits', recordId: auditId });
    const audit = auditRecord?.value as unknown as ChangeAudit | undefined;
    if (!audit || !['capture-change-set-v0', 'derived-change-set-v0', 'actor-registry-change-set-v0', 'dream-change-set-v0'].includes(audit.kind)) throw new Error('找不到可回滚的多角色 ChangeSet。');
    const operations: WorkspaceTransactionOperation[] = [];
    const auditedKeys = new Set(audit.entries.map(entry => `${entry.collection}:${entry.recordId}`));
    const captureTraceIds = new Set(audit.kind === 'capture-change-set-v0'
      ? audit.entries.filter(entry => entry.collection === 'memory-traces' && entry.after !== undefined).map(entry => entry.recordId)
      : []);
    for (const entry of [...audit.entries].reverse()) {
      const current = await this.workspace.get({ workspaceId: this.workspaceId, collection: entry.collection, recordId: entry.recordId });
      if (entry.before === undefined) operations.push({ action: 'delete', collection: entry.collection, recordId: entry.recordId, ...(current ? { expectedVersion: current.version } : {}) });
      else {
        const restored = entry.collection === 'capture-jobs' && typeof entry.before === 'object'
          ? {
            ...(entry.before as Record<string, unknown>),
            status: ['running', 'completed'].includes(String((entry.before as Record<string, unknown>).status ?? '')) ? 'paused' : (entry.before as Record<string, unknown>).status,
            updatedAt: Date.now(),
          }
          : entry.before;
        operations.push({ action: 'upsert', collection: entry.collection, recordId: entry.recordId, value: asPlain(restored), ...(current ? { expectedVersion: current.version } : {}) });
      }
    }
    // Derived records carry their parent ChangeSet id. Remove them in the same
    // transaction so a Capture/Dream rollback cannot leave stale details,
    // links, profiles, vectors, graph nodes or exposures behind.
    const derivedCollections = ['memory-details', 'memory-links', 'vector-index', 'graph-nodes', 'graph-edges', 'profiles', 'profile-claims', 'relationship-claims', 'recall-exposures', 'dream-jobs', 'dream-audits', 'dream-narratives'] as const;
    for (const collection of derivedCollections) {
      const records = await this.list(collection, { workspaceId: this.workspaceId });
      for (const record of records) {
        const value = record.value as Record<string, unknown>;
        const traceExposureCreatedDuringCapture = collection === 'recall-exposures'
          && captureTraceIds.has(String(value.traceId ?? ''))
          && Number(value.createdAt ?? 0) >= audit.createdAt;
        if ((value.sourceChangeSetId === audit.id || value.parentChangeSetId === audit.id || traceExposureCreatedDuringCapture)
          && !auditedKeys.has(`${collection}:${record.recordId}`)) {
          const current = await this.workspace.get({ workspaceId: this.workspaceId, collection, recordId: record.recordId });
          operations.push({ action: 'delete', collection, recordId: record.recordId, ...(current ? { expectedVersion: current.version } : {}) });
        }
      }
    }
    operations.push({ action: 'upsert', collection: 'change-audits', recordId: audit.id, value: asPlain({ ...audit, rolledBackAt: Date.now() }) });
    await this.workspace.transaction({ workspaceId: this.workspaceId, idempotencyKey: `rollback:${auditId}`, operations });
    // A rollback may restore an existing fact as well as delete a newly
    // captured one. In both cases the external vector must be invalidated;
    // callers that need the restored fact indexed can enqueue a rebuild after
    // this transaction completes.
    const invalidatedFactIds = audit.entries
      .filter(entry => entry.collection === 'facts')
      .map(entry => entry.recordId);
    await this.deleteFactVectors(invalidatedFactIds);
  }

  async upsertDerived(collection: 'profiles' | 'profile-claims' | 'relationship-claims' | 'memory-details' | 'memory-links' | 'vector-index' | 'graph-nodes' | 'graph-edges' | 'recall-exposures' | 'dream-jobs' | 'dream-audits' | 'dream-narratives', records: readonly Record<string, unknown>[]): Promise<void> {
    if (records.length === 0) return;
    const operations: WorkspaceTransactionOperation[] = [];
    for (const record of records) {
      const recordId = String(record.id ?? '');
      if (!recordId) throw new Error(`派生记录缺少 id：${collection}`);
      const current = await this.workspace.get({ workspaceId: this.workspaceId, collection, recordId });
      const persisted = { ...record, workspaceId: record.workspaceId ?? this.workspaceId, chatKey: record.chatKey ?? this.chatKey };
      operations.push({ action: 'upsert', collection, recordId, value: asPlain(persisted), expectedVersion: current?.version ?? 0 });
    }
    await this.workspace.transaction({ workspaceId: this.workspaceId, idempotencyKey: `derived:${collection}:${Date.now()}`, operations });
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
        const before = await this.workspace.get({ workspaceId: this.workspaceId, collection: group.collection, recordId });
        const persisted = { ...record, workspaceId: record.workspaceId ?? this.workspaceId, chatKey: record.chatKey ?? this.chatKey, sourceChangeSetId: record.sourceChangeSetId ?? auditId };
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
    if (!audit) throw new Error('找不到要附加派生记录的 ChangeSet。');
    const entries = [...audit.entries];
    const operations: WorkspaceTransactionOperation[] = [];
    for (const group of recordsByCollection) {
      for (const record of group.records) {
        const recordId = String(record.id ?? '');
        if (!recordId) throw new Error(`派生记录缺少 id：${group.collection}`);
        const before = await this.workspace.get({ workspaceId: this.workspaceId, collection: group.collection, recordId });
        const persisted = { ...record, workspaceId: record.workspaceId ?? this.workspaceId, chatKey: record.chatKey ?? this.chatKey, sourceChangeSetId: record.sourceChangeSetId ?? auditId };
        entries.push({ collection: group.collection, recordId, ...(before ? { before: before.value } : {}), after: asPlain(persisted) });
        operations.push({ action: 'upsert', collection: group.collection, recordId, value: asPlain(persisted), expectedVersion: before?.version ?? 0 });
      }
    }
    operations.push({ action: 'upsert', collection: 'change-audits', recordId: auditId, value: asPlain({ ...audit, entries }) });
    await this.workspace.transaction({ workspaceId: this.workspaceId, idempotencyKey: `derived-attach:${auditId}:${Date.now()}`, operations });
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
      const persisted = { ...candidate, id: candidate.localId, workspaceId: this.workspaceId, chatKey: this.chatKey, status: candidate.status ?? 'pending', updatedAt: Date.now() };
      const before = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'actor-candidates', recordId: candidate.localId });
      entries.push({ collection: 'actor-candidates', recordId: candidate.localId, ...(before ? { before: before.value } : {}), after: asPlain(persisted) });
      operations.push({ action: 'upsert', collection: 'actor-candidates', recordId: candidate.localId, value: asPlain(persisted), expectedVersion: before?.version ?? 0 });
    }
    const existingCandidates = await this.list('actor-candidates', { workspaceId: this.workspaceId, chatKey: this.chatKey });
    const desiredCandidateIds = new Set(pendingCandidates.map(candidate => candidate.localId));
    for (const record of existingCandidates) {
      if (!desiredCandidateIds.has(record.recordId)) {
        entries.push({ collection: 'actor-candidates', recordId: record.recordId, before: record.value });
        operations.push({ action: 'delete', collection: 'actor-candidates', recordId: record.recordId, expectedVersion: record.version });
      }
    }
    if (migration) {
      for (const trace of await this.listTraces(migration.fromOwnerId)) {
        const current = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'memory-traces', recordId: trace.id });
        const next = { ...trace, id: `trace:${migration.toOwnerId}:${trace.factId}`, ownerId: migration.toOwnerId, chatKey: trace.chatKey ?? this.chatKey, traceRevision: trace.traceRevision + 1, updatedAt: Date.now() };
        const target = await this.workspace.get({ workspaceId: this.workspaceId, collection: 'memory-traces', recordId: next.id });
        const targetValue = target?.value as unknown as ActorMemoryTrace | undefined;
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
      }
    }
    const audit: ChangeAudit = { id: `change-audit:${crypto.randomUUID()}`, workspaceId: this.workspaceId, chatKey: this.chatKey, kind: 'actor-registry-change-set-v0', createdAt: Date.now(), entries, ...(metadata ? { metadata: asPlain(metadata) } : {}) };
    operations.push({ action: 'upsert', collection: 'change-audits', recordId: audit.id, value: asPlain(audit) });
    await this.workspace.transaction({ workspaceId: this.workspaceId, idempotencyKey: audit.id, operations });
    return audit;
  }

  async clearCurrentChatData(): Promise<void> {
    const chatScopedCollections = ['actor-candidates', 'episodes', 'observations', 'facts', 'evidence', 'fact-heads', 'memory-traces', 'scene-casts', 'capture-jobs', 'change-audits', 'memory-details', 'memory-links', 'vector-index', 'graph-nodes', 'graph-edges', 'recall-exposures', 'dream-jobs', 'dream-audits', 'dream-narratives'] as const;
    const operations: WorkspaceTransactionOperation[] = [];
    // Observations intentionally point at an Episode instead of duplicating
    // chat metadata. Resolve the current chat's episode ids before deleting so
    // a chat switch cannot leave orphaned observations behind.
    const episodeIds = new Set((await this.list('episodes', { workspaceId: this.workspaceId, chatKey: this.chatKey })).map(record => record.recordId));
    for (const collection of chatScopedCollections) {
      const records = collection === 'observations'
        ? (await this.list(collection, { workspaceId: this.workspaceId })).filter(record => episodeIds.has(String((record.value as { episodeId?: unknown }).episodeId ?? '')))
        : await this.list(collection, { workspaceId: this.workspaceId, chatKey: this.chatKey });
      for (const record of records) operations.push({ action: 'delete', collection, recordId: record.recordId, expectedVersion: record.version });
    }
    if (operations.length > 0) await this.workspace.transaction({ workspaceId: this.workspaceId, idempotencyKey: `multi-actor-clear:${this.chatKey}:${Date.now()}`, operations });
    await this.workspace.vectorClear({ workspaceId: this.workspaceId, collection: 'facts', metadata: { chatKey: this.chatKey } }).catch(() => 0);
  }

  async clearAllData(): Promise<void> {
    const operations: WorkspaceTransactionOperation[] = [];
    for (const collection of Object.keys(COLLECTIONS)) {
      for (const record of await this.list(collection, { workspaceId: this.workspaceId })) {
        operations.push({ action: 'delete', collection, recordId: record.recordId, expectedVersion: record.version });
      }
    }
    if (operations.length > 0) await this.workspace.transaction({ workspaceId: this.workspaceId, idempotencyKey: `multi-actor-clear-all:${this.workspaceId}:${Date.now()}`, operations });
    await this.workspace.vectorClear({ workspaceId: this.workspaceId, collection: 'facts' }).catch(() => 0);
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
    await this.workspace.transaction({ workspaceId: this.workspaceId, idempotencyKey: `traces:${Date.now()}`, operations });
  }
}

export type { CaptureCommit, ChangeAudit };
