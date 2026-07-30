import type { MemoryTokenUsage } from '../../domain';
import { createSSHelperError, describeSSHelperFailure } from '@ss-helper/sdk';
import {
  MEMORY_PLUGIN_ID,
  MEMORY_RERANK_TASK,
  readMemoryLlmClient,
  type MemoryLlmClient,
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
import type { GraphRecallCandidateProvider, GraphRecallSearchResult } from '../graph';
import { MemoryVectorIndexService, type VectorSearchResult } from './vector-index-service';
import { planRecallIntentByRules } from './recall-intent-planner';

export type MemoryRecallMode = 'auto' | 'lexical' | 'vector' | 'hybrid';
export type MemoryRerankMode = 'off' | 'adaptive' | 'always';
export interface MemoryGraphRecallOptions {
  maxHops: 1 | 2;
  maxEdges: number;
}

function sourceFloor(item: RecallItem): number | undefined {
  const values = [...(item.fact.sourceRefs ?? []), ...(item.fact.evidenceRefs ?? [])]
    .map(value => Number(value.match(/message:floor-(\d+)/u)?.[1]))
    .filter(Number.isFinite);
  return values.length > 0 ? Math.min(...values) : undefined;
}

function rerankDocument(item: RecallItem): string {
  const floor = sourceFloor(item);
  return [
    `[${item.fact.kind}]`,
    item.fact.subjectKey,
    item.fact.predicateKey,
    item.fact.objectKey ?? '',
    floor === undefined ? '' : `floor=${floor}`,
    item.fact.content,
  ].filter(Boolean).join('｜');
}

function rerankDocumentLimit(query: string): number {
  const intent = planRecallIntentByRules(query);
  // The configured Qwen3 endpoint consistently completes eight long memory
  // documents in about 24s, while twelve can exceed the 30s provider deadline.
  if (intent.complexity === 'multi_hop' || intent.complexity === 'multi_topic') return 8;
  if (intent.requestedKinds.length > 0 || intent.timeMode !== 'unknown') return 8;
  return 4;
}

function buildRerankQuery(query: string): string {
  const intent = planRecallIntentByRules(query);
  const priorities: string[] = [
    'Rank roleplay memory facts by whether they directly answer the user query.',
    'Prefer exact entity matches and concrete evidence over merely related facts.',
  ];
  if (intent.requestedKinds.includes('capability')) {
    priorities.push('For ability questions, rank capability facts above plans, assignments, or commitments.');
  }
  if (intent.timeMode === 'current') {
    priorities.push('For current-state questions, prefer the latest exact numeric or state value.');
  }
  if (intent.timeMode === 'historical' || intent.timeMode === 'timeline') {
    priorities.push('For historical questions, prefer facts from the requested time or earliest matching event, not later related actions.');
  }
  if (intent.requestedKinds.length > 0) priorities.push(`Requested fact types: ${intent.requestedKinds.join(', ')}.`);
  return `${priorities.join(' ')}\nUser query: ${query}`;
}

function selectRerankItems(items: readonly RecallItem[], query: string, temporalHeadSize: number, limit: number): RecallItem[] {
  const candidates = items.slice(temporalHeadSize);
  if (candidates.length <= limit) return [...candidates];
  const intent = planRecallIntentByRules(query);
  const requestedKinds = new Set(intent.requestedKinds.map(value => value.trim().toLocaleLowerCase()).filter(Boolean));
  const selected: RecallItem[] = [];
  const append = (item: RecallItem | undefined): void => {
    if (item && selected.length < limit && !selected.some(current => current.fact.id === item.fact.id)) selected.push(item);
  };

  // Preserve broad retrieval quality while reserving slots for candidates that
  // directly answer the requested memory type. This prevents a capability or
  // historical event at rank 9–20 from being invisible to the cross-encoder.
  // Keep several fusion leaders while reserving space for temporal/type/entity
  // candidates. Qwen3-Reranker supports long contexts; a query-adaptive pool is
  // more robust than a fixed top-four gate without paying the cost on generic
  // direct lookups.
  candidates.slice(0, Math.min(4, Math.max(2, Math.ceil(limit / 3)))).forEach(append);
  if (EARLIEST_QUERY_PATTERN.test(query)) {
    append([...candidates]
      .filter(item => requestedKinds.size === 0 || requestedKinds.has(item.fact.kind.toLocaleLowerCase()))
      .sort((left, right) => (sourceFloor(left) ?? Number.MAX_SAFE_INTEGER) - (sourceFloor(right) ?? Number.MAX_SAFE_INTEGER)
        || left.fact.updatedAt - right.fact.updatedAt)[0]);
  }
  candidates
    .filter(item => requestedKinds.has(item.fact.kind.toLocaleLowerCase()))
    .forEach(append);
  const normalizedQuery = query.normalize('NFKC').toLocaleLowerCase();
  candidates
    .filter(item => {
      const names = [item.fact.subjectKey, item.fact.objectKey ?? '', ...item.fact.entityKeys]
        .map(value => value.trim().normalize('NFKC').toLocaleLowerCase())
        .filter(value => value.length >= 2);
      return names.some(name => normalizedQuery.includes(name));
    })
    .forEach(append);
  candidates.forEach(append);
  return selected;
}

// The configured Qwen3 cross-encoder needs about 15–19s for 8–12 long memory
// candidates. Keep enough headroom for route inspection and provider jitter.
const RERANK_TIMEOUT_MS = 30_000;
const TOTAL_EXTRA_RECALL_BUDGET_MS = 40_000;
const RERANK_MODEL_WEIGHT = 0.85;
const HISTORICAL_QUERY_PATTERN = /(?:曾经|当时|之前|历史|过程|最早|最初|一开始|中段|先后|一路|变化|如何发展|起初|后来)/u;
const CURRENT_STATE_QUERY_PATTERN = /(?:最新状态|最后确认|当前|现在|目前|还剩|剩余|还能|现有|最终确认)/u;
const STATE_HISTORY_TOPIC_PATTERN = /(?:状态|数量|多少|几次|次数|弹药|剩余|还剩|变化|一路|先后)/u;
const EARLIEST_QUERY_PATTERN = /(?:最早|最初|一开始|起初|起先|初次)/u;
const DIRECTIVE_QUERY_PATTERN = /(?:指挥|指令|命令|下令|安排|分工|应对|调度)/u;

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
  const graphTop = [...items]
    .filter(item => item.graphRank !== undefined)
    .sort((left, right) => (left.graphRank ?? Number.MAX_SAFE_INTEGER) - (right.graphRank ?? Number.MAX_SAFE_INTEGER))[0];
  const top = items[0];
  if (lexicalTop && vectorTop && lexicalTop.fact.id !== vectorTop.fact.id) return true;
  if (graphTop && ((lexicalTop && graphTop.fact.id !== lexicalTop.fact.id) || (vectorTop && graphTop.fact.id !== vectorTop.fact.id))) return true;
  if (top?.reason.vector && !top.reason.lexical && !top.reason.entity && !top.reason.context) return true;
  const firstScore = items[0]?.score ?? 0;
  const secondScore = items[1]?.score ?? 0;
  const normalizedGap = firstScore > 0 ? Math.abs(firstScore - secondScore) / firstScore : 1;
  return normalizedGap <= 0.08;
}

function normalizedRerankScore(item: RecallItem, modelScore: number): number {
  // Do not use batch min-max: an entirely irrelevant batch must not manufacture a 1.0 winner.
  const support = Math.min(1, Math.max(0, item.lexicalScore ?? 0, item.vectorScore ?? 0, item.graphScore ?? 0));
  return modelScore * (RERANK_MODEL_WEIGHT + (1 - RERANK_MODEL_WEIGHT) * support);
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
  private readonly graph: GraphRecallCandidateProvider | undefined;
  private readonly getLlm: () => MemoryLlmClient | null;

  constructor(
    private readonly index: MemoryRecallIndex,
    private readonly vectors: MemoryVectorIndexService,
    graphOrGetLlm?: GraphRecallCandidateProvider | (() => MemoryLlmClient | null),
    getLlm: () => MemoryLlmClient | null = readMemoryLlmClient,
  ) {
    if (typeof graphOrGetLlm === 'function') this.getLlm = graphOrGetLlm;
    else {
      this.graph = graphOrGetLlm;
      this.getLlm = getLlm;
    }
  }

  async recall(
    query: RecallQuery,
    requestedMode: MemoryRecallMode,
    rerankMode: MemoryRerankMode,
    graphOptions?: MemoryGraphRecallOptions,
  ): Promise<RecallResult> {
    const startedAt = Date.now();
    const deadline = startedAt + TOTAL_EXTRA_RECALL_BUDGET_MS;
    const maxItems = clampRequestedItems(query.maxItems);
    // Multi-actor recall may need one independent candidate budget per active
    // owner. The final response is still capped by `maxItems`; this pool only
    // prevents the highest-scoring actor from starving other partitions.
    const candidatePoolSize = Math.min(120, Math.max(12, query.candidateLimit ?? maxItems * 2));
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
        const diagnostic = describeSSHelperFailure(error, {
          reasonCode: 'INTERNAL_ERROR',
          stage: 'memory.recall.vector',
        });
        degradedReason = `${diagnostic.reasonCode} · ${diagnostic.title}`;
      }
    }

    const allowedFactIds = query.allowedFactIds ? new Set(query.allowedFactIds) : undefined;
    const vectorScores = new Map((vectorResult?.candidates ?? [])
      .filter(item => !allowedFactIds || allowedFactIds.has(item.factId))
      .map(item => [item.factId, item.score]));
    const initial = this.index.recall(query, {
      mode: resolvedMode,
      vectorScores,
      candidateLimit: candidatePoolSize,
    });
    let graphResult: GraphRecallSearchResult | undefined;
    let graphDegradedReason = '';
    let graphScores = new Map<string, number>();
    if (this.graph && graphOptions) {
      try {
        const seedEntityKeys = [...new Set(initial.items.flatMap((item) => [
          item.fact.subjectKey,
          ...(item.fact.objectKey ? [item.fact.objectKey] : []),
          ...item.fact.entityKeys,
        ]).map((value) => value.trim()).filter(Boolean))];
        graphResult = await this.graph.search({
          chatKey: query.chatKey,
          query: query.query,
          seedEntityKeys,
          maxHops: graphOptions.maxHops,
          maxEdges: graphOptions.maxEdges,
        });
        graphScores = new Map(graphResult.candidates
          .filter(item => !allowedFactIds || allowedFactIds.has(item.factId))
          .map((item) => [item.factId, item.score]));
      } catch {
        // Do not persist graph labels, query text, or evidence in diagnostics.
        graphDegradedReason = '关系图谱候选不可用，已回退到原有召回。';
      }
    }
    const finalMode: 'lexical' | 'vector' | 'hybrid' = graphScores.size > 0 ? 'hybrid' : resolvedMode;
    const base = graphScores.size > 0
      ? this.index.recall(query, {
        mode: finalMode,
        vectorScores,
        graphScores,
        candidateLimit: candidatePoolSize,
      })
      : initial;
    if (graphDegradedReason) degradedReason = degradedReason || graphDegradedReason;
    let orderedItems = [...base.items];
    const temporalHeadSize = EARLIEST_QUERY_PATTERN.test(query.query) && DIRECTIVE_QUERY_PATTERN.test(query.query)
      ? Math.min(6, orderedItems.length)
      : HISTORICAL_QUERY_PATTERN.test(query.query)
      && STATE_HISTORY_TOPIC_PATTERN.test(query.query)
      ? 2
      : CURRENT_STATE_QUERY_PATTERN.test(query.query)
        ? 1
        : 0;
    const preservedTemporalItems = orderedItems.slice(0, temporalHeadSize);
    // The fused pool remains broad (up to 120). Generic lookups keep the old
    // four-document fast path, while typed/temporal and complex questions get
    // eight intent-aware candidates to stay within the real provider SLA.
    const rerankItems = selectRerankItems(
      orderedItems,
      query.query,
      temporalHeadSize,
      rerankDocumentLimit(query.query),
    );
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
        const routeTimeoutMs = Math.min(RERANK_TIMEOUT_MS, remainingMs);
        const rerankStartedAt = Date.now();
        try {
          const route = llm.inspect?.previewRoute
            ? await withTimeout(Promise.resolve(llm.inspect.previewRoute({
                consumer: MEMORY_PLUGIN_ID,
                taskKey: MEMORY_RERANK_TASK,
                taskKind: 'rerank',
                requiredCapabilities: ['rerank'],
              })), routeTimeoutMs, 'memory_rerank_route')
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
            const rerankRemainingMs = Math.max(0, deadline - Date.now());
            if (rerankRemainingMs === 0) {
              const error = '召回总预算已用尽，已跳过重排。';
              degradedReason = degradedReason || error;
              rerankDiagnostic = {
                requested: true,
                success: false,
                ...(route?.resourceId ? { resourceId: route.resourceId } : {}),
                ...(route?.model ? { model: route.model } : {}),
                latencyMs: Date.now() - rerankStartedAt,
                error,
              };
            } else {
              const rerankTimeoutMs = Math.min(RERANK_TIMEOUT_MS, rerankRemainingMs);
              llmCalls += 1;
              const response = await withTimeout(llm.rerank({
                consumer: MEMORY_PLUGIN_ID,
                taskKey: MEMORY_RERANK_TASK,
                taskDescription: '记忆候选重排',
                query: buildRerankQuery(query.query),
                docs: rerankItems.map(rerankDocument),
                topK: rerankItems.length,
                budget: { maxLatencyMs: rerankTimeoutMs },
                enqueue: { displayMode: 'silent' },
              }), rerankTimeoutMs, 'memory_rerank');
              if (!response.ok) throw createSSHelperError(response.failure.reasonCode, response.failure);
              const seen = new Set<number>();
              const valid = response.results
                .filter(item => {
                  if (!Number.isInteger(item.index)
                    || item.index < 0
                    || item.index >= rerankItems.length
                    || !Number.isFinite(item.score)
                    || item.score < 0
                    || item.score > 1
                    || seen.has(item.index)) return false;
                  seen.add(item.index);
                  return true;
                })
                .sort((left, right) => right.score - left.score || left.index - right.index);
              const rankedIndexes = new Set(valid.map(item => item.index));
              const reranked = valid.map(result => ({
                ...rerankItems[result.index]!,
                score: normalizedRerankScore(rerankItems[result.index]!, result.score),
                rerankScore: result.score,
              }));
              const rerankIds = new Set(rerankItems.map(item => item.fact.id));
              orderedItems = [
                ...preservedTemporalItems,
                ...reranked,
                ...rerankItems.filter((_, index) => !rankedIndexes.has(index)),
                ...orderedItems.filter(item => !preservedTemporalItems.some(preserved => preserved.fact.id === item.fact.id) && !rerankIds.has(item.fact.id)),
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
          }
        } catch (error) {
          const diagnostic = describeSSHelperFailure(error, {
            reasonCode: 'INTERNAL_ERROR',
            stage: 'memory.recall.rerank',
          });
          const message = `${diagnostic.reasonCode} · ${diagnostic.title}`;
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
      resolvedMode: finalMode,
      vectorCandidateCount: vectorScores.size,
      graphCandidateCount: graphScores.size,
      graphHitCount: graphResult?.edgeHitCount,
      graphSeedNodeCount: graphResult?.seedNodeCount,
      graphLatencyMs: graphResult?.latencyMs,
      ...(graphDegradedReason ? { graphDegradedReason } : {}),
      fusedCandidateCount: finalMode === 'hybrid' ? base.diagnostics.candidateCount : undefined,
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
  rerankModelWeight: RERANK_MODEL_WEIGHT,
});
