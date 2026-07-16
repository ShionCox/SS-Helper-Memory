import type { MemoryFact, MemoryFactVectorCoverage, MemoryTokenUsage } from '../../domain';
import { MemoryRepository } from '../../infrastructure';
import {
  MEMORY_EMBED_TASK,
  MEMORY_PLUGIN_ID,
  readMemoryLlmApi,
  readMemoryRecallRouteDiagnostics,
  type MemoryLlmApi,
  type MemoryLlmMeta,
} from '../ingest/llm-extractor';

const EMBEDDING_TIMEOUT_MS = 3_000;
const VECTOR_BATCH_SIZE = 32;
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
  private syncPromise: Promise<void> | null = null;
  private pendingSyncChatKey = '';
  private active = false;
  private lifecycleRevision = 0;

  constructor(
    private readonly repository: MemoryRepository,
    private readonly getLlm: () => MemoryLlmApi | null = readMemoryLlmApi,
    private readonly getRoutes: typeof readMemoryRecallRouteDiagnostics = readMemoryRecallRouteDiagnostics,
  ) {}

  start(): void {
    this.active = true;
    this.lifecycleRevision += 1;
  }

  stop(): void {
    this.active = false;
    this.lifecycleRevision += 1;
    this.queryCache.clear();
    this.pendingSyncChatKey = '';
  }

  scheduleSync(chatKey: string): void {
    if (!this.active || !chatKey) return;
    if (this.syncPromise) {
      this.pendingSyncChatKey = chatKey;
      return;
    }
    this.syncPromise = this.syncChat(chatKey).finally(() => {
      this.syncPromise = null;
      const pendingChatKey = this.pendingSyncChatKey;
      this.pendingSyncChatKey = '';
      if (this.active && pendingChatKey) this.scheduleSync(pendingChatKey);
    });
  }

  async rebuild(chatKey: string): Promise<void> {
    if (!this.active || !chatKey) return;
    this.pendingSyncChatKey = '';
    if (this.syncPromise) await this.syncPromise;
    await this.repository.clearFactVectors(chatKey);
    this.queryCache.clear();
    this.syncPromise = this.syncChat(chatKey).finally(() => { this.syncPromise = null; });
    await this.syncPromise;
  }

  async rebuildFacts(chatKey: string, factIds: readonly string[]): Promise<void> {
    if (!this.active || !chatKey) throw Object.assign(new Error('向量索引修复已排队。'), { code: 'VECTOR_INDEX_REPAIR_PENDING' });
    if (this.syncPromise) await this.syncPromise;
    const lifecycleRevision = this.lifecycleRevision;
    const route = (await this.getRoutes()).embedding;
    const llm = this.getLlm();
    if (!route.available || !route.resourceId || !route.model || route.blockedReason || !llm?.embed) {
      throw Object.assign(new Error('向量索引修复已排队。'), { code: 'VECTOR_INDEX_REPAIR_PENDING' });
    }
    const facts = (await Promise.all([...new Set(factIds)].map((factId) => this.repository.getFact(chatKey, factId))))
      .filter((fact): fact is MemoryFact => Boolean(fact && (fact.status === 'active' || fact.status === 'pending')));
    this.queryCache.clear();
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
        if (!response.ok || response.vectors.length !== batch.length) throw new Error('回滚向量修复失败。');
        const vectors = response.vectors.map(validateVector);
        const dimensions = vectors[0]?.length;
        if (!dimensions || vectors.some((vector) => vector.length !== dimensions)) throw new Error('回滚向量维度不一致。');
        const resourceId = response.meta?.resourceId ?? route.resourceId;
        const model = response.meta?.model ?? response.model ?? route.model;
        await Promise.all(batch.map((fact, index) => this.repository.upsertFactVector({
          factId: fact.id,
          chatKey,
          content: embeddingText(fact),
          resourceId,
          model,
          vector: vectors[index]!,
        })));
      }
    } catch {
      throw Object.assign(new Error('向量索引修复已排队。'), { code: 'VECTOR_INDEX_REPAIR_PENDING' });
    }
  }

  async getStatus(chatKey: string): Promise<VectorIndexStatus> {
    const diagnostics = await this.getRoutes();
    const route = diagnostics.embedding;
    const target = route.resourceId && route.model
      ? { resourceId: route.resourceId, model: route.model }
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
    const queryEmbedding = await this.embedQuery(query);
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
      this.statuses.set(chatKey, {
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
    let batchIndex = 0;
    try {
      while (true) {
        if (!this.active || lifecycleRevision !== this.lifecycleRevision) return;
        const target = { resourceId: route.resourceId, model: route.model, ...(dimensions ? { dimensions } : {}) };
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
        if (!response.ok) throw new Error(response.error || '事实 embedding 失败。');
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
        await Promise.all(facts.map((fact, index) => this.repository.upsertFactVector({
          factId: fact.id,
          chatKey,
          content: embeddingText(fact),
          resourceId,
          model,
          vector: normalized[index]!,
        })));
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
      const target = { resourceId: route.resourceId, model: route.model, ...(dimensions ? { dimensions } : {}) };
      const coverage = await this.repository.getFactVectorCoverage(chatKey, target);
      status({ rebuilding: false, coverage, pendingFacts: coverage.missing + coverage.stale });
    } catch (error) {
      status({ rebuilding: false, lastError: error instanceof Error ? error.message : String(error) });
    }
  }

  private async embedQuery(query: string): Promise<CachedQueryVector> {
    const diagnostics = await this.getRoutes();
    const route = diagnostics.embedding;
    if (!route.available || !route.resourceId || !route.model || route.blockedReason) {
      throw new Error(route.blockedReason ?? '没有可用的 embedding 路由。');
    }
    const key = `${route.resourceId}\u0000${route.model}\u0000${query.normalize('NFKC').trim()}`;
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
    if (!response.ok) throw new Error(response.error || '查询 embedding 失败。');
    if (response.vectors.length !== 1) throw new Error('查询 embedding 返回数量不为 1。');
    const entry: CachedQueryVector = {
      key,
      vector: validateVector(response.vectors[0]!),
      resourceId: response.meta?.resourceId ?? route.resourceId,
      model: response.meta?.model ?? response.model ?? route.model,
      ...(response.meta ? { meta: response.meta } : {}),
      usage: memoryUsage(response.usage),
      expiresAt: Date.now() + QUERY_CACHE_TTL_MS,
      cached: false,
    };
    this.queryCache.set(key, entry);
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
