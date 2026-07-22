import { describe, expect, it, vi } from 'vitest';
import { LLM_CAPABILITY_STATUS_V0, LLM_EMBEDDING_V0, LLM_RERANK_V0, LLM_STRUCTURED_TASK_V0, type PluginSession } from '@ss-helper/sdk';
import { createMemoryLlmApi } from '../src/ss-helper/llm-adapter';

describe('SDK LLM typed adapter', () => {
  it('maps structured/embed/rerank calls through public contracts with timeout and abort options', async () => {
    const signal = new AbortController().signal;
    const call = vi.fn(async (contract: { name: string }) => {
      if (contract === LLM_STRUCTURED_TASK_V0) return { output: { facts: [] }, route: { route: 'memory', model: 'm1' } };
      if (contract === LLM_EMBEDDING_V0) return { embeddings: [[1, 2]], route: { route: 'embed', model: 'e1' } };
      return { results: [{ id: '1', index: 1, score: 0.9 }], route: { route: 'rerank' } };
    });
    const api = createMemoryLlmApi({ services: { call } } as unknown as PluginSession, signal);

    await expect(api.runTask({
      consumer: 'stx_memory', taskKey: 'memory_extract', taskDescription: 'extract', taskKind: 'generation',
      input: { messages: [{ role: 'user', content: 'hello' }] }, schema: { type: 'object' },
      budget: { maxTokens: 100 }, enqueue: { displayMode: 'silent' },
    })).resolves.toMatchObject({ ok: true, data: { facts: [] }, meta: { model: 'm1' } });
    await expect(api.embed?.({ consumer: 'stx_memory', taskKey: 'memory_embed', texts: ['hello'], budget: { maxLatencyMs: 1234 } }))
      .resolves.toMatchObject({ ok: true, vectors: [[1, 2]], model: 'e1' });
    await expect(api.rerank?.({ consumer: 'stx_memory', taskKey: 'memory_rerank', query: 'q', docs: ['a', 'b'], topK: 1 }))
      .resolves.toMatchObject({ ok: true, results: [{ index: 1, score: 0.9, doc: 'b' }] });

    expect(call).toHaveBeenNthCalledWith(1, LLM_STRUCTURED_TASK_V0, expect.not.objectContaining({ timeoutMs: expect.anything() }), { signal });
    expect(call).toHaveBeenNthCalledWith(2, LLM_EMBEDDING_V0, expect.objectContaining({ timeoutMs: 1234 }), { timeoutMs: 1234, signal });
    expect(call).toHaveBeenNthCalledWith(3, LLM_RERANK_V0, expect.objectContaining({ timeoutMs: 30_000 }), { timeoutMs: 30_000, signal });
  });

  it('keeps typed service failures inside the retained Memory result boundary', async () => {
    const api = createMemoryLlmApi({ services: { call: async () => { throw new Error('Core unavailable'); } } } as unknown as PluginSession);
    await expect(api.embed?.({ consumer: 'stx_memory', taskKey: 'memory_embed', texts: ['x'] }))
      .resolves.toEqual({ ok: false, error: 'Core unavailable' });
  });

  it('preserves the SDK error code for workbench diagnostics', async () => {
    const failure = Object.assign(new Error('The public data boundary rejected a value'), { code: 'PAYLOAD_INVALID' });
    const api = createMemoryLlmApi({ services: { call: async () => { throw failure; } } } as unknown as PluginSession);
    await expect(api.runTask({
      consumer: 'stx_memory', taskKey: 'memory_extract', taskDescription: 'extract', taskKind: 'generation',
      input: { messages: [{ role: 'user', content: 'hello' }] }, schema: { type: 'object' },
      budget: { maxTokens: 100 }, enqueue: { displayMode: 'silent' },
    })).resolves.toEqual({ ok: false, error: 'The public data boundary rejected a value', reasonCode: 'PAYLOAD_INVALID' });
  });

  it('prefers the provider reason code retained in SDK error details', async () => {
    const failure = Object.assign(new Error('模型返回内容不是有效 JSON'), {
      code: 'PAYLOAD_INVALID',
      details: { phase: 'handler', reasonCode: 'invalid_json' },
    });
    const api = createMemoryLlmApi({ services: { call: async () => { throw failure; } } } as unknown as PluginSession);
    await expect(api.runTask({
      consumer: 'stx_memory', taskKey: 'memory_extract', taskDescription: 'extract', taskKind: 'generation',
      input: { messages: [{ role: 'user', content: 'hello' }] }, schema: { type: 'object' },
      budget: { maxTokens: 100 }, enqueue: { displayMode: 'silent' },
    })).resolves.toEqual({ ok: false, error: '模型返回内容不是有效 JSON', reasonCode: 'invalid_json' });
  });

  it('reads the real LLM capability service before reporting a recall route as available', async () => {
    const signal = new AbortController().signal;
    const call = vi.fn(async () => ({
      revision: 3,
      checks: [{ id: 'memory_embed', configured: false, available: false, reason: 'no_resource' }],
    }));
    const api = createMemoryLlmApi({ services: { call } } as unknown as PluginSession, signal);

    await expect(api.inspect?.previewRoute({
      consumer: 'stx_memory', taskKey: 'memory_embed', taskKind: 'embedding', requiredCapabilities: ['embeddings'],
    })).resolves.toEqual({ available: false, blockedReason: 'LLM 中尚未配置匹配的资源' });
    expect(call).toHaveBeenCalledWith(LLM_CAPABILITY_STATUS_V0, {
      checks: [{ id: 'memory_embed', taskKey: 'memory_embed', taskKind: 'embedding', requiredCapabilities: ['embeddings'] }],
    }, { timeoutMs: 5_000, signal });
  });
});
