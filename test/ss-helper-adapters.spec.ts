import { describe, expect, it, vi } from 'vitest';
import { MEMORY_RECALL_V1, MEMORY_UPDATED_V1, type PluginSession } from '@ss-helper/sdk';
import { createMemorySettingsAdapter, MEMORY_DEFAULT_SETTINGS, MEMORY_SETTINGS_SCHEMA } from '../src/ss-helper/settings';
import { registerMemoryServices } from '../src/ss-helper/services';

describe('SS-Helper Memory typed adapters', () => {
  it('uses the Core settings schema/adapter without a second settings root', async () => {
    let settings = { ...MEMORY_DEFAULT_SETTINGS };
    const listeners = new Set<(value: typeof settings) => void>();
    const adapter = createMemorySettingsAdapter({
      getSettings: () => ({ ...settings }),
      saveSettings: async (value) => { settings = value; listeners.forEach((listener) => listener(settings)); },
      onSettingsChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    });
    expect(MEMORY_SETTINGS_SCHEMA.id).toBe('ss-helper.memory');
    expect(await adapter.load()).toMatchObject({ enabled: true, maxRecallItems: 12 });
    await adapter.save({ enabled: false, maxRecallItems: 6 });
    expect(settings).toMatchObject({ enabled: false, maxRecallItems: 6, promptMaxChars: 8_000 });
    await adapter.reset();
    expect(settings).toEqual(MEMORY_DEFAULT_SETTINGS);
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
