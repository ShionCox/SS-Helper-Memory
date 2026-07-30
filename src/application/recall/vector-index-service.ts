import type { MemoryFact, MemoryFactVectorCoverage, MemoryTokenUsage } from '../../domain';
import { createSSHelperError, describeSSHelperFailure, readSSHelperFailure } from '@ss-helper/sdk';
import { MemoryRepository } from '../../infrastructure';
import {
  MEMORY_EMBED_TASK,
  MEMORY_PLUGIN_ID,
  readMemoryLlmClient,
  readMemoryRecallRouteDiagnostics,
  type MemoryLlmClient,
  type MemoryLlmMeta,
} from '../ingest/llm-extractor';

// Remote embedding endpoints can legitimately take several seconds for large
// rebuild batches. A 3s deadline caused healthy Qwen3 requests to be aborted
// mid-rebuild and left the physical vector table only partially populated.
const EMBEDDING_TIMEOUT_MS = 15_000;
// The browser plugin bus serializes every vector component. Keep rebuild pages
// small enough that a 1024-dimension response can cross that boundary without
// consuming the request deadline on structured-clone/validation work.
const VECTOR_BATCH_SIZE = 8;
const VECTOR_TOP_K = 60;
const QUERY_CACHE_SIZE = 64;
const QUERY_CACHE_TTL_MS = 10 * 60 * 1_000;

export interface VectorSearchCandidate {
  factId: string;
  score: number;
  rank: number;
}

export interface VectorRequestAudit {
  requestId?: string;
  resourceId?: string;
  model?: string;
  dimensions?: number;
  inputCount: number;
  latencyMs: number;
  usage: MemoryTokenUsage | null;
  cached?: boolean;
}

export interface VectorSearchResult {
  candidates: VectorSearchCandidate[];
  cutoff: number | null;
  audit: VectorRequestAudit;
}

export interface VectorBatchAudit extends VectorRequestAudit {
  batchIndex: number;
  accepted: number;
  rejected: number;
}

export interface VectorIndexStatus {
  route: {
    available: boolean;
    resourceId?: string;
    model?: string;
    blockedReason?: string;
  };
  coverage: MemoryFactVectorCoverage | null;
  rebuilding: boolean;
  pendingFacts: number;
  lastError?: string;
  batches: readonly VectorBatchAudit[];
}

interface CachedQueryVector {
  key: string;
  vector: Float32Array;
  resourceId: string;
  model: string;
  meta?: MemoryLlmMeta;
  usage: MemoryTokenUsage | null;
  expiresAt: number;
  cached: boolean;
}

interface ResolvedEmbeddingTarget {
  requestedResourceId: string;
  requestedModel: string;
  resourceId: string;
  model: string;
}

function memoryUsage(usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined): MemoryTokenUsage | null {
  return usage ? {
    promptTokens: Number.isFinite(usage.promptTokens) ? usage.promptTokens : null,
    completionTokens: Number.isFinite(usage.completionTokens) ? usage.completionTokens : null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: Number.isFinite(usage.totalTokens) ? usage.totalTokens : null,
  } : null;
}

function validateVector(input: readonly number[]): Float32Array {
  if (input.length === 0) throw new Error('embedding 返回了空向量。');
  const vector = Float32Array.from(input);
  let norm = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index]!;
    if (!Number.isFinite(value)) throw new Error(`embedding 第 ${index} 维不是有限数值。`);
    norm += value * value;
  }
  if (norm === 0) throw new Error('embedding 返回了零向量。');
  return vector;
}

function embeddingText(fact: MemoryFact): string {
  return [
    `类型：${fact.kind}`,
    `主体：${fact.subjectKey}`,
    `谓词：${fact.predicateKey}`,
    fact.objectKey ? `对象：${fact.objectKey}` : '',
    fact.entityKeys.length > 0 ? `实体：${fact.entityKeys.join('、')}` : '',
    `事实：${fact.content}`,
  ].filter(Boolean).join('\n');
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new Error(`${label} 超过 ${timeoutMs}ms，已降级。`)), timeoutMs);
    promise.then(
      value => { globalThis.clearTimeout(timer); resolve(value); },
      error => { globalThis.clearTimeout(timer); reject(error); },
    );
  });
}

/** 管理事实向量的单并发回填、查询缓存与本地余弦扫描。 */
export class MemoryVectorIndexService {
  private readonly queryCache = new Map<string, CachedQueryVector>();
  private readonly statuses = new Map<string, VectorIndexStatus>();
  private readonly statusListeners = new Set<(chatKey: string, status: VectorIndexStatus) => void>();
  /**
   * LLMHub may execute an embedding request on a fallback route.  Keep that
   * route for the current service lifetime so the next sync looks for the
   * vectors it actually wrote instead of continuously rebuilding them against
   * the diagnostic route.
   */
  private readonly resolvedEmbeddingTargets = new Map<string, ResolvedEmbeddingTarget>();
  private syncPromise: Promise<void> | null = null;
  private rebuildPromise: Promise<void> | null = null;
  private pendingSyncChatKey = '';
  private active = false;
  private lifecycleRevision = 0;

  constructor(
    private readonly repository: MemoryRepository,
    private readonly getLlm: () => MemoryLlmClient | null = readMemoryLlmClient,
    private readonly getRoutes: typeof readMemoryRecallRouteDiagnostics = readMemoryRecallRouteDiagnostics,
  ) {}

  onStatusChanged(listener: (chatKey: string, status: VectorIndexStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(chatKey: string, status: VectorIndexStatus): void {
    this.statuses.set(chatKey, status);
    this.statusListeners.forEach((listener) => {
      try { listener(chatKey, status); } catch { /* presentation observers cannot break index work */ }
    });
  }

  private finishSync(completed: Promise<void>): void {
    // An older task must never clear the pointer of a newer queued task. This
    // was the source of overlapping vector rebuilds after a pending sync was
    // scheduled from a `finally` callback.
    if (this.syncPromise !== completed) return;
    this.syncPromise = null;
    if (this.rebuildPromise) return;
    const pendingChatKey = this.pendingSyncChatKey;
    this.pendingSyncChatKey = '';
    if (this.active && pendingChatKey) this.scheduleSync(pendingChatKey);
  }

  private startSync(chatKey: string): Promise<void> {
    let tracked!: Promise<void>;
    tracked = this.syncChat(chatKey).finally(() => this.finishSync(tracked));
    this.syncPromise = tracked;
    return tracked;
  }

  private async waitForSyncIdle(): Promise<void> {
    while (this.syncPromise) {
      const current = this.syncPromise;
      await current;
      // `finishSync` may have promoted a pending task. Loop until the entire
      // chain is drained instead of awaiting only the promise observed first.
    }
  }

  start(): void {
    this.active = true;
    this.lifecycleRevision += 1;
  }

  stop(): void {
    this.active = false;
    this.lifecycleRevision += 1;
    this.queryCache.clear();
    this.resolvedEmbeddingTargets.clear();
    this.pendingSyncChatKey = '';
  }

  scheduleSync(chatKey: string): void {
    if (!this.active || !chatKey) return;
    if (this.rebuildPromise || this.syncPromise) {
      this.pendingSyncChatKey = chatKey;
      return;
    }
    this.startSync(chatKey);
  }

  async rebuild(chatKey: string): Promise<void> {
    if (!this.active || !chatKey) return;
    if (this.rebuildPromise) {
      await this.rebuildPromise;
      return;
    }
    let tracked!: Promise<void>;
    tracked = (async () => {
      this.pendingSyncChatKey = '';
      await this.waitForSyncIdle();
      await this.repository.clearFactVectors(chatKey);
      this.queryCache.clear();
      this.resolvedEmbeddingTargets.delete(chatKey);
      await this.syncChat(chatKey);
      // A same-chat sync requested during this exclusive rebuild is already
      // covered by syncChat's until-empty loop. Do not start a redundant task
      // after returning to the validation caller.
      if (this.pendingSyncChatKey === chatKey) this.pendingSyncChatKey = '';
    })().finally(() => {
      if (this.rebuildPromise === tracked) this.rebuildPromise = null;
      const pendingChatKey = this.pendingSyncChatKey;
      this.pendingSyncChatKey = '';
      if (this.active && pendingChatKey) this.scheduleSync(pendingChatKey);
    });
    this.rebuildPromise = tracked;
    await tracked;
  }

  async rebuildFacts(chatKey: string, factIds: readonly string[]): Promise<void> {
    if (!this.active || !chatKey) throw createSSHelperError('WORKSPACE_UNAVAILABLE', {
      stage: 'memory.vector.rebuild',
    });
    if (this.rebuildPromise) await this.rebuildPromise;
    await this.waitForSyncIdle();
    const operation = (async (): Promise<void> => {
      const lifecycleRevision = this.lifecycleRevision;
      const route = (await this.getRoutes()).embedding;
      const llm = this.getLlm();
      if (!route.available || !route.resourceId || !route.model || route.blockedReason || !llm?.embed) {
        throw createSSHelperError('LLM_CAPABILITY_UNAVAILABLE', {
          stage: 'memory.vector.route',
          resourceId: route.resourceId,
          model: route.model,
        });
      }
      const facts = (await Promise.all([...new Set(factIds)].map((factId) => this.repository.getFact(chatKey, factId))))
        .filter((fact): fact is MemoryFact => Boolean(fact && (fact.status === 'active' || fact.status === 'pending')));
      this.queryCache.clear();
      let observedResponseRoute: { resourceId: string; model: string } | undefined;
      try {
        for (let offset = 0; offset < facts.length; offset += VECTOR_BATCH_SIZE) {
          if (!this.active || lifecycleRevision !== this.lifecycleRevision) throw new Error('Memory 生命周期已变化。');
          const batch = facts.slice(offset, offset + VECTOR_BATCH_SIZE);
          const response = await withTimeout(llm.embed({
            consumer: MEMORY_PLUGIN_ID,
            taskKey: MEMORY_EMBED_TASK,
            taskDescription: '回滚后选择性重建事实向量',
            texts: batch.map(embeddingText),
            budget: { maxLatencyMs: EMBEDDING_TIMEOUT_MS },
            enqueue: { displayMode: 'silent' },
          }), EMBEDDING_TIMEOUT_MS, '回滚向量修复');
          if (!this.active || lifecycleRevision !== this.lifecycleRevision) throw new Error('Memory 生命周期已变化。');
          if (!response.ok || response.vectors.length !== batch.length) throw new Error('回滚向量修复失败。');
          const vectors = response.vectors.map(validateVector);
          const dimensions = vectors[0]?.length;
          if (!dimensions || vectors.some((vector) => vector.length !== dimensions)) throw new Error('回滚向量维度不一致。');
          const resourceId = response.meta?.resourceId ?? route.resourceId;
          const model = response.meta?.model ?? response.model ?? route.model;
          if (observedResponseRoute && (observedResponseRoute.resourceId !== resourceId || observedResponseRoute.model !== model)) {
            throw new Error('embedding 路由在修复期间发生变化。');
          }
          observedResponseRoute = { resourceId, model };
          await Promise.all(batch.map((fact, index) => this.repository.upsertFactVector({
            factId: fact.id,
            chatKey,
            content: embeddingText(fact),
            resourceId,
            model,
            vector: vectors[index]!,
          })));
          this.rememberEmbeddingTarget(chatKey, route.resourceId, route.model, { resourceId, model });
        }
      } catch (error) {
        const failure = readSSHelperFailure(error, {
          reasonCode: 'INTERNAL_ERROR',
          stage: 'memory.vector.rebuild',
        })!;
        throw createSSHelperError(failure.reasonCode, failure);
      }
    })();
    let tracked!: Promise<void>;
    tracked = operation.finally(() => this.finishSync(tracked));
    this.syncPromise = tracked;
    await tracked;
  }

  async getStatus(chatKey: string): Promise<VectorIndexStatus> {
    const diagnostics = await this.getRoutes();
    const route = diagnostics.embedding;
    const target = route.resourceId && route.model
      ? this.getEmbeddingTarget(chatKey, route.resourceId, route.model)
      : null;
    const coverage = target ? await this.repository.getFactVectorCoverage(chatKey, target) : null;
    const previous = this.statuses.get(chatKey);
    return {
      route,
      coverage,
      rebuilding: previous?.rebuilding ?? false,
      pendingFacts: (coverage?.missing ?? 0) + (coverage?.stale ?? 0),
      ...(previous?.lastError ? { lastError: previous.lastError } : {}),
      batches: previous?.batches ?? [],
    };
  }

  async search(chatKey: string, query: string, maxItems = VECTOR_TOP_K): Promise<VectorSearchResult> {
    const startedAt = Date.now();
    const queryEmbedding = await this.embedQuery(chatKey, query);
    const scored = (await this.repository.vectorSearch({
      chatKey,
      vector: queryEmbedding.vector,
      limit: Math.min(VECTOR_TOP_K, Math.max(1, Math.trunc(maxItems))),
      resourceId: queryEmbedding.resourceId,
      model: queryEmbedding.model,
    })).filter(item => Number.isFinite(item.score) && item.score > 0)
      .sort((left, right) => right.score - left.score || left.factId.localeCompare(right.factId));
    const best = scored[0]?.score;
    const cutoff = best === undefined ? null : Math.max(0.20, best - 0.18);
    const candidates = cutoff === null ? [] : scored
      .filter(item => item.score >= cutoff)
      .slice(0, Math.min(VECTOR_TOP_K, Math.max(1, Math.trunc(maxItems))))
      .map((item, index) => ({ ...item, rank: index + 1 }));
    return {
      candidates,
      cutoff,
      audit: {
        ...(queryEmbedding.meta?.requestId ? { requestId: queryEmbedding.meta.requestId } : {}),
        resourceId: queryEmbedding.resourceId,
        model: queryEmbedding.model,
        dimensions: queryEmbedding.vector.length,
        inputCount: 1,
        latencyMs: Date.now() - startedAt,
        usage: queryEmbedding.usage,
        cached: queryEmbedding.cached,
      },
    };
  }

  private async syncChat(chatKey: string): Promise<void> {
    if (!this.active) return;
    const lifecycleRevision = this.lifecycleRevision;
    const diagnostics = await this.getRoutes();
    const route = diagnostics.embedding;
    const batches: VectorBatchAudit[] = [];
    const status = (patch: Partial<VectorIndexStatus>): void => {
      const previous = this.statuses.get(chatKey);
      this.setStatus(chatKey, {
        route,
        coverage: previous?.coverage ?? null,
        rebuilding: previous?.rebuilding ?? false,
        pendingFacts: previous?.pendingFacts ?? 0,
        batches,
        ...patch,
      });
    };
    if (!route.available || !route.resourceId || !route.model || route.blockedReason) {
      status({ rebuilding: false, lastError: route.blockedReason ?? '没有可用的 embedding 路由。' });
      return;
    }
    const llm = this.getLlm();
    if (!llm?.embed) {
      status({ rebuilding: false, lastError: 'LLMHub 未加载或版本过旧。' });
      return;
    }
    status({ rebuilding: true });
    let dimensions: number | undefined;
    let targetRoute = this.getEmbeddingTarget(chatKey, route.resourceId, route.model);
    let observedResponseRoute: { resourceId: string; model: string } | undefined;
    let batchIndex = 0;
    try {
      while (true) {
        if (!this.active || lifecycleRevision !== this.lifecycleRevision) return;
        const target = { ...targetRoute, ...(dimensions ? { dimensions } : {}) };
        const facts = await this.repository.listFactsNeedingVectorRebuild(chatKey, target, VECTOR_BATCH_SIZE);
        const coverage = await this.repository.getFactVectorCoverage(chatKey, target);
        status({ coverage, pendingFacts: coverage.missing + coverage.stale });
        if (facts.length === 0) break;
        const startedAt = Date.now();
        const response = await withTimeout(llm.embed({
          consumer: MEMORY_PLUGIN_ID,
          taskKey: MEMORY_EMBED_TASK,
          taskDescription: '记忆事实向量回填',
          texts: facts.map(embeddingText),
          budget: { maxLatencyMs: EMBEDDING_TIMEOUT_MS },
          enqueue: { displayMode: 'silent' },
        }), EMBEDDING_TIMEOUT_MS, '事实 embedding');
        if (!response.ok) throw createSSHelperError(response.failure.reasonCode, response.failure);
        if (response.vectors.length !== facts.length) {
          throw new Error(`embedding 返回 ${response.vectors.length} 条向量，预期 ${facts.length} 条。`);
        }
        const normalized = response.vectors.map(validateVector);
        const firstDimensions = normalized[0]?.length;
        if (!firstDimensions || normalized.some(vector => vector.length !== firstDimensions)) {
          throw new Error('同批 embedding 维度不一致。');
        }
        if (dimensions !== undefined && dimensions !== firstDimensions) throw new Error('embedding 模型维度在回填期间发生变化。');
        dimensions = firstDimensions;
        if (!this.active || lifecycleRevision !== this.lifecycleRevision) return;
        const resourceId = response.meta?.resourceId ?? route.resourceId;
        const model = response.meta?.model ?? response.model ?? route.model;
        if (observedResponseRoute && (observedResponseRoute.resourceId !== resourceId || observedResponseRoute.model !== model)) {
          throw new Error('embedding 路由在回填期间发生变化。');
        }
        observedResponseRoute = { resourceId, model };
        await Promise.all(facts.map((fact, index) => this.repository.upsertFactVector({
          factId: fact.id,
          chatKey,
          content: embeddingText(fact),
          resourceId,
          model,
          vector: normalized[index]!,
        })));
        targetRoute = { resourceId, model };
        this.rememberEmbeddingTarget(chatKey, route.resourceId, route.model, targetRoute);
        batchIndex += 1;
        batches.push({
          batchIndex,
          ...(response.meta?.requestId ? { requestId: response.meta.requestId } : {}),
          resourceId,
          model,
          dimensions,
          inputCount: facts.length,
          accepted: facts.length,
          rejected: 0,
          latencyMs: Date.now() - startedAt,
          usage: memoryUsage(response.usage),
        });
      }
      const target = { ...targetRoute, ...(dimensions ? { dimensions } : {}) };
      const coverage = await this.repository.getFactVectorCoverage(chatKey, target);
      status({ rebuilding: false, coverage, pendingFacts: coverage.missing + coverage.stale });
    } catch (error) {
      const diagnostic = describeSSHelperFailure(error, {
        reasonCode: 'INTERNAL_ERROR',
        stage: 'memory.vector.rebuild',
      });
      status({ rebuilding: false, lastError: `${diagnostic.reasonCode} · ${diagnostic.title}` });
    }
  }

  private getEmbeddingTarget(chatKey: string, requestedResourceId: string, requestedModel: string): { resourceId: string; model: string } {
    const remembered = this.resolvedEmbeddingTargets.get(chatKey);
    if (remembered
      && remembered.requestedResourceId === requestedResourceId
      && remembered.requestedModel === requestedModel) {
      return { resourceId: remembered.resourceId, model: remembered.model };
    }
    if (remembered) this.resolvedEmbeddingTargets.delete(chatKey);
    return { resourceId: requestedResourceId, model: requestedModel };
  }

  private rememberEmbeddingTarget(
    chatKey: string,
    requestedResourceId: string,
    requestedModel: string,
    actual: { resourceId: string; model: string },
  ): void {
    const previous = this.resolvedEmbeddingTargets.get(chatKey);
    if (previous && (
      previous.requestedResourceId !== requestedResourceId
      || previous.requestedModel !== requestedModel
      || previous.resourceId !== actual.resourceId
      || previous.model !== actual.model
    )) this.queryCache.clear();
    this.resolvedEmbeddingTargets.set(chatKey, {
      requestedResourceId,
      requestedModel,
      resourceId: actual.resourceId,
      model: actual.model,
    });
  }

  private async embedQuery(chatKey: string, query: string): Promise<CachedQueryVector> {
    const diagnostics = await this.getRoutes();
    const route = diagnostics.embedding;
    if (!route.available || !route.resourceId || !route.model || route.blockedReason) {
      throw new Error(route.blockedReason ?? '没有可用的 embedding 路由。');
    }
    const requestedTarget = this.getEmbeddingTarget(chatKey, route.resourceId, route.model);
    const normalizedQuery = query.normalize('NFKC').trim();
    const key = `${requestedTarget.resourceId}\u0000${requestedTarget.model}\u0000${normalizedQuery}`;
    const cached = this.queryCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      this.queryCache.delete(key);
      this.queryCache.set(key, cached);
      return { ...cached, cached: true };
    }
    if (cached) this.queryCache.delete(key);
    const llm = this.getLlm();
    if (!llm?.embed) throw new Error('LLMHub 未加载或不支持 embedding。');
    const response = await withTimeout(llm.embed({
      consumer: MEMORY_PLUGIN_ID,
      taskKey: MEMORY_EMBED_TASK,
      taskDescription: '记忆查询向量',
      texts: [query],
      budget: { maxLatencyMs: EMBEDDING_TIMEOUT_MS },
      enqueue: { displayMode: 'silent' },
    }), EMBEDDING_TIMEOUT_MS, '查询 embedding');
    if (!response.ok) throw createSSHelperError(response.failure.reasonCode, response.failure);
    if (response.vectors.length !== 1) throw new Error('查询 embedding 返回数量不为 1。');
    const resourceId = response.meta?.resourceId ?? route.resourceId;
    const model = response.meta?.model ?? response.model ?? route.model;
    this.rememberEmbeddingTarget(chatKey, route.resourceId, route.model, { resourceId, model });
    const actualKey = `${resourceId}\u0000${model}\u0000${normalizedQuery}`;
    const entry: CachedQueryVector = {
      key: actualKey,
      vector: validateVector(response.vectors[0]!),
      resourceId,
      model,
      ...(response.meta ? { meta: response.meta } : {}),
      usage: memoryUsage(response.usage),
      expiresAt: Date.now() + QUERY_CACHE_TTL_MS,
      cached: false,
    };
    this.queryCache.set(actualKey, entry);
    while (this.queryCache.size > QUERY_CACHE_SIZE) {
      const oldest = this.queryCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.queryCache.delete(oldest);
    }
    return entry;
  }
}

export const vectorRecallLimits = Object.freeze({
  batchSize: VECTOR_BATCH_SIZE,
  topK: VECTOR_TOP_K,
  queryCacheSize: QUERY_CACHE_SIZE,
  queryCacheTtlMs: QUERY_CACHE_TTL_MS,
  embeddingTimeoutMs: EMBEDDING_TIMEOUT_MS,
});
