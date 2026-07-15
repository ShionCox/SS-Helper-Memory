import { describe, expect, it } from 'vitest';
import { captureMainChatUsage } from '../src/host/main-chat-usage';

describe('主聊天 usage 采集', () => {
  it('记录供应商返回的 prompt/completion/cache/total 字段', () => {
    const usage = captureMainChatUsage('chat-a', {
      messageId: 'assistant-7',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      usage: {
        prompt_tokens: 120,
        completion_tokens: 30,
        prompt_cache_hit_tokens: 80,
        prompt_cache_miss_tokens: 40,
        total_tokens: 150,
      },
    }, [{ mesid: 'assistant-7', extra: {} }], 1000);

    expect(usage).toMatchObject({
      messageId: 'assistant-7', promptTokens: 120, completionTokens: 30,
      cacheReadTokens: 80, cacheWriteTokens: 40, totalTokens: 150,
      provider: 'deepseek', model: 'deepseek-v4-flash', capturedAt: 1000,
    });
  });

  it('宿主只给回复 token_count 时其余字段明确为 null', () => {
    const usage = captureMainChatUsage('chat-a', 0, [{ mesid: 'assistant-1', extra: { token_count: 27 } }], 2000);
    expect(usage).toMatchObject({
      messageId: 'assistant-1', promptTokens: null, completionTokens: 27,
      cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null,
    });
  });
});
