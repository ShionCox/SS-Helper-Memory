import { MemoryRepository } from '../infrastructure';
import { deriveMemoryGraphProjection } from '../domain';
import type {
  FactListOptions,
  MainChatUsage,
  ManualFactInput,
  MemoryFact,
  MemoryGraphPreview,
  MemoryGraphStatus,
  MemoryJob,
  MemoryRecallLog,
} from '../domain';
import {
  MemoryRecallIndex,
  MemoryVectorIndexService,
  SemanticRecallService,
  recallLimits,
  type RecallQuery,
  type RecallResult,
} from './recall';
import { MemoryGraphRecallIndex, MemoryGraphService } from './graph';
import {
  LlmMemoryExtractor,
  readMemoryLlmApi,
  readMemoryLlmRouteDiagnostic,
  readMemoryRecallRouteDiagnostics,
  type MemoryLlmRouteDiagnostic,
} from './ingest/llm-extractor';
import { MemoryIngestService } from './ingest/memory-ingest-service';
import { ExistingMemoryContextRetriever } from './ingest/existing-memory-context';
import {
  applyInitializationConflictResolutions,
  reduceInitializationBatches,
  snapshotsFromSources,
} from './ingest/initialization-finalizer';
import { resolveInitializationConflicts } from './ingest/initialization-conflict-resolver';
import { filterSourceBlocks } from './ingest/source-blocks';
import {
  buildSummaryBatches,
  DEFAULT_SUMMARY_STRATEGY,
  estimateSummaryInitialization,
  getSummaryWaitingFloors,
  normalizeSummaryStrategy,
  selectAutomaticSummaryWindow,
  visibleConversationMessages,
  type SummaryProgress,
} from './ingest/summary-strategy';
import type { SourceBlock } from './ingest/types';
import { collectCurrentChatSources, selectSourceGroups, summarizeSourceGroups } from '../host/source-adapter';
import type { MemoryPluginApi, MemorySqliteStatus } from '../index';
import type {
  MemoryCaptureProgress,
  MemoryInitializationEstimate,
  MemoryInitializationOptions,
  MemoryInitializationState,
  MemoryInitializationSourceOption,
  MemoryUiController,
  MemoryUiFact,
  MemoryUiOverview,
  MemoryUiSettings,
} from '../ui/memory-ui';
import type { MemoryHostContext } from '../host/sdk-host-context';
import { traceMemoryStartup } from '../host/runtime-feedback';
import { describeMemoryError, type MemoryErrorDiagnostic } from '../diagnostics/memory-error';

type MemoryGlobalSettings = Omit<MemoryUiSettings, 'chatMode'>;

const DEFAULT_SETTINGS: Readonly<MemoryGlobalSettings> = Object.freeze({
  enabled: true,
  autoOrganize: true,
  summaryBatchMode: DEFAULT_SUMMARY_STRATEGY.batchMode,
  summaryBatchFloors: DEFAULT_SUMMARY_STRATEGY.batchFloors,
  summaryBatchChars: DEFAULT_SUMMARY_STRATEGY.batchChars,
  summaryIntervalFloors: DEFAULT_SUMMARY_STRATEGY.triggerIntervalFloors,
  summaryOverlapFloors: DEFAULT_SUMMARY_STRATEGY.overlapFloors,
  maxRecallItems: recallLimits.default,
  promptMaxChars: 8_000,
  answerMode: 'auto',
  recallMode: 'auto',
  rerankMode: 'adaptive',
  preExtractReferenceEnabled: true,
  preExtractReferenceItems: 8,
  preExtractReferenceMode: 'auto',
  preExtractReferenceMaxChars: 2_400,
  graphEnabled: true,
  graphLlmRelationEnabled: true,
  graphMaxHops: 1,
  graphMaxEdges: 12,
});
const MAX_MEMORY_BACKUP_BYTES = 64 * 1024 * 1024;

function createId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function asUiFact(
  fact: MemoryFact,
  evidence: Array<{ sourceRef: string; excerpt: string }>,
  auditBatches: NonNullable<MemoryUiFact['auditBatches']>,
): MemoryUiFact {
  return {
    id: fact.id,
    content: fact.content,
    kind: fact.kind,
    status: fact.status,
    confidence: fact.confidence,
    sourceRefs: [...fact.sourceRefs],
    evidence,
    ...(fact.supersedesId ? { supersedesId: fact.supersedesId } : {}),
    ...(fact.supersededById ? { supersededById: fact.supersededById } : {}),
    ...(auditBatches.length > 0 ? { auditBatches } : {}),
    updatedAt: fact.updatedAt,
  };
}

function clampMaxItems(value: number): number {
  return Math.min(recallLimits.max, Math.max(recallLimits.min, Math.trunc(value || recallLimits.default)));
}

function clampPromptMaxChars(value: number): number {
  return Math.min(16_000, Math.max(2_000, Math.trunc(value || DEFAULT_SETTINGS.promptMaxChars)));
}

function clampPreExtractReferenceItems(value: number): number {
  const candidate = Number.isFinite(value) ? value : DEFAULT_SETTINGS.preExtractReferenceItems;
  return Math.min(10, Math.max(1, Math.trunc(candidate)));
}

function clampPreExtractReferenceMaxChars(value: number): number {
  const candidate = Number.isFinite(value) ? value : DEFAULT_SETTINGS.preExtractReferenceMaxChars;
  return Math.min(4_000, Math.max(500, Math.round(candidate / 100) * 100));
}

function clampGraphMaxHops(value: number): 1 | 2 {
  return value === 2 ? 2 : 1;
}

function clampGraphMaxEdges(value: number): number {
  const candidate = Number.isFinite(value) ? value : DEFAULT_SETTINGS.graphMaxEdges;
  return Math.min(24, Math.max(4, Math.trunc(candidate)));
}

function usesVectorIndex(settings: MemoryGlobalSettings): boolean {
  return settings.recallMode !== 'lexical'
    || (settings.enabled
      && settings.preExtractReferenceEnabled
      && settings.preExtractReferenceMode !== 'lexical');
}

function summaryStrategyFromSettings(settings: MemoryGlobalSettings) {
  return normalizeSummaryStrategy({
    batchMode: settings.summaryBatchMode,
    batchFloors: settings.summaryBatchFloors,
    batchChars: settings.summaryBatchChars,
    triggerIntervalFloors: settings.summaryIntervalFloors,
    overlapFloors: settings.summaryOverlapFloors,
  });
}

class CaptureCancelledError extends Error {
  constructor() { super('记忆整理已因停止或聊天切换而取消。'); }
}

function isRetryableInitializationError(error: unknown): boolean {
  const code = String(
    error && typeof error === 'object'
      ? ((error as { details?: { reasonCode?: unknown }; code?: unknown }).details?.reasonCode
        ?? (error as { code?: unknown }).code
        ?? '')
      : '',
  ).toLocaleLowerCase();
  return !['auth_failed', 'credential_missing', 'llm_disabled', 'no_resource', 'resource_disabled', 'route_unavailable', '401', '403'].some((value) => code.includes(value));
}

/** Memory 唯一应用服务，SQLite 是唯一持久数据源。 */
export class MemoryApplication implements MemoryPluginApi, MemoryUiController {
  readonly facts: MemoryPluginApi['facts'];
  readonly capture: MemoryPluginApi['capture'];
  readonly recall: MemoryPluginApi['recall'];
  readonly graph: MemoryPluginApi['graph'];
  readonly backup: MemoryPluginApi['backup'];
  readonly diagnostics: MemoryPluginApi['diagnostics'];

  private settings: MemoryGlobalSettings = { ...DEFAULT_SETTINGS };
  private chatOverrides: Record<string, boolean> = {};
  private readonly recallIndex = new MemoryRecallIndex();
  private readonly vectorIndex: MemoryVectorIndexService;
  private readonly graphService: MemoryGraphService;
  private readonly semanticRecall: SemanticRecallService;
  private summaryProgressByChat: Record<string, SummaryProgress> = {};
  private readonly summaryWaitingByChat = new Map<string, number>();
  private lastRecall: RecallResult | null = null;
  private lastRecallLogId: string | null = null;
  private lastOrganizedAt: number | null = null;
  private status: MemoryUiOverview['status'] = 'ready';
  private error = '';
  private errorDiagnostic: MemoryErrorDiagnostic | undefined;
  private capturePromise: Promise<void> | null = null;
  private captureVersion = 0;
  private bindVersion = 0;
  private stopped = false;
  private boundChatKey = '';
  private boundScopeKey = '';
  private captureStartedAt = 0;
  private activeCaptureProgress: MemoryCaptureProgress | null = null;
  private cancelRequested = false;
  private sqliteAvailable = false;
  private hostContext: MemoryHostContext | null = null;
  private llmRouteDiagnostic: MemoryLlmRouteDiagnostic | undefined;
  private llmRouteDiagnosticPending: Promise<void> | undefined;

  private readonly settingsListeners = new Set<(settings: MemoryUiSettings) => void>();

  constructor(readonly repository: MemoryRepository) {
    this.vectorIndex = new MemoryVectorIndexService(repository);
    this.graphService = new MemoryGraphService(repository);
    this.graphService.onStatusChanged((status) => {
      if (!this.stopped && status.chatKey === this.getChatKey()) this.emitSettingsChanged();
    });
    this.semanticRecall = new SemanticRecallService(this.recallIndex, this.vectorIndex, this.graphService);
    this.facts = {
      list: (options) => this.repository.listFacts(this.requireChatKey(), options),
      search: (query, options) => this.repository.searchFacts(this.requireChatKey(), query, options?.limit),
      upsert: async (input) => {
        const fact = await this.repository.upsertManualFact(this.requireChatKey(), input);
        this.recallIndex.upsert(fact);
        this.vectorIndex.scheduleSync(fact.chatKey);
        this.scheduleGraph(fact.chatKey);
        return fact;
      },
      remove: async (id) => {
        await this.repository.removeFact(this.requireChatKey(), id);
        this.recallIndex.remove(id);
        this.scheduleGraph(this.requireChatKey());
      },
    };
    this.capture = { flush: () => this.flushCapture('incremental') };
    this.recall = { preview: (input) => this.previewRecall(input) };
    this.graph = {
      preview: async (input) => {
        const currentChatKey = this.getChatKey();
        if (!currentChatKey || input.chatKey !== currentChatKey) return { nodes: [], edges: [] };
        return this.graphService.preview(input.chatKey, input.query, input.limit, this.getEffectiveSettings().graphEnabled);
      },
      getStatus: () => this.getGraphStatus(),
      rebuild: () => this.rebuildGraph(),
    };
    this.backup = {
      export: () => this.exportSqliteBackup(),
      import: (file) => this.importSqliteBackup(file),
      checkIntegrity: () => this.checkSqliteIntegrity(),
    };
    this.diagnostics = { getLastRecall: () => this.getLastRecall() };
  }

  useHostContext(context: MemoryHostContext): void {
    this.hostContext = context;
  }

  bindStorageScope(workspaceId: string, sourceChatKey: string): void { this.repository.bind?.(workspaceId, sourceChatKey); }

  private currentLlmRouteDiagnostic(): MemoryLlmRouteDiagnostic {
    if (this.llmRouteDiagnosticPending === undefined) {
      const pending = readMemoryLlmRouteDiagnostic()
        .then((diagnostic) => { this.llmRouteDiagnostic = diagnostic; })
        .catch(() => { this.llmRouteDiagnostic = { available: false, blockedReason: '暂时无法读取 LLM 资源状态' }; })
        .finally(() => {
          if (this.llmRouteDiagnosticPending === pending) this.llmRouteDiagnosticPending = undefined;
          if (!this.stopped) this.emitSettingsChanged();
        });
      this.llmRouteDiagnosticPending = pending;
    }
    return this.llmRouteDiagnostic ?? { available: readMemoryLlmApi() !== null, blockedReason: 'LLM 路由状态正在加载' };
  }

  async start(): Promise<void> {
    this.stopped = false;
    try {
      await this.repository.open();
      this.sqliteAvailable = true;
      this.vectorIndex.start();
      await this.loadSettings();
      await this.bindCurrentChat();
    } catch (error) {
      this.sqliteAvailable = false;
      this.vectorIndex.stop();
      this.recallIndex.replace([]);
      this.setRuntimeError(error, 'SQLITE_SERVICE_UNAVAILABLE', 'startup');
      return;
    }
    void this.resumePausedWork().catch(() => undefined);
  }

  stop(): void {
    this.stopped = true;
    this.captureVersion += 1;
    this.bindVersion += 1;
    this.recallIndex.replace([]);
    this.vectorIndex.stop();
    this.repository.close();
    this.sqliteAvailable = false;
  }

  getChatKey(): string {
    return this.hostContext?.getChatKey() ?? '';
  }

  /**
   * Startup already probes and opens the workspace.  The host runtime uses
   * this snapshot to avoid a second health request during SillyTavern's own
   * APP_READY turn; detailed counters are refreshed only when a UI asks for
   * them later.
   */
  isSqliteAvailable(): boolean { return this.sqliteAvailable; }

  private getCurrentScopeKey(): string {
    const workspaceId = this.hostContext?.getWorkspaceId() ?? '';
    const chatKey = this.getChatKey();
    return workspaceId && chatKey ? JSON.stringify([workspaceId, chatKey]) : '';
  }

  isChatEnabled(workspaceId: string, chatKey: string): boolean {
    const normalizedWorkspaceId = workspaceId.trim();
    const normalizedChatKey = chatKey.trim();
    if (!normalizedWorkspaceId || !normalizedChatKey) return false;
    const override = this.chatOverrides[JSON.stringify([normalizedWorkspaceId, normalizedChatKey])];
    return override ?? this.settings.enabled;
  }

  getCurrentChatInfo(): { available: boolean; name: string; key: string; mode: MemoryUiSettings['chatMode']; effectiveEnabled: boolean } {
    const key = this.getChatKey();
    const scopeKey = this.getCurrentScopeKey();
    const override = scopeKey ? this.chatOverrides[scopeKey] : undefined;
    const mode: MemoryUiSettings['chatMode'] = override === true ? 'enabled' : override === false ? 'disabled' : 'inherit';
    return {
      available: Boolean(scopeKey),
      name: this.hostContext?.getChatName?.() || key,
      key,
      mode,
      effectiveEnabled: Boolean(scopeKey) && this.isChatEnabled(this.hostContext?.getWorkspaceId() ?? '', key),
    };
  }

  getSummaryProgressInfo(): import('../ss-helper/settings').MemorySummaryProgressInfo {
    const chat = this.getCurrentChatInfo();
    if (!chat.available) return { available: false, initialized: false };
    const progress = this.summaryProgressByChat[chat.key];
    if (!progress) return { available: true, initialized: false };
    const strategy = summaryStrategyFromSettings(this.settings);
    const nextStart = progress.completedFloor + 1;
    const nextEnd = progress.completedFloor + strategy.triggerIntervalFloors;
    return {
      available: true,
      initialized: true,
      completedFloor: progress.completedFloor,
      nextWindow: `下一窗口：第 ${nextStart}–${nextEnd} 层`,
      waitingFloors: this.summaryWaitingByChat.get(chat.key),
    };
  }

  listChatKeys(): Promise<string[]> {
    if (!this.sqliteAvailable) return Promise.resolve([]);
    return this.repository.getChatKeys();
  }

  async bindCurrentChat(): Promise<void> {
    const chatKey = this.getChatKey();
    const workspaceId = this.hostContext?.getWorkspaceId() ?? '';
    const scopeKey = workspaceId && chatKey ? JSON.stringify([workspaceId, chatKey]) : '';
    const bindVersion = ++this.bindVersion;
    const isCurrent = (): boolean => !this.stopped
      && this.bindVersion === bindVersion
      && this.getChatKey() === chatKey
      && (this.hostContext?.getWorkspaceId() ?? '') === workspaceId;
    this.repository.bind?.(workspaceId, chatKey);
    if (this.boundScopeKey !== scopeKey) this.captureVersion += 1;
    this.boundScopeKey = scopeKey;
    this.boundChatKey = '';
    this.settingsListeners.forEach((listener) => listener(this.getSettings()));
    if (!workspaceId) {
      this.recallIndex.replace([]);
      this.lastRecall = null;
      this.lastRecallLogId = null;
      this.clearRuntimeError();
      return;
    }
    if (!this.sqliteAvailable) {
      try {
        // A previous transient server/startup failure must not permanently
        // poison later chat switches. Reopen against the latest bound scope.
        await this.repository.open();
        if (!isCurrent()) return;
        this.sqliteAvailable = true;
        this.vectorIndex.start();
        await this.loadSettings();
        if (!isCurrent()) return;
      } catch (error) {
        if (!isCurrent()) return;
        this.recallIndex.replace([]);
        this.vectorIndex.stop();
        this.setRuntimeError(error, 'SQLITE_SERVICE_UNAVAILABLE', 'chat-bind');
        return;
      }
    }
    try {
      const bootstrap = chatKey ? await this.repository.bootstrap(chatKey) : null;
      if (!isCurrent()) return;
      this.recallIndex.replace(bootstrap?.facts ?? []);
      this.boundChatKey = chatKey;
      this.clearRuntimeError();
    } catch (error) {
      if (!isCurrent()) return;
      this.recallIndex.replace([]);
      // A character/group workspace error is not automatically a global
      // SQLite outage. Keeping the service available lets “重新检查” repair it.
      this.setRuntimeError(error, 'MEMORY_CHAT_BIND_FAILED', 'chat-bind');
      return;
    }
    const effective = this.getEffectiveSettings();
    if (!effective.enabled) this.status = 'disabled';
    else if (this.status === 'disabled' || this.status === 'unselected') this.status = 'ready';
    if (effective.enabled && chatKey && usesVectorIndex(effective)) this.vectorIndex.scheduleSync(chatKey);
    if (effective.enabled && chatKey) this.scheduleGraph(chatKey);
    this.lastRecall = null;
    this.lastRecallLogId = null;
    if (chatKey) {
      void this.ensureSummaryProgress(chatKey).then(() => this.emitSettingsChanged()).catch(() => undefined);
    }
  }

  getSettings(): MemoryUiSettings {
    return { ...this.settings, chatMode: this.getCurrentChatInfo().mode };
  }

  getEffectiveSettings(settings: MemoryUiSettings = this.getSettings()): MemoryGlobalSettings {
    const available = this.getCurrentChatInfo().available;
    const enabled = available && (settings.chatMode === 'enabled' || (settings.chatMode === 'inherit' && settings.enabled));
    const { chatMode: _chatMode, ...global } = settings;
    return { ...global, enabled };
  }

  async saveSettings(settings: MemoryUiSettings): Promise<void> {
    if (!this.sqliteAvailable) throw new Error('Memory workspace 不可用，设置未保存。');
    const nextSettings: MemoryGlobalSettings = {
      enabled: settings.enabled === true,
      autoOrganize: settings.autoOrganize === true,
      summaryBatchMode: settings.summaryBatchMode === 'chars' ? 'chars' : 'floors',
      summaryBatchFloors: Math.min(20, Math.max(1, Math.trunc(settings.summaryBatchFloors))),
      summaryBatchChars: Math.min(16_000, Math.max(2_000, Math.round(settings.summaryBatchChars / 500) * 500)),
      summaryIntervalFloors: Math.min(50, Math.max(1, Math.trunc(settings.summaryIntervalFloors))),
      summaryOverlapFloors: Math.min(10, Math.max(0, Math.trunc(settings.summaryOverlapFloors))),
      maxRecallItems: clampMaxItems(settings.maxRecallItems),
      promptMaxChars: clampPromptMaxChars(settings.promptMaxChars),
      answerMode: settings.answerMode === 'diagnostic' || settings.answerMode === 'roleplay' ? settings.answerMode : 'auto',
      recallMode: settings.recallMode === 'lexical' || settings.recallMode === 'vector' || settings.recallMode === 'hybrid'
        ? settings.recallMode
        : 'auto',
      rerankMode: settings.rerankMode === 'off' || settings.rerankMode === 'always' ? settings.rerankMode : 'adaptive',
      preExtractReferenceEnabled: settings.preExtractReferenceEnabled === true,
      preExtractReferenceItems: clampPreExtractReferenceItems(settings.preExtractReferenceItems),
      preExtractReferenceMode: settings.preExtractReferenceMode === 'lexical' || settings.preExtractReferenceMode === 'vector' || settings.preExtractReferenceMode === 'hybrid'
        ? settings.preExtractReferenceMode
        : 'auto',
      preExtractReferenceMaxChars: clampPreExtractReferenceMaxChars(settings.preExtractReferenceMaxChars),
      graphEnabled: settings.graphEnabled === true,
      graphLlmRelationEnabled: settings.graphLlmRelationEnabled === true,
      graphMaxHops: clampGraphMaxHops(settings.graphMaxHops),
      graphMaxEdges: clampGraphMaxEdges(settings.graphMaxEdges),
    };
    const scopeKey = this.getCurrentScopeKey();
    const nextOverrides = { ...this.chatOverrides };
    if (settings.chatMode !== 'inherit' && !scopeKey) throw new Error('请先进入角色或群组聊天，再修改当前聊天设置。');
    if (scopeKey) {
      if (settings.chatMode === 'inherit') delete nextOverrides[scopeKey];
      else nextOverrides[scopeKey] = settings.chatMode === 'enabled';
    }
    await this.repository.setSettings({ ...nextSettings, chatOverrides: nextOverrides });
    this.settings = nextSettings;
    this.chatOverrides = nextOverrides;
    this.emitSettingsChanged();
    const effective = this.getEffectiveSettings();
    if (!effective.enabled) this.status = 'disabled';
    else if (this.status === 'disabled') this.status = 'ready';
    if (effective.enabled && usesVectorIndex(effective)) this.vectorIndex.scheduleSync(this.getChatKey());
    if (effective.enabled) this.scheduleGraph(this.getChatKey());
  }

  async resetSettings(): Promise<void> {
    if (!this.sqliteAvailable) throw new Error('Memory workspace 不可用，设置未恢复。');
    await this.repository.setSettings({ ...DEFAULT_SETTINGS, chatOverrides: {}, summaryProgressByChat: {} });
    this.settings = { ...DEFAULT_SETTINGS };
    this.chatOverrides = {};
    this.summaryProgressByChat = {};
    this.emitSettingsChanged();
    const effective = this.getEffectiveSettings();
    this.status = effective.enabled ? 'ready' : 'disabled';
    if (effective.enabled && usesVectorIndex(effective)) this.vectorIndex.scheduleSync(this.getChatKey());
    if (effective.enabled) this.scheduleGraph(this.getChatKey());
  }

  async getRecallStatus(): Promise<import('../ui/memory-ui').MemoryRecallStatus> {
    const chatKey = this.getChatKey();
    const [vector, routes] = await Promise.all([
      chatKey ? this.vectorIndex.getStatus(chatKey) : Promise.resolve(null),
      readMemoryRecallRouteDiagnostics(),
    ]);
    const coverage = vector?.coverage;
    return {
      resolvedMode: this.lastRecall?.diagnostics.resolvedMode ?? 'lexical',
      embedding: routes.embedding,
      rerank: routes.rerank,
      indexedFacts: coverage?.ready ?? 0,
      eligibleFacts: coverage?.totalFacts ?? 0,
      pendingFacts: vector?.pendingFacts ?? 0,
      rebuilding: vector?.rebuilding ?? false,
      ...(this.lastRecall?.diagnostics.degradedReason ? { degradedReason: this.lastRecall.diagnostics.degradedReason } : {}),
      ...(vector?.lastError ? { lastError: vector.lastError } : {}),
      batches: vector?.batches ?? [],
    };
  }

  async rebuildVectorIndex(): Promise<void> {
    await this.vectorIndex.rebuild(this.requireChatKey());
  }

  getGraphStatus(): MemoryGraphStatus {
    const chatKey = this.getChatKey();
    return this.graphService.getStatus(chatKey, Boolean(chatKey) && this.getEffectiveSettings().enabled && this.getEffectiveSettings().graphEnabled);
  }

  async getRelationshipGraph(query = '', limit?: number): Promise<MemoryGraphPreview> {
    const chatKey = this.requireChatKey();
    return this.graphService.preview(chatKey, query, limit, this.getEffectiveSettings().enabled && this.getEffectiveSettings().graphEnabled);
  }

  async rebuildGraph(): Promise<void> {
    const chatKey = this.requireChatKey();
    const enabled = this.getEffectiveSettings().enabled && this.getEffectiveSettings().graphEnabled;
    if (!enabled) return;
    await this.graphService.rebuild(chatKey, true);
    this.emitSettingsChanged();
  }

  async initialize(selectedKinds?: string[], options?: MemoryInitializationOptions): Promise<void> {
    await this.flushCapture('initialize', undefined, selectedKinds, options);
  }

  async reinitialize(selectedKinds?: string[], options?: MemoryInitializationOptions): Promise<void> {
    await this.cancelCapture();
    await this.clearCurrentChatData();
    await this.initialize(selectedKinds, options);
  }

  async retry(): Promise<void> {
    this.clearRuntimeError();
    const paused = (await this.repository.listJobs(this.requireChatKey()))
      .filter((job) => job.status === 'paused')
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    await this.flushCapture(paused?.type ?? 'incremental', paused);
  }

  async getOverview(): Promise<MemoryUiOverview> {
    traceMemoryStartup('application:overview-begin');
    const chatKey = this.getChatKey();
    const storage = this.repository.getHealthSnapshot();
    const currentChatSizeBytes = storage?.currentChatSizeBytes ?? 0;
    const currentChatUsageRatio = storage?.workspaceSizeBytes
      ? currentChatSizeBytes / storage.workspaceSizeBytes
      : 0;
    const degraded = (message = this.error): MemoryUiOverview => {
      const diagnostic = this.errorDiagnostic ?? describeMemoryError(message, 'SQLITE_SERVICE_UNAVAILABLE', 'health');
      const currentChat = this.getCurrentChatInfo();
      return ({
      status: 'error',
      bound: false,
      ...(chatKey ? { chatKey } : {}),
      ...(currentChat.name ? { chatName: currentChat.name } : {}),
      factCount: 0,
      currentChatSizeBytes,
      currentChatUsageRatio,
      lastOrganizedAt: this.lastOrganizedAt,
      pendingJobs: 0,
      llmAvailable: readMemoryLlmApi() !== null,
      errorCode: diagnostic.code,
      error: diagnostic.reason,
      errorDiagnostic: diagnostic,
    });
    };
    if (!this.sqliteAvailable) {
      traceMemoryStartup('application:overview-degraded');
      return degraded();
    }
    let facts: MemoryFact[] = [];
    let jobs: MemoryJob[] = [];
    if (chatKey) {
      try {
        [facts, jobs] = await Promise.all([this.repository.listFacts(chatKey), this.repository.listJobs(chatKey)]);
        traceMemoryStartup('application:overview-records-ready');
      } catch (error) {
        this.recallIndex.replace([]);
        this.setRuntimeError(error, 'MEMORY_CHAT_READ_FAILED', 'chat-bind');
        traceMemoryStartup('application:overview-records-failed');
        return degraded(this.error);
      }
    }
    const latestCompletedAt = jobs
      .filter((job) => job.status === 'completed')
      .reduce<number | null>((latest, job) => latest === null ? job.updatedAt : Math.max(latest, job.updatedAt), null);
    const llmRoute = this.currentLlmRouteDiagnostic();
    traceMemoryStartup('application:overview-route-cached');
    const errorCode = this.errorDiagnostic?.code;
    const currentChat = this.getCurrentChatInfo();
    const bound = Boolean(chatKey && this.boundChatKey === chatKey);
    const overview: MemoryUiOverview = {
      status: this.status === 'error' ? 'error' : !currentChat.available ? 'unselected' : currentChat.effectiveEnabled ? this.status : 'disabled',
      bound,
      ...(chatKey ? { chatKey } : {}),
      ...(currentChat.name ? { chatName: currentChat.name } : {}),
      factCount: facts.length,
      currentChatSizeBytes,
      currentChatUsageRatio,
      lastOrganizedAt: this.lastOrganizedAt ?? latestCompletedAt,
      pendingJobs: jobs.filter((job) => job.status === 'queued' || job.status === 'running' || job.status === 'paused').length,
      llmAvailable: readMemoryLlmApi() !== null,
      ...(llmRoute.resourceId ? { llmResource: llmRoute.resourceId } : {}),
      ...(llmRoute.model ? { llmModel: llmRoute.model } : {}),
      ...(errorCode ? { errorCode } : {}),
      ...(this.error ? { error: this.error } : {}),
      ...(this.errorDiagnostic ? { errorDiagnostic: this.errorDiagnostic } : {}),
    };
    traceMemoryStartup('application:overview-ready');
    return overview;
  }

  async getInitializationSources(options: MemoryInitializationOptions = {}): Promise<MemoryInitializationSourceOption[]> {
    const chatKey = this.getChatKey();
    if (!chatKey) return [];
    const [groups, initialization] = await Promise.all([
      this.collectSources(chatKey).then((sources) => {
        const rawGroups = summarizeSourceGroups(sources);
        const defaultGroups = summarizeSourceGroups(filterSourceBlocks(sources));
        const currentGroups = summarizeSourceGroups(filterSourceBlocks(sources, options));
        const defaultById = new Map(defaultGroups.map((group) => [group.id, group]));
        const currentById = new Map(currentGroups.map((group) => [group.id, group]));
        return rawGroups.map((group) => {
          const current = currentById.get(group.id);
          const safe = defaultById.get(group.id);
          return {
            ...group,
            count: current?.count ?? 0,
            rawCount: group.count,
            defaultCount: safe?.count ?? 0,
            excludedCount: Math.max(0, group.count - (current?.count ?? 0)),
          };
        });
      }),
      this.getInitializationState(),
    ]);
    const selectedKinds = initialization.selectedSourceKinds.length > 0
      ? new Set(initialization.selectedSourceKinds)
      : new Set(groups.filter((group) => group.count > 0).map((group) => group.id));
    return groups.map((group) => ({
      kind: group.id,
      label: group.label,
      count: group.count,
      rawCount: group.rawCount,
      defaultCount: group.defaultCount,
      excludedCount: group.excludedCount,
      selected: group.count > 0 && selectedKinds.has(group.id),
    }));
  }

  async getInitializationState(): Promise<MemoryInitializationState> {
    const chatKey = this.getChatKey();
    if (!chatKey) return { initialized: false, lastCompletedAt: null, selectedSourceKinds: [], attempts: [] };
    const initializationJobs = (await this.repository.listJobs(chatKey))
      .filter((job) => job.type === 'initialize')
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const latestCompleted = initializationJobs.find((job) => job.status === 'completed');
    return {
      initialized: Boolean(latestCompleted),
      lastCompletedAt: latestCompleted?.updatedAt ?? null,
      selectedSourceKinds: [...(latestCompleted?.checkpoint.selectedSourceGroupIds ?? [])],
      ...(latestCompleted?.checkpoint.qualityStatus ? { qualityStatus: latestCompleted.checkpoint.qualityStatus } : {}),
      ...(latestCompleted?.checkpoint.pendingReviewCount === undefined ? {} : { pendingReviewCount: latestCompleted.checkpoint.pendingReviewCount }),
      ...(latestCompleted?.checkpoint.stagedBatchCount === undefined ? {} : { stagedBatchCount: latestCompleted.checkpoint.stagedBatchCount }),
      ...(latestCompleted?.checkpoint.mergedDuplicateCount === undefined ? {} : { mergedDuplicateCount: latestCompleted.checkpoint.mergedDuplicateCount }),
      ...(latestCompleted?.checkpoint.supersededCount === undefined ? {} : { supersededCount: latestCompleted.checkpoint.supersededCount }),
      ...(latestCompleted?.checkpoint.conflictBucketCount === undefined ? {} : { conflictBucketCount: latestCompleted.checkpoint.conflictBucketCount }),
      ...(latestCompleted?.checkpoint.ruleResolvedCount === undefined ? {} : { ruleResolvedCount: latestCompleted.checkpoint.ruleResolvedCount }),
      ...(latestCompleted?.checkpoint.llmResolvedCount === undefined ? {} : { llmResolvedCount: latestCompleted.checkpoint.llmResolvedCount }),
      attempts: initializationJobs.slice(0, 5).map((job) => ({
        jobId: job.id,
        status: this.activeCaptureProgress?.jobId === job.id && this.activeCaptureProgress.status === 'cancelled'
          ? 'cancelled'
          : job.status,
        updatedAt: job.updatedAt,
        totalBatches: job.checkpoint.totalBatches ?? job.checkpoint.batchIndex,
        selectedSourceKinds: [...(job.checkpoint.selectedSourceGroupIds ?? [])],
        ...(job.checkpoint.includeInvisibleHistory === undefined ? {} : { includeInvisibleHistory: job.checkpoint.includeInvisibleHistory }),
        ...(job.error ? { error: job.error } : {}),
      })),
    };
  }

  async getInitializationEstimate(selectedKinds?: string[], options: MemoryInitializationOptions = {}): Promise<MemoryInitializationEstimate> {
    const chatKey = this.getChatKey();
    if (!chatKey) return estimateSummaryInitialization(0, []);
    const sources = selectSourceGroups(filterSourceBlocks(await this.collectSources(chatKey), options), selectedKinds);
    const messageCount = sources.filter((source) => source.kind === 'message').length;
    return estimateSummaryInitialization(messageCount, buildSummaryBatches(sources, summaryStrategyFromSettings(this.settings), {
      includeSystemMessages: options.includeInvisibleHistory === true,
    }));
  }

  async getCaptureProgress(): Promise<MemoryCaptureProgress> {
    if (this.activeCaptureProgress) {
      return {
        ...this.activeCaptureProgress,
        elapsedMs: this.activeCaptureProgress.status === 'running'
          ? Math.max(0, Date.now() - this.captureStartedAt)
          : this.activeCaptureProgress.elapsedMs,
      };
    }
    const chatKey = this.getChatKey();
    const latest = chatKey
      ? (await this.repository.listJobs(chatKey)).sort((left, right) => right.updatedAt - left.updatedAt)[0]
      : undefined;
    if (!latest) return { status: 'idle', batchIndex: 0, totalBatches: 0, processedCount: 0, elapsedMs: 0 };
    return {
      status: latest.status,
      jobId: latest.id,
      batchIndex: latest.checkpoint.batchIndex,
      totalBatches: latest.checkpoint.totalBatches ?? latest.checkpoint.batchIndex,
      processedCount: latest.checkpoint.processedCount,
      elapsedMs: Math.max(0, latest.updatedAt - latest.createdAt),
      ...(latest.error ? { error: latest.error } : {}),
      ...(latest.checkpoint.phase ? { phase: latest.checkpoint.phase } : {}),
      ...(latest.checkpoint.stagedBatchCount === undefined ? {} : { stagedBatchCount: latest.checkpoint.stagedBatchCount }),
      ...(latest.checkpoint.conflictBucketCount === undefined ? {} : { conflictBucketCount: latest.checkpoint.conflictBucketCount }),
      ...(latest.checkpoint.pendingReviewCount === undefined ? {} : { pendingReviewCount: latest.checkpoint.pendingReviewCount }),
      ...(latest.checkpoint.qualityStatus ? { qualityStatus: latest.checkpoint.qualityStatus } : {}),
    };
  }

  async listAuditRecords(): Promise<Array<Record<string, unknown>>> {
    return (await this.repository.listJobBatchAudits(this.requireChatKey())).map((audit) => ({
      ...audit,
      status: audit.rolledBackAt ? '已回滚' : '已完成',
      rejected: audit.rejections,
    }));
  }

  async getMainChatUsage(): Promise<MainChatUsage[]> {
    return this.repository.listMainChatUsage(this.requireChatKey());
  }

  async recordMainChatUsage(usage: MainChatUsage): Promise<void> {
    if (usage.chatKey !== this.requireChatKey()) return;
    await this.repository.addMainChatUsage({
      ...usage,
      ...(this.lastRecallLogId ? { recallLogId: this.lastRecallLogId } : {}),
    });
  }

  async rollbackBatch(jobId: string, batchIndex: number): Promise<void> {
    const chatKey = this.requireChatKey();
    let affectedFactIds: string[];
    try {
      affectedFactIds = await this.repository.rollbackJobBatch(jobId, batchIndex, chatKey);
    } catch (error) {
      await this.bindCurrentChat();
      throw error;
    }
    try {
      if (affectedFactIds.length > 0) {
        await this.vectorIndex.rebuildFacts(chatKey, affectedFactIds);
        await this.repository.completeRollbackIndexRepair(jobId, batchIndex);
      }
    } catch {
      await this.bindCurrentChat();
      throw Object.assign(new Error('回滚已提交，向量索引修复等待重试。'), { code: 'VECTOR_INDEX_REPAIR_PENDING' });
    }
    await this.bindCurrentChat();
  }

  async cancelCapture(): Promise<void> {
    if (!this.capturePromise) return;
    this.cancelRequested = true;
    this.captureVersion += 1;
    await this.capturePromise.catch(() => undefined);
  }

  /** LLMHub 延迟挂载时重试任务注册，并继续未完成的向量回填。 */
  refreshLlmRegistration(): void {
    const settings = this.getEffectiveSettings();
    if (this.sqliteAvailable && settings.enabled && usesVectorIndex(settings)) {
      this.vectorIndex.scheduleSync(this.getChatKey());
    }
  }

  async listFacts(query = ''): Promise<MemoryUiFact[]> {
    traceMemoryStartup('application:list-facts-begin');
    const chatKey = this.requireChatKey();
    const [facts, audits] = await Promise.all([
      query.trim() ? this.repository.searchFacts(chatKey, query) : this.repository.listFacts(chatKey),
      this.repository.listJobBatchAudits(chatKey),
    ]);
    const result = await Promise.all(facts.map(async (fact) => asUiFact(
      fact,
      (await this.repository.listEvidence(chatKey, fact.id)).map((item) => ({ sourceRef: item.sourceRef, excerpt: item.excerpt })),
      audits
        .filter((audit) => audit.sourceRefs.some((sourceRef) => fact.sourceRefs.includes(sourceRef)))
        .map((audit) => {
          const kind = (audit as { kind?: unknown }).kind;
          return {
            jobId: audit.jobId,
            batchIndex: audit.batchIndex,
            status: audit.rolledBackAt ? '已回滚' : '已完成',
            ...(typeof kind === 'string' ? { kind } : {}),
          };
        }),
    )));
    traceMemoryStartup('application:list-facts-ready');
    return result;
  }

  onSettingsChanged(listener: (settings: MemoryUiSettings) => void): () => void {
    this.settingsListeners.add(listener);
    return () => this.settingsListeners.delete(listener);
  }

  async updateFact(id: string, content: string): Promise<void> {
    const chatKey = this.requireChatKey();
    const current = await this.repository.getFact(this.requireChatKey(), id);
    if (!current || current.chatKey !== chatKey) throw new Error('记忆不存在或不属于当前聊天。');
    const input: ManualFactInput = {
      id,
      kind: current.kind,
      subjectKey: current.subjectKey,
      predicateKey: current.predicateKey,
      content,
      entityKeys: current.entityKeys,
      confidence: current.confidence,
      status: current.status,
      ...(current.objectKey === undefined ? {} : { objectKey: current.objectKey }),
      ...(current.validFrom === undefined ? {} : { validFrom: current.validFrom }),
      ...(current.validUntil === undefined ? {} : { validUntil: current.validUntil }),
      ...(current.stableAnchor === undefined ? {} : { stableAnchor: current.stableAnchor }),
      ...(current.scope === undefined ? {} : { scope: current.scope }),
    };
    const fact = await this.repository.upsertManualFact(chatKey, input);
    this.recallIndex.upsert(fact);
    this.vectorIndex.scheduleSync(chatKey);
    this.scheduleGraph(chatKey);
  }

  async removeFact(id: string): Promise<void> {
    await this.facts.remove(id);
  }

  async getLastRecall(): Promise<MemoryRecallLog | RecallResult | null> {
    return this.lastRecall ?? await this.repository.getLastRecall(this.requireChatKey()) ?? null;
  }

  /** 将宿主真正注入的 Prompt 回写到同一条召回日志，供真实链路审计。 */
  async recordPromptInjection(input: {
    injected: boolean;
    recall: RecallResult | null;
    prompt: string;
    promptDiagnostics: MemoryRecallLog['promptDiagnostics'] | null;
  }): Promise<void> {
    if (!input.recall || input.recall !== this.lastRecall || !this.lastRecallLogId) return;
    const recallLogId = this.lastRecallLogId;
    const log = await this.repository.getLastRecall(this.requireChatKey());
    if (!log || log.id !== recallLogId) return;
    await this.repository.addRecallLog({
      ...log,
      ...(input.injected ? { injectedPrompt: input.prompt } : {}),
      ...(input.promptDiagnostics ? { promptDiagnostics: structuredClone(input.promptDiagnostics) } : {}),
    });
  }

  async getSqliteStatus(): Promise<MemorySqliteStatus> {
    try {
      traceMemoryStartup('application:sqlite-status-begin');
      const health = await this.repository.refreshHealth(this.getChatKey());
      traceMemoryStartup('application:sqlite-status-health-ready');
      const wasAvailable = this.sqliteAvailable;
      this.sqliteAvailable = health.connected;
      if (health.connected && (!wasAvailable || this.status === 'error') && !this.stopped) {
        traceMemoryStartup('application:sqlite-status-rebind');
        this.vectorIndex.start();
        if (!wasAvailable) await this.loadSettings();
        await this.bindCurrentChat();
      }
      const sqliteCoverage = health.vectorCoverage;
      const indexedFacts = Number(sqliteCoverage?.indexedFacts ?? sqliteCoverage?.ready ?? health.tableCounts.fact_vectors ?? 0);
      const eligibleFacts = Number(sqliteCoverage?.eligibleFacts ?? sqliteCoverage?.totalFacts ?? health.tableCounts.facts ?? 0);
      const coverageRatio = Number(sqliteCoverage?.ratio ?? sqliteCoverage?.coverage
        ?? (eligibleFacts === 0 ? 1 : indexedFacts / eligibleFacts));
      const lastError = typeof health.lastError === 'string'
        ? health.lastError
        : health.lastError?.message;
      return {
        connected: health.connected,
        serverVersion: health.serverVersion,
        nodeVersion: health.nodeVersion,
        protocolVersion: health.protocolVersion,
        sqliteVersion: health.sqliteVersion,
        schemaVersion: health.schemaVersion,
        databasePath: health.databasePath,
        databaseSizeBytes: health.databaseSizeBytes,
        workspaceSizeBytes: health.workspaceSizeBytes,
        currentChatSizeBytes: health.currentChatSizeBytes,
        currentChatUsageRatio: health.workspaceSizeBytes ? health.currentChatSizeBytes / health.workspaceSizeBytes : 0,
        walMode: health.walMode,
        tableCounts: { ...health.tableCounts },
        tableBytes: { ...health.tableBytes },
        vectorCoverage: { indexedFacts, eligibleFacts, ratio: coverageRatio },
        ...(lastError ? { lastError } : {}),
      };
    } catch (error) {
      this.sqliteAvailable = false;
      this.vectorIndex.stop();
      this.setRuntimeError(error, 'SQLITE_SERVICE_UNAVAILABLE', 'health');
      const previous = this.repository.getHealthSnapshot();
      return {
        connected: false,
        serverVersion: previous?.serverVersion ?? 'N/A',
        nodeVersion: previous?.nodeVersion ?? 'N/A',
        protocolVersion: previous?.protocolVersion ?? 0,
        sqliteVersion: previous?.sqliteVersion ?? 'N/A',
        schemaVersion: previous?.schemaVersion ?? 0,
        databasePath: previous?.databasePath ?? 'data/_ss-helper-v0/ss-helper.sqlite3',
        databaseSizeBytes: previous?.databaseSizeBytes ?? 0,
        workspaceSizeBytes: previous?.workspaceSizeBytes ?? 0,
        currentChatSizeBytes: previous?.currentChatSizeBytes ?? 0,
        currentChatUsageRatio: previous?.workspaceSizeBytes ? previous.currentChatSizeBytes / previous.workspaceSizeBytes : 0,
        walMode: previous?.walMode ?? 'N/A',
        tableCounts: previous?.tableCounts ?? {},
        tableBytes: previous?.tableBytes ?? {},
        vectorCoverage: { indexedFacts: 0, eligibleFacts: 0, ratio: 0 },
        lastError: this.errorDiagnostic?.reason ?? 'SQLite 工作区服务未连接。',
      };
    }
  }

  private setRuntimeError(error: unknown, fallbackCode: string, stage: Parameters<typeof describeMemoryError>[2]): void {
    const diagnostic = describeMemoryError(error, fallbackCode, stage);
    this.status = 'error';
    this.errorDiagnostic = diagnostic;
    this.error = diagnostic.reason;
  }

  private clearRuntimeError(): void {
    this.error = '';
    this.errorDiagnostic = undefined;
    if (this.status === 'error') this.status = 'ready';
  }

  exportSqliteBackup(): Promise<Blob> {
    if (!this.sqliteAvailable) throw new Error('Memory workspace 不可用，无法导出备份。');
    return this.repository.exportBackup();
  }

  async importSqliteBackup(file: File): Promise<void> {
    if (!this.sqliteAvailable) throw new Error('Memory workspace 不可用，无法恢复备份。');
    if (!Number.isFinite(file.size) || file.size < 1 || file.size > MAX_MEMORY_BACKUP_BYTES) {
      const error = new Error('Memory 备份文件过大或无效。') as Error & { code?: string };
      error.code = 'BACKUP_TOO_LARGE';
      throw error;
    }
    await this.cancelCapture();
    await this.repository.importBackup(file);
    await this.loadSettings();
    this.settingsListeners.forEach(listener => listener(this.getSettings()));
    await this.bindCurrentChat();
    // Import can restore several chats from the current character/group
    // Workspace. Reconcile each independently so old archives without graph
    // records backfill in the background; a later chat bind handles other
    // Workspaces in the same archive.
    if (this.settings.enabled && this.settings.graphEnabled) {
      void Promise.resolve()
        .then(() => this.repository.getChatKeys())
        .then((chatKeys) => chatKeys.forEach((chatKey) => this.graphService.schedule(chatKey, true)))
        .catch(() => undefined);
    }
  }

  async checkSqliteIntegrity(): Promise<{ ok: boolean; message: string }> {
    if (!this.sqliteAvailable) return { ok: false, message: 'Memory workspace 不可用。' };
    return this.repository.checkIntegrity();
  }

  async clearCurrentChatData(): Promise<void> {
    const chatKey = this.requireChatKey();
    await this.repository.clearCurrentChatData(chatKey);
    if (this.summaryProgressByChat[chatKey]) {
      const next = { ...this.summaryProgressByChat };
      delete next[chatKey];
      await this.repository.setSettings({ summaryProgressByChat: next });
      this.summaryProgressByChat = next;
      this.summaryWaitingByChat.delete(chatKey);
      this.emitSettingsChanged();
    }
    this.recallIndex.replace([]);
    this.lastRecall = null;
    this.lastRecallLogId = null;
    this.lastOrganizedAt = null;
    this.activeCaptureProgress = null;
    this.captureStartedAt = 0;
    this.cancelRequested = false;
    this.clearRuntimeError();
    this.scheduleGraph(chatKey);
  }

  async clearAllMemoryData(): Promise<void> {
    await this.cancelCapture();
    await this.repository.clearAllMemory();
    await this.repository.setSettings({ summaryProgressByChat: {} });
    this.summaryProgressByChat = {};
    this.summaryWaitingByChat.clear();
    this.recallIndex.replace([]);
    this.lastRecall = null;
    this.lastRecallLogId = null;
    await this.bindCurrentChat();
  }

  observeCompletedRound(_visibleText: string): void {
    const settings = this.getEffectiveSettings();
    if (!settings.enabled || !settings.autoOrganize) return;
    if (!this.getChatKey()) return;
    void this.flushCapture('incremental').catch(() => undefined);
  }

  private async loadSettings(): Promise<void> {
    const [enabled, autoOrganize, summaryBatchMode, summaryBatchFloors, summaryBatchChars, summaryIntervalFloors, summaryOverlapFloors, maxRecallItems, promptMaxChars, answerMode, recallMode, rerankMode, preExtractReferenceEnabled, preExtractReferenceItems, preExtractReferenceMode, preExtractReferenceMaxChars, graphEnabled, graphLlmRelationEnabled, graphMaxHops, graphMaxEdges, chatOverrides, summaryProgressByChat] = await Promise.all([
      this.repository.getSetting<boolean>('enabled'),
      this.repository.getSetting<boolean>('autoOrganize'),
      this.repository.getSetting<MemoryGlobalSettings['summaryBatchMode']>('summaryBatchMode'),
      this.repository.getSetting<number>('summaryBatchFloors'),
      this.repository.getSetting<number>('summaryBatchChars'),
      this.repository.getSetting<number>('summaryIntervalFloors'),
      this.repository.getSetting<number>('summaryOverlapFloors'),
      this.repository.getSetting<number>('maxRecallItems'),
      this.repository.getSetting<number>('promptMaxChars'),
      this.repository.getSetting<MemoryUiSettings['answerMode']>('answerMode'),
      this.repository.getSetting<MemoryUiSettings['recallMode']>('recallMode'),
      this.repository.getSetting<MemoryUiSettings['rerankMode']>('rerankMode'),
      this.repository.getSetting<boolean>('preExtractReferenceEnabled'),
      this.repository.getSetting<number>('preExtractReferenceItems'),
      this.repository.getSetting<MemoryUiSettings['preExtractReferenceMode']>('preExtractReferenceMode'),
      this.repository.getSetting<number>('preExtractReferenceMaxChars'),
      this.repository.getSetting<boolean>('graphEnabled'),
      this.repository.getSetting<boolean>('graphLlmRelationEnabled'),
      this.repository.getSetting<number>('graphMaxHops'),
      this.repository.getSetting<number>('graphMaxEdges'),
      this.repository.getSetting<Record<string, boolean>>('chatOverrides'),
      this.repository.getSetting<Record<string, SummaryProgress>>('summaryProgressByChat'),
    ]);
    this.settings = {
      enabled: enabled ?? DEFAULT_SETTINGS.enabled,
      autoOrganize: autoOrganize ?? DEFAULT_SETTINGS.autoOrganize,
      summaryBatchMode: summaryBatchMode === 'chars' ? 'chars' : 'floors',
      summaryBatchFloors: Math.min(20, Math.max(1, Math.trunc(summaryBatchFloors ?? DEFAULT_SETTINGS.summaryBatchFloors))),
      summaryBatchChars: Math.min(16_000, Math.max(2_000, Math.round((summaryBatchChars ?? DEFAULT_SETTINGS.summaryBatchChars) / 500) * 500)),
      summaryIntervalFloors: Math.min(50, Math.max(1, Math.trunc(summaryIntervalFloors ?? DEFAULT_SETTINGS.summaryIntervalFloors))),
      summaryOverlapFloors: Math.min(10, Math.max(0, Math.trunc(summaryOverlapFloors ?? DEFAULT_SETTINGS.summaryOverlapFloors))),
      maxRecallItems: clampMaxItems(maxRecallItems ?? DEFAULT_SETTINGS.maxRecallItems),
      promptMaxChars: clampPromptMaxChars(promptMaxChars ?? DEFAULT_SETTINGS.promptMaxChars),
      answerMode: answerMode === 'diagnostic' || answerMode === 'roleplay' ? answerMode : 'auto',
      recallMode: recallMode === 'lexical' || recallMode === 'vector' || recallMode === 'hybrid' ? recallMode : 'auto',
      rerankMode: rerankMode === 'off' || rerankMode === 'always' ? rerankMode : 'adaptive',
      preExtractReferenceEnabled: preExtractReferenceEnabled ?? DEFAULT_SETTINGS.preExtractReferenceEnabled,
      preExtractReferenceItems: clampPreExtractReferenceItems(preExtractReferenceItems ?? DEFAULT_SETTINGS.preExtractReferenceItems),
      preExtractReferenceMode: preExtractReferenceMode === 'lexical' || preExtractReferenceMode === 'vector' || preExtractReferenceMode === 'hybrid'
        ? preExtractReferenceMode
        : 'auto',
      preExtractReferenceMaxChars: clampPreExtractReferenceMaxChars(preExtractReferenceMaxChars ?? DEFAULT_SETTINGS.preExtractReferenceMaxChars),
      graphEnabled: graphEnabled ?? DEFAULT_SETTINGS.graphEnabled,
      graphLlmRelationEnabled: graphLlmRelationEnabled ?? DEFAULT_SETTINGS.graphLlmRelationEnabled,
      graphMaxHops: clampGraphMaxHops(graphMaxHops ?? DEFAULT_SETTINGS.graphMaxHops),
      graphMaxEdges: clampGraphMaxEdges(graphMaxEdges ?? DEFAULT_SETTINGS.graphMaxEdges),
    };
    this.chatOverrides = chatOverrides && typeof chatOverrides === 'object' && !Array.isArray(chatOverrides)
      ? Object.fromEntries(Object.entries(chatOverrides).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'))
      : {};
    this.summaryProgressByChat = summaryProgressByChat && typeof summaryProgressByChat === 'object' && !Array.isArray(summaryProgressByChat)
      ? Object.fromEntries(Object.entries(summaryProgressByChat).filter((entry): entry is [string, SummaryProgress] => {
        const value = entry[1];
        return Boolean(value) && typeof value === 'object'
          && typeof value.completedFloor === 'number'
          && typeof value.completedMessageId === 'string'
          && typeof value.updatedAt === 'number';
      }))
      : {};
  }

  private async previewRecall(input: Omit<RecallQuery, 'chatKey'> & { query: string }): Promise<RecallResult> {
    const chatKey = this.requireChatKey();
    const settings = this.getEffectiveSettings();
    if (!settings.enabled) throw new Error('当前聊天未启用记忆。');
    const recallContext = await this.hostContext?.getRecallContext?.();
    const query: RecallQuery = {
      ...input,
      chatKey,
      maxItems: input.maxItems ?? settings.maxRecallItems,
      characterKeys: input.characterKeys ?? recallContext?.characterKeys ?? [],
      worldKeys: input.worldKeys ?? recallContext?.worldKeys ?? [],
    };
    const recallVersion = this.captureVersion;
    const result = await this.semanticRecall.recall(
      query,
      settings.recallMode,
      settings.rerankMode,
      settings.graphEnabled ? { maxHops: settings.graphMaxHops, maxEdges: settings.graphMaxEdges } : undefined,
    );
    if (this.stopped || recallVersion !== this.captureVersion || this.getChatKey() !== chatKey) {
      throw new Error('召回结果已因聊天切换而丢弃。');
    }
    this.lastRecall = result;
    const recallLogId = createId('recall');
    this.lastRecallLogId = recallLogId;
    await this.repository.addRecallLog({
      id: recallLogId,
      chatKey,
      query: result.query,
      maxItems: result.maxItems,
      candidates: result.candidates.map((candidate) => ({
        factId: candidate.factId,
        score: candidate.score,
        selected: candidate.selected,
        reasonCodes: [...candidate.reasonCodes],
        ...(candidate.omittedReason === undefined ? {} : { omittedReason: candidate.omittedReason }),
        ...(candidate.lexicalScore === undefined ? {} : { lexicalScore: candidate.lexicalScore }),
        ...(candidate.vectorScore === undefined ? {} : { vectorScore: candidate.vectorScore }),
        ...(candidate.graphScore === undefined ? {} : { graphScore: candidate.graphScore }),
        ...(candidate.lexicalRank === undefined ? {} : { lexicalRank: candidate.lexicalRank }),
        ...(candidate.vectorRank === undefined ? {} : { vectorRank: candidate.vectorRank }),
        ...(candidate.graphRank === undefined ? {} : { graphRank: candidate.graphRank }),
        ...(candidate.fusionScore === undefined ? {} : { fusionScore: candidate.fusionScore }),
        ...(candidate.rerankScore === undefined ? {} : { rerankScore: candidate.rerankScore }),
      })),
      selectedFactIds: result.items.map((item) => item.fact.id),
      diagnostics: structuredClone(result.diagnostics),
      createdAt: result.createdAt,
    });
    return result;
  }

  private flushCapture(
    mode: 'initialize' | 'incremental',
    resumeJob?: MemoryJob,
    selectedSourceGroups?: string[],
    options?: MemoryInitializationOptions,
  ): Promise<void> {
    if (this.capturePromise) return this.capturePromise;
    this.capturePromise = this.runCapture(mode, resumeJob, selectedSourceGroups, options).finally(() => { this.capturePromise = null; });
    return this.capturePromise;
  }

  private async runCapture(
    mode: 'initialize' | 'incremental',
    resumeJob?: MemoryJob,
    selectedSourceGroups?: string[],
    options?: MemoryInitializationOptions,
  ): Promise<void> {
    const captureSettings = this.getEffectiveSettings();
    if (!captureSettings.enabled) return;
    const chatKey = this.requireChatKey();
    const captureVersion = this.captureVersion;
    const [baselineFacts, referenceScope] = captureSettings.preExtractReferenceEnabled
      ? await Promise.all([
        this.repository.listFacts(chatKey),
        this.hostContext?.getRecallContext?.() ?? Promise.resolve(undefined),
      ])
      : [[], undefined] as const;
    this.assertCaptureCurrent(captureVersion, chatKey);
    const referenceRetriever = captureSettings.preExtractReferenceEnabled
      ? new ExistingMemoryContextRetriever(
        baselineFacts,
        this.vectorIndex,
        captureSettings.graphEnabled ? new MemoryGraphRecallIndex(deriveMemoryGraphProjection(baselineFacts)) : undefined,
      )
      : null;
    const includeInvisibleHistory = mode === 'initialize'
      && (resumeJob?.checkpoint.includeInvisibleHistory ?? options?.includeInvisibleHistory === true);
    const effectiveSelectedSourceGroups = resumeJob?.checkpoint.selectedSourceGroupIds ?? selectedSourceGroups;
    const allSources = selectSourceGroups(
      filterSourceBlocks(await this.collectSources(chatKey), { includeInvisibleHistory }),
      mode === 'incremental' ? undefined : effectiveSelectedSourceGroups,
    );
    this.assertCaptureCurrent(captureVersion, chatKey);
    const existingProgress = await this.ensureSummaryProgress(chatKey, allSources);
    if (existingProgress) {
      const waiting = getSummaryWaitingFloors(allSources, existingProgress, summaryStrategyFromSettings(this.settings));
      if (waiting !== undefined) this.summaryWaitingByChat.set(chatKey, waiting);
      this.emitSettingsChanged();
    }
    const automaticWindow = mode === 'incremental'
      ? selectAutomaticSummaryWindow(allSources, existingProgress, summaryStrategyFromSettings(this.settings))
      : undefined;
    const sources = automaticWindow?.sources ?? (mode === 'incremental' ? [] : allSources);
    if (sources.length === 0) {
      return;
    }
    const summaryOptions = { includeSystemMessages: includeInvisibleHistory };
    const messageSources = visibleConversationMessages(sources, summaryOptions);
    const target = automaticWindow
      ? { startFloor: automaticWindow.startFloor, endFloor: automaticWindow.endFloor, endMessageId: automaticWindow.endMessageId }
      : messageSources.length > 0
        ? {
          startFloor: messageSources[0]?.floor ?? 1,
          endFloor: messageSources.at(-1)?.floor ?? messageSources.length,
          endMessageId: messageSources.at(-1)?.id ?? '',
        }
        : undefined;
    const allBatches = buildSummaryBatches(sources, summaryStrategyFromSettings(this.settings), summaryOptions);
    const initializationPhase = mode === 'initialize'
      ? (resumeJob?.checkpoint.phase ?? 'extract')
      : undefined;
    const resumeBatchIndex = initializationPhase && initializationPhase !== 'extract'
      ? allBatches.length
      : resumeJob?.checkpoint.batchIndex ?? 0;
    const batches = allBatches.slice(resumeBatchIndex);
    if (batches.length === 0 && mode !== 'initialize') return;
    const jobId = resumeJob?.id ?? createId('job');
    const createdAt = resumeJob?.createdAt ?? Date.now();
    this.status = 'working';
    this.cancelRequested = false;
    this.captureStartedAt = Date.now();
    this.activeCaptureProgress = {
      status: 'running',
      jobId,
      batchIndex: resumeBatchIndex,
      totalBatches: allBatches.length,
      processedCount: resumeJob?.checkpoint.processedCount ?? 0,
      elapsedMs: 0,
      ...(initializationPhase ? { phase: initializationPhase } : {}),
    };
    this.assertCaptureCurrent(captureVersion, chatKey);
    await this.repository.putJob({
      id: jobId, chatKey, type: mode, status: 'running',
      checkpoint: {
        batchIndex: resumeBatchIndex,
        totalBatches: allBatches.length,
        processedCount: resumeJob?.checkpoint.processedCount ?? 0,
        ...(resumeJob?.checkpoint.metadataSourceRefs === undefined ? {} : { metadataSourceRefs: resumeJob.checkpoint.metadataSourceRefs }),
        ...(effectiveSelectedSourceGroups === undefined ? {} : { selectedSourceGroupIds: effectiveSelectedSourceGroups }),
        ...(mode === 'initialize' ? { includeInvisibleHistory } : {}),
        ...(target === undefined ? {} : { summaryStartFloor: target.startFloor, summaryEndFloor: target.endFloor, summaryEndMessageId: target.endMessageId }),
        ...(initializationPhase ? {
          phase: initializationPhase,
          ...(resumeJob?.checkpoint.stagedBatchCount === undefined ? {} : { stagedBatchCount: resumeJob.checkpoint.stagedBatchCount }),
        } : {}),
      },
      createdAt, updatedAt: Date.now(),
    });
    const service = new MemoryIngestService({
      extractor: new LlmMemoryExtractor(),
      loadExistingMemoryContext: async ({ sources: batchSources }) => {
        if (!referenceRetriever) return [];
        const context = await referenceRetriever.load({
          chatKey,
          sources: batchSources,
          maxItems: captureSettings.preExtractReferenceItems,
          maxChars: captureSettings.preExtractReferenceMaxChars,
          mode: captureSettings.preExtractReferenceMode,
          characterKeys: referenceScope?.characterKeys ?? [],
          worldKeys: referenceScope?.worldKeys ?? [],
          graphMaxHops: captureSettings.graphMaxHops,
          graphMaxEdges: captureSettings.graphMaxEdges,
        });
        this.assertCaptureCurrent(captureVersion, chatKey);
        return context;
      },
      commit: (commit) => {
        this.assertCaptureCurrent(captureVersion, chatKey);
        return this.repository.commit(commit);
      },
      graphLlmRelationEnabled: captureSettings.graphEnabled && captureSettings.graphLlmRelationEnabled,
    });
    let processedCount = resumeJob?.checkpoint.processedCount ?? 0;
    let checkpoint: MemoryJob['checkpoint'] = {
      batchIndex: resumeBatchIndex,
      totalBatches: allBatches.length,
      processedCount,
      ...(resumeJob?.checkpoint.lastSourceRef === undefined ? {} : { lastSourceRef: resumeJob.checkpoint.lastSourceRef }),
      ...(resumeJob?.checkpoint.overlapSourceRefs === undefined ? {} : { overlapSourceRefs: resumeJob.checkpoint.overlapSourceRefs }),
      ...(resumeJob?.checkpoint.metadataSourceRefs === undefined ? {} : { metadataSourceRefs: resumeJob.checkpoint.metadataSourceRefs }),
      ...(effectiveSelectedSourceGroups === undefined ? {} : { selectedSourceGroupIds: effectiveSelectedSourceGroups }),
      ...(mode === 'initialize' ? { includeInvisibleHistory } : {}),
      ...(target === undefined ? {} : { summaryStartFloor: target.startFloor, summaryEndFloor: target.endFloor, summaryEndMessageId: target.endMessageId }),
      ...(initializationPhase ? {
        phase: initializationPhase,
        ...(resumeJob?.checkpoint.stagedBatchCount === undefined ? {} : { stagedBatchCount: resumeJob.checkpoint.stagedBatchCount }),
      } : {}),
    };
    const processedMetadataRefs = new Set(resumeJob?.checkpoint.metadataSourceRefs ?? []);
    const processedMessageRefs = new Set<string>();
    try {
      if (mode === 'initialize') {
        const stagedBefore = await this.repository.listInitializationStagingBatches(chatKey, jobId);
        const stagedBatchIndices = new Set(stagedBefore.map((batch) => batch.batchIndex));
        if (initializationPhase === 'extract') {
          for (let index = 0; index < allBatches.length; index += 1) {
            const batch = allBatches[index]!;
            const batchIndex = index + 1;
            if (stagedBatchIndices.has(batchIndex)) continue;
            this.activeCaptureProgress = {
              status: 'running', jobId, phase: 'extract', batchIndex, totalBatches: allBatches.length,
              processedCount, stagedBatchCount: stagedBatchIndices.size, elapsedMs: Date.now() - this.captureStartedAt,
            };
            batch.filter((source) => source.kind !== 'message').forEach((source) => processedMetadataRefs.add(source.id));
            for (const source of batch) {
              if (source.kind === 'message' && !processedMessageRefs.has(source.id)) {
                processedMessageRefs.add(source.id);
                processedCount += 1;
              }
            }
            const prepared = await service.prepare({ chatKey, sources: batch });
            this.assertCaptureCurrent(captureVersion, chatKey);
            await this.repository.putInitializationStagingBatch({
              id: '', kind: 'initialization-staging-v0', chatKey, jobId, batchIndex,
              totalBatches: allBatches.length, processedCount,
              sources: snapshotsFromSources(prepared.sources), facts: prepared.facts,
              rejections: prepared.rejections, ...(prepared.audit ? { audit: prepared.audit } : {}),
              createdAt: Date.now(), updatedAt: Date.now(),
            });
            stagedBatchIndices.add(batchIndex);
            checkpoint = {
              batchIndex, totalBatches: allBatches.length, processedCount,
              lastSourceRef: batch.at(-1)?.id,
              overlapSourceRefs: batch.slice(-2).map((source) => source.id),
              metadataSourceRefs: [...processedMetadataRefs],
              ...(effectiveSelectedSourceGroups === undefined ? {} : { selectedSourceGroupIds: effectiveSelectedSourceGroups }),
              ...(mode === 'initialize' ? { includeInvisibleHistory } : {}),
              ...(target === undefined ? {} : { summaryStartFloor: target.startFloor, summaryEndFloor: target.endFloor, summaryEndMessageId: target.endMessageId }),
              phase: 'extract', stagedBatchCount: stagedBatchIndices.size,
            };
            await this.repository.putJob({ id: jobId, chatKey, type: mode, status: 'running', checkpoint, createdAt, updatedAt: Date.now() });
          }
        }
        const stagedBatches = await this.repository.listInitializationStagingBatches(chatKey, jobId);
        const storedResolution = initializationPhase === 'apply'
          ? await this.repository.getInitializationResolution(chatKey, jobId)
          : undefined;
        let finalized = storedResolution?.reduction;
        if (!finalized) {
          this.assertCaptureCurrent(captureVersion, chatKey);
          this.activeCaptureProgress = {
            status: 'running', jobId, phase: 'reduce', batchIndex: allBatches.length, totalBatches: allBatches.length,
            processedCount, stagedBatchCount: stagedBatches.length, elapsedMs: Date.now() - this.captureStartedAt,
          };
          checkpoint = { ...checkpoint, batchIndex: allBatches.length, totalBatches: allBatches.length, processedCount, phase: 'reduce', stagedBatchCount: stagedBatches.length };
          await this.repository.putJob({ id: jobId, chatKey, type: mode, status: 'running', checkpoint, createdAt, updatedAt: Date.now() });
          const reduced = reduceInitializationBatches(jobId, stagedBatches);
          this.assertCaptureCurrent(captureVersion, chatKey);
          this.activeCaptureProgress = {
            status: 'running', jobId, phase: 'resolve', batchIndex: allBatches.length, totalBatches: allBatches.length,
            processedCount, stagedBatchCount: stagedBatches.length, conflictBucketCount: reduced.conflictBuckets.length,
            elapsedMs: Date.now() - this.captureStartedAt,
          };
          checkpoint = { ...checkpoint, phase: 'resolve', conflictBucketCount: reduced.conflictBuckets.length, ruleResolvedCount: reduced.stats.ruleResolvedCount };
          await this.repository.putJob({ id: jobId, chatKey, type: mode, status: 'running', checkpoint, createdAt, updatedAt: Date.now() });
          const conflictResult = await resolveInitializationConflicts({ llm: readMemoryLlmApi(), buckets: reduced.conflictBuckets, facts: reduced.facts });
          finalized = applyInitializationConflictResolutions(reduced, conflictResult.resolutions);
          await this.repository.putInitializationResolution({
            id: '', kind: 'initialization-resolution-v0', chatKey, jobId, reduction: finalized, createdAt: Date.now(), updatedAt: Date.now(),
          });
        }
        this.assertCaptureCurrent(captureVersion, chatKey);
        this.activeCaptureProgress = {
          status: 'running', jobId, phase: 'apply', batchIndex: allBatches.length, totalBatches: allBatches.length,
          processedCount, stagedBatchCount: stagedBatches.length, conflictBucketCount: finalized.stats.conflictBucketCount,
          pendingReviewCount: finalized.stats.pendingReviewCount, qualityStatus: finalized.stats.qualityStatus,
          elapsedMs: Date.now() - this.captureStartedAt,
        };
        checkpoint = {
          ...checkpoint, phase: 'apply', stagedBatchCount: finalized.stats.stagedBatchCount,
          mergedDuplicateCount: finalized.stats.mergedDuplicateCount, supersededCount: finalized.stats.supersededCount,
          conflictBucketCount: finalized.stats.conflictBucketCount, ruleResolvedCount: finalized.stats.ruleResolvedCount,
          llmResolvedCount: finalized.stats.llmResolvedCount, pendingReviewCount: finalized.stats.pendingReviewCount,
          qualityStatus: finalized.stats.qualityStatus,
        };
        const finalizationStats = await this.repository.applyInitializationFinalization({
          chatKey,
          job: { id: jobId, chatKey, type: mode, status: 'running', checkpoint, createdAt, updatedAt: Date.now() },
          batches: stagedBatches,
          reduction: finalized,
        });
        checkpoint = { ...checkpoint, ...finalizationStats, phase: 'apply' };
        await this.bindCurrentChat();
      } else {
        for (let index = 0; index < batches.length; index += 1) {
          const batch = batches[index]!;
          this.activeCaptureProgress = {
            status: 'running', jobId, batchIndex: resumeBatchIndex + index + 1, totalBatches: allBatches.length,
            processedCount, elapsedMs: Date.now() - this.captureStartedAt,
          };
          batch.filter((source) => source.kind !== 'message').forEach((source) => processedMetadataRefs.add(source.id));
          for (const source of batch) {
            if (source.kind === 'message' && !processedMessageRefs.has(source.id)) {
              processedMessageRefs.add(source.id);
              processedCount += 1;
            }
          }
          await service.ingest({
            chatKey, jobId, sources: batch, jobType: mode, jobStatus: index === batches.length - 1 ? 'completed' : 'paused',
            batchIndex: resumeBatchIndex + index + 1, totalBatches: allBatches.length, processedCount,
            metadataSourceRefs: [...processedMetadataRefs],
            ...(effectiveSelectedSourceGroups === undefined ? {} : { selectedSourceGroupIds: effectiveSelectedSourceGroups }),
            ...(target === undefined ? {} : { summaryStartFloor: target.startFloor, summaryEndFloor: target.endFloor, summaryEndMessageId: target.endMessageId }),
          });
          checkpoint = {
            batchIndex: resumeBatchIndex + index + 1, totalBatches: allBatches.length, processedCount,
            lastSourceRef: batch.at(-1)?.id, overlapSourceRefs: batch.slice(-2).map((source) => source.id), metadataSourceRefs: [...processedMetadataRefs],
            ...(effectiveSelectedSourceGroups === undefined ? {} : { selectedSourceGroupIds: effectiveSelectedSourceGroups }),
            ...(target === undefined ? {} : { summaryStartFloor: target.startFloor, summaryEndFloor: target.endFloor, summaryEndMessageId: target.endMessageId }),
          };
          await this.bindCurrentChat();
        }
      }
      this.lastOrganizedAt = Date.now();
      if (target) {
        await this.saveSummaryProgress(chatKey, target.endFloor, target.endMessageId, jobId);
        const waiting = getSummaryWaitingFloors(allSources, this.summaryProgressByChat[chatKey], summaryStrategyFromSettings(this.settings));
        if (waiting !== undefined) this.summaryWaitingByChat.set(chatKey, waiting);
        this.emitSettingsChanged();
      }
      this.status = 'ready';
      this.clearRuntimeError();
      this.activeCaptureProgress = {
        status: 'completed', jobId, batchIndex: allBatches.length, totalBatches: allBatches.length,
        processedCount, elapsedMs: Date.now() - this.captureStartedAt,
        ...(mode === 'initialize' ? {
          phase: 'apply' as const,
          stagedBatchCount: checkpoint.stagedBatchCount,
          conflictBucketCount: checkpoint.conflictBucketCount,
          pendingReviewCount: checkpoint.pendingReviewCount,
          qualityStatus: checkpoint.qualityStatus,
        } : {}),
      };
    } catch (error) {
      if (
        error instanceof CaptureCancelledError
        || this.stopped
        || captureVersion !== this.captureVersion
        || this.getChatKey() !== chatKey
      ) {
        if (!this.stopped) {
          await this.repository.putJob({
            id: jobId, chatKey, type: mode, status: 'paused', checkpoint, createdAt, updatedAt: Date.now(),
          });
        }
        this.status = this.getEffectiveSettings().enabled ? 'ready' : 'disabled';
        this.activeCaptureProgress = {
          status: this.cancelRequested ? 'cancelled' : 'paused', jobId,
          batchIndex: checkpoint.batchIndex, totalBatches: allBatches.length,
          processedCount: checkpoint.processedCount, elapsedMs: Date.now() - this.captureStartedAt,
        };
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.setRuntimeError(error, 'MEMORY_CAPTURE_FAILED', 'operation');
      const pauseForRetry = mode === 'initialize' && isRetryableInitializationError(error);
      await this.repository.putJob({
        id: jobId, chatKey, type: mode, status: pauseForRetry ? 'paused' : 'failed',
        checkpoint, error: message, createdAt, updatedAt: Date.now(),
      });
      this.activeCaptureProgress = {
        status: pauseForRetry ? 'paused' : 'failed', jobId, batchIndex: checkpoint.batchIndex, totalBatches: allBatches.length,
        processedCount: checkpoint.processedCount, elapsedMs: Date.now() - this.captureStartedAt, error: message,
      };
      throw error;
    }
  }

  private async ensureSummaryProgress(chatKey: string, suppliedSources?: SourceBlock[]): Promise<SummaryProgress | undefined> {
    const existing = this.summaryProgressByChat[chatKey];
    if (!existing) return undefined;
    const sources = suppliedSources ?? filterSourceBlocks(await this.collectSources(chatKey));
    const waiting = getSummaryWaitingFloors(sources, existing, summaryStrategyFromSettings(this.settings));
    if (waiting !== undefined) this.summaryWaitingByChat.set(chatKey, waiting);
    return existing;
  }

  private async saveSummaryProgress(chatKey: string, completedFloor: number, completedMessageId: string, lastJobId?: string): Promise<void> {
    const progress: SummaryProgress = { completedFloor, completedMessageId, updatedAt: Date.now(), ...(lastJobId ? { lastJobId } : {}) };
    this.summaryProgressByChat = { ...this.summaryProgressByChat, [chatKey]: progress };
    this.summaryWaitingByChat.delete(chatKey);
    await this.repository.setSettings({ summaryProgressByChat: this.summaryProgressByChat });
    this.emitSettingsChanged();
  }

  private emitSettingsChanged(): void {
    this.settingsListeners.forEach((listener) => listener(this.getSettings()));
  }

  private scheduleGraph(chatKey: string): void {
    if (!chatKey) return;
    const effective = this.getEffectiveSettings();
    this.graphService.schedule(chatKey, effective.enabled && effective.graphEnabled);
    this.emitSettingsChanged();
  }

  private async resumePausedWork(): Promise<void> {
    const chatKey = this.getChatKey();
    if (!chatKey || !this.getEffectiveSettings().enabled) return;
    const paused = (await this.repository.listJobs(chatKey))
      .filter((job) => job.status === 'paused')
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (paused) await this.flushCapture(paused.type, paused);
  }

  private requireChatKey(): string {
    const chatKey = this.getChatKey();
    if (!chatKey) throw new Error('当前没有可用的聊天。');
    return chatKey;
  }

  private collectSources(chatKey: string): Promise<SourceBlock[]> {
    if (!this.hostContext) return Promise.reject(new Error('Memory HostPort 尚未连接。'));
    return this.hostContext.collectSources(chatKey);
  }

  private assertCaptureCurrent(version: number, chatKey: string): void {
    if (this.stopped || version !== this.captureVersion || this.getChatKey() !== chatKey) {
      throw new CaptureCancelledError();
    }
  }

}
