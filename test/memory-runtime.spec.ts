import { describe, expect, it } from 'vitest';
import { memoryWorkspaceStatus } from '../src/host/memory-runtime';

describe('Memory runtime status boundaries', () => {
  it('does not report the global LLM or memory setting as disabled when no chat is selected', () => {
    expect(memoryWorkspaceStatus({ getCurrentChatInfo: () => ({ available: false, name: '', key: '', mode: 'inherit', effectiveEnabled: false }) })).toMatchObject({
      value: '未选择', tone: 'warning',
    });
  });

  it('distinguishes a chat-level override from a ready workspace', () => {
    expect(memoryWorkspaceStatus({ getCurrentChatInfo: () => ({ available: true, name: 'Chat', key: 'chat-a', mode: 'disabled', effectiveEnabled: false }) })).toMatchObject({
      value: '已关闭', tone: 'neutral',
    });
    expect(memoryWorkspaceStatus({ getCurrentChatInfo: () => ({ available: true, name: 'Chat', key: 'chat-a', mode: 'inherit', effectiveEnabled: true }) })).toMatchObject({
      value: '已就绪', tone: 'success',
    });
  });
});
