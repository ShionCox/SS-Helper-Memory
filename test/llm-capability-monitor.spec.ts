import { describe, expect, it, vi } from 'vitest';
import { LLM_CAPABILITY_STATUS_V0, LLM_TASK_ROUTING_GET_V0, type PluginSession } from '@ss-helper/sdk';
import {
  MEMORY_LLM_CAPABILITY_STATUS_TIMEOUT_MS,
  MemoryLlmCapabilityMonitor,
  type MemoryCapabilitySettings,
} from '../src/ss-helper/llm-capability-monitor';

const disabled: MemoryCapabilitySettings = { enabled: false, autoOrganize: false, recallMode: 'lexical', rerankMode: 'off', preExtractReferenceEnabled: false, preExtractReferenceMode: 'auto' };

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
    bus: { request: vi.fn(async () => response), subscribe: vi.fn(() => () => {}) },
    host: { events: { subscribe: vi.fn(() => () => {}) } },
  } as unknown as PluginSession, () => disabled);
}

const agentTaskIds = ['agent_single', 'agent_entities', 'agent_narrative', 'agent_inventory', 'agent_repair'] as const;
const agentSettings: MemoryCapabilitySettings = {
  enabled: true, autoOrganize: false, recallMode: 'lexical', rerankMode: 'off',
  preExtractReferenceEnabled: false, preExtractReferenceMode: 'auto', extractionMode: 'agent',
  agentToolPolicy: 'off', agentWriteMode: 'shadow',
};

function agentMonitor(options: { status?: 'verified' | 'failed'; expiresAt?: number; entryModel?: string; capabilityModel?: string } = {}): MemoryLlmCapabilityMonitor {
  const model = 'agent-model';
  const capability = {
    status: options.status ?? 'verified', resourceId: 'agent-resource', model: options.capabilityModel ?? model,
    dialect: 'openai_chat_compatible', parallelToolCalls: false, streamingToolCalls: false,
    strictToolSchema: 'none', reasoningReplay: 'none', probeVersion: 2,
    expiresAt: options.expiresAt ?? Date.now() + 60_000,
  };
  const statusResponse = {
    revision: 1,
    checks: [
      { id: 'generation', configured: true, available: true, source: 'custom', resourceId: 'agent-resource', model },
      ...agentTaskIds.map((id) => ({ id, configured: true, available: true, source: 'custom', resourceId: 'agent-resource', model: options.entryModel ?? model })),
      { id: 'embedding', configured: false, available: false, reason: 'no_resource' },
      { id: 'rerank', configured: false, available: false, reason: 'no_resource' },
    ],
  };
  const routingResponse = {
    revision: 1,
    assignments: [],
    resources: [{
      resourceId: 'agent-resource', label: 'Agent 模型', type: 'generation', apiType: 'openai',
      defaultModel: model, enabled: true, available: true, capabilities: ['chat', 'json', 'tools'], toolCapabilities: capability,
    }],
  };
  return new MemoryLlmCapabilityMonitor({
    bus: { request: vi.fn(async (contract: unknown) => contract === LLM_CAPABILITY_STATUS_V0 ? statusResponse : routingResponse), subscribe: vi.fn(() => () => {}) },
    host: { events: { subscribe: vi.fn(() => () => {}) } },
  } as unknown as PluginSession, () => agentSettings);
}

describe('Memory settings capability policy', () => {
  it('allows Agent with tool policy off only when all resolved default models are verified', async () => {
    const monitor = agentMonitor();
    await expect(monitor.assess(agentSettings, disabled)).resolves.toEqual({ warnings: [] });
    expect(monitor.isAgentAvailable()).toBe(true);
    monitor.dispose();
  });

  it.each([
    ['failed capability', { status: 'failed' as const }],
    ['expired capability', { expiresAt: Date.now() - 1 }],
    ['non-default route model', { entryModel: 'old-model' }],
    ['mismatched capability model', { capabilityModel: 'old-model' }],
  ])('blocks Agent for %s even when read-only tools are disabled', async (_label, options) => {
    const monitor = agentMonitor(options);
    await expect(monitor.assess(agentSettings, disabled)).resolves.toMatchObject({
      blocked: { code: 'LLM_TOOL_CAPABILITY_UNVERIFIED', message: expect.stringContaining('不支持 Agent 模式') },
      warnings: [],
    });
    expect(monitor.isAgentAvailable()).toBe(false);
    monitor.dispose();
  });
  it.each([
    [{ enabled: true, autoOrganize: true, recallMode: 'lexical', rerankMode: 'off', preExtractReferenceEnabled: false, preExtractReferenceMode: 'auto' }, 'MEMORY_GENERATION_UNAVAILABLE'],
    [{ enabled: true, autoOrganize: false, recallMode: 'vector', rerankMode: 'off', preExtractReferenceEnabled: false, preExtractReferenceMode: 'auto' }, 'MEMORY_EMBEDDING_UNAVAILABLE'],
    [{ enabled: true, autoOrganize: false, recallMode: 'lexical', rerankMode: 'always', preExtractReferenceEnabled: false, preExtractReferenceMode: 'auto' }, 'MEMORY_RERANK_UNAVAILABLE'],
  ] as const)('blocks an unavailable strict setting without persisting it', async (next, code) => {
    const monitor = unavailableMonitor();
    const assessment = await monitor.assess(next, disabled);
    expect(assessment).toMatchObject({ blocked: { code }, warnings: [] });
    expect(assessment.blocked?.message).toContain('LLM');
    monitor.dispose();
  });

  it('allows automatic modes and reports both non-obvious degradations', async () => {
    const monitor = unavailableMonitor();
    await expect(monitor.assess({ enabled: true, autoOrganize: false, recallMode: 'auto', rerankMode: 'adaptive', preExtractReferenceEnabled: false, preExtractReferenceMode: 'auto' }, disabled)).resolves.toMatchObject({
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
      bus: { request: call, subscribe: vi.fn((_token, listener) => { eventListener = listener; return () => { eventListener = undefined; }; }) },
      host: { events: { subscribe: vi.fn(() => () => {}) } },
    } as unknown as PluginSession, () => ({ enabled: true, autoOrganize: true, recallMode: 'vector', rerankMode: 'off', preExtractReferenceEnabled: false, preExtractReferenceMode: 'auto' }));
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
      bus: { request: vi.fn(async () => response), subscribe: vi.fn(() => () => {}) },
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

  it('requests task routing for embedding and rerank alongside extraction tasks', async () => {
    const call = vi.fn(async (contract: unknown) => contract === LLM_CAPABILITY_STATUS_V0
      ? { revision: 1, checks: [] }
      : { revision: 1, resources: [], taskAssignments: {} });
    const monitor = new MemoryLlmCapabilityMonitor({
      bus: { request: call, subscribe: vi.fn(() => () => {}) },
      host: { events: { subscribe: vi.fn(() => () => {}) } },
    } as unknown as PluginSession, () => disabled);

    await monitor.start();

    expect(call).toHaveBeenCalledWith(LLM_TASK_ROUTING_GET_V0, expect.objectContaining({
      taskKeys: expect.arrayContaining(['memory_embed', 'memory_rerank']),
    }), expect.objectContaining({ timeoutMs: MEMORY_LLM_CAPABILITY_STATUS_TIMEOUT_MS }));
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

  it('bounds a stalled LLM capability probe and publishes a safe unavailable state', async () => {
    vi.useFakeTimers();
    try {
      const monitor = new MemoryLlmCapabilityMonitor({
        bus: { request: vi.fn(() => new Promise(() => {})), subscribe: vi.fn(() => () => {}) },
        host: { events: { subscribe: vi.fn(() => () => {}) } },
      } as unknown as PluginSession, () => disabled);

      const started = monitor.start();
      await vi.advanceTimersByTimeAsync(MEMORY_LLM_CAPABILITY_STATUS_TIMEOUT_MS);
      await expect(started).resolves.toBeUndefined();
      expect(monitor.getStatus()).toMatchObject({
        generationStatus: { value: '不可用', tone: 'error' },
        embeddingStatus: { value: '未配置', tone: 'neutral' },
        rerankStatus: { value: '未配置', tone: 'neutral' },
      });
      monitor.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
