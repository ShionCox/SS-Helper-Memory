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
    await expect(monitor.assess(next, disabled)).resolves.toMatchObject({ blocked: { code }, warnings: [] });
    monitor.dispose();
  });

  it('allows automatic modes and reports both non-obvious degradations', async () => {
    const monitor = unavailableMonitor();
    await expect(monitor.assess({ enabled: true, autoOrganize: false, recallMode: 'auto', rerankMode: 'adaptive' }, disabled)).resolves.toMatchObject({
      warnings: [
        { code: 'MEMORY_EMBEDDING_DEGRADED' },
        { code: 'MEMORY_RERANK_DEGRADED' },
      ],
    });
    monitor.dispose();
  });
});
