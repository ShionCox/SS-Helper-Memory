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
  type MemoryRecallRouteDiagnostics,
} from './ingest/llm-extractor';
import { MemoryIngestService } from './ingest/memory-ingest-service';
import { ExistingMemoryContextRetriever } from './ingest/existing-memory-context';
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
import { logger, traceMemoryStartup } from '../host/runtime-feedback';
import { describeMemoryError, type MemoryErrorDiagnostic } from '../diagnostics/memory-error';
import { ActorRegistry, ActiveCastResolver, MultiActorCaptureService, type ActorRegistryChangeAudit } from './actors';
import { ActorRecallService, RecallExposureTracker, auditKnowledgeLeakage, type KnowledgeLeakageAudit } from './recall';
import { buildActorMemoryPromptResult, type ActorMemoryPromptResult } from './prompt';
import { MultiActorMemoryRepository } from '../infrastructure';
import type { ActorRecallRequest, ActorRecallResponse, SceneCast } from '../domain';
import { StructuredMemoryCaptureExtractor } from './ingest/llm-extractor';
import { ProfileCoordinator } from './profile';
import { DreamCoordinator, type DreamApplyResult } from './dream';
import { buildMemoryRecallPacket } from './recall/memory-strength';
import type { ActorCandidate, ActorMemoryTrace, ProfileClaim, RelationshipClaim } from '../domain';

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
const MEMORY_RECALL_ROUTE_CACHE_TTL_MS = 5_000;

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

function isRetryableCaptureError(error: unknown): boolean {
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
  private actorCapturePromise: Promise<import('./actors').MultiActorCaptureResult> | null = null;
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
  private recallRouteDiagnostic: MemoryRecallRouteDiagnostics | undefined;
  private recallRouteDiagnosticAt = 0;
  private recallRouteDiagnosticPending: Promise<void> | undefined;
  private recallRouteProbeVersion = 0;
  private multiActorRepository: MultiActorMemoryRepository | null = null;
  private actorRegistry: ActorRegistry | null = null;
  private actorCapture: MultiActorCaptureService | null = null;
  private lastSceneCast: SceneCast | null = null;
  private lastActorRecall: ActorRecallResponse | null = null;
  private actorExposureTracker = new RecallExposureTracker();
  private readonly lastExposureIds = new Map<string, string>();
  private readonly actorCorrectionChangeSets = new Map<string, string>();
  private readonly profileCoordinator = new ProfileCoordinator();
  private readonly dreamCoordinator = new DreamCoordinator({ automaticApply: true });
  private readonly automaticDreamTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private generationActive = false;
  private rollbackActive = false;

  private readonly settingsListeners = new Set<(settings: MemoryUiSettings) => void>();
  private readonly overviewListeners = new Set<() => void>();

  constructor(readonly repository: MemoryRepository) {
    this.vectorIndex = new MemoryVectorIndexService(repository);
    this.graphService = new MemoryGraphService(repository);
    this.graphService.onStatusChanged((status) => {
      if (!this.stopped && status.chatKey === this.getChatKey()) this.emitSettingsChanged();
    });
    this.semanticRecall = new SemanticRecallService(this.recallIndex, this.vectorIndex, this.graphService);
    this.facts = {
      list: async (options) => {
        const chatKey = this.requireChatKey();
        if (this.multiActorRepository) return this.multiActorRepository.listFacts(options);
        return this.repository.listFacts(chatKey, options);
      },
      search: async (query, options) => {
        const chatKey = this.requireChatKey();
        if (this.multiActorRepository) {
          const needle = query.trim().toLocaleLowerCase();
          const facts = await this.multiActorRepository.listFacts(options ?? {});
          return needle ? facts.filter(fact => [fact.content, fact.canonicalKey, ...fact.entityKeys].some(value => value.toLocaleLowerCase().includes(needle))).slice(0, options?.limit ?? 50) : [];
        }
        return this.repository.searchFacts(chatKey, query, options?.limit);
      },
      upsert: async (input) => {
        if (this.multiActorRepository) {
          const fact = await this.multiActorRepository.upsertManualFact(input);
          this.recallIndex.upsert(fact);
          this.vectorIndex.scheduleSync(fact.chatKey);
          this.scheduleGraph(fact.chatKey);
          return fact;
        }
        const fact = await this.repository.upsertManualFact(this.requireChatKey(), input);
        this.recallIndex.upsert(fact);
        this.vectorIndex.scheduleSync(fact.chatKey);
        this.scheduleGraph(fact.chatKey);
        return fact;
      },
      remove: async (id) => {
        if (this.multiActorRepository) {
          const chatKey = this.requireChatKey();
          const removed = await this.multiActorRepository.removeFact(id);
          if (!removed) return;
          this.recallIndex.remove(id);
          this.scheduleGraph(chatKey);
          this.vectorIndex.scheduleSync(chatKey);
          return;
        }
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

  bindStorageScope(workspaceId: string, sourceChatKey: string): void {
    const workspace = (this.repository as unknown as { workspace?: unknown }).workspace;
    if (!workspace || typeof workspace !== 'object') return;
    this.repository.bind?.(workspaceId, sourceChatKey);
    this.multiActorRepository ??= new MultiActorMemoryRepository(workspace as import('@ss-helper/sdk').WorkspacePort);
    this.multiActorRepository.bind(workspaceId, sourceChatKey);
    this.actorRegistry = new ActorRegistry(workspaceId);
    this.actorCapture = new MultiActorCaptureService(this.actorRegistry, new StructuredMemoryCaptureExtractor(), this.multiActorRepository);
  }

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

  private currentRecallRouteDiagnostics(): MemoryRecallRouteDiagnostics | undefined {
    if (this.stopped) return this.recallRouteDiagnostic;
    const now = Date.now();
    const cacheFresh = this.recallRouteDiagnostic !== undefined
      && now - this.recallRouteDiagnosticAt < MEMORY_RECALL_ROUTE_CACHE_TTL_MS;
    if (!cacheFresh && this.recallRouteDiagnosticPending === undefined) {
      const probeVersion = this.recallRouteProbeVersion;
      const pending = readMemoryRecallRouteDiagnostics()
        .then((diagnostic) => {
          if (this.recallRouteProbeVersion !== probeVersion) return;
          this.recallRouteDiagnostic = diagnostic;
          this.recallRouteDiagnosticAt = Date.now();
        })
        .catch(() => {
          if (this.recallRouteProbeVersion !== probeVersion) return;
          this.recallRouteDiagnostic = {
            embedding: { available: false, blockedReason: '暂时无法读取 LLM 资源状态' },
            rerank: { available: false, blockedReason: '暂时无法读取 LLM 资源状态' },
          };
          this.recallRouteDiagnosticAt = Date.now();
        })
        .finally(() => {
          if (this.recallRouteDiagnosticPending === pending) this.recallRouteDiagnosticPending = undefined;
          if (!this.stopped && this.recallRouteProbeVersion === probeVersion) this.emitOverviewChanged();
        });
      this.recallRouteDiagnosticPending = pending;
    }
    return this.recallRouteDiagnostic;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.llmRouteDiagnostic = undefined;
    this.llmRouteDiagnosticPending = undefined;
    this.recallRouteProbeVersion += 1;
    this.recallRouteDiagnostic = undefined;
    this.recallRouteDiagnosticAt = 0;
    this.recallRouteDiagnosticPending = undefined;
    try {
      await this.repository.open();
      if (this.multiActorRepository) await this.multiActorRepository.open();
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
    this.recallRouteProbeVersion += 1;
    this.captureVersion += 1;
    this.bindVersion += 1;
    this.recallIndex.replace([]);
    this.clearAutomaticDreamTimers();
    this.generationActive = false;
    this.vectorIndex.stop();
    this.repository.close();
    this.sqliteAvailable = false;
  }

  getChatKey(): string {
    return this.hostContext?.getChatKey() ?? '';
  }

  /** Host generation is an idle-gate input for automatic Dream Apply. */
  setGenerationActive(active: boolean): void {
    this.generationActive = active;
    if (active) this.clearAutomaticDreamTimers();
    else if (!this.stopped) {
      const chatKey = this.getChatKey();
      for (const job of this.dreamCoordinator.listJobs().filter(item => (item.status === 'queued' || item.status === 'running') && item.chatKey === chatKey)) {
        this.scheduleAutomaticDream(job.id, chatKey, job.ownerId);
      }
    }
  }

  /** Captures the current card/world/chat into the new multi-owner model. */
  async captureActors(): Promise<import('./actors').MultiActorCaptureResult> {
    this.assertStorageAvailable('Capture');
    if (this.actorCapturePromise) return this.actorCapturePromise;
    this.actorCapturePromise = this.runActorCapture().finally(() => { this.actorCapturePromise = null; });
    return this.actorCapturePromise;
  }

  private assertStorageAvailable(operation: string): void {
    if (this.sqliteAvailable) return;
    const error = Object.assign(
      new Error(this.error || `Memory workspace 不可用，无法执行${operation}。`),
      { code: this.errorDiagnostic?.code ?? 'SQLITE_SERVICE_UNAVAILABLE' },
    );
    throw error;
  }

  private async runActorCapture(sourceOverride?: readonly SourceBlock[], includeInvisibleHistory = false, captureJobId?: string): Promise<import('./actors').MultiActorCaptureResult> {
    const capture = this.actorCapture;
    const context = this.hostContext;
    if (!capture || !context) throw new Error('多角色 Memory 尚未绑定宿主工作区。');
    const chatKey = this.getChatKey();
    const captureVersion = this.captureVersion;
    const sources = sourceOverride ? [...sourceOverride] : await context.collectSources(chatKey);
    const currentFloor = Math.max(0, ...sources.map(source => source.floor ?? 0));
    const previousTraces = await this.multiActorRepository?.listTraces() ?? [];
    const result = await capture.capture({ workspaceId: this.hostContext?.getWorkspaceId() ?? '', chatKey, sources, currentFloor, includeInvisibleHistory, ...(captureJobId ? { captureJobId } : {}) });
    if (this.stopped || this.captureVersion !== captureVersion || this.getChatKey() !== chatKey) {
      if (result.changeAudit?.id && this.multiActorRepository) await this.multiActorRepository.rollbackChangeSet(result.changeAudit.id).catch(() => undefined);
      throw new Error('聊天已切换，Capture 结果已丢弃。');
    }
    this.lastSceneCast = result.sceneCast;
    // Keep the objective candidate index in sync with the v0 actor facts. The
    // owner/trace filter remains downstream in ActorRecallService; this index
    // only answers which facts are relevant to the query.
    for (const fact of result.facts) this.recallIndex.upsert(fact);
    // Actor Capture writes canonical facts in the v0 transaction; vector and
    // relationship indexes remain asynchronous derived projections and must be
    // queued explicitly so the next recall sees the new objective candidates.
    const effectiveSettings = this.getEffectiveSettings();
    if (usesVectorIndex(effectiveSettings)) this.vectorIndex.scheduleSync(chatKey);
    if (effectiveSettings.graphEnabled) this.scheduleGraph(chatKey);
    const persistedTraces = await this.persistCaptureDerivations(result, chatKey);
    if (this.stopped || this.captureVersion !== captureVersion || this.getChatKey() !== chatKey) {
      if (result.changeAudit?.id && this.multiActorRepository) await this.multiActorRepository.rollbackChangeSet(result.changeAudit.id).catch(() => undefined);
      throw new Error('聊天已切换，Capture 派生结果已丢弃。');
    }
    this.actorExposureTracker = new RecallExposureTracker([...previousTraces, ...persistedTraces]);
    this.lastExposureIds.clear();
    const activeActorIds = new Set([...result.sceneCast.presentOwnerIds, ...result.sceneCast.speakerOwnerIds].filter(ownerId => ownerId.startsWith('owner:actor:')));
    const changedActorIds = new Set(result.traces.map(trace => trace.ownerId).filter(ownerId => ownerId.startsWith('owner:actor:')));
    // A card/world seed may be the only new evidence for an actor that is not
    // currently in the cast. It is allowed to bootstrap that actor's profile;
    // a merely mentioned/present actor with no new trace is not.
    const seededActorIds = new Set(result.facts
      .filter(fact => Boolean(fact.scope?.hostCardKeys?.length || fact.scope?.worldKeys?.length))
      .flatMap(fact => fact.entityKeys.filter(ownerId => ownerId.startsWith('owner:actor:'))));
    const profileActorIds = new Set([...activeActorIds].filter(ownerId => changedActorIds.has(ownerId)).concat([...seededActorIds]));
    try {
      this.assertCaptureCurrent(captureVersion, chatKey);
      for (const ownerId of profileActorIds) {
        await this.updateActorProfile(ownerId, result.changeAudit?.id).catch(error => logger.warn('人物画像派生失败。', error));
        this.assertCaptureCurrent(captureVersion, chatKey);
      }
      for (const owner of result.owners.filter(item => item.kind === 'actor' && activeActorIds.has(item.id))) {
        this.assertCaptureCurrent(captureVersion, chatKey);
        const ownerTraceIds = persistedTraces.filter(trace => trace.ownerId === owner.id).map(trace => trace.id);
        const existingJobs = this.multiActorRepository ? await this.multiActorRepository.listDerived('dream-jobs', owner.id) : [];
        const activeJob = existingJobs.find(job => job.status === 'queued' || job.status === 'running');
        if (activeJob) {
          this.scheduleAutomaticDream(String(activeJob.id), chatKey, owner.id);
          continue;
        }
        const latestApplied = existingJobs.filter(job => job.status === 'applied' || job.status === 'rolled-back').sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0))[0];
        const previousIds = new Set(Array.isArray(latestApplied?.traceIds) ? latestApplied.traceIds.map(String) : []);
        // Trace identity is ownerId + factId and therefore remains stable when
        // a later observation changes the same fact. Count both new trace ids
        // and revisions written after the last applied/rolled-back Dream so
        // “20 条新增/变化 Trace” does not miss repeated observations.
        const baselineTraceUpdatedAt = Number(latestApplied?.updatedAt ?? latestApplied?.createdAt ?? 0);
        const changedTraceIds = new Set(persistedTraces
          .filter(trace => trace.ownerId === owner.id && (!latestApplied || !previousIds.has(trace.id) || trace.updatedAt > baselineTraceUpdatedAt))
          .map(trace => trace.id));
        const addedTraceCount = changedTraceIds.size;
        const previousFloor = Number(latestApplied?.visibleFloor ?? currentFloor);
        const visibleFloorCount = Math.max(0, currentFloor - (Number.isFinite(previousFloor) ? previousFloor : currentFloor));
        const salient = Math.max(0, ...persistedTraces.filter(trace => changedTraceIds.has(trace.id)).map(trace => trace.emotionalSalience > 1 ? trace.emotionalSalience / 100 : trace.emotionalSalience));
        if (!this.dreamCoordinator.shouldTrigger({ ownerId: owner.id, addedTraceCount, visibleFloorCount, salient })) continue;
        const trigger: import('../domain').DreamJob['trigger'] = salient >= 0.85 ? 'salience' : addedTraceCount >= this.dreamCoordinator.options.traceThreshold ? 'trace-count' : 'floor-count';
        try {
          const job = this.dreamCoordinator.enqueue({ workspaceId: this.hostContext?.getWorkspaceId() ?? '', chatKey, ownerId: owner.id, traceIds: ownerTraceIds, trigger });
          if (this.multiActorRepository) await this.multiActorRepository.upsertDerived('dream-jobs', [{ ...job, visibleFloor: currentFloor, ...(result.changeAudit?.id ? { sourceChangeSetId: result.changeAudit.id } : {}) }]);
          this.assertCaptureCurrent(captureVersion, chatKey);
          this.scheduleAutomaticDream(job.id, chatKey, owner.id);
        } catch (error) {
          // Dream is a derived, retryable projection. A queue/index failure must
          // never turn an already committed Capture into a failed chat write.
          if (this.stopped || this.captureVersion !== captureVersion || this.getChatKey() !== chatKey) throw error;
          logger.warn('自动 Dream 入队失败，已保留 Capture 结果。', error);
        }
      }
    } catch (error) {
      if ((this.stopped || this.captureVersion !== captureVersion || this.getChatKey() !== chatKey) && result.changeAudit?.id && this.multiActorRepository) {
        await this.multiActorRepository.rollbackChangeSet(result.changeAudit.id).catch(() => undefined);
      }
      throw error;
    }
    return result;
  }

  /** Dream only applies after the host has been quiet for the configured idle window. */
  private scheduleAutomaticDream(jobId: string, chatKey: string, ownerId: string, attempt = 0): void {
    const previous = this.automaticDreamTimers.get(ownerId);
    if (previous !== undefined) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.automaticDreamTimers.delete(ownerId);
      if (this.stopped || this.getChatKey() !== chatKey || this.generationActive || this.capturePromise || this.actorCapturePromise || this.rollbackActive) {
        if (!this.stopped && this.getChatKey() === chatKey) this.scheduleAutomaticDream(jobId, chatKey, ownerId);
        return;
      }
      void this.runActorDream(jobId).catch((error) => {
        logger.warn('自动 Dream 失败，将按指数退避重试。', error);
        if (!this.stopped && this.getChatKey() === chatKey) this.scheduleAutomaticDream(jobId, chatKey, ownerId, attempt + 1);
      });
    }, Math.max(0, this.dreamCoordinator.options.idleMs * (2 ** Math.min(attempt, 6))));
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as unknown as { unref?: () => void }).unref?.();
    }
    this.automaticDreamTimers.set(ownerId, timer);
  }

  private clearAutomaticDreamTimers(): void {
    for (const timer of this.automaticDreamTimers.values()) clearTimeout(timer);
    this.automaticDreamTimers.clear();
  }

  private async persistCaptureDerivations(
    result: import('./actors').MultiActorCaptureResult,
    chatKey: string,
  ): Promise<readonly ActorMemoryTrace[]> {
    const repository = this.multiActorRepository;
    if (!repository) return result.traces;
    const traces = await repository.listTraces();
    const factsById = new Map(result.facts.map(fact => [fact.id, fact]));
    const ownersById = new Map((this.actorRegistry?.listOwners() ?? []).map(owner => [owner.id, owner]));
    const parent = result.changeAudit?.id;
    const details: Record<string, unknown>[] = [];
    const links = new Map<string, Record<string, unknown>>();
    const vectors = new Map<string, Record<string, unknown>>();
    const graphNodes = new Map<string, Record<string, unknown>>();
    const graphEdges = new Map<string, Record<string, unknown>>();
    for (const trace of traces) {
      const fact = factsById.get(trace.factId);
      if (!fact) continue;
      const packet = buildMemoryRecallPacket(trace, fact, Date.now(), String(result.sceneCast.floor), {
        traits: ownersById.get(trace.ownerId)?.memoryTraits,
      });
      for (const detail of packet?.details ?? []) details.push({ ...detail, workspaceId: repository.boundWorkspaceId, chatKey, ...(parent ? { sourceChangeSetId: parent } : {}) });
      // A fact has one objective vector regardless of how many owners have a
      // trace for it. Keeping this keyed by fact id prevents a single ChangeSet
      // from submitting duplicate records with the same id/version.
      vectors.set(`vector:${fact.id}`, { id: `vector:${fact.id}`, workspaceId: repository.boundWorkspaceId, chatKey, recordId: fact.id, state: 'pending', updatedAt: Date.now(), ...(parent ? { sourceChangeSetId: parent } : {}) });
      for (const entityKey of fact.entityKeys) {
        const nodeId = `graph-node:${repository.boundWorkspaceId}:${encodeURIComponent(chatKey)}:${encodeURIComponent(entityKey)}`;
        graphNodes.set(nodeId, { id: nodeId, workspaceId: repository.boundWorkspaceId, chatKey, entityKey, kind: entityKey.startsWith('owner:') ? 'actor' : 'entity', updatedAt: Date.now(), ...(parent ? { sourceChangeSetId: parent } : {}) });
      }
      if (fact.objectEntityId || fact.objectKey) {
        const fromNodeId = `graph-node:${repository.boundWorkspaceId}:${encodeURIComponent(chatKey)}:${encodeURIComponent(fact.subjectEntityId ?? fact.subjectKey)}`;
        const toNodeId = `graph-node:${repository.boundWorkspaceId}:${encodeURIComponent(chatKey)}:${encodeURIComponent(String(fact.objectEntityId ?? fact.objectKey))}`;
        const edgeId = `graph-edge:${fact.id}`;
        graphEdges.set(edgeId, { id: edgeId, workspaceId: repository.boundWorkspaceId, chatKey, fromNodeId, toNodeId, backingFactId: fact.id, relation: fact.predicateKey, updatedAt: Date.now(), ...(parent ? { sourceChangeSetId: parent } : {}) });
        // Links are owner/trace scoped; the same fact may be known by several
        // owners and must not overwrite another owner's relationship edge.
        links.set(`memory-link:${trace.id}`, { id: `memory-link:${trace.id}`, workspaceId: repository.boundWorkspaceId, chatKey, ownerId: trace.ownerId, factId: fact.id, traceIds: [trace.id], fromNodeId, toNodeId, relation: fact.predicateKey, updatedAt: Date.now(), ...(parent ? { sourceChangeSetId: parent } : {}) });
      }
    }
    const groups = [
      { collection: 'memory-details' as const, records: details },
      { collection: 'memory-links' as const, records: [...links.values()] },
      { collection: 'vector-index' as const, records: [...vectors.values()] },
      { collection: 'graph-nodes' as const, records: [...graphNodes.values()] },
      { collection: 'graph-edges' as const, records: [...graphEdges.values()] },
    ].filter(group => group.records.length > 0);
    if (groups.length > 0) {
      if (parent) await repository.upsertDerivedForChangeSet(parent, groups);
      else for (const group of groups) await repository.upsertDerived(group.collection, group.records);
    }
    return traces;
  }

  /** Performs objective recall followed by owner/trace privacy filtering. */
  async recallActors(input: Omit<ActorRecallRequest, 'workspaceId' | 'chatKey' | 'scene'> & {
    scene?: SceneCast;
    chatKey?: string;
    sceneOwnerIds?: readonly string[];
    presentOwnerIds?: readonly string[];
    viewpointOwnerId?: string;
  }): Promise<ActorRecallResponse> {
    const actorRepository = this.multiActorRepository;
    const registry = this.actorRegistry;
    const context = this.hostContext;
    if (!actorRepository || !registry || !context) throw new Error('多角色 Memory 尚未绑定宿主工作区。');
    const chatKey = input.chatKey?.trim() || this.getChatKey();
    let scene = input.scene ?? this.lastSceneCast;
    if (scene && (scene.chatKey !== chatKey || scene.workspaceId !== context.getWorkspaceId())) scene = null;
    if (!scene) {
      const sources = await context.collectSources(chatKey);
      scene = new ActiveCastResolver(registry).resolve(sources, { currentFloor: Math.max(0, ...sources.map(source => source.floor ?? 0)) }).scene;
      this.lastSceneCast = scene;
    }
    if (input.sceneOwnerIds || input.presentOwnerIds || input.viewpointOwnerId) {
      scene = {
        ...scene,
        speakerOwnerIds: input.sceneOwnerIds ? [...input.sceneOwnerIds] : scene.speakerOwnerIds,
        presentOwnerIds: input.presentOwnerIds ? [...input.presentOwnerIds] : scene.presentOwnerIds,
        mentionedOwnerIds: [...new Set([...scene.mentionedOwnerIds, ...(input.sceneOwnerIds ?? []), ...(input.presentOwnerIds ?? [])])],
        viewpointOwnerId: input.viewpointOwnerId ?? scene.viewpointOwnerId,
      };
    }
    const settings = this.getEffectiveSettings();
    const service = new ActorRecallService({
      recallObjective: query => this.semanticRecall.recall(query, settings.recallMode, settings.rerankMode === 'off' ? 'off' : settings.rerankMode, { maxHops: settings.graphMaxHops, maxEdges: settings.graphMaxEdges }),
      listTraces: (workspaceId, currentChatKey) => actorRepository.listTraces(),
      getFact: factId => actorRepository.getFact(factId),
      getOwner: ownerId => actorRepository.getOwner(ownerId),
    });
    const result = await service.recall({ ...input, workspaceId: context.getWorkspaceId(), chatKey, scene });
    this.lastActorRecall = result;
    return result;
  }

  auditActorOutput(output: string): KnowledgeLeakageAudit | null {
    if (!this.lastActorRecall) return null;
    const rehearsed: import('../domain').ActorMemoryTrace[] = [];
    const usedExposures: import('../domain').RecallExposure[] = [];
    const segments = new Map<string, string>();
    for (const match of output.matchAll(/<actor_memory\b[^>]*owner_id="([^"]+)"[^>]*>([\s\S]*?)<\/actor_memory>/gu)) segments.set(match[1]!, match[2]!);
    for (const partition of [this.lastActorRecall.world, this.lastActorRecall.narrator, ...this.lastActorRecall.actors]) {
      const labelled = output.split(/\r?\n/u).filter(line => line.trimStart().startsWith(`${partition.ownerName}:`) || line.trimStart().startsWith(`${partition.ownerName}：`)).join('\n');
      if (labelled) segments.set(partition.ownerId, `${segments.get(partition.ownerId) ?? ''}\n${labelled}`);
    }
    for (const partition of [this.lastActorRecall.world, this.lastActorRecall.narrator, ...this.lastActorRecall.actors]) {
      const ownerOutput = segments.get(partition.ownerId);
      if (!ownerOutput) continue;
      for (const packet of partition.packets) {
        const marker = [packet.gist, ...packet.details.map(detail => detail.text)].find(value => value.length >= 6 && ownerOutput.includes(value));
        if (!marker) continue;
        const exposureId = this.lastExposureIds.get(packet.traceId);
        if (!exposureId) continue;
        const explicitRecall = /(?:记得|回忆|想起|recall|remember)/iu.test(this.lastActorRecall.request.query);
        const updated = this.actorExposureTracker.markUsed(exposureId, Math.min(1, packet.effectiveStrength / 100), explicitRecall);
        usedExposures.push(updated.exposure);
        if (updated.trace) rehearsed.push(updated.trace);
      }
    }
    if (rehearsed.length > 0 && this.multiActorRepository) void this.multiActorRepository.upsertTraces(rehearsed).catch(() => undefined);
    if (usedExposures.length > 0 && this.multiActorRepository) void this.multiActorRepository.upsertDerived('recall-exposures', usedExposures.map(exposure => ({ ...exposure }))).catch(() => undefined);
    const audit = auditKnowledgeLeakage(output, [this.lastActorRecall.world, this.lastActorRecall.narrator, ...this.lastActorRecall.actors]);
    if (this.multiActorRepository) void this.multiActorRepository.recordKnowledgeLeakageAudit(audit).catch(() => undefined);
    return audit;
  }

  async buildActorMemoryPrompt(input: Omit<ActorRecallRequest, 'workspaceId' | 'chatKey' | 'scene'> & { scene?: SceneCast; chatKey?: string; maxChars?: number }): Promise<ActorMemoryPromptResult> {
    const response = await this.recallActors(input);
    const built = buildActorMemoryPromptResult(response, { maxChars: input.maxChars ?? this.getEffectiveSettings().promptMaxChars, sceneLabel: response.request.chatKey });
    if (this.multiActorRepository) {
      const sceneEpoch = response.request.sceneEpoch ?? String(response.request.scene.floor);
      const exposures = [...response.world.packets, ...response.narrator.packets, ...response.actors.flatMap(partition => partition.packets)].map(packet => {
        const exposure = this.actorExposureTracker.expose({
          workspaceId: response.request.workspaceId,
          chatKey: response.request.chatKey,
          ownerId: packet.ownerId,
          traceId: packet.traceId,
          sceneEpoch,
          included: built.includedTraceIds.includes(packet.traceId),
          used: false,
          confidence: packet.effectiveStrength / 100,
        });
        this.lastExposureIds.set(packet.traceId, exposure.id);
        return exposure;
      });
      await this.multiActorRepository.upsertDerived('recall-exposures', exposures.map(exposure => ({ ...exposure })));
    }
    return built;
  }

  async updateActorProfile(ownerId: string, sourceChangeSetId?: string): Promise<readonly import('../domain').ProfileClaim[]> {
    const repository = this.multiActorRepository;
    if (!repository) throw new Error('多角色 Memory 尚未绑定宿主工作区。');
    const currentClaims = (await repository.listDerived('profile-claims', ownerId)).filter(value => typeof value.id === 'string' && value.ownerId === ownerId && typeof value.claim === 'string') as unknown as ProfileClaim[];
    const result = this.profileCoordinator.update(ownerId, await repository.listTraces(ownerId), await repository.listFacts(), currentClaims, repository.boundWorkspaceId);
    const claims = result.claims.map(claim => ({ ...claim, workspaceId: repository.boundWorkspaceId, ...(sourceChangeSetId ? { sourceChangeSetId } : {}) }));
    const relationships = result.relationships.map(item => ({ ...item, ...(sourceChangeSetId ? { sourceChangeSetId } : {}) }));
    const groups = [
      ...(claims.length > 0 ? [{ collection: 'profile-claims' as const, records: claims }] : []),
      ...(relationships.length > 0 ? [{ collection: 'relationship-claims' as const, records: relationships }] : []),
    ];
    if (groups.length > 0) {
      if (sourceChangeSetId) await repository.upsertDerivedForChangeSet(sourceChangeSetId, groups);
      else for (const group of groups) await repository.upsertDerived(group.collection, group.records);
    }
    return result.claims;
  }

  async enqueueActorDream(ownerId: string, traceIds: readonly string[] = []): Promise<import('../domain').DreamJob> {
    const repository = this.multiActorRepository;
    if (!repository) throw new Error('多角色 Memory 尚未绑定宿主工作区。');
    const traces = await repository.listTraces(ownerId);
    const selected = traceIds.length > 0 ? traceIds : traces.map(trace => trace.id);
    const job = this.dreamCoordinator.enqueue({ workspaceId: repository.boundWorkspaceId, chatKey: repository.boundChatKey, ownerId, traceIds: selected, trigger: 'manual' });
    await repository.upsertDerived('dream-jobs', [{ ...job }]);
    return job;
  }

  async runActorDream(jobId: string, options: { readonly dryRun?: boolean; readonly narrative?: boolean } = {}): Promise<import('../application/dream').DreamAudit> {
    const repository = this.multiActorRepository;
    if (!repository) throw new Error('多角色 Memory 尚未绑定宿主工作区。');
    const job = this.dreamCoordinator.listJobs().find(item => item.id === jobId);
    if (!job) throw new Error('Dream job 不存在。');
    const traces = await repository.listTraces(job.ownerId);
    const facts = await repository.listFacts();
    const persistedJob = (await repository.listDerived('dream-jobs', job.ownerId)).find(item => item.id === jobId);
    const visibleFloor = Number(persistedJob?.visibleFloor);
    const existingClaims = (await repository.listDerived('profile-claims', job.ownerId)) as unknown as ProfileClaim[];
    const profile = this.profileCoordinator.update(job.ownerId, traces, facts, existingClaims, repository.boundWorkspaceId);
    const result = await this.dreamCoordinator.run(jobId, traces, async (apply: DreamApplyResult) => {
      const profileClaims = profile.claims.map(claim => ({ ...claim, workspaceId: repository.boundWorkspaceId }));
      const links = apply.links.map(link => ({ ...link, workspaceId: repository.boundWorkspaceId, chatKey: repository.boundChatKey }));
      const change = await repository.upsertDerivedWithAudit([
        { collection: 'profile-claims', records: profileClaims },
        { collection: 'memory-links', records: links },
      ], 'dream-change-set-v0', { jobId: job.id, ownerId: job.ownerId });
      return { profileClaims, links, changeSetId: change.id, undoToken: change.id };
    }, options);
    const finalJob = {
      ...result.job,
      workspaceId: repository.boundWorkspaceId,
      chatKey: repository.boundChatKey,
      ...(Number.isFinite(visibleFloor) ? { visibleFloor } : {}),
    };
    const finalAudit = { ...result.audit, workspaceId: repository.boundWorkspaceId, chatKey: repository.boundChatKey, ...(result.audit.changeSetId ? { changeSetId: result.audit.changeSetId } : {}) };
    const finalGroups = [
      { collection: 'dream-jobs' as const, records: [finalJob] },
      { collection: 'dream-audits' as const, records: [finalAudit] },
      ...(result.narrative ? [{ collection: 'dream-narratives' as const, records: [{ ...result.narrative, workspaceId: repository.boundWorkspaceId, chatKey: repository.boundChatKey }] }] : []),
    ];
    if (result.audit.changeSetId) await repository.upsertDerivedForChangeSet(result.audit.changeSetId, finalGroups);
    else await repository.upsertDerivedWithAudit(finalGroups, 'dream-change-set-v0', { jobId: job.id, ownerId: job.ownerId });
    return result.audit;
  }

  async listActors(): Promise<readonly import('../domain').MemoryOwner[]> {
    return this.multiActorRepository ? this.multiActorRepository.listOwners() : [];
  }

  async listPendingActorCandidates(): Promise<readonly ActorCandidate[]> {
    return this.actorRegistry?.listPending() ?? [];
  }

  async listActorCorrectionReviews(): Promise<readonly import('../ui/memory-ui').ActorCorrectionReview[]> {
    return (this.actorRegistry?.listAudits() ?? []).map(audit => ({
      id: audit.id,
      operation: audit.operation === 'confirm' || audit.operation === 'update-traits' ? 'correction' : audit.operation === 'correct-alias' ? 'alias' : audit.operation,
      status: audit.undoneAt ? 'undone' : 'applied',
      ownerIds: [...new Set([...audit.beforeOwners.map(owner => owner.id)])],
      createdAt: audit.createdAt,
    }));
  }

  private async persistActorRegistryChange(metadata: Record<string, unknown> = {}): Promise<void> {
    if (!this.actorRegistry || !this.multiActorRepository) return;
    const registryAudit = this.actorRegistry.listAudits().at(-1);
    const persistedMetadata = registryAudit ? { ...metadata, registryAudit: structuredClone(registryAudit) } : metadata;
    const audit = await this.multiActorRepository.upsertActorRegistryState(
      this.actorRegistry.listOwners(),
      this.actorRegistry.listAliases(),
      persistedMetadata,
      undefined,
      this.actorRegistry.listPending(),
    );
    const registryAuditId = typeof metadata.registryAuditId === 'string' ? metadata.registryAuditId : undefined;
    if (registryAuditId) this.actorCorrectionChangeSets.set(registryAuditId, audit.id);
  }

  async confirmActorCandidate(candidateId: string, canonicalName?: string): Promise<void> {
    if (!this.actorRegistry) throw new Error('人物注册表尚未就绪。');
    if (!this.actorRegistry.confirm(candidateId, canonicalName)) throw new Error('待确认人物不存在。');
    const registryAuditId = this.actorRegistry.listAudits().at(-1)?.id;
    await this.persistActorRegistryChange({ operation: 'confirm', candidateId, ...(registryAuditId ? { registryAuditId } : {}) });
  }

  async resolveActorCorrection(auditId: string, action: 'confirm' | 'undo'): Promise<void> {
    if (!this.actorRegistry) throw new Error('人物注册表尚未就绪。');
    if (action === 'undo') {
      const changeSetId = this.actorCorrectionChangeSets.get(auditId);
      if (!this.actorRegistry.undo(auditId)) throw new Error('人物纠正审计不存在或已撤销。');
      if (changeSetId && this.multiActorRepository) await this.multiActorRepository.rollbackChangeSet(changeSetId);
    }
    await this.persistActorRegistryChange({ operation: action, auditId });
  }

  async mergeActors(fromOwnerId: string, intoOwnerId: string): Promise<void> {
    if (!this.actorRegistry) throw new Error('人物注册表尚未就绪。');
    this.actorRegistry.merge(fromOwnerId, intoOwnerId);
    const registryAuditId = this.actorRegistry.listAudits().at(-1)?.id;
    if (this.actorRegistry && this.multiActorRepository) {
      const latest = this.actorRegistry.listAudits().at(-1);
      const audit = await this.multiActorRepository.upsertActorRegistryState(
        this.actorRegistry.listOwners(),
        this.actorRegistry.listAliases(),
        { operation: 'merge', fromOwnerId, intoOwnerId, ...(registryAuditId ? { registryAuditId } : {}), ...(latest ? { registryAudit: structuredClone(latest) } : {}) },
        { fromOwnerId, toOwnerId: intoOwnerId },
        this.actorRegistry.listPending(),
      );
      if (registryAuditId) this.actorCorrectionChangeSets.set(registryAuditId, audit.id);
    }
  }

  async splitActor(ownerId: string, aliasValue: string, displayName?: string): Promise<void> {
    if (!this.actorRegistry) throw new Error('人物注册表尚未就绪。');
    this.actorRegistry.split(ownerId, aliasValue, displayName);
    const registryAuditId = this.actorRegistry.listAudits().at(-1)?.id;
    await this.persistActorRegistryChange({ operation: 'split', ownerId, aliasValue, ...(registryAuditId ? { registryAuditId } : {}) });
  }

  async renameActor(ownerId: string, displayName: string): Promise<void> {
    if (!this.actorRegistry) throw new Error('人物注册表尚未就绪。');
    this.actorRegistry.rename(ownerId, displayName);
    const registryAuditId = this.actorRegistry.listAudits().at(-1)?.id;
    await this.persistActorRegistryChange({ operation: 'rename', ownerId, ...(registryAuditId ? { registryAuditId } : {}) });
  }

  async updateActorMemoryTraits(ownerId: string, traits: import('../domain').MemoryTraits): Promise<void> {
    if (!this.actorRegistry) throw new Error('人物注册表尚未就绪。');
    this.actorRegistry.updateMemoryTraits(ownerId, traits);
    const registryAuditId = this.actorRegistry.listAudits().at(-1)?.id;
    await this.persistActorRegistryChange({ operation: 'update-traits', ownerId, ...(registryAuditId ? { registryAuditId } : {}) });
  }

  async correctActorAlias(aliasId: string, ownerId: string): Promise<void> {
    if (!this.actorRegistry) throw new Error('人物注册表尚未就绪。');
    this.actorRegistry.correctAlias(aliasId, ownerId);
    const registryAuditId = this.actorRegistry.listAudits().at(-1)?.id;
    await this.persistActorRegistryChange({ operation: 'correct-alias', aliasId, ownerId, ...(registryAuditId ? { registryAuditId } : {}) });
  }

  async rollbackActorCapture(auditId: string): Promise<void> {
    if (!this.multiActorRepository) throw new Error('多角色 Memory 尚未绑定宿主工作区。');
    this.rollbackActive = true;
    try {
      const persistedAudit = (await this.multiActorRepository.listChangeAudits()).find(record => String(record.id ?? '') === auditId);
      const affectedFactIds = persistedAudit && Array.isArray(persistedAudit.entries)
        ? persistedAudit.entries
          .filter(entry => entry && typeof entry === 'object' && String((entry as Record<string, unknown>).collection ?? '') === 'facts')
          .map(entry => String((entry as Record<string, unknown>).recordId ?? ''))
          .filter(Boolean)
        : [];
      const invalidatedDreamJobs = (await this.multiActorRepository.listDerived('dream-jobs'))
        .filter(job => String(job.sourceChangeSetId ?? '') === auditId)
        .map(job => ({ id: String(job.id ?? ''), ownerId: String(job.ownerId ?? '') }))
        .filter(job => job.id && job.ownerId);
      await this.multiActorRepository.rollbackChangeSet(auditId);
      for (const job of invalidatedDreamJobs) this.dreamCoordinator.forgetJob(job.id);
      this.clearAutomaticDreamTimers();
      for (const job of await this.multiActorRepository.listDerived('dream-jobs')) {
        if ((job.status === 'queued' || job.status === 'running') && typeof job.id === 'string' && typeof job.ownerId === 'string') this.scheduleAutomaticDream(job.id, this.getChatKey(), job.ownerId);
      }
      this.recallIndex.replace(await this.multiActorRepository.listFacts());
      this.lastSceneCast = null;
      this.lastActorRecall = null;
      this.actorExposureTracker = new RecallExposureTracker(await this.multiActorRepository.listTraces());
      this.lastExposureIds.clear();
      if (affectedFactIds.length > 0) {
        await this.vectorIndex.rebuildFacts(this.getChatKey(), [...new Set(affectedFactIds)]).catch(() => this.vectorIndex.scheduleSync(this.getChatKey()));
      }
      this.scheduleGraph(this.getChatKey());
    } finally {
      this.rollbackActive = false;
    }
  }

  async listSceneCasts(): Promise<readonly SceneCast[]> {
    return this.multiActorRepository ? this.multiActorRepository.listSceneCasts() : [];
  }

  async listActorTraces(ownerId?: string): Promise<readonly import('../domain').ActorMemoryTrace[]> {
    return this.multiActorRepository ? this.multiActorRepository.listTraces(ownerId) : [];
  }

  async listActorProfiles(ownerId?: string): Promise<readonly Record<string, unknown>[]> {
    return this.multiActorRepository ? this.multiActorRepository.listDerived('profile-claims', ownerId) : [];
  }

  async listActorDreams(ownerId?: string): Promise<readonly Record<string, unknown>[]> {
    return this.multiActorRepository ? this.multiActorRepository.listDerived('dream-jobs', ownerId) : [];
  }

  async rollbackActorDream(auditId: string): Promise<void> {
    const previous = this.dreamCoordinator.listAudits().find(audit => audit.id === auditId);
    const repository = this.multiActorRepository;
    if (!repository) throw new Error('多角色 Memory 尚未绑定宿主工作区。');
    this.rollbackActive = true;
    try {
      const persisted = (await repository.listDerived('dream-audits')).find(item => item.id === auditId) as (import('../application/dream').DreamAudit & { changeSetId?: string }) | undefined;
      const changeSetId = previous?.changeSetId ?? persisted?.changeSetId;
      if (changeSetId) await repository.rollbackChangeSet(changeSetId);
      // After a restart the in-memory coordinator may not have hydrated an
      // audit that is already persisted.  The repository ChangeSet is the
      // authoritative rollback in that case; do not turn a successful
      // persisted undo into a false "audit missing" failure.
      if (previous) await this.dreamCoordinator.rollback(auditId, async () => undefined);
      const rolled = previous ? { ...previous, status: 'rolled-back', rolledBackAt: Date.now() } : persisted ? { ...persisted, status: 'rolled-back', rolledBackAt: Date.now() } : undefined;
      if (rolled) await repository.upsertDerived('dream-audits', [{ ...rolled, workspaceId: repository.boundWorkspaceId, chatKey: repository.boundChatKey }]);
      if (previous) {
        const job = this.dreamCoordinator.listJobs().find(item => item.id === previous.jobId);
        if (job) await repository.upsertDerived('dream-jobs', [{ ...job, status: 'rolled-back', updatedAt: Date.now(), workspaceId: repository.boundWorkspaceId, chatKey: repository.boundChatKey }]);
      }
    } finally {
      this.rollbackActive = false;
    }
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
    const hasWorkspacePort = Boolean((this.repository as unknown as { workspace?: unknown }).workspace);
    const actorScopeChanged = hasWorkspacePort && (this.multiActorRepository === null
      || this.multiActorRepository.boundWorkspaceId !== workspaceId
      || this.multiActorRepository.boundChatKey !== chatKey);
    this.repository.bind?.(workspaceId, chatKey);
    if (actorScopeChanged) this.bindStorageScope(workspaceId, chatKey);
    else this.multiActorRepository?.bind(workspaceId, chatKey);
    if (this.multiActorRepository && actorScopeChanged && workspaceId) {
      this.actorCorrectionChangeSets.clear();
      // WorkspacePort open/defineCollection is idempotent. Re-open on a chat
      // or group switch so the new v0 collections are ready before Capture.
      await this.multiActorRepository.open();
      if (this.actorRegistry) {
        const [owners, aliases, pendingCandidates, persistedAudits] = await Promise.all([
          this.multiActorRepository.listOwners().catch(() => []),
          this.multiActorRepository.listAliases().catch(() => []),
          this.multiActorRepository.listPendingCandidates().catch(() => []),
          this.multiActorRepository.listChangeAudits().catch(() => []),
        ]);
        this.actorRegistry.hydrate(owners, aliases);
        this.actorRegistry.hydratePending(pendingCandidates);
        const registryAudits = persistedAudits
          .map(record => record.metadata && typeof record.metadata === 'object' ? (record.metadata as Record<string, unknown>).registryAudit : undefined)
          .filter((value): value is ActorRegistryChangeAudit => Boolean(value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string'));
        this.actorRegistry.hydrateAudits(registryAudits);
        for (const record of persistedAudits) {
          const metadata = record.metadata && typeof record.metadata === 'object' ? record.metadata as Record<string, unknown> : undefined;
          const registryAudit = metadata?.registryAudit;
          if (registryAudit && typeof registryAudit === 'object' && typeof (registryAudit as { id?: unknown }).id === 'string') {
            const registryId = String((registryAudit as { id: string }).id);
            const existingChangeSet = this.actorCorrectionChangeSets.get(registryId);
            const existingRecord = existingChangeSet ? persistedAudits.find(item => String(item.id) === existingChangeSet) : undefined;
            if (!existingRecord || Number(record.createdAt ?? 0) >= Number(existingRecord.createdAt ?? 0)) this.actorCorrectionChangeSets.set(registryId, String(record.id));
          }
        }
      }
    }
    if (actorScopeChanged && !workspaceId) this.actorCorrectionChangeSets.clear();
    if (this.boundScopeKey !== scopeKey) {
      this.captureVersion += 1;
      this.clearAutomaticDreamTimers();
      this.lastSceneCast = null;
      this.lastActorRecall = null;
      this.actorExposureTracker = new RecallExposureTracker();
      this.lastExposureIds.clear();
      this.dreamCoordinator.reset();
    }
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
        if (this.multiActorRepository) await this.multiActorRepository.open();
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
      const actorFacts = this.multiActorRepository && chatKey
        ? await this.multiActorRepository.listFacts().catch(() => [] as import('../domain').MemoryFact[])
        : [];
      if (this.multiActorRepository && chatKey) {
        const traces = await this.multiActorRepository.listTraces().catch(() => [] as ActorMemoryTrace[]);
        this.actorExposureTracker = new RecallExposureTracker(traces);
        const persistedDreamJobs = await this.multiActorRepository.listDerived('dream-jobs').catch(() => [] as Record<string, unknown>[]);
        this.dreamCoordinator.hydrateJobs(persistedDreamJobs.filter(job => typeof job.id === 'string' && typeof job.ownerId === 'string' && typeof job.workspaceId === 'string' && typeof job.chatKey === 'string' && typeof job.status === 'string' && typeof job.phase === 'string' && Array.isArray(job.traceIds)) as unknown as import('../domain').DreamJob[]);
        for (const job of persistedDreamJobs.filter(job => (job.status === 'queued' || job.status === 'running') && typeof job.id === 'string' && typeof job.ownerId === 'string')) this.scheduleAutomaticDream(String(job.id), chatKey, String(job.ownerId));
        const persistedDreamAudits = await this.multiActorRepository.listDerived('dream-audits').catch(() => [] as Record<string, unknown>[]);
        this.dreamCoordinator.hydrateAudits(persistedDreamAudits.filter(audit => typeof audit.id === 'string' && typeof audit.jobId === 'string' && typeof audit.ownerId === 'string') as unknown as import('../application/dream').DreamAudit[]);
      }
      const factsById = new Map<string, import('../domain').MemoryFact>();
      for (const fact of [...(bootstrap?.facts ?? []), ...actorFacts]) factsById.set(fact.id, fact);
      this.recallIndex.replace([...factsById.values()]);
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

  /**
   * Read capture progress from the active v0 repository.  The generic
   * MemoryRepository job facade is intentionally retained only for the
   * isolated legacy test double; a bound production workspace always takes
   * this branch and never reads the retired batch pipeline.
   */
  private async listCaptureJobs(chatKey: string): Promise<MemoryJob[]> {
    if (this.multiActorRepository) {
      return (await this.multiActorRepository.listCaptureJobs())
        .filter(record => String(record.chatKey ?? '') === chatKey)
        .filter(record => record.type === 'initialize' || record.type === 'incremental')
        .filter(record => record.checkpoint && typeof record.checkpoint === 'object')
        .map(record => record as unknown as MemoryJob);
    }
    return this.repository.listJobs(chatKey);
  }

  async retry(): Promise<void> {
    this.clearRuntimeError();
    const paused = (await this.listCaptureJobs(this.requireChatKey()))
      .filter((job) => job.status === 'paused')
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    await this.flushCapture(paused?.type ?? 'incremental', paused);
  }

  async getOverview(): Promise<MemoryUiOverview> {
    traceMemoryStartup('application:overview-begin');
    const chatKey = this.getChatKey();
    const recallRoutes = this.currentRecallRouteDiagnostics();
    const storage = this.repository.getHealthSnapshot();
    const currentChatSizeBytes = storage?.currentChatSizeBytes ?? 0;
    const currentChatUsageRatio = storage?.workspaceSizeBytes
      ? currentChatSizeBytes / storage.workspaceSizeBytes
      : 0;
    const degraded = (message = this.error, recallRoutes?: MemoryRecallRouteDiagnostics): MemoryUiOverview => {
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
      ...(recallRoutes ? { embedding: recallRoutes.embedding, rerank: recallRoutes.rerank } : {}),
      errorCode: diagnostic.code,
      error: diagnostic.reason,
      errorDiagnostic: diagnostic,
    });
    };
    if (!this.sqliteAvailable) {
      traceMemoryStartup('application:overview-degraded');
      return degraded(this.error, recallRoutes);
    }
    let facts: MemoryFact[] = [];
    let jobs: MemoryJob[] = [];
    let actorJobs: Array<Record<string, unknown>> = [];
    if (chatKey) {
      try {
        const [loadedFacts, loadedJobs, loadedActorJobs] = await Promise.all([
          this.multiActorRepository ? this.multiActorRepository.listFacts() : this.repository.listFacts(chatKey),
          this.listCaptureJobs(chatKey),
          this.multiActorRepository
            ? this.multiActorRepository.listDerived('dream-jobs')
            : Promise.resolve([] as Array<Record<string, unknown>>),
        ]);
        facts = loadedFacts;
        jobs = loadedJobs;
        actorJobs = loadedActorJobs;
        traceMemoryStartup('application:overview-records-ready');
      } catch (error) {
        this.recallIndex.replace([]);
        this.setRuntimeError(error, 'MEMORY_CHAT_READ_FAILED', 'chat-bind');
        traceMemoryStartup('application:overview-records-failed');
        return degraded(this.error, recallRoutes);
      }
    }
    const latestCompletedAt = [
      ...jobs.filter((job) => job.status === 'completed').map(job => job.updatedAt),
      ...actorJobs.filter(job => ['completed', 'applied'].includes(String(job.status ?? ''))).map(job => Number(job.updatedAt ?? 0)),
    ].filter(Number.isFinite).reduce<number | null>((latest, updatedAt) => latest === null ? updatedAt : Math.max(latest, updatedAt), null);
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
      pendingJobs: jobs.filter((job) => job.status === 'queued' || job.status === 'running' || job.status === 'paused').length
        + actorJobs.filter(job => ['queued', 'running', 'paused'].includes(String(job.status ?? ''))).length,
      llmAvailable: readMemoryLlmApi() !== null,
      ...(llmRoute.resourceId ? { llmResource: llmRoute.resourceId } : {}),
      ...(llmRoute.model ? { llmModel: llmRoute.model } : {}),
      ...(recallRoutes ? { embedding: recallRoutes.embedding, rerank: recallRoutes.rerank } : {}),
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
        const invisibleGroups = summarizeSourceGroups(filterSourceBlocks(sources, { includeInvisibleHistory: true }));
        const defaultById = new Map(defaultGroups.map((group) => [group.id, group]));
        const currentById = new Map(currentGroups.map((group) => [group.id, group]));
        const invisibleById = new Map(invisibleGroups.map((group) => [group.id, group]));
        return rawGroups.map((group) => {
          const current = currentById.get(group.id);
          const safe = defaultById.get(group.id);
          const invisible = invisibleById.get(group.id);
          return {
            ...group,
            count: current?.count ?? 0,
            rawCount: group.count,
            defaultCount: safe?.count ?? 0,
            excludedCount: Math.max(0, group.count - (current?.count ?? 0)),
            invisibleCount: Math.max(0, (invisible?.count ?? 0) - (safe?.count ?? 0)),
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
      ...(group.invisibleCount === undefined ? {} : { invisibleCount: group.invisibleCount }),
      selected: group.count > 0 && selectedKinds.has(group.id),
    }));
  }

  async getInitializationState(): Promise<MemoryInitializationState> {
    const chatKey = this.getChatKey();
    if (!chatKey) return { initialized: false, lastCompletedAt: null, selectedSourceKinds: [], attempts: [] };
    const initializationJobs = (await this.listCaptureJobs(chatKey))
      .filter((job) => job.type === 'initialize')
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const latestCompleted = initializationJobs.find((job) => job.status === 'completed');
    return {
      initialized: Boolean(latestCompleted),
      lastCompletedAt: latestCompleted?.updatedAt ?? null,
      selectedSourceKinds: [...(latestCompleted?.checkpoint.selectedSourceGroupIds ?? [])],
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
    if (this.actorCapture && this.multiActorRepository) {
      // Production v0 uses one structured Capture request for the selected
      // source set. Keep the UI estimate aligned with the actual transaction;
      // the old summary batch estimator is retained only for the isolated
      // compatibility test double without the actor repository.
      return estimateSummaryInitialization(messageCount, sources.length > 0 ? [sources] : []);
    }
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
      ? (await this.listCaptureJobs(chatKey)).sort((left, right) => right.updatedAt - left.updatedAt)[0]
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
    };
  }

  async listAuditRecords(): Promise<Array<Record<string, unknown>>> {
    const chatKey = this.requireChatKey();
    const batchAudits = this.multiActorRepository
      ? []
      : (await this.repository.listJobBatchAudits(chatKey)).map((audit) => ({
        ...audit,
        status: audit.rolledBackAt ? '已回滚' : '已完成',
        rejected: audit.rejections,
      }));
    const actorAudits = this.multiActorRepository
      ? (await this.multiActorRepository.listChangeAudits()).filter(record => String(record.kind ?? '') === 'capture-change-set-v0').map(record => ({
        ...record,
        type: 'actor-capture',
        status: record.rolledBackAt ? '已回滚' : '已完成',
        accepted: Number(record.factCount ?? 0),
        sourceRefs: Array.isArray(record.sourceRefs) ? record.sourceRefs : [],
      }))
      : [];
    const auditTimestamp = (record: Record<string, unknown>): number => Number(record.createdAt ?? record.updatedAt ?? 0);
    return [...batchAudits, ...actorAudits].sort((left, right) => auditTimestamp(right) - auditTimestamp(left));
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
    if (!this.capturePromise && !this.actorCapturePromise) return;
    if (!this.capturePromise && this.actorCapturePromise) {
      await this.actorCapturePromise.catch(() => undefined);
      return;
    }
    this.cancelRequested = true;
    this.captureVersion += 1;
    const capturePromise = this.capturePromise;
    if (capturePromise) await capturePromise.catch(() => undefined);
    await this.actorCapturePromise?.catch(() => undefined);
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
    const [facts, audits, actorAudits] = await Promise.all([
      this.multiActorRepository
        ? (query.trim() ? this.facts.search(query) : this.facts.list({}))
        : (query.trim() ? this.repository.searchFacts(chatKey, query) : this.repository.listFacts(chatKey)),
      this.multiActorRepository
        ? Promise.resolve([] as import('../domain').MemoryJobBatchAudit[])
        : this.repository.listJobBatchAudits(chatKey),
      this.multiActorRepository
        ? this.multiActorRepository.listChangeAudits().then(records => records.filter(record => String(record.kind ?? '') === 'capture-change-set-v0'))
        : Promise.resolve([] as Array<Record<string, unknown>>),
    ]);
    const result = await Promise.all(facts.map(async (fact) => {
      const auditBatches = [
        ...audits
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
        ...actorAudits
          .filter((audit) => {
            const entries = Array.isArray(audit.entries) ? audit.entries : [];
            return entries.some(entry => entry && typeof entry === 'object' && String((entry as Record<string, unknown>).collection ?? '') === 'facts' && String((entry as Record<string, unknown>).recordId ?? '') === fact.id)
              || (Array.isArray(audit.sourceRefs) && audit.sourceRefs.some(sourceRef => fact.sourceRefs.includes(String(sourceRef))));
          })
          .map(audit => ({
            jobId: String(audit.id ?? 'capture'),
            batchIndex: 0,
            status: audit.rolledBackAt ? '已回滚' : '已完成',
            kind: String(audit.kind ?? 'capture-change-set-v0'),
          })),
      ];
      return asUiFact(
        fact,
        (await (this.multiActorRepository ? this.multiActorRepository.listEvidence(fact.id) : this.repository.listEvidence(chatKey, fact.id))).map((item) => ({ sourceRef: item.sourceRef, excerpt: item.excerpt })),
        auditBatches,
      );
    }));
    traceMemoryStartup('application:list-facts-ready');
    return result;
  }

  onSettingsChanged(listener: (settings: MemoryUiSettings) => void): () => void {
    this.settingsListeners.add(listener);
    return () => this.settingsListeners.delete(listener);
  }

  onOverviewChanged(listener: () => void): () => void {
    this.overviewListeners.add(listener);
    return () => this.overviewListeners.delete(listener);
  }

  async updateFact(id: string, content: string): Promise<void> {
    const chatKey = this.requireChatKey();
    if (this.multiActorRepository) {
      const current = await this.multiActorRepository.getFact(id);
      if (!current || current.chatKey !== chatKey) throw new Error('记忆不存在或不属于当前聊天。');
      const fact = await this.multiActorRepository.upsertManualFact({
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
      });
      this.recallIndex.upsert(fact);
      this.vectorIndex.scheduleSync(chatKey);
      this.scheduleGraph(chatKey);
      return;
    }
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
      // Raw SQLite health is not sufficient for the v0 Memory runtime. The
      // actor repository also performs the retired-collection guard; never
      // report storage as connected (or re-enable writes) until that guard
      // passes for the currently bound workspace.
      if (this.multiActorRepository && this.multiActorRepository.boundWorkspaceId && health.connected) await this.multiActorRepository.open();
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

  async importSqliteBackup(_file: File): Promise<void> {
    // v0 deliberately starts from a clean WorkspacePort model. Importing an
    // archive would silently reintroduce retired facts, slots and ownership
    // semantics, so the old archive route is fail-closed rather than treated
    // as a migration helper.
    const error = new Error('Memory v0 不支持旧归档导入；请删除旧数据库并从当前来源重新 Capture。') as Error & { code?: string };
    error.code = 'MEMORY_ARCHIVE_IMPORT_DISABLED';
    throw error;
  }

  async checkSqliteIntegrity(): Promise<{ ok: boolean; message: string }> {
    if (!this.sqliteAvailable) return { ok: false, message: 'Memory workspace 不可用。' };
    return this.repository.checkIntegrity();
  }

  async clearCurrentChatData(): Promise<void> {
    const chatKey = this.requireChatKey();
    await this.repository.clearCurrentChatData(chatKey);
    await this.multiActorRepository?.clearCurrentChatData();
    this.actorRegistry?.hydratePending([]);
    this.actorRegistry?.clearAudits();
    this.actorCorrectionChangeSets.clear();
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
    this.lastSceneCast = null;
    this.lastActorRecall = null;
    this.actorExposureTracker = new RecallExposureTracker();
    this.lastExposureIds.clear();
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
    await this.multiActorRepository?.clearAllData();
    await this.repository.setSettings({ summaryProgressByChat: {} });
    this.summaryProgressByChat = {};
    this.summaryWaitingByChat.clear();
    this.recallIndex.replace([]);
    this.lastRecall = null;
    this.lastRecallLogId = null;
    this.lastSceneCast = null;
    this.lastActorRecall = null;
    this.actorExposureTracker = new RecallExposureTracker();
    this.lastExposureIds.clear();
    if (this.hostContext && this.multiActorRepository) {
      this.bindStorageScope(this.hostContext.getWorkspaceId(), this.getChatKey());
    }
    await this.bindCurrentChat();
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

  /**
   * The production initialization path uses the same multi-owner Capture
   * transaction as post-generation capture. The legacy batch extractor remains
   * available only for isolated contract tests and for hosts that have not
   * exposed the v0 actor repository yet.
   */
  private async runMultiActorCaptureWorkflow(
    mode: 'initialize' | 'incremental',
    resumeJob?: MemoryJob,
    selectedSourceGroups?: string[],
    options: MemoryInitializationOptions = {},
  ): Promise<void> {
    const capture = this.actorCapture;
    const context = this.hostContext;
    const actorRepository = this.multiActorRepository;
    if (!capture || !context || !actorRepository) throw new Error('多角色 Capture 尚未绑定宿主工作区。');
    const chatKey = this.requireChatKey();
    const captureVersion = this.captureVersion;
    const includeInvisibleHistory = mode === 'initialize'
      && (resumeJob?.checkpoint.includeInvisibleHistory ?? options.includeInvisibleHistory === true);
    const allSources = selectSourceGroups(
      await context.collectSources(chatKey).then(sources => filterSourceBlocks(sources, { includeInvisibleHistory })),
      mode === 'incremental' ? undefined : (resumeJob?.checkpoint.selectedSourceGroupIds ?? selectedSourceGroups),
    );
    this.assertCaptureCurrent(captureVersion, chatKey);
    if (allSources.length === 0) return;
    const selectedGroups = resumeJob?.checkpoint.selectedSourceGroupIds
      ?? selectedSourceGroups
      ?? summarizeSourceGroups(allSources).map(group => group.id);
    const messageCount = allSources.filter(source => source.kind === 'message').length;
    const totalBatches = 1;
    const jobId = resumeJob?.id ?? createId('job');
    const createdAt = resumeJob?.createdAt ?? Date.now();
    const baseCheckpoint: MemoryJob['checkpoint'] = {
      batchIndex: 0,
      totalBatches,
      processedCount: 0,
      selectedSourceGroupIds: selectedGroups,
      ...(mode === 'initialize' ? { includeInvisibleHistory } : {}),
      phase: 'capture',
    };
    const persistJob = (job: MemoryJob): Promise<void> => actorRepository.upsertCaptureJob({
      ...job,
      workspaceId: actorRepository.boundWorkspaceId,
    });
    this.status = 'working';
    this.cancelRequested = false;
    this.captureStartedAt = Date.now();
    this.activeCaptureProgress = { status: 'running', jobId, batchIndex: 0, totalBatches, processedCount: 0, elapsedMs: 0, phase: 'capture' };
    await persistJob({ id: jobId, chatKey, type: mode, status: 'running', checkpoint: baseCheckpoint, createdAt, updatedAt: Date.now() });
    try {
      const result = await this.runActorCapture(allSources, includeInvisibleHistory, jobId);
      this.assertCaptureCurrent(captureVersion, chatKey);
      const completedCheckpoint: MemoryJob['checkpoint'] = {
        ...baseCheckpoint,
        batchIndex: 1,
        processedCount: messageCount,
      };
      await persistJob({ id: jobId, chatKey, type: mode, status: 'completed', checkpoint: completedCheckpoint, createdAt, updatedAt: Date.now() });
      // The v0 actor Capture job is the source of truth for initialization
      // progress; the retired summary-progress cursor is not written here.
      await this.bindCurrentChat();
      this.status = 'ready';
      this.clearRuntimeError();
      this.activeCaptureProgress = { status: 'completed', jobId, batchIndex: 1, totalBatches, processedCount: messageCount, elapsedMs: Date.now() - this.captureStartedAt, phase: 'capture' };
      void result;
    } catch (error) {
      if (this.stopped || captureVersion !== this.captureVersion || this.getChatKey() !== chatKey) {
        if (!this.stopped) await persistJob({ id: jobId, chatKey, type: mode, status: 'paused', checkpoint: baseCheckpoint, createdAt, updatedAt: Date.now() });
        this.status = this.getEffectiveSettings().enabled ? 'ready' : 'disabled';
        this.activeCaptureProgress = { status: this.cancelRequested ? 'cancelled' : 'paused', jobId, batchIndex: 0, totalBatches, processedCount: 0, elapsedMs: Date.now() - this.captureStartedAt, phase: 'capture' };
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.setRuntimeError(error, 'MEMORY_CAPTURE_FAILED', 'operation');
      await persistJob({ id: jobId, chatKey, type: mode, status: isRetryableCaptureError(error) ? 'paused' : 'failed', checkpoint: baseCheckpoint, error: message, createdAt, updatedAt: Date.now() });
      this.activeCaptureProgress = { status: isRetryableCaptureError(error) ? 'paused' : 'failed', jobId, batchIndex: 0, totalBatches, processedCount: 0, elapsedMs: Date.now() - this.captureStartedAt, error: message, phase: 'capture' };
      throw error;
    }
  }

  private async runCapture(
    mode: 'initialize' | 'incremental',
    resumeJob?: MemoryJob,
    selectedSourceGroups?: string[],
    options?: MemoryInitializationOptions,
  ): Promise<void> {
    this.assertStorageAvailable('初始化');
    const captureSettings = this.getEffectiveSettings();
    if (!captureSettings.enabled) return;
    if (this.actorCapture && this.multiActorRepository) {
      await this.runMultiActorCaptureWorkflow(mode, resumeJob, selectedSourceGroups, options);
      return;
    }
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
    const resumeBatchIndex = resumeJob?.checkpoint.batchIndex ?? 0;
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
      phase: 'capture',
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
        phase: 'capture',
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
      phase: 'capture',
    };
    const processedMetadataRefs = new Set(resumeJob?.checkpoint.metadataSourceRefs ?? []);
    const processedMessageRefs = new Set<string>();
    try {
      for (let index = 0; index < batches.length; index += 1) {
        const batch = batches[index]!;
        this.activeCaptureProgress = {
          status: 'running', jobId, phase: 'capture', batchIndex: resumeBatchIndex + index + 1,
          totalBatches: allBatches.length, processedCount, elapsedMs: Date.now() - this.captureStartedAt,
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
          ...(mode === 'initialize' ? { includeInvisibleHistory } : {}),
          ...(target === undefined ? {} : { summaryStartFloor: target.startFloor, summaryEndFloor: target.endFloor, summaryEndMessageId: target.endMessageId }),
          phase: 'capture',
        };
        await this.repository.putJob({ id: jobId, chatKey, type: mode, status: index === batches.length - 1 ? 'completed' : 'running', checkpoint, createdAt, updatedAt: Date.now() });
        await this.bindCurrentChat();
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
        processedCount, elapsedMs: Date.now() - this.captureStartedAt, phase: 'capture',
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
      const pauseForRetry = isRetryableCaptureError(error);
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

  private emitOverviewChanged(): void {
    this.overviewListeners.forEach((listener) => {
      try { listener(); } catch { /* a stale popup listener must not affect application state */ }
    });
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
    const paused = (await this.listCaptureJobs(chatKey))
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
