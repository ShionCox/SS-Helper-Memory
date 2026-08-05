import {
  LLM_TASK_STATUS_V0,
  LLM_TASK_ROUTE_SET_V0,
  LLM_RESOURCE_CAPABILITY_VERIFY_V0,
  LLM_TASK_STATUS_CHANGED_V0,
  readSSHelperFailure,
  type LlmSafeResourceSummary,
  type LlmTaskRoutingAssignment,
  type LlmTaskStatusSnapshot,
  type PluginSession,
  type PopupUiContext,
  type SSHelperReasonCode,
  type ToastNotification,
} from '@ss-helper/sdk';
import { MEMORY_TASK_ROUTING_POPUP } from './settings';

export const MEMORY_TASK_ROUTING_TASKS = Object.freeze([
  { taskKey: 'memory_extract_single', label: '单次提取', description: '单阶段结构化记忆提取', execution: 'structured', icon: 'bolt' },
  { taskKey: 'memory_extract_entities', label: '实体提取', description: '人物与地点实体解析', execution: 'tool_turn', icon: 'user-tag' },
  { taskKey: 'memory_extract_content', label: '内容与库存提取', description: '叙事、事实与库存联合提取', execution: 'tool_turn', icon: 'book-open' },
  { taskKey: 'memory_extract_repair', label: '结构修复', description: '局部结构化提取修复', execution: 'structured', icon: 'wrench' },
  { taskKey: 'memory_cast_plan', label: '角色规划', description: '下一轮角色规划', execution: 'structured', icon: 'bolt' },
  { taskKey: 'memory_recall_intent', label: '召回意图', description: '复杂召回查询规划', execution: 'structured', icon: 'magnifying-glass' },
  { taskKey: 'memory_embed', label: '向量索引', description: '记忆向量化与查询', execution: 'embedding', icon: 'database' },
  { taskKey: 'memory_rerank', label: '候选重排', description: '召回候选模型重排', execution: 'rerank', icon: 'sort' },
] as const);

const taskKeys = MEMORY_TASK_ROUTING_TASKS.map((task) => task.taskKey);
type MemoryRoutingTaskKey = (typeof taskKeys)[number];

function safeReasonCode(error: unknown, fallback: SSHelperReasonCode = 'INTERNAL_ERROR'): string {
  return readSSHelperFailure(error, { reasonCode: fallback, stage: 'memory.routing.ui' })!.reasonCode;
}

function capabilityCurrent(resource: LlmSafeResourceSummary | undefined): boolean {
  const capability = resource?.toolCapabilities;
  return capability?.status === 'verified'
    && (capability.expiresAt === undefined || capability.expiresAt > Date.now());
}

function capabilityLabel(resource: LlmSafeResourceSummary): string {
  const capability = resource.toolCapabilities;
  if (capability?.expiresAt !== undefined && capability.expiresAt <= Date.now()) return '工具调用验证已过期';
  if (capability?.status === 'verified') return '工具调用已验证';
  if (capability?.status === 'failed') return '工具调用未通过';
  return '工具调用未验证';
}

function resourceLabel(resource: LlmSafeResourceSummary): string {
  return `${resource.label} · ${resource.defaultModel ?? '默认模型'} · ${capabilityLabel(resource)}`;
}

function capabilityValue(value: 'incremental' | 'whole_call' | 'unsupported' | 'unknown' | undefined): string {
  if (value === 'incremental') return '增量流式';
  if (value === 'whole_call') return '整块工具调用';
  if (value === 'unsupported') return '不支持';
  return '未验证';
}

function strictSchemaLabel(value: 'native' | 'beta' | 'unsupported' | 'unknown' | undefined): string {
  if (value === 'native') return '原生支持';
  if (value === 'beta') return 'Beta';
  if (value === 'unsupported') return '不支持';
  return '未验证';
}

export async function renderMemoryTaskRoutingPopup(
  container: HTMLElement,
  session: PluginSession,
  ui: PopupUiContext,
): Promise<() => void> {
  const document = container.ownerDocument;
  let disposed = false;
  let selectedTaskKey: MemoryRoutingTaskKey = 'memory_extract_entities';
  let snapshot: LlmTaskStatusSnapshot = await session.bus.request(LLM_TASK_STATUS_V0, { taskKeys });

  const workspace = document.createElement('div');
  workspace.className = 'ss-helper-memory-routing-workspace';
  const intro = document.createElement('header');
  intro.className = 'ss-helper-memory-routing-intro';
  const introCopy = document.createElement('div');
  const eyebrow = document.createElement('span');
  eyebrow.className = 'ss-helper-memory-routing-eyebrow';
  eyebrow.textContent = 'MEMORY PIPELINE';
  const note = document.createElement('p');
  note.textContent = '为记忆提取、规划、召回、向量和重排场景分别选择资源；每个场景进入自己的执行链。';
  introCopy.append(eyebrow, note);
  const readiness = document.createElement('span');
  readiness.className = 'ss-helper-memory-routing-readiness';
  readiness.dataset.ssHelperControl = 'status';
  intro.append(introCopy, readiness);

  const layout = document.createElement('div');
  layout.className = 'ss-helper-memory-routing-layout';
  const nav = document.createElement('nav');
  nav.className = 'ss-helper-memory-routing-nav';
  nav.setAttribute('aria-label', '记忆提取任务');
  const detail = document.createElement('section');
  detail.className = 'ss-helper-memory-routing-detail';
  detail.setAttribute('aria-live', 'polite');
  layout.append(nav, detail);

  const footer = document.createElement('footer');
  footer.className = 'ss-helper-memory-routing-footer';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = '修改会即时保存。';
  const resetButton = ui.createButton({
    label: '全部恢复自动选择',
    ariaLabel: '将全部记忆场景恢复为自动选择',
    icon: 'rotate-left',
    tone: 'neutral',
    size: 'sm',
  });
  resetButton.classList.add('ss-helper-memory-routing-reset');
  footer.append(status, resetButton);
  workspace.append(intro, layout, footer);
  container.append(workspace);

  const notify = (notification: ToastNotification): void => {
    try { session.ui.showToast(notification); } catch { /* Core may be disposing. */ }
  };

  const selectedButton = (): HTMLButtonElement | null => nav.querySelector(`[data-task-key="${selectedTaskKey}"]`);

  let loadSequence = 0;
  let saveQueue: Promise<void> = Promise.resolve();
  let pendingSave: { assignments: readonly LlmTaskRoutingAssignment[]; successMessage: string } | undefined;
  let saveInProgress = false;
  let refreshPending = false;

  const readLatest = async (): Promise<LlmTaskStatusSnapshot> => session.bus.request(LLM_TASK_STATUS_V0, { taskKeys });
  const load = async (focusTask = false): Promise<void> => {
    if (saveInProgress) {
      refreshPending = true;
      return;
    }
    const sequence = ++loadSequence;
    const next = await readLatest();
    if (disposed || saveInProgress || sequence !== loadSequence || next.revision < snapshot.revision) return;
    snapshot = next;
    renderWorkspace(focusTask);
  };

  const runSaveQueue = async (): Promise<void> => {
    saveInProgress = true;
    try {
      while (pendingSave !== undefined && !disposed) {
        let intent = pendingSave;
        pendingSave = undefined;
        let replayed = false;
        while (!disposed) {
          // A newer UI intent supersedes an older one before it reaches the bus.
          if (pendingSave !== undefined) {
            intent = pendingSave;
            pendingSave = undefined;
            replayed = false;
          }
          status.textContent = '正在保存任务路由…';
          try {
            snapshot = await session.bus.request(LLM_TASK_ROUTE_SET_V0, {
              expectedRevision: snapshot.revision,
              assignments: intent.assignments,
            });
            status.textContent = '任务路由已保存并热加载。';
            notify({
              level: 'success',
              title: '任务路由已保存',
              message: intent.successMessage,
              code: 'MEMORY_TASK_ROUTING_SAVED',
            });
            renderWorkspace();
            break;
          } catch (error) {
            if (disposed) return;
            const code = safeReasonCode(error);
            if (code === 'WORKSPACE_CONFLICT' && !replayed) {
              replayed = true;
              status.textContent = '配置已被其他操作更新，正在重放最新选择。';
              try {
                const latest = await readLatest();
                if (latest.revision >= snapshot.revision) snapshot = latest;
              } catch {
                // The retry below reports the original conflict without applying
                // a stale local snapshot.
              }
              continue;
            }
            status.textContent = code === 'WORKSPACE_CONFLICT' ? '配置已被其他操作更新，请重新选择需要的模型。' : `路由保存失败（${code}）。`;
            notify({
              level: code === 'WORKSPACE_CONFLICT' ? 'warning' : 'error',
              title: code === 'WORKSPACE_CONFLICT' ? '路由配置已刷新' : '路由保存失败',
              message: code === 'WORKSPACE_CONFLICT' ? '检测到连续并发修改，请重新选择需要的模型。' : '当前选择已回滚，请检查资源状态后重试。',
              code,
            });
            if (code !== 'WORKSPACE_CONFLICT') {
              try {
                const latest = await readLatest();
                if (latest.revision >= snapshot.revision) snapshot = latest;
              } catch { /* Keep the last known safe snapshot. */ }
            }
            renderWorkspace();
            break;
          }
        }
      }
    } finally {
      saveInProgress = false;
      if (refreshPending && !disposed) {
        refreshPending = false;
        await load().catch(() => undefined);
      }
    }
  };

  const saveAssignments = (
    assignments: readonly LlmTaskRoutingAssignment[],
    successMessage = '新的模型分配已经生效。',
  ): Promise<void> => {
    pendingSave = { assignments: assignments.map((assignment) => ({ ...assignment })), successMessage };
    saveQueue = saveQueue.then(runSaveQueue, runSaveQueue);
    return saveQueue;
  };

  const saveAssignment = async (taskKey: MemoryRoutingTaskKey, resourceId: string): Promise<void> => {
    if (resourceId.startsWith('unavailable:')) return;
    const current = new Map((pendingSave?.assignments ?? snapshot.assignments ?? []).map((assignment) => [assignment.taskKey, assignment]));
    current.set(taskKey, { taskKey, ...(resourceId ? { resourceId } : {}) });
    await saveAssignments(taskKeys.map((key) => current.get(key) ?? { taskKey: key }));
  };

  const verifyResource = async (resource: LlmSafeResourceSummary, taskKey: string, button: HTMLButtonElement): Promise<void> => {
    status.textContent = `正在验证 ${resource.label} 的 Agent 工具能力…`;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      await session.bus.request(LLM_RESOURCE_CAPABILITY_VERIFY_V0, {
        resourceId: resource.resourceId,
        taskKeys: [taskKey],
        force: true,
      });
      if (disposed) return;
      status.textContent = '工具能力验证完成。';
      notify({
        level: 'success',
        title: '工具能力验证完成',
        message: '能力快照已刷新，可继续检查 Agent 可用性。',
        code: 'LLM_TOOL_CAPABILITY_VERIFIED',
      });
      await load(true);
    } catch (error) {
      if (disposed) return;
      const code = safeReasonCode(error);
      status.textContent = `工具能力验证失败（${code}）。`;
      notify({
        level: 'error',
        title: '工具能力验证失败',
        message: '请检查生成资源和模型配置后重试。',
        code,
      });
      await load(true).catch(() => undefined);
    } finally {
      button.removeAttribute('aria-busy');
      button.disabled = false;
    }
  };

  const appendCapabilityRow = (
    list: HTMLElement,
    labelText: string,
    valueText: string,
    tone: 'success' | 'warning' | 'neutral',
  ): void => {
    const row = document.createElement('div');
    const label = document.createElement('dt');
    label.textContent = labelText;
    const value = document.createElement('dd');
    value.textContent = valueText;
    value.dataset.tone = tone;
    row.append(label, value);
    list.append(row);
  };

  const renderDetail = (): void => {
    detail.replaceChildren();
    const task = MEMORY_TASK_ROUTING_TASKS.find((candidate) => candidate.taskKey === selectedTaskKey)!;
    const assignment = (snapshot.assignments ?? []).find((item) => item.taskKey === task.taskKey);
    const resourcesById = new Map(snapshot.resources.map((resource) => [resource.resourceId, resource]));
    const resourceType = task.execution === 'embedding' ? 'embedding' : task.execution === 'rerank' ? 'rerank' : 'generation';
    const availableResources = snapshot.resources.filter((resource) => resource.type === resourceType && resource.enabled && resource.available);
    const availableIds = new Set(availableResources.map((resource) => resource.resourceId));
    const assignedResource = assignment?.resourceId ? resourcesById.get(assignment.resourceId) : undefined;
    const taskStatus = (snapshot.tasks ?? []).find((item) => item.taskKey === task.taskKey);
    const resolvedRoute = assignment?.resourceId === undefined ? taskStatus : undefined;
    const resolvedResource = resolvedRoute?.resourceId ? resourcesById.get(resolvedRoute.resourceId) : undefined;
    const activeResource = assignedResource ?? resolvedResource;
    const taskReady = taskStatus?.available === true
      && (task.execution !== 'tool_turn' || capabilityCurrent(activeResource));
    const unavailableAssignment = assignment?.resourceId !== undefined && !availableIds.has(assignment.resourceId);

    const heading = document.createElement('div');
    heading.className = 'ss-helper-memory-routing-heading';
    const headingIcon = document.createElement('span');
    headingIcon.append(ui.createIcon({ name: task.icon, decorative: true, fixedWidth: true }));
    const headingCopy = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = task.label;
    const description = document.createElement('p');
    description.textContent = task.description;
    headingCopy.append(title, description);
    heading.append(headingIcon, headingCopy);

    const resourceSection = document.createElement('section');
    resourceSection.className = 'ss-helper-memory-routing-resource';
    const resourceHeading = document.createElement('div');
    const resourceTitle = document.createElement('h4');
    resourceTitle.textContent = '生成资源';
    const resourceHint = document.createElement('p');
    resourceHint.textContent = task.execution === 'tool_turn' ? '选择生成资源；工具能力按当前模型独立验证。' : '选择匹配此执行链的资源；模型跟随资源默认模型。';
    resourceHeading.append(resourceTitle, resourceHint);
    const options = [
      { value: '', label: '自动选择（使用默认生成路由）' },
      ...(unavailableAssignment && assignment?.resourceId
        ? [{ value: `unavailable:${assignment.resourceId}`, label: `${assignedResource?.label ?? '原资源'} · 当前不可用，请重新选择` }]
        : []),
      ...availableResources.map((resource) => ({
        value: resource.resourceId,
        label: task.execution === 'tool_turn' ? resourceLabel(resource) : `${resource.label} · ${resource.defaultModel ?? '默认模型'}`,
      })),
    ];
    const selected = unavailableAssignment && assignment?.resourceId
        ? `unavailable:${assignment.resourceId}`
        : assignment?.resourceId ?? '';
    const select = ui.createSelect({
      label: `${task.label}使用的模型`,
      value: selected,
      options,
      onChange: (value) => { void saveAssignment(task.taskKey, value); },
    });
    resourceSection.append(resourceHeading, select);

    const routeMetrics = document.createElement('dl');
    routeMetrics.className = 'ss-helper-memory-routing-metrics';
    const metricValues = activeResource
      ? [
          ['Provider', activeResource.apiType],
          ['资源', `${activeResource.label}${assignedResource ? '' : '（自动）'}`],
          ['模型', resolvedRoute?.route?.model ?? activeResource.defaultModel ?? '默认模型'],
          ['链路', resolvedRoute?.route?.transport ?? task.execution],
        ]
      : [
          ['Provider', '自动解析'],
          ['资源', '默认生成路由'],
          ['模型', '资源默认模型'],
        ];
    for (const [labelText, valueText] of metricValues) {
      const item = document.createElement('div');
      const label = document.createElement('dt');
      label.textContent = labelText;
      const value = document.createElement('dd');
      value.textContent = valueText;
      item.append(label, value);
      routeMetrics.append(item);
    }

    const capabilitySection = document.createElement('section');
    capabilitySection.className = 'ss-helper-memory-routing-capabilities';
    const capabilityHeading = document.createElement('div');
    const capabilityCopy = document.createElement('div');
    const capabilityTitle = document.createElement('h4');
    capabilityTitle.textContent = task.execution === 'tool_turn' ? 'Agent 工具能力' : '场景能力';
    const capabilityHint = document.createElement('p');
    capabilityHint.textContent = assignedResource
      ? '基于当前资源与默认模型的能力快照。'
      : activeResource
        ? `自动路由当前解析为 ${activeResource.label}。`
        : '当前未解析到可用的默认生成资源。';
    capabilityCopy.append(capabilityTitle, capabilityHint);
    capabilityHeading.append(capabilityCopy);
    if (activeResource && !unavailableAssignment) {
      const verifyButton = ui.createButton({
        label: '重新验证',
        ariaLabel: `重新验证 ${activeResource.label} 的${task.execution === 'tool_turn' ? ' Agent 工具能力' : '场景能力'}`,
        icon: 'rotate',
        tone: 'neutral',
        size: 'sm',
      });
      verifyButton.classList.add('ss-helper-memory-routing-verify');
      verifyButton.addEventListener('click', () => { void verifyResource(activeResource, task.taskKey, verifyButton); });
      capabilityHeading.append(verifyButton);
    }
    const capabilityList = document.createElement('dl');
    const capability = activeResource?.toolCapabilities;
    if (task.execution === 'tool_turn') {
      const toolLabel = activeResource ? capabilityLabel(activeResource) : '默认路由不可用';
      appendCapabilityRow(capabilityList, '工具调用', toolLabel, capabilityCurrent(activeResource) ? 'success' : 'warning');
      appendCapabilityRow(capabilityList, '严格 Schema', strictSchemaLabel(capability?.strictToolSchema), capability?.strictToolSchema === 'native' ? 'success' : capability ? 'warning' : 'neutral');
      appendCapabilityRow(capabilityList, '流式工具', capabilityValue(capability?.streamingToolCalls), capability?.streamingToolCalls === 'incremental' ? 'success' : capability ? 'warning' : 'neutral');
    } else {
      appendCapabilityRow(capabilityList, '执行链', task.execution, taskReady ? 'success' : 'warning');
      appendCapabilityRow(capabilityList, '场景状态', taskReady ? '可用' : '不可用', taskReady ? 'success' : 'warning');
    }
    capabilitySection.append(capabilityHeading, capabilityList);

    const callout = document.createElement('aside');
    callout.className = 'ss-helper-memory-routing-callout';
    const calloutIcon = ui.createIcon({
      name: unavailableAssignment || (activeResource && !capabilityCurrent(activeResource)) ? 'triangle-exclamation' : 'circle-info',
      decorative: true,
      fixedWidth: true,
    });
    const calloutCopy = document.createElement('p');
    if (unavailableAssignment) {
      callout.dataset.tone = 'danger';
      calloutCopy.textContent = '当前绑定的生成资源已停用、不可用或不存在，请重新选择。';
    } else if (activeResource && !taskReady) {
      callout.dataset.tone = 'warning';
      calloutCopy.textContent = task.execution === 'tool_turn'
        ? `${assignedResource ? '此资源' : '默认路由当前解析的资源'}尚未通过基础工具调用验证；严格 Schema或流式能力不足不会阻止非严格/非流式 Agent。`
        : `${assignedResource ? '此资源' : '默认路由当前解析的资源'}尚未满足当前场景的执行能力。`;
    } else if (activeResource) {
      callout.dataset.tone = 'success';
      calloutCopy.textContent = assignedResource ? '当前资源已满足此场景执行能力。' : `自动选择当前解析为 ${activeResource.label}，已满足此场景执行能力。`;
    } else {
      callout.dataset.tone = 'warning';
      calloutCopy.textContent = '当前默认生成路由没有解析到可用资源，Agent 模式不可用。';
    }
    callout.append(calloutIcon, calloutCopy);
    detail.append(heading, resourceSection, routeMetrics, capabilitySection, callout);
    ui.refreshControls(detail);
  };

  const renderWorkspace = (focusTask = false): void => {
    nav.replaceChildren();
    const resourcesById = new Map(snapshot.resources.map((resource) => [resource.resourceId, resource]));
    let readyCount = 0;
    const agentTasks = MEMORY_TASK_ROUTING_TASKS.filter((task) => task.execution === 'tool_turn');
    for (const task of MEMORY_TASK_ROUTING_TASKS) {
      const assignment = (snapshot.assignments ?? []).find((item) => item.taskKey === task.taskKey);
      const assignedResource = assignment?.resourceId ? resourcesById.get(assignment.resourceId) : undefined;
      const taskStatus = (snapshot.tasks ?? []).find((item) => item.taskKey === task.taskKey);
      const resolvedRoute = assignment?.resourceId === undefined ? taskStatus : undefined;
      const resolvedResource = resolvedRoute?.resourceId ? resourcesById.get(resolvedRoute.resourceId) : undefined;
      const activeResource = assignedResource ?? resolvedResource;
      const availableIds = new Set(snapshot.resources
        .filter((resource) => resource.type === (task.execution === 'embedding' ? 'embedding' : task.execution === 'rerank' ? 'rerank' : 'generation') && resource.enabled && resource.available)
        .map((resource) => resource.resourceId));
      const unavailableAssignment = assignment?.resourceId !== undefined && !availableIds.has(assignment.resourceId);
      const ready = !unavailableAssignment
        && taskStatus?.available === true
        && (task.execution !== 'tool_turn' || capabilityCurrent(activeResource));
      if (ready && task.execution === 'tool_turn') readyCount += 1;
      const button = ui.createButton({
        label: task.label,
        ariaLabel: `配置${task.label}模型`,
        icon: task.icon,
        tone: 'neutral',
        size: 'lg',
      });
      button.classList.add('ss-helper-memory-routing-task');
      button.dataset.taskKey = task.taskKey;
      button.setAttribute('aria-current', task.taskKey === selectedTaskKey ? 'page' : 'false');
      const route = document.createElement('small');
      route.textContent = unavailableAssignment
          ? '资源不可用'
          : assignedResource?.label ?? (resolvedResource ? `${resolvedResource.label}（自动）` : '自动选择');
      const dot = document.createElement('i');
      dot.className = 'ss-helper-memory-routing-dot';
      dot.dataset.tone = ready ? 'success' : activeResource ? 'warning' : 'neutral';
      dot.setAttribute('aria-hidden', 'true');
      button.append(route, dot);
      button.addEventListener('click', () => {
        selectedTaskKey = task.taskKey;
        renderWorkspace(true);
      });
      nav.append(button);
    }
    readiness.textContent = `${readyCount} / ${agentTasks.length} 个 Agent 场景可用`;
    readiness.dataset.ssHelperTone = readyCount === agentTasks.length ? 'success' : 'warning';
    renderDetail();
    if (focusTask) selectedButton()?.focus();
  };

  resetButton.addEventListener('click', () => {
    void ui.confirm({
      title: '恢复自动选择？',
      message: '全部记忆场景的手动资源分配都会被清除，并立即跟随对应 execution 默认资源。',
      confirmLabel: '恢复自动选择',
    }).then((confirmed) => {
      if (!confirmed || disposed) return;
      void saveAssignments(
        MEMORY_TASK_ROUTING_TASKS.map((task) => ({ taskKey: task.taskKey })),
        '全部记忆场景已恢复为自动选择。',
      );
    });
  });

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribeCapabilityChange = (): void => undefined;
  try {
    unsubscribeCapabilityChange = session.bus.subscribe(LLM_TASK_STATUS_CHANGED_V0, () => {
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        if (saveInProgress) {
          refreshPending = true;
          return;
        }
        void load().then(() => {
          if (!disposed && !saveInProgress) status.textContent = '工具能力状态已刷新。';
        }).catch((error) => {
          if (!disposed) status.textContent = `工具能力状态刷新失败（${safeReasonCode(error)}）。`;
        });
      }, 80);
    });
  } catch { /* Capability events are optional while Core is starting. */ }
  renderWorkspace();
  return () => {
    disposed = true;
    if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    unsubscribeCapabilityChange();
    workspace.replaceChildren();
    workspace.remove();
  };
}

export function registerMemoryTaskRoutingPopup(session: PluginSession): () => void {
  return session.registerPopup({
    token: MEMORY_TASK_ROUTING_POPUP,
    title: '提取模型分配',
    ariaLabel: 'SS-Helper Memory 提取模型分配',
    closeLabel: '关闭提取模型分配',
    render: (container, _input, ui) => {
      let disposed = false;
      let cleanup: () => void = () => undefined;
      if (ui === undefined) {
        container.textContent = '加载失败（CORE_BRIDGE_UNAVAILABLE）。';
        return cleanup;
      }
      void renderMemoryTaskRoutingPopup(container, session, ui).then((nextCleanup) => {
        if (disposed) nextCleanup();
        else cleanup = nextCleanup;
      }).catch((error) => {
        if (disposed) return;
        const code = safeReasonCode(error, 'CORE_BRIDGE_UNAVAILABLE');
        container.textContent = `路由配置加载失败（${code}）。`;
        try {
          session.ui.showToast({
            level: 'error',
            title: '路由配置加载失败',
            message: '无法读取当前模型分配，请稍后重试。',
            code,
          });
        } catch { /* Core may be disposing. */ }
      });
      return () => {
        disposed = true;
        cleanup();
        container.replaceChildren();
      };
    },
  });
}
