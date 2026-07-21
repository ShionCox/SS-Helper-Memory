import { describe, expect, it, vi } from 'vitest';
import type { ChatIndicatorRegistration, ChatIndicatorTarget, PluginSession } from '@ss-helper/sdk';
import { registerMemoryChatIndicator } from '../src/ss-helper/chat-indicator';

const target = (workspaceId: string, chatKey: string): ChatIndicatorTarget => ({
  key: JSON.stringify([workspaceId, chatKey]), workspaceId, chatKey,
});

describe('Memory chat indicator provider', () => {
  it('reports hidden, enabled and retained states and only activates LLM for enabled data chats', async () => {
    let registration: ChatIndicatorRegistration | undefined;
    let settingsListener: (() => void) | undefined;
    const memoryKeys = new Set(['character:a\u0000enabled', 'group:g\u0000retained']);
    const query = vi.fn(async ({ workspaceId, filter }: { workspaceId: string; filter?: Readonly<Record<string, unknown>> }) => ({
      records: memoryKeys.has(`${workspaceId}\u0000${String(filter?.chatKey ?? '')}`) ? [{ recordId: 'fact' }] : [], nextCursor: null,
    }));
    const unregister = vi.fn();
    const session = {
      workspace: { query },
      registerChatIndicator: (value: ChatIndicatorRegistration) => { registration = value; return unregister; },
    } as unknown as Pick<PluginSession, 'workspace' | 'registerChatIndicator'>;
    const controller = {
      isChatEnabled: (workspaceId: string, chatKey: string) => `${workspaceId}\u0000${chatKey}` === 'character:a\u0000enabled',
      onSettingsChanged: (listener: () => void) => { settingsListener = listener; return () => { settingsListener = undefined; }; },
    };
    expect(registerMemoryChatIndicator(session, controller)).toBe(unregister);
    expect(registration?.icon).toBe('brain');
    const invalidate = vi.fn();
    registration?.subscribe?.(invalidate);
    settingsListener?.();
    expect(invalidate).toHaveBeenCalledWith();

    const resolutions = await registration!.resolve([
      target('character:a', 'enabled'), target('group:g', 'retained'), target('character:a', 'empty'),
    ]);
    expect(resolutions).toEqual([
      { targetKey: JSON.stringify(['character:a', 'enabled']), state: 'enabled', activeDependencies: ['ss-helper.llm'] },
      { targetKey: JSON.stringify(['group:g', 'retained']), state: 'retained' },
      { targetKey: JSON.stringify(['character:a', 'empty']), state: 'hidden' },
    ]);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('bounds workspace lookups to four concurrent queries', async () => {
    let registration: ChatIndicatorRegistration | undefined;
    let active = 0; let peak = 0; const releases: Array<() => void> = [];
    const session = {
      workspace: { query: vi.fn(async () => {
        active += 1; peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return { records: [], nextCursor: null };
      }) },
      registerChatIndicator: (value: ChatIndicatorRegistration) => { registration = value; return () => undefined; },
    } as unknown as Pick<PluginSession, 'workspace' | 'registerChatIndicator'>;
    registerMemoryChatIndicator(session, { isChatEnabled: () => true, onSettingsChanged: () => () => undefined });
    const pending = registration!.resolve(Array.from({ length: 7 }, (_, index) => target('character:a', `chat-${index}`)));
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    releases.splice(0).forEach((release) => release());
    await pending;
    expect(peak).toBe(4);
  });

  it('gracefully skips registration against an older Core', () => {
    const session = { workspace: { query: vi.fn() } } as unknown as Pick<PluginSession, 'workspace' | 'registerChatIndicator'>;
    expect(() => registerMemoryChatIndicator(session, { isChatEnabled: () => true, onSettingsChanged: () => () => undefined })()).not.toThrow();
  });
});
