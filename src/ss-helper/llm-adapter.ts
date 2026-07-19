import {
  LLM_CAPABILITY_STATUS_V1,
  LLM_EMBEDDING_V1,
  LLM_RERANK_V1,
  LLM_STRUCTURED_TASK_V1,
  type PluginSession,
} from '@ss-helper/sdk';
import type { MemoryLlmApi, MemoryLlmUsage } from '../application/ingest/llm-extractor';

type RunTaskInput = Parameters<MemoryLlmApi['runTask']>[0];

function serviceFailure(error: unknown): { error: string; reasonCode?: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (!error || typeof error !== 'object') return { error: message };
  const details = 'details' in error
    ? (error as { details?: { reasonCode?: unknown } }).details
    : undefined;
  const reasonCode = String(details?.reasonCode ?? '').trim();
  if (reasonCode) return { error: message, reasonCode };
  if (!('code' in error)) return { error: message };
  const code = String((error as { code?: unknown }).code ?? '').trim();
  return code ? { error: message, reasonCode: code } : { error: message };
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

export function createMemoryLlmApi(session: PluginSession, signal?: AbortSignal): MemoryLlmApi {
  return {
    inspect: {
      async previewRoute(input) {
        const timeoutMs = 5_000;
        const response = await session.services.call(LLM_CAPABILITY_STATUS_V1, {
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
      try {
        const response = await session.services.call(LLM_STRUCTURED_TASK_V1, {
          task: input.taskKey,
          input: input.input,
          outputSchema: input.schema as Record<string, never>,
        }, { signal });
        return {
          ok: true as const,
          data: response.output as T,
          meta: { resourceId: response.route.route, model: response.route.model, fallbackUsed: response.route.fallback },
          usage: usage(response.usage),
        };
      } catch (error) {
        return { ok: false as const, ...serviceFailure(error) };
      }
    },
    async embed(input) {
      try {
        const timeoutMs = input.budget?.maxLatencyMs ?? 30_000;
        const response = await session.services.call(LLM_EMBEDDING_V1, {
          input: input.texts,
          timeoutMs,
        }, { timeoutMs, signal });
        return { ok: true as const, vectors: response.embeddings.map((vector) => [...vector]), model: response.route.model, usage: usage(response.usage) };
      } catch (error) {
        return { ok: false as const, ...serviceFailure(error) };
      }
    },
    async rerank(input) {
      try {
        const timeoutMs = input.budget?.maxLatencyMs ?? 30_000;
        const response = await session.services.call(LLM_RERANK_V1, {
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
          usage: usage(response.usage),
        };
      } catch (error) {
        return { ok: false as const, ...serviceFailure(error) };
      }
    },
  };
}
