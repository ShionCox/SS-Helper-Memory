import { describe, expect, it, vi } from 'vitest';
import { LLM_EMBEDDING_V0, LLM_RERANK_V0, LLM_STRUCTURED_TASK_V0, LLM_TASK_STATUS_V0, type PluginSession } from '@ss-helper/sdk';
import { createMemoryLlmClient } from '../src/ss-helper/llm-client';

describe('SDK LLM typed adapter', () => {
  it('maps structured/embed/rerank calls through public contracts with timeout and abort options', async () => {
    const signal = new AbortController().signal;
    const call = vi.fn(async (contract: unknown) => {
      if (contract === LLM_STRUCTURED_TASK_V0) return {
        requestId: 'r1',
        output: { facts: [] },
        route: { resourceId: 'memory', source: 'custom', provider: 'openai', model: 'm1', execution: 'structured', transport: 'json_schema' },
        diagnostics: {
          transport: 'json_schema',
          attemptCount: 1,
          repairCount: 0,
          validationOutcome: 'complete',
          itemRejections: [],
        },
      };
      if (contract === LLM_EMBEDDING_V0) return { requestId: 'r2', embeddings: [[1, 2]], route: { resourceId: 'embed', source: 'custom', provider: 'openai', model: 'e1', execution: 'embedding', transport: 'embedding' } };
      return { requestId: 'r3', results: [{ id: '1', index: 1, score: 0.9 }], route: { resourceId: 'rerank', source: 'custom', provider: 'openai', model: 'r1', execution: 'rerank', transport: 'rerank' } };
    });
    const api = createMemoryLlmClient({ bus: { request: call } } as unknown as PluginSession, signal);
    const trace = { workflowId: 'pipeline-1', workflowLabel: '初始化记忆', workflowKind: 'agent', jobId: 'job-1', batchIndex: 0, batchCount: 2 };

    const structured = await api.runTask({
      consumer: 'stx_memory', taskKey: 'memory_extract', taskDescription: 'extract', taskKind: 'generation',
      input: { messages: [{ role: 'user', content: 'hello' }] }, schema: { type: 'object' },
      budget: { maxTokens: 100, maxLatencyMs: 4321 }, enqueue: { displayMode: 'silent' },
      trace,
    });
    expect(structured).toMatchObject({ ok: true, data: { facts: [] }, meta: { model: 'm1' } });
    expect(structured).toHaveProperty('usage', undefined);
    await expect(api.embed?.({ consumer: 'stx_memory', taskKey: 'memory_embed', texts: ['hello'], budget: { maxLatencyMs: 1234 }, trace }))
      .resolves.toMatchObject({ ok: true, vectors: [[1, 2]], model: 'e1' });
    await expect(api.rerank?.({ consumer: 'stx_memory', taskKey: 'memory_rerank', query: 'q', docs: ['a', 'b'], topK: 1, trace }))
      .resolves.toMatchObject({ ok: true, results: [{ index: 1, score: 0.9, doc: 'b' }] });

    expect(call).toHaveBeenNthCalledWith(1, LLM_STRUCTURED_TASK_V0, expect.objectContaining({ timeoutMs: 4321, trace }), { timeoutMs: 4321, signal });
    expect(call).toHaveBeenNthCalledWith(2, LLM_EMBEDDING_V0, expect.objectContaining({ task: 'memory_embed', timeoutMs: 1234, trace }), { timeoutMs: 1234, signal });
    expect(call).toHaveBeenNthCalledWith(3, LLM_RERANK_V0, expect.objectContaining({ task: 'memory_rerank', timeoutMs: 30_000, trace }), { timeoutMs: 30_000, signal });
  });

  it('propagates typed Bus failures without a Memory error wrapper', async () => {
    const api = createMemoryLlmClient({ bus: { request: async () => { throw new Error('Core unavailable'); } } } as unknown as PluginSession);
    await expect(api.embed?.({ consumer: 'stx_memory', taskKey: 'memory_embed', texts: ['x'] }))
      .rejects.toThrow('Core unavailable');
  });

  it('returns structured embed and rerank failures with safe route metadata', async () => {
    const failure = Object.assign(new Error('capability unavailable'), {
      code: 'NOT_FOUND',
      details: { reasonCode: 'LLM_CAPABILITY_UNAVAILABLE', stage: 'llm.route.resolve', requestId: 'request-safe', resourceId: 'resource-safe', model: 'model-safe' },
    });
    const api = createMemoryLlmClient({ bus: { request: async () => { throw failure; } } } as unknown as PluginSession);

    await expect(api.embed?.({ consumer: 'stx_memory', taskKey: 'memory_embed', texts: ['x'] })).resolves.toMatchObject({
      ok: false,
      failure: { reasonCode: 'LLM_CAPABILITY_UNAVAILABLE', stage: 'llm.route.resolve' },
      meta: { requestId: 'request-safe', resourceId: 'resource-safe', model: 'model-safe' },
    });
    await expect(api.rerank?.({ consumer: 'stx_memory', taskKey: 'memory_rerank', query: 'q', docs: ['x'], topK: 1 })).resolves.toMatchObject({
      ok: false,
      failure: { reasonCode: 'LLM_CAPABILITY_UNAVAILABLE', stage: 'llm.route.resolve' },
    });
  });

  it('preserves the SDK error code for workbench diagnostics', async () => {
    const failure = Object.assign(new Error('The public data boundary rejected a value'), { code: 'INVALID_PAYLOAD' });
    const api = createMemoryLlmClient({ bus: { request: async () => { throw failure; } } } as unknown as PluginSession);
    await expect(api.runTask({
      consumer: 'stx_memory', taskKey: 'memory_extract', taskDescription: 'extract', taskKind: 'generation',
      input: { messages: [{ role: 'user', content: 'hello' }] }, schema: { type: 'object' },
      budget: { maxTokens: 100 }, enqueue: { displayMode: 'silent' },
    })).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
  });

  it('prefers the provider reason code retained in SDK error details', async () => {
    const failure = Object.assign(new Error('模型返回内容不是有效 JSON'), {
      code: 'INVALID_PAYLOAD',
      details: {
        stage: 'llm.structured.validate', reasonCode: 'INVALID_JSON', requestId: 'request-1',
        inputTokens: 12, outputTokens: 3, totalTokens: 15,
      },
    });
    const api = createMemoryLlmClient({ bus: { request: async () => { throw failure; } } } as unknown as PluginSession);
    await expect(api.runTask({
      consumer: 'stx_memory', taskKey: 'memory_extract', taskDescription: 'extract', taskKind: 'generation',
      input: { messages: [{ role: 'user', content: 'hello' }] }, schema: { type: 'object' },
      budget: { maxTokens: 100 }, enqueue: { displayMode: 'silent' },
    })).resolves.toMatchObject({
      ok: false,
      failure: { reasonCode: 'INVALID_JSON', stage: 'llm.structured.validate', requestId: 'request-1' },
      usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
    });
  });

  it('reads the real LLM capability service before reporting a recall route as available', async () => {
    const signal = new AbortController().signal;
    const call = vi.fn(async () => ({
      revision: 3,
      tasks: [{ taskKey: 'memory_embed', execution: 'embedding', available: false, failure: { reasonCode: 'LLM_TASK_ROUTE_UNAVAILABLE', stage: 'llm.task.status' } }],
      defaults: {}, assignments: [], resources: [],
    }));
    const api = createMemoryLlmClient({ bus: { request: call } } as unknown as PluginSession, signal);

    await expect(api.inspect?.previewRoute({
      consumer: 'stx_memory', taskKey: 'memory_embed', taskKind: 'embedding', requiredCapabilities: ['embeddings'],
    })).resolves.toEqual({ available: false, failure: { reasonCode: 'LLM_TASK_ROUTE_UNAVAILABLE', stage: 'llm.task.status' } });
    expect(call).toHaveBeenCalledWith(LLM_TASK_STATUS_V0, { taskKeys: ['memory_embed'] }, { timeoutMs: 5_000, signal });
  });
});
