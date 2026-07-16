import type { IngestCommit, IngestCommitter } from '../application/ingest/types';
import type {
  PlainData,
  WorkspacePort,
  WorkspaceRecord,
  WorkspaceTransactionOperation,
} from '@ss-helper/sdk';
import {
  ACTIVE_CONFIDENCE_THRESHOLD,
  MAX_FACT_CONTENT_LENGTH,
  createCanonicalKey,
  createFactSlotKey,
  decideFactReconciliation,
  normalizeFactContent,
  validateAutomaticProposal,
  type AutomaticFactProposal,
  AutomaticIngestResult,
  FactListOptions,
  MainChatUsage,
  ManualFactInput,
  MemoryBatchSnapshot,
  MemoryEvidence,
  MemoryFact,
  MemoryFactVector,
  MemoryFactVectorCoverage,
  MemoryFactVectorTarget,
  MemoryJob,
  MemoryJobBatchAudit,
  MemoryRecallLog,
  MemorySettingRecord,
  UpsertMemoryFactVectorInput,
} from '../domain';
import { float32ArrayToArrayBuffer, sha256Content } from './vector/vector-utils';

const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 500;
const QUERY_PAGE_SIZE = 1_000;
const SETTINGS_WORKSPACE_ID = 'settings:global';
const COLLECTIONS = Object.freeze({
  facts: ['status', 'kind', 'slotKey', 'chatKey', 'updatedAt'],
  'fact-slots': ['factId'],
  evidence: ['factId', 'chatKey', 'occurredAt'],
  jobs: ['chatKey', 'status', 'type', 'updatedAt'],
  'job-audits': ['chatKey', 'jobId', 'batchIndex', 'completedAt'],
  usage: ['chatKey', 'capturedAt'],
  'recall-logs': ['chatKey', 'createdAt'],
} as const);

export interface MemoryWorkspaceHealth {
  connected: boolean;
  serverVersion: string;
  nodeVersion: string;
  protocolVersion: number;
  sqliteVersion: string;
  schemaVersion: number;
  databasePath: string;
  databaseSizeBytes: number;
  walMode: string;
  tableCounts: Record<string, number>;
  tableBytes: Record<string, number | null>;
  vectorCoverage?: { indexedFacts?: number; eligibleFacts?: number; ratio?: number; ready?: number; totalFacts?: number; coverage?: number };
  lastError?: string | { message?: string };
}

export interface MemoryWorkspaceBootstrap<TFact> extends MemoryWorkspaceHealth { facts: TFact[]; }

function asPlain(value: unknown): PlainData { return structuredClone(value) as PlainData; }
function workspaceErrorCode(error: unknown): string | undefined { return error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : undefined; }

function clampLimit(limit: number | undefined): number {
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.trunc(limit ?? DEFAULT_SEARCH_LIMIT)));
}

function createId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${uuid}`;
}

interface UndoLogEntry {
  collection: 'facts' | 'evidence' | 'fact-slots';
  recordId: string;
  before?: PlainData;
  after?: PlainData;
  beforeRevision: number;
  afterRevision?: number;
}

interface UndoLogV2 {
  id: string;
  kind: 'undo-log-v2';
  chatKey: string;
  jobId: string;
  batchIndex: number;
  transactionId: string;
  committedSequence: number;
  entries: readonly UndoLogEntry[];
  result?: AutomaticIngestResult;
  createdAt: number;
  rolledBackAt?: number;
  rolledBackBy?: string;
}

interface RollbackMarkerV2 {
  id: string;
  kind: 'rollback-v2';
  chatKey: string;
  jobId: string;
  batchIndex: number;
  status: 'index-repair-pending' | 'completed';
  affectedLogIds: string[];
  affectedFactIds: string[];
  createdAt: number;
  completedAt?: number;
}

let lastCommittedSequence = 0;
function nextCommittedSequence(): number { lastCommittedSequence = Math.max(lastCommittedSequence + 1, Date.now() * 1_000); return lastCommittedSequence; }
function undoRecordKey(entry: UndoLogEntry): string { return `${entry.collection}\0${entry.recordId}`; }

function samePlainData(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function evidenceId(factId: string, sourceRef: string, excerpt: string): string {
  return `evidence:${factId}:${stableHash(`${sourceRef}\n${excerpt}`)}`;
}

function rows<T>(value: T[] | { items?: T[] } | undefined | null): T[] {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.items) ? value.items : [];
}

/** Memory 的唯一仓储。领域逻辑留在 Memory，持久化只使用 SDK 通用 WorkspacePort。 */
export class MemoryRepository implements IngestCommitter {
  private healthSnapshot: MemoryWorkspaceHealth | null = null;
  private workspaceId = '';
  private sourceChatKey = '';

  constructor(readonly workspace: WorkspacePort) {}

  bind(workspaceId: string, sourceChatKey: string): void {
    this.workspaceId = workspaceId.trim();
    this.sourceChatKey = sourceChatKey.trim();
  }

  private requireWorkspaceId(): string {
    if (!this.workspaceId) throw new Error('当前角色或群组缺少稳定 ID，Memory workspace 未启用。');
    return this.workspaceId;
  }

  private async ensureCollections(workspaceId: string): Promise<void> {
    await this.workspace.open({ workspaceId, create: true, metadata: { kind: workspaceId.startsWith('group:') ? 'group' : workspaceId === SETTINGS_WORKSPACE_ID ? 'settings' : 'character' } });
    if (workspaceId === SETTINGS_WORKSPACE_ID) {
      await this.workspace.defineCollection({ workspaceId, name: 'settings', indexes: ['key'] });
      return;
    }
    for (const [name, indexes] of Object.entries(COLLECTIONS)) await this.workspace.defineCollection({ workspaceId, name, indexes });
  }

  async open(): Promise<void> {
    const health = await this.workspace.health();
    if (!health.ready) throw new Error(health.error || 'SS-Helper workspace 数据库未连接。');
    await this.ensureCollections(SETTINGS_WORKSPACE_ID);
    if (this.workspaceId) await this.ensureCollections(this.workspaceId);
    this.healthSnapshot = await this.refreshHealth();
  }

  close(): void {
    this.healthSnapshot = null;
  }

  getHealthSnapshot(): MemoryWorkspaceHealth | null {
    return this.healthSnapshot ? structuredClone(this.healthSnapshot) : null;
  }

  async refreshHealth(_chatKey?: string): Promise<MemoryWorkspaceHealth> {
    const health = await this.workspace.health();
    const tableCounts: Record<string, number> = {};
    if (health.ready && this.workspaceId) {
      for (const name of Object.keys(COLLECTIONS)) tableCounts[name.replaceAll('-', '_')] = (await this.listAllRecordRows(name)).length;
      tableCounts.fact_vectors = (await this.listAllVectors()).length;
    }
    this.healthSnapshot = {
      connected: health.ready,
      serverVersion: 'SS-Helper SDK 1.0.0',
      nodeVersion: 'SillyTavern server',
      protocolVersion: 1,
      sqliteVersion: health.sqliteVersion ?? 'N/A',
      schemaVersion: health.schemaVersion,
      databasePath: `data/_ss-helper/${health.database}`,
      databaseSizeBytes: 0,
      walMode: health.walMode ?? 'N/A',
      tableCounts,
      tableBytes: {},
      ...(health.error ? { lastError: health.error } : {}),
    };
    return structuredClone(this.healthSnapshot);
  }

  async bootstrap(chatKey: string): Promise<MemoryWorkspaceBootstrap<MemoryFact>> {
    const health = await this.refreshHealth(chatKey);
    return { ...health, facts: await this.listAllFacts(chatKey) };
  }

  private async listAllRecordRows(collection: string, filter: Record<string, PlainData> = {}, orderBy?: { field: string; direction: 'asc' | 'desc' }, workspaceId = this.requireWorkspaceId()): Promise<WorkspaceRecord[]> {
    const records: WorkspaceRecord[] = []; let cursor: string | undefined;
    do {
      const page = await this.workspace.query({ workspaceId, collection, filter, ...(orderBy ? { orderBy } : {}), ...(cursor ? { cursor } : {}), limit: QUERY_PAGE_SIZE });
      records.push(...page.records); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return records;
  }

  private async listAllRows<T>(collection: string, filters: Record<string, PlainData> = {}): Promise<T[]> {
    return (await this.listAllRecordRows(collection, filters)).map((record) => record.value as T);
  }

  private async listAllFacts(_chatKey?: string, filters: Record<string, PlainData> = {}): Promise<MemoryFact[]> {
    return this.listAllRows<MemoryFact>('facts', filters);
  }

  private async listAllVectors() {
    const vectors = []; let cursor: string | undefined;
    do { const page = await this.workspace.vectorList({ workspaceId: this.requireWorkspaceId(), ...(cursor ? { cursor } : {}), limit: QUERY_PAGE_SIZE }); vectors.push(...page.vectors); cursor = page.nextCursor ?? undefined; } while (cursor);
    return vectors;
  }

  async listFacts(chatKey: string, options: FactListOptions = {}): Promise<MemoryFact[]> {
    const facts = await this.listAllFacts(chatKey, {
      ...(options.status ? { status: options.status } : {}),
      ...(options.kind ? { kind: options.kind } : {}),
    });
    return options.limit === undefined ? facts : facts.slice(0, clampLimit(options.limit));
  }

  list(chatKey: string, options: FactListOptions = {}): Promise<MemoryFact[]> {
    return this.listFacts(chatKey, options);
  }

  async searchFacts(chatKey: string, query: string, limit = DEFAULT_SEARCH_LIMIT): Promise<MemoryFact[]> {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return [];
    return (await this.listAllFacts(chatKey)).filter((fact) => [fact.content, fact.canonicalKey, ...fact.entityKeys].some((value) => value.toLocaleLowerCase().includes(needle))).slice(0, clampLimit(limit));
  }

  search(chatKey: string, query: string, limit = DEFAULT_SEARCH_LIMIT): Promise<MemoryFact[]> {
    return this.searchFacts(chatKey, query, limit);
  }

  async getFact(chatKey: string, id: string): Promise<MemoryFact | undefined> {
    const result = await this.workspace.get({ workspaceId: this.requireWorkspaceId(), collection: 'facts', recordId: id });
    return result?.value as MemoryFact | undefined;
  }

  async upsertManualFact(chatKey: string, input: ManualFactInput): Promise<MemoryFact> {
    const content = normalizeFactContent(input.content);
    if (!content || Array.from(content).length > MAX_FACT_CONTENT_LENGTH) {
      throw new Error(`手动记忆正文必须为 1–${MAX_FACT_CONTENT_LENGTH} 字。`);
    }
    const confidence = input.confidence ?? 1;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error('手动记忆置信度必须位于 0 到 1 之间。');
    }
    const id = input.id ?? createId('fact');
    const previousRecord = await this.workspace.get({ workspaceId: this.requireWorkspaceId(), collection: 'facts', recordId: id });
    const previous = previousRecord?.value as MemoryFact | undefined;
    const slotKey = createFactSlotKey(input.subjectKey, input.predicateKey);
    if (previous && previous.slotKey !== slotKey && (previous.supersedesId || previous.supersededById)) {
      throw new Error('已形成历史链的记忆不能修改主体或谓词；请新增记忆或先删除历史链。');
    }
    const slotFacts = (await this.listFacts(chatKey))
      .filter(item => item.slotKey === slotKey && (item.status === 'active' || item.status === 'pending'))
      .sort((left, right) => {
        const status = Number(right.status === 'active') - Number(left.status === 'active');
        return status
          || right.freshestEvidenceAt - left.freshestEvidenceAt
          || right.updatedAt - left.updatedAt
          || left.id.localeCompare(right.id);
      });
    const expectedSlotFactId = slotFacts[0]?.id ?? null;
    const now = Date.now();
    const sourceRef = `manual:${id}`;
    const evidenceKey = evidenceId(id, sourceRef, content);
    const requestedStatus = input.status ?? previous?.status ?? 'active';
    const status = requestedStatus === 'active' && confidence < ACTIVE_CONFIDENCE_THRESHOLD
      ? 'pending'
      : requestedStatus;
    const fact: MemoryFact = {
      id,
      chatKey,
      kind: input.kind,
      subjectKey: input.subjectKey.trim(),
      predicateKey: input.predicateKey.trim(),
      ...(input.objectKey === undefined ? {} : { objectKey: input.objectKey.trim() }),
      canonicalKey: createCanonicalKey(input.subjectKey, input.predicateKey, input.objectKey),
      slotKey,
      content,
      entityKeys: [...new Set(input.entityKeys ?? [])],
      confidence,
      status,
      sourceRefs: [sourceRef],
      evidenceIds: [evidenceKey],
      freshestEvidenceAt: now,
      ...(input.validFrom === undefined ? {} : { validFrom: input.validFrom }),
      ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }),
      ...(input.stableAnchor === undefined ? {} : { stableAnchor: input.stableAnchor }),
      ...(input.scope === undefined ? {} : { scope: structuredClone(input.scope) }),
      origin: 'manual',
      revision: (previous?.revision ?? 0) + 1,
      ...(previous?.supersedesId ? { supersedesId: previous.supersedesId } : {}),
      ...(previous?.supersededById ? { supersededById: previous.supersededById } : {}),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    const evidence: MemoryEvidence = {
      id: evidenceKey,
      factId: id,
      chatKey,
      sourceRef,
      sourceType: 'manual',
      excerpt: content,
      occurredAt: now,
      createdAt: now,
    };
    const conflicting = !previous && (status === 'active' || status === 'pending')
      ? slotFacts[0]
      : undefined;
    if (conflicting) fact.supersedesId = conflicting.id;
    const relatedFacts = conflicting ? [{
      ...conflicting,
      status: 'superseded' as const,
      supersededById: id,
      revision: conflicting.revision + 1,
      updatedAt: now,
    }] : [];
    const workspaceId = this.requireWorkspaceId();
    const slotRecord = await this.workspace.get({ workspaceId, collection: 'fact-slots', recordId: slotKey });
    const slotValue = slotRecord?.value as { factId?: string } | undefined;
    if ((slotValue?.factId ?? null) !== expectedSlotFactId) throw Object.assign(new Error('记忆槽位已变化，请刷新后重试。'), { code: 'WORKSPACE_CONFLICT' });
    const operations: WorkspaceTransactionOperation[] = [
      { action: 'upsert', collection: 'facts', recordId: fact.id, value: asPlain(fact), expectedVersion: previousRecord?.version ?? 0 },
      { action: 'upsert', collection: 'evidence', recordId: evidence.id, value: asPlain(evidence) },
    ];
    for (const related of relatedFacts) {
      const record = await this.workspace.get({ workspaceId, collection: 'facts', recordId: related.id });
      operations.push({ action: 'upsert', collection: 'facts', recordId: related.id, value: asPlain(related), expectedVersion: record?.version ?? 0 });
    }
    if (status === 'active' || status === 'pending') operations.push({ action: 'upsert', collection: 'fact-slots', recordId: slotKey, value: { factId: fact.id }, expectedVersion: slotRecord?.version ?? 0 });
    await this.workspace.transaction({ workspaceId, operations });
    return fact;
  }

  upsert(chatKey: string, input: ManualFactInput): Promise<MemoryFact> {
    return this.upsertManualFact(chatKey, input);
  }

  async removeFact(chatKey: string, id: string): Promise<boolean> {
    const workspaceId = this.requireWorkspaceId();
    const targetRecord = await this.workspace.get({ workspaceId, collection: 'facts', recordId: id });
    const target = targetRecord?.value as MemoryFact | undefined;
    if (!target || !targetRecord) return false;
    const relatedIds = [target.supersedesId, target.supersededById].filter((value): value is string => Boolean(value));
    const relatedRecords = await Promise.all(relatedIds.map((recordId) => this.workspace.get({ workspaceId, collection: 'facts', recordId })));
    if (relatedRecords.some(item => !item)) throw new Error('记忆历史链已变化，请刷新后重试。');
    const operations: WorkspaceTransactionOperation[] = [{ action: 'delete', collection: 'facts', recordId: id, expectedVersion: targetRecord.version }];
    for (const record of relatedRecords) {
      const value = structuredClone(record!.value as unknown as MemoryFact);
      if (value.supersededById === id) { delete value.supersededById; value.status = 'active'; }
      if (value.supersedesId === id) delete value.supersedesId;
      value.revision += 1; value.updatedAt = Date.now();
      operations.push({ action: 'upsert', collection: 'facts', recordId: value.id, value: asPlain(value), expectedVersion: record!.version });
    }
    const evidence = await this.listAllRecordRows('evidence', { factId: id });
    for (const record of evidence) operations.push({ action: 'delete', collection: 'evidence', recordId: record.recordId, expectedVersion: record.version });
    if (target.slotKey) {
      const slot = await this.workspace.get({ workspaceId, collection: 'fact-slots', recordId: target.slotKey });
      if (slot) {
        const replacement = relatedRecords.map((record) => record!.value as unknown as MemoryFact).find((fact) => fact.status === 'active' || fact.status === 'pending');
        operations.push(replacement
          ? { action: 'upsert', collection: 'fact-slots', recordId: target.slotKey, value: { factId: replacement.id }, expectedVersion: slot.version }
          : { action: 'delete', collection: 'fact-slots', recordId: target.slotKey, expectedVersion: slot.version });
      }
    }
    await this.workspace.transaction({ workspaceId, operations });
    await this.workspace.vectorDelete({ workspaceId, collection: 'facts', recordId: id }).catch(() => false);
    return true;
  }

  remove(chatKey: string, id: string): Promise<boolean> {
    return this.removeFact(chatKey, id);
  }

  async listEvidence(chatKey: string, factId: string): Promise<MemoryEvidence[]> {
    void chatKey;
    return this.listAllRows<MemoryEvidence>('evidence', { factId });
  }

  async commitIngest(input: IngestCommit, retryAttempt = 0): Promise<AutomaticIngestResult> {
    const startedAt = Date.now();
    const batchIndex = input.checkpoint.batchIndex ?? 1;
    const undoLogId = `undo-v2:${input.jobId}:${batchIndex}`;
    const existingUndo = await this.workspace.get({ workspaceId: this.requireWorkspaceId(), collection: 'job-audits', recordId: undoLogId });
    if (existingUndo) {
      const log = existingUndo.value as unknown as UndoLogV2;
      if (log.kind !== 'undo-log-v2' || log.chatKey !== input.chatKey || !log.result) {
        throw Object.assign(new Error('整理批次幂等标识冲突。'), { code: 'WORKSPACE_CONFLICT' });
      }
      return structuredClone(log.result);
    }
    const sourceRows = input.sources.map(source => ({
      id: source.id,
      chatKey: source.chatKey,
      type: source.kind,
      content: source.content,
      occurredAt: source.createdAt,
      ...(source.floor === undefined ? {} : { floor: source.floor }),
    }));
    if (sourceRows.some(source => source.chatKey !== input.chatKey)) {
      throw new Error('整理批次包含其他聊天的来源，事务已取消。');
    }
    const rejected = structuredClone(input.rejections ?? []);
    const proposals = input.facts.map((proposal, index) => {
      const automatic: AutomaticFactProposal = {
        kind: proposal.kind,
        subjectKey: proposal.subjectKey,
        predicateKey: proposal.predicateKey,
        ...(proposal.objectKey === undefined ? {} : { objectKey: proposal.objectKey }),
        content: proposal.content,
        entityKeys: proposal.entityKeys,
        confidence: proposal.confidence,
        evidence: [{ sourceRef: proposal.sourceRef, excerpt: proposal.evidenceExcerpt }],
        ...(proposal.validFrom === undefined ? {} : { validFrom: proposal.validFrom }),
        ...(proposal.validTo === undefined ? {} : { validUntil: proposal.validTo }),
        ...(proposal.stable === undefined ? {} : { stableAnchor: proposal.stable }),
        ...(proposal.scope === undefined ? {} : { scope: proposal.scope }),
      };
      const validation = validateAutomaticProposal(automatic, sourceRows);
      if (!validation.ok) {
        rejected.push({ index, code: validation.code, message: validation.message });
        return null;
      }
      return validation.value;
    }).filter(value => value !== null);
    if (rejected.length > (input.rejections?.length ?? 0)) {
      throw new Error(`记忆批次包含无效事实，事务已取消：${rejected.at(-1)?.message ?? ''}`);
    }

    const beforeFactRecords = await this.listAllRecordRows('facts');
    const beforeFacts = beforeFactRecords.map((record) => record.value as unknown as MemoryFact);
    const beforeRecordById = new Map(beforeFactRecords.map((record) => [record.recordId, record]));
    const touchedSlots = new Set(proposals.map(proposal => proposal.slotKey));
    const baseSlotFactIds = Object.fromEntries([...touchedSlots].map(slotKey => [
      slotKey,
      beforeFacts
        .filter(fact => fact.slotKey === slotKey && (fact.status === 'active' || fact.status === 'pending'))
        .sort((left, right) => {
          if (left.status !== right.status) return left.status === 'active' ? -1 : 1;
          return right.freshestEvidenceAt - left.freshestEvidenceAt
            || right.updatedAt - left.updatedAt
            || left.id.localeCompare(right.id);
        })[0]?.id ?? null,
    ]));
    const workingFacts = new Map(beforeFacts.map(fact => [fact.id, structuredClone(fact)]));
    const changedFacts = new Map<string, MemoryFact>();
    const changedEvidence: MemoryEvidence[] = [];
    const result: AutomaticIngestResult = {
      facts: [], accepted: 0, duplicated: 0, pending: 0, superseded: 0, rejected,
    };
    const sourceById = new Map(sourceRows.map(source => [source.id, source]));

    for (const proposal of proposals) {
      const candidates = [...workingFacts.values()].filter(fact => fact.slotKey === proposal.slotKey
        && (fact.status === 'active' || fact.status === 'pending'));
      const duplicate = candidates.find(fact => decideFactReconciliation(fact, proposal) === 'duplicate');
      const existing = duplicate ?? candidates.sort((left, right) => {
        if (left.status !== right.status) return left.status === 'active' ? -1 : 1;
        return right.freshestEvidenceAt - left.freshestEvidenceAt;
      })[0];
      const hasNovelSource = existing
        ? proposal.sourceRefs.some(sourceRef => !existing.sourceRefs.includes(sourceRef))
        : true;
      const decision = decideFactReconciliation(existing, existing && !hasNovelSource
        ? { ...proposal, freshestEvidenceAt: existing.freshestEvidenceAt }
        : proposal);
      const now = Date.now();

      if (decision === 'duplicate' && existing) {
        const evidence = proposal.evidence.map(item => {
          const source = sourceById.get(item.sourceRef)!;
          return {
            id: evidenceId(existing.id, source.id, item.excerpt), factId: existing.id,
            chatKey: input.chatKey, sourceRef: source.id, sourceType: source.type,
            excerpt: item.excerpt, ...(source.floor === undefined ? {} : { floor: source.floor }),
            occurredAt: source.occurredAt, createdAt: now,
          } satisfies MemoryEvidence;
        });
        const merged: MemoryFact = {
          ...existing,
          confidence: Math.max(existing.confidence, proposal.confidence),
          status: existing.status === 'pending' && proposal.status === 'active' ? 'active' : existing.status,
          sourceRefs: [...new Set([...existing.sourceRefs, ...proposal.sourceRefs])],
          evidenceIds: [...new Set([...existing.evidenceIds, ...evidence.map(item => item.id)])],
          freshestEvidenceAt: Math.max(existing.freshestEvidenceAt, proposal.freshestEvidenceAt),
          revision: existing.revision + 1,
          updatedAt: now,
        };
        workingFacts.set(merged.id, merged);
        changedFacts.set(merged.id, merged);
        changedEvidence.push(...evidence);
        result.facts.push(merged);
        result.duplicated += 1;
        continue;
      }

      const id = createId('fact');
      const effectiveStatus = decision === 'pending' ? 'pending' : proposal.status;
      const evidence = proposal.evidence.map(item => {
        const source = sourceById.get(item.sourceRef)!;
        return {
          id: evidenceId(id, source.id, item.excerpt), factId: id,
          chatKey: input.chatKey, sourceRef: source.id, sourceType: source.type,
          excerpt: item.excerpt, ...(source.floor === undefined ? {} : { floor: source.floor }),
          occurredAt: source.occurredAt, createdAt: now,
        } satisfies MemoryEvidence;
      });
      const fact: MemoryFact = {
        id, chatKey: input.chatKey, kind: proposal.kind, subjectKey: proposal.subjectKey,
        predicateKey: proposal.predicateKey,
        ...(proposal.objectKey === undefined ? {} : { objectKey: proposal.objectKey }),
        canonicalKey: proposal.canonicalKey, slotKey: proposal.slotKey, content: proposal.content,
        entityKeys: proposal.entityKeys, confidence: proposal.confidence, status: effectiveStatus,
        sourceRefs: proposal.sourceRefs, evidenceIds: evidence.map(item => item.id),
        freshestEvidenceAt: proposal.freshestEvidenceAt,
        ...(proposal.validFrom === undefined ? {} : { validFrom: proposal.validFrom }),
        ...(proposal.validUntil === undefined ? {} : { validUntil: proposal.validUntil }),
        ...(proposal.stableAnchor === undefined ? {} : { stableAnchor: proposal.stableAnchor }),
        ...(proposal.scope === undefined ? {} : { scope: structuredClone(proposal.scope) }),
        origin: 'automatic', revision: 1,
        ...(decision === 'supersede' && existing ? { supersedesId: existing.id } : {}),
        createdAt: now, updatedAt: now,
      };
      if (decision === 'supersede' && existing) {
        const replaced: MemoryFact = {
          ...existing, status: 'superseded', supersededById: id,
          revision: existing.revision + 1, updatedAt: now,
        };
        workingFacts.set(replaced.id, replaced);
        changedFacts.set(replaced.id, replaced);
        result.superseded += 1;
      }
      workingFacts.set(fact.id, fact);
      changedFacts.set(fact.id, fact);
      changedEvidence.push(...evidence);
      result.facts.push(fact);
      result.accepted += 1;
      if (effectiveStatus === 'pending') result.pending += 1;
    }

    const now = input.checkpoint.completedAt;
    const job: MemoryJob = {
      id: input.jobId, chatKey: input.chatKey, type: input.jobType ?? 'incremental',
      status: input.jobStatus ?? 'completed',
      checkpoint: {
        batchIndex,
        ...(input.checkpoint.totalBatches === undefined ? {} : { totalBatches: input.checkpoint.totalBatches }),
        processedCount: input.checkpoint.processedCount ?? input.checkpoint.sourceIds.length,
        ...(input.checkpoint.sourceIds.at(-1) ? { lastSourceRef: input.checkpoint.sourceIds.at(-1) } : {}),
        overlapSourceRefs: input.checkpoint.overlapSourceRefs ?? input.checkpoint.sourceIds.slice(-2),
        ...(input.checkpoint.metadataSourceRefs === undefined ? {} : { metadataSourceRefs: input.checkpoint.metadataSourceRefs }),
        ...(input.checkpoint.selectedSourceGroupIds === undefined ? {} : { selectedSourceGroupIds: input.checkpoint.selectedSourceGroupIds }),
      },
      createdAt: now,
      updatedAt: now,
    };
    const audit: MemoryJobBatchAudit = {
      id: `batch-audit:${job.id}:${batchIndex}`, chatKey: input.chatKey, jobId: job.id, batchIndex,
      sourceRefs: sourceRows.map(source => source.id), accepted: result.accepted,
      rejected: result.rejected.length, duplicated: result.duplicated, pending: result.pending,
      superseded: result.superseded, rejections: result.rejected,
      startedAt, completedAt: Date.now(), usage: input.audit?.usage ?? null,
      ...(input.audit?.requestId ? { requestId: input.audit.requestId } : {}),
      ...(input.audit?.resourceId ? { resourceId: input.audit.resourceId } : {}),
      ...(input.audit?.model ? { model: input.audit.model } : {}),
      ...(input.audit?.latencyMs === undefined ? {} : { latencyMs: input.audit.latencyMs }),
    };
    try {
      const workspaceId = this.requireWorkspaceId();
      const operations: WorkspaceTransactionOperation[] = [];
      const undoEntries: UndoLogEntry[] = [];
      for (const fact of changedFacts.values()) {
        const beforeRecord = beforeRecordById.get(fact.id);
        const beforeRevision = beforeRecord?.revision ?? beforeRecord?.version ?? 0;
        operations.push({ action: 'upsert', collection: 'facts', recordId: fact.id, value: asPlain(fact), expectedRevision: beforeRevision });
        const before = beforeRecord?.value;
        undoEntries.push({ collection: 'facts', recordId: fact.id, ...(before === undefined ? {} : { before: asPlain(before) }), after: asPlain(fact), beforeRevision, afterRevision: beforeRevision + 1 });
      }
      for (const evidence of changedEvidence) {
        const before = await this.workspace.get({ workspaceId, collection: 'evidence', recordId: evidence.id });
        const beforeRevision = before?.revision ?? before?.version ?? 0;
        operations.push({ action: 'upsert', collection: 'evidence', recordId: evidence.id, value: asPlain(evidence), expectedRevision: beforeRevision });
        undoEntries.push({ collection: 'evidence', recordId: evidence.id, ...(before == null ? {} : { before: asPlain(before.value) }), after: asPlain(evidence), beforeRevision, afterRevision: beforeRevision + 1 });
      }
      for (const slotKey of touchedSlots) {
        const slotRecord = await this.workspace.get({ workspaceId, collection: 'fact-slots', recordId: slotKey });
        const slotValue = slotRecord?.value as { factId?: string } | undefined;
        if ((slotValue?.factId ?? null) !== baseSlotFactIds[slotKey]) throw Object.assign(new Error('记忆槽位已变化。'), { code: 'WORKSPACE_CONFLICT' });
        const selected = [...workingFacts.values()].filter((fact) => fact.slotKey === slotKey && (fact.status === 'active' || fact.status === 'pending')).sort((left, right) => Number(right.status === 'active') - Number(left.status === 'active') || right.freshestEvidenceAt - left.freshestEvidenceAt || left.id.localeCompare(right.id))[0];
        if (selected) {
          const after = { factId: selected.id };
          const beforeRevision = slotRecord?.revision ?? slotRecord?.version ?? 0;
          operations.push({ action: 'upsert', collection: 'fact-slots', recordId: slotKey, value: after, expectedRevision: beforeRevision });
          undoEntries.push({ collection: 'fact-slots', recordId: slotKey, ...(slotRecord == null ? {} : { before: asPlain(slotRecord.value) }), after, beforeRevision, afterRevision: beforeRevision + 1 });
        } else {
          const beforeRevision = slotRecord?.revision ?? slotRecord?.version ?? 0;
          operations.push({ action: 'delete', collection: 'fact-slots', recordId: slotKey, expectedRevision: beforeRevision });
          undoEntries.push({ collection: 'fact-slots', recordId: slotKey, ...(slotRecord == null ? {} : { before: asPlain(slotRecord.value) }), beforeRevision });
        }
      }
      const jobRecord = await this.workspace.get({ workspaceId, collection: 'jobs', recordId: job.id });
      operations.push({ action: 'upsert', collection: 'jobs', recordId: job.id, value: asPlain(job), expectedVersion: jobRecord?.version ?? 0 });
      operations.push({ action: 'upsert', collection: 'job-audits', recordId: audit.id, value: asPlain(audit) });
      const undoLog: UndoLogV2 = { id: undoLogId, kind: 'undo-log-v2', chatKey: input.chatKey, jobId: job.id, batchIndex, transactionId: input.audit?.requestId ?? undoLogId, committedSequence: nextCommittedSequence(), entries: undoEntries, result: structuredClone(result), createdAt: startedAt };
      operations.push({ action: 'upsert', collection: 'job-audits', recordId: undoLog.id, value: asPlain(undoLog) });
      await this.workspace.transaction({ workspaceId, idempotencyKey: undoLogId, operations });
      return result;
    } catch (error) {
      if (workspaceErrorCode(error) === 'WORKSPACE_CONFLICT' && retryAttempt < 1) return this.commitIngest(input, retryAttempt + 1);
      throw error;
    }
  }

  async commit(input: IngestCommit): Promise<void> {
    await this.commitIngest(input);
  }

  async putJob(job: MemoryJob): Promise<void> {
    const workspaceId = this.requireWorkspaceId(); const current = await this.workspace.get({ workspaceId, collection: 'jobs', recordId: job.id });
    await this.workspace.upsert({ workspaceId, collection: 'jobs', recordId: job.id, value: asPlain(job), expectedVersion: current?.version ?? 0 });
  }

  async listJobs(chatKey: string): Promise<MemoryJob[]> {
    return this.listAllRows<MemoryJob>('jobs', { chatKey });
  }

  async addJobBatchAudit(audit: MemoryJobBatchAudit): Promise<void> {
    await this.workspace.upsert({ workspaceId: this.requireWorkspaceId(), collection: 'job-audits', recordId: audit.id, value: asPlain(audit) });
  }

  async listJobBatchAudits(chatKey: string, jobId?: string): Promise<MemoryJobBatchAudit[]> {
    return (await this.listAllRows<MemoryJobBatchAudit>('job-audits', { chatKey, ...(jobId ? { jobId } : {}) })).filter((audit) => (audit as { kind?: unknown }).kind !== 'undo-log-v2' && (audit as { kind?: unknown }).kind !== 'snapshot');
  }

  async addMainChatUsage(usage: MainChatUsage): Promise<void> {
    await this.workspace.upsert({ workspaceId: this.requireWorkspaceId(), collection: 'usage', recordId: usage.id, value: asPlain(usage) });
  }

  async listMainChatUsage(chatKey: string): Promise<MainChatUsage[]> {
    return this.listAllRows<MainChatUsage>('usage', { chatKey });
  }

  async rollbackJobBatch(jobId: string, batchIndex: number, expectedChatKey?: string): Promise<string[]> {
    const workspaceId = this.requireWorkspaceId();
    const markerId = `rollback-v2:${jobId}:${batchIndex}`;
    const existingMarker = await this.workspace.get({ workspaceId, collection: 'job-audits', recordId: markerId });
    if (existingMarker) {
      const marker = existingMarker.value as unknown as RollbackMarkerV2;
      if (marker.kind !== 'rollback-v2') throw Object.assign(new Error('回滚标识冲突。'), { code: 'WORKSPACE_CONFLICT' });
      if (marker.status === 'completed') return [];
      await this.deleteRollbackVectors(workspaceId, marker);
      return [...marker.affectedFactIds];
    }
    const allRows = await this.listAllRecordRows('job-audits');
    const logRows = allRows.filter((row) => (row.value as { kind?: unknown }).kind === 'undo-log-v2');
    const allLogs = logRows.map((row) => ({ row, log: row.value as unknown as UndoLogV2 })).filter(({ log }) => !log.rolledBackBy).sort((left, right) => left.log.committedSequence - right.log.committedSequence);
    const target = allLogs.find(({ log }) => log.jobId === jobId && log.batchIndex === batchIndex);
    if (!target) throw new Error('该整理批次没有可执行的 UndoLogV2；旧快照仅可查看，不能执行回滚。');
    if (expectedChatKey && target.log.chatKey !== expectedChatKey) throw new Error('整理批次不属于当前聊天。');
    const included = new Map<string, { row: WorkspaceRecord; log: UndoLogV2 }>();
    for (const item of allLogs) if (item.log.chatKey === target.log.chatKey && item.log.jobId === jobId && item.log.batchIndex >= batchIndex) included.set(item.log.id, item);
    const affectedKeys = new Set([...included.values()].flatMap(({ log }) => log.entries.map(undoRecordKey)));
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of allLogs) {
        if (included.has(item.log.id) || item.log.chatKey !== target.log.chatKey || item.log.committedSequence <= target.log.committedSequence) continue;
        if (item.log.entries.some((entry) => affectedKeys.has(undoRecordKey(entry)))) { included.set(item.log.id, item); item.log.entries.forEach((entry) => affectedKeys.add(undoRecordKey(entry))); changed = true; }
      }
    }
    const chains = new Map<string, UndoLogEntry[]>();
    for (const { log } of [...included.values()].sort((a, b) => a.log.committedSequence - b.log.committedSequence)) for (const entry of log.entries) { const key = undoRecordKey(entry); const chain = chains.get(key) ?? []; chain.push(entry); chains.set(key, chain); }
    const operations: WorkspaceTransactionOperation[] = [];
    const affectedFactIds = new Set<string>();
    for (const chain of chains.values()) {
      for (let index = 1; index < chain.length; index += 1) if (!samePlainData(chain[index - 1].after, chain[index].before)) throw Object.assign(new Error('UndoLogV2 修订链不连续，回滚已取消。'), { code: 'WORKSPACE_CONFLICT' });
      const first = chain[0]; const last = chain.at(-1)!; const current = await this.workspace.get({ workspaceId, collection: last.collection, recordId: last.recordId });
      const revision = current?.revision ?? current?.version ?? 0;
      if (last.after === undefined ? current !== null : current === null || !samePlainData(current.value, last.after) || (last.afterRevision !== undefined && revision !== last.afterRevision)) throw Object.assign(new Error('记忆记录已被其他任务修改，回滚已安全取消。'), { code: 'WORKSPACE_CONFLICT' });
      if (last.collection === 'facts') affectedFactIds.add(last.recordId);
      if (first.before === undefined) { if (current) operations.push({ action: 'delete', collection: last.collection, recordId: last.recordId, expectedRevision: revision }); }
      else operations.push({ action: 'upsert', collection: last.collection, recordId: last.recordId, value: first.before, expectedRevision: revision });
    }
    const rollbackAt = Date.now();
    for (const { row, log } of included.values()) operations.push({ action: 'upsert', collection: 'job-audits', recordId: row.recordId, value: asPlain({ ...log, rolledBackAt: rollbackAt, rolledBackBy: markerId }), expectedRevision: row.revision ?? row.version });
    const affectedJobs = new Map<string, number>();
    for (const { log } of included.values()) affectedJobs.set(log.jobId, Math.min(affectedJobs.get(log.jobId) ?? log.batchIndex, log.batchIndex));
    for (const [affectedJobId, firstBatch] of affectedJobs) {
      const jobRecord = await this.workspace.get({ workspaceId, collection: 'jobs', recordId: affectedJobId });
      if (jobRecord) { const value = jobRecord.value as unknown as MemoryJob; operations.push({ action: 'upsert', collection: 'jobs', recordId: affectedJobId, value: asPlain({ ...value, status: 'paused', checkpoint: { ...value.checkpoint, batchIndex: Math.max(0, firstBatch - 1) }, updatedAt: rollbackAt }), expectedRevision: jobRecord.revision ?? jobRecord.version }); }
    }
    for (const { log } of included.values()) {
      const auditRecord = allRows.find((row) => row.recordId === `batch-audit:${log.jobId}:${log.batchIndex}`);
      if (auditRecord) operations.push({ action: 'upsert', collection: 'job-audits', recordId: auditRecord.recordId, value: asPlain({ ...(auditRecord.value as object), rolledBackAt: rollbackAt, rollbackId: markerId }), expectedRevision: auditRecord.revision ?? auditRecord.version });
    }
    const marker: RollbackMarkerV2 = { id: markerId, kind: 'rollback-v2', chatKey: target.log.chatKey, jobId, batchIndex, status: 'index-repair-pending', affectedLogIds: [...included.keys()], affectedFactIds: [...affectedFactIds], createdAt: rollbackAt };
    operations.push({ action: 'upsert', collection: 'job-audits', recordId: markerId, value: asPlain(marker), expectedRevision: 0 });
    const result = await this.workspace.transaction({ workspaceId, idempotencyKey: markerId, operations });
    void result;
    await this.deleteRollbackVectors(workspaceId, marker);
    return [...marker.affectedFactIds];
  }

  private async deleteRollbackVectors(workspaceId: string, marker: RollbackMarkerV2): Promise<void> {
    const failed: string[] = [];
    for (const recordId of marker.affectedFactIds) try { await this.workspace.vectorDelete({ workspaceId, collection: 'facts', recordId }); } catch { failed.push(recordId); }
    if (failed.length) throw Object.assign(new Error('向量索引修复已排队。'), { code: 'VECTOR_INDEX_REPAIR_PENDING' });
  }

  async completeRollbackIndexRepair(jobId: string, batchIndex: number): Promise<void> {
    const workspaceId = this.requireWorkspaceId();
    const markerId = `rollback-v2:${jobId}:${batchIndex}`;
    const markerRecord = await this.workspace.get({ workspaceId, collection: 'job-audits', recordId: markerId });
    if (!markerRecord) throw Object.assign(new Error('回滚修复标识不存在。'), { code: 'WORKSPACE_CONFLICT' });
    const marker = markerRecord.value as unknown as RollbackMarkerV2;
    if (marker.kind !== 'rollback-v2') throw Object.assign(new Error('回滚标识冲突。'), { code: 'WORKSPACE_CONFLICT' });
    if (marker.status === 'completed') return;
    const requiredVectorIds = new Set<string>();
    for (const recordId of marker.affectedFactIds) {
      const factRecord = await this.workspace.get({ workspaceId, collection: 'facts', recordId });
      const fact = factRecord?.value as unknown as MemoryFact | undefined;
      if (fact && (fact.status === 'active' || fact.status === 'pending')) requiredVectorIds.add(recordId);
    }
    const vectorIds = new Set((await this.listAllVectors()).map((item) => item.recordId));
    if ([...requiredVectorIds].some((recordId) => !vectorIds.has(recordId))) {
      throw Object.assign(new Error('向量索引修复已排队。'), { code: 'VECTOR_INDEX_REPAIR_PENDING' });
    }
    const completed: RollbackMarkerV2 = { ...marker, status: 'completed', completedAt: Date.now() };
    await this.workspace.upsert({ workspaceId, collection: 'job-audits', recordId: marker.id, value: asPlain(completed), expectedRevision: markerRecord.revision ?? markerRecord.version });
  }

  async getSetting<T>(key: string): Promise<T | undefined> {
    const result = await this.workspace.get({ workspaceId: SETTINGS_WORKSPACE_ID, collection: 'settings', recordId: key });
    const value = result?.value as unknown as MemorySettingRecord | undefined;
    return value?.value as T | undefined;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.ensureCollections(SETTINGS_WORKSPACE_ID); const current = await this.workspace.get({ workspaceId: SETTINGS_WORKSPACE_ID, collection: 'settings', recordId: key });
    const setting: MemorySettingRecord = { id: key, namespace: 'stx_memory', key, value, updatedAt: Date.now() };
    await this.workspace.upsert({ workspaceId: SETTINGS_WORKSPACE_ID, collection: 'settings', recordId: key, value: asPlain(setting), expectedVersion: current?.version ?? 0 });
  }

  async setSettings(values: Record<string, unknown>): Promise<void> {
    await this.ensureCollections(SETTINGS_WORKSPACE_ID); const operations: WorkspaceTransactionOperation[] = [];
    for (const [key, value] of Object.entries(values)) {
      const current = await this.workspace.get({ workspaceId: SETTINGS_WORKSPACE_ID, collection: 'settings', recordId: key });
      operations.push({ action: 'upsert', collection: 'settings', recordId: key, value: asPlain({ id: key, namespace: 'stx_memory', key, value, updatedAt: Date.now() }), expectedVersion: current?.version ?? 0 });
    }
    await this.workspace.transaction({ workspaceId: SETTINGS_WORKSPACE_ID, operations });
  }

  async addRecallLog(log: MemoryRecallLog): Promise<void> {
    const { injectedPrompt: _sensitivePrompt, ...safeLog } = log;
    await this.workspace.upsert({ workspaceId: this.requireWorkspaceId(), collection: 'recall-logs', recordId: log.id, value: asPlain(safeLog) });
  }

  async getLastRecall(chatKey: string): Promise<MemoryRecallLog | undefined> {
    const page = await this.workspace.query({ workspaceId: this.requireWorkspaceId(), collection: 'recall-logs', filter: { chatKey }, orderBy: { field: 'createdAt', direction: 'desc' }, limit: 1 });
    return page.records[0]?.value as unknown as MemoryRecallLog | undefined;
  }

  async clearCurrentChatData(chatKey: string): Promise<void> {
    const workspaceId = this.requireWorkspaceId();
    const [evidenceRecords, jobRecords, auditRecords, usageRecords, logRecords, factRecords] = await Promise.all([
      this.listAllRecordRows('evidence', { chatKey }), this.listAllRecordRows('jobs', { chatKey }), this.listAllRecordRows('job-audits', { chatKey }),
      this.listAllRecordRows('usage', { chatKey }), this.listAllRecordRows('recall-logs', { chatKey }), this.listAllRecordRows('facts'),
    ]);
    const removedEvidenceIds = new Set(evidenceRecords.map((record) => record.recordId));
    const touchedFactIds = new Set(evidenceRecords.map((record) => (record.value as unknown as MemoryEvidence).factId));
    const allEvidence = await this.listAllRecordRows('evidence'); const remainingEvidence = allEvidence.filter((record) => !removedEvidenceIds.has(record.recordId));
    const remainingByFact = new Map<string, MemoryEvidence[]>();
    for (const record of remainingEvidence) { const value = record.value as unknown as MemoryEvidence; const list = remainingByFact.get(value.factId) ?? []; list.push(value); remainingByFact.set(value.factId, list); }
    const operations: WorkspaceTransactionOperation[] = [...evidenceRecords, ...jobRecords, ...auditRecords, ...usageRecords, ...logRecords].map((record) => ({ action: 'delete', collection: evidenceRecords.includes(record) ? 'evidence' : jobRecords.includes(record) ? 'jobs' : auditRecords.includes(record) ? 'job-audits' : usageRecords.includes(record) ? 'usage' : 'recall-logs', recordId: record.recordId, expectedVersion: record.version }));
    const deletedFactIds: string[] = []; const affectedSlots = new Set<string>();
    for (const record of factRecords) {
      if (!touchedFactIds.has(record.recordId)) continue;
      const fact = structuredClone(record.value as unknown as MemoryFact); const remaining = remainingByFact.get(fact.id) ?? [];
      if (fact.slotKey) affectedSlots.add(fact.slotKey);
      if (!remaining.length) { operations.push({ action: 'delete', collection: 'facts', recordId: fact.id, expectedVersion: record.version }); deletedFactIds.push(fact.id); continue; }
      fact.evidenceIds = remaining.map((item) => item.id); fact.sourceRefs = [...new Set(remaining.map((item) => item.sourceRef))]; fact.freshestEvidenceAt = Math.max(...remaining.map((item) => item.occurredAt)); fact.revision += 1; fact.updatedAt = Date.now();
      operations.push({ action: 'upsert', collection: 'facts', recordId: fact.id, value: asPlain(fact), expectedVersion: record.version });
    }
    const survivingFacts = factRecords.map((record) => record.value as unknown as MemoryFact).filter((fact) => !deletedFactIds.includes(fact.id));
    for (const slotKey of affectedSlots) {
      const slot = await this.workspace.get({ workspaceId, collection: 'fact-slots', recordId: slotKey });
      const selected = survivingFacts.filter((fact) => fact.slotKey === slotKey && (fact.status === 'active' || fact.status === 'pending')).sort((left, right) => Number(right.status === 'active') - Number(left.status === 'active') || right.freshestEvidenceAt - left.freshestEvidenceAt)[0];
      if (selected) operations.push({ action: 'upsert', collection: 'fact-slots', recordId: slotKey, value: { factId: selected.id }, expectedVersion: slot?.version ?? 0 });
      else if (slot) operations.push({ action: 'delete', collection: 'fact-slots', recordId: slotKey, expectedVersion: slot.version });
    }
    await this.workspace.transaction({ workspaceId, operations });
    for (const factId of deletedFactIds) await this.workspace.vectorDelete({ workspaceId, collection: 'facts', recordId: factId }).catch(() => false);
  }

  async getChatKeys(): Promise<string[]> {
    const values = await Promise.all(['evidence', 'jobs', 'job-audits', 'usage', 'recall-logs'].map((collection) => this.listAllRecordRows(collection)));
    return [...new Set(values.flat().map((record) => (record.value as unknown as { chatKey?: string }).chatKey).filter((value): value is string => Boolean(value)))].sort();
  }

  async upsertFactVector(input: UpsertMemoryFactVectorInput): Promise<MemoryFactVector> {
    const now = input.updatedAt ?? Date.now();
    const contentHash = await sha256Content(input.content);
    const vector = float32ArrayToArrayBuffer(input.vector);
    await this.workspace.vectorUpsert({ workspaceId: this.requireWorkspaceId(), collection: 'facts', recordId: input.factId, model: input.model, vector: Array.from(input.vector), metadata: { chatKey: input.chatKey, contentHash, resourceId: input.resourceId, dimensions: input.vector.length, updatedAt: now } });
    return {
      factId: input.factId,
      chatKey: input.chatKey,
      contentHash,
      resourceId: input.resourceId,
      model: input.model,
      dimensions: input.vector.length,
      vector,
      createdAt: now,
      updatedAt: now,
    };
  }

  async deleteFactVector(chatKey: string, factId: string): Promise<boolean> {
    void chatKey;
    return this.workspace.vectorDelete({ workspaceId: this.requireWorkspaceId(), collection: 'facts', recordId: factId });
  }

  async clearFactVectors(chatKey: string): Promise<number> {
    void chatKey;
    return this.workspace.vectorClear({ workspaceId: this.requireWorkspaceId(), collection: 'facts' });
  }

  async getFactVectorCoverage(chatKey: string, target: MemoryFactVectorTarget): Promise<MemoryFactVectorCoverage> {
    const facts = (await this.listAllFacts()).filter((fact) => fact.status === 'active' || fact.status === 'pending'); const vectors = await this.listAllVectors(); const byId = new Map(vectors.map((item) => [item.recordId, item]));
    const readyFactIds: string[] = []; const missingFactIds: string[] = []; const staleFactIds: string[] = [];
    for (const fact of facts) { const vector = byId.get(fact.id); const metadata = vector?.metadata as { resourceId?: string; dimensions?: number } | undefined; if (!vector) missingFactIds.push(fact.id); else if (vector.model !== target.model || metadata?.resourceId !== target.resourceId || (target.dimensions !== undefined && metadata?.dimensions !== target.dimensions)) staleFactIds.push(fact.id); else readyFactIds.push(fact.id); }
    const factIds = new Set(facts.map((fact) => fact.id)); const orphanedFactIds = vectors.filter((item) => !factIds.has(item.recordId)).map((item) => item.recordId); const totalFacts = facts.length;
    return { chatKey, totalFacts, ready: readyFactIds.length, missing: missingFactIds.length, stale: staleFactIds.length, orphaned: orphanedFactIds.length, coverage: totalFacts ? readyFactIds.length / totalFacts : 1, readyFactIds, missingFactIds, staleFactIds, orphanedFactIds };
  }

  async listFactsNeedingVectorRebuild(
    chatKey: string,
    target: MemoryFactVectorTarget,
    limit = 32,
  ): Promise<MemoryFact[]> {
    const coverage = await this.getFactVectorCoverage(chatKey, target); const ids = new Set([...coverage.missingFactIds, ...coverage.staleFactIds]);
    return (await this.listAllFacts()).filter((fact) => ids.has(fact.id)).slice(0, Math.min(32, Math.max(1, Math.trunc(limit))));
  }

  vectorSearch(input: {
    chatKey: string;
    vector: readonly number[] | Float32Array;
    limit?: number;
    resourceId?: string;
    model?: string;
  }): Promise<Array<{ factId: string; score: number }>> {
    return this.workspace.vectorSearch({ workspaceId: this.requireWorkspaceId(), collection: 'facts', vector: Array.from(input.vector), ...(input.limit === undefined ? {} : { limit: input.limit }), ...(input.model ? { model: input.model } : {}), ...(input.resourceId ? { metadata: { resourceId: input.resourceId } } : {}) }).then((hits) => hits.map((hit) => ({ factId: hit.recordId, score: hit.score })));
  }

  async clearAllMemory(): Promise<number> {
    const removed = await this.workspace.clearOwned({ preserveWorkspaceIds: [SETTINGS_WORKSPACE_ID], idempotencyKey: `memory-clear:${Date.now()}` });
    if (this.workspaceId) await this.ensureCollections(this.workspaceId);
    return removed;
  }

  async exportBackup(): Promise<Blob> {
    const backup = await this.workspace.exportAll();
    return new Blob([JSON.stringify({ format: 'ss-helper-memory', version: 1, ...backup })], { type: 'application/vnd.ss-helper.workspace+json' });
  }

  async importBackup(file: File): Promise<void> {
    const value = JSON.parse(await file.text()) as { format?: string; version?: number; archive?: unknown; sha256?: string };
    if (value.format !== 'ss-helper-memory' || value.version !== 1 || !value.archive || typeof value.sha256 !== 'string') throw new Error('Memory 备份格式无效。');
    await this.workspace.importAll({ archive: value.archive as never, sha256: value.sha256 });
    await this.ensureCollections(SETTINGS_WORKSPACE_ID); if (this.workspaceId) await this.ensureCollections(this.workspaceId);
  }

  async checkIntegrity(): Promise<{ ok: boolean; message: string }> {
    const sqlite = await this.workspace.integrity(); if (!sqlite.ok) return { ok: false, message: sqlite.messages.join('；') };
    const [facts, evidence, slots, vectors] = await Promise.all([this.listAllRecordRows('facts'), this.listAllRows<MemoryEvidence>('evidence'), this.listAllRecordRows('fact-slots'), this.listAllVectors()]);
    const factIds = new Set(facts.map((item) => item.recordId));
    const problems = [
      ...evidence.filter((item) => !factIds.has(item.factId)).map((item) => `证据 ${item.id} 缺少事实 ${item.factId}`),
      ...slots.filter((item) => !factIds.has(String((item.value as { factId?: string }).factId ?? ''))).map((item) => `槽位 ${item.recordId} 指向不存在的事实`),
      ...vectors.filter((item) => !factIds.has(item.recordId)).map((item) => `向量 ${item.recordId} 缺少事实`),
    ];
    return { ok: problems.length === 0, message: problems.length ? problems.join('；') : 'SQLite 与 Memory workspace 完整性检查通过。' };
  }

  private async rebuildSlots(): Promise<void> {
    const workspaceId = this.requireWorkspaceId(); const facts = await this.listAllFacts(); const current = await this.listAllRecordRows('fact-slots');
    const slots = new Map<string, MemoryFact[]>(); for (const fact of facts) if (fact.slotKey && (fact.status === 'active' || fact.status === 'pending')) { const values = slots.get(fact.slotKey) ?? []; values.push(fact); slots.set(fact.slotKey, values); }
    const operations: WorkspaceTransactionOperation[] = current.map((record) => ({ action: 'delete', collection: 'fact-slots', recordId: record.recordId, expectedVersion: record.version }));
    for (const [slotKey, values] of slots) { const selected = values.sort((left, right) => Number(right.status === 'active') - Number(left.status === 'active') || right.freshestEvidenceAt - left.freshestEvidenceAt)[0]; operations.push({ action: 'upsert', collection: 'fact-slots', recordId: slotKey, value: { factId: selected.id }, expectedVersion: 0 }); }
    await this.workspace.transaction({ workspaceId, operations });
  }
}
