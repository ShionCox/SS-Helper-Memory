import {
  LLM_EMBEDDING_V0,
  LLM_RERANK_V0,
  LLM_STRUCTURED_TASK_V0,
  LLM_TASK_STATUS_V0,
  LLM_TASK_ROUTE_SET_V0,
  LLM_RESOURCE_CAPABILITY_VERIFY_V0,
  LLM_TOOL_SESSION_CANCEL_V0,
  LLM_TOOL_TURN_V0,
  readSSHelperFailure,
  type SSHelperFailureContext,
  type PluginSession,
} from '@ss-helper/sdk';
import { memoryLlmUsageFromError, memoryLlmUsageFromProvider, type MemoryLlmClient, type MemoryLlmUsage } from '../application/ingest/llm-extractor';

type RunTaskInput = Parameters<MemoryLlmClient['runTask']>[0];

function structuredTaskFailure(error: unknown): {
  readonly ok: false;
  readonly failure: SSHelperFailureContext;
  readonly meta?: { readonly requestId?: string };
  readonly usage?: MemoryLlmUsage;
} | null {
  const failure = readSSHelperFailure(error);
  if (!failure) return null;
  const usage = memoryLlmUsageFromError(error);
  return {
    ok: false,
    failure,
    ...(failure.requestId || failure.resourceId || failure.model ? { meta: {
      ...(failure.requestId ? { requestId: failure.requestId } : {}),
      ...(failure.resourceId ? { resourceId: failure.resourceId } : {}),
      ...(failure.model ? { model: failure.model } : {}),
    } } : {}),
    ...(usage ? { usage } : {}),
  };
}

export function createMemoryLlmClient(session: PluginSession, signal?: AbortSignal): MemoryLlmClient {
  return {
    inspect: {
      async previewRoute(input) {
        const timeoutMs = 5_000;
        const response = await session.bus.request(LLM_TASK_STATUS_V0, { taskKeys: [input.taskKey] }, { timeoutMs, signal });
        const route = response.tasks.find((task) => task.taskKey === input.taskKey);
        if (!route) return {
          available: false,
          failure: { reasonCode: 'LLM_TASK_ROUTE_UNAVAILABLE', stage: 'memory.routing.inspect' },
        };
        return {
          available: route.available,
          ...(route.resourceId ? { resourceId: route.resourceId } : {}),
          ...(route.route?.model ? { model: route.route.model } : {}),
          ...(route.failure ? { failure: route.failure } : {}),
        };
      },
      async getTaskStatus(taskKeys) {
        return session.bus.request(LLM_TASK_STATUS_V0, {
          ...(taskKeys && taskKeys.length > 0 ? { taskKeys: [...taskKeys] } : {}),
        }, { timeoutMs: 10_000, signal });
      },
      async setTaskRoute(input) {
        return session.bus.request(LLM_TASK_ROUTE_SET_V0, input, { timeoutMs: 10_000, signal });
      },
      async verifyResourceCapability(input) {
        return session.bus.request(LLM_RESOURCE_CAPABILITY_VERIFY_V0, input, { timeoutMs: 30_000, signal });
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
          timeoutMs,
          ...(input.parentRequestId ? { parentRequestId: input.parentRequestId } : {}),
          ...(input.trace ? { trace: input.trace } : {}),
        }, { timeoutMs, signal: input.signal ?? signal });
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
          resourceId: response.route.resourceId ?? 'unknown',
          model: response.route.model,
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
        usage: memoryLlmUsageFromProvider(response.usage),
      };
    },
    async embed(input) {
      const timeoutMs = input.budget?.maxLatencyMs ?? 30_000;
      try {
        const response = await session.bus.request(LLM_EMBEDDING_V0, {
          task: input.taskKey,
          input: input.texts,
          timeoutMs,
          ...(input.trace ? { trace: input.trace } : {}),
        }, { timeoutMs, signal });
        return {
          ok: true as const,
          vectors: response.embeddings.map((vector) => [...vector]),
          model: response.route.model,
          meta: {
            requestId: response.requestId,
            resourceId: response.route.resourceId ?? 'unknown',
            model: response.route.model,
          },
          usage: memoryLlmUsageFromProvider(response.usage),
        };
      } catch (error) {
        const failure = structuredTaskFailure(error);
        if (failure) return failure;
        throw error;
      }
    },
    async rerank(input) {
      const timeoutMs = input.budget?.maxLatencyMs ?? 30_000;
      try {
        const response = await session.bus.request(LLM_RERANK_V0, {
          task: input.taskKey,
          query: input.query,
          documents: input.docs.map((text, index) => ({ id: String(index), text })),
          topN: input.topK,
          timeoutMs,
          ...(input.trace ? { trace: input.trace } : {}),
        }, { timeoutMs, signal });
        return {
          ok: true as const,
          results: response.results.map((item) => ({ index: item.index, score: item.score, doc: input.docs[item.index] })),
          resource: response.route.resourceId ?? 'unknown',
          meta: {
            requestId: response.requestId,
            resourceId: response.route.resourceId ?? 'unknown',
            model: response.route.model,
          },
          usage: memoryLlmUsageFromProvider(response.usage),
        };
      } catch (error) {
        const failure = structuredTaskFailure(error);
        if (failure) return failure;
        throw error;
      }
    },
    async toolTurn(input, requestSignal) {
      return session.bus.request(LLM_TOOL_TURN_V0, input, { timeoutMs: input.timeoutMs ?? 600_000, signal: requestSignal ?? signal });
    },
    async cancelToolSession(toolSessionId, reason) {
      await session.bus.request(LLM_TOOL_SESSION_CANCEL_V0, {
        toolSessionId,
        ...(reason ? { reason } : {}),
      }, { timeoutMs: 5_000, signal });
    },
  };
}
