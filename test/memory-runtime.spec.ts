import { describe, expect, it, vi } from 'vitest';
import { memoryWorkspaceStatus, retrySqliteAvailability } from '../src/host/memory-runtime';

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

  it('retries a transient SQLite outage before reporting degraded storage', async () => {
    let refreshes = 0;
    let available = false;
    await expect(retrySqliteAvailability(
      () => available,
      async () => {
        refreshes += 1;
        available = refreshes >= 2;
        return available;
      },
      { delaysMs: [0, 0] },
    )).resolves.toBe(true);
    expect(refreshes).toBe(2);
  });

  it('stops bounded SQLite retries when the runtime is cancelled', async () => {
    const refresh = vi.fn(async () => true);
    await expect(retrySqliteAvailability(() => false, refresh, { delaysMs: [0], shouldContinue: () => false })).resolves.toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });
});
