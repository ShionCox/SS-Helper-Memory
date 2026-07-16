import { MemoryRepository } from '../infrastructure';
import type {
  FactListOptions,
  MainChatUsage,
  ManualFactInput,
  MemoryFact,
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
import { AdaptiveIngestTrigger } from './ingest/adaptive-trigger';
import {
  LlmMemoryExtractor,
  readMemoryLlmApi,
  readMemoryLlmRouteDiagnostic,
  readMemoryRecallRouteDiagnostics,
} from './ingest/llm-extractor';
import { MemoryIngestService } from './ingest/memory-ingest-service';
import { buildHistoryBatches, buildIncrementalBatch, estimateHistoryInitialization, filterSourceBlocks } from './ingest/source-blocks';
import type { SourceBlock } from './ingest/types';
import { collectCurrentChatSources, selectSourceGroups, summarizeSourceGroups } from '../host/source-adapter';
import type { MemoryPluginApi, MemorySqliteStatus } from '../index';
import type {
  MemoryCaptureProgress,
  MemoryInitializationEstimate,
  MemoryInitializationSourceOption,
  MemoryUiController,
  MemoryUiFact,
  MemoryUiOverview,
  MemoryUiSettings,
} from '../ui/memory-ui';
import type { MemoryHostContext } from '../host/sdk-host-context';

const DEFAULT_SETTINGS: Readonly<MemoryUiSettings> = Object.freeze({
  enabled: true,
  autoOrganize: true,
  maxRecallItems: recallLimits.default,
  promptMaxChars: 8_000,
  answerMode: 'auto',
  recallMode: 'auto',
  rerankMode: 'adaptive',
});

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

class CaptureCancelledError extends Error {
  constructor() { super('记忆整理已因停止或聊天切换而取消。'); }
}

/** Memory 唯一应用服务，SQLite 是唯一持久数据源。 */
export class MemoryApplication implements MemoryPluginApi, MemoryUiController {
  readonly facts: MemoryPluginApi['facts'];
  readonly capture: MemoryPluginApi['capture'];
  readonly recall: MemoryPluginApi['recall'];
  readonly backup: MemoryPluginApi['backup'];
  readonly diagnostics: MemoryPluginApi['diagnostics'];

  private settings: MemoryUiSettings = { ...DEFAULT_SETTINGS };
  private readonly recallIndex = new MemoryRecallIndex();
  private readonly vectorIndex: MemoryVectorIndexService;
  private readonly semanticRecall: SemanticRecallService;
  private readonly trigger = new AdaptiveIngestTrigger();
  private lastRecall: RecallResult | null = null;
  private lastRecallLogId: string | null = null;
  private lastOrganizedAt: number | null = null;
  private status: MemoryUiOverview['status'] = 'ready';
  private error = '';
  private capturePromise: Promise<void> | null = null;
  private captureVersion = 0;
  private stopped = false;
  private boundChatKey = '';
  private captureStartedAt = 0;
  private activeCaptureProgress: MemoryCaptureProgress | null = null;
  private cancelRequested = false;
  private sqliteAvailable = false;
  private hostContext: MemoryHostContext | null = null;

  private readonly settingsListeners = new Set<(settings: MemoryUiSettings) => void>();

  constructor(readonly repository: MemoryRepository) {
    this.vectorIndex = new MemoryVectorIndexService(repository);
    this.semanticRecall = new SemanticRecallService(this.recallIndex, this.vectorIndex);
    this.facts = {
      list: (options) => this.repository.listFacts(this.requireChatKey(), options),
      search: (query, options) => this.repository.searchFacts(this.requireChatKey(), query, options?.limit),
      upsert: async (input) => {
        const fact = await this.repository.upsertManualFact(this.requireChatKey(), input);
        this.recallIndex.upsert(fact);
        this.vectorIndex.scheduleSync(fact.chatKey);
        return fact;
      },
      remove: async (id) => {
        await this.repository.removeFact(this.requireChatKey(), id);
        this.recallIndex.remove(id);
      },
    };
    this.capture = { flush: () => this.flushCapture('incremental') };
    this.recall = { preview: (input) => this.previewRecall(input) };
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
      this.status = 'error';
      this.error = error instanceof Error ? error.message : String(error);
      return;
    }
    void this.resumePausedWork().catch(() => undefined);
  }

  stop(): void {
    this.stopped = true;
    this.captureVersion += 1;
    this.trigger.reset();
    this.recallIndex.replace([]);
    this.vectorIndex.stop();
    this.repository.close();
    this.sqliteAvailable = false;
  }

  getChatKey(): string {
    return this.hostContext?.getChatKey() ?? '';
  }

  listChatKeys(): Promise<string[]> {
    if (!this.sqliteAvailable) return Promise.resolve([]);
    return this.repository.getChatKeys();
  }

  async bindCurrentChat(): Promise<void> {
    const chatKey = this.getChatKey();
    const workspaceId = this.hostContext?.getWorkspaceId() ?? '';
    this.repository.bind?.(workspaceId, chatKey);
    if (this.boundChatKey && this.boundChatKey !== chatKey) this.captureVersion += 1;
    this.boundChatKey = chatKey;
    if (!this.sqliteAvailable) {
      this.recallIndex.replace([]);
      return;
    }
    if (!workspaceId) {
      this.recallIndex.replace([]);
      this.lastRecall = null;
      this.lastRecallLogId = null;
      this.error = '当前角色或群组缺少稳定 ID，Memory 暂不整理或召回。';
      if (this.status === 'error') this.status = 'ready';
      return;
    }
    try {
      const bootstrap = chatKey ? await this.repository.bootstrap(chatKey) : null;
      this.recallIndex.replace(bootstrap?.facts ?? []);
      this.error = '';
      if (this.status === 'error') this.status = 'ready';
    } catch (error) {
      this.sqliteAvailable = false;
      this.recallIndex.replace([]);
      this.status = 'error';
      this.error = error instanceof Error ? error.message : String(error);
      return;
    }
    if (chatKey && this.settings.recallMode !== 'lexical') this.vectorIndex.scheduleSync(chatKey);
    this.lastRecall = null;
    this.lastRecallLogId = null;
  }

  getSettings(): MemoryUiSettings {
    return { ...this.settings, enabled: this.settings.enabled && this.sqliteAvailable && Boolean(this.hostContext?.getWorkspaceId()) };
  }

  async saveSettings(settings: MemoryUiSettings): Promise<void> {
    if (!this.sqliteAvailable) throw new Error('Memory workspace 不可用，设置未保存。');
    const nextSettings: MemoryUiSettings = {
      enabled: settings.enabled === true,
      autoOrganize: settings.autoOrganize === true,
      maxRecallItems: clampMaxItems(settings.maxRecallItems),
      promptMaxChars: clampPromptMaxChars(settings.promptMaxChars),
      answerMode: settings.answerMode === 'diagnostic' || settings.answerMode === 'roleplay' ? settings.answerMode : 'auto',
      recallMode: settings.recallMode === 'lexical' || settings.recallMode === 'vector' || settings.recallMode === 'hybrid'
        ? settings.recallMode
        : 'auto',
      rerankMode: settings.rerankMode === 'off' || settings.rerankMode === 'always' ? settings.rerankMode : 'adaptive',
    };
    await this.repository.setSettings({ ...nextSettings });
    this.settings = nextSettings;
    this.settingsListeners.forEach((listener) => listener(this.getSettings()));
    if (!this.settings.enabled) this.status = 'disabled';
    else if (this.status === 'disabled') this.status = 'ready';
    if (this.settings.enabled && this.settings.recallMode !== 'lexical') this.vectorIndex.scheduleSync(this.getChatKey());
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

  async initialize(selectedKinds?: string[]): Promise<void> {
    await this.flushCapture('initialize', undefined, selectedKinds);
  }

  async retry(): Promise<void> {
    this.error = '';
    const paused = (await this.repository.listJobs(this.requireChatKey())).find((job) => job.status === 'paused');
    await this.flushCapture(paused?.type ?? 'incremental', paused);
  }

  async getOverview(): Promise<MemoryUiOverview> {
    const chatKey = this.getChatKey();
    const degraded = (message = this.error): MemoryUiOverview => ({
      status: 'error',
      bound: false,
      ...(chatKey ? { chatKey } : {}),
      factCount: 0,
      lastOrganizedAt: this.lastOrganizedAt,
      pendingJobs: 0,
      llmAvailable: readMemoryLlmApi() !== null,
      errorCode: message.match(/(?:错误码\s*[=:]|HTTP\s+)([\w-]+)/i)?.[1] ?? 'SQLITE_SERVICE_UNAVAILABLE',
      error: message || 'Memory workspace 不可用，记忆整理、召回与注入已停用。',
    });
    if (!this.sqliteAvailable) return degraded();
    let facts: MemoryFact[] = [];
    let jobs: MemoryJob[] = [];
    if (chatKey) {
      try {
        [facts, jobs] = await Promise.all([this.repository.listFacts(chatKey), this.repository.listJobs(chatKey)]);
      } catch (error) {
        this.sqliteAvailable = false;
        this.status = 'error';
        this.error = error instanceof Error ? error.message : String(error);
        this.recallIndex.replace([]);
        this.vectorIndex.stop();
        return degraded(this.error);
      }
    }
    const latestCompletedAt = jobs
      .filter((job) => job.status === 'completed')
      .reduce<number | null>((latest, job) => latest === null ? job.updatedAt : Math.max(latest, job.updatedAt), null);
    const llmRoute = await readMemoryLlmRouteDiagnostic();
    const errorCode = this.error.match(/(?:错误码\s*[=:]|HTTP\s+)([\w-]+)/i)?.[1];
    return {
      status: this.settings.enabled ? this.status : 'disabled',
      bound: Boolean(chatKey && this.boundChatKey === chatKey),
      ...(chatKey ? { chatKey } : {}),
      factCount: facts.length,
      lastOrganizedAt: this.lastOrganizedAt ?? latestCompletedAt,
      pendingJobs: jobs.filter((job) => job.status === 'queued' || job.status === 'running' || job.status === 'paused').length,
      llmAvailable: readMemoryLlmApi() !== null,
      ...(llmRoute.resourceId ? { llmResource: llmRoute.resourceId } : {}),
      ...(llmRoute.model ? { llmModel: llmRoute.model } : {}),
      ...(errorCode ? { errorCode } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  async getInitializationSources(): Promise<MemoryInitializationSourceOption[]> {
    const chatKey = this.getChatKey();
    if (!chatKey) return [];
    return summarizeSourceGroups(filterSourceBlocks(await this.collectSources(chatKey))).map((group) => ({
      kind: group.id,
      label: group.label,
      count: group.count,
      selected: true,
    }));
  }

  async getInitializationEstimate(selectedKinds?: string[]): Promise<MemoryInitializationEstimate> {
    const chatKey = this.getChatKey();
    if (!chatKey) return estimateHistoryInitialization(0, []);
    const sources = selectSourceGroups(filterSourceBlocks(await this.collectSources(chatKey)), selectedKinds);
    const messageCount = sources.filter((source) => source.kind === 'message').length;
    return estimateHistoryInitialization(messageCount, buildHistoryBatches(sources));
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
    const latest = chatKey ? (await this.repository.listJobs(chatKey))[0] : undefined;
    if (!latest) return { status: 'idle', batchIndex: 0, totalBatches: 0, processedCount: 0, elapsedMs: 0 };
    return {
      status: latest.status,
      jobId: latest.id,
      batchIndex: latest.checkpoint.batchIndex,
      totalBatches: latest.checkpoint.totalBatches ?? latest.checkpoint.batchIndex,
      processedCount: latest.checkpoint.processedCount,
      elapsedMs: Math.max(0, latest.updatedAt - latest.createdAt),
      ...(latest.error ? { error: latest.error } : {}),
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
    await this.repository.rollbackJobBatch(jobId, batchIndex, this.requireChatKey());
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
    if (this.sqliteAvailable && this.settings.recallMode !== 'lexical') {
      this.vectorIndex.scheduleSync(this.getChatKey());
    }
  }

  async listFacts(query = ''): Promise<MemoryUiFact[]> {
    const chatKey = this.requireChatKey();
    const [facts, audits] = await Promise.all([
      query.trim() ? this.repository.searchFacts(chatKey, query) : this.repository.listFacts(chatKey),
      this.repository.listJobBatchAudits(chatKey),
    ]);
    return Promise.all(facts.map(async (fact) => asUiFact(
      fact,
      (await this.repository.listEvidence(chatKey, fact.id)).map((item) => ({ sourceRef: item.sourceRef, excerpt: item.excerpt })),
      audits
        .filter((audit) => audit.sourceRefs.some((sourceRef) => fact.sourceRefs.includes(sourceRef)))
        .map((audit) => ({
          jobId: audit.jobId,
          batchIndex: audit.batchIndex,
          status: audit.rolledBackAt ? '已回滚' : '已完成',
        })),
    )));
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
      const health = await this.repository.refreshHealth(this.getChatKey());
      const wasAvailable = this.sqliteAvailable;
      this.sqliteAvailable = health.connected;
      if (health.connected && !wasAvailable && !this.stopped) {
        this.vectorIndex.start();
        await this.loadSettings();
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
        walMode: health.walMode,
        tableCounts: { ...health.tableCounts },
        tableBytes: { ...health.tableBytes },
        vectorCoverage: { indexedFacts, eligibleFacts, ratio: coverageRatio },
        ...(lastError ? { lastError } : {}),
      };
    } catch (error) {
      const wasAvailable = this.sqliteAvailable;
      this.sqliteAvailable = false;
      const previous = this.repository.getHealthSnapshot();
      const message = error instanceof Error ? error.message : String(error);
      return {
        connected: false,
        serverVersion: previous?.serverVersion ?? 'N/A',
        nodeVersion: previous?.nodeVersion ?? 'N/A',
        protocolVersion: previous?.protocolVersion ?? 0,
        sqliteVersion: previous?.sqliteVersion ?? 'N/A',
        schemaVersion: previous?.schemaVersion ?? 0,
        databasePath: previous?.databasePath ?? 'data/_ss-helper/ss-helper.sqlite3',
        databaseSizeBytes: previous?.databaseSizeBytes ?? 0,
        walMode: previous?.walMode ?? 'N/A',
        tableCounts: previous?.tableCounts ?? {},
        tableBytes: previous?.tableBytes ?? {},
        vectorCoverage: { indexedFacts: 0, eligibleFacts: 0, ratio: 0 },
        lastError: message,
      };
    }
  }

  exportSqliteBackup(): Promise<Blob> {
    if (!this.sqliteAvailable) throw new Error('Memory workspace 不可用，无法导出备份。');
    return this.repository.exportBackup();
  }

  async importSqliteBackup(file: File): Promise<void> {
    if (!this.sqliteAvailable) throw new Error('Memory workspace 不可用，无法恢复备份。');
    await this.cancelCapture();
    await this.repository.importBackup(file);
    await this.loadSettings();
    this.settingsListeners.forEach(listener => listener(this.getSettings()));
    await this.bindCurrentChat();
  }

  async checkSqliteIntegrity(): Promise<{ ok: boolean; message: string }> {
    if (!this.sqliteAvailable) return { ok: false, message: 'Memory workspace 不可用。' };
    return this.repository.checkIntegrity();
  }

  async clearCurrentChatData(): Promise<void> {
    const chatKey = this.requireChatKey();
    await this.repository.clearCurrentChatData(chatKey);
    this.recallIndex.replace([]);
    this.lastRecall = null;
    this.lastRecallLogId = null;
  }

  async clearAllMemoryData(): Promise<void> {
    await this.cancelCapture();
    await this.repository.clearAllMemory();
    this.recallIndex.replace([]);
    this.lastRecall = null;
    this.lastRecallLogId = null;
    await this.bindCurrentChat();
  }

  observeCompletedRound(visibleText: string): void {
    if (!this.settings.enabled || !this.settings.autoOrganize) return;
    const chatKey = this.getChatKey();
    if (!chatKey) return;
    const decision = this.trigger.observeRound(chatKey, visibleText);
    if (decision.shouldFlush) void this.flushCapture('incremental');
  }

  private async loadSettings(): Promise<void> {
    const [enabled, autoOrganize, maxRecallItems, promptMaxChars, answerMode, recallMode, rerankMode] = await Promise.all([
      this.repository.getSetting<boolean>('enabled'),
      this.repository.getSetting<boolean>('autoOrganize'),
      this.repository.getSetting<number>('maxRecallItems'),
      this.repository.getSetting<number>('promptMaxChars'),
      this.repository.getSetting<MemoryUiSettings['answerMode']>('answerMode'),
      this.repository.getSetting<MemoryUiSettings['recallMode']>('recallMode'),
      this.repository.getSetting<MemoryUiSettings['rerankMode']>('rerankMode'),
    ]);
    this.settings = {
      enabled: enabled ?? DEFAULT_SETTINGS.enabled,
      autoOrganize: autoOrganize ?? DEFAULT_SETTINGS.autoOrganize,
      maxRecallItems: clampMaxItems(maxRecallItems ?? DEFAULT_SETTINGS.maxRecallItems),
      promptMaxChars: clampPromptMaxChars(promptMaxChars ?? DEFAULT_SETTINGS.promptMaxChars),
      answerMode: answerMode === 'diagnostic' || answerMode === 'roleplay' ? answerMode : 'auto',
      recallMode: recallMode === 'lexical' || recallMode === 'vector' || recallMode === 'hybrid' ? recallMode : 'auto',
      rerankMode: rerankMode === 'off' || rerankMode === 'always' ? rerankMode : 'adaptive',
    };
  }

  private async previewRecall(input: Omit<RecallQuery, 'chatKey'> & { query: string }): Promise<RecallResult> {
    const chatKey = this.requireChatKey();
    const recallContext = await this.hostContext?.getRecallContext?.();
    const query: RecallQuery = {
      ...input,
      chatKey,
      maxItems: input.maxItems ?? this.settings.maxRecallItems,
      characterKeys: input.characterKeys ?? recallContext?.characterKeys ?? [],
      worldKeys: input.worldKeys ?? recallContext?.worldKeys ?? [],
    };
    const recallVersion = this.captureVersion;
    const result = await this.semanticRecall.recall(query, this.settings.recallMode, this.settings.rerankMode);
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
        ...(candidate.lexicalRank === undefined ? {} : { lexicalRank: candidate.lexicalRank }),
        ...(candidate.vectorRank === undefined ? {} : { vectorRank: candidate.vectorRank }),
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
    mode: 'initialize' | 'history' | 'incremental',
    resumeJob?: MemoryJob,
    selectedSourceGroups?: string[],
  ): Promise<void> {
    if (this.capturePromise) return this.capturePromise;
    this.capturePromise = this.runCapture(mode, resumeJob, selectedSourceGroups).finally(() => { this.capturePromise = null; });
    return this.capturePromise;
  }

  private async runCapture(
    mode: 'initialize' | 'history' | 'incremental',
    resumeJob?: MemoryJob,
    selectedSourceGroups?: string[],
  ): Promise<void> {
    if (!this.settings.enabled) return;
    const chatKey = this.requireChatKey();
    const captureVersion = this.captureVersion;
    const effectiveSelectedSourceGroups = resumeJob?.checkpoint.selectedSourceGroupIds ?? selectedSourceGroups;
    const allSources = selectSourceGroups(
      filterSourceBlocks(await this.collectSources(chatKey)),
      mode === 'incremental' ? undefined : effectiveSelectedSourceGroups,
    );
    this.assertCaptureCurrent(captureVersion, chatKey);
    const sources = mode === 'incremental' ? await this.onlyUnprocessedSources(chatKey, allSources) : allSources;
    if (sources.length === 0) {
      this.trigger.markFlushed(chatKey);
      return;
    }
    const allBatches = mode === 'incremental' ? [buildIncrementalBatch(sources)] : buildHistoryBatches(sources);
    const resumeBatchIndex = mode === 'incremental' ? 0 : resumeJob?.checkpoint.batchIndex ?? 0;
    const batches = allBatches.slice(resumeBatchIndex);
    if (batches.length === 0) return;
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
      },
      createdAt, updatedAt: Date.now(),
    });
    const service = new MemoryIngestService({
      extractor: new LlmMemoryExtractor(),
      commit: (commit) => {
        this.assertCaptureCurrent(captureVersion, chatKey);
        return this.repository.commit(commit);
      },
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
    };
    const processedMetadataRefs = new Set(resumeJob?.checkpoint.metadataSourceRefs ?? []);
    try {
      for (let index = 0; index < batches.length; index += 1) {
        const batch = batches[index]!;
        this.activeCaptureProgress = {
          status: 'running',
          jobId,
          batchIndex: resumeBatchIndex + index + 1,
          totalBatches: allBatches.length,
          processedCount,
          elapsedMs: Date.now() - this.captureStartedAt,
        };
        batch.filter((source) => source.kind !== 'message').forEach((source) => processedMetadataRefs.add(source.id));
        processedCount += Math.max(0, batch.length - (index === 0 ? 0 : 2));
        await service.ingest({
          chatKey,
          jobId,
          sources: batch,
          jobType: mode,
          jobStatus: index === batches.length - 1 ? 'completed' : 'paused',
          batchIndex: resumeBatchIndex + index + 1,
          totalBatches: allBatches.length,
          processedCount,
          metadataSourceRefs: [...processedMetadataRefs],
          ...(effectiveSelectedSourceGroups === undefined ? {} : { selectedSourceGroupIds: effectiveSelectedSourceGroups }),
        });
        checkpoint = {
          batchIndex: resumeBatchIndex + index + 1,
          totalBatches: allBatches.length,
          processedCount,
          lastSourceRef: batch.at(-1)?.id,
          overlapSourceRefs: batch.slice(-2).map((source) => source.id),
          metadataSourceRefs: [...processedMetadataRefs],
          ...(effectiveSelectedSourceGroups === undefined ? {} : { selectedSourceGroupIds: effectiveSelectedSourceGroups }),
        };
        await this.bindCurrentChat();
      }
      this.lastOrganizedAt = Date.now();
      this.status = 'ready';
      this.error = '';
      this.trigger.markFlushed(chatKey);
      this.activeCaptureProgress = {
        status: 'completed', jobId, batchIndex: allBatches.length, totalBatches: allBatches.length,
        processedCount, elapsedMs: Date.now() - this.captureStartedAt,
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
        this.status = this.settings.enabled ? 'ready' : 'disabled';
        this.activeCaptureProgress = {
          status: this.cancelRequested ? 'cancelled' : 'paused', jobId,
          batchIndex: checkpoint.batchIndex, totalBatches: allBatches.length,
          processedCount: checkpoint.processedCount, elapsedMs: Date.now() - this.captureStartedAt,
        };
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.error = message;
      this.status = 'error';
      await this.repository.putJob({
        id: jobId, chatKey, type: mode, status: 'failed',
        checkpoint, error: message, createdAt, updatedAt: Date.now(),
      });
      this.activeCaptureProgress = {
        status: 'failed', jobId, batchIndex: checkpoint.batchIndex, totalBatches: allBatches.length,
        processedCount: checkpoint.processedCount, elapsedMs: Date.now() - this.captureStartedAt, error: message,
      };
      throw error;
    }
  }

  private async onlyUnprocessedSources(chatKey: string, sources: SourceBlock[]): Promise<SourceBlock[]> {
    const completedSourceRefs = new Set(
      (await this.repository.listJobBatchAudits(chatKey)).flatMap(audit => audit.sourceRefs),
    );
    if (completedSourceRefs.size === 0) {
      const metadata = sources.filter(source => source.kind !== 'message');
      return [...metadata, ...sources.filter(source => source.kind === 'message').slice(-20)];
    }
    return sources.filter(source => !completedSourceRefs.has(source.id));
  }

  private async resumePausedWork(): Promise<void> {
    const chatKey = this.getChatKey();
    if (!chatKey || !this.settings.enabled) return;
    const paused = (await this.repository.listJobs(chatKey)).find((job) => job.status === 'paused');
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
