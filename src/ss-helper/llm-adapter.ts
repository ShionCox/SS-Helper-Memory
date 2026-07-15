import {
  LLM_EMBEDDING_V1,
  LLM_RERANK_V1,
  LLM_STRUCTURED_TASK_V1,
  type PluginSession,
} from '@ss-helper/sdk';
import type { MemoryLlmApi, MemoryLlmUsage } from '../application/ingest/llm-extractor';

type RunTaskInput = Parameters<MemoryLlmApi['runTask']>[0];

function usage(value: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined): MemoryLlmUsage | undefined {
  if (!value) return undefined;
  const promptTokens = value.inputTokens ?? 0;
  const completionTokens = value.outputTokens ?? 0;
  return { promptTokens, completionTokens, totalTokens: value.totalTokens ?? promptTokens + completionTokens };
}

export function createMemoryLlmApi(session: PluginSession, signal?: AbortSignal): MemoryLlmApi {
  return {
    async runTask<T>(input: RunTaskInput) {
      try {
        const timeoutMs = 60_000;
        const response = await session.services.call(LLM_STRUCTURED_TASK_V1, {
          task: input.taskKey,
          input: input.input,
          outputSchema: input.schema as Record<string, never>,
          timeoutMs,
        }, { timeoutMs, signal });
        return {
          ok: true as const,
          data: response.output as T,
          meta: { resourceId: response.route.route, model: response.route.model, fallbackUsed: response.route.fallback },
          usage: usage(response.usage),
        };
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
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
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
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
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
