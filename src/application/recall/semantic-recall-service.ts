import type { MemoryTokenUsage } from '../../domain';
import {
  MEMORY_PLUGIN_ID,
  MEMORY_RERANK_TASK,
  readMemoryLlmApi,
  type MemoryLlmApi,
} from '../ingest/llm-extractor';
import {
  MemoryRecallIndex,
  recallLimits,
  type RecallCandidateDecision,
  type RecallDiagnostics,
  type RecallItem,
  type RecallQuery,
  type RecallResult,
} from './memory-recall-index';
import { MemoryVectorIndexService, type VectorSearchResult } from './vector-index-service';

export type MemoryRecallMode = 'auto' | 'lexical' | 'vector' | 'hybrid';
export type MemoryRerankMode = 'off' | 'adaptive' | 'always';

const RERANK_TIMEOUT_MS = 15_000;
const TOTAL_EXTRA_RECALL_BUDGET_MS = 19_000;
const MAX_RERANK_DOCUMENTS = 4;
const HISTORICAL_QUERY_PATTERN = /(?:曾经|当时|之前|历史|过程|最早|最初|一开始|中段|先后|一路|变化|如何发展|起初|后来)/u;
const CURRENT_STATE_QUERY_PATTERN = /(?:最新状态|最后确认|当前|现在|目前|还剩|剩余|还能|现有|最终确认)/u;
const STATE_HISTORY_TOPIC_PATTERN = /(?:状态|数量|多少|几次|次数|弹药|剩余|还剩|变化|一路|先后)/u;

function clampRequestedItems(value: number | undefined): number {
  if (!Number.isFinite(value)) return recallLimits.default;
  return Math.min(recallLimits.max, Math.max(recallLimits.min, Math.trunc(value!)));
}

function usageOrNull(usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined): MemoryTokenUsage | null {
  return usage ? {
    promptTokens: Number.isFinite(usage.promptTokens) ? usage.promptTokens : null,
    completionTokens: Number.isFinite(usage.completionTokens) ? usage.completionTokens : null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: Number.isFinite(usage.totalTokens) ? usage.totalTokens : null,
  } : null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new Error(`${label} 超过 ${timeoutMs}ms，已保留原排序。`)), timeoutMs);
    promise.then(
      value => { globalThis.clearTimeout(timer); resolve(value); },
      error => { globalThis.clearTimeout(timer); reject(error); },
    );
  });
}

function adaptiveRerankRequired(items: readonly RecallItem[]): boolean {
  if (items.length < 4) return false;
  const lexicalTop = [...items]
    .filter(item => item.lexicalRank !== undefined)
    .sort((left, right) => (left.lexicalRank ?? Number.MAX_SAFE_INTEGER) - (right.lexicalRank ?? Number.MAX_SAFE_INTEGER))[0];
  const vectorTop = [...items]
    .filter(item => item.vectorRank !== undefined)
    .sort((left, right) => (left.vectorRank ?? Number.MAX_SAFE_INTEGER) - (right.vectorRank ?? Number.MAX_SAFE_INTEGER))[0];
  const top = items[0];
  if (lexicalTop && vectorTop && lexicalTop.fact.id !== vectorTop.fact.id) return true;
  if (top?.reason.vector && !top.reason.lexical && !top.reason.entity && !top.reason.context) return true;
  const firstScore = items[0]?.score ?? 0;
  const secondScore = items[1]?.score ?? 0;
  const normalizedGap = firstScore > 0 ? Math.abs(firstScore - secondScore) / firstScore : 1;
  return normalizedGap <= 0.08;
}

function updateCandidate(
  candidate: RecallCandidateDecision,
  item: RecallItem | undefined,
  selectedIds: ReadonlySet<string>,
): RecallCandidateDecision {
  if (!item) return { ...candidate, selected: false };
  return {
    ...candidate,
    score: item.score,
    selected: selectedIds.has(candidate.factId),
    ...(item.rerankScore === undefined ? {} : { rerankScore: item.rerankScore }),
    ...(selectedIds.has(candidate.factId) ? { omittedReason: undefined } : {}),
  };
}

/** 组合本地硬过滤、向量扫描、RRF 与可选 LLM 重排，并保证失败时可降级。 */
export class SemanticRecallService {
  constructor(
    private readonly index: MemoryRecallIndex,
    private readonly vectors: MemoryVectorIndexService,
    private readonly getLlm: () => MemoryLlmApi | null = readMemoryLlmApi,
  ) {}

  async recall(
    query: RecallQuery,
    requestedMode: MemoryRecallMode,
    rerankMode: MemoryRerankMode,
  ): Promise<RecallResult> {
    const startedAt = Date.now();
    const deadline = startedAt + TOTAL_EXTRA_RECALL_BUDGET_MS;
    const maxItems = clampRequestedItems(query.maxItems);
    const candidatePoolSize = Math.min(60, Math.max(12, maxItems * 2));
    let resolvedMode: 'lexical' | 'vector' | 'hybrid' = 'lexical';
    let vectorResult: VectorSearchResult | null = null;
    let degradedReason = '';
    let llmCalls = 0;

    if (requestedMode !== 'lexical') {
      try {
        llmCalls += 1;
        vectorResult = await this.vectors.search(query.chatKey, query.query, 60);
        if (vectorResult.audit.cached) llmCalls -= 1;
        if (vectorResult.candidates.length > 0) {
          resolvedMode = requestedMode === 'vector' ? 'vector' : 'hybrid';
        } else {
          degradedReason = '没有达到动态阈值的向量候选，已退回词法召回。';
        }
      } catch (error) {
        degradedReason = error instanceof Error ? error.message : String(error);
      }
    }

    const vectorScores = new Map((vectorResult?.candidates ?? []).map(item => [item.factId, item.score]));
    const base = this.index.recall(query, {
      mode: resolvedMode,
      vectorScores,
      candidateLimit: candidatePoolSize,
    });
    let orderedItems = [...base.items];
    const temporalHeadSize = HISTORICAL_QUERY_PATTERN.test(query.query)
      && STATE_HISTORY_TOPIC_PATTERN.test(query.query)
      ? 2
      : CURRENT_STATE_QUERY_PATTERN.test(query.query)
        ? 1
        : 0;
    const preservedTemporalItems = orderedItems.slice(0, temporalHeadSize);
    const rerankItems = orderedItems.slice(temporalHeadSize, temporalHeadSize + MAX_RERANK_DOCUMENTS);
    const shouldRerank = rerankMode === 'always'
      || (rerankMode === 'adaptive' && adaptiveRerankRequired(rerankItems));
    let rerankDiagnostic: RecallDiagnostics['rerank'];

    if (shouldRerank && rerankItems.length > 1) {
      const llm = this.getLlm();
      const remainingMs = Math.max(0, deadline - Date.now());
      if (!llm?.rerank || remainingMs === 0) {
        const error = !llm?.rerank ? 'LLMHub 未加载或不支持 rerank，已保留融合排序。' : '召回总预算已用尽，已跳过重排。';
        degradedReason = degradedReason || error;
        rerankDiagnostic = { requested: true, success: false, error };
      } else {
        const timeoutMs = Math.min(RERANK_TIMEOUT_MS, remainingMs);
        const rerankStartedAt = Date.now();
        try {
          const route = llm.inspect?.previewRoute
            ? await llm.inspect.previewRoute({
                consumer: MEMORY_PLUGIN_ID,
                taskKey: MEMORY_RERANK_TASK,
                taskKind: 'rerank',
                requiredCapabilities: ['rerank'],
              })
            : null;
          if (route?.blockedReason) {
            degradedReason = degradedReason || route.blockedReason;
            rerankDiagnostic = {
              requested: true,
              success: false,
              ...(route.resourceId ? { resourceId: route.resourceId } : {}),
              ...(route.model ? { model: route.model } : {}),
              latencyMs: Date.now() - rerankStartedAt,
              error: route.blockedReason,
            };
          } else {
          llmCalls += 1;
          const response = await withTimeout(llm.rerank({
            consumer: MEMORY_PLUGIN_ID,
            taskKey: MEMORY_RERANK_TASK,
            taskDescription: '记忆候选重排',
            query: query.query,
            docs: rerankItems.map(item => item.fact.content),
            topK: rerankItems.length,
            budget: { maxLatencyMs: timeoutMs },
            enqueue: { displayMode: 'silent' },
          }), timeoutMs, 'memory_rerank');
          if (!response.ok) throw new Error(response.error || 'memory_rerank 失败。');
          const seen = new Set<number>();
          const valid = response.results
            .filter(item => {
              if (!Number.isInteger(item.index)
                || item.index < 0
                || item.index >= rerankItems.length
                || !Number.isFinite(item.score)
                || seen.has(item.index)) return false;
              seen.add(item.index);
              return true;
            })
            .sort((left, right) => right.score - left.score || left.index - right.index);
          const rankedIndexes = new Set(valid.map(item => item.index));
          const reranked = valid.map(result => ({
            ...rerankItems[result.index]!,
            score: result.score,
            rerankScore: result.score,
          }));
          orderedItems = [
            ...preservedTemporalItems,
            ...reranked,
            ...rerankItems.filter((_, index) => !rankedIndexes.has(index)),
            ...orderedItems.slice(temporalHeadSize + rerankItems.length),
          ];
          rerankDiagnostic = {
            requested: true,
            success: true,
            ...(response.meta?.requestId ? { requestId: response.meta.requestId } : {}),
            ...(response.meta?.resourceId || response.resource ? { resourceId: response.meta?.resourceId ?? response.resource } : {}),
            ...(response.meta?.model ? { model: response.meta.model } : {}),
            latencyMs: response.meta?.latencyMs ?? Date.now() - rerankStartedAt,
            usage: usageOrNull(response.usage),
            ...(response.fallbackUsed ? { fallbackUsed: true } : {}),
          };
          if (response.fallbackUsed) degradedReason = degradedReason || '重排资源使用了非 LLM 关键词兜底。';
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          degradedReason = degradedReason || message;
          rerankDiagnostic = {
            requested: true,
            success: false,
            latencyMs: Date.now() - rerankStartedAt,
            error: message,
          };
        }
      }
    } else {
      rerankDiagnostic = { requested: false, success: false };
    }

    const items = Object.freeze(orderedItems.slice(0, maxItems).map(item => Object.freeze(item)));
    const itemMap = new Map(orderedItems.map(item => [item.fact.id, item]));
    const selectedIds = new Set(items.map(item => item.fact.id));
    const candidates = Object.freeze(base.candidates.map(candidate => Object.freeze(
      updateCandidate(candidate, itemMap.get(candidate.factId), selectedIds),
    )));
    const embeddingDiagnostic: RecallDiagnostics['embedding'] = requestedMode === 'lexical'
      ? { requested: false, success: false }
      : vectorResult
        ? {
            requested: true,
            success: true,
            ...(vectorResult.audit.cached ? { cached: true } : {}),
            ...(vectorResult.audit.requestId ? { requestId: vectorResult.audit.requestId } : {}),
            ...(vectorResult.audit.resourceId ? { resourceId: vectorResult.audit.resourceId } : {}),
            ...(vectorResult.audit.model ? { model: vectorResult.audit.model } : {}),
            latencyMs: vectorResult.audit.latencyMs,
            usage: vectorResult.audit.usage,
          }
        : { requested: true, success: false, error: degradedReason || '向量召回不可用。' };
    const diagnostics = Object.freeze({
      ...base.diagnostics,
      selectedCount: items.length,
      llmCalls,
      requestedMode,
      resolvedMode,
      vectorCandidateCount: vectorScores.size,
      fusedCandidateCount: resolvedMode === 'hybrid' ? base.diagnostics.candidateCount : undefined,
      ...(degradedReason ? { degradedReason } : {}),
      embedding: embeddingDiagnostic,
      rerank: rerankDiagnostic,
      totalExtraLatencyMs: Date.now() - startedAt,
    });
    return Object.freeze({
      ...base,
      maxItems,
      items,
      candidates,
      diagnostics,
    });
  }
}

export const semanticRecallLimits = Object.freeze({
  rerankTimeoutMs: RERANK_TIMEOUT_MS,
  totalExtraBudgetMs: TOTAL_EXTRA_RECALL_BUDGET_MS,
});
