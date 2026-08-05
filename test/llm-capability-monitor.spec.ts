import { describe, expect, it, vi } from 'vitest';
import { LLM_TASK_STATUS_V0, type LlmTaskStatusSnapshot, type PluginSession, type VerifiedToolCapabilities } from '@ss-helper/sdk';
import {
  MEMORY_LLM_CAPABILITY_STATUS_TIMEOUT_MS,
  MemoryLlmCapabilityMonitor,
  type MemoryCapabilitySettings,
} from '../src/ss-helper/llm-capability-monitor';

const disabled: MemoryCapabilitySettings = { enabled: false, autoOrganize: false, recallMode: 'lexical', rerankMode: 'off', preExtractReferenceEnabled: false, preExtractReferenceMode: 'auto' };

function unavailableMonitor(): MemoryLlmCapabilityMonitor {
  const response: LlmTaskStatusSnapshot = {
    revision: 1,
    tasks: taskKeys.map((taskKey) => ({ taskKey, execution: executionOf(taskKey), available: false, failure: { reasonCode: 'LLM_TASK_ROUTE_UNAVAILABLE', stage: 'llm.task.status' } })),
    defaults: {}, assignments: [], resources: [],
  };
  return new MemoryLlmCapabilityMonitor({
    bus: { request: vi.fn(async () => response), subscribe: vi.fn(() => () => {}) },
    host: { events: { subscribe: vi.fn(() => () => {}) } },
  } as unknown as PluginSession, () => disabled);
}

const taskKeys = ['memory_extract_single', 'memory_extract_entities', 'memory_extract_content', 'memory_extract_content', 'memory_extract_repair', 'memory_cast_plan', 'memory_recall_intent', 'memory_embed', 'memory_rerank'] as const;
const agentTaskIds = ['memory_extract_entities', 'memory_extract_content', 'memory_extract_content'] as const;
function executionOf(taskKey: string): 'structured' | 'tool_turn' | 'embedding' | 'rerank' {
  if (taskKey === 'memory_embed') return 'embedding';
  if (taskKey === 'memory_rerank') return 'rerank';
  if (agentTaskIds.includes(taskKey as typeof agentTaskIds[number])) return 'tool_turn';
  return 'structured';
}
const agentSettings: MemoryCapabilitySettings = {
  enabled: true, autoOrganize: false, recallMode: 'lexical', rerankMode: 'off',
  preExtractReferenceEnabled: false, preExtractReferenceMode: 'auto', extractionMode: 'agent',
  agentToolPolicy: 'read_only',
};

function agentMonitor(options: { status?: 'verified' | 'failed'; expiresAt?: number; entryModel?: string; routeModel?: string; capabilityModel?: string } = {}): MemoryLlmCapabilityMonitor {
  const model = 'agent-model';
  const capability: VerifiedToolCapabilities = {
    status: options.status ?? 'verified', resourceId: 'agent-resource', model: options.capabilityModel ?? model,
    dialect: 'openai_chat_compatible', parallelToolCalls: false, streamingToolCalls: 'whole_call',
    strictToolSchema: 'unsupported', reasoningReplay: 'none', probeVersion: 2,
    expiresAt: options.expiresAt ?? Date.now() + 60_000,
  };
  const statusResponse: LlmTaskStatusSnapshot = {
    revision: 1,
    tasks: taskKeys.map((taskKey) => ({
      taskKey,
      execution: executionOf(taskKey),
      available: taskKey === 'memory_embed' || taskKey === 'memory_rerank' ? false : true,
      ...(taskKey === 'memory_embed' || taskKey === 'memory_rerank' ? {} : {
        resourceId: 'agent-resource',
        ...(options.entryModel ? { model: options.entryModel } : {}),
        route: { resourceId: 'agent-resource', source: 'custom', provider: 'openai', model: options.routeModel ?? model, execution: executionOf(taskKey), transport: 'json' },
      }),
      ...((options.status === 'failed' && taskKey !== 'memory_embed' && taskKey !== 'memory_rerank') ? { failure: { reasonCode: 'LLM_TASK_ROUTE_UNAVAILABLE', stage: 'llm.task.status' } } : {}),
    })),
    defaults: { structured: 'agent-resource', tool_turn: 'agent-resource' },
    assignments: [],
    resources: [{
      resourceId: 'agent-resource', label: 'Agent 模型', type: 'generation', apiType: 'openai',
      defaultModel: model, enabled: true, available: true, capabilities: ['chat', 'json', 'tools'], toolCapabilities: capability,
    }],
  };
  return new MemoryLlmCapabilityMonitor({
    bus: { request: vi.fn(async (contract: unknown) => contract === LLM_TASK_STATUS_V0 ? statusResponse : statusResponse), subscribe: vi.fn(() => () => {}) },
    host: { events: { subscribe: vi.fn(() => () => {}) } },
  } as unknown as PluginSession, () => agentSettings);
}

describe('Memory settings capability policy', () => {
  it('allows Agent with read-only tool policy only when all resolved default models are verified', async () => {
    const monitor = agentMonitor();
    await expect(monitor.assess(agentSettings, disabled)).resolves.toEqual({ warnings: [] });
    expect(monitor.isAgentAvailable()).toBe(true);
    monitor.dispose();
  });

  it('blocks Agent when the required tool policy is disabled', async () => {
    const monitor = agentMonitor();
    await expect(monitor.assess({ ...agentSettings, agentToolPolicy: 'off' }, disabled)).resolves.toMatchObject({
      blocked: { code: 'LLM_TOOL_CAPABILITY_UNVERIFIED', message: expect.stringContaining('基础工具调用是硬要求') },
      warnings: [],
    });
    expect(monitor.isAgentAvailable()).toBe(true);
    monitor.dispose();
  });

  it('uses canonical route metadata when the optional duplicate task model is absent or stale', async () => {
    for (const monitor of [agentMonitor(), agentMonitor({ entryModel: 'stale-duplicate-model' })]) {
      await expect(monitor.assess(agentSettings, disabled)).resolves.toEqual({ warnings: [] });
      expect(monitor.isAgentAvailable()).toBe(true);
      expect(monitor.getStatus().agentRouteEntities).toMatchObject({ value: '工具调用已验证', tone: 'success' });
      monitor.dispose();
    }
  });

  it.each([
    ['failed capability', { status: 'failed' as const }],
    ['expired capability', { expiresAt: Date.now() - 1 }],
    ['non-default route model', { routeModel: 'old-model' }],
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
    let eventListener: ((payload: { revision: number; taskKeys: readonly string[]; resourceIds: readonly string[] }) => void) | undefined;
    const call = vi.fn(async () => ({
      revision,
      tasks: taskKeys.map((taskKey) => ({ taskKey, execution: executionOf(taskKey), available: taskKey === 'memory_rerank' ? false : true, resourceId: taskKey === 'memory_embed' ? 'private-resource-id' : 'tavern-resource', model: taskKey === 'memory_embed' ? model : 'chat-a', route: { resourceId: taskKey === 'memory_embed' ? 'private-resource-id' : 'tavern-resource', source: taskKey === 'memory_embed' ? 'custom' : 'tavern', provider: 'openai', model: taskKey === 'memory_embed' ? model : 'chat-a', execution: executionOf(taskKey), transport: 'json' } })),
      defaults: { structured: 'tavern-resource', tool_turn: 'tavern-resource', embedding: 'private-resource-id' }, assignments: [],
      resources: [{ resourceId: 'tavern-resource', label: '酒馆模型', type: 'generation', apiType: 'openai', defaultModel: 'chat-a', enabled: true, available: true, capabilities: ['chat', 'json', 'tools'], toolCapabilities: { status: 'verified', resourceId: 'tavern-resource', model: 'chat-a', dialect: 'openai_responses', parallelToolCalls: false, streamingToolCalls: 'whole_call', strictToolSchema: 'unsupported', reasoningReplay: 'none', probeVersion: 1 } }, { resourceId: 'private-resource-id', label: '自定义资源', type: 'embedding', apiType: 'openai', defaultModel: model, enabled: true, available: true, capabilities: ['embedding'] }],
    } as LlmTaskStatusSnapshot));
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
    eventListener?.({ revision, taskKeys: ['memory_embed'], resourceIds: ['private-resource-id'] });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(snapshots.at(-1)?.embeddingStatus.description).toContain('embed-b');
    const count = snapshots.length;
    const listenerAfterDispose = eventListener;
    monitor.dispose();
    listenerAfterDispose?.({ revision: 3, taskKeys: ['memory_embed'], resourceIds: ['private-resource-id'] });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(snapshots).toHaveLength(count);
  });

  it('reports real resource availability even when Memory is globally disabled', async () => {
    const response: LlmTaskStatusSnapshot = {
      revision: 1,
      tasks: taskKeys.map((taskKey) => ({ taskKey, execution: executionOf(taskKey), available: true, resourceId: taskKey === 'memory_embed' ? 'embed-resource' : taskKey === 'memory_rerank' ? 'rerank-resource' : 'tavern-resource', model: taskKey === 'memory_embed' ? 'embed-a' : taskKey === 'memory_rerank' ? 'rerank-a' : 'chat-a', route: { resourceId: taskKey === 'memory_embed' ? 'embed-resource' : taskKey === 'memory_rerank' ? 'rerank-resource' : 'tavern-resource', source: taskKey === 'memory_embed' || taskKey === 'memory_rerank' ? 'custom' : 'tavern', provider: 'openai', model: taskKey === 'memory_embed' ? 'embed-a' : taskKey === 'memory_rerank' ? 'rerank-a' : 'chat-a', execution: executionOf(taskKey), transport: 'json' } })),
      defaults: { structured: 'tavern-resource', tool_turn: 'tavern-resource', embedding: 'embed-resource', rerank: 'rerank-resource' }, assignments: [],
      resources: [
        { resourceId: 'tavern-resource', label: '酒馆模型', type: 'generation', apiType: 'openai', defaultModel: 'chat-a', enabled: true, available: true, capabilities: ['chat'] },
        { resourceId: 'embed-resource', label: '自定义资源', type: 'embedding', apiType: 'openai', defaultModel: 'embed-a', enabled: true, available: true, capabilities: ['embedding'] },
        { resourceId: 'rerank-resource', label: '自定义资源', type: 'rerank', apiType: 'openai', defaultModel: 'rerank-a', enabled: true, available: true, capabilities: ['rerank'] },
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
    const call = vi.fn(async () => unavailableMonitorSnapshot());
    const monitor = new MemoryLlmCapabilityMonitor({
      bus: { request: call, subscribe: vi.fn(() => () => {}) },
      host: { events: { subscribe: vi.fn(() => () => {}) } },
    } as unknown as PluginSession, () => disabled);

    await monitor.start();

    expect(call).toHaveBeenCalledWith(LLM_TASK_STATUS_V0, expect.objectContaining({
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

  it('bounds a stalled LLM capability probe and keeps the state synchronising', async () => {
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
        generationStatus: { value: '正在同步', tone: 'neutral' },
        embeddingStatus: { value: '正在同步', tone: 'neutral' },
        rerankStatus: { value: '正在同步', tone: 'neutral' },
      });
      monitor.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

function unavailableMonitorSnapshot(): LlmTaskStatusSnapshot {
  return { revision: 1, tasks: taskKeys.map((taskKey) => ({ taskKey, execution: executionOf(taskKey), available: false })), defaults: {}, assignments: [], resources: [] };
}
