import { describe, expect, it, vi } from 'vitest';
import { LLM_EMBEDDING_V1, LLM_RERANK_V1, LLM_STRUCTURED_TASK_V1, type PluginSession } from '@ss-helper/sdk';
import { createMemoryLlmApi } from '../src/ss-helper/llm-adapter';

describe('SDK LLM typed adapter', () => {
  it('maps structured/embed/rerank calls through public contracts with timeout and abort options', async () => {
    const signal = new AbortController().signal;
    const call = vi.fn(async (contract: { name: string }) => {
      if (contract === LLM_STRUCTURED_TASK_V1) return { output: { facts: [] }, route: { route: 'memory', model: 'm1' } };
      if (contract === LLM_EMBEDDING_V1) return { embeddings: [[1, 2]], route: { route: 'embed', model: 'e1' } };
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

    expect(call).toHaveBeenNthCalledWith(1, LLM_STRUCTURED_TASK_V1, expect.objectContaining({ timeoutMs: 60_000 }), { timeoutMs: 60_000, signal });
    expect(call).toHaveBeenNthCalledWith(2, LLM_EMBEDDING_V1, expect.objectContaining({ timeoutMs: 1234 }), { timeoutMs: 1234, signal });
    expect(call).toHaveBeenNthCalledWith(3, LLM_RERANK_V1, expect.objectContaining({ timeoutMs: 30_000 }), { timeoutMs: 30_000, signal });
  });

  it('keeps typed service failures inside the retained Memory result boundary', async () => {
    const api = createMemoryLlmApi({ services: { call: async () => { throw new Error('Core unavailable'); } } } as unknown as PluginSession);
    await expect(api.embed?.({ consumer: 'stx_memory', taskKey: 'memory_embed', texts: ['x'] }))
      .resolves.toEqual({ ok: false, error: 'Core unavailable' });
  });
});
