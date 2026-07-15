import { describe, expect, it, vi } from 'vitest';
import type { PluginSession } from '@ss-helper/sdk';
import type { MemoryHostCapability } from '../src/ss-helper/plugin';
import { SdkMemoryHostContext } from '../src/host/sdk-host-context';

describe('SDK Memory HostPort context', () => {
  it('forwards public host snapshots and preserves typed variables/stat_data', async () => {
    const request = { send: vi.fn() };
    const binaryRequest = { send: vi.fn() };
    const host = {
      context: { read: vi.fn(async () => ({ chatKey: ' chat-a ' })) },
      chat: { readMessages: vi.fn(async () => [{
        id: 'm1', index: 0, role: 'assistant', text: 'visible', createdAt: '2026-07-14T00:00:00Z',
        variables: [{ stat_data: { 核心储备: 4 } }],
      }]) },
      character: { read: vi.fn(async () => ({ id: 'c1', name: '角色' })) },
      persona: { read: vi.fn(async () => ({ id: 'p1', name: '用户', description: 'Persona' })) },
      worldbooks: { active: vi.fn(async () => [{ id: 'w1', name: '世界', active: true, entries: [] }]) },
      request,
      binaryRequest,
    };
    const context = new SdkMemoryHostContext({ host } as unknown as PluginSession<MemoryHostCapability>);
    await expect(context.refresh()).resolves.toBe('chat-a');
    expect(context.getRequestPort()).toBe(request);
    expect(context.getBinaryRequestPort()).toBe(binaryRequest);
    await expect(context.getRecallContext()).resolves.toEqual({ characterKeys: ['c1', '角色'], worldKeys: ['w1', '世界'] });
    const sources = await context.collectSources('chat-a');
    expect(sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'message:m1', content: 'visible' }),
      expect.objectContaining({ kind: 'state', content: expect.stringContaining('核心储备') }),
      expect.objectContaining({ kind: 'character' }),
      expect.objectContaining({ kind: 'persona' }),
    ]));
  });

  it('falls back to chatId when chatKey is absent', async () => {
    const host = { context: { read: async () => ({ chatId: ' legacy-id ' }) } };
    const context = new SdkMemoryHostContext({ host } as unknown as PluginSession<MemoryHostCapability>);
    await expect(context.refresh()).resolves.toBe('legacy-id');
  });
});
