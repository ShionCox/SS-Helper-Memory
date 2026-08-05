import {
  LLM_TASK_STATUS_CHANGED_V0,
  LLM_TASK_STATUS_V0,
  type LlmTaskStatusSnapshot,
  type PluginSession,
  type SettingsStatusSnapshot,
} from '@ss-helper/sdk';

export type MemoryCapabilityStatusMap = Readonly<Record<string, SettingsStatusSnapshot>>;
export type MemoryCapabilitySettings = {
  enabled: boolean;
  autoOrganize: boolean;
  recallMode: 'auto' | 'lexical' | 'vector' | 'hybrid';
  rerankMode: 'off' | 'adaptive' | 'always';
  preExtractReferenceEnabled: boolean;
  preExtractReferenceMode: 'auto' | 'lexical' | 'vector' | 'hybrid';
  extractionMode?: 'single' | 'agent';
  agentToolPolicy?: 'off' | 'read_only';
};
export interface MemorySettingsNotice { readonly title: string; readonly message: string; readonly code: string; }
export interface MemorySettingsAssessment { readonly blocked?: MemorySettingsNotice; readonly warnings: readonly MemorySettingsNotice[]; }
type WorkspaceStatusReader = () => SettingsStatusSnapshot | Promise<SettingsStatusSnapshot>;

const LLM_RESOURCE_TARGET = Object.freeze({ pluginId: 'ss-helper.llm', tabId: 'resources', fieldId: 'resourceManager' });
const MEMORY_TASK_ROUTING_TARGET = Object.freeze({ pluginId: 'ss-helper.memory', tabId: 'routing', fieldId: 'taskRouting' });
const MEMORY_LLM_TASK_KEYS = Object.freeze([
  'memory_extract_single',
  'memory_extract_entities',
  'memory_extract_content',
  'memory_extract_repair',
  'memory_cast_plan',
  'memory_recall_intent',
  'memory_embed',
  'memory_rerank',
] as const);
/**
 * LLM capability state is advisory for Memory.  A missing or wedged provider
 * must therefore degrade the status card instead of holding the whole Memory
 * activation chain open.
 */
export const MEMORY_LLM_CAPABILITY_STATUS_TIMEOUT_MS = 3_000;
const reasonText: Record<string, string> = {
  llm_disabled: 'LLM 已停用。',
  no_resource: '尚未配置匹配的资源。',
  resource_disabled: '匹配资源已停用。',
  credential_missing: '匹配资源缺少凭据。',
  route_unavailable: '当前路由不可用。',
  tavern_unavailable: '酒馆当前没有可用的模型。',
  status_unavailable: 'LLM 状态服务暂不可用。',
};

const neutral = (value: string, description?: string): SettingsStatusSnapshot => ({ value, tone: 'neutral', ...(description ? { description } : {}) });
const success = (value: string, description?: string): SettingsStatusSnapshot => ({ value, tone: 'success', ...(description ? { description } : {}) });
const action = (value: string, tone: 'warning' | 'error', description: string): SettingsStatusSnapshot => ({ value, tone, description });

function readStatusWithDeadline<T>(operation: Promise<T>, timeoutMs = MEMORY_LLM_CAPABILITY_STATUS_TIMEOUT_MS): Promise<T | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: T | undefined): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => finish(undefined), timeoutMs);
    void operation.then((value) => finish(value), () => finish(undefined));
  });
}

export class MemoryLlmCapabilityMonitor {
  private readonly listeners = new Set<(status: MemoryCapabilityStatusMap) => void>();
  private status: MemoryCapabilityStatusMap = Object.freeze({
    generationStatus: neutral('正在同步'),
    embeddingStatus: neutral('正在同步'),
    rerankStatus: neutral('正在同步'),
    workspaceStatus: neutral('正在同步'),
  });
  private revision = -1;
  private availability: Readonly<{ generation: boolean; embedding: boolean; rerank: boolean; agentRoutes: boolean; agentToolsVerified: boolean }> = Object.freeze({ generation: false, embedding: false, rerank: false, agentRoutes: false, agentToolsVerified: false });
  private timer: ReturnType<typeof setTimeout> | undefined;
  private syncRetryMs = 250;
  private disposed = false;
  private refreshGeneration = 0;
  private unsubscribeSettings: (() => void) | undefined;
  private unsubscribeEvent: (() => void) | undefined;
  private unsubscribeHostEvent: (() => void) | undefined;

  constructor(
    private readonly session: PluginSession,
    private readonly readSettings: () => MemoryCapabilitySettings,
    onSettingsChanged?: (listener: () => void) => () => void,
    private readonly readWorkspaceStatus?: WorkspaceStatusReader,
  ) {
    this.unsubscribeSettings = onSettingsChanged?.(() => { void this.refresh(); });
  }

  getStatus(): MemoryCapabilityStatusMap { return this.status; }
  loadStatus(): MemoryCapabilityStatusMap { return this.status; }
  subscribeStatus(listener: (status: MemoryCapabilityStatusMap) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    try {
      this.unsubscribeEvent = this.session.bus.subscribe(LLM_TASK_STATUS_CHANGED_V0, (payload) => {
        if (payload.revision <= this.revision) return;
        this.scheduleRefresh();
      });
    } catch { this.unsubscribeEvent = undefined; }
    try {
      this.unsubscribeHostEvent = this.session.host.events.subscribe('chat-changed', () => this.scheduleRefresh());
    } catch { this.unsubscribeHostEvent = undefined; }
    await this.refresh();
  }

  async refreshNow(): Promise<void> {
    await this.refresh();
  }

  async assess(next: MemoryCapabilitySettings, previous: MemoryCapabilitySettings): Promise<MemorySettingsAssessment> {
    await this.refresh();
    const activating = next.enabled && !previous.enabled;
    if (next.enabled && next.autoOrganize && (activating || !previous.autoOrganize) && !this.availability.generation) {
      return { blocked: { title: '无法启用自动整理', message: '当前没有可用的大语言模型资源，请先完成 LLM 配置。', code: 'MEMORY_GENERATION_UNAVAILABLE' }, warnings: [] };
    }
    const enablingAgent = next.enabled && next.extractionMode === 'agent'
      && (previous.extractionMode !== 'agent' || activating);
    if (next.enabled && next.extractionMode === 'agent' && next.agentToolPolicy !== 'read_only') {
      return { blocked: { title: '无法启用 Agent 模式', message: 'Agent 模式的基础工具调用是硬要求，请先将“只读工具”设为“按需使用”。', code: 'LLM_TOOL_CAPABILITY_UNVERIFIED' }, warnings: [] };
    }
    if (enablingAgent && !this.availability.agentRoutes) {
      return { blocked: { title: '无法启用 Agent 模式', message: '三个工具提取场景尚未全部绑定可用资源，请先在 Memory 的模型路由中完成配置。', code: 'MEMORY_AGENT_ROUTE_UNAVAILABLE' }, warnings: [] };
    }
    if (enablingAgent && !this.availability.agentToolsVerified) {
      return { blocked: { title: '无法启用 Agent 模式', message: '当前选择的一个或多个大语言模型不支持 Agent 模式或尚未通过工具调用验证。', code: 'LLM_TOOL_CAPABILITY_UNVERIFIED' }, warnings: [] };
    }
    if (next.enabled && (next.recallMode === 'vector' || next.recallMode === 'hybrid') && (activating || next.recallMode !== previous.recallMode) && !this.availability.embedding) {
      return { blocked: { title: '无法启用所选召回模式', message: '当前没有可用的向量模型，请先在 LLM 中配置向量资源。', code: 'MEMORY_EMBEDDING_UNAVAILABLE' }, warnings: [] };
    }
    if (next.enabled && next.rerankMode === 'always' && (activating || previous.rerankMode !== 'always') && !this.availability.rerank) {
      return { blocked: { title: '无法启用始终重排', message: '当前没有可用的重排序模型，请先在 LLM 中配置重排序资源。', code: 'MEMORY_RERANK_UNAVAILABLE' }, warnings: [] };
    }
    const warnings: MemorySettingsNotice[] = [];
    if (next.enabled && next.recallMode === 'auto' && (activating || next.recallMode !== previous.recallMode) && !this.availability.embedding) {
      warnings.push({ title: '召回已自动降级', message: '向量模型当前不可用，请先在 LLM 中配置；目前将使用关键词召回。', code: 'MEMORY_EMBEDDING_DEGRADED' });
    }
    if (next.enabled && next.rerankMode === 'adaptive' && (activating || next.rerankMode !== previous.rerankMode) && !this.availability.rerank) {
      warnings.push({ title: '重排已自动降级', message: '重排序模型当前不可用，请先在 LLM 中配置；目前将保留基础排序结果。', code: 'MEMORY_RERANK_DEGRADED' });
    }
    const referenceUsesEmbedding = next.enabled
      && next.preExtractReferenceEnabled === true
      && next.preExtractReferenceMode !== 'lexical';
    const referenceChanged = activating
      || next.preExtractReferenceEnabled !== previous.preExtractReferenceEnabled
      || next.preExtractReferenceMode !== previous.preExtractReferenceMode;
    if (referenceUsesEmbedding && referenceChanged && !this.availability.embedding) {
      warnings.push({
        title: '旧记忆参考已自动降级',
        message: '向量模型当前不可用；提取前参考旧记忆将使用关键词检索，或在无候选时直接继续整理。',
        code: 'MEMORY_PRE_EXTRACT_REFERENCE_DEGRADED',
      });
    }
    return { warnings };
  }

  isAgentAvailable(): boolean {
    return this.readSettings().agentToolPolicy === 'read_only'
      && this.availability.agentRoutes
      && this.availability.agentToolsVerified;
  }

  dispose(): void {
    this.disposed = true;
    this.refreshGeneration += 1;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.unsubscribeEvent?.();
    this.unsubscribeHostEvent?.();
    this.unsubscribeSettings?.();
    this.listeners.clear();
  }

  private async refresh(): Promise<void> {
    if (this.disposed) return;
    const refreshGeneration = ++this.refreshGeneration;
    const settings = this.readSettings();
    let response: LlmTaskStatusSnapshot | undefined;
    try {
      response = await readStatusWithDeadline(this.session.bus.request(LLM_TASK_STATUS_V0, { taskKeys: MEMORY_LLM_TASK_KEYS }, { timeoutMs: MEMORY_LLM_CAPABILITY_STATUS_TIMEOUT_MS }));
    } catch {
      response = undefined;
    }
    if (this.disposed || refreshGeneration !== this.refreshGeneration) return;
    if (response && response.revision < this.revision) return;
    const byKey = new Map((response?.tasks ?? []).map((entry) => [entry.taskKey, entry]));
    const complete = response !== undefined && MEMORY_LLM_TASK_KEYS.every((key) => byKey.has(key));
    if (!complete) {
      if (response && response.revision >= this.revision) this.revision = response.revision;
      const syncing = neutral('正在同步', '正在等待 LLM 消费者声明和完整任务状态。');
      this.availability = Object.freeze({ generation: false, embedding: false, rerank: false, agentRoutes: false, agentToolsVerified: false });
      this.status = Object.freeze({
        ...this.status,
        generationStatus: syncing,
        agentRouteSingle: syncing,
        agentRouteEntities: syncing,
        agentRouteContent: syncing,
        agentRouteRepair: syncing,
        agentRouteCastPlan: syncing,
        agentRouteRecallIntent: syncing,
        agentRouteEmbed: syncing,
        agentRouteRerank: syncing,
        embeddingStatus: syncing,
        rerankStatus: syncing,
      });
      this.listeners.forEach((listener) => {
        try { listener(this.status); } catch { /* Status listeners are isolated from background refresh. */ }
      });
      this.syncRetryMs = Math.min(5_000, this.syncRetryMs * 2);
      this.scheduleRefresh(this.syncRetryMs);
      return;
    }
    if (response === undefined) return;
    if (response.revision < this.revision) return;
    this.revision = response.revision;
    this.syncRetryMs = 250;
    const generation = byKey.get('memory_extract_single');
    const embedding = byKey.get('memory_embed');
    const rerank = byKey.get('memory_rerank');
    const agentEntries = ['memory_extract_entities', 'memory_extract_content'].map(key => byKey.get(key));
    const resourceById = new Map((response?.resources ?? []).map(item => [item.resourceId, item]));
    const reasonOf = (entry: typeof generation): string => entry?.failure?.reasonCode ?? 'status_unavailable';
    const routedModelOf = (entry: typeof generation): string | undefined => entry?.route?.model;
    const toolCapabilityState = (entry: typeof generation): 'ready' | 'resource_missing' | 'model_mismatch' | 'expired' | 'unverified' => {
      const resourceId = entry?.resourceId;
      const resource = resourceId ? resourceById.get(resourceId) : undefined;
      const capability = resource?.toolCapabilities;
      const routedModel = routedModelOf(entry);
      if (!resource) return 'resource_missing';
      if (!routedModel
        || (resource.defaultModel !== undefined && routedModel !== resource.defaultModel)
        || (capability?.model !== undefined && capability.model !== routedModel)) return 'model_mismatch';
      if (capability?.expiresAt !== undefined && capability.expiresAt <= Date.now()) return 'expired';
      return capability?.status === 'verified' ? 'ready' : 'unverified';
    };
    const agentRoutes = agentEntries.every(entry => entry?.available === true);
    const agentToolsVerified = agentRoutes && agentEntries.every(entry => toolCapabilityState(entry) === 'ready');
    this.availability = Object.freeze({ generation: generation?.available === true, embedding: embedding?.available === true, rerank: rerank?.available === true, agentRoutes, agentToolsVerified });
    const next: Record<string, SettingsStatusSnapshot> = {};
    try {
      next.workspaceStatus = this.readWorkspaceStatus
        ? await this.readWorkspaceStatus()
        : action('状态不可用', 'warning', '当前运行时没有提供工作区状态读取器。');
    } catch {
      next.workspaceStatus = neutral('暂不可用', '无法读取当前角色或群组状态。');
    }
    if (this.disposed || refreshGeneration !== this.refreshGeneration) return;
    const resourceDescription = (entry: typeof generation): string | undefined => routedModelOf(entry)
      ? `${entry?.route?.source === 'tavern' ? '酒馆模型' : '自定义资源'} · ${routedModelOf(entry)}` : undefined;
    next.generationStatus = generation?.available
      ? success('已连接', resourceDescription(generation))
      : action('不可用', 'error', reasonText[reasonOf(generation)] ?? '无法满足整理任务。');
    const toolTaskKeys = new Set(['memory_extract_entities', 'memory_extract_content']);
    const routeStatus = (taskKey: string, entry: typeof generation): SettingsStatusSnapshot => {
      if (!entry?.available) return action('路由不可用', 'error', reasonText[reasonOf(entry)] ?? '固定任务没有可用资源。');
      const resource = entry.resourceId ? resourceById.get(entry.resourceId) : undefined;
      const capability = resource?.toolCapabilities;
      if (toolTaskKeys.has(taskKey)) {
        const capabilityState = toolCapabilityState(entry);
        if (capabilityState === 'resource_missing' || capabilityState === 'model_mismatch') return action('模型绑定不匹配', 'error', '当前路由使用了非默认模型覆盖，请在 Memory 的模型路由中重新选择已添加的生成资源。');
        if (capabilityState === 'expired') return action('验证已过期', 'error', '工具调用能力验证已过期，请重新验证。');
        if (capabilityState !== 'ready' || !resource || !capability) return action('工具未验证', 'error', '当前模型尚未通过工具调用验证，不能用于 Agent 模式。');
        return success('工具调用已验证', `${resource.label} · ${routedModelOf(entry)} · ${capability.dialect}`);
      }
      return success('路由可用', resourceDescription(entry));
    };
    next.agentRouteSingle = routeStatus('memory_extract_single', byKey.get('memory_extract_single'));
    next.agentRouteEntities = routeStatus('memory_extract_entities', byKey.get('memory_extract_entities'));
    next.agentRouteContent = routeStatus('memory_extract_content', byKey.get('memory_extract_content'));
    next.agentRouteRepair = routeStatus('memory_extract_repair', byKey.get('memory_extract_repair'));
    next.agentRouteCastPlan = routeStatus('memory_cast_plan', byKey.get('memory_cast_plan'));
    next.agentRouteRecallIntent = routeStatus('memory_recall_intent', byKey.get('memory_recall_intent'));
    next.agentRouteEmbed = routeStatus('memory_embed', byKey.get('memory_embed'));
    next.agentRouteRerank = routeStatus('memory_rerank', byKey.get('memory_rerank'));
    const referenceUsesEmbedding = settings.enabled
      && settings.preExtractReferenceEnabled === true
      && settings.preExtractReferenceMode !== 'lexical';
    if (embedding?.available) next.embeddingStatus = success('已连接', resourceDescription(embedding));
    else if (settings.recallMode === 'lexical' && !referenceUsesEmbedding) next.embeddingStatus = neutral('未配置', '当前使用关键词召回，不需要向量模型。');
    else if (settings.recallMode === 'lexical' && referenceUsesEmbedding) next.embeddingStatus = action('旧记忆参考降级为关键词', 'warning', `${reasonText[reasonOf(embedding)] ?? '向量模型不可用'} 提取前参考旧记忆将使用关键词检索。`);
    else if (settings.recallMode === 'auto') next.embeddingStatus = action('降级为关键词', 'warning', `${reasonText[reasonOf(embedding)] ?? '向量模型不可用'} 自动召回将使用关键词召回；如需向量召回，请先在 LLM 中配置。`);
    else next.embeddingStatus = action('不可用', 'error', `${reasonText[reasonOf(embedding)] ?? '当前召回模式需要向量模型。'} 请先在 LLM 中配置。`);
    next.rerankStatus = rerank?.available
      ? success('已连接', resourceDescription(rerank))
      : settings.rerankMode === 'off'
        ? neutral('未配置', '当前未启用重排序，不需要重排序模型。')
        : settings.rerankMode === 'adaptive'
          ? action('降级为基础排序', 'warning', `${reasonText[reasonOf(rerank)] ?? '重排序模型不可用'} 将保留基础排序结果；如需模型重排，请先在 LLM 中配置。`)
          : action('不可用', 'error', `${reasonText[reasonOf(rerank)] ?? '当前重排策略需要重排序模型。'} 请先在 LLM 中配置。`);
    this.status = Object.freeze(next);
    this.listeners.forEach((listener) => {
      try { listener(this.status); } catch { /* Settings listeners are isolated from background refresh. */ }
    });
  }

  private scheduleRefresh(delayMs = 80): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, delayMs);
  }
}

export const MEMORY_LLM_RESOURCE_ACTION = Object.freeze({ buttonLabel: '管理资源', target: LLM_RESOURCE_TARGET, showWhen: ['warning', 'error'] as const });
export const MEMORY_TASK_ROUTING_ACTION = Object.freeze({ buttonLabel: '配置路由', target: MEMORY_TASK_ROUTING_TARGET, showWhen: ['warning', 'error'] as const });
