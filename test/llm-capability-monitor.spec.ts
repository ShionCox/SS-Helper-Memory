import { describe, expect, it, vi } from 'vitest';
import type { PluginSession } from '@ss-helper/sdk';
import { MemoryLlmCapabilityMonitor, type MemoryCapabilitySettings } from '../src/ss-helper/llm-capability-monitor';

const disabled: MemoryCapabilitySettings = { enabled: false, autoOrganize: false, recallMode: 'lexical', rerankMode: 'off' };

function unavailableMonitor(): MemoryLlmCapabilityMonitor {
  const response = {
    revision: 1,
    checks: [
      { id: 'generation', available: false, reason: 'no_resource' },
      { id: 'embedding', available: false, reason: 'no_resource' },
      { id: 'rerank', available: false, reason: 'no_resource' },
    ],
  };
  return new MemoryLlmCapabilityMonitor({
    services: { call: vi.fn(async () => response) },
    events: { subscribe: vi.fn(() => () => {}) },
    host: { events: { subscribe: vi.fn(() => () => {}) } },
  } as unknown as PluginSession, () => disabled);
}

describe('Memory settings capability policy', () => {
  it.each([
    [{ enabled: true, autoOrganize: true, recallMode: 'lexical', rerankMode: 'off' }, 'MEMORY_GENERATION_UNAVAILABLE'],
    [{ enabled: true, autoOrganize: false, recallMode: 'vector', rerankMode: 'off' }, 'MEMORY_EMBEDDING_UNAVAILABLE'],
    [{ enabled: true, autoOrganize: false, recallMode: 'lexical', rerankMode: 'always' }, 'MEMORY_RERANK_UNAVAILABLE'],
  ] as const)('blocks an unavailable strict setting without persisting it', async (next, code) => {
    const monitor = unavailableMonitor();
    const assessment = await monitor.assess(next, disabled);
    expect(assessment).toMatchObject({ blocked: { code }, warnings: [] });
    expect(assessment.blocked?.message).toContain('LLM');
    monitor.dispose();
  });

  it('allows automatic modes and reports both non-obvious degradations', async () => {
    const monitor = unavailableMonitor();
    await expect(monitor.assess({ enabled: true, autoOrganize: false, recallMode: 'auto', rerankMode: 'adaptive' }, disabled)).resolves.toMatchObject({
      warnings: [
        { code: 'MEMORY_EMBEDDING_DEGRADED', message: expect.stringContaining('LLM') },
        { code: 'MEMORY_RERANK_DEGRADED', message: expect.stringContaining('LLM') },
      ],
    });
    monitor.dispose();
  });

  it('warns when only extraction-time old-memory reference must fall back to keywords', async () => {
    const monitor = unavailableMonitor();
    await expect(monitor.assess({
      enabled: true,
      autoOrganize: false,
      recallMode: 'lexical',
      rerankMode: 'off',
      preExtractReferenceEnabled: true,
      preExtractReferenceMode: 'auto',
    }, disabled)).resolves.toMatchObject({
      warnings: [{ code: 'MEMORY_PRE_EXTRACT_REFERENCE_DEGRADED', message: expect.stringContaining('关键词') }],
    });
    monitor.dispose();
  });

  it('publishes live capability changes, hides internal resource IDs, and stops after disposal', async () => {
    let revision = 1;
    let model = 'embed-a';
    let eventListener: ((payload: { revision: number }) => void) | undefined;
    const call = vi.fn(async () => ({
      revision,
      checks: [
        { id: 'generation', configured: true, available: true, source: 'tavern', model: 'chat-a' },
        { id: 'embedding', configured: true, available: true, source: 'custom', resourceId: 'private-resource-id', model },
        { id: 'rerank', configured: false, available: false, reason: 'no_resource' },
      ],
    }));
    const monitor = new MemoryLlmCapabilityMonitor({
      services: { call },
      events: { subscribe: vi.fn((_token, listener) => { eventListener = listener; return () => { eventListener = undefined; }; }) },
      host: { events: { subscribe: vi.fn(() => () => {}) } },
    } as unknown as PluginSession, () => ({ enabled: true, autoOrganize: true, recallMode: 'vector', rerankMode: 'off' }));
    const snapshots: Array<Record<string, { value: string; description?: string }>> = [];
    monitor.subscribeStatus((status) => snapshots.push(status as typeof snapshots[number]));
    await monitor.start();
    expect(snapshots.at(-1)?.embeddingStatus.description).toContain('embed-a');
    expect(JSON.stringify(snapshots.at(-1))).not.toContain('private-resource-id');

    revision = 2;
    model = 'embed-b';
    eventListener?.({ revision });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(snapshots.at(-1)?.embeddingStatus.description).toContain('embed-b');
    const count = snapshots.length;
    monitor.dispose();
    eventListener?.({ revision: 3 });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(snapshots).toHaveLength(count);
  });

  it('reports real resource availability even when Memory is globally disabled', async () => {
    const response = {
      revision: 1,
      checks: [
        { id: 'generation', available: true, source: 'tavern', model: 'chat-a' },
        { id: 'embedding', available: true, source: 'custom', model: 'embed-a' },
        { id: 'rerank', available: true, source: 'custom', model: 'rerank-a' },
      ],
    };
    const monitor = new MemoryLlmCapabilityMonitor({
      services: { call: vi.fn(async () => response) },
      events: { subscribe: vi.fn(() => () => {}) },
      host: { events: { subscribe: vi.fn(() => () => {}) } },
    } as unknown as PluginSession, () => disabled);
    await monitor.start();
    expect(monitor.getStatus()).toMatchObject({
      generationStatus: { value: '已连接', description: '酒馆模型 · chat-a' },
      embeddingStatus: { value: '已连接', description: '自定义资源 · embed-a' },
      rerankStatus: { value: '已连接', description: '自定义资源 · rerank-a' },
    });
    monitor.dispose();
  });

  it('uses neutral unconfigured statuses for optional resources that the current strategy does not need', async () => {
    const monitor = unavailableMonitor();
    await monitor.start();
    expect(monitor.getStatus()).toMatchObject({
      generationStatus: { value: '不可用', tone: 'error' },
      embeddingStatus: { value: '未配置', tone: 'neutral' },
      rerankStatus: { value: '未配置', tone: 'neutral' },
    });
    monitor.dispose();
  });
});
