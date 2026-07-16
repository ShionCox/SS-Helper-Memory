import { describe, expect, it, vi } from 'vitest';
import { MEMORY_RECALL_V1, MEMORY_UPDATED_V1, type PluginSession } from '@ss-helper/sdk';
import { createMemorySettingsAdapter, MEMORY_DEFAULT_SETTINGS, MEMORY_SETTINGS_SCHEMA } from '../src/ss-helper/settings';
import { registerMemoryServices } from '../src/ss-helper/services';

const liveStatusSource = {
  loadStatus: () => ({ workspaceStatus: { value: '已就绪', tone: 'success' as const } }),
  subscribeStatus: (listener: (status: Record<string, { value: string; tone: 'success' }>) => void) => {
    listener({ workspaceStatus: { value: '已就绪', tone: 'success' } });
    return () => {};
  },
  assess: async () => ({ warnings: [] }),
};

describe('SS-Helper Memory typed adapters', () => {
  it('uses the Core settings schema/adapter without a second settings root', async () => {
    let settings = { ...MEMORY_DEFAULT_SETTINGS };
    const listeners = new Set<(value: typeof settings) => void>();
    const adapter = createMemorySettingsAdapter({
      getSettings: () => ({ ...settings }),
      getEffectiveSettings: (value = settings) => { const { chatMode: _chatMode, ...effective } = value; return effective; },
      saveSettings: async (value) => { settings = value; listeners.forEach((listener) => listener(settings)); },
      resetSettings: async () => { settings = { ...MEMORY_DEFAULT_SETTINGS }; listeners.forEach((listener) => listener(settings)); },
      getCurrentChatInfo: () => ({ available: true, name: 'Chat A', key: 'chat-a', mode: settings.chatMode, effectiveEnabled: settings.enabled }),
      onSettingsChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    }, liveStatusSource);
    expect(MEMORY_SETTINGS_SCHEMA.id).toBe('ss-helper.memory');
    expect(await adapter.load()).toMatchObject({ enabled: true, maxRecallItems: 12 });
    await adapter.save({ enabled: false, maxRecallItems: 6 });
    expect(settings).toMatchObject({ enabled: false, maxRecallItems: 6, promptMaxChars: 8_000 });
    await adapter.reset();
    expect(settings).toEqual(MEMORY_DEFAULT_SETTINGS);
  });

  it('exposes exactly the global and current-chat tabs and disables overrides without a chat', async () => {
    expect(MEMORY_SETTINGS_SCHEMA.fields.map((field) => field.id)).toEqual(['global', 'currentChat']);
    let settings = { ...MEMORY_DEFAULT_SETTINGS };
    const listeners = new Set<(value: typeof settings) => void>();
    const adapter = createMemorySettingsAdapter({
      getSettings: () => ({ ...settings }),
      getEffectiveSettings: (value = settings) => { const { chatMode: _chatMode, ...effective } = value; return { ...effective, enabled: false }; },
      saveSettings: async (value) => { settings = value; listeners.forEach((listener) => listener(settings)); },
      resetSettings: async () => { settings = { ...MEMORY_DEFAULT_SETTINGS }; listeners.forEach((listener) => listener(settings)); },
      getCurrentChatInfo: () => ({ available: false, name: '', key: '', mode: 'inherit', effectiveEnabled: false }),
      onSettingsChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    }, liveStatusSource);
    expect(await adapter.loadFieldState?.()).toEqual({ chatMode: { disabled: true, disabledReason: '请先进入角色或群组聊天，再修改当前聊天设置。' } });
    await expect(adapter.loadStatus?.()).resolves.toMatchObject({
      workspaceStatus: { value: '已就绪', tone: 'success' },
      currentChatIdentity: { value: '不可用', tone: 'warning' },
      currentChatEffective: { value: '未生效', tone: 'warning' },
    });
  });

  it('updates current-chat status live without exposing the internal chat key', async () => {
    let chat = { available: true, name: 'Alice', key: 'private/chat/key', mode: 'inherit' as const, effectiveEnabled: true };
    const listeners = new Set<() => void>();
    const adapter = createMemorySettingsAdapter({
      getSettings: () => ({ ...MEMORY_DEFAULT_SETTINGS }),
      getEffectiveSettings: (value = MEMORY_DEFAULT_SETTINGS) => { const { chatMode: _chatMode, ...effective } = value; return effective; },
      saveSettings: async () => {},
      resetSettings: async () => {},
      getCurrentChatInfo: () => chat,
      onSettingsChanged: (listener) => { const callback = () => listener({ ...MEMORY_DEFAULT_SETTINGS }); listeners.add(callback); return () => listeners.delete(callback); },
    }, liveStatusSource);
    const snapshots: Array<Record<string, { value: string; description?: string }>> = [];
    const dispose = adapter.subscribeStatus?.((status) => snapshots.push(status as typeof snapshots[number]));
    chat = { ...chat, name: 'Group B', key: 'private/group/key' };
    listeners.forEach((listener) => listener());
    const latest = snapshots.at(-1)?.currentChatIdentity;
    expect(latest?.value).toBe('Group B');
    expect(JSON.stringify(latest)).not.toContain('private/group/key');
    dispose?.();
  });

  it('blocks strict capability changes, warns on graceful degradation, and reports persistence failures once', async () => {
    let settings = { ...MEMORY_DEFAULT_SETTINGS, enabled: false, autoOrganize: false };
    const saveSettings = vi.fn(async (value: typeof settings) => { settings = value; });
    const toast = vi.fn();
    const assess = vi.fn(async (next: { recallMode: string }) => next.recallMode === 'vector'
      ? { blocked: { title: '无法启用所选召回模式', message: 'Embedding API 不可用。', code: 'MEMORY_EMBEDDING_UNAVAILABLE' }, warnings: [] }
      : { warnings: [{ title: '召回已自动降级', message: '将使用关键词召回。', code: 'MEMORY_EMBEDDING_DEGRADED' }] });
    const controller = {
      getSettings: () => ({ ...settings }),
      getEffectiveSettings: (value = settings) => { const { chatMode: _chatMode, ...effective } = value; return effective; },
      saveSettings,
      resetSettings: async () => {},
      getCurrentChatInfo: () => ({ available: true, name: 'Alice', key: 'chat-a', mode: settings.chatMode, effectiveEnabled: settings.enabled }),
      onSettingsChanged: () => () => {},
    };
    const adapter = createMemorySettingsAdapter(controller, { loadStatus: () => ({}), subscribeStatus: () => () => {}, assess }, toast);

    await expect(adapter.save({ ...settings, enabled: true, recallMode: 'vector' })).rejects.toThrow('Embedding API 不可用。');
    expect(saveSettings).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ level: 'error', code: 'MEMORY_EMBEDDING_UNAVAILABLE', durationMs: 0 }));

    toast.mockClear();
    await adapter.save({ ...settings, enabled: true, recallMode: 'auto' });
    expect(saveSettings).toHaveBeenCalledOnce();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning', code: 'MEMORY_EMBEDDING_DEGRADED' }));

    saveSettings.mockRejectedValueOnce(new Error('workspace transaction failed'));
    toast.mockClear();
    await expect(adapter.save({ ...settings, maxRecallItems: 14 })).rejects.toThrow('workspace transaction failed');
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ level: 'error', code: 'MEMORY_SETTINGS_SAVE_FAILED', durationMs: 0 }));
  });

  it('exposes MEMORY_RECALL_V1 and publishes MEMORY_UPDATED_V1 as plain DTOs', async () => {
    let handler: ((request: any, context: { signal: AbortSignal }) => Promise<any>) | undefined;
    const publish = vi.fn();
    const dispose = vi.fn();
    const session = {
      services: { expose: vi.fn((token, next) => { expect(token).toBe(MEMORY_RECALL_V1); handler = next; return dispose; }) },
      events: { publish },
    } as unknown as PluginSession;
    const registration = registerMemoryServices(session, {
      getChatKey: () => 'chat-a',
      recall: { preview: async () => ({
        chatKey: 'chat-a', query: 'q', maxItems: 4, createdAt: 1, candidates: [], diagnostics: { candidateCount: 1, eligibleCount: 1, selectedCount: 1, llmCalls: 0 },
        items: [{ fact: { id: 'fact-a', chatKey: 'chat-a', kind: 'identity', subjectKey: 'a', predicateKey: 'is', content: 'plain memory', entityKeys: [], confidence: 1, status: 'active', sourceRefs: ['source-a'], updatedAt: 1 }, score: 0.9, reason: { lexical: true, entity: false, context: false, stableAnchor: false } }],
      }) },
    });
    const context = { signal: new AbortController().signal };
    await expect(handler?.({ query: 'q', chatKey: 'chat-b' }, context)).resolves.toEqual({ items: [] });
    await expect(handler?.({ query: 'q', chatKey: 'chat-a', limit: 4 }, context)).resolves.toEqual({ items: [{ id: 'fact-a', text: 'plain memory', score: 0.9, source: 'source-a' }] });
    const aborted = new AbortController();
    aborted.abort();
    await expect(handler?.({ query: 'q', chatKey: 'chat-a' }, { signal: aborted.signal })).rejects.toMatchObject({ name: 'AbortError' });
    registration.publishUpdated({ chatKey: 'chat-a', operation: 'created', recordIds: ['fact-a'] });
    expect(publish).toHaveBeenCalledWith(MEMORY_UPDATED_V1, { chatKey: 'chat-a', operation: 'created', recordIds: ['fact-a'] });
    registration.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
