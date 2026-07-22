import { describe, expect, it, vi } from 'vitest';
import { MEMORY_GRAPH_V0, MEMORY_RECALL_V0, MEMORY_UPDATED_V0, type PluginSession } from '@ss-helper/sdk';
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
      getSummaryProgressInfo: () => ({ available: true, initialized: false }),
      onSettingsChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    }, liveStatusSource);
    expect(MEMORY_SETTINGS_SCHEMA.id).toBe('ss-helper.memory');
    expect(await adapter.load()).toMatchObject({
      enabled: true,
      maxRecallItems: 12,
      preExtractReferenceEnabled: true,
      preExtractReferenceItems: 8,
      preExtractReferenceMode: 'auto',
      preExtractReferenceMaxChars: 2_400,
      graphEnabled: true,
      graphLlmRelationEnabled: true,
      graphMaxHops: 1,
      graphMaxEdges: 12,
    });
    await adapter.save({ enabled: false, maxRecallItems: 6 });
    expect(settings).toMatchObject({ enabled: false, maxRecallItems: 6, promptMaxChars: 8_000 });
    await adapter.save({ ...settings, preExtractReferenceItems: 99, preExtractReferenceMode: 'vector', preExtractReferenceMaxChars: 4_099 });
    expect(settings).toMatchObject({ preExtractReferenceItems: 10, preExtractReferenceMode: 'vector', preExtractReferenceMaxChars: 4_000 });
    await adapter.save({ ...settings, graphMaxHops: 2, graphMaxEdges: 99 });
    expect(settings).toMatchObject({ graphEnabled: true, graphLlmRelationEnabled: true, graphMaxHops: 2, graphMaxEdges: 24 });
    await adapter.reset();
    expect(settings).toEqual(MEMORY_DEFAULT_SETTINGS);
  });

  it('exposes 基础、总结、召回、高级、当前聊天 tabs and graph controls without a chat', async () => {
    expect(MEMORY_SETTINGS_SCHEMA.fields.map((field) => field.id)).toEqual(['basic', 'summary', 'recall', 'advanced', 'currentChat']);
    const advanced = MEMORY_SETTINGS_SCHEMA.fields.find((field) => field.id === 'advanced');
    expect(advanced).toMatchObject({ label: '高级' });
    const groups = advanced?.kind === 'section' ? advanced.children : [];
    const oldMemory = groups.find((field) => field.id === 'preExtractReference');
    expect(oldMemory).toMatchObject({ id: 'preExtractReference', label: '提取前参考旧记忆' });
    expect(oldMemory?.kind === 'section' ? oldMemory.children.map((field) => field.id) : []).toEqual([
      'preExtractReferenceEnabled', 'preExtractReferenceItems', 'preExtractReferenceMode', 'preExtractReferenceMaxChars',
    ]);
    const graph = groups.find((field) => field.id === 'relationshipGraph');
    expect(graph).toMatchObject({ id: 'relationshipGraph', label: '关系图谱' });
    expect(graph?.kind === 'section' ? graph.children.map((field) => field.id) : []).toEqual([
      'graphEnabled', 'graphLlmRelationEnabled', 'graphMaxHops', 'graphMaxEdges', 'graphStatus', 'graphWorkbench',
    ]);
    const graphFields = graph?.kind === 'section' ? graph.children : [];
    expect(graphFields.find((field) => field.id === 'graphMaxHops')).toMatchObject({ min: 1, max: 2, defaultValue: 1 });
    expect(graphFields.find((field) => field.id === 'graphMaxEdges')).toMatchObject({ min: 4, max: 24, defaultValue: 12 });
    expect(graphFields.find((field) => field.id === 'graphWorkbench')).toMatchObject({ actionId: 'rebuild-relationship-graph', buttonLabel: '重建关系图谱' });
    let settings = { ...MEMORY_DEFAULT_SETTINGS };
    const listeners = new Set<(value: typeof settings) => void>();
    const adapter = createMemorySettingsAdapter({
      getSettings: () => ({ ...settings }),
      getEffectiveSettings: (value = settings) => { const { chatMode: _chatMode, ...effective } = value; return { ...effective, enabled: false }; },
      saveSettings: async (value) => { settings = value; listeners.forEach((listener) => listener(settings)); },
      resetSettings: async () => { settings = { ...MEMORY_DEFAULT_SETTINGS }; listeners.forEach((listener) => listener(settings)); },
      getCurrentChatInfo: () => ({ available: false, name: '', key: '', mode: 'inherit', effectiveEnabled: false }),
      getSummaryProgressInfo: () => ({ available: false, initialized: false }),
      onSettingsChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    }, liveStatusSource);
    expect(await adapter.loadFieldState?.()).toMatchObject({
      chatMode: { disabled: true, disabledReason: '请先进入角色或群组聊天，再修改当前聊天设置。' },
      summaryBatchFloors: { disabled: false },
      summaryBatchChars: { disabled: true },
      graphWorkbench: { disabled: true, disabledReason: '请先进入角色或群组聊天，再重建关系图谱。' },
    });
    await expect(adapter.loadStatus?.()).resolves.toMatchObject({
      workspaceStatus: { value: '已就绪', tone: 'success' },
      currentChatIdentity: { value: '不可用', tone: 'warning' },
      currentChatEffective: { value: '未生效', tone: 'warning' },
      summaryProgress: { value: '未选择聊天', tone: 'warning' },
      graphStatus: { value: '未选择聊天', tone: 'warning' },
    });
  });

  it('uses global summary defaults and switches the active batch control with the batch mode', async () => {
    let settings = { ...MEMORY_DEFAULT_SETTINGS };
    const controller = {
      getSettings: () => ({ ...settings }),
      getEffectiveSettings: (value = settings) => { const { chatMode: _chatMode, ...effective } = value; return effective; },
      saveSettings: async (value: typeof settings) => { settings = value; },
      resetSettings: async () => {},
      getCurrentChatInfo: () => ({ available: true, name: 'Chat A', key: 'chat-a', mode: settings.chatMode, effectiveEnabled: true }),
      getSummaryProgressInfo: () => ({ available: true, initialized: true, completedFloor: 60, nextWindow: '下一窗口：第 61–65 层', waitingFloors: 1 }),
      onSettingsChanged: () => () => {},
    };
    const adapter = createMemorySettingsAdapter(controller, liveStatusSource);
    await adapter.save({ ...settings, summaryBatchMode: 'chars', summaryBatchChars: 12_000, summaryIntervalFloors: 5 });
    expect(settings).toMatchObject({ summaryBatchMode: 'chars', summaryBatchChars: 12_000, summaryIntervalFloors: 5, summaryOverlapFloors: 2 });
    expect(await adapter.loadFieldState?.()).toMatchObject({
      summaryBatchFloors: { disabled: true },
      summaryBatchChars: { disabled: false },
    });
    await expect(adapter.loadStatus?.()).resolves.toMatchObject({
      summaryProgress: { value: '已总结至第 60 层', description: expect.stringContaining('下一窗口：第 61–65 层') },
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
      getSummaryProgressInfo: () => ({ available: chat.available, initialized: false }),
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
      getSummaryProgressInfo: () => ({ available: true, initialized: false }),
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

  it('validates globally enabled resource modes even when no chat is selected', async () => {
    let settings = { ...MEMORY_DEFAULT_SETTINGS, autoOrganize: false, recallMode: 'auto' as const };
    const saveSettings = vi.fn(async (value: typeof settings) => { settings = value; });
    const assess = vi.fn(async (next: { enabled: boolean; recallMode: string }) => next.recallMode === 'vector' && next.enabled
      ? { blocked: { title: '无法启用向量召回', message: '请先在 LLM 中配置向量资源。', code: 'MEMORY_EMBEDDING_UNAVAILABLE' }, warnings: [] }
      : { warnings: [] });
    const adapter = createMemorySettingsAdapter({
      getSettings: () => ({ ...settings }),
      getEffectiveSettings: (value = settings) => { const { chatMode: _chatMode, ...effective } = value; return { ...effective, enabled: false }; },
      saveSettings,
      resetSettings: async () => undefined,
      getCurrentChatInfo: () => ({ available: false, name: '', key: '', mode: 'inherit', effectiveEnabled: false }),
      getSummaryProgressInfo: () => ({ available: false, initialized: false }),
      onSettingsChanged: () => () => undefined,
    }, { loadStatus: () => ({}), subscribeStatus: () => () => undefined, assess });

    await expect(adapter.save({ ...settings, recallMode: 'vector' })).rejects.toThrow('请先在 LLM 中配置向量资源');
    expect(assess).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, recallMode: 'vector' }),
      expect.objectContaining({ enabled: true, recallMode: 'auto' }),
    );
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it('exposes MEMORY_RECALL_V0 and MEMORY_GRAPH_V0 without leaking graph evidence', async () => {
    const handlers = new Map<object, (request: any, context: { signal: AbortSignal }) => Promise<any>>();
    const publish = vi.fn();
    const dispose = vi.fn();
    const session = {
      services: { expose: vi.fn((token, next) => { handlers.set(token, next); return dispose; }) },
      events: { publish },
    } as unknown as PluginSession;
    const registration = registerMemoryServices(session, {
      getChatKey: () => 'chat-a',
      recallActors: async (input) => ({
        request: input,
        world: { ownerId: 'owner:world', ownerName: '世界', packets: [] },
        narrator: { ownerId: 'owner:narrator', ownerName: '旁白', packets: [] },
        actors: [{ ownerId: 'owner:actor:a', ownerName: '艾琳', packets: [{ text: 'plain memory', effectiveStrength: 90 }] }],
      }),
      graph: { preview: async () => ({
        nodes: [{ id: 'node-a', label: '艾琳' }, { id: 'node-b', label: '雷暴' }],
        edges: [{ id: 'edge-fact-a', from: 'node-a', to: 'node-b', predicate: '害怕', kind: 'relationship', confidence: 0.9, backingFactId: 'fact-a' }],
      }) },
    });
    const context = { signal: new AbortController().signal };
    const handler = handlers.get(MEMORY_RECALL_V0);
    const request = { query: 'q', chatKey: 'chat-a', sceneOwnerIds: ['owner:actor:a'], presentOwnerIds: ['owner:actor:a'], viewpointOwnerId: 'owner:actor:a', mode: 'multi_actor' as const, maxItems: 4 };
    await expect(handler?.({ ...request, chatKey: 'chat-b' }, context)).resolves.toEqual({
      mode: 'multi_actor',
      world: { ownerId: 'owner:world', owner: '世界', memories: [] },
      narrator: { ownerId: 'owner:narrator', owner: '旁白', memories: [] },
      actors: [],
    });
    await expect(handler?.(request, context)).resolves.toEqual({
      mode: 'multi_actor',
      world: { ownerId: 'owner:world', owner: '世界', memories: [] },
      narrator: { ownerId: 'owner:narrator', owner: '旁白', memories: [] },
      actors: [{ ownerId: 'owner:actor:a', owner: '艾琳', memories: [{ text: 'plain memory', confidence: 0.9, strength: 90 }] }],
    });
    const aborted = new AbortController();
    aborted.abort();
    await expect(handler?.({ ...request, query: 'abort' }, { signal: aborted.signal })).rejects.toMatchObject({ name: 'AbortError' });
    const graphHandler = handlers.get(MEMORY_GRAPH_V0);
    await expect(graphHandler?.({ query: 'q', chatKey: 'chat-b' }, context)).resolves.toEqual({ nodes: [], edges: [] });
    await expect(graphHandler?.({ query: '雷暴', chatKey: 'chat-a', limit: 4 }, context)).resolves.toEqual({
      nodes: [{ id: 'node-a', label: '艾琳' }, { id: 'node-b', label: '雷暴' }],
      edges: [{ id: 'edge-fact-a', from: 'node-a', to: 'node-b', predicate: '害怕', kind: 'relationship', confidence: 0.9, backingFactId: 'fact-a' }],
    });
    registration.publishUpdated({ chatKey: 'chat-a', operation: 'created', recordIds: ['fact-a'] });
    expect(publish).toHaveBeenCalledWith(MEMORY_UPDATED_V0, { chatKey: 'chat-a', operation: 'created', recordIds: ['fact-a'] });
    registration.dispose();
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});
