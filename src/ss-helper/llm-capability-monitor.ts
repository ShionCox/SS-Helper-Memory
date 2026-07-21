import {
  LLM_CAPABILITY_STATUS_CHANGED_V1,
  LLM_CAPABILITY_STATUS_V1,
  type LlmCapabilityStatusResponse,
  type PluginSession,
  type SettingsStatusSnapshot,
} from '@ss-helper/sdk';

export type MemoryCapabilityStatusMap = Readonly<Record<string, SettingsStatusSnapshot>>;
export type MemoryCapabilitySettings = {
  enabled: boolean;
  autoOrganize: boolean;
  recallMode: 'auto' | 'lexical' | 'vector' | 'hybrid';
  rerankMode: 'off' | 'adaptive' | 'always';
  /** Optional for backward-compatible capability probes from older callers. */
  preExtractReferenceEnabled?: boolean;
  preExtractReferenceMode?: 'auto' | 'lexical' | 'vector' | 'hybrid';
};
export interface MemorySettingsNotice { readonly title: string; readonly message: string; readonly code: string; }
export interface MemorySettingsAssessment { readonly blocked?: MemorySettingsNotice; readonly warnings: readonly MemorySettingsNotice[]; }
type WorkspaceStatusReader = () => SettingsStatusSnapshot | Promise<SettingsStatusSnapshot>;

const TARGET = Object.freeze({ pluginId: 'ss-helper.llm', tabId: 'resources', fieldId: 'resourceWizard' });
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
  private availability: Readonly<{ generation: boolean; embedding: boolean; rerank: boolean }> = Object.freeze({ generation: false, embedding: false, rerank: false });
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
      this.unsubscribeEvent = this.session.events.subscribe(LLM_CAPABILITY_STATUS_CHANGED_V1, (payload) => {
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
    try {
      response = await readStatusWithDeadline(this.session.services.call(LLM_CAPABILITY_STATUS_V1, {
        checks: [
          { id: 'generation', taskKey: 'memory_extract', taskKind: 'generation', requiredCapabilities: ['chat', 'json'] },
          { id: 'embedding', taskKey: 'memory_embed', taskKind: 'embedding', requiredCapabilities: ['embeddings'] },
          { id: 'rerank', taskKey: 'memory_rerank', taskKind: 'rerank', requiredCapabilities: ['rerank'] },
        ],
      }, { timeoutMs: MEMORY_LLM_CAPABILITY_STATUS_TIMEOUT_MS }));
    } catch {
      response = undefined;
    }
    if (this.disposed || refreshGeneration !== this.refreshGeneration) return;
    if (response && response.revision < this.revision) return;
    if (response) this.revision = response.revision;
    const byId = new Map((response?.checks ?? []).map((entry) => [entry.id, entry]));
    const generation = byId.get('generation');
    const embedding = byId.get('embedding');
    const rerank = byId.get('rerank');
    this.availability = Object.freeze({ generation: generation?.available === true, embedding: embedding?.available === true, rerank: rerank?.available === true });
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

export const MEMORY_LLM_RESOURCE_ACTION = Object.freeze({ buttonLabel: '前往配置', target: TARGET, showWhen: ['warning', 'error'] as const });
