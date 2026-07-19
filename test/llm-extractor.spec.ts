import { describe, expect, it, vi } from 'vitest';
import { LlmMemoryExtractor, MEMORY_EXTRACT_MAX_TOKENS, MemoryLlmTaskError, type MemoryLlmApi } from '../src/application/ingest/llm-extractor';

describe('Memory LLMHub 三任务契约', () => {
  it('每次 extract 只调用一次 LLM 并限制 3072 tokens', async () => {
    const runTask = vi.fn(async () => ({
      ok: true as const,
      data: { facts: [] },
      meta: { requestId: 'req-1', resourceId: 'deepseek-main', model: 'deepseek-chat', latencyMs: 1234 },
      usage: { promptTokens: 321, completionTokens: 45, totalTokens: 366 },
    }));
    const extractor = new LlmMemoryExtractor(() => ({ runTask } as unknown as MemoryLlmApi));
    const result = await extractor.extract({ chatKey: 'c', sources: [{ id: 'm1', chatKey: 'c', kind: 'message', role: 'user', content: '足够明确的来源正文', createdAt: 1 }] });
    expect(runTask).toHaveBeenCalledTimes(1);
    const request = (runTask.mock.calls[0] as unknown[])[0] as { budget: unknown; input: { messages: Array<{ content: string }> } };
    expect(request).toMatchObject({ budget: { maxTokens: MEMORY_EXTRACT_MAX_TOKENS } });
    expect(request.input.messages[0]?.content).toContain('不得添加聊天名');
    expect(request.input.messages[1]?.content).toContain('允许的 sourceRef（必须逐字复制其中一个值）：["m1"]');
    expect(request.input.messages[1]?.content).not.toContain('chatKey=');
    expect(result.audit).toEqual({
      requestId: 'req-1',
      resourceId: 'deepseek-main',
      model: 'deepseek-chat',
      latencyMs: 1234,
      usage: { promptTokens: 321, completionTokens: 45, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: 366 },
    });
  });

  it('鉴权失败时保留安全的错误码、资源和模型定位信息', async () => {
    const extractor = new LlmMemoryExtractor(() => ({
      runTask: vi.fn(async () => ({
        ok: false as const,
        error: 'HTTP 401 Unauthorized',
        reasonCode: 'auth_failed',
        meta: { resourceId: 'deepseek-main', model: 'deepseek-v4-flash' },
      })),
    }));
    const error = await extractor.extract({
      chatKey: 'c',
      sources: [{ id: 'm1', chatKey: 'c', kind: 'message', role: 'user', content: '足够明确的来源正文', createdAt: 1 }],
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(MemoryLlmTaskError);
    expect((error as Error).message).toContain('错误码=auth_failed');
    expect((error as Error).message).toContain('资源=deepseek-main');
    expect((error as Error).message).not.toMatch(/api[_ -]?key|bearer/i);
  });
});
