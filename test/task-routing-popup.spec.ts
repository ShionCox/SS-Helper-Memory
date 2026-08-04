// jsdom is a runtime-only test dependency in this package.
// @ts-expect-error jsdom does not ship declarations in this workspace.
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSSHelperError,
  LLM_TASK_ROUTING_GET_V0,
  LLM_TASK_ROUTING_SET_V0,
  LLM_TOOL_CAPABILITY_VERIFY_V0,
  type LlmTaskRoutingSnapshot,
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

function resource(resourceId: string, label: string, available = true) {
  return {
    resourceId,
    label,
    type: 'generation' as const,
    apiType: 'openai',
    defaultModel: `${resourceId}-model`,
    enabled: true,
    available,
    capabilities: ['chat', 'json'],
    toolCapabilities: {
      status: 'verified' as const,
      resourceId,
      model: `${resourceId}-model`,
      dialect: 'openai_responses' as const,
      parallelToolCalls: false,
      streamingToolCalls: false,
      strictToolSchema: 'native' as const,
      reasoningReplay: 'none' as const,
      expiresAt: Date.now() + 60_000,
      probeVersion: 1,
    },
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
    createSelect: vi.fn((options: PopupSelectOptions) => {
      selects.push(options);
      return document.createElement('div');
    }),
    confirm: vi.fn(async () => confirmed),
    refreshControls: vi.fn(),
  } as unknown as PopupUiContext;
}

function sessionWith(request: ReturnType<typeof vi.fn>) {
  return {
    bus: { request },
    ui: { showToast: vi.fn() },
  } as unknown as PluginSession;
}

describe('Memory task routing popup', () => {
  it('uses the Memory session identity and writes only resourceId with revision protection', async () => {
    installDocument();
    const initial: LlmTaskRoutingSnapshot = {
      revision: 7,
      assignments: [],
      resources: [resource('generation-a', '生成 A'), resource('generation-b', '生成 B')],
    };
    const saved: LlmTaskRoutingSnapshot = {
      ...initial,
      revision: 8,
      assignments: [{ taskKey: 'memory_extract_single', resourceId: 'generation-b' }],
    };
    const request = vi.fn(async (contract, _payload?: unknown) => contract === LLM_TASK_ROUTING_GET_V0 ? initial : saved);
    const session = sessionWith(request);
    const selects: PopupSelectOptions[] = [];
    const container = document.createElement('div');
    const cleanup = await renderMemoryTaskRoutingPopup(container, session, popupUi(selects));

    expect(request.mock.calls[0]).toHaveLength(2);
    expect(request.mock.calls[0]).toEqual([LLM_TASK_ROUTING_GET_V0, { taskKeys: MEMORY_TASK_ROUTING_TASKS.map((task) => task.taskKey) }]);
    expect(container.querySelectorAll('.ss-helper-memory-routing-task')).toHaveLength(5);
    expect(container.textContent).toContain('0 / 5 可用于 Agent');
    expect(selects[0].label).toBe('实体提取使用的模型');

    container.querySelector<HTMLButtonElement>('[data-task-key="memory_extract_single"]')!.click();
    const singleSelect = selects.at(-1)!;
    expect(singleSelect.options.map((option) => option.label)).toEqual([
      '自动选择（使用默认生成路由）',
      '生成 A · generation-a-model · 工具调用已验证',
      '生成 B · generation-b-model · 工具调用已验证',
    ]);

    singleSelect.onChange('generation-b');
    const expectedAssignments = MEMORY_TASK_ROUTING_TASKS.map((task) => ({
      taskKey: task.taskKey,
      ...(task.taskKey === 'memory_extract_single' ? { resourceId: 'generation-b' } : {}),
    }));
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(LLM_TASK_ROUTING_SET_V0, {
      expectedRevision: 7,
      assignments: expectedAssignments,
    }));
    const setPayload = request.mock.calls.find(([contract]) => contract === LLM_TASK_ROUTING_SET_V0)?.[1] as { assignments: Array<Record<string, unknown>> } | undefined;
    expect(setPayload?.assignments[0]).not.toHaveProperty('model');
    expect(session.ui.showToast).toHaveBeenCalledWith(expect.objectContaining({ code: 'MEMORY_TASK_ROUTING_SAVED' }));
    cleanup();
  });

  it('preserves the other four assignments when one task changes', async () => {
    installDocument();
    const initial: LlmTaskRoutingSnapshot = {
      revision: 5,
      assignments: MEMORY_TASK_ROUTING_TASKS.map((task) => ({ taskKey: task.taskKey, resourceId: 'generation-a' })),
      resources: [resource('generation-a', '生成 A'), resource('generation-b', '生成 B')],
    };
    const request = vi.fn(async (contract, payload?: unknown) => contract === LLM_TASK_ROUTING_GET_V0
      ? initial
      : { ...initial, revision: 6, assignments: (payload as { assignments: LlmTaskRoutingSnapshot['assignments'] }).assignments });
    const selects: PopupSelectOptions[] = [];
    const container = document.createElement('div');
    await renderMemoryTaskRoutingPopup(container, sessionWith(request), popupUi(selects));

    selects[0]!.onChange('generation-b');
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(LLM_TASK_ROUTING_SET_V0, {
      expectedRevision: 5,
      assignments: MEMORY_TASK_ROUTING_TASKS.map((task) => ({
        taskKey: task.taskKey,
        resourceId: task.taskKey === 'memory_extract_entities' ? 'generation-b' : 'generation-a',
      })),
    }));
  });

  it('keeps unavailable and legacy assignments visible, then reloads on revision conflict', async () => {
    installDocument();
    const unavailable = resource('generation-old', '旧生成', false);
    const initial: LlmTaskRoutingSnapshot = {
      revision: 3,
      assignments: [
        { taskKey: 'memory_extract_single', resourceId: 'generation-old' },
        { taskKey: 'memory_extract_entities', resourceId: 'generation-a', model: 'legacy-model' },
      ],
      resources: [unavailable, resource('generation-a', '生成 A')],
    };
    const refreshed: LlmTaskRoutingSnapshot = { ...initial, revision: 4, assignments: [] };
    let gets = 0;
    const request = vi.fn(async (contract, _payload?: unknown) => {
      if (contract === LLM_TASK_ROUTING_GET_V0) return gets++ === 0 ? initial : refreshed;
      throw createSSHelperError('WORKSPACE_CONFLICT', { stage: 'memory.routing.save' });
    });
    const session = sessionWith(request);
    const selects: PopupSelectOptions[] = [];
    const container = document.createElement('div');
    await renderMemoryTaskRoutingPopup(container, session, popupUi(selects));

    expect(selects[0].value).toBe('legacy:generation-a');
    expect(selects[0].options.some((option) => option.label.includes('非默认模型覆盖，请重新选择'))).toBe(true);

    container.querySelector<HTMLButtonElement>('[data-task-key="memory_extract_single"]')!.click();
    expect(selects.at(-1)!.value).toBe('unavailable:generation-old');
    expect(selects.at(-1)!.options.some((option) => option.label.includes('当前不可用，请重新选择'))).toBe(true);

    container.querySelector<HTMLButtonElement>('[data-task-key="memory_extract_narrative"]')!.click();
    selects.at(-1)!.onChange('generation-a');
    await vi.waitFor(() => expect(session.ui.showToast).toHaveBeenCalledWith(expect.objectContaining({
      level: 'warning',
      code: 'WORKSPACE_CONFLICT',
    })));
    await vi.waitFor(() => expect(gets).toBe(2));
    expect(container.textContent).toContain('配置已被其他操作更新');
  });

  it('verifies the selected resource and can restore all five tasks to automatic routing', async () => {
    installDocument();
    const selectedResource = resource('generation-a', '生成 A');
    const initial: LlmTaskRoutingSnapshot = {
      revision: 11,
      assignments: [{ taskKey: 'memory_extract_entities', resourceId: 'generation-a' }],
      resources: [selectedResource],
    };
    const reset: LlmTaskRoutingSnapshot = { ...initial, revision: 12, assignments: [] };
    const request = vi.fn(async (contract) => {
      if (contract === LLM_TOOL_CAPABILITY_VERIFY_V0) return { capability: selectedResource.toolCapabilities };
      if (contract === LLM_TASK_ROUTING_SET_V0) return reset;
      return initial;
    });
    const selects: PopupSelectOptions[] = [];
    const container = document.createElement('div');
    await renderMemoryTaskRoutingPopup(container, sessionWith(request), popupUi(selects));

    container.querySelector<HTMLButtonElement>('[aria-label="重新验证 生成 A 的 Agent 工具能力"]')!.click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(LLM_TOOL_CAPABILITY_VERIFY_V0, {
      resourceId: 'generation-a',
      model: 'generation-a-model',
      force: true,
    }));

    container.querySelector<HTMLButtonElement>('[aria-label="将五个提取任务全部恢复为自动选择"]')!.click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(LLM_TASK_ROUTING_SET_V0, {
      expectedRevision: 11,
      assignments: MEMORY_TASK_ROUTING_TASKS.map((task) => ({ taskKey: task.taskKey })),
    }));
  });
});
