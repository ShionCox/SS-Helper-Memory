import { describe, expect, it, vi } from 'vitest';
import type { PluginSession } from '@ss-helper/sdk';
import type { MemoryHostCapability } from '../src/ss-helper/plugin';
import { SdkMemoryHostContext } from '../src/host/sdk-host-context';

describe('SDK Memory HostPort context', () => {
  it('forwards public host snapshots and preserves typed variables/stat_data', async () => {
    const host = {
      context: { read: vi.fn(async () => ({ chatKey: ' chat-a ' })) },
      chat: { readMessages: vi.fn(async () => [{
        id: 'm1', index: 0, role: 'assistant', text: 'visible', createdAt: '2026-07-14T00:00:00Z',
        variables: [{ stat_data: { 核心储备: 4 } }],
      }]) },
      character: { read: vi.fn(async () => ({ id: 'c1', name: '角色' })) },
      persona: { read: vi.fn(async () => ({ name: '用户', description: '当前 Persona 描述' })) },
      worldbooks: { active: vi.fn(async () => [{ id: 'w1', name: '世界', active: true, entries: [] }]) },
    };
    const context = new SdkMemoryHostContext({ host } as unknown as PluginSession<MemoryHostCapability>);
    await expect(context.refresh()).resolves.toBe('character:c1');
    expect(context.getWorkspaceId()).toBe('character:c1');
    expect(context.getChatKey()).toBe('chat-a');
    await expect(context.getRecallContext()).resolves.toEqual({ characterKeys: ['c1', '角色'], worldKeys: ['w1', '世界'] });
    const sources = await context.collectSources('chat-a');
    expect(sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'message:m1', content: 'visible' }),
      expect.objectContaining({ kind: 'state', content: expect.stringContaining('核心储备') }),
      expect.objectContaining({ kind: 'character' }),
      expect.objectContaining({ kind: 'persona', content: '用户名：用户\nPersona：当前 Persona 描述' }),
    ]));
  });

  it('stops without a stable character or group workspace id', async () => {
    const host = {
      context: { read: async () => ({ chatId: ' legacy-id ', groupId: 'null' }) },
      character: { read: async () => ({ id: 'undefined', name: '未选择角色' }) },
    };
    const context = new SdkMemoryHostContext({ host } as unknown as PluginSession<MemoryHostCapability>);
    await expect(context.refresh()).resolves.toBe('');
  });

  it('uses a stable group id without reading the character', async () => {
    const readCharacter = vi.fn();
    const host = {
      context: { read: async () => ({ chatKey: 'group-chat', groupId: ' group-7 ' }) },
      character: { read: readCharacter },
    };
    const context = new SdkMemoryHostContext({ host } as unknown as PluginSession<MemoryHostCapability>);
    await expect(context.refresh()).resolves.toBe('group:group-7');
    expect(readCharacter).not.toHaveBeenCalled();
  });

  it('uses the current chat snapshot when context.chatKey is temporarily absent', async () => {
    const host = {
      context: { read: async () => ({ characterId: '2' }) },
      chat: { readCurrent: async () => ({ key: 'Assistant - imported-chat', name: 'Assistant' }) },
      character: { read: async () => ({ id: 'assistant-avatar', name: 'Assistant' }) },
    };
    const context = new SdkMemoryHostContext({ host } as unknown as PluginSession<MemoryHostCapability>);
    await expect(context.refresh()).resolves.toBe('character:assistant-avatar');
    expect(context.getChatKey()).toBe('Assistant - imported-chat');
    expect(context.getChatName()).toBe('Assistant');
  });

  it('keeps a character-index workspace while the character snapshot is loading', async () => {
    const host = {
      context: { read: async () => ({ chatKey: 'chat-loading', characterId: '4' }) },
      chat: { readCurrent: async () => ({ key: 'chat-loading', name: '角色' }) },
      character: { read: async () => null },
    };
    const context = new SdkMemoryHostContext({ host } as unknown as PluginSession<MemoryHostCapability>);
    await expect(context.refresh()).resolves.toBe('character:4');
    expect(context.getChatKey()).toBe('chat-loading');
  });
});
