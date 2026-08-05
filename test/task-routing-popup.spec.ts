// jsdom is a runtime-only test dependency in this package.
// @ts-expect-error jsdom does not ship declarations in this workspace.
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSSHelperError,
  LLM_RESOURCE_CAPABILITY_VERIFY_V0,
  LLM_TASK_ROUTE_SET_V0,
  LLM_TASK_STATUS_CHANGED_V0,
  LLM_TASK_STATUS_V0,
  type LlmSafeResourceSummary,
  type LlmTaskRoutingAssignment,
  type LlmTaskStatusSnapshot,
  type PluginSession,
  type PopupButtonOptions,
  type PopupSelectOptions,
  type PopupUiContext,
} from '@ss-helper/sdk';
import { MEMORY_TASK_ROUTING_TASKS, renderMemoryTaskRoutingPopup } from '../src/ss-helper/task-routing-popup';

const originalDocument = globalThis.document;

afterEach(() => {
  if (originalDocument === undefined) Reflect.deleteProperty(globalThis, 'document');
  else globalThis.document = originalDocument;
});

function installDocument(): void {
  globalThis.document = new JSDOM('<!doctype html><body></body>').window.document;
}

function resource(resourceId: string, label: string, available = true, type: 'generation' | 'embedding' | 'rerank' = 'generation'): LlmSafeResourceSummary {
  return {
    resourceId, label, type, apiType: 'openai', defaultModel: `${resourceId}-model`, enabled: true, available,
    capabilities: type === 'generation' ? ['chat', 'json', 'tools'] : [type],
    ...(type === 'generation' ? {
      toolCapabilities: {
        status: 'verified' as const, resourceId, model: `${resourceId}-model`, dialect: 'openai_responses' as const,
        parallelToolCalls: false, streamingToolCalls: 'whole_call' as const, strictToolSchema: 'native' as const,
        reasoningReplay: 'none' as const, expiresAt: Date.now() + 60_000, probeVersion: 1,
      },
    } : {}),
  };
}

function execution(taskKey: string): 'structured' | 'tool_turn' | 'embedding' | 'rerank' {
  if (taskKey === 'memory_embed') return 'embedding';
  if (taskKey === 'memory_rerank') return 'rerank';
  if (taskKey === 'memory_extract_entities' || taskKey === 'memory_extract_content' || taskKey === 'memory_extract_content') return 'tool_turn';
  return 'structured';
}

function statusSnapshot(
  revision: number,
  assignments: readonly LlmTaskRoutingAssignment[] = [],
  resources: readonly LlmSafeResourceSummary[] = [resource('generation-a', '生成 A'), resource('generation-b', '生成 B'), resource('embedding-a', '向量 A', true, 'embedding'), resource('rerank-a', '重排 A', true, 'rerank')],
  available = true,
): LlmTaskStatusSnapshot {
  const defaults = { structured: 'generation-a', tool_turn: 'generation-a', embedding: 'embedding-a', rerank: 'rerank-a' } as const;
  const byId = new Map(resources.map((item) => [item.resourceId, item]));
  return {
    revision,
    assignments,
    defaults,
    resources,
    tasks: MEMORY_TASK_ROUTING_TASKS.map((task) => {
      const assignment = assignments.find((item) => item.taskKey === task.taskKey);
      const resourceId = assignment?.resourceId ?? defaults[task.execution];
      const active = byId.get(resourceId);
      return {
        taskKey: task.taskKey,
        execution: task.execution,
        available: available && active?.available === true,
        resourceId,
        model: active?.defaultModel,
        route: {
          resourceId,
          source: active?.resourceId.startsWith('tavern:') ? 'tavern' : 'custom',
          provider: active?.apiType ?? 'unknown',
          model: active?.defaultModel ?? 'unknown',
          execution: task.execution,
          transport: task.execution,
        },
      };
    }),
  };
}

function popupUi(selects: PopupSelectOptions[], confirmed = true): PopupUiContext {
  return {
    createButton: vi.fn((options: PopupButtonOptions) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.ssHelperControl = 'button';
      button.dataset.ssHelperSize = options.size ?? 'md';
      button.setAttribute('aria-label', options.ariaLabel ?? options.label);
      const label = document.createElement('span');
      label.textContent = options.label;
      button.append(label);
      return button;
    }),
    createIcon: vi.fn(() => document.createElement('ss-helper-icon')),
    createSelect: vi.fn((options: PopupSelectOptions) => { selects.push(options); return document.createElement('div'); }),
    confirm: vi.fn(async () => confirmed),
    refreshControls: vi.fn(),
  } as unknown as PopupUiContext;
}

function sessionWith(request: ReturnType<typeof vi.fn>, subscribe = vi.fn(() => () => undefined)): PluginSession {
  return { bus: { request, subscribe }, ui: { showToast: vi.fn() } } as unknown as PluginSession;
}

describe('Memory task routing popup', () => {
  it('uses the Memory session identity and writes only resourceId with revision protection', async () => {
    installDocument();
    const initial = statusSnapshot(7);
    const saved = statusSnapshot(8, [{ taskKey: 'memory_extract_single', resourceId: 'generation-b' }]);
    const request = vi.fn(async (contract: unknown) => contract === LLM_TASK_STATUS_V0 ? initial : contract === LLM_TASK_ROUTE_SET_V0 ? saved : undefined);
    const session = sessionWith(request);
    const selects: PopupSelectOptions[] = [];
    const container = document.createElement('div');
    const cleanup = await renderMemoryTaskRoutingPopup(container, session, popupUi(selects));

    expect(request.mock.calls[0]).toEqual([LLM_TASK_STATUS_V0, { taskKeys: MEMORY_TASK_ROUTING_TASKS.map((task) => task.taskKey) }]);
    expect(container.querySelectorAll('.ss-helper-memory-routing-task')).toHaveLength(8);
    expect(container.textContent).toContain('2 / 2 个 Agent 场景可用');
    expect(container.textContent).toContain('生成 A（自动）');
    expect(container.textContent).toContain('自动选择当前解析为 生成 A');
    expect(selects[0].label).toBe('实体提取使用的模型');

    container.querySelector<HTMLButtonElement>('[data-task-key="memory_extract_single"]')!.click();
    const singleSelect = selects.at(-1)!;
    expect(singleSelect.options.map((option) => option.label)).toEqual([
      '自动选择（使用默认生成路由）',
      '生成 A · generation-a-model',
      '生成 B · generation-b-model',
    ]);
    singleSelect.onChange('generation-b');
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(LLM_TASK_ROUTE_SET_V0, {
      expectedRevision: 7,
      assignments: MEMORY_TASK_ROUTING_TASKS.map((task) => ({ taskKey: task.taskKey, ...(task.taskKey === 'memory_extract_single' ? { resourceId: 'generation-b' } : {}) })),
    }));
    const setCall = request.mock.calls.find((call) => call[0] === LLM_TASK_ROUTE_SET_V0) as unknown as [unknown, { assignments: Array<Record<string, unknown>> }];
    const setPayload = setCall?.[1];
    expect(setPayload?.assignments[0]).not.toHaveProperty('model');
    await vi.waitFor(() => expect(session.ui.showToast).toHaveBeenCalledWith(expect.objectContaining({ code: 'MEMORY_TASK_ROUTING_SAVED' })));
    cleanup();
  });

  it('preserves the other eight assignments when one task changes', async () => {
    installDocument();
    const assignments = MEMORY_TASK_ROUTING_TASKS.map((task) => ({ taskKey: task.taskKey, resourceId: 'generation-a' }));
    const initial = statusSnapshot(5, assignments);
    const request = vi.fn(async (contract: unknown, payload?: unknown) => contract === LLM_TASK_STATUS_V0
      ? initial
      : statusSnapshot(6, (payload as { assignments: LlmTaskRoutingAssignment[] }).assignments));
    const selects: PopupSelectOptions[] = [];
    const container = document.createElement('div');
    await renderMemoryTaskRoutingPopup(container, sessionWith(request), popupUi(selects));
    selects[0]!.onChange('generation-b');
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(LLM_TASK_ROUTE_SET_V0, {
      expectedRevision: 5,
      assignments: MEMORY_TASK_ROUTING_TASKS.map((task) => ({ taskKey: task.taskKey, resourceId: task.taskKey === 'memory_extract_entities' ? 'generation-b' : 'generation-a' })),
    }));
  });

  it('keeps unavailable assignments visible, then reloads on revision conflict', async () => {
    installDocument();
    const unavailable = resource('generation-old', '旧生成', false);
    const initial = statusSnapshot(3, [
      { taskKey: 'memory_extract_single', resourceId: 'generation-old' },
      { taskKey: 'memory_extract_entities', resourceId: 'generation-a' },
    ], [unavailable, resource('generation-a', '生成 A')]);
    const refreshed = statusSnapshot(4, [], [resource('generation-a', '生成 A')]);
    let gets = 0;
    const request = vi.fn(async (contract: unknown) => {
      if (contract === LLM_TASK_STATUS_V0) return gets++ === 0 ? initial : refreshed;
      throw createSSHelperError('WORKSPACE_CONFLICT', { stage: 'memory.routing.save' });
    });
    const session = sessionWith(request);
    const selects: PopupSelectOptions[] = [];
    const container = document.createElement('div');
    await renderMemoryTaskRoutingPopup(container, session, popupUi(selects));
    expect(selects[0].value).toBe('generation-a');
    container.querySelector<HTMLButtonElement>('[data-task-key="memory_extract_single"]')!.click();
    expect(selects.at(-1)!.options.some((option) => option.label.includes('当前不可用，请重新选择'))).toBe(true);
    container.querySelector<HTMLButtonElement>('[data-task-key="memory_extract_content"]')!.click();
    selects.at(-1)!.onChange('generation-a');
    await vi.waitFor(() => expect(session.ui.showToast).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning', code: 'WORKSPACE_CONFLICT' })));
    await vi.waitFor(() => expect(gets).toBe(2));
    expect(container.textContent).toContain('配置已被其他操作更新');
  });

  it('verifies one selected tool task and can restore all eight tasks to automatic routing', async () => {
    installDocument();
    const selectedResource = resource('generation-a', '生成 A');
    const initial = statusSnapshot(11, [{ taskKey: 'memory_extract_entities', resourceId: 'generation-a' }], [selectedResource]);
    const reset = statusSnapshot(12, [], [selectedResource]);
    const request = vi.fn(async (contract: unknown) => {
      if (contract === LLM_RESOURCE_CAPABILITY_VERIFY_V0) return { capability: selectedResource.toolCapabilities };
      if (contract === LLM_TASK_ROUTE_SET_V0) return reset;
      return initial;
    });
    const selects: PopupSelectOptions[] = [];
    const container = document.createElement('div');
    await renderMemoryTaskRoutingPopup(container, sessionWith(request), popupUi(selects));
    container.querySelector<HTMLButtonElement>('[aria-label="重新验证 生成 A 的 Agent 工具能力"]')!.click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(LLM_RESOURCE_CAPABILITY_VERIFY_V0, { resourceId: 'generation-a', taskKeys: ['memory_extract_entities'], force: true }));
    container.querySelector<HTMLButtonElement>('[aria-label="将全部记忆场景恢复为自动选择"]')!.click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(LLM_TASK_ROUTE_SET_V0, {
      expectedRevision: 11,
      assignments: MEMORY_TASK_ROUTING_TASKS.map((task) => ({ taskKey: task.taskKey })),
    }));
  });

  it('refreshes an open popup when unified task status changes', async () => {
    installDocument();
    const unverified = resource('generation-a', '生成 A');
    const initial = statusSnapshot(1, [], [unverified], false);
    const verified = resource('generation-a', '生成 A');
    const refreshed = statusSnapshot(2, [], [verified], true);
    let getCount = 0;
    let listener: ((payload: { revision: number; taskKeys: readonly string[]; resourceIds: readonly string[] }) => void) | undefined;
    const request = vi.fn(async (contract: unknown) => {
      if (contract === LLM_TASK_STATUS_V0) return getCount++ === 0 ? initial : refreshed;
      throw new Error('unexpected request');
    });
    const subscribe = vi.fn((contract: unknown, next: (payload: { revision: number; taskKeys: readonly string[]; resourceIds: readonly string[] }) => void) => {
      expect(contract).toBe(LLM_TASK_STATUS_CHANGED_V0); listener = next; return () => undefined;
    });
    const container = document.createElement('div');
    const cleanup = await renderMemoryTaskRoutingPopup(container, sessionWith(request, subscribe), popupUi([]));
    expect(container.textContent).toContain('0 / 2 个 Agent 场景可用');
    listener?.({ revision: 2, taskKeys: ['memory_extract_entities'], resourceIds: ['generation-a'] });
    await vi.waitFor(() => expect(container.textContent).toContain('2 / 2 个 Agent 场景可用'));
    expect(container.textContent).toContain('工具能力状态已刷新');
    cleanup();
  });
});
