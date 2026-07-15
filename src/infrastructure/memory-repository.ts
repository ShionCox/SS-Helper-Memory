import type { IngestCommit, IngestCommitter } from '../application/ingest/types';
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
import {
  MemorySqliteClient,
  MemorySqliteError,
  type MemorySqliteBootstrap,
  type MemorySqliteHealth,
  type MemorySqliteQueryResource,
} from './memory-sqlite-client';
import { float32ArrayToArrayBuffer, sha256Content } from './vector/vector-utils';

const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 500;
const MAX_QUERY_LIMIT = 10_000;
const QUERY_PAGE_SIZE = 1_000;
const EXPECTED_PROTOCOL_VERSION = 1;
const EXPECTED_SCHEMA_VERSION = 2;

function clampLimit(limit: number | undefined): number {
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.trunc(limit ?? DEFAULT_SEARCH_LIMIT)));
}

function createId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${uuid}`;
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

/**
 * Memory 的唯一仓储。所有持久化读写都通过 SillyTavern 服务端插件完成；
 * 浏览器仅保留当前调用所需的短生命周期对象。
 */
export class MemoryRepository implements IngestCommitter {
  private healthSnapshot: MemorySqliteHealth | null = null;

  constructor(readonly client: MemorySqliteClient = new MemorySqliteClient()) {}

  async open(): Promise<void> {
    this.healthSnapshot = await this.client.health();
    if (!this.healthSnapshot.connected) {
      const lastError = typeof this.healthSnapshot.lastError === 'string'
        ? this.healthSnapshot.lastError
        : this.healthSnapshot.lastError?.message;
      throw new Error(lastError || 'Memory SQLite 服务未连接。');
    }
    if (this.healthSnapshot.protocolVersion !== EXPECTED_PROTOCOL_VERSION) {
      throw new Error(`Memory SQLite 协议不兼容：需要 v${EXPECTED_PROTOCOL_VERSION}，服务端为 v${this.healthSnapshot.protocolVersion}。`);
    }
    if (this.healthSnapshot.schemaVersion !== EXPECTED_SCHEMA_VERSION) {
      throw new Error(`Memory SQLite schema 不兼容：需要 v${EXPECTED_SCHEMA_VERSION}，服务端为 v${this.healthSnapshot.schemaVersion}。`);
    }
    if (!/^0\.0\./u.test(this.healthSnapshot.serverVersion)) {
      throw new Error(`Memory SQLite 服务端版本不兼容：需要 0.0.x，当前为 ${this.healthSnapshot.serverVersion}。`);
    }
  }

  close(): void {
    this.healthSnapshot = null;
  }

  getHealthSnapshot(): MemorySqliteHealth | null {
    return this.healthSnapshot ? structuredClone(this.healthSnapshot) : null;
  }

  async refreshHealth(chatKey?: string): Promise<MemorySqliteHealth> {
    this.healthSnapshot = await this.client.health(chatKey);
    return structuredClone(this.healthSnapshot);
  }

  async bootstrap(chatKey: string): Promise<MemorySqliteBootstrap<MemoryFact>> {
    const bootstrap = await this.client.bootstrap<MemoryFact>(chatKey);
    if (bootstrap.facts.length < MAX_QUERY_LIMIT) return bootstrap;
    return { ...bootstrap, facts: await this.listAllFacts(chatKey) };
  }

  private async listAllFacts(chatKey: string, filters: Record<string, unknown> = {}): Promise<MemoryFact[]> {
    const facts: MemoryFact[] = [];
    for (let offset = 0; ; offset += QUERY_PAGE_SIZE) {
      const page = rows(await this.client.query<MemoryFact[] | { items?: MemoryFact[] }>('facts', {
        chatKey, filters, limit: QUERY_PAGE_SIZE, offset,
      }));
      facts.push(...page);
      if (page.length < QUERY_PAGE_SIZE) return facts;
    }
  }

  private async listAllRows<T>(resource: MemorySqliteQueryResource, chatKey: string, filters: Record<string, unknown> = {}): Promise<T[]> {
    const result: T[] = [];
    for (let offset = 0; ; offset += QUERY_PAGE_SIZE) {
      const page = rows(await this.client.query<T[] | { items?: T[] }>(resource, {
        chatKey, filters, limit: QUERY_PAGE_SIZE, offset,
      }));
      result.push(...page);
      if (page.length < QUERY_PAGE_SIZE) return result;
    }
  }

  async listFacts(chatKey: string, options: FactListOptions = {}): Promise<MemoryFact[]> {
    if (options.limit === undefined) {
      return this.listAllFacts(chatKey, {
        ...(options.status ? { status: options.status } : {}),
        ...(options.kind ? { kind: options.kind } : {}),
      });
    }
    const result = await this.client.query<MemoryFact[] | { items?: MemoryFact[] }>('facts', {
      chatKey,
      filters: {
        ...(options.status ? { status: options.status } : {}),
        ...(options.kind ? { kind: options.kind } : {}),
      },
      limit: clampLimit(options.limit),
    });
    return rows(result);
  }

  list(chatKey: string, options: FactListOptions = {}): Promise<MemoryFact[]> {
    return this.listFacts(chatKey, options);
  }

  async searchFacts(chatKey: string, query: string, limit = DEFAULT_SEARCH_LIMIT): Promise<MemoryFact[]> {
    const result = await this.client.query<MemoryFact[] | { items?: MemoryFact[] }>('facts', {
      chatKey,
      filters: { query },
      limit: clampLimit(limit),
    });
    return rows(result);
  }

  search(chatKey: string, query: string, limit = DEFAULT_SEARCH_LIMIT): Promise<MemoryFact[]> {
    return this.searchFacts(chatKey, query, limit);
  }

  async getFact(chatKey: string, id: string): Promise<MemoryFact | undefined> {
    const result = await this.client.query<MemoryFact | null>('fact', { chatKey, filters: { id } });
    return result ?? undefined;
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
    const previous = await this.getFact(chatKey, id);
    if (previous && previous.chatKey !== chatKey) throw new Error('不能跨聊天修改记忆。');
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
    return this.client.command<MemoryFact>('fact.upsert', {
      fact,
      evidence: [evidence],
      relatedFacts,
      expectedRevision: previous?.revision ?? null,
      expectedSlotFactId,
      expectedRelatedRevisions: Object.fromEntries(relatedFacts.map(item => [item.id, item.revision - 1])),
    });
  }

  upsert(chatKey: string, input: ManualFactInput): Promise<MemoryFact> {
    return this.upsertManualFact(chatKey, input);
  }

  async removeFact(chatKey: string, id: string): Promise<boolean> {
    const target = await this.getFact(chatKey, id);
    if (!target) return false;
    const relatedIds = [target.supersedesId, target.supersededById].filter((value): value is string => Boolean(value));
    const related = await Promise.all(relatedIds.map(relatedId => this.getFact(chatKey, relatedId)));
    if (related.some(item => !item)) throw new Error('记忆历史链已变化，请刷新后重试。');
    const result = await this.client.command<boolean | { removed: boolean }>('fact.remove', {
      chatKey,
      id,
      expectedRevision: target.revision,
      expectedRelatedRevisions: Object.fromEntries(related.map(item => [item!.id, item!.revision])),
    });
    return typeof result === 'boolean' ? result : result.removed;
  }

  remove(chatKey: string, id: string): Promise<boolean> {
    return this.removeFact(chatKey, id);
  }

  async listEvidence(chatKey: string, factId: string): Promise<MemoryEvidence[]> {
    const result = await this.client.query<MemoryEvidence[] | { items?: MemoryEvidence[] }>('evidence', {
      chatKey,
      filters: { factId },
    });
    return rows(result);
  }

  async commitIngest(input: IngestCommit, retryAttempt = 0): Promise<AutomaticIngestResult> {
    const startedAt = Date.now();
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

    const beforeFacts = await this.listFacts(input.chatKey);
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
    const batchIndex = input.checkpoint.batchIndex ?? 1;
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
      return await this.client.command<AutomaticIngestResult>('ingest.commit', {
        job, facts: [...changedFacts.values()], evidence: changedEvidence, audit,
        baseRevisions: Object.fromEntries(beforeFacts
          .filter(fact => touchedSlots.has(fact.slotKey ?? createFactSlotKey(fact.subjectKey, fact.predicateKey)))
          .map(fact => [fact.id, fact.revision])),
        baseSlotFactIds,
        accepted: result.accepted, duplicated: result.duplicated, pending: result.pending,
        superseded: result.superseded, rejected: result.rejected,
      }, input.audit?.requestId);
    } catch (error) {
      if (error instanceof MemorySqliteError && error.code === 'REVISION_CONFLICT' && retryAttempt < 1) {
        return this.commitIngest(input, retryAttempt + 1);
      }
      throw error;
    }
  }

  async commit(input: IngestCommit): Promise<void> {
    await this.commitIngest(input);
  }

  async putJob(job: MemoryJob): Promise<void> {
    await this.client.command('job.put', { job });
  }

  async listJobs(chatKey: string): Promise<MemoryJob[]> {
    return this.listAllRows<MemoryJob>('jobs', chatKey);
  }

  async addJobBatchAudit(audit: MemoryJobBatchAudit): Promise<void> {
    await this.client.command('ingest.commit', { audit });
  }

  async listJobBatchAudits(chatKey: string, jobId?: string): Promise<MemoryJobBatchAudit[]> {
    return this.listAllRows<MemoryJobBatchAudit>('job_batch_audits', chatKey, { ...(jobId ? { jobId } : {}) });
  }

  async addMainChatUsage(usage: MainChatUsage): Promise<void> {
    await this.client.command('main_chat_usage.add', { usage });
  }

  async listMainChatUsage(chatKey: string): Promise<MainChatUsage[]> {
    return this.listAllRows<MainChatUsage>('main_chat_usage', chatKey);
  }

  rollbackJobBatch(jobId: string, batchIndex: number, expectedChatKey?: string): Promise<MemoryBatchSnapshot> {
    return this.client.command<MemoryBatchSnapshot>('batch.rollback', {
      jobId,
      batchIndex,
      ...(expectedChatKey ? { chatKey: expectedChatKey } : {}),
    });
  }

  async getSetting<T>(key: string): Promise<T | undefined> {
    const result = await this.client.query<MemorySettingRecord | { value?: T } | null>('settings', {
      filters: { key },
    });
    return result && 'value' in result ? result.value as T : undefined;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.client.command('setting.set', { key, value });
  }

  async setSettings(values: Record<string, unknown>): Promise<void> {
    await this.client.command('settings.setMany', {
      settings: Object.entries(values).map(([key, value]) => ({ key, value })),
    });
  }

  async addRecallLog(log: MemoryRecallLog): Promise<void> {
    await this.client.command('recall_log.add', { log });
  }

  async getLastRecall(chatKey: string): Promise<MemoryRecallLog | undefined> {
    const result = await this.client.query<MemoryRecallLog[] | { items?: MemoryRecallLog[] }>('recall_logs', {
      chatKey,
      limit: 1,
    });
    return rows(result)[0];
  }

  async clearCurrentChatData(chatKey: string): Promise<void> {
    await this.client.command('chat.clear', { chatKey });
  }

  async getChatKeys(): Promise<string[]> {
    const result = await this.client.query<string[] | { items?: string[] }>('chat_keys');
    return rows(result);
  }

  async upsertFactVector(input: UpsertMemoryFactVectorInput): Promise<MemoryFactVector> {
    const now = input.updatedAt ?? Date.now();
    const contentHash = await sha256Content(input.content);
    const vector = float32ArrayToArrayBuffer(input.vector);
    const metadata = await this.client.command<Omit<MemoryFactVector, 'vector'>>('vector.upsert', {
      factId: input.factId,
      chatKey: input.chatKey,
      contentHash,
      resourceId: input.resourceId,
      model: input.model,
      vector: Array.from(input.vector),
      updatedAt: now,
    });
    return {
      factId: metadata.factId ?? input.factId,
      chatKey: metadata.chatKey ?? input.chatKey,
      contentHash: metadata.contentHash ?? contentHash,
      resourceId: metadata.resourceId ?? input.resourceId,
      model: metadata.model ?? input.model,
      dimensions: metadata.dimensions ?? input.vector.length,
      vector,
      createdAt: metadata.createdAt ?? now,
      updatedAt: metadata.updatedAt ?? now,
    };
  }

  async deleteFactVector(chatKey: string, factId: string): Promise<boolean> {
    const result = await this.client.command<boolean | { removed: boolean }>('vector.delete', { chatKey, factId });
    return typeof result === 'boolean' ? result : result.removed;
  }

  async clearFactVectors(chatKey: string): Promise<number> {
    const result = await this.client.command<number | { removed: number }>('vector.clear', {
      chatKey,
    });
    return typeof result === 'number' ? result : result.removed;
  }

  async getFactVectorCoverage(chatKey: string, target: MemoryFactVectorTarget): Promise<MemoryFactVectorCoverage> {
    return this.client.query<MemoryFactVectorCoverage>('vector_coverage', {
      chatKey,
      filters: { target: { ...target } },
    });
  }

  async listFactsNeedingVectorRebuild(
    chatKey: string,
    target: MemoryFactVectorTarget,
    limit = 32,
  ): Promise<MemoryFact[]> {
    const result = await this.client.query<MemoryFact[] | { items?: MemoryFact[] }>('vector_rebuild', {
      chatKey,
      filters: { target: { ...target } },
      limit: Math.min(32, Math.max(1, Math.trunc(limit))),
    });
    return rows(result);
  }

  vectorSearch(input: {
    chatKey: string;
    vector: readonly number[] | Float32Array;
    limit?: number;
    resourceId?: string;
    model?: string;
  }): Promise<Array<{ factId: string; score: number }>> {
    return this.client.vectorSearch(input);
  }
}
