import {
  LLM_CAPABILITY_STATUS_CHANGED_V0,
  LLM_CAPABILITY_STATUS_V0,
  LLM_TASK_ROUTING_GET_V0,
  type LlmCapabilityStatusResponse,
  type LlmTaskRoutingSnapshot,
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
  agentWriteMode?: 'shadow' | 'active';
};
export interface MemorySettingsNotice { readonly title: string; readonly message: string; readonly code: string; }
export interface MemorySettingsAssessment { readonly blocked?: MemorySettingsNotice; readonly warnings: readonly MemorySettingsNotice[]; }
type WorkspaceStatusReader = () => SettingsStatusSnapshot | Promise<SettingsStatusSnapshot>;

const LLM_RESOURCE_TARGET = Object.freeze({ pluginId: 'ss-helper.llm', tabId: 'resources', fieldId: 'resourceManager' });
const MEMORY_TASK_ROUTING_TARGET = Object.freeze({ pluginId: 'ss-helper.memory', tabId: 'routing', fieldId: 'taskRouting' });
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
      this.unsubscribeEvent = this.session.bus.subscribe(LLM_CAPABILITY_STATUS_CHANGED_V0, (payload) => {
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
    if (enablingAgent && !this.availability.agentRoutes) {
      return { blocked: { title: '无法启用 Agent 模式', message: '五个固定提取任务尚未全部绑定可用资源，请先在 Memory 的模型路由中完成配置。', code: 'MEMORY_AGENT_ROUTE_UNAVAILABLE' }, warnings: [] };
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

  isAgentAvailable(): boolean { return this.availability.agentRoutes && this.availability.agentToolsVerified; }

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
    let response: LlmCapabilityStatusResponse | undefined;
    let routing: LlmTaskRoutingSnapshot | undefined;
    try {
      [response, routing] = await Promise.all([
        readStatusWithDeadline(this.session.bus.request(LLM_CAPABILITY_STATUS_V0, {
        checks: [
          { id: 'generation', taskKey: 'memory_extract_single', taskKind: 'generation', requiredCapabilities: ['chat', 'json'] },
          { id: 'agent_single', taskKey: 'memory_extract_single', taskKind: 'generation', requiredCapabilities: ['chat', 'json'] },
          { id: 'agent_entities', taskKey: 'memory_extract_entities', taskKind: 'generation', requiredCapabilities: ['chat', 'json'] },
          { id: 'agent_narrative', taskKey: 'memory_extract_narrative', taskKind: 'generation', requiredCapabilities: ['chat', 'json'] },
          { id: 'agent_inventory', taskKey: 'memory_extract_inventory', taskKind: 'generation', requiredCapabilities: ['chat', 'json'] },
          { id: 'agent_repair', taskKey: 'memory_extract_repair', taskKind: 'generation', requiredCapabilities: ['chat', 'json'] },
          { id: 'embedding', taskKey: 'memory_embed', taskKind: 'embedding', requiredCapabilities: ['embeddings'] },
          { id: 'rerank', taskKey: 'memory_rerank', taskKind: 'rerank', requiredCapabilities: ['rerank'] },
        ],
        }, { timeoutMs: MEMORY_LLM_CAPABILITY_STATUS_TIMEOUT_MS })),
        readStatusWithDeadline(this.session.bus.request(LLM_TASK_ROUTING_GET_V0, {
          taskKeys: ['memory_extract_single', 'memory_extract_entities', 'memory_extract_narrative', 'memory_extract_inventory', 'memory_extract_repair', 'memory_embed', 'memory_rerank'],
        }, { timeoutMs: MEMORY_LLM_CAPABILITY_STATUS_TIMEOUT_MS })),
      ]);
    } catch {
      response = undefined;
      routing = undefined;
    }
    if (this.disposed || refreshGeneration !== this.refreshGeneration) return;
    if (response && response.revision < this.revision) return;
    if (response) this.revision = response.revision;
    const byId = new Map((response?.checks ?? []).map((entry) => [entry.id, entry]));
    const generation = byId.get('generation');
    const embedding = byId.get('embedding');
    const rerank = byId.get('rerank');
    const agentEntries = ['agent_single', 'agent_entities', 'agent_narrative', 'agent_inventory', 'agent_repair'].map(id => byId.get(id));
    const resourceById = new Map((routing?.resources ?? []).map(item => [item.resourceId, item]));
    const agentRoutes = agentEntries.every(entry => entry?.available === true);
    const agentToolsVerified = agentRoutes && agentEntries.every(entry => {
      const resourceId = entry?.resourceId;
      const resource = resourceId ? resourceById.get(resourceId) : undefined;
      const capability = resource?.toolCapabilities;
      return resource !== undefined
        && entry?.model !== undefined
        && entry.model === resource.defaultModel
        && capability?.model === resource.defaultModel
        && capability.status === 'verified'
        && (capability.expiresAt === undefined || capability.expiresAt > Date.now());
    });
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
    const resourceDescription = (entry: typeof generation): string | undefined => entry?.model
      ? `${entry.source === 'tavern' ? '酒馆模型' : '自定义资源'} · ${entry.model}`
      : entry?.source === 'tavern' ? '酒馆模型' : entry?.source === 'custom' ? '自定义资源' : undefined;
    next.generationStatus = generation?.available
      ? success('已连接', resourceDescription(generation))
      : action('不可用', 'error', reasonText[generation?.reason ?? 'status_unavailable'] ?? '无法满足整理任务。');
    const routeStatus = (entry: typeof generation): SettingsStatusSnapshot => {
      if (!entry?.available) return action('路由不可用', 'error', reasonText[entry?.reason ?? 'status_unavailable'] ?? '固定任务没有可用资源。');
      const resource = entry.resourceId ? resourceById.get(entry.resourceId) : undefined;
      const capability = resource?.toolCapabilities;
      if (settings.extractionMode === 'agent') {
        if (!resource || !entry.model || entry.model !== resource.defaultModel || capability?.model !== resource.defaultModel) return action('模型绑定不匹配', 'error', '当前路由使用了非默认模型覆盖，请在 Memory 的模型路由中重新选择已添加的生成资源。');
        if (capability?.expiresAt !== undefined && capability.expiresAt <= Date.now()) return action('验证已过期', 'error', '工具调用能力验证已过期，请重新验证。');
        if (capability?.status !== 'verified') return action('工具未验证', 'error', '当前模型尚未通过工具调用验证，不能用于 Agent 模式。');
        return success('工具调用已验证', `${resource.label} · ${resource.defaultModel ?? '默认模型'} · ${capability.dialect}`);
      }
      return success('路由可用', resourceDescription(entry));
    };
    next.agentRouteSingle = routeStatus(byId.get('agent_single'));
    next.agentRouteEntities = routeStatus(byId.get('agent_entities'));
    next.agentRouteNarrative = routeStatus(byId.get('agent_narrative'));
    next.agentRouteInventory = routeStatus(byId.get('agent_inventory'));
    next.agentRouteRepair = routeStatus(byId.get('agent_repair'));
    const referenceUsesEmbedding = settings.enabled
      && settings.preExtractReferenceEnabled === true
      && settings.preExtractReferenceMode !== 'lexical';
    if (embedding?.available) next.embeddingStatus = success('已连接', resourceDescription(embedding));
    else if (settings.recallMode === 'lexical' && !referenceUsesEmbedding) next.embeddingStatus = neutral('未配置', '当前使用关键词召回，不需要向量模型。');
    else if (settings.recallMode === 'lexical' && referenceUsesEmbedding) next.embeddingStatus = action('旧记忆参考降级为关键词', 'warning', `${reasonText[embedding?.reason ?? 'status_unavailable'] ?? '向量模型不可用'} 提取前参考旧记忆将使用关键词检索。`);
    else if (settings.recallMode === 'auto') next.embeddingStatus = action('降级为关键词', 'warning', `${reasonText[embedding?.reason ?? 'status_unavailable'] ?? '向量模型不可用'} 自动召回将使用关键词召回；如需向量召回，请先在 LLM 中配置。`);
    else next.embeddingStatus = action('不可用', 'error', `${reasonText[embedding?.reason ?? 'status_unavailable'] ?? '当前召回模式需要向量模型。'} 请先在 LLM 中配置。`);
    next.rerankStatus = rerank?.available
      ? success('已连接', resourceDescription(rerank))
      : settings.rerankMode === 'off'
        ? neutral('未配置', '当前未启用重排序，不需要重排序模型。')
        : settings.rerankMode === 'adaptive'
          ? action('降级为基础排序', 'warning', `${reasonText[rerank?.reason ?? 'status_unavailable'] ?? '重排序模型不可用'} 将保留基础排序结果；如需模型重排，请先在 LLM 中配置。`)
          : action('不可用', 'error', `${reasonText[rerank?.reason ?? 'status_unavailable'] ?? '当前重排策略需要重排序模型。'} 请先在 LLM 中配置。`);
    this.status = Object.freeze(next);
    this.listeners.forEach((listener) => {
      try { listener(this.status); } catch { /* Settings listeners are isolated from background refresh. */ }
    });
  }

  private scheduleRefresh(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, 80);
  }
}

export const MEMORY_LLM_RESOURCE_ACTION = Object.freeze({ buttonLabel: '管理资源', target: LLM_RESOURCE_TARGET, showWhen: ['warning', 'error'] as const });
export const MEMORY_TASK_ROUTING_ACTION = Object.freeze({ buttonLabel: '配置路由', target: MEMORY_TASK_ROUTING_TARGET, showWhen: ['warning', 'error'] as const });
