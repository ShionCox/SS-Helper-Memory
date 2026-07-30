import {
  LLM_CAPABILITY_STATUS_V0,
  LLM_EMBEDDING_V0,
  LLM_RERANK_V0,
  LLM_STRUCTURED_TASK_V0,
  readSSHelperFailure,
  type SSHelperFailureContext,
  type PluginSession,
} from '@ss-helper/sdk';
import type { MemoryLlmClient, MemoryLlmUsage } from '../application/ingest/llm-extractor';

type RunTaskInput = Parameters<MemoryLlmClient['runTask']>[0];

function structuredTaskFailure(error: unknown): {
  readonly ok: false;
  readonly failure: SSHelperFailureContext;
  readonly meta?: { readonly requestId?: string };
} | null {
  const failure = readSSHelperFailure(error);
  if (!failure) return null;
  return {
    ok: false,
    failure,
    ...(failure.requestId ? { meta: { requestId: failure.requestId } } : {}),
  };
}

function usage(value: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined): MemoryLlmUsage | undefined {
  if (!value) return undefined;
  const promptTokens = value.inputTokens ?? 0;
  const completionTokens = value.outputTokens ?? 0;
  return { promptTokens, completionTokens, totalTokens: value.totalTokens ?? promptTokens + completionTokens };
}

const capabilityReason: Readonly<Record<string, string>> = Object.freeze({
  llm_disabled: 'LLM 已停用',
  no_resource: 'LLM 中尚未配置匹配的资源',
  resource_disabled: '匹配的 LLM 资源已停用',
  credential_missing: '匹配的 LLM 资源缺少凭据',
  route_unavailable: 'LLM 中没有满足当前任务的路由',
  tavern_unavailable: '酒馆当前没有可用的来源或模型',
  status_unavailable: '暂时无法读取 LLM 资源状态',
});

export function createMemoryLlmClient(session: PluginSession, signal?: AbortSignal): MemoryLlmClient {
  return {
    inspect: {
      async previewRoute(input) {
        const timeoutMs = 5_000;
        const response = await session.bus.request(LLM_CAPABILITY_STATUS_V0, {
          checks: [{
            id: input.taskKey,
            taskKey: input.taskKey,
            taskKind: input.taskKind,
            requiredCapabilities: input.requiredCapabilities,
          }],
        }, { timeoutMs, signal });
        const route = response.checks[0];
        if (!route) return { available: false, blockedReason: 'LLM 未返回资源状态' };
        return {
          available: route.available === true,
          ...(route.resourceId ? { resourceId: route.resourceId } : {}),
          ...(route.model ? { model: route.model } : {}),
          ...(route.available ? {} : { blockedReason: capabilityReason[route.reason ?? 'status_unavailable'] ?? 'LLM 资源不可用' }),
        };
      },
    },
    async runTask<T>(input: RunTaskInput) {
      const timeoutMs = input.budget.maxLatencyMs ?? 30_000;
      let response;
      try {
        response = await session.bus.request(LLM_STRUCTURED_TASK_V0, {
          task: input.taskKey,
          input: input.input,
          outputSchema: input.schema as Record<string, never>,
          ...(input.route?.resourceId ? { route: input.route.resourceId } : {}),
          ...(input.route?.model ? { model: input.route.model } : {}),
          ...(input.parentRequestId ? { parentRequestId: input.parentRequestId } : {}),
        }, { timeoutMs, signal });
      } catch (error) {
        const failure = structuredTaskFailure(error);
        if (failure) return failure;
        throw error;
      }
      return {
        ok: true as const,
        data: response.output as T,
        meta: {
          requestId: response.requestId,
          resourceId: response.route.route,
          model: response.route.model,
          fallbackUsed: response.route.fallback,
          attemptCount: response.diagnostics.attemptCount,
          repairCount: response.diagnostics.repairCount,
          transport: response.diagnostics.transport,
          validationOutcome: response.diagnostics.validationOutcome,
          itemRejections: response.diagnostics.itemRejections.map(item => ({
            collection: item.collection,
            itemIndex: item.itemIndex,
            issues: item.issues.map(issue => ({ ...issue })),
            sourceRefs: [...item.sourceRefs],
          })),
          parentRequestId: response.parentRequestId,
        },
        usage: usage(response.usage),
      };
    },
    async embed(input) {
      const timeoutMs = input.budget?.maxLatencyMs ?? 30_000;
      const response = await session.bus.request(LLM_EMBEDDING_V0, {
        input: input.texts,
        timeoutMs,
      }, { timeoutMs, signal });
      return { ok: true as const, vectors: response.embeddings.map((vector) => [...vector]), model: response.route.model, meta: { requestId: response.requestId }, usage: usage(response.usage) };
    },
    async rerank(input) {
      const timeoutMs = input.budget?.maxLatencyMs ?? 30_000;
      const response = await session.bus.request(LLM_RERANK_V0, {
        query: input.query,
        documents: input.docs.map((text, index) => ({ id: String(index), text })),
        topN: input.topK,
        timeoutMs,
      }, { timeoutMs, signal });
      return {
        ok: true as const,
        results: response.results.map((item) => ({ index: item.index, score: item.score, doc: input.docs[item.index] })),
        resource: response.route.route,
        fallbackUsed: response.route.fallback,
        meta: { requestId: response.requestId },
        usage: usage(response.usage),
      };
    },
  };
}
