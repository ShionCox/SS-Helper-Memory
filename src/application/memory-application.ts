import { MemoryRepository, MultiActorMemoryRepository, type ChangeAudit } from '../infrastructure';
import {
  createSSHelperError,
  describeSSHelperFailure,
  readSSHelperFailure,
  SS_HELPER_DIAGNOSTICS,
  type SSHelperFailureContext,
  type SSHelperReasonCode,
  type ChatMessageSnapshot,
  type FinalPromptSnapshot,
} from '@ss-helper/sdk';
import { DEFAULT_CAST_SETTINGS, FIXED_OWNER_IDS, deriveMemoryGraphProjection, isAiRepairableProposalCode, type RepairClassification } from '../domain';
import type {
  MainChatUsage,
  ManualFactInput,
  MemoryFact,
  MemoryGraphPreview,
  MemoryGraphStatus,
  MemoryJob,
  MemoryEpisode,
  MemoryEvidence,
  MemoryObservation,
  MemoryRecallLog,
  MemoryTokenUsage,
  AutomaticIngestRejection,
  CaptureRepairQueueRecord,
  SceneState,
  GenerationCastPlan,
  GenerationRecallDetail,
  GenerationRecallLookupTarget,
} from '../domain';
import {
  MemoryRecallIndex,
  MemoryVectorIndexService,
  SemanticRecallService,
  recallLimits,
  type RecallQuery,
  type RecallResult,
  MemoryUsageClassifier,
  RecallCoverageVerifier,
} from './recall';
import { MemoryGraphRecallIndex, MemoryGraphService } from './graph';
import {
  readMemoryLlmClient,
  readMemoryLlmRouteDiagnostic,
  readMemoryRecallRouteDiagnostics,
  type MemoryLlmRouteDiagnostic,
  type MemoryLlmUsage,
  type MemoryRecallRouteDiagnostics,
} from './ingest/llm-extractor';
import { ExistingMemoryContextRetriever } from './ingest/existing-memory-context';
import { filterSourceBlocks } from './ingest/source-blocks';
import {
  buildSummaryBatchPlans,
  buildSummaryBatches,
  conversationFloorGroups,
  DEFAULT_SUMMARY_STRATEGY,
  estimateSummaryInitialization,
  getSummaryWaitingFloors,
  normalizeSummaryStrategy,
  selectAutomaticSummaryWindow,
  visibleConversationMessages,
  type SummaryProgress,
} from './ingest/summary-strategy';
import type { SourceBlock, StructuredRepairDecision } from './ingest/types';
import { buildEvidenceWindowHash } from './ingest/supported-evidence-directory';
import { buildMatchedInventoryPrompt } from './inventory';
import { selectSourceGroups, summarizeSourceGroups } from '../host/source-adapter';
import type { MemoryPluginApi, MemorySqliteStatus } from '../index';
import type {
  MemoryCaptureProgress,
  MemoryInitializationEstimate,
  MemoryInitializationOptions,
  MemoryInitializationState,
  MemoryInitializationSourceOption,
  MemoryAuditIssue,
  MemoryAuditRecord,
  MemoryAuditSummary,
  MemoryUiController,
  MemoryUiFact,
  MemoryUiOverview,
  MemoryUiSettings,
  MemoryCandidateStats,
  MemoryCandidateSourcePreview,
} from '../ui/memory-ui';
import type { MemoryPage, MemoryPageRequest, MemoryPageResource } from '../ui/memory-page';
import type { MemoryHostContext } from '../host/sdk-host-context';
import { logger, startMemoryPerformanceSpan, traceMemoryStartup } from '../host/runtime-feedback';
import { describeMemoryError, type MemoryErrorDiagnostic } from '../diagnostics/memory-error';
import {
  ActorRegistry,
  ActiveCastResolver,
  ActualCastReconciler,
  CastCandidateResolver,
  GenerationCastPlanner,
  MultiActorCaptureService,
  SceneStateReducer,
  type ActorRegistryChangeAudit,
} from './actors';
import { ActorRecallService, RecallExposureTracker, auditKnowledgeLeakage, type KnowledgeLeakageAudit } from './recall';
import { buildActorMemoryPromptResult, type ActorMemoryPromptResult } from './prompt';
import type { ActorRecallRequest, ActorRecallResponse, SceneCast } from '../domain';
import { ExtractionPipelineCoordinator } from './extraction';
import { MemoryReviewQueue, validateMemoryReviewResolution, type MemoryReviewAction } from './review';
import type { MemoryReviewItem } from './extraction';
import type { PlainData } from '@ss-helper/sdk';
import { LocationRegistry } from './locations';
import { ProfileCoordinator } from './profile';
import { DreamCoordinator, type DreamApplyResult } from './dream';
import { buildMemoryRecallPacket } from './recall/memory-strength';
import type { ActorCandidate, ActorMemoryTrace, ProfileClaim, MemoryCandidateRecord } from '../domain';
import {
  GenerationMemoryCoordinator,
  createGenerationRecallDetail,
  type PreparedGenerationMemory,
} from './generation';

type MemoryGlobalSettings = Omit<MemoryUiSettings, 'chatMode'>;
function candidateSourceDigest(value: string): string {
  const normalized = value.normalize('NFKC');
  const parts: string[] = [];
  for (let variant = 0; variant < 4; variant += 1) {
    let result = 2166136261;
    for (const char of `${variant}\0${normalized}`) {
      result ^= char.codePointAt(0) ?? 0;
      result = Math.imul(result, 16777619);
    }
    parts.push((result >>> 0).toString(16).padStart(8, '0'));
  }
  return `sha256:${parts.join('')}`;
}
function addReportedToken(current: number | null | undefined, incoming: number | null | undefined): number | null {
  return incoming === null || incoming === undefined
    ? current ?? null
    : current === null || current === undefined ? incoming : current + incoming;
}

function mergeActualUsage(current: MemoryTokenUsage | undefined, incoming: MemoryLlmUsage | undefined): MemoryTokenUsage {
  return {
    promptTokens: addReportedToken(current?.promptTokens, incoming?.promptTokens),
    completionTokens: addReportedToken(current?.completionTokens, incoming?.completionTokens),
    cacheReadTokens: current?.cacheReadTokens ?? null,
    cacheWriteTokens: current?.cacheWriteTokens ?? null,
    totalTokens: addReportedToken(current?.totalTokens, incoming?.totalTokens),
  };
}

function hasReportedUsage(usage: MemoryLlmUsage | undefined): boolean {
  return usage !== undefined && [usage.promptTokens, usage.completionTokens, usage.totalTokens]
    .some(value => value !== null);
}

function usageProgress(checkpoint: Partial<Pick<MemoryJob['checkpoint'], 'actualUsage' | 'usageRequestCount' | 'usageReportedCount'>>): Pick<MemoryCaptureProgress, 'actualUsage' | 'usageRequestCount' | 'usageReportedCount'> {
  return {
    ...(checkpoint.actualUsage ? { actualUsage: checkpoint.actualUsage } : {}),
    ...(checkpoint.usageRequestCount === undefined ? {} : { usageRequestCount: checkpoint.usageRequestCount }),
    ...(checkpoint.usageReportedCount === undefined ? {} : { usageReportedCount: checkpoint.usageReportedCount }),
  };
}

const MAX_AUTOMATIC_DREAM_FAILURES = 6;

const DEFAULT_SETTINGS: Readonly<MemoryGlobalSettings> = Object.freeze({
  enabled: true,
  autoOrganize: true,
  extractionMode: 'single',
  agentConcurrency: 2,
  agentToolPolicy: 'off',
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
  structuredRepairEnabled: true,
  structuredRepairBeforeFloors: 2,
  structuredRepairAfterFloors: 2,
  structuredRepairMaxItems: 8,
  graphEnabled: true,
  graphLlmRelationEnabled: true,
  graphMaxHops: 1,
  graphMaxEdges: 12,
  ...DEFAULT_CAST_SETTINGS,
});
const MEMORY_RECALL_ROUTE_CACHE_TTL_MS = 5_000;

export interface GenerationCompletionScope {
  readonly workspaceId: string;
  readonly chatKey: string;
  readonly preparedGeneration: PreparedGenerationMemory | null;
  readonly recallLogId: string | null;
  readonly finalPromptSnapshot?: FinalPromptSnapshot;
}

export interface GenerationCompletionCommit extends GenerationCompletionScope {
  readonly usage: MainChatUsage;
  readonly message?: ChatMessageSnapshot;
}

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
    subjectKey: fact.subjectKey,
    predicateKey: fact.predicateKey,
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

function clampFocusLookbackFloors(value: number): number {
  const candidate = Number.isFinite(value) ? value : DEFAULT_SETTINGS.focusLookbackFloors;
  return Math.min(12, Math.max(1, Math.trunc(candidate)));
}

function clampActorScanLookbackFloors(value: number): number {
  const candidate = Number.isFinite(value) ? value : DEFAULT_SETTINGS.actorScanLookbackFloors;
  return Math.min(40, Math.max(4, Math.trunc(candidate)));
}

function clampPlannerCandidateThreshold(value: number): number {
  const candidate = Number.isFinite(value) ? value : DEFAULT_SETTINGS.plannerCandidateThreshold;
  return Math.min(8, Math.max(1, Math.trunc(candidate)));
}

function clampPlannerConfidenceThreshold(value: number): number {
  const candidate = Number.isFinite(value) ? value : DEFAULT_SETTINGS.plannerConfidenceThreshold;
  return Math.min(0.95, Math.max(0.5, candidate));
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

function isRetryableCaptureError(error: unknown): boolean {
  const failure = readSSHelperFailure(error, {
    reasonCode: 'INTERNAL_ERROR',
    stage: 'memory.capture',
  })!;
  return SS_HELPER_DIAGNOSTICS[failure.reasonCode].retryable;
}

function classifyRepairRecord(record: CaptureRepairQueueRecord, sources: readonly SourceBlock[]): RepairClassification {
  if (record.classification) return record.classification;
  if (record.issues.some(issue => issue.keyword === 'duplicate_proposal' || issue.keyword === 'duplicate_noop')) return 'duplicate_noop';
  if (record.issues.some(issue => ['excerpt_mismatch', 'invalid_shape', 'invalid_reference', 'entity_ref_unsupported'].includes(issue.keyword))
    && !record.issues.some(issue => /ambiguous|multiple|候选/u.test(issue.expected))) return 'unsupported_evidence';
  const refs = [...record.sourceRefs, ...record.fallbackSourceRefs];
  if (refs.length === 0 || !refs.some(ref => sources.some(source => source.id === ref))) return 'unsupported_evidence';
  return 'ai_required';
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
  private agentModeAvailable: () => boolean = () => true;
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
  private generationScopeRevision = 0;
  private stopped = false;
  private boundChatKey = '';
  private boundScopeKey = '';
  private captureStartedAt = 0;
  private activeCaptureProgress: MemoryCaptureProgress | null = null;
  private activeExtractionSnapshot: Pick<MemoryCaptureProgress, 'extractionMode' | 'agentConcurrency' | 'agentToolPolicy'> | null = null;
  private cancelRequested = false;
  private captureAbortController: AbortController | null = null;
  private initializationVectorSyncBarrier = false;
  private readonly pendingVectorSyncChats = new Set<string>();
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
  private locationRegistry: LocationRegistry | null = null;
  private actorCapture: MultiActorCaptureService | null = null;
  private sceneStateReducer: SceneStateReducer | null = null;
  private actualCastReconciler: ActualCastReconciler | null = null;
  private generationMemoryCoordinator: GenerationMemoryCoordinator | null = null;
  private lastSceneCast: SceneCast | null = null;
  private lastSceneState: SceneState | null = null;
  private lastPreparedGeneration: PreparedGenerationMemory | null = null;
  private lastIncludedTraceIds: readonly string[] = [];
  private lastActorRecall: ActorRecallResponse | null = null;
  private actorExposureTracker = new RecallExposureTracker();
  private readonly lastExposureIds = new Map<string, string>();
  private readonly actorCorrectionChangeSets = new Map<string, string>();
  private readonly profileCoordinator = new ProfileCoordinator();
  private readonly dreamCoordinator = new DreamCoordinator({ automaticApply: true });
  private readonly automaticDreamTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private generationActive = false;
  private rollbackActive = false;

  private scheduleVectorSync(chatKey: string): void {
    if (!chatKey) return;
    if (this.initializationVectorSyncBarrier) {
      this.pendingVectorSyncChats.add(chatKey);
      return;
    }
    this.vectorIndex.scheduleSync(chatKey);
  }

  private finishInitializationVectorSync(): void {
    if (!this.initializationVectorSyncBarrier) return;
    this.initializationVectorSyncBarrier = false;
    const chats = [...this.pendingVectorSyncChats];
    this.pendingVectorSyncChats.clear();
    for (const chatKey of chats) this.vectorIndex.scheduleSync(chatKey);
  }

  private readonly settingsListeners = new Set<(settings: MemoryUiSettings) => void>();
  private readonly overviewListeners = new Set<() => void>();
  private readonly generationRecallDetailListeners = new Set<(kind: 'updated' | 'cleared') => void>();

  constructor(readonly repository: MemoryRepository) {
    this.vectorIndex = new MemoryVectorIndexService(repository);
    this.vectorIndex.onStatusChanged((chatKey) => {
      if (!this.stopped && chatKey === this.getChatKey()) {
        this.emitSettingsChanged();
        this.emitOverviewChanged();
      }
    });
    this.graphService = new MemoryGraphService(repository);
    this.graphService.onStatusChanged((status) => {
      if (!this.stopped && status.chatKey === this.getChatKey()) {
        this.emitSettingsChanged();
        this.emitOverviewChanged();
      }
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
          this.scheduleVectorSync(fact.chatKey);
          this.scheduleGraph(fact.chatKey);
          this.emitOverviewChanged();
          return fact;
        }
        const fact = await this.repository.upsertManualFact(this.requireChatKey(), input);
        this.recallIndex.upsert(fact);
        this.scheduleVectorSync(fact.chatKey);
        this.scheduleGraph(fact.chatKey);
        this.emitOverviewChanged();
        return fact;
      },
      remove: async (id) => {
        if (this.multiActorRepository) {
          const chatKey = this.requireChatKey();
          const removed = await this.multiActorRepository.removeFact(id);
          if (!removed) return;
          this.recallIndex.remove(id);
          this.scheduleGraph(chatKey);
          this.scheduleVectorSync(chatKey);
          this.emitOverviewChanged();
          return;
        }
        await this.repository.removeFact(this.requireChatKey(), id);
        this.recallIndex.remove(id);
        this.scheduleGraph(this.requireChatKey());
        this.emitOverviewChanged();
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

  setAgentModeAvailabilityResolver(resolver: () => boolean): void {
    this.agentModeAvailable = resolver;
  }

  getExtractionRuntimeMode(): 'single' | 'agent' {
    return this.settings.extractionMode === 'agent' && this.agentModeAvailable() ? 'agent' : 'single';
  }

  bindStorageScope(workspaceId: string, sourceChatKey: string): void {
    this.captureAbortController?.abort();
    this.captureAbortController = null;
    const workspace = (this.repository as unknown as { workspace?: unknown }).workspace;
    if (!workspace || typeof workspace !== 'object') return;
    this.repository.bind?.(workspaceId, sourceChatKey);
    if (!workspaceId.trim()) {
      this.generationScopeRevision += 1;
      this.multiActorRepository = null;
      this.actorRegistry = null;
      this.locationRegistry = null;
      this.actorCapture = null;
      this.sceneStateReducer = null;
      this.actualCastReconciler = null;
      this.generationMemoryCoordinator = null;
      return;
    }
    const scopeRevision = ++this.generationScopeRevision;
    const repository = new MultiActorMemoryRepository(workspace as import('@ss-helper/sdk').WorkspacePort);
    repository.bind(workspaceId, sourceChatKey);
    const registry = new ActorRegistry(workspaceId);
    const locationRegistry = new LocationRegistry(workspaceId);
    const sceneStateReducer = new SceneStateReducer(registry, repository);
    const scopeSemanticRecall = new SemanticRecallService(this.recallIndex, this.vectorIndex, this.graphService);
    const isCurrent = (): boolean => this.generationScopeRevision === scopeRevision
      && this.multiActorRepository === repository
      && this.actorRegistry === registry
      && this.locationRegistry === locationRegistry
      && repository.boundWorkspaceId === workspaceId
      && repository.boundChatKey === sourceChatKey;
    const staleScopeError = (): Error => createSSHelperError('MEMORY_STALE_GENERATION_SCOPE', {
      stage: 'memory.generation.scope',
    });
    this.multiActorRepository = repository;
    this.actorRegistry = registry;
    this.locationRegistry = locationRegistry;
    this.actorCapture = new MultiActorCaptureService(
      registry,
      locationRegistry,
      new ExtractionPipelineCoordinator(() => {
        const settings = this.getSettings();
        return {
          extractionMode: this.getExtractionRuntimeMode(),
          agentConcurrency: settings.agentConcurrency,
          agentToolPolicy: settings.agentToolPolicy,
        };
      }, repository),
      repository,
    );
    this.sceneStateReducer = sceneStateReducer;
    const coverageVerifier = new RecallCoverageVerifier();
    this.generationMemoryCoordinator = new GenerationMemoryCoordinator(
      sceneStateReducer,
      new CastCandidateResolver(registry),
      new GenerationCastPlanner(),
      coverageVerifier,
      {
        collectSources: async (chatKey) => {
          if (!this.hostContext) throw new Error('Memory 尚未绑定宿主上下文。');
          return this.hostContext.collectSources(chatKey);
        },
        listEpisodes: () => repository.listEpisodes(),
        listFacts: () => repository.listFacts(),
        listTraces: () => repository.listTraces(),
        resolveOwnerName: (name) => {
          const resolution = registry.resolveMention(name);
          return resolution && !resolution.ambiguous ? resolution.owner.id : undefined;
        },
        listKnownOwners: () => registry.listOwners().map(owner => ({
          ownerId: owner.id,
          names: [...new Set([owner.displayName, owner.canonicalName ?? '', ...owner.aliases].map(value => value.trim()).filter(Boolean))],
        })),
        buildInventoryPrompt: async (userMessage, maxChars) => {
          const [items, states] = await Promise.all([repository.listInventoryItems(), repository.listInventoryStates()]);
          return buildMatchedInventoryPrompt(userMessage, items, states, Math.min(2_000, maxChars));
        },
        recall: async ({ query, scene, castPlan, intentPlan, maxItems, now, minimumRetrievalLevel, coverageExpansion, excludedFactIds }) => {
          if (!isCurrent()) throw staleScopeError();
          const result = await this.performActorRecall({
            workspaceId,
            chatKey: sourceChatKey,
            query,
            scene,
            castPlan,
            intentPlan,
            maxItems,
            now,
            ...(minimumRetrievalLevel ? { minimumRetrievalLevel } : {}),
            ...(coverageExpansion ? { coverageExpansion: true } : {}),
            ...(excludedFactIds?.length ? { excludedFactIds } : {}),
            mode: castPlan.mode === 'single_actor' ? 'strict_pov' : 'multi_actor',
            sceneEpoch: castPlan.sceneId,
          }, repository, scopeSemanticRecall, this.getEffectiveSettings());
          if (!isCurrent()) throw staleScopeError();
          return result;
        },
        buildPrompt: (response, castPlan, maxChars, intentKind) => buildActorMemoryPromptResult(response, {
          maxChars,
          sceneLabel: castPlan.sceneId,
          castPlan,
          answerMode: ['world_knowledge', 'actor_entity', 'actor_knowledge', 'relationship', 'timeline'].includes(intentKind) ? 'direct' : 'roleplay',
          ...(intentKind === 'world_knowledge' || intentKind === 'actor_entity' || intentKind === 'actor_knowledge'
            ? { rules: ['只使用与当前问题直接相关的记忆，不要为了覆盖召回角色而额外提及人物。'] }
            : {}),
        }),
        isCurrent,
        commitPrepared: (prepared) => repository.commitGenerationPreparation(prepared),
      },
    );
    this.actualCastReconciler = new ActualCastReconciler(registry, sceneStateReducer, {
      saveAudit: (audit) => repository.recordCastPlanAudit(audit),
    });
  }

  /** Replace the in-memory identity/location directories with persisted state. */
  private async reloadActorDirectoryState(repository = this.multiActorRepository): Promise<void> {
    const actorRegistry = this.actorRegistry;
    const locationRegistry = this.locationRegistry;
    if (!repository || !actorRegistry || !locationRegistry) return;
    const workspaceId = repository.boundWorkspaceId;
    const chatKey = repository.boundChatKey;
    const [owners, aliases, pendingCandidates, locations, locationAliases, pendingLocations, persistedAudits] = await Promise.all([
      repository.listOwners(),
      repository.listAliases(),
      repository.listPendingCandidates(),
      repository.listLocations(),
      repository.listLocationAliases(),
      repository.listPendingLocationCandidates(),
      repository.listChangeAudits(),
    ]);
    if (this.multiActorRepository !== repository
      || this.actorRegistry !== actorRegistry
      || this.locationRegistry !== locationRegistry
      || repository.boundWorkspaceId !== workspaceId
      || repository.boundChatKey !== chatKey) return;
    actorRegistry.hydrate(owners, aliases);
    actorRegistry.hydratePending(pendingCandidates);
    locationRegistry.hydrate(locations, locationAliases);
    locationRegistry.hydratePending(pendingLocations);
    const registryAudits = persistedAudits
      .map(record => record.metadata && typeof record.metadata === 'object'
        ? (record.metadata as Record<string, unknown>).registryAudit
        : undefined)
      .filter((value): value is ActorRegistryChangeAudit => Boolean(value
        && typeof value === 'object'
        && typeof (value as { id?: unknown }).id === 'string'));
    actorRegistry.hydrateAudits(registryAudits);
    this.actorCorrectionChangeSets.clear();
    for (const record of persistedAudits) {
      const metadata = record.metadata && typeof record.metadata === 'object'
        ? record.metadata as Record<string, unknown>
        : undefined;
      const registryAudit = metadata?.registryAudit;
      if (!registryAudit || typeof registryAudit !== 'object' || typeof (registryAudit as { id?: unknown }).id !== 'string') continue;
      const registryId = String((registryAudit as { id: string }).id);
      const existingChangeSet = this.actorCorrectionChangeSets.get(registryId);
      const existingRecord = existingChangeSet
        ? persistedAudits.find(item => String(item.id) === existingChangeSet)
        : undefined;
      if (!existingRecord || Number(record.createdAt ?? 0) >= Number(existingRecord.createdAt ?? 0)) {
        this.actorCorrectionChangeSets.set(registryId, String(record.id));
      }
    }
  }

  private currentLlmRouteDiagnostic(): MemoryLlmRouteDiagnostic {
    if (this.llmRouteDiagnosticPending === undefined) {
      const pending = readMemoryLlmRouteDiagnostic()
        .then((diagnostic) => { this.llmRouteDiagnostic = diagnostic; })
        .catch(() => { this.llmRouteDiagnostic = { available: false, failure: { reasonCode: 'BUS_REQUEST_TIMEOUT', stage: 'memory.routing.inspect' } }; })
        .finally(() => {
          if (this.llmRouteDiagnosticPending === pending) this.llmRouteDiagnosticPending = undefined;
          if (!this.stopped) this.emitSettingsChanged();
        });
      this.llmRouteDiagnosticPending = pending;
    }
    return this.llmRouteDiagnostic ?? {
      available: readMemoryLlmClient() !== null,
      failure: { reasonCode: 'BUS_REQUEST_TIMEOUT', stage: 'memory.routing.inspect' },
    };
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
            embedding: { available: false, failure: { reasonCode: 'BUS_REQUEST_TIMEOUT', stage: 'memory.routing.inspect' } },
            rerank: { available: false, failure: { reasonCode: 'BUS_REQUEST_TIMEOUT', stage: 'memory.routing.inspect' } },
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
    const finish = startMemoryPerformanceSpan('application.start');
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
      finish('error');
      this.sqliteAvailable = false;
      this.vectorIndex.stop();
      this.recallIndex.replace([]);
      this.setRuntimeError(error, 'WORKSPACE_DATABASE_UNAVAILABLE', 'startup');
      const failure = readSSHelperFailure(error, {
        reasonCode: 'WORKSPACE_DATABASE_UNAVAILABLE',
        stage: 'memory.startup',
      })!;
      logger.error(`Memory 应用启动失败：${failure.reasonCode}`, failure);
      return;
    }
    finish();
    void this.resumePausedWork().catch(() => undefined);
  }

  stop(): void {
    this.stopped = true;
    this.captureAbortController?.abort();
    this.captureAbortController = null;
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

  /**
   * Makes the lightweight recall-detail lookup path available as soon as the
   * host context changes. The full actor/fact rebind intentionally continues
   * in the background and must not delay chat-message actions.
   */
  prepareCurrentChatLookupScope(): void {
    const workspaceId = this.hostContext?.getWorkspaceId() ?? '';
    const chatKey = this.getChatKey();
    this.repository.bind?.(workspaceId, chatKey);
    this.emitOverviewChanged();
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
    this.actorCapturePromise = this.runActorCapture().finally(() => {
      this.actorCapturePromise = null;
      this.emitOverviewChanged();
    });
    return this.actorCapturePromise;
  }

  private assertStorageAvailable(operation: string): void {
    if (this.sqliteAvailable) return;
    throw createSSHelperError(
      this.errorDiagnostic?.reasonCode ?? 'WORKSPACE_DATABASE_UNAVAILABLE',
      {
        stage: this.errorDiagnostic?.stage ?? 'memory.workspace.operation',
      },
    );
  }

  private async executeActorCapture(
    sources: readonly SourceBlock[],
    options: {
      captureJobId?: string;
      captureJob?: MemoryJob;
      writableSourceRefs?: readonly string[];
      existingMemoryContext?: readonly import('./ingest/types').ExistingMemoryContextItem[];
      graphLlmRelationEnabled?: boolean;
      idempotencyKey?: string;
      includeHiddenMessageFloors?: boolean;
      repair?: import('./ingest/types').MemoryExtractionInput['repair'];
      reviewOverride?: import('./ingest/types').MemoryExtractionInput['reviewOverride'];
      stage?: import('./ingest/types').MemoryExtractionInput['stage'];
      onUsage?: (usage: MemoryLlmUsage | undefined) => void | Promise<void>;
    } = {},
  ): Promise<import('./actors').MultiActorCaptureResult> {
    const capture = this.actorCapture;
    const context = this.hostContext;
    const repository = this.multiActorRepository;
    if (!capture || !context || !repository) throw new Error('多角色 Memory 尚未绑定宿主工作区。');
    const chatKey = this.getChatKey();
    const captureVersion = this.captureVersion;
    const currentFloor = Math.max(0, ...sources.map(source => source.floor ?? 0));
    const captureAbortController = new AbortController();
    this.captureAbortController?.abort();
    this.captureAbortController = captureAbortController;
    let result: import('./actors').MultiActorCaptureResult;
    try {
      const captureInput: import('./actors').MultiActorCaptureInput = {
        workspaceId: context.getWorkspaceId(),
        chatKey,
        sources,
        currentFloor,
        ...(options.includeHiddenMessageFloors === undefined ? {} : { includeHiddenMessageFloors: options.includeHiddenMessageFloors }),
        ...(options.captureJobId ? { captureJobId: options.captureJobId } : {}),
        ...(options.captureJob ? { captureJob: options.captureJob as unknown as Record<string, unknown> } : {}),
        ...(options.writableSourceRefs === undefined ? {} : { writableSourceRefs: options.writableSourceRefs }),
        ...(options.existingMemoryContext === undefined ? {} : { existingMemoryContext: options.existingMemoryContext }),
        ...(options.graphLlmRelationEnabled === undefined ? {} : { graphLlmRelationEnabled: options.graphLlmRelationEnabled }),
        ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
        ...(options.repair === undefined ? {} : { repair: options.repair }),
        ...(options.reviewOverride === undefined ? {} : { reviewOverride: options.reviewOverride }),
        ...(options.stage === undefined ? {} : { stage: options.stage }),
        signal: captureAbortController.signal,
      };
      if (options.onUsage) {
        Object.defineProperty(captureInput, 'onUsage', { value: options.onUsage, enumerable: false });
      }
      result = await capture.capture(captureInput);
    } finally {
      if (this.captureAbortController === captureAbortController) this.captureAbortController = null;
    }
    if (this.stopped || this.captureVersion !== captureVersion || this.getChatKey() !== chatKey) {
      if (result.changeAudit?.id) {
        try {
          // Use the repository captured with the Capture service. A chat switch
          // may already have replaced this.multiActorRepository with a new
          // scope; rolling the old audit back through the new repository would
          // fail and leave committed data in the previous chat.
          await repository.rollbackChangeSet(result.changeAudit.id);
        } catch (error) {
          throw createSSHelperError('MEMORY_CAPTURE_ROLLBACK_FAILED', {
            stage: 'memory.capture.rollback-after-scope-change',
            ...(result.audit?.requestId ? { requestId: result.audit.requestId } : {}),
          });
        }
      }
      throw createSSHelperError('MEMORY_STALE_GENERATION_SCOPE', {
        stage: 'memory.capture.scope',
      });
    }
    return result;
  }

  private repairSourceWindow(
    records: readonly CaptureRepairQueueRecord[],
    allSources: readonly SourceBlock[],
    settings: MemoryGlobalSettings,
  ): SourceBlock[] {
    const anchorIds = new Set(records.flatMap(record => record.sourceRefs));
    const fallbackIds = new Set(records.flatMap(record => record.fallbackSourceRefs));
    const anchorFloors = allSources
      .filter(source => anchorIds.has(source.id) && Number.isFinite(source.floor))
      .map(source => source.floor as number);
    if (anchorFloors.length === 0) return allSources.filter(source => fallbackIds.has(source.id));
    const start = Math.min(...anchorFloors) - settings.structuredRepairBeforeFloors;
    const end = Math.max(...anchorFloors) + settings.structuredRepairAfterFloors;
    return allSources.filter(source =>
      (Number.isFinite(source.floor) && (source.floor as number) >= start && (source.floor as number) <= end)
      || (source.floor === undefined && fallbackIds.has(source.id)));
  }

  private async reconcileHistoricalCaptureRepairs(repository: MultiActorMemoryRepository): Promise<void> {
    for (const job of await repository.listCaptureJobs()) {
      const jobId = String(job.id ?? '').trim();
      const status = String(job.status ?? '');
      if (!jobId) continue;
      // A queued/running capture belongs to a worker in the previous page or
      // server session. There is no resumable worker after a reload, so leave
      // an explicit cancelled terminal record instead of showing an infinite
      // "正在处理" state. A new initialization can safely start from the
      // persisted checkpoint; no facts are committed by this reconciliation.
      if (status === 'queued' || status === 'running') {
        const failure: SSHelperFailureContext = {
          reasonCode: 'MEMORY_EXTRACTION_PIPELINE_CANCELLED',
          stage: 'memory.capture.reconcile.stale',
          ...(typeof job.requestId === 'string' ? { requestId: job.requestId } : {}),
        };
        await repository.upsertCaptureJob({
          ...job,
          status: 'cancelled',
          outcome: 'partial',
          failure,
          updatedAt: Date.now(),
          checkpoint: {
            ...((job.checkpoint && typeof job.checkpoint === 'object') ? job.checkpoint : {}),
            phase: 'cancelled',
          },
        });
        continue;
      }
      await repository.reconcileCaptureRepairQueue(jobId);
      if (status !== 'repairing' && status !== 'needs_repair' && status !== 'needs_review') continue;
      // A persisted `repairing` state has no live worker after a page reload.
      // Re-project all repair states from the durable queue so the user can
      // resume instead of seeing an indefinitely frozen task, and so an older
      // transport failure cannot survive after the queue has been reconciled.
      const queue = await repository.listCaptureRepairQueue(jobId);
      const queueByRejectionId = new Map(queue.flatMap(record =>
        (record.rejectionIds?.length ? record.rejectionIds : record.rejectionId ? [record.rejectionId] : [])
          .map(rejectionId => [rejectionId, record] as const)));
      const sourceRejections = Array.isArray(job.rejections)
        ? job.rejections as AutomaticIngestRejection[]
        : [];
      const rejections = sourceRejections.map((rejection) => {
        const record = rejection.id ? queueByRejectionId.get(rejection.id) : undefined;
        if (!record) {
          return (rejection.status ?? 'unresolved') === 'unresolved'
            && !isAiRepairableProposalCode(rejection.code)
            ? { ...rejection, status: 'ignored' as const, ignoredAt: Date.now(), waitingForEvidenceChange: false }
            : rejection;
        }
        if (record.waitingForEvidenceChange === true) {
          return { ...rejection, status: 'unresolved' as const, waitingForEvidenceChange: true, repairAttempts: record.attemptCount };
        }
        if (record.status !== 'resolved' && record.status !== 'ignored') return rejection;
        return record.status === 'ignored'
          ? {
            ...rejection,
            status: 'ignored' as const,
            repairAttempts: record.attemptCount,
            ignoredAt: record.resolvedAt ?? record.updatedAt,
          }
          : {
            ...rejection,
            status: 'repaired' as const,
            repairAttempts: record.attemptCount,
            repairedAt: record.resolvedAt ?? record.updatedAt,
          };
      });
      const unresolvedCount = rejections.filter(rejection =>
        (rejection.status ?? 'unresolved') === 'unresolved').length;
      const counts = this.captureRepairQueueCounts(queue);
      const reviewRequiredCount = 0;
      const recoveredJob = { ...job };
      delete recoveredJob.failure;
      await repository.upsertCaptureJob({
        ...recoveredJob,
        status: counts.retryable > 0 ? 'needs_repair' : 'completed',
        outcome: unresolvedCount > 0 ? 'partial' : 'complete',
        rejectionCount: unresolvedCount,
        rejections,
        checkpoint: {
          ...((job.checkpoint && typeof job.checkpoint === 'object') ? job.checkpoint : {}),
          phase: 'repair',
          pendingRepairCount: counts.retryable,
          retryableRepairCount: counts.retryable,
          exhaustedRepairCount: counts.exhausted,
          quarantinedCount: counts.quarantined,
          reviewRequiredCount,
          unresolvedRejectionCount: unresolvedCount,
          repairedCount: rejections.filter(rejection => rejection.status === 'repaired').length,
          degradedCount: queue.filter(record =>
            record.status === 'resolved' && record.resolutionMode === 'degraded').length,
          ignoredCount: rejections.filter(rejection => rejection.status === 'ignored').length,
        },
        updatedAt: Date.now(),
      });
    }
  }

  private captureRepairQueueCounts(queue: readonly CaptureRepairQueueRecord[]): {
    retryable: number;
    exhausted: number;
    quarantined: number;
  } {
    const rank = (collection: CaptureRepairQueueRecord['collection']): number =>
      ({ actorCandidates: 0, locationCandidates: 1, itemCandidates: 2, episodes: 3, claims: 4, inventoryOperations: 5, batch: 6 })[collection];
    const blocker = (record: CaptureRepairQueueRecord): CaptureRepairQueueRecord | undefined => {
      const sources = new Set([...record.sourceRefs, ...record.fallbackSourceRefs]);
      return queue.find(candidate =>
        candidate.id !== record.id
        && rank(candidate.collection) < rank(record.collection)
        && (candidate.status === 'queued' || candidate.status === 'running' || candidate.status === 'unresolved')
        && candidate.waitingForEvidenceChange !== true
        && candidate.attemptCount < (candidate.maxAttempts ?? 1)
        && [...candidate.sourceRefs, ...candidate.fallbackSourceRefs].some(sourceRef => sources.has(sourceRef)));
    };
    const active = (record: CaptureRepairQueueRecord): boolean =>
      (record.status === 'queued' || record.status === 'running' || record.status === 'unresolved')
      && record.waitingForEvidenceChange !== true
      && record.attemptCount < (record.maxAttempts ?? 1);
    return {
      retryable: queue.filter(record => active(record) && blocker(record) === undefined).length,
      exhausted: queue.filter(record =>
        record.status === 'unresolved'
        && record.waitingForEvidenceChange !== true
        && record.attemptCount >= (record.maxAttempts ?? 1)).length,
      quarantined: queue.filter(record =>
        record.status === 'unresolved' && record.waitingForEvidenceChange === true).length,
    };
  }

  private async resolveCaptureRepairAudit(
    repository: MultiActorMemoryRepository,
    jobId: string,
    record: CaptureRepairQueueRecord,
    attemptCount: number,
    resolution: 'repaired' | 'ignored' | 'quarantined' = 'repaired',
  ): Promise<void> {
    const auditRepository = repository as unknown as {
      listChangeAudits?: MultiActorMemoryRepository['listChangeAudits'];
      updateCaptureAuditRejections?: MultiActorMemoryRepository['updateCaptureAuditRejections'];
    };
    if (typeof auditRepository.listChangeAudits !== 'function'
      || typeof auditRepository.updateCaptureAuditRejections !== 'function') {
      await repository.updateCaptureRepairRecord({
        ...record,
        status: resolution === 'ignored' ? 'ignored' : resolution === 'repaired' ? 'resolved' : 'unresolved',
        ...(resolution === 'ignored' ? { resolutionMode: 'ignored' as const } : {}),
        ...(resolution === 'quarantined' ? { waitingForEvidenceChange: true } : {}),
        ...(resolution === 'quarantined' ? {} : { resolvedAt: Date.now() }),
        updatedAt: Date.now(),
      });
      return;
    }
    const rejectionIds = new Set(record.rejectionIds?.length
      ? record.rejectionIds
      : record.rejectionId ? [record.rejectionId] : []);
    if (rejectionIds.size === 0) {
      throw createSSHelperError('MEMORY_CAPTURE_INTEGRITY_FAILED', {
        stage: 'memory.repair.audit-link',
        batchIndex: record.batchIndex,
        collection: record.collection,
      });
    }
    const resolvedAt = Date.now();
    const matched = new Set<string>();
    for (const audit of await auditRepository.listChangeAudits.call(repository)) {
      const metadata = audit.metadata && typeof audit.metadata === 'object' && !Array.isArray(audit.metadata)
        ? audit.metadata as Record<string, unknown>
        : undefined;
      if (String(metadata?.captureJobId ?? '') !== jobId || audit.rolledBackAt) continue;
      const rejections = Array.isArray(metadata?.rejections)
        ? metadata.rejections.filter((item): item is AutomaticIngestRejection => Boolean(item && typeof item === 'object'))
        : [];
      if (!rejections.some(rejection => rejection.id && rejectionIds.has(rejection.id))) continue;
      const updated = rejections.map((rejection) => {
        if (!rejection.id || !rejectionIds.has(rejection.id)) return rejection;
        matched.add(rejection.id);
        return {
          ...rejection,
          status: resolution === 'quarantined' ? 'unresolved' as const : resolution,
          repairAttempts: attemptCount,
          waitingForEvidenceChange: resolution === 'quarantined',
          ...(resolution === 'ignored' ? { ignoredAt: resolvedAt }
            : resolution === 'repaired' ? { repairedAt: resolvedAt }
              : {}),
        };
      });
      await auditRepository.updateCaptureAuditRejections.call(repository, String(audit.id ?? ''), updated);
    }
    if ([...rejectionIds].some(rejectionId => !matched.has(rejectionId))) {
      throw createSSHelperError('MEMORY_CAPTURE_INTEGRITY_FAILED', {
        stage: 'memory.repair.audit-link',
        batchIndex: record.batchIndex,
        collection: record.collection,
      });
    }
  }

  private async retryEvidenceChangedCaptureRepairs(
    repository: MultiActorMemoryRepository,
    allSources: readonly SourceBlock[],
    settings: MemoryGlobalSettings,
    captureVersion: number,
    chatKey: string,
    includeHiddenMessageFloors: boolean,
  ): Promise<void> {
    if (typeof repository.listCaptureRepairQueue !== 'function'
      || typeof repository.updateCaptureRepairRecord !== 'function') return;
    const releasedJobIds = new Set<string>();
    for (const record of await repository.listCaptureRepairQueue()) {
      if (record.status !== 'unresolved'
        || record.waitingForEvidenceChange !== true
        || record.evidenceRetryUsed === true) continue;
      const sources = this.repairSourceWindow([record], allSources, settings);
      const writableSourceRefs = [...new Set(record.sourceRefs.length > 0 ? record.sourceRefs : record.fallbackSourceRefs)]
        .filter(ref => sources.some(source => source.id === ref));
      if (sources.length === 0 || writableSourceRefs.length === 0) {
        await this.resolveCaptureRepairAudit(repository, record.jobId, {
          ...record,
          status: 'ignored',
          resolutionMode: 'ignored',
          waitingForEvidenceChange: false,
          resolvedAt: Date.now(),
          updatedAt: Date.now(),
        }, record.attemptCount, 'ignored');
        continue;
      }
      const evidenceSetHash = buildEvidenceWindowHash(sources, writableSourceRefs);
      if (!record.evidenceSetHash) {
        await repository.updateCaptureRepairRecord({ ...record, evidenceSetHash, updatedAt: Date.now() });
        continue;
      }
      if (evidenceSetHash === record.evidenceSetHash) continue;
      await repository.updateCaptureRepairRecord({
        ...record,
        status: 'queued',
        maxAttempts: record.attemptCount + 1,
        evidenceRetryUsed: true,
        waitingForEvidenceChange: false,
        updatedAt: Date.now(),
      });
      releasedJobIds.add(record.jobId);
    }
    for (const jobId of releasedJobIds) {
      const repair = await this.runDeferredCaptureRepairs(
        repository,
        jobId,
        allSources,
        settings,
        captureVersion,
        chatKey,
        includeHiddenMessageFloors,
      );
      if (repair.results.length > 0) {
        await this.finalizeActorCaptureResults(repair.results, allSources, captureVersion, chatKey);
      }
    }
    if (releasedJobIds.size > 0) {
      this.activeCaptureProgress = null;
      this.emitOverviewChanged();
    }
  }

  private async runDeferredCaptureRepairs(
    repository: MultiActorMemoryRepository,
    jobId: string,
    allSources: readonly SourceBlock[],
    settings: MemoryGlobalSettings,
    captureVersion: number,
    chatKey: string,
    includeHiddenMessageFloors = false,
    onUsage?: (usage: MemoryLlmUsage | undefined) => void | Promise<void>,
  ): Promise<{
    results: import('./actors').MultiActorCaptureResult[];
    resolvedRejectionIds: Set<string>;
    remaining: number;
    degraded: number;
  }> {
    await repository.reconcileCaptureRepairQueue?.(jobId);
    // Deterministic failures never enter the provider queue. Keep the original
    // rejection row for audit, but mark duplicate/no-evidence candidates once.
    const classifiedQueue = await repository.listCaptureRepairQueue(jobId);
    for (const record of classifiedQueue) {
      const classification = classifyRepairRecord(record, allSources);
      if (record.classification === classification || record.status === 'resolved' || record.status === 'ignored') continue;
      if (classification === 'ai_required') {
        await repository.updateCaptureRepairRecord({ ...record, classification, updatedAt: Date.now() });
        continue;
      }
      const nextRecord: CaptureRepairQueueRecord = {
        ...record,
        classification,
        status: 'ignored',
        resolutionMode: 'ignored',
        waitingForEvidenceChange: false,
        resolvedAt: Date.now(),
        failure: {
          reasonCode: classification === 'duplicate_noop' ? 'MEMORY_UPDATE_DUPLICATE' : 'MEMORY_REPAIR_SOURCE_UNAVAILABLE',
          stage: 'memory.repair.deterministic',
          batchIndex: record.batchIndex,
          collection: record.collection,
        },
        updatedAt: Date.now(),
      };
      await repository.updateCaptureRepairRecord(nextRecord);
      await this.resolveCaptureRepairAudit(repository, jobId, nextRecord, record.attemptCount, 'ignored');
    }
    const rank = (collection: CaptureRepairQueueRecord['collection']): number =>
      ({ actorCandidates: 0, locationCandidates: 1, itemCandidates: 2, episodes: 3, claims: 4, inventoryOperations: 5, batch: 6 })[collection];
    if (!settings.structuredRepairEnabled) {
      const queue = await repository.listCaptureRepairQueue(jobId);
      for (const record of queue.filter(item => item.status !== 'resolved' && item.status !== 'ignored')) {
        await this.resolveCaptureRepairAudit(repository, jobId, {
          ...record,
          status: 'ignored',
          resolutionMode: 'ignored',
          waitingForEvidenceChange: false,
          resolvedAt: Date.now(),
          updatedAt: Date.now(),
        }, record.attemptCount, 'ignored');
      }
      return { results: [], resolvedRejectionIds: new Set(), remaining: 0, degraded: 0 };
    }
    const isActive = (record: CaptureRepairQueueRecord): boolean =>
      record.waitingForEvidenceChange !== true
      && (record.status === 'queued' || record.status === 'running' || record.status === 'unresolved')
      && record.attemptCount < (record.maxAttempts ?? 1);
    const dependencyPending = (record: CaptureRepairQueueRecord, queue: readonly CaptureRepairQueueRecord[]): boolean => {
      const sourceSet = new Set([...record.sourceRefs, ...record.fallbackSourceRefs]);
      return queue.some(candidate =>
        candidate.id !== record.id
        && rank(candidate.collection) < rank(record.collection)
        && isActive(candidate)
        && [...candidate.sourceRefs, ...candidate.fallbackSourceRefs].some(ref => sourceSet.has(ref)));
    };
    const eligibleQueue = async (): Promise<CaptureRepairQueueRecord[]> =>
      (await repository.listCaptureRepairQueue(jobId))
        .filter(record => record.collection !== 'batch')
        .filter(isActive)
        .sort((left, right) => rank(left.collection) - rank(right.collection)
          || left.batchIndex - right.batchIndex
          || left.itemIndex - right.itemIndex);
    const initialPending = await eligibleQueue();
    const results: import('./actors').MultiActorCaptureResult[] = [];
    const resolvedRejectionIds = new Set<string>();
    let processed = 0;
    const completedRecordIds = new Set<string>();
    const total = initialPending.length;
    let madeProgress = true;
    while (madeProgress) {
      madeProgress = false;
      const pending = await eligibleQueue();
      if (pending.length === 0) break;
      const liveQueue = await repository.listCaptureRepairQueue(jobId);
      const record = pending.find(candidate => !dependencyPending(candidate, liveQueue));
      if (!record) break;
      const maxAttempts = record.maxAttempts ?? 1;
      const attemptNo = record.attemptCount + 1;
      const seedWindowIds = new Set(this.repairSourceWindow([record], allSources, settings).map(source => source.id));
      const compatible = pending.filter(candidate => {
        if (candidate.collection !== record.collection
          || candidate.attemptCount + 1 !== attemptNo
          || (candidate.maxAttempts ?? 1) !== maxAttempts
          || candidate.evidenceRetryUsed !== record.evidenceRetryUsed
          || dependencyPending(candidate, liveQueue)) return false;
        const candidateWindow = this.repairSourceWindow([candidate], allSources, settings);
        return candidate.id === record.id || candidateWindow.some(source => seedWindowIds.has(source.id));
      });
      const group: CaptureRepairQueueRecord[] = [];
      let estimatedTokens = 0;
      for (const candidate of compatible) {
        const candidateTokens = Math.ceil(candidate.issues.reduce((sum, issue) => sum + issue.path.length + issue.keyword.length + issue.expected.length, 0) / 3)
          + Math.ceil(this.repairSourceWindow([candidate], allSources, settings).reduce((sum, source) => sum + source.content.length, 0) / 4);
        if (group.length >= Math.min(8, settings.structuredRepairMaxItems)) break;
        if (group.length > 0 && estimatedTokens + candidateTokens > 8_000) break;
        group.push(candidate);
        estimatedTokens += candidateTokens;
      }
      const sources = this.repairSourceWindow(group, allSources, settings);
      const writableSourceRefs = [...new Set(
        group.flatMap(candidate => candidate.sourceRefs.length > 0 ? candidate.sourceRefs : candidate.fallbackSourceRefs),
      )].filter(ref => sources.some(source => source.id === ref));
      if (sources.length === 0 || writableSourceRefs.length === 0) {
        for (const candidate of group) {
          await repository.updateCaptureRepairRecord({
            ...candidate,
            status: 'queued',
            failure: {
              reasonCode: 'MEMORY_REPAIR_SOURCE_UNAVAILABLE',
              stage: 'memory.repair.source-window',
              batchIndex: candidate.batchIndex,
              collection: candidate.collection,
            },
            updatedAt: Date.now(),
          });
        }
        continue;
      }
      madeProgress = true;
      const evidenceSetHash = buildEvidenceWindowHash(sources, writableSourceRefs);
      const evidenceSetHashes = new Map(group.map((candidate) => {
        const candidateSources = this.repairSourceWindow([candidate], allSources, settings);
        const candidateWritableSourceRefs = [...new Set(
          candidate.sourceRefs.length > 0 ? candidate.sourceRefs : candidate.fallbackSourceRefs,
        )].filter(ref => candidateSources.some(source => source.id === ref));
        return [candidate.id, candidateSources.length > 0 && candidateWritableSourceRefs.length > 0
          ? buildEvidenceWindowHash(candidateSources, candidateWritableSourceRefs)
          : evidenceSetHash] as const;
      }));
      // Keep attemptCount unchanged while work is in flight. If the process is
      // interrupted, or the final queue-state write fails, the durable
      // `running` row remains eligible and reuses the same Capture idempotency
      // key on the next resume.
      for (const candidate of group) {
        await repository.updateCaptureRepairRecord({
          ...candidate,
          status: 'running',
          evidenceSetHash: evidenceSetHashes.get(candidate.id)!,
          waitingForEvidenceChange: false,
          updatedAt: Date.now(),
        });
      }
      this.activeCaptureProgress = {
        ...usageProgress(this.activeCaptureProgress ?? {}),
        status: 'repairing',
        jobId,
        batchIndex: processed,
        totalBatches: total,
        processedCount: processed,
        elapsedMs: Date.now() - this.captureStartedAt,
        phase: 'repair',
        pendingRepairCount: Math.max(0, total - processed),
      };
      this.emitOverviewChanged();

      let result: import('./actors').MultiActorCaptureResult;
      try {
        this.assertCaptureCurrent(captureVersion, chatKey);
        result = await this.executeActorCapture(sources, {
          captureJobId: jobId,
          writableSourceRefs,
          repair: {
            collection: record.collection as Exclude<CaptureRepairQueueRecord['collection'], 'batch'>,
            issues: group.flatMap(candidate => candidate.issues).slice(0, 16),
            targets: group.map(candidate => ({ repairId: candidate.id, issues: candidate.issues.slice(0, 16) })),
            attempt: attemptNo,
            maxAttempts,
            mode: record.evidenceRetryUsed === true ? 'conservative' : 'targeted',
            ...(record.originalRequestId ? { parentRequestId: record.originalRequestId } : {}),
            maxItems: group.length,
          },
          graphLlmRelationEnabled: settings.graphEnabled && settings.graphLlmRelationEnabled,
          idempotencyKey: `capture:${jobId}:repair:${group.map(candidate => candidate.id).sort().join(',')}:${attemptNo}`,
          includeHiddenMessageFloors,
          ...(onUsage ? { onUsage } : {}),
        });
      } catch (error) {
        const failure = readSSHelperFailure(error, {
          reasonCode: 'REPAIR_UNRESOLVED',
          stage: 'memory.repair.execute',
        })!;
        const diagnostic = SS_HELPER_DIAGNOSTICS[failure.reasonCode];
        const failureCode = diagnostic.transportCode;
        const interrupted = diagnostic.retryable
          || failureCode === 'ABORTED'
          || failureCode === 'TIMEOUT'
          || failureCode === 'CORE_UNAVAILABLE'
          || failureCode === 'CONFLICT'
          || failureCode === 'STALE_SESSION';
        for (const candidate of group) {
          const finalFailure = !interrupted && candidate.evidenceRetryUsed === true;
          const nextRecord: CaptureRepairQueueRecord = {
            ...candidate,
            status: interrupted ? 'queued' : finalFailure ? 'ignored' : 'unresolved',
            attemptCount: interrupted ? candidate.attemptCount : attemptNo,
            maxAttempts,
            evidenceSetHash: evidenceSetHashes.get(candidate.id)!,
            waitingForEvidenceChange: !interrupted && !finalFailure,
            ...(finalFailure ? { resolutionMode: 'ignored' as const, resolvedAt: Date.now() } : {}),
            failure: {
              ...failure,
              batchIndex: candidate.batchIndex,
              collection: candidate.collection,
            },
            updatedAt: Date.now(),
          };
          await repository.updateCaptureRepairRecord(nextRecord);
          if (!interrupted) {
            await this.resolveCaptureRepairAudit(
              repository,
              jobId,
              nextRecord,
              attemptNo,
              finalFailure ? 'ignored' : 'quarantined',
            );
            completedRecordIds.add(candidate.id);
          }
        }
        // Cancellation, timeout and Workspace transport/concurrency failures
        // do not consume a semantic repair attempt. Stop the current
        // repair phase and let the job resume the same queue record later with
        // its stable Capture idempotency key.
        if (interrupted) throw error;
        processed = completedRecordIds.size;
        this.activeCaptureProgress = {
          ...usageProgress(this.activeCaptureProgress ?? {}),
          status: 'repairing',
          jobId,
          batchIndex: processed,
          totalBatches: total,
          processedCount: processed,
          elapsedMs: Date.now() - this.captureStartedAt,
          phase: 'repair',
          pendingRepairCount: Math.max(0, total - processed),
        };
        this.emitOverviewChanged();
        continue;
      }

      results.push(result);
      const recordType = record.collection === 'actorCandidates' ? 'actor'
        : record.collection === 'locationCandidates' ? 'location'
          : record.collection === 'itemCandidates' ? 'item'
            : record.collection === 'episodes' ? 'episode'
              : record.collection === 'inventoryOperations' ? 'inventory'
                : 'claim';
      const latestIssues = result.rejections.flatMap(rejection =>
        rejection.issues?.map(issue => ({
          path: issue.path,
          keyword: issue.keyword,
          expected: issue.expected,
        })) ?? [{
          path: rejection.fieldPath ?? '$',
          keyword: rejection.code ?? 'validation',
          expected: '符合来源支持规则的结构化字段',
        }]).slice(0, 16);
      const declaredDecisions = result.repairDecisions ?? [];
      const compatibilityDecision: StructuredRepairDecision[] = declaredDecisions.length === 0 && group.length === 1
        && result.acceptedLocalIds[recordType][0]
        ? [{
          repairId: group[0]!.id,
          action: 'emit' as const,
          localId: result.acceptedLocalIds[recordType][0],
          sourceRefs: group[0]!.sourceRefs.length > 0 ? group[0]!.sourceRefs : group[0]!.fallbackSourceRefs,
        }]
        : [];
      const decisions = new Map([...declaredDecisions, ...compatibilityDecision]
        .map(decision => [decision.repairId, decision] as const));
      for (const candidate of group) {
        const decision = decisions.get(candidate.id);
        const targetSources = new Set(candidate.sourceRefs.length > 0 ? candidate.sourceRefs : candidate.fallbackSourceRefs);
        const decisionSourcesSupported = Boolean(decision?.sourceRefs?.length)
          && decision!.sourceRefs!.every(sourceRef => targetSources.has(sourceRef));
        const ignoredByValidator = decision?.action === 'emit'
          && Number.isInteger(decision.itemIndex)
          && result.rejections.some(rejection => rejection.index === decision.itemIndex
            && (rejection.recordType ?? recordType) === recordType
            && rejection.status === 'ignored');
        const succeeded = decision?.action === 'emit'
          && !ignoredByValidator
          && Boolean(decision.localId)
          && decisionSourcesSupported
          && result.acceptedLocalIds[recordType].includes(decision.localId!);
        const dropped = decision?.action === 'drop' || ignoredByValidator;
        const finalFailure = !succeeded && !dropped && candidate.evidenceRetryUsed === true;
        const recordWithoutFailure = { ...candidate };
        delete recordWithoutFailure.failure;
        const nextRecord: CaptureRepairQueueRecord = {
          ...recordWithoutFailure,
          status: succeeded ? 'running' : dropped || finalFailure ? 'ignored' : 'unresolved',
          classification: succeeded && (result.fieldActions?.length || result.resolutionMode === 'degraded')
            ? 'locally_fixed'
            : candidate.classification ?? 'ai_required',
          attemptCount: attemptNo,
          maxAttempts,
          evidenceSetHash: evidenceSetHashes.get(candidate.id)!,
          waitingForEvidenceChange: !succeeded && !dropped && !finalFailure,
          ...(result.candidateSetHash ? { candidateSetHash: result.candidateSetHash } : {}),
          ...(succeeded ? { resolutionMode: result.resolutionMode ?? 'repaired' as const } : {}),
          ...(dropped || finalFailure ? { resolutionMode: 'ignored' as const, resolvedAt: Date.now() } : {}),
          ...(succeeded && result.fieldActions?.length ? { fieldActions: [...result.fieldActions] } : {}),
          ...(!succeeded && !dropped && latestIssues.length > 0 ? { issues: latestIssues } : {}),
          ...(result.audit?.requestId ? { repairRequestId: result.audit.requestId } : {}),
          ...(!succeeded && !dropped ? {
            failure: {
              reasonCode: 'REPAIR_UNRESOLVED',
              stage: 'memory.repair.validate',
              batchIndex: candidate.batchIndex,
              collection: candidate.collection,
            } satisfies SSHelperFailureContext,
          } : {}),
          updatedAt: Date.now(),
        };
        await repository.updateCaptureRepairRecord(nextRecord);
        if (succeeded || dropped || finalFailure) {
        try {
          // The Change Audit is the source of truth for job projections. Updating
          // it also resolves the linked queue row in the same Workspace commit.
          await this.resolveCaptureRepairAudit(
            repository,
            jobId,
            nextRecord,
            attemptNo,
            succeeded ? 'repaired' : 'ignored',
          );
        } catch (error) {
          const failure = readSSHelperFailure(error, {
            reasonCode: 'MEMORY_CAPTURE_INTEGRITY_FAILED',
            stage: 'memory.repair.audit-writeback',
          })!;
          await repository.updateCaptureRepairRecord({
            ...candidate,
            status: 'queued',
            attemptCount: candidate.attemptCount,
            failure,
            updatedAt: Date.now(),
          });
          throw error;
        }
          for (const rejectionId of candidate.rejectionIds?.length
            ? candidate.rejectionIds
            : candidate.rejectionId ? [candidate.rejectionId] : []) resolvedRejectionIds.add(rejectionId);
        } else {
          await this.resolveCaptureRepairAudit(repository, jobId, nextRecord, attemptNo, 'quarantined');
        }
        completedRecordIds.add(candidate.id);
      }
      processed = completedRecordIds.size;
      this.activeCaptureProgress = {
        ...usageProgress(this.activeCaptureProgress ?? {}),
        status: 'repairing',
        jobId,
        batchIndex: processed,
        totalBatches: total,
        processedCount: processed,
        elapsedMs: Date.now() - this.captureStartedAt,
        phase: 'repair',
        pendingRepairCount: Math.max(0, total - processed),
      };
      this.emitOverviewChanged();
      if (processed % 10 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    const finalQueue = await repository.listCaptureRepairQueue(jobId);
    const remaining = this.captureRepairQueueCounts(finalQueue).retryable;
    const degraded = finalQueue
      .filter(record => record.status === 'resolved' && record.resolutionMode === 'degraded').length;
    return { results, resolvedRejectionIds, remaining, degraded };
  }

  private async rollbackActorCaptureResults(
    results: readonly import('./actors').MultiActorCaptureResult[],
    repository = this.multiActorRepository,
  ): Promise<void> {
    if (!repository) return;
    const failures: unknown[] = [];
    for (const result of [...results].reverse()) {
      if (!result.changeAudit?.id) continue;
      try {
        await repository.rollbackChangeSet(result.changeAudit.id);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw createSSHelperError('MEMORY_CAPTURE_ROLLBACK_FAILED', {
        stage: 'memory.capture.rollback',
      });
    }
    await this.reloadActorDirectoryState(repository);
  }

  private async finalizeActorCaptureResults(
    results: readonly import('./actors').MultiActorCaptureResult[],
    sources: readonly SourceBlock[],
    captureVersion: number,
    chatKey: string,
    scheduleIndexes = true,
  ): Promise<void> {
    const repository = this.multiActorRepository;
    const registry = this.actorRegistry;
    const committedResults = results;
    const lastResult = committedResults.at(-1);
    if (!repository || !lastResult) return;
    const currentFloor = Math.max(0, ...sources.map(source => source.floor ?? 0));
    const [facts, traces] = await Promise.all([repository.listFacts(), repository.listTraces()]);
    this.assertCaptureCurrent(captureVersion, chatKey);
    const aggregateResult: import('./actors').MultiActorCaptureResult = {
      ...lastResult,
      owners: registry?.listOwners() ?? lastResult.owners,
      facts,
      traces,
    };
    const finalChangeSetId = lastResult.changeAudit?.id;
    // Job-final derived projections are attached to the last batch ChangeSet.
    // Rolling that ChangeSet back also removes/restores every derived write
    // produced after the multi-batch job completed.
    const persistedTraces = await this.persistCaptureDerivations(aggregateResult, chatKey, repository, registry);
    if (this.stopped || this.captureVersion !== captureVersion || this.getChatKey() !== chatKey) {
      await this.rollbackActorCaptureResults(results, repository);
      throw new Error('聊天已切换，Capture 派生结果已丢弃。');
    }
    const activeActorIds = new Set([...aggregateResult.sceneCast.presentOwnerIds, ...aggregateResult.sceneCast.speakerOwnerIds].filter(ownerId => ownerId.startsWith('owner:actor:')));
    const changedActorIds = new Set(traces.map(trace => trace.ownerId).filter(ownerId => ownerId.startsWith('owner:actor:')));
    // A card/world seed may be the only new evidence for an actor that is not
    // currently in the cast. It is allowed to bootstrap that actor's profile;
    // a merely mentioned/present actor with no new trace is not.
    const seededActorIds = new Set(facts
      .filter(fact => Boolean(fact.scope?.hostCardKeys?.length || fact.scope?.worldKeys?.length))
      .flatMap(fact => fact.entityKeys.filter(ownerId => ownerId.startsWith('owner:actor:'))));
    const profileActorIds = new Set([...activeActorIds].filter(ownerId => changedActorIds.has(ownerId)).concat([...seededActorIds]));
    const dreamSchedules: { readonly jobId: string; readonly ownerId: string }[] = [];
    const enqueuedDreamJobIds: string[] = [];
    try {
      this.assertCaptureCurrent(captureVersion, chatKey);
      for (const ownerId of profileActorIds) {
        await this.updateActorProfile(ownerId, finalChangeSetId, repository).catch(error => logger.warn('人物画像派生失败。', error));
        this.assertCaptureCurrent(captureVersion, chatKey);
      }
      for (const owner of aggregateResult.owners.filter(item => item.kind === 'actor' && activeActorIds.has(item.id))) {
        this.assertCaptureCurrent(captureVersion, chatKey);
        const ownerTraceIds = persistedTraces.filter(trace => trace.ownerId === owner.id).map(trace => trace.id);
        const existingJobs = await repository.listDerived('dream-jobs', owner.id);
        const activeJob = existingJobs.find(job => job.status === 'queued' || job.status === 'running');
        if (activeJob) {
          dreamSchedules.push({ jobId: String(activeJob.id), ownerId: owner.id });
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
        const salient = Math.min(1, Math.max(0, ...persistedTraces.filter(trace => changedTraceIds.has(trace.id)).map(trace => trace.emotionalSalience)));
        if (!this.dreamCoordinator.shouldTrigger({ ownerId: owner.id, addedTraceCount, visibleFloorCount, salient })) continue;
        const trigger: import('../domain').DreamJob['trigger'] = salient >= 0.85 ? 'salience' : addedTraceCount >= this.dreamCoordinator.options.traceThreshold ? 'trace-count' : 'floor-count';
        try {
          const job = this.dreamCoordinator.enqueue({ workspaceId: this.hostContext?.getWorkspaceId() ?? '', chatKey, ownerId: owner.id, traceIds: ownerTraceIds, trigger });
          enqueuedDreamJobIds.push(job.id);
          const dreamRecord = {
            ...job,
            visibleFloor: currentFloor,
            ...(finalChangeSetId ? { sourceChangeSetId: finalChangeSetId } : {}),
          };
          if (finalChangeSetId) {
            await repository.upsertDerivedForChangeSet(finalChangeSetId, [{ collection: 'dream-jobs', records: [dreamRecord] }]);
          } else {
            await repository.upsertDerived('dream-jobs', [dreamRecord]);
          }
          this.assertCaptureCurrent(captureVersion, chatKey);
          dreamSchedules.push({ jobId: job.id, ownerId: owner.id });
        } catch (error) {
          // Dream is a derived, retryable projection. A queue/index failure must
          // never turn an already committed Capture into a failed chat write.
          if (this.stopped || this.captureVersion !== captureVersion || this.getChatKey() !== chatKey) throw error;
          logger.warn('自动 Dream 入队失败，已保留 Capture 结果。', error);
        }
      }
    } catch (error) {
      if (this.stopped || this.captureVersion !== captureVersion || this.getChatKey() !== chatKey) {
        for (const jobId of enqueuedDreamJobIds) this.dreamCoordinator.forgetJob(jobId);
        await this.rollbackActorCaptureResults(results, repository);
      }
      throw error;
    }
    // Do not mutate current-chat runtime state until every asynchronous write
    // has completed and the original scope is still current. Otherwise a late
    // old-chat finalizer can overwrite a freshly bound chat's recall index,
    // scene cast, exposure tracker or automatic Dream timer.
    this.assertCaptureCurrent(captureVersion, chatKey);
    this.lastSceneCast = aggregateResult.sceneCast;
    this.recallIndex.replace(facts);
    this.actorExposureTracker = new RecallExposureTracker(persistedTraces);
    this.lastExposureIds.clear();
    const effectiveSettings = this.getEffectiveSettings();
    if (scheduleIndexes && usesVectorIndex(effectiveSettings)) this.scheduleVectorSync(chatKey);
    if (scheduleIndexes && effectiveSettings.graphEnabled) this.scheduleGraph(chatKey);
    for (const schedule of dreamSchedules) this.scheduleAutomaticDream(schedule.jobId, chatKey, schedule.ownerId);
  }

  private async runActorCapture(
    sourceOverride?: readonly SourceBlock[],
    captureJobId?: string,
    reviewOverride?: import('./ingest/types').MemoryExtractionInput['reviewOverride'],
    stage?: import('./ingest/types').MemoryExtractionInput['stage'],
  ): Promise<import('./actors').MultiActorCaptureResult> {
    const context = this.hostContext;
    if (!this.actorCapture || !context) throw new Error('多角色 Memory 尚未绑定宿主工作区。');
    const chatKey = this.getChatKey();
    const captureVersion = this.captureVersion;
    const sources = sourceOverride ? [...sourceOverride] : await context.collectSources(chatKey);
    const settings = this.getEffectiveSettings();
    const baselineFacts = settings.preExtractReferenceEnabled ? await this.multiActorRepository?.listFacts() ?? [] : [];
    const referenceScope = settings.preExtractReferenceEnabled ? await context.getRecallContext?.() : undefined;
    const referenceRetriever = settings.preExtractReferenceEnabled
      ? new ExistingMemoryContextRetriever(
        baselineFacts,
        this.vectorIndex,
        settings.graphEnabled ? new MemoryGraphRecallIndex(deriveMemoryGraphProjection(baselineFacts)) : undefined,
      )
      : null;
    const existingMemoryContext = referenceRetriever ? await referenceRetriever.load({
      chatKey,
      sources,
      maxItems: settings.preExtractReferenceItems,
      maxChars: settings.preExtractReferenceMaxChars,
      mode: settings.preExtractReferenceMode,
      characterKeys: referenceScope?.characterKeys ?? [],
      worldKeys: referenceScope?.worldKeys ?? [],
      graphMaxHops: settings.graphMaxHops,
      graphMaxEdges: settings.graphMaxEdges,
    }) : [];
    this.assertCaptureCurrent(captureVersion, chatKey);
    const result = await this.executeActorCapture(sources, {
      ...(captureJobId ? { captureJobId } : {}),
      existingMemoryContext,
      graphLlmRelationEnabled: settings.graphEnabled && settings.graphLlmRelationEnabled,
      ...(reviewOverride === undefined ? {} : { reviewOverride }),
      ...(stage === undefined ? {} : { stage }),
    });
    await this.finalizeActorCaptureResults([result], sources, captureVersion, chatKey);
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
        const failureCount = attempt + 1;
        if (failureCount >= MAX_AUTOMATIC_DREAM_FAILURES) {
          logger.warn(`自动 Dream 连续失败 ${failureCount} 次，已停止自动重试并保留失败状态。`, error);
          this.emitOverviewChanged();
          return;
        }
        logger.warn(`自动 Dream 失败，将按指数退避重试（${failureCount}/${MAX_AUTOMATIC_DREAM_FAILURES}）。`, error);
        if (!this.stopped && this.getChatKey() === chatKey) this.scheduleAutomaticDream(jobId, chatKey, ownerId, failureCount);
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
    repository = this.multiActorRepository,
    registry = this.actorRegistry,
  ): Promise<readonly ActorMemoryTrace[]> {
    if (!repository) return result.traces;
    const traces = await repository.listTraces();
    const factsById = new Map(result.facts.map(fact => [fact.id, fact]));
    const ownersById = new Map((registry?.listOwners() ?? []).map(owner => [owner.id, owner]));
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

  /**
   * Capture projections are rebuildable caches. A newest-first batch rollback
   * can remove the job-final derived children that represented all earlier
   * batches, so recreate those projections from the remaining facts/traces and
   * attach them to the newest surviving root Capture ChangeSet.
   */
  private async rebuildCaptureProjections(
    repository: MultiActorMemoryRepository,
  ): Promise<{ readonly facts: readonly MemoryFact[]; readonly traces: readonly ActorMemoryTrace[] }> {
    const registry = this.actorRegistry;
    const locationRegistry = this.locationRegistry;
    const chatKey = repository.boundChatKey;
    const [facts, traces, sceneCasts, audits] = await Promise.all([
      repository.listFacts(),
      repository.listTraces(),
      repository.listSceneCasts(),
      repository.listChangeAudits(),
    ]);
    const latestParent = audits
      .filter(record => String(record.kind ?? '') === 'capture-change-set-v0' && !record.rolledBackAt)
      .sort((left, right) => Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0)
        || String(right.id ?? '').localeCompare(String(left.id ?? '')))[0] as unknown as import('../infrastructure').ChangeAudit | undefined;
    const sceneCast = [...sceneCasts]
      .sort((left, right) => right.floor - left.floor || right.createdAt - left.createdAt)[0]
      ?? {
        id: `scene:rollback-rebuild:${encodeURIComponent(chatKey)}`,
        workspaceId: repository.boundWorkspaceId,
        chatKey,
        floor: 0,
        members: [],
        viewpointOwnerId: FIXED_OWNER_IDS.unknown,
        speakerOwnerIds: [],
        presentOwnerIds: [],
        mentionedOwnerIds: [],
        createdAt: Date.now(),
      } satisfies SceneCast;
    const rebuilt: import('./actors').MultiActorCaptureResult = {
      envelope: {
        workspaceId: repository.boundWorkspaceId,
        chatKey,
        sourceRefs: [...new Set(facts.flatMap(fact => fact.sourceRefs))],
        actorCandidates: [],
        locationCandidates: [],
        episodes: [],
        claimLocalIds: [],
        capturedAt: Date.now(),
      },
      owners: registry?.listOwners() ?? [],
      pendingCandidates: registry?.listPending() ?? [],
      locations: locationRegistry?.listLocations() ?? [],
      locationAliases: locationRegistry?.listAliases() ?? [],
      pendingLocationCandidates: locationRegistry?.listPending() ?? [],
      inventoryItems: [],
      inventoryStates: [],
      inventoryEvents: [],
      episodes: [],
      observations: [],
      facts,
      traces,
      sceneCast,
      outcome: 'complete',
      rejections: [],
      acceptedLocalIds: { actor: [], location: [], item: [], episode: [], claim: [], inventory: [] },
      ...(latestParent ? { changeAudit: latestParent } : {}),
    };
    await this.persistCaptureDerivations(rebuilt, chatKey, repository, registry);
    const ownerIds = [...new Set(traces
      .map(trace => trace.ownerId)
      .filter(ownerId => ownerId.startsWith('owner:actor:')))];
    for (const ownerId of ownerIds) {
      await this.updateActorProfile(ownerId, latestParent?.id, repository);
    }
    return { facts, traces };
  }

  private async performActorRecall(
    request: ActorRecallRequest,
    actorRepository: MultiActorMemoryRepository,
    semanticRecall: SemanticRecallService,
    settings: MemoryGlobalSettings,
  ): Promise<ActorRecallResponse> {
    const service = new ActorRecallService({
      recallObjective: (query) => {
        const level = query.retrievalLevel ?? 4;
        const recallMode = level <= 1 ? 'lexical' : settings.recallMode;
        const rerankMode = level >= 4 && settings.rerankMode !== 'off' ? settings.rerankMode : 'off';
        const graphOptions = level >= 3 && settings.graphEnabled && request.intentPlan?.graphHops !== 0
          ? {
            maxHops: request.intentPlan?.graphHops === 2 ? 2 as const : settings.graphMaxHops,
            maxEdges: settings.graphMaxEdges,
          }
          : undefined;
        return semanticRecall.recall(query, recallMode, rerankMode, graphOptions);
      },
      listTraces: () => actorRepository.listTraces(),
      getFact: factId => actorRepository.getFact(factId),
      getOwner: ownerId => actorRepository.getOwner(ownerId),
    });
    return service.recall(request);
  }

  /** Performs owner-aware recall; each partition receives an independent candidate pool. */
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
    const scopeRevision = this.generationScopeRevision;
    const isCurrent = (): boolean => this.generationScopeRevision === scopeRevision
      && this.multiActorRepository === actorRepository
      && this.actorRegistry === registry;
    const staleScopeError = (): Error => createSSHelperError('MEMORY_STALE_GENERATION_SCOPE', {
      stage: 'memory.recall.scope',
    });
    const chatKey = input.chatKey?.trim() || this.getChatKey();
    let scene = input.scene ?? this.lastSceneCast;
    if (scene && (scene.chatKey !== chatKey || scene.workspaceId !== context.getWorkspaceId())) scene = null;
    if (!scene) {
      const sources = await context.collectSources(chatKey);
      if (!isCurrent()) throw staleScopeError();
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
    const result = await this.performActorRecall(
      { ...input, workspaceId: context.getWorkspaceId(), chatKey, scene },
      actorRepository,
      this.semanticRecall,
      settings,
    );
    if (!isCurrent()) throw staleScopeError();
    this.lastActorRecall = result;
    return result;
  }

  async auditActorOutput(output: string): Promise<KnowledgeLeakageAudit | null> {
    if (!this.lastActorRecall) return null;
    const response = this.lastActorRecall;
    const repository = this.multiActorRepository;
    if (repository) await (async () => {
      const traces = await repository.listTraces();
      const classified = new MemoryUsageClassifier().classify({
        output,
        response,
        traces,
        includedTraceIds: this.lastIncludedTraceIds,
        planId: response.request.castPlan.id,
      });
      const usedExposures: import('../domain').RecallExposure[] = [];
      for (const item of classified.evidence.filter(item => item.usage !== 'not_used')) {
        const exposureId = this.lastExposureIds.get(item.traceId);
        if (!exposureId) continue;
        try {
          usedExposures.push(this.actorExposureTracker.markUsed(exposureId, item.confidence, item.usage === 'explicit').exposure);
        } catch {
          // A stale exposure from a previous scope is ignored fail-closed.
        }
      }
      if (classified.updatedTraces.length > 0) await repository.upsertTraces(classified.updatedTraces);
      if (classified.logs.length > 0) await repository.recordMemoryUsage(classified.logs);
      if (usedExposures.length > 0) await repository.upsertDerived('recall-exposures', usedExposures.map(exposure => ({ ...exposure })));
    })().catch(error => logger.warn('角色记忆使用分类持久化失败。', error));
    const audit = auditKnowledgeLeakage(output, [this.lastActorRecall.world, this.lastActorRecall.narrator, ...this.lastActorRecall.actors]);
    if (this.multiActorRepository) {
      await this.multiActorRepository.recordKnowledgeLeakageAudit(audit)
        .catch(error => logger.warn('角色知识泄漏审计持久化失败。', error));
    }
    return audit;
  }

  async buildActorMemoryPrompt(input: Omit<ActorRecallRequest, 'workspaceId' | 'chatKey' | 'scene'> & { scene?: SceneCast; chatKey?: string; maxChars?: number }): Promise<ActorMemoryPromptResult> {
    const settings = this.getEffectiveSettings();
    let response: ActorRecallResponse;
    let built: ActorMemoryPromptResult;
    let exposureRepository = this.multiActorRepository;
    if (!input.scene && this.generationMemoryCoordinator && this.hostContext && this.multiActorRepository && this.actorRegistry) {
      const coordinator = this.generationMemoryCoordinator;
      const context = this.hostContext;
      const repository = this.multiActorRepository;
      const registry = this.actorRegistry;
      const scopeRevision = this.generationScopeRevision;
      const isCurrent = (): boolean => this.generationScopeRevision === scopeRevision
        && this.generationMemoryCoordinator === coordinator
        && this.hostContext === context
        && this.multiActorRepository === repository
        && this.actorRegistry === registry;
      const staleScopeError = (): Error => createSSHelperError('MEMORY_STALE_GENERATION_SCOPE', {
        stage: 'memory.generation.prepare.scope',
      });
      const chatKey = input.chatKey?.trim() || this.getChatKey();
      const sources = await context.collectSources(chatKey);
      if (!isCurrent()) throw staleScopeError();
      const currentFloor = Math.max(0, ...sources.map(source => source.floor ?? 0));
      const prepared = await coordinator.prepareGenerationMemory({
        workspaceId: context.getWorkspaceId(),
        chatKey,
        currentFloor,
        userMessage: input.query,
        maxItems: input.maxItems ?? settings.maxRecallItems,
        maxChars: input.maxChars ?? settings.promptMaxChars,
        settings,
        now: input.now ?? Date.now(),
      });
      if (!isCurrent()) throw staleScopeError();
      this.lastPreparedGeneration = prepared;
      this.lastSceneState = prepared.sceneState;
      this.lastSceneCast = prepared.sceneCast;
      this.lastActorRecall = prepared.recalled;
      response = prepared.recalled;
      built = prepared.prompt;
      exposureRepository = repository;
    } else {
      response = await this.recallActors(input);
      built = buildActorMemoryPromptResult(response, { maxChars: input.maxChars ?? settings.promptMaxChars, sceneLabel: response.request.chatKey, castPlan: response.request.castPlan });
      exposureRepository = this.multiActorRepository;
    }
    this.lastIncludedTraceIds = [...built.includedTraceIds];
    if (exposureRepository
      && exposureRepository.boundWorkspaceId === response.request.workspaceId
      && exposureRepository.boundChatKey === response.request.chatKey) {
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
      // Recall exposures are rebuildable diagnostics. Their persistence must
      // not suppress an otherwise valid prompt contribution.
      await exposureRepository.upsertDerived('recall-exposures', exposures.map(exposure => ({ ...exposure })))
        .catch(error => logger.warn('RecallExposure 派生记录写入失败，继续使用已生成的记忆 Prompt。', error));
    }
    return built;
  }

  /** Reconciles the latest official assistant message against the saved generation plan. */
  async reconcileGeneratedMessage(): Promise<void> {
    const prepared = this.lastPreparedGeneration;
    const reconciler = this.actualCastReconciler;
    const repository = this.multiActorRepository;
    const registry = this.actorRegistry;
    const context = this.hostContext;
    if (!prepared || !reconciler || !repository || !registry || !context) return;
    if (prepared.castPlan.chatKey !== this.getChatKey() || prepared.castPlan.workspaceId !== context.getWorkspaceId()) return;
    // Consume once so duplicate generation-ended notifications cannot apply the same turn twice.
    this.lastPreparedGeneration = null;
    const sources = await context.collectSources(prepared.castPlan.chatKey);
    const generatedSource = [...sources]
      .filter(source => source.kind === 'message' && source.role === 'assistant' && (source.floor ?? 0) >= prepared.castPlan.basedOnFloor)
      .sort((left, right) => (right.floor ?? 0) - (left.floor ?? 0) || right.createdAt - left.createdAt)[0];
    if (!generatedSource) return;
    const result = await reconciler.reconcile({
      plan: prepared.castPlan,
      sources,
      generatedSource,
      currentFloor: generatedSource.floor ?? prepared.castPlan.basedOnFloor,
      unplannedActorPolicy: this.getEffectiveSettings().unplannedActorPolicy,
    });
    this.lastSceneState = result.state;
    const metadata = { castPlanId: prepared.castPlan.id, castPlanAuditId: result.audit.id, operation: 'actual-cast-reconcile' };
    if (result.promotions.length === 0) {
      await repository.upsertActorRegistryState(registry.listOwners(), registry.listAliases(), metadata, undefined, registry.listPending());
    } else {
      for (const promotion of result.promotions) {
        await repository.upsertActorRegistryState(registry.listOwners(), registry.listAliases(), metadata, { fromOwnerId: promotion.fromOwnerId, toOwnerId: promotion.toOwnerId }, registry.listPending());
      }
    }
    this.emitOverviewChanged();
  }

  async updateActorProfile(
    ownerId: string,
    sourceChangeSetId?: string,
    repository = this.multiActorRepository,
  ): Promise<readonly import('../domain').ProfileClaim[]> {
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
      if (!sourceChangeSetId) this.emitOverviewChanged();
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
    this.emitOverviewChanged();
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
    let result: Awaited<ReturnType<DreamCoordinator['run']>>;
    try {
      result = await this.dreamCoordinator.run(jobId, traces, async (apply: DreamApplyResult) => {
        const profileClaims = profile.claims.map(claim => ({ ...claim, workspaceId: repository.boundWorkspaceId }));
        const links = apply.links.map(link => ({ ...link, workspaceId: repository.boundWorkspaceId, chatKey: repository.boundChatKey }));
        const change = await repository.upsertDerivedWithAudit([
          { collection: 'profile-claims', records: profileClaims },
          { collection: 'memory-links', records: links },
        ], 'dream-change-set-v0', { jobId: job.id, ownerId: job.ownerId });
        return { profileClaims, links, changeSetId: change.id, undoToken: change.id };
      }, options);
    } catch (error) {
      const failedJob = this.dreamCoordinator.listJobs().find(item => item.id === jobId);
      if (failedJob) {
        await repository.upsertDerived('dream-jobs', [{
          ...failedJob,
          workspaceId: repository.boundWorkspaceId,
          chatKey: repository.boundChatKey,
          ...(Number.isFinite(visibleFloor) ? { visibleFloor } : {}),
        }]).catch(persistError => logger.warn('Dream 失败状态持久化失败。', persistError));
      }
      this.emitOverviewChanged();
      throw error;
    }
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
    this.emitOverviewChanged();
    return result.audit;
  }

  async listActors(): Promise<readonly import('../domain').MemoryOwner[]> {
    return this.multiActorRepository ? this.multiActorRepository.listOwners() : [];
  }

  async listInventoryStates(): Promise<{
    readonly items: readonly import('../domain').InventoryItem[];
    readonly states: readonly import('../domain').InventoryState[];
  }> {
    if (!this.multiActorRepository) return { items: [], states: [] };
    const [items, states] = await Promise.all([
      this.multiActorRepository.listInventoryItems(),
      this.multiActorRepository.listInventoryStates(),
    ]);
    return { items, states };
  }

  async getInventoryHistory(itemId: string): Promise<readonly import('../domain').InventoryEvent[]> {
    return this.multiActorRepository ? this.multiActorRepository.listInventoryEvents(itemId, { includeNoop: true }) : [];
  }

  async createInventoryItem(input: {
    readonly canonicalName: string;
    readonly aliases?: readonly string[];
    readonly category?: import('../domain').InventoryItemCategory;
  }): Promise<import('../domain').InventoryItem> {
    if (!this.multiActorRepository) throw createSSHelperError('MEMORY_CAPTURE_NOT_BOUND', { stage: 'memory.inventory.item.create' });
    const item = await this.multiActorRepository.createInventoryItem(input);
    this.emitOverviewChanged();
    return item;
  }

  async applyInventoryCommand(
    command: import('../domain').InventoryCommand,
    options?: { readonly expectedRevision?: number; readonly idempotencyKey?: string },
  ): Promise<{ readonly state: import('../domain').InventoryState; readonly event: import('../domain').InventoryEvent }> {
    if (!this.multiActorRepository) throw createSSHelperError('MEMORY_CAPTURE_NOT_BOUND', { stage: 'memory.inventory.command.apply' });
    const result = await this.multiActorRepository.applyInventoryCommand(command, options);
    this.emitOverviewChanged();
    return result;
  }

  async invalidateInventoryItem(itemId: string): Promise<import('../domain').InventoryItem> {
    if (!this.multiActorRepository) throw createSSHelperError('MEMORY_CAPTURE_NOT_BOUND', { stage: 'memory.inventory.item.invalidate' });
    const item = await this.multiActorRepository.invalidateInventoryItem(itemId);
    this.emitOverviewChanged();
    return item;
  }

  async listActorAliases(): Promise<readonly import('../domain').ActorAlias[]> {
    return this.multiActorRepository
      ? this.multiActorRepository.listAliases()
      : this.actorRegistry?.listAliases() ?? [];
  }

  async listPendingActorCandidates(): Promise<readonly ActorCandidate[]> {
    return this.multiActorRepository
      ? this.multiActorRepository.listPendingCandidates()
      : this.actorRegistry?.listPending() ?? [];
  }

  async listMemoryReviewItems(status?: MemoryReviewItem['status']): Promise<readonly MemoryReviewItem[]> {
    if (!this.multiActorRepository) return [];
    return new MemoryReviewQueue(this.multiActorRepository).list(status);
  }

  async resolveMemoryReviewItem(id: string, action: MemoryReviewAction, payload?: PlainData): Promise<MemoryReviewItem> {
    if (!this.multiActorRepository) throw createSSHelperError('MEMORY_CAPTURE_NOT_BOUND', { stage: 'memory.review.bind' });
    const queue = new MemoryReviewQueue(this.multiActorRepository);
    validateMemoryReviewResolution(action, payload);
    const item = (await queue.list('pending')).find(candidate => candidate.id === id);
    if (!item) throw createSSHelperError('MEMORY_UPDATE_PENDING_REVIEW', { stage: 'memory.review.lookup', resourceId: id });
    if (action !== 'reject') {
      const context = this.hostContext;
      if (!context || item.chatKey !== this.getChatKey()) throw createSSHelperError('MEMORY_STALE_GENERATION_SCOPE', { stage: 'memory.review.scope' });
      const allSources = await context.collectSources(item.chatKey);
      const sourceSet = new Set(item.sourceRefs);
      const sources = allSources.filter(source => sourceSet.has(source.id));
      if (sources.length === 0) throw createSSHelperError('MEMORY_CAPTURE_EVIDENCE_MISMATCH', { stage: 'memory.review.sources' });
      const reviewOverride = action === 'reextract' ? undefined : { candidateLocalId: item.candidateLocalId, action, ...(payload === undefined ? {} : { payload }) } as const;
      const stage = item.stage === 'repair' ? undefined : item.stage;
      const capture = await this.runActorCapture(sources, undefined, reviewOverride, stage);
      const accepted = Object.values(capture.acceptedLocalIds).some(localIds => localIds.includes(item.candidateLocalId));
      if (action !== 'reextract' && !accepted) throw createSSHelperError('MEMORY_UPDATE_PENDING_REVIEW', { stage: 'memory.review.commit-guard' });
    }
    const result = await queue.resolve(id, action, payload);
    this.emitOverviewChanged();
    return result;
  }

  async exportMemoryReviewGold(): Promise<PlainData> {
    if (!this.multiActorRepository) return [];
    return new MemoryReviewQueue(this.multiActorRepository).exportGold();
  }

  async listLocations(): Promise<readonly import('../domain').MemoryLocation[]> {
    return this.multiActorRepository ? this.multiActorRepository.listLocations() : [];
  }

  async listLocationAliases(): Promise<readonly import('../domain').LocationAlias[]> {
    return this.multiActorRepository
      ? this.multiActorRepository.listLocationAliases()
      : this.locationRegistry?.listAliases() ?? [];
  }

  async listPendingLocationCandidates(): Promise<readonly import('../domain').LocationCandidate[]> {
    return this.multiActorRepository
      ? this.multiActorRepository.listPendingLocationCandidates()
      : this.locationRegistry?.listPending() ?? [];
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

  private async persistActorRegistryChange(
    metadata: Record<string, unknown> = {},
    migration?: { readonly fromOwnerId: string; readonly toOwnerId: string },
  ): Promise<void> {
    if (!this.actorRegistry) return;
    if (!this.multiActorRepository) {
      this.emitOverviewChanged();
      return;
    }
    const registryAudit = this.actorRegistry.listAudits().at(-1);
    const persistedMetadata = registryAudit ? { ...metadata, registryAudit: structuredClone(registryAudit) } : metadata;
    const audit = await this.multiActorRepository.upsertActorRegistryState(
      this.actorRegistry.listOwners(),
      this.actorRegistry.listAliases(),
      persistedMetadata,
      migration,
      this.actorRegistry.listPending(),
    );
    const registryAuditId = typeof metadata.registryAuditId === 'string' ? metadata.registryAuditId : undefined;
    if (registryAuditId) this.actorCorrectionChangeSets.set(registryAuditId, audit.id);
    if (migration) await this.bindCurrentChat();
    this.emitOverviewChanged();
  }

  async confirmActorCandidate(candidateId: string, resolution?: import('../domain').ActorCandidateResolution): Promise<void> {
    if (!this.actorRegistry) throw new Error('人物注册表尚未就绪。');
    const pending = this.actorRegistry.listPending().find(candidate => candidate.localId === candidateId);
    if (!pending) throw new Error('待确认人物不存在。');
    const provisional = pending.ownerRef ? this.actorRegistry.getOwner(pending.ownerRef) : undefined;
    const confirmed = this.actorRegistry.confirm(candidateId, resolution);
    if (!confirmed) throw new Error('待确认人物不存在。');
    const registryAuditId = this.actorRegistry.listAudits().at(-1)?.id;
    const migration = provisional?.kind === 'actor' && provisional.status === 'pending' && provisional.id !== confirmed.id
      ? { fromOwnerId: provisional.id, toOwnerId: confirmed.id }
      : undefined;
    await this.persistActorRegistryChange(
      { operation: 'confirm', candidateId, ...(registryAuditId ? { registryAuditId } : {}), ...(migration ? { migration } : {}) },
      migration,
    );
  }

  async resolveActorCorrection(auditId: string, action: 'confirm' | 'undo'): Promise<void> {
    if (!this.actorRegistry) throw new Error('人物注册表尚未就绪。');
    let restoredData = false;
    if (action === 'undo') {
      const changeSetId = this.actorCorrectionChangeSets.get(auditId);
      if (!this.actorRegistry.undo(auditId)) throw new Error('人物纠正审计不存在或已撤销。');
      if (changeSetId && this.multiActorRepository) {
        await this.multiActorRepository.rollbackChangeSet(changeSetId);
        restoredData = true;
      }
    }
    await this.persistActorRegistryChange({ operation: action, auditId });
    if (restoredData) await this.bindCurrentChat();
  }

  async mergeActors(fromOwnerId: string, intoOwnerId: string): Promise<void> {
    if (!this.actorRegistry) throw new Error('人物注册表尚未就绪。');
    this.actorRegistry.merge(fromOwnerId, intoOwnerId);
    const registryAuditId = this.actorRegistry.listAudits().at(-1)?.id;
    await this.persistActorRegistryChange(
      { operation: 'merge', fromOwnerId, intoOwnerId, ...(registryAuditId ? { registryAuditId } : {}) },
      { fromOwnerId, toOwnerId: intoOwnerId },
    );
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
      const persistedAudits = await this.multiActorRepository.listChangeAudits();
      const selectedAudit = persistedAudits.find(record => String(record.id ?? '') === auditId);
      const affectedTraceIds = new Set((Array.isArray(selectedAudit?.entries) ? selectedAudit.entries : [])
        .filter(entry => entry && typeof entry === 'object'
          && String((entry as Record<string, unknown>).collection ?? '') === 'memory-traces')
        .map(entry => String((entry as Record<string, unknown>).recordId ?? ''))
        .filter(Boolean));
      const invalidatedDreamJobs = (await this.multiActorRepository.listDerived('dream-jobs'))
        .filter(job => String(job.sourceChangeSetId ?? '') === auditId
          || (Array.isArray(job.traceIds) && job.traceIds.some(traceId => affectedTraceIds.has(String(traceId)))))
        .map(job => ({ id: String(job.id ?? ''), ownerId: String(job.ownerId ?? '') }))
        .filter(job => job.id && job.ownerId);
      const affectedFactIds = await this.multiActorRepository.rollbackChangeSet(auditId);
      await this.reloadActorDirectoryState(this.multiActorRepository);
      const rebuilt = await this.rebuildCaptureProjections(this.multiActorRepository);
      for (const job of invalidatedDreamJobs) this.dreamCoordinator.forgetJob(job.id);
      this.clearAutomaticDreamTimers();
      for (const job of await this.multiActorRepository.listDerived('dream-jobs')) {
        if ((job.status === 'queued' || job.status === 'running') && typeof job.id === 'string' && typeof job.ownerId === 'string') this.scheduleAutomaticDream(job.id, this.getChatKey(), job.ownerId);
      }
      this.recallIndex.replace([...rebuilt.facts]);
      this.lastSceneCast = null;
      this.lastSceneState = null;
      this.lastPreparedGeneration = null;
      this.lastIncludedTraceIds = [];
      this.lastActorRecall = null;
      this.actorExposureTracker = new RecallExposureTracker(rebuilt.traces);
      this.lastExposureIds.clear();
      if (affectedFactIds.length > 0) {
        await this.vectorIndex.rebuildFacts(this.getChatKey(), [...new Set(affectedFactIds)]).catch(() => this.scheduleVectorSync(this.getChatKey()));
      }
      this.scheduleVectorSync(this.getChatKey());
      this.scheduleGraph(this.getChatKey());
    } finally {
      this.rollbackActive = false;
    }
    this.emitOverviewChanged();
  }

  async listSceneCasts(): Promise<readonly SceneCast[]> {
    return this.multiActorRepository ? this.multiActorRepository.listSceneCasts() : [];
  }

  async getCurrentSceneState(): Promise<SceneState | null> {
    if (this.lastSceneState && this.lastSceneState.chatKey === this.getChatKey()) return structuredClone(this.lastSceneState);
    return await this.multiActorRepository?.getSceneState() ?? null;
  }

  async listSceneTransitions(): Promise<readonly import('../domain').SceneTransition[]> {
    return this.multiActorRepository ? this.multiActorRepository.listSceneTransitions() : [];
  }

  async correctCurrentSceneState(input: {
    readonly ownerId: string;
    readonly placement: 'present' | 'nearby' | 'exited' | 'viewpoint';
  }): Promise<void> {
    const repository = this.multiActorRepository;
    const reducer = this.sceneStateReducer;
    const registry = this.actorRegistry;
    const context = this.hostContext;
    if (!repository || !reducer || !registry || !context) throw new Error('Memory 尚未绑定当前聊天。');
    const owner = registry.getOwner(input.ownerId);
    if (!owner || owner.kind !== 'actor' || owner.status === 'merged') throw new Error('只能纠正当前人物注册表中的有效角色。');
    const state = await repository.getSceneState();
    if (!state) throw new Error('当前没有可纠正的持续场景。');
    const present = new Set(state.presentOwnerIds);
    const nearby = new Set(state.nearbyOwnerIds);
    const exited = new Set(state.exitedOwnerIds);
    if (input.placement === 'present' || input.placement === 'viewpoint') {
      present.add(owner.id);
      nearby.delete(owner.id);
      exited.delete(owner.id);
    } else if (input.placement === 'nearby') {
      present.delete(owner.id);
      nearby.add(owner.id);
      exited.delete(owner.id);
    } else {
      present.delete(owner.id);
      nearby.delete(owner.id);
      exited.add(owner.id);
    }
    const resolved = await reducer.resolve({
      workspaceId: context.getWorkspaceId(),
      chatKey: state.chatKey,
      currentFloor: state.updatedAtFloor,
      sources: [],
      now: Date.now(),
      correction: {
        presentOwnerIds: [...present],
        nearbyOwnerIds: [...nearby],
        exitedOwnerIds: [...exited],
        locationKeys: [...state.locationKeys],
        viewpointOwnerId: input.placement === 'viewpoint' ? owner.id : state.viewpointOwnerId,
      },
    });
    this.lastSceneState = resolved.state;
    this.emitOverviewChanged();
  }

  async listGenerationCastPlans(): Promise<readonly GenerationCastPlan[]> {
    return this.multiActorRepository ? this.multiActorRepository.listGenerationCastPlans() : [];
  }

  async listCastPlanAudits(): Promise<readonly import('../domain').CastPlanAudit[]> {
    return this.multiActorRepository ? this.multiActorRepository.listCastPlanAudits() : [];
  }

  async listRecallCoverageLogs(): Promise<readonly import('../domain').RecallCoverageLog[]> {
    return this.multiActorRepository ? this.multiActorRepository.listRecallCoverageLogs() : [];
  }

  async listMemoryUsageLogs(): Promise<readonly import('../domain').MemoryUsageLog[]> {
    return this.multiActorRepository ? this.multiActorRepository.listMemoryUsageLogs() : [];
  }

  async getActorRecallDiagnostics(): Promise<ActorRecallResponse | null> {
    return this.lastActorRecall ? structuredClone(this.lastActorRecall) : null;
  }

  async listEpisodes(): Promise<readonly MemoryEpisode[]> {
    return this.multiActorRepository ? this.multiActorRepository.listEpisodes() : [];
  }

  async listObservations(): Promise<readonly MemoryObservation[]> {
    if (!this.multiActorRepository) return [];
    const [episodes, observations] = await Promise.all([
      this.multiActorRepository.listEpisodes(),
      this.multiActorRepository.listObservations(),
    ]);
    const episodeIds = new Set(episodes.map((episode) => episode.id));
    return observations.filter((observation) => episodeIds.has(observation.episodeId));
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
    this.emitOverviewChanged();
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
    const finish = startMemoryPerformanceSpan('application.chat-bind');
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
      try {
        this.actorCorrectionChangeSets.clear();
        // Workspace open with its complete schema is idempotent. Re-open on a chat
        // or group switch so the new v0 collections are ready before Capture.
        await this.multiActorRepository.open();
        if (!isCurrent()) return;
        await this.reloadActorDirectoryState(this.multiActorRepository);
        if (!isCurrent()) return;
        void this.reconcileHistoricalCaptureRepairs(this.multiActorRepository).catch((error) => logger.warn(
          '历史 Capture 修复将在打开初始化页面时继续。',
          readSSHelperFailure(error, { reasonCode: 'MEMORY_CHAT_READ_FAILED', stage: 'memory.repair.reconcile.background' }),
        ));
      } catch (error) {
        if (!isCurrent()) return;
        this.recallIndex.replace([]);
        this.setRuntimeError(error, 'MEMORY_CHAT_BIND_FAILED', 'chat-bind');
        this.emitOverviewChanged();
        return;
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
      if (isCurrent()) this.emitOverviewChanged();
      finish();
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
        finish('error');
        if (!isCurrent()) return;
        this.recallIndex.replace([]);
        this.vectorIndex.stop();
        this.setRuntimeError(error, 'WORKSPACE_DATABASE_UNAVAILABLE', 'chat-bind');
        this.emitOverviewChanged();
        return;
      }
    }
    try {
      const [actorFacts, traces] = this.multiActorRepository && chatKey
        ? await Promise.all([
            this.multiActorRepository.listFacts(),
            this.multiActorRepository.listTraces(),
          ])
        : [[], []];
      if (this.multiActorRepository && chatKey) {
        this.actorExposureTracker = new RecallExposureTracker(traces);
        const dreamRepository = this.multiActorRepository;
        void Promise.all([
          dreamRepository.listDerived('dream-jobs'),
          dreamRepository.listDerived('dream-audits'),
        ]).then(([persistedDreamJobs, persistedDreamAudits]) => {
          if (!isCurrent() || this.multiActorRepository !== dreamRepository) return;
          this.dreamCoordinator.hydrateJobs(persistedDreamJobs.filter(job => typeof job.id === 'string' && typeof job.ownerId === 'string' && typeof job.workspaceId === 'string' && typeof job.chatKey === 'string' && typeof job.status === 'string' && typeof job.phase === 'string' && Array.isArray(job.traceIds)) as unknown as import('../domain').DreamJob[]);
          for (const job of persistedDreamJobs.filter(job => (job.status === 'queued' || job.status === 'running') && typeof job.id === 'string' && typeof job.ownerId === 'string')) this.scheduleAutomaticDream(String(job.id), chatKey, String(job.ownerId));
          this.dreamCoordinator.hydrateAudits(persistedDreamAudits.filter(audit => typeof audit.id === 'string' && typeof audit.jobId === 'string' && typeof audit.ownerId === 'string') as unknown as import('../application/dream').DreamAudit[]);
          traceMemoryStartup('application:dream-state-ready');
          this.emitOverviewChanged();
        }).catch((error) => logger.warn(
          'Dream 状态将在打开页面时重新加载。',
          readSSHelperFailure(error, { reasonCode: 'MEMORY_CHAT_READ_FAILED', stage: 'memory.dream.hydrate.background' }),
        ));
      }
      this.recallIndex.replace(actorFacts);
      traceMemoryStartup('application:recall-index-ready');
      this.boundChatKey = chatKey;
      this.clearRuntimeError();
    } catch (error) {
      finish('error');
      if (!isCurrent()) return;
      this.recallIndex.replace([]);
      // A character/group workspace error is not automatically a global
      // SQLite outage. Keeping the service available lets “重新检查” repair it.
      this.setRuntimeError(error, 'MEMORY_CHAT_BIND_FAILED', 'chat-bind');
      this.emitOverviewChanged();
      return;
    }
    const effective = this.getEffectiveSettings();
    if (!effective.enabled) this.status = 'disabled';
    else if (this.status === 'disabled' || this.status === 'unselected') this.status = 'ready';
    if (effective.enabled && chatKey && usesVectorIndex(effective)) this.scheduleVectorSync(chatKey);
    if (effective.enabled && chatKey) this.scheduleGraph(chatKey);
    this.lastRecall = null;
    this.lastRecallLogId = null;
    if (chatKey) {
      void this.ensureSummaryProgress(chatKey).then(() => this.emitSettingsChanged()).catch(() => undefined);
    }
    if (isCurrent()) this.emitOverviewChanged();
    finish();
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
      extractionMode: settings.extractionMode === 'agent' ? 'agent' : 'single',
      agentConcurrency: settings.agentConcurrency === 1 ? 1 : 2,
      agentToolPolicy: settings.agentToolPolicy === 'read_only' ? 'read_only' : 'off',
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
      structuredRepairEnabled: settings.structuredRepairEnabled === true,
      structuredRepairBeforeFloors: Math.min(10, Math.max(0, Math.trunc(settings.structuredRepairBeforeFloors))),
      structuredRepairAfterFloors: Math.min(10, Math.max(0, Math.trunc(settings.structuredRepairAfterFloors))),
      structuredRepairMaxItems: Math.min(8, Math.max(1, Math.trunc(settings.structuredRepairMaxItems))),
      graphEnabled: settings.graphEnabled === true,
      graphLlmRelationEnabled: settings.graphLlmRelationEnabled === true,
      graphMaxHops: clampGraphMaxHops(settings.graphMaxHops),
      graphMaxEdges: clampGraphMaxEdges(settings.graphMaxEdges),
      castPlanningMode: settings.castPlanningMode === 'fast' || settings.castPlanningMode === 'director' ? settings.castPlanningMode : 'hybrid',
      focusLookbackFloors: clampFocusLookbackFloors(settings.focusLookbackFloors),
      actorScanLookbackFloors: clampActorScanLookbackFloors(settings.actorScanLookbackFloors),
      persistPresenceUntilTransition: settings.persistPresenceUntilTransition !== false,
      plannerCandidateThreshold: clampPlannerCandidateThreshold(settings.plannerCandidateThreshold),
      plannerConfidenceThreshold: clampPlannerConfidenceThreshold(settings.plannerConfidenceThreshold),
      likelyActorRecall: settings.likelyActorRecall === 'identity_only' || settings.likelyActorRecall === 'none' ? settings.likelyActorRecall : 'public_only',
      backgroundActorRecall: settings.backgroundActorRecall === 'public_only' || settings.backgroundActorRecall === 'none' ? settings.backgroundActorRecall : 'identity_only',
      mentionedActorRecall: 'none',
      provisionalActorEnabled: settings.provisionalActorEnabled !== false,
      plannerCanProposeActors: settings.plannerCanProposeActors !== false,
      unplannedActorPolicy: settings.unplannedActorPolicy === 'allow_without_private_memory' || settings.unplannedActorPolicy === 'regenerate_once'
        ? settings.unplannedActorPolicy
        : 'allow_public_only',
      maxPlannerCallsPerTurn: settings.maxPlannerCallsPerTurn === 0 ? 0 : 1,
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
    if (effective.enabled && usesVectorIndex(effective)) this.scheduleVectorSync(this.getChatKey());
    if (effective.enabled) this.scheduleGraph(this.getChatKey());
    this.emitOverviewChanged();
    this.emitOverviewChanged();
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
    if (effective.enabled && usesVectorIndex(effective)) this.scheduleVectorSync(this.getChatKey());
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
      ...(vector?.failure ? { failure: vector.failure } : {}),
      batches: vector?.batches ?? [],
    };
  }

  async rebuildVectorIndex(): Promise<void> {
    await this.vectorIndex.rebuild(this.requireChatKey());
    this.emitOverviewChanged();
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
    this.emitOverviewChanged();
  }

  isCaptureBusy(): boolean {
    return this.capturePromise !== null || this.actorCapturePromise !== null;
  }

  async initialize(selectedKinds?: string[], options?: MemoryInitializationOptions): Promise<void> {
    await this.flushCapture('initialize', undefined, selectedKinds, options);
  }

  async reinitialize(selectedKinds?: string[], options?: MemoryInitializationOptions): Promise<void> {
    await this.cancelCapture();
    await this.clearCurrentChatData();
    await this.initialize(selectedKinds, options);
  }

  /** Read capture progress from the single bound capture store. */
  private async listCaptureJobs(chatKey: string): Promise<MemoryJob[]> {
    const repository = this.multiActorRepository;
    if (!repository) throw new Error('Memory capture store is not bound.');
    return (await repository.listCaptureJobs())
      .filter(record => String(record.chatKey ?? '') === chatKey)
      .filter(record => record.type === 'initialize' || record.type === 'incremental')
      .filter(record => record.checkpoint && typeof record.checkpoint === 'object')
      .map(record => record as unknown as MemoryJob);
  }

  async retry(): Promise<void> {
    this.clearRuntimeError();
    const paused = (await this.listCaptureJobs(this.requireChatKey()))
      .filter((job) => job.status === 'paused' || job.status === 'needs_repair')
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
      const diagnostic = this.errorDiagnostic ?? describeMemoryError(message, 'WORKSPACE_DATABASE_UNAVAILABLE', 'health');
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
      llmAvailable: readMemoryLlmClient() !== null,
      ...(recallRoutes ? { embedding: recallRoutes.embedding, rerank: recallRoutes.rerank } : {}),
      failure: readSSHelperFailure(diagnostic)!,
      errorDiagnostic: diagnostic,
    });
    };
    if (!this.sqliteAvailable) {
      traceMemoryStartup('application:overview-degraded');
      return degraded(this.error, recallRoutes);
    }
    let factCount = 0;
    let jobs: MemoryJob[] = [];
    let actorJobs: Array<Record<string, unknown>> = [];
    if (chatKey) {
      try {
        const [factPage, loadedJobs, loadedActorJobs] = await Promise.all([
          this.multiActorRepository
            ? this.multiActorRepository.page<MemoryFact>('facts', { limit: 1, includeTotal: true }, {
                workspaceId: this.multiActorRepository.boundWorkspaceId,
                chatKey,
              })
            : this.repository.pageFacts(chatKey, { limit: 1, includeTotal: true }),
          this.listCaptureJobs(chatKey),
          this.multiActorRepository
            ? this.multiActorRepository.listDerived('dream-jobs')
            : Promise.resolve([] as Array<Record<string, unknown>>),
        ]);
        factCount = factPage.total ?? factPage.items.length;
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
    const failure = this.errorDiagnostic ? readSSHelperFailure(this.errorDiagnostic) : undefined;
    const currentChat = this.getCurrentChatInfo();
    const bound = Boolean(chatKey && this.boundChatKey === chatKey);
    const overview: MemoryUiOverview = {
      status: this.status === 'error' ? 'error' : !currentChat.available ? 'unselected' : currentChat.effectiveEnabled ? this.status : 'disabled',
      bound,
      ...(chatKey ? { chatKey } : {}),
      ...(currentChat.name ? { chatName: currentChat.name } : {}),
      factCount,
      currentChatSizeBytes,
      currentChatUsageRatio,
      lastOrganizedAt: this.lastOrganizedAt ?? latestCompletedAt,
      pendingJobs: jobs.filter((job) => job.status === 'queued' || job.status === 'running' || job.status === 'paused').length
        + actorJobs.filter(job => ['queued', 'running', 'paused'].includes(String(job.status ?? ''))).length,
      llmAvailable: readMemoryLlmClient() !== null,
      ...(llmRoute.resourceId ? { llmResource: llmRoute.resourceId } : {}),
      ...(llmRoute.model ? { llmModel: llmRoute.model } : {}),
      ...(recallRoutes ? { embedding: recallRoutes.embedding, rerank: recallRoutes.rerank } : {}),
      ...(failure ? { failure } : {}),
      ...(this.errorDiagnostic ? { errorDiagnostic: this.errorDiagnostic } : {}),
    };
    traceMemoryStartup('application:overview-ready');
    return overview;
  }

  async getInitializationSources(options: MemoryInitializationOptions = {}): Promise<MemoryInitializationSourceOption[]> {
    const chatKey = this.getChatKey();
    if (!chatKey) return [];
    const sourceFilterOptions = { includeHiddenMessageFloors: options.includeHiddenMessageFloors !== false };
    const [groups, initialization] = await Promise.all([
      this.collectSources(chatKey).then((sources) => {
        const rawGroups = summarizeSourceGroups(sources);
        const defaultGroups = summarizeSourceGroups(filterSourceBlocks(sources, { includeHiddenMessageFloors: true }));
        const currentGroups = summarizeSourceGroups(filterSourceBlocks(sources, sourceFilterOptions));
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
        ...(job.checkpoint.batchRangeStart === undefined ? {} : { batchRangeStart: job.checkpoint.batchRangeStart }),
        ...(job.checkpoint.batchRangeEnd === undefined ? {} : { batchRangeEnd: job.checkpoint.batchRangeEnd }),
        ...(job.checkpoint.availableBatchCount === undefined ? {} : { availableBatchCount: job.checkpoint.availableBatchCount }),
        selectedSourceKinds: [...(job.checkpoint.selectedSourceGroupIds ?? [])],
        ...(job.checkpoint.includeHiddenMessageFloors === undefined ? {} : {
          includeHiddenMessageFloors: job.checkpoint.includeHiddenMessageFloors,
        }),
        ...(job.failure ? { failure: job.failure } : {}),
      })),
    };
  }

  async getInitializationEstimate(selectedKinds?: string[], options: MemoryInitializationOptions = {}): Promise<MemoryInitializationEstimate> {
    const chatKey = this.getChatKey();
    if (!chatKey) return estimateSummaryInitialization(0, []);
    const includeHiddenMessageFloors = options.includeHiddenMessageFloors !== false;
    const sources = selectSourceGroups(filterSourceBlocks(
      await this.collectSources(chatKey),
      { includeHiddenMessageFloors },
    ), selectedKinds);
    const messageCount = sources.filter((source) => source.kind === 'message').length;
    const strategy = summaryStrategyFromSettings(this.settings);
    const batches = buildSummaryBatches(
      sources,
      strategy,
      { includeHiddenMessageFloors },
    );
    const conversationFloorCount = conversationFloorGroups(sources, { includeHiddenMessageFloors }).length;
    const logicalBatchCount = strategy.batchMode === 'floors' && conversationFloorCount > 0
      ? Math.ceil(conversationFloorCount / strategy.batchFloors)
      : batches.length;
    const requestedStart = Math.trunc(Number(options.batchRange?.start) || 1);
    const rangeStart = batches.length === 0 ? 0 : Math.min(batches.length, Math.max(1, requestedStart));
    const requestedEnd = Math.trunc(Number(options.batchRange?.end) || batches.length);
    const rangeEnd = batches.length === 0 ? 0 : Math.min(batches.length, Math.max(rangeStart, requestedEnd));
    return {
      ...estimateSummaryInitialization(messageCount, batches.slice(Math.max(0, rangeStart - 1), rangeEnd)),
      batchCount: batches.length,
      conversationFloorCount,
      logicalBatchCount,
    };
  }

  async getCaptureProgress(): Promise<MemoryCaptureProgress> {
    if (this.activeCaptureProgress) {
      return {
        ...this.activeCaptureProgress,
        ...(this.activeExtractionSnapshot ?? {}),
        elapsedMs: this.activeCaptureProgress.status === 'running'
          || this.activeCaptureProgress.status === 'repairing'
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
      ...(latest.checkpoint.completedBatchCount === undefined ? {} : { completedBatchCount: latest.checkpoint.completedBatchCount }),
      ...(latest.checkpoint.extractionMode === undefined ? {} : { extractionMode: latest.checkpoint.extractionMode }),
      ...(latest.checkpoint.agentConcurrency === undefined ? {} : { agentConcurrency: latest.checkpoint.agentConcurrency }),
      ...(latest.checkpoint.agentToolPolicy === undefined ? {} : { agentToolPolicy: latest.checkpoint.agentToolPolicy }),
      ...(latest.checkpoint.batchRangeStart === undefined ? {} : { batchRangeStart: latest.checkpoint.batchRangeStart }),
      ...(latest.checkpoint.batchRangeEnd === undefined ? {} : { batchRangeEnd: latest.checkpoint.batchRangeEnd }),
      ...(latest.checkpoint.availableBatchCount === undefined ? {} : { availableBatchCount: latest.checkpoint.availableBatchCount }),
      processedCount: latest.checkpoint.processedCount,
      elapsedMs: Math.max(0, latest.updatedAt - latest.createdAt),
      ...(latest.failure ? { failure: latest.failure } : {}),
      ...(latest.checkpoint.phase ? { phase: latest.checkpoint.phase } : {}),
      ...(latest.outcome ? { outcome: latest.outcome } : {}),
      ...(latest.checkpoint.pendingRepairCount !== undefined
        ? { pendingRepairCount: latest.checkpoint.pendingRepairCount }
        : {}),
      ...(latest.checkpoint.retryableRepairCount !== undefined ? { retryableRepairCount: latest.checkpoint.retryableRepairCount } : {}),
      ...(latest.checkpoint.exhaustedRepairCount !== undefined ? { exhaustedRepairCount: latest.checkpoint.exhaustedRepairCount } : {}),
      ...(latest.checkpoint.quarantinedCount !== undefined ? { quarantinedCount: latest.checkpoint.quarantinedCount } : {}),
      ...(latest.checkpoint.reviewRequiredCount !== undefined ? { reviewRequiredCount: latest.checkpoint.reviewRequiredCount } : {}),
      ...(latest.checkpoint.unresolvedRejectionCount !== undefined ? { unresolvedRejectionCount: latest.checkpoint.unresolvedRejectionCount } : {}),
      ...(latest.checkpoint.repairedCount !== undefined ? { repairedCount: latest.checkpoint.repairedCount } : {}),
      ...(latest.checkpoint.degradedCount !== undefined
        ? { degradedCount: latest.checkpoint.degradedCount }
        : {}),
      ...(latest.checkpoint.ignoredCount !== undefined ? { ignoredCount: latest.checkpoint.ignoredCount } : {}),
      ...usageProgress(latest.checkpoint),
      ...(latest.outcome === 'partial' ? { rejectedCount: Number((latest as MemoryJob & { rejectionCount?: number }).rejectionCount ?? 0) } : {}),
    };
  }

  private projectAuditRecords(
    changeAudits: readonly ChangeAudit[],
    repairQueue: readonly CaptureRepairQueueRecord[],
    chatKey: string,
  ): MemoryAuditRecord[] {
    const cleanString = (value: unknown): string | undefined => {
      const text = typeof value === 'string' ? value.trim() : '';
      return text || undefined;
    };
    const cleanStrings = (value: unknown): string[] => Array.isArray(value)
      ? [...new Set(value.map(cleanString).filter((item): item is string => item !== undefined))]
      : [];
    const safeCount = (value: unknown): number => {
      const count = Number(value);
      return Number.isFinite(count) && count >= 0 ? count : 0;
    };
    const repairKey = (jobId: string, batchIndex: number): string => `${jobId}\0${batchIndex}`;
    const queueByAudit = new Map<string, CaptureRepairQueueRecord[]>();
    for (const item of repairQueue) {
      const key = repairKey(item.jobId, Number.isInteger(item.batchIndex) ? item.batchIndex : 0);
      const bucket = queueByAudit.get(key) ?? [];
      bucket.push(item);
      queueByAudit.set(key, bucket);
    }
    const safeFailure = (
      source: SSHelperFailureContext | undefined,
      fallback: SSHelperFailureContext,
    ): SSHelperFailureContext => {
      const value: SSHelperFailureContext = {
        reasonCode: source?.reasonCode ?? fallback.reasonCode,
        stage: source?.stage ?? fallback.stage,
        requestId: cleanString(source?.requestId) ?? cleanString(fallback.requestId),
        attemptId: cleanString(source?.attemptId) ?? cleanString(fallback.attemptId),
        batchIndex: Number.isInteger(source?.batchIndex) ? source?.batchIndex : fallback.batchIndex,
        collection: cleanString(source?.collection) ?? cleanString(fallback.collection),
        path: cleanString(source?.path) ?? cleanString(fallback.path),
        keyword: cleanString(source?.keyword) ?? cleanString(fallback.keyword),
        expected: cleanString(source?.expected) ?? cleanString(fallback.expected),
        resourceId: cleanString(source?.resourceId) ?? cleanString(fallback.resourceId),
        model: cleanString(source?.model) ?? cleanString(fallback.model),
      };
      return {
        reasonCode: value.reasonCode,
        stage: value.stage,
        ...(cleanString(value.requestId) ? { requestId: cleanString(value.requestId) } : {}),
        ...(cleanString(value.attemptId) ? { attemptId: cleanString(value.attemptId) } : {}),
        ...(Number.isInteger(value.batchIndex) ? { batchIndex: value.batchIndex } : {}),
        ...(cleanString(value.collection) ? { collection: cleanString(value.collection) } : {}),
        ...(cleanString(value.path) ? { path: cleanString(value.path) } : {}),
        ...(cleanString(value.keyword) ? { keyword: cleanString(value.keyword) } : {}),
        ...(cleanString(value.expected) ? { expected: cleanString(value.expected) } : {}),
        ...(cleanString(value.resourceId) ? { resourceId: cleanString(value.resourceId) } : {}),
        ...(cleanString(value.model) ? { model: cleanString(value.model) } : {}),
      };
    };
    const captureAudits = changeAudits
      .filter(record => record.kind === 'capture-change-set-v0' && record.chatKey === chatKey)
      .map((record): MemoryAuditRecord => {
        const metadata = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
          ? record.metadata as Record<string, unknown>
          : {};
        const acceptedCounts = metadata.accepted && typeof metadata.accepted === 'object' && !Array.isArray(metadata.accepted)
          ? metadata.accepted as Record<string, unknown>
          : {};
        const rejections = Array.isArray(metadata.rejections)
          ? metadata.rejections.filter((item): item is AutomaticIngestRejection => Boolean(item && typeof item === 'object'))
          : [];
        const jobId = cleanString(metadata.captureJobId) ?? record.id;
        const batchIndex = Number.isInteger(metadata.batchIndex) ? Number(metadata.batchIndex) : 0;
        const scopedRepairQueue = queueByAudit.get(repairKey(jobId, batchIndex)) ?? [];
        const queueByRejectionId = new Map<string, CaptureRepairQueueRecord>();
        for (const item of scopedRepairQueue) {
          for (const rejectionId of item.rejectionIds?.length ? item.rejectionIds : item.rejectionId ? [item.rejectionId] : []) {
            if (rejectionId.trim()) queueByRejectionId.set(rejectionId, item);
          }
        }
        const recordRequestId = cleanString(metadata.requestId);
        const recordResourceId = cleanString(metadata.resourceId);
        const recordModel = cleanString(metadata.model);
        const projectIssues = (
          rejection: AutomaticIngestRejection | undefined,
          repair: CaptureRepairQueueRecord | undefined,
          fallbackIndex: number,
        ): MemoryAuditIssue[] => {
          const rejectionId = cleanString(rejection?.id);
          const diagnosticId = rejectionId
            ?? cleanString(repair?.rejectionId)
            ?? cleanString(repair?.rejectionIds?.[0])
            ?? cleanString(repair?.id)
            ?? `${record.id}:item:${fallbackIndex}`;
          const status = rejection?.status === 'ignored' || repair?.status === 'ignored'
            ? 'ignored'
            : rejection?.status === 'repaired' || repair?.status === 'resolved'
              ? 'repaired'
              : rejection?.status === 'repairing' || repair?.status === 'running'
                ? 'running'
                : repair?.status === 'queued' || repair?.status === 'unresolved'
                  ? repair.status
                : 'unresolved';
          const collection = repair?.collection ?? rejection?.recordType ?? 'record';
          const projectedBatchIndex = Number.isInteger(repair?.batchIndex)
            ? repair!.batchIndex
            : Number.isInteger(rejection?.batchIndex) ? rejection!.batchIndex! : batchIndex;
          const requestId = cleanString(repair?.originalRequestId) ?? cleanString(rejection?.requestId) ?? recordRequestId;
          const resourceId = cleanString(repair?.originalResourceId) ?? cleanString(rejection?.resourceId) ?? recordResourceId;
          const model = cleanString(repair?.originalModel) ?? cleanString(rejection?.model) ?? recordModel;
          const rawIssues = rejection?.issues?.length
            ? rejection.issues
            : repair?.issues?.length ? repair.issues : [undefined];
          return rawIssues.map((issue, issueIndex): MemoryAuditIssue => {
            const path = cleanString(issue?.path) ?? cleanString(rejection?.fieldPath) ?? '$';
            const keyword = cleanString(issue?.keyword);
            const expected = cleanString(issue?.expected);
            const fallbackFailure: SSHelperFailureContext = {
              reasonCode: rejection?.code === 'schema_validation_failed'
                ? 'SCHEMA_VALIDATION_FAILED'
                : rejection && isAiRepairableProposalCode(rejection.code)
                  ? 'ENTITY_REF_UNSUPPORTED'
                  : 'CAPTURE_ITEM_INVALID',
              stage: 'memory.capture.item',
              ...(requestId ? { requestId } : {}),
              batchIndex: projectedBatchIndex,
              collection,
              path,
              ...(keyword ? { keyword } : {}),
              ...(expected ? { expected } : {}),
              ...(resourceId ? { resourceId } : {}),
              ...(model ? { model } : {}),
            };
            const failure = safeFailure(repair?.failure, fallbackFailure);
            return {
              id: rawIssues.length === 1 ? diagnosticId : `${diagnosticId}:issue:${issueIndex}`,
              ...(rejectionId ? { rejectionId } : {}),
              collection,
              itemIndex: Number.isInteger(repair?.itemIndex) ? repair!.itemIndex : Number(rejection?.index ?? fallbackIndex),
              batchIndex: projectedBatchIndex,
              path,
              ...(keyword ? { keyword } : {}),
              ...(expected ? { expected } : {}),
              sourceRefs: cleanStrings([
                ...(repair?.sourceRefs ?? []),
                ...(repair?.fallbackSourceRefs ?? []),
                ...(rejection?.sourceRefs ?? []),
              ]),
              status,
              canIgnore: status === 'unresolved' && rejectionId !== undefined && issueIndex === 0,
              attemptCount: Math.max(0, Number(repair?.attemptCount ?? rejection?.repairAttempts ?? 0)),
              ...(Number.isInteger(repair?.maxAttempts) ? { maxAttempts: repair!.maxAttempts } : {}),
              waitingForEvidenceChange: repair?.waitingForEvidenceChange === true || rejection?.waitingForEvidenceChange === true,
              ...(cleanString(repair?.resolutionMode) ? { resolutionMode: cleanString(repair?.resolutionMode) } : {}),
              failure: {
                ...failure,
                batchIndex: projectedBatchIndex,
                collection,
                path,
                ...(keyword ? { keyword } : {}),
                ...(expected ? { expected } : {}),
              },
            };
          });
        };
        const linkedQueueIds = new Set<string>();
        const issues = rejections.flatMap((rejection, index) => {
          const repair = rejection.id ? queueByRejectionId.get(rejection.id) : undefined;
          if (repair) linkedQueueIds.add(repair.id);
          return projectIssues(rejection, repair, index);
        });
        for (const repair of scopedRepairQueue.filter(item => !linkedQueueIds.has(item.id))) {
          issues.push(...projectIssues(undefined, repair, issues.length));
        }
        const countItems = (matches: (issue: MemoryAuditIssue) => boolean): number => new Set(
          issues.filter(matches).map(issue => issue.rejectionId ?? issue.id.replace(/:issue:\d+$/u, '')),
        ).size;
        const unresolvedCount = countItems(issue => issue.status === 'queued' || issue.status === 'running' || issue.status === 'unresolved');
        const repairedCount = countItems(issue => issue.status === 'repaired');
        const ignoredCount = countItems(issue => issue.status === 'ignored');
        const acceptedCount = Object.values(acceptedCounts).reduce<number>((total, value) => {
          const count = Number(value);
          return total + (Number.isFinite(count) && count > 0 ? count : 0);
        }, 0);
        const outcome = metadata.outcome === 'partial' ? 'partial' : 'complete';
        return {
          kind: 'capture',
          id: record.id,
          jobId,
          createdAt: record.createdAt,
          ...(record.rolledBackAt === undefined ? {} : { rolledBackAt: record.rolledBackAt }),
          status: record.rolledBackAt ? 'rolled_back' : outcome === 'partial' || unresolvedCount > 0 ? 'partial' : 'completed',
          outcome,
          batchIndex,
          sourceRefs: cleanStrings(metadata.sourceRefs),
          acceptedCount,
          rejectedCount: rejections.length,
          unresolvedCount,
          repairedCount,
          ignoredCount,
          issues,
          ...(recordRequestId ? { requestId: recordRequestId } : {}),
          ...(recordResourceId ? { resourceId: recordResourceId } : {}),
          ...(recordModel ? { model: recordModel } : {}),
          ...(Number.isFinite(Number(metadata.latencyMs)) ? { latencyMs: Math.max(0, Number(metadata.latencyMs)) } : {}),
          ...(typeof metadata.fallbackUsed === 'boolean' ? { fallbackUsed: metadata.fallbackUsed } : {}),
        };
      });
    const agentAudits = changeAudits
      .filter(record => record.kind === 'capture-change-set-v0' && record.chatKey === chatKey)
      .flatMap((record): MemoryAuditRecord[] => {
        const metadata = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
          ? record.metadata as Record<string, unknown>
          : {};
        const pipeline = metadata.pipeline && typeof metadata.pipeline === 'object' && !Array.isArray(metadata.pipeline)
          ? metadata.pipeline as Record<string, unknown>
          : undefined;
        if (!pipeline || pipeline.mode !== 'agent') return [];
        const stages = (Array.isArray(pipeline.stages) ? pipeline.stages : []).flatMap((value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
          const stage = value as Record<string, unknown>;
          const name = cleanString(stage.stage);
          const status: 'completed' | 'failed' | 'cancelled' | undefined = stage.status === 'completed' || stage.status === 'failed' || stage.status === 'cancelled'
            ? stage.status
            : undefined;
          if (!name || !status) return [];
          const requestId = cleanString(stage.requestId);
          const resourceId = cleanString(stage.resourceId);
          const model = cleanString(stage.model);
          const reasonCode = cleanString(stage.reasonCode);
          return [{
            stage: name,
            status,
            latencyMs: safeCount(stage.latencyMs),
            toolRounds: safeCount(stage.toolRounds),
            toolCalls: safeCount(stage.toolCalls),
            ...(requestId ? { requestId } : {}),
            ...(resourceId ? { resourceId } : {}),
            ...(model ? { model } : {}),
            ...(reasonCode ? { reasonCode } : {}),
          }];
        });
        const completedStageCount = stages.filter(stage => stage.status === 'completed').length;
        const failedStageCount = stages.filter(stage => stage.status === 'failed').length;
        const cancelledStageCount = stages.filter(stage => stage.status === 'cancelled').length;
        const unresolvedCount = failedStageCount + cancelledStageCount;
        const pipelineRunId = cleanString(pipeline.pipelineRunId) ?? record.id;
        const totalUsage = pipeline.totalUsage && typeof pipeline.totalUsage === 'object' && !Array.isArray(pipeline.totalUsage)
          ? pipeline.totalUsage as Record<string, unknown>
          : {};
        const rawTotalTokens = Number(totalUsage.totalTokens);
        const totalTokens = Number.isFinite(rawTotalTokens) && rawTotalTokens >= 0 ? rawTotalTokens : null;
        const firstRequestId = stages.find(stage => stage.requestId)?.requestId;
        const firstResourceId = stages.find(stage => stage.resourceId)?.resourceId;
        const firstModel = stages.find(stage => stage.model)?.model;
        const wallClockLatencyMs = safeCount(pipeline.wallClockLatencyMs);
        const toolCallCount = Array.isArray(pipeline.toolCalls)
          ? pipeline.toolCalls.length
          : stages.reduce((total, stage) => total + stage.toolCalls, 0);
        return [{
          kind: 'agent_pipeline',
          id: record.id,
          jobId: pipelineRunId,
          createdAt: record.createdAt,
          status: unresolvedCount > 0 ? 'partial' : 'completed',
          outcome: unresolvedCount > 0 ? 'partial' : 'complete',
          batchIndex: 0,
          sourceRefs: [],
          acceptedCount: 0,
          rejectedCount: 0,
          unresolvedCount,
          repairedCount: 0,
          ignoredCount: 0,
          issues: [],
          ...(firstRequestId ? { requestId: firstRequestId } : {}),
          ...(firstResourceId ? { resourceId: firstResourceId } : {}),
          ...(firstModel ? { model: firstModel } : {}),
          latencyMs: wallClockLatencyMs,
          pipeline: {
            mode: 'agent',
            toolPolicy: pipeline.toolPolicy === 'read_only' ? 'read_only' : 'off',
            stageCount: stages.length,
            completedStageCount,
            failedStageCount,
            cancelledStageCount,
            toolCallCount,
            wallClockLatencyMs,
            totalTokens,
            stages,
          },
        }];
      });
    return [...captureAudits, ...agentAudits].sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
  }

  private async listAuditRepairQueueForAudits(
    changeAudits: readonly ChangeAudit[],
    signal?: AbortSignal,
  ): Promise<CaptureRepairQueueRecord[]> {
    const repository = this.multiActorRepository;
    if (!repository || changeAudits.length === 0) return [];
    const chatKey = this.requireChatKey();
    const pairKeys = new Set<string>();
    const jobIds = new Set<string>();
    for (const record of changeAudits) {
      const metadata = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
        ? record.metadata as Record<string, unknown>
        : {};
      const jobId = typeof metadata.captureJobId === 'string' && metadata.captureJobId.trim()
        ? metadata.captureJobId.trim()
        : record.id;
      const batchIndex = Number.isInteger(metadata.batchIndex) ? Number(metadata.batchIndex) : 0;
      jobIds.add(jobId);
      pairKeys.add(`${jobId}\0${batchIndex}`);
    }
    const items: CaptureRepairQueueRecord[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      if (signal?.aborted) throw signal.reason;
      const page = await repository.page<CaptureRepairQueueRecord>('capture-repair-queue', {
        limit: 500,
        signal,
        ...(cursor === undefined ? {} : { cursor }),
        where: [{ field: 'jobId', op: 'in', value: [...jobIds] }],
      }, {
        workspaceId: repository.boundWorkspaceId,
        chatKey,
      });
      items.push(...page.items.filter(item => pairKeys.has(`${item.jobId}\0${Number.isInteger(item.batchIndex) ? item.batchIndex : 0}`)));
      if (page.nextCursor === null) break;
      if (seen.has(page.nextCursor)) throw createSSHelperError('INTERNAL_ERROR', { stage: 'memory.ui.audit-repair-pagination' });
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  }

  async listAuditRecords(): Promise<MemoryAuditRecord[]> {
    const chatKey = this.requireChatKey();
    const repository = this.multiActorRepository;
    if (!repository) return [];
    const [changeAudits, repairQueue] = await Promise.all([
      repository.listChangeAudits(),
      repository.listCaptureRepairQueue(),
    ]);
    return this.projectAuditRecords(changeAudits, repairQueue, chatKey);
  }

  async listAuditRecordsPage(request: MemoryPageRequest): Promise<MemoryPage<MemoryAuditRecord>> {
    const chatKey = this.requireChatKey();
    const repository = this.multiActorRepository;
    if (!repository) return { items: [], nextCursor: null, total: 0 };
    const limit = Math.max(1, Math.min(500, Math.trunc(request.limit)));
    const query = request.query?.trim().toLocaleLowerCase() ?? '';
    const requestedStatus = request.filter?.auditStatus;
    const status = requestedStatus === 'completed' || requestedStatus === 'partial' || requestedStatus === 'rolled_back'
      ? requestedStatus
      : undefined;
    const issuesOnly = request.filter?.auditIssuesOnly === true;
    const scope = { workspaceId: repository.boundWorkspaceId, chatKey };
    const loadRawPage = (cursor: string | undefined, pageLimit: number): Promise<MemoryPage<ChangeAudit>> => repository.page<ChangeAudit>('change-audits', {
      limit: pageLimit,
      signal: request.signal,
      ...(cursor === undefined ? {} : { cursor }),
      orderBy: { field: 'createdAt', direction: 'desc' },
    }, scope);
    const projectPage = async (page: MemoryPage<ChangeAudit>): Promise<MemoryAuditRecord[]> => {
      const scopedAudits = page.items.filter(record => record.chatKey === chatKey);
      const captureAudits = scopedAudits.filter(record => record.kind === 'capture-change-set-v0');
      return this.projectAuditRecords(
        scopedAudits,
        await this.listAuditRepairQueueForAudits(captureAudits, request.signal),
        chatKey,
      );
    };
    const matches = (record: MemoryAuditRecord): boolean => {
      if (status && record.status !== status) return false;
      if (issuesOnly && record.unresolvedCount === 0) return false;
      if (!query) return true;
      return [
        record.id,
        record.jobId,
        record.requestId,
        record.resourceId,
        record.model,
        record.kind,
        record.pipeline?.mode,
        record.pipeline?.toolPolicy,
        ...record.sourceRefs,
        ...record.issues.flatMap(issue => [issue.collection, issue.path, issue.failure.reasonCode, issue.failure.requestId]),
        ...(record.pipeline?.stages.flatMap(stage => [stage.stage, stage.status, stage.reasonCode, stage.requestId, stage.resourceId, stage.model]) ?? []),
      ].some(value => String(value ?? '').toLocaleLowerCase().includes(query));
    };
    const items: MemoryAuditRecord[] = [];
    let cursor = request.cursor;
    let nextCursor: string | null = cursor ?? null;
    const seen = new Set<string>();
    do {
      if (request.signal?.aborted) throw request.signal.reason;
      const page = await loadRawPage(cursor, Math.max(1, limit - items.length));
      items.push(...(await projectPage(page)).filter(matches));
      nextCursor = page.nextCursor;
      if (items.length >= limit || nextCursor === null) break;
      if (seen.has(nextCursor)) throw createSSHelperError('INTERNAL_ERROR', { stage: 'memory.ui.audit-page.search-pagination' });
      seen.add(nextCursor);
      cursor = nextCursor;
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    } while (cursor);
    return { items, nextCursor };
  }

  private async readCaptureRejections(
    auditId: string,
  ): Promise<{ audit: import('../infrastructure').ChangeAudit; rejections: AutomaticIngestRejection[] }> {
    const repository = this.multiActorRepository;
    if (!repository) throw new Error('当前存储不支持 Capture 失败项处理。');
    const audit = await repository.getChangeAudit(auditId);
    if (!audit || audit.kind !== 'capture-change-set-v0' || audit.chatKey !== this.requireChatKey()) throw new Error('找不到当前聊天的 Capture 审计记录。');
    const metadata = audit.metadata && typeof audit.metadata === 'object' && !Array.isArray(audit.metadata)
      ? audit.metadata as Record<string, unknown>
      : {};
    const rejections = Array.isArray(metadata.rejections)
      ? metadata.rejections.filter((item): item is AutomaticIngestRejection => Boolean(item && typeof item === 'object'))
      : [];
    return { audit, rejections: structuredClone(rejections) };
  }

  async ignoreCaptureRejections(auditId: string, rejectionIds: readonly string[]): Promise<void> {
    const repository = this.multiActorRepository;
    if (!repository) throw new Error('当前存储不支持 Capture 失败项处理。');
    const selected = new Set(rejectionIds.map(String));
    const { rejections } = await this.readCaptureRejections(auditId);
    let changed = false;
    const updated = rejections.map((rejection) => {
      if (!rejection.id || !selected.has(rejection.id) || (rejection.status ?? 'unresolved') !== 'unresolved') return rejection;
      changed = true;
      return { ...rejection, status: 'ignored' as const, ignoredAt: Date.now() };
    });
    if (!changed) throw new Error('没有可忽略的待处理项。');
    await repository.updateCaptureAuditRejections(auditId, updated);
    this.emitOverviewChanged();
  }

  async getMainChatUsage(): Promise<MainChatUsage[]> {
    return this.repository.listMainChatUsage(this.requireChatKey());
  }

  private isMainChatUsageComplete(usage: MainChatUsage): boolean {
    return [
      usage.promptTokens,
      usage.completionTokens,
      usage.cacheReadTokens,
      usage.cacheWriteTokens,
      usage.totalTokens,
    ].every(value => value !== null);
  }

  async getMainChatUsagePage(request: MemoryPageRequest): Promise<MemoryPage<MainChatUsage>> {
    const chatKey = this.requireChatKey();
    const limit = Math.max(1, Math.min(500, Math.trunc(request.limit)));
    const query = request.query?.trim().toLocaleLowerCase() ?? '';
    const requestedModel = request.filter?.usageModel;
    const model = typeof requestedModel === 'string' && requestedModel.trim() ? requestedModel.trim() : undefined;
    const requestedCompleteness = request.filter?.usageCompleteness;
    const completeness = requestedCompleteness === 'complete' || requestedCompleteness === 'missing'
      ? requestedCompleteness
      : undefined;
    const computedFilter = Boolean(query || model || completeness);
    const loadRawPage = (cursor: string | undefined, pageLimit: number, includeTotal: boolean): Promise<MemoryPage<MainChatUsage>> => this.repository.pageCollection<MainChatUsage>('usage', {
      limit: pageLimit,
      signal: request.signal,
      ...(cursor === undefined ? {} : { cursor }),
      orderBy: { field: 'capturedAt', direction: 'desc' },
      includeTotal,
    }, { chatKey });
    if (!computedFilter) return loadRawPage(request.cursor, limit, request.includeTotal === true);

    const matches = (usage: MainChatUsage): boolean => {
      if (model && usage.model !== model) return false;
      const complete = this.isMainChatUsageComplete(usage);
      if (completeness === 'complete' && !complete) return false;
      if (completeness === 'missing' && complete) return false;
      if (!query) return true;
      return [usage.id, usage.messageId, usage.provider, usage.model]
        .some(value => String(value ?? '').toLocaleLowerCase().includes(query));
    };
    const items: MainChatUsage[] = [];
    let cursor = request.cursor;
    let nextCursor: string | null = cursor ?? null;
    const seen = new Set<string>();
    do {
      if (request.signal?.aborted) throw request.signal.reason;
      const page = await loadRawPage(cursor, Math.max(1, limit - items.length), false);
      items.push(...page.items.filter(matches));
      nextCursor = page.nextCursor;
      if (items.length >= limit || nextCursor === null) break;
      if (seen.has(nextCursor)) throw createSSHelperError('INTERNAL_ERROR', { stage: 'memory.ui.usage-page.search-pagination' });
      seen.add(nextCursor);
      cursor = nextCursor;
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    } while (cursor);
    return { items, nextCursor };
  }

  async getAuditSummary(): Promise<MemoryAuditSummary> {
    const summary: MemoryAuditSummary = {
      auditTotal: 0,
      pendingIssueCount: 0,
      rolledBackCount: 0,
      usageTotal: 0,
      promptTokens: { value: null, known: 0 },
      completionTokens: { value: null, known: 0 },
      totalTokens: { value: null, known: 0 },
      incompleteUsageCount: 0,
      models: [],
    };
    const models = new Set<string>();
    const addKnown = (target: { value: number | null; known: number }, value: number | null): void => {
      if (value === null) return;
      target.value = (target.value ?? 0) + value;
      target.known += 1;
    };
    let auditCursor: string | undefined;
    const seenAuditCursors = new Set<string>();
    do {
      const page = await this.listAuditRecordsPage({
        limit: 200,
        ...(auditCursor === undefined ? {} : { cursor: auditCursor }),
      });
      summary.auditTotal += page.items.length;
      for (const record of page.items) {
        summary.pendingIssueCount += record.unresolvedCount;
        if (record.status === 'rolled_back') summary.rolledBackCount += 1;
      }
      if (page.nextCursor === null) break;
      if (seenAuditCursors.has(page.nextCursor)) throw createSSHelperError('INTERNAL_ERROR', { stage: 'memory.ui.audit-summary-pagination' });
      seenAuditCursors.add(page.nextCursor);
      auditCursor = page.nextCursor;
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    } while (auditCursor);

    let usageCursor: string | undefined;
    const seenUsageCursors = new Set<string>();
    do {
      const page = await this.getMainChatUsagePage({
        limit: 500,
        ...(usageCursor === undefined ? {} : { cursor: usageCursor }),
      });
      summary.usageTotal += page.items.length;
      for (const usage of page.items) {
        addKnown(summary.promptTokens, usage.promptTokens);
        addKnown(summary.completionTokens, usage.completionTokens);
        addKnown(summary.totalTokens, usage.totalTokens);
        if (!this.isMainChatUsageComplete(usage)) summary.incompleteUsageCount += 1;
        if (usage.model?.trim()) models.add(usage.model.trim());
      }
      if (page.nextCursor === null) break;
      if (seenUsageCursors.has(page.nextCursor)) throw createSSHelperError('INTERNAL_ERROR', { stage: 'memory.ui.usage-summary-pagination' });
      seenUsageCursors.add(page.nextCursor);
      usageCursor = page.nextCursor;
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    } while (usageCursor);
    summary.models = [...models].sort((left, right) => left.localeCompare(right, 'zh-CN'));
    return summary;
  }

  async getGenerationRecallDetail(detailId: string): Promise<GenerationRecallDetail | undefined> {
    const workspaceId = this.hostContext?.getWorkspaceId().trim() ?? '';
    const chatKey = this.requireChatKey();
    detailId = detailId.trim();
    if (!workspaceId || !detailId) {
      throw createSSHelperError('INVALID_PAYLOAD', {
        stage: 'memory.generation-recall.detail-scope',
      });
    }
    return this.repository.getGenerationRecallDetail(workspaceId, chatKey, detailId);
  }

  captureGenerationCompletionScope(): GenerationCompletionScope {
    const workspaceId = this.hostContext?.getWorkspaceId().trim() ?? '';
    const chatKey = this.getChatKey().trim();
    if (!workspaceId || !chatKey) {
      throw createSSHelperError('MEMORY_CAPTURE_NOT_BOUND', {
        stage: 'memory.generation-completion.scope',
      });
    }
    const preparedGeneration = this.lastPreparedGeneration === null
      ? null
      : structuredClone(this.lastPreparedGeneration);
    return Object.freeze({
      workspaceId,
      chatKey,
      preparedGeneration,
      recallLogId: this.lastRecallLogId,
    });
  }

  createGenerationCompletionCommit(
    scope: GenerationCompletionScope,
    usage: MainChatUsage,
    message?: ChatMessageSnapshot,
  ): GenerationCompletionCommit {
    if (usage.chatKey !== scope.chatKey) {
      throw createSSHelperError('INVALID_PAYLOAD', {
        stage: 'memory.generation-completion.create',
      });
    }
    return Object.freeze({
      ...scope,
      usage: structuredClone(usage),
      ...(message === undefined ? {} : { message: structuredClone(message) }),
    });
  }

  isGenerationCompletionScopeCurrent(scope: GenerationCompletionScope): boolean {
    return scope.workspaceId === (this.hostContext?.getWorkspaceId() ?? '')
      && scope.chatKey === this.getChatKey();
  }

  async recordMainChatUsage(usage: MainChatUsage): Promise<void> {
    if (usage.chatKey !== this.requireChatKey()) return;
    await this.repository.addMainChatUsage({
      ...usage,
      ...(this.lastRecallLogId ? { recallLogId: this.lastRecallLogId } : {}),
    });
  }

  async recordCompletedGeneration(commit: GenerationCompletionCommit): Promise<GenerationRecallDetail | undefined> {
    const { workspaceId, chatKey, preparedGeneration: prepared, message } = commit;
    const usage: MainChatUsage = {
      ...commit.usage,
      ...(commit.recallLogId ? { recallLogId: commit.recallLogId } : {}),
    };
    if (!prepared
      || message?.role !== 'assistant'
      || prepared.castPlan.chatKey !== chatKey
      || prepared.castPlan.workspaceId !== workspaceId) {
      await this.repository.addMainChatUsageForScope({ workspaceId, chatKey }, usage);
      return undefined;
    }
    const baseDetail = createGenerationRecallDetail(prepared, message, usage.capturedAt);
    const snapshot = await this.repository.prepareGenerationPromptSnapshot(
      { workspaceId, chatKey },
      baseDetail.id,
      prepared.prompt.prompt,
      commit.finalPromptSnapshot,
      usage.capturedAt,
    );
    const detail: GenerationRecallDetail = { ...baseDetail, promptSnapshot: snapshot.metadata };
    await this.repository.commitMainChatGenerationForScope({ workspaceId, chatKey }, {
      ...usage,
      id: `main-usage:${detail.id}`,
      messageId: detail.messageId,
      generationRecallDetailId: detail.id,
    }, detail, snapshot);
    this.emitGenerationRecallDetailsChanged('updated');
    this.emitOverviewChanged();
    return detail;
  }

  async listGenerationRecallDetails(chatKey = this.requireChatKey()): Promise<GenerationRecallDetail[]> {
    const currentChatKey = this.requireChatKey();
    if (chatKey.trim() !== currentChatKey) return [];
    return this.repository.listGenerationRecallDetails(currentChatKey);
  }

  async findGenerationRecallDetails(
    workspaceId: string,
    chatKey: string,
    targets: readonly GenerationRecallLookupTarget[],
    signal?: AbortSignal,
  ): Promise<GenerationRecallDetail[]> {
    return this.repository.findGenerationRecallDetailsForTargets(
      workspaceId,
      chatKey,
      targets,
      signal,
    );
  }

  async loadGenerationPromptSnapshot(
    workspaceId: string,
    chatKey: string,
    snapshotId: string,
    signal?: AbortSignal,
  ) {
    return this.repository.loadGenerationPromptSnapshot(workspaceId, chatKey, snapshotId, signal);
  }

  async applyGenerationRecallMessageDeletion(messageIndex: number, deletedCount: number): Promise<number> {
    const changed = await this.repository.applyGenerationRecallMessageDeletion(this.requireChatKey(), messageIndex, deletedCount);
    if (changed > 0) { this.emitGenerationRecallDetailsChanged('updated'); this.emitOverviewChanged(); }
    return changed;
  }

  async applyGenerationRecallMessageEdit(message: import('@ss-helper/sdk').ChatMessageSnapshot): Promise<number> {
    const changed = await this.repository.applyGenerationRecallMessageEdit(this.requireChatKey(), message);
    if (changed > 0) { this.emitGenerationRecallDetailsChanged('updated'); this.emitOverviewChanged(); }
    return changed;
  }

  async applyGenerationRecallSwipeDeletion(messageIndex: number, deletedVariantId: string): Promise<number> {
    const changed = await this.repository.applyGenerationRecallSwipeDeletion(this.requireChatKey(), messageIndex, deletedVariantId);
    if (changed > 0) { this.emitGenerationRecallDetailsChanged('updated'); this.emitOverviewChanged(); }
    return changed;
  }

  async cancelCapture(): Promise<void> {
    if (!this.capturePromise && !this.actorCapturePromise) return;
    if (!this.capturePromise && this.actorCapturePromise) {
      await this.actorCapturePromise.catch(() => undefined);
      this.emitOverviewChanged();
      return;
    }
    this.cancelRequested = true;
    this.captureAbortController?.abort();
    this.captureVersion += 1;
    const capturePromise = this.capturePromise;
    if (capturePromise) await capturePromise.catch(() => undefined);
    await this.actorCapturePromise?.catch(() => undefined);
    this.emitOverviewChanged();
  }

  /** LLMHub 延迟挂载时重试任务注册，并继续未完成的向量回填。 */
  refreshLlmRegistration(): void {
    const settings = this.getEffectiveSettings();
    if (this.sqliteAvailable && settings.enabled && usesVectorIndex(settings)) {
      this.scheduleVectorSync(this.getChatKey());
    }
  }

  async listFacts(query = ''): Promise<MemoryUiFact[]> {
    traceMemoryStartup('application:list-facts-begin');
    const chatKey = this.requireChatKey();
    const [facts, audits, actorAudits] = await Promise.all([
      this.multiActorRepository
        ? (query.trim() ? this.facts.search(query) : this.facts.list({}))
        : (query.trim() ? this.repository.searchFacts(chatKey, query) : this.repository.listFacts(chatKey)),
      Promise.resolve([] as import('../domain').MemoryJobBatchAudit[]),
      this.multiActorRepository
        ? this.multiActorRepository.listChangeAudits().then(records => records.filter(record => String(record.kind ?? '') === 'capture-change-set-v0'))
        : Promise.resolve([] as import('../infrastructure').ChangeAudit[]),
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
            const metadata = audit.metadata && typeof audit.metadata === 'object' && !Array.isArray(audit.metadata)
              ? audit.metadata as Record<string, unknown>
              : {};
            const sourceRefs = Array.isArray(metadata.sourceRefs) ? metadata.sourceRefs : [];
            return entries.some(entry => entry && typeof entry === 'object' && String((entry as Record<string, unknown>).collection ?? '') === 'facts' && String((entry as Record<string, unknown>).recordId ?? '') === fact.id)
              || sourceRefs.some(sourceRef => fact.sourceRefs.includes(String(sourceRef)));
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

  async listFactsPage(request: MemoryPageRequest): Promise<MemoryPage<MemoryUiFact>> {
    const chatKey = this.requireChatKey();
    const signal = request.signal;
    const query = request.query?.trim().toLocaleLowerCase() ?? '';
    const pageRequest: MemoryPageRequest = {
      ...request,
      filter: { ...(request.filter ?? {}) },
    };
    let page: MemoryPage<MemoryFact>;
    if (!this.multiActorRepository) {
      page = await this.repository.pageFacts(chatKey, pageRequest);
    } else if (!query) {
      page = await this.multiActorRepository.page<MemoryFact>('facts', pageRequest, {
        workspaceId: this.multiActorRepository.boundWorkspaceId,
        chatKey,
      });
    } else {
      const items: MemoryFact[] = [];
      let cursor = request.cursor;
      let nextCursor: string | null = cursor ?? null;
      const seen = new Set<string>();
      do {
        if (signal?.aborted) throw signal.reason;
        const rawPage = await this.multiActorRepository.page<MemoryFact>('facts', {
          ...pageRequest,
          ...(cursor === undefined ? {} : { cursor }),
          limit: Math.max(1, request.limit - items.length),
          includeTotal: false,
        }, {
          workspaceId: this.multiActorRepository.boundWorkspaceId,
          chatKey,
        });
        for (const fact of rawPage.items) {
          if ([fact.content, fact.canonicalKey, ...fact.entityKeys].some(value => value.toLocaleLowerCase().includes(query))) items.push(fact);
        }
        nextCursor = rawPage.nextCursor;
        if (items.length >= request.limit || nextCursor === null) break;
        if (seen.has(nextCursor)) throw createSSHelperError('INTERNAL_ERROR', { stage: 'memory.ui.facts-page.search-pagination' });
        seen.add(nextCursor);
        cursor = nextCursor;
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      } while (cursor);
      page = { items, nextCursor };
    }

    if (signal?.aborted) throw signal.reason;
    const factIds = page.items.map(fact => fact.id);
    let evidence: MemoryEvidence[] = [];
    if (factIds.length > 0) {
      if (this.multiActorRepository) {
        let cursor: string | undefined;
        do {
          const evidencePage = await this.multiActorRepository.page<MemoryEvidence>('evidence', {
            limit: 500,
            signal,
            ...(cursor === undefined ? {} : { cursor }),
            where: [{ field: 'factId', op: 'in', value: factIds }],
          }, {
            workspaceId: this.multiActorRepository.boundWorkspaceId,
            chatKey,
          });
          evidence.push(...evidencePage.items);
          cursor = evidencePage.nextCursor ?? undefined;
        } while (cursor);
      } else evidence = await this.repository.listEvidenceForFacts(chatKey, factIds, signal);
    }
    const evidenceByFact = new Map<string, MemoryEvidence[]>();
    for (const item of evidence) {
      const bucket = evidenceByFact.get(item.factId) ?? [];
      bucket.push(item);
      evidenceByFact.set(item.factId, bucket);
    }
    return {
      items: page.items.map(fact => asUiFact(
        fact,
        (evidenceByFact.get(fact.id) ?? []).map(item => ({ sourceRef: item.sourceRef, excerpt: item.excerpt })),
        [],
      )),
      nextCursor: page.nextCursor,
      ...(page.total === undefined ? {} : { total: page.total }),
    };
  }

  async getLibraryStats(): Promise<{
    total: number;
    active: number;
    pending: number;
    evidenceCoverage: number;
    kindCounts: Readonly<Record<string, number>>;
    statusCounts: Readonly<Record<string, number>>;
  }> {
    const chatKey = this.requireChatKey();
    const scope = this.multiActorRepository
      ? { workspaceId: this.multiActorRepository.boundWorkspaceId, chatKey }
      : undefined;
    const count = async (request: MemoryPageRequest): Promise<number> => {
      const page = this.multiActorRepository
        ? await this.multiActorRepository.page<MemoryFact>('facts', { ...request, limit: 1, includeTotal: true }, scope)
        : await this.repository.pageFacts(chatKey, { ...request, limit: 1, includeTotal: true });
      return page.total ?? page.items.length;
    };
    const kinds = ['identity', 'relationship', 'location', 'world_rule', 'state', 'goal', 'commitment', 'preference', 'capability', 'event', 'other'];
    const statuses = ['active', 'pending', 'superseded', 'invalid'];
    const [total, evidenceBacked, kindValues, statusValues] = await Promise.all([
      count({ limit: 1 }),
      count({ limit: 1, where: [{ field: 'freshestEvidenceAt', op: 'gt', value: 0 }] }),
      Promise.all(kinds.map(kind => count({ limit: 1, filter: { kind } }))),
      Promise.all(statuses.map(status => count({ limit: 1, filter: { status } }))),
    ]);
    const kindCounts = Object.fromEntries(kinds.map((kind, index) => [kind, kindValues[index] ?? 0]));
    const statusCounts = Object.fromEntries(statuses.map((status, index) => [status, statusValues[index] ?? 0]));
    return {
      total,
      active: statusCounts.active ?? 0,
      pending: statusCounts.pending ?? 0,
      evidenceCoverage: total === 0 ? 0 : Math.round((evidenceBacked / total) * 100),
      kindCounts,
      statusCounts,
    };
  }

  async loadMemoryPage<T>(resource: MemoryPageResource, request: MemoryPageRequest): Promise<MemoryPage<T>> {
    if (resource === 'facts') return this.listFactsPage(request) as Promise<MemoryPage<T>>;
    const chatKey = this.requireChatKey();
    const workspaceId = this.multiActorRepository?.boundWorkspaceId;
    const workspaceOnly = resource === 'actors' || resource === 'actor-aliases' || resource === 'inventory-items' || resource === 'profiles' || resource === 'profile-claims';
    const scope: Record<string, string> = resource === 'usage'
      ? { chatKey }
      : {
          ...(workspaceId ? { workspaceId } : {}),
          ...(workspaceOnly ? {} : { chatKey }),
          ...(resource === 'actor-candidates' ? { status: 'pending' } : {}),
        };
    const load = (pageRequest: MemoryPageRequest): Promise<MemoryPage<T>> => {
      if (this.multiActorRepository && resource !== 'usage') {
        return this.multiActorRepository.page<T>(resource, pageRequest, scope);
      }
      return this.repository.pageCollection<T>(resource, pageRequest, scope);
    };
    const needle = request.query?.trim().toLocaleLowerCase() ?? '';
    if (!needle) return load(request);

    const items: T[] = [];
    let cursor = request.cursor;
    let nextCursor: string | null = cursor ?? null;
    const seen = new Set<string>();
    do {
      if (request.signal?.aborted) throw request.signal.reason;
      const page = await load({
        ...request,
        ...(cursor === undefined ? {} : { cursor }),
        query: '',
        limit: Math.max(1, request.limit - items.length),
        includeTotal: false,
      });
      for (const item of page.items) {
        const haystack = JSON.stringify(item).toLocaleLowerCase();
        if (haystack.includes(needle)) items.push(item);
      }
      nextCursor = page.nextCursor;
      if (items.length >= request.limit || nextCursor === null) break;
      if (seen.has(nextCursor)) throw createSSHelperError('INTERNAL_ERROR', { stage: `memory.ui.${resource}.search-pagination` });
      seen.add(nextCursor);
      cursor = nextCursor;
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    } while (cursor);
    return { items, nextCursor };
  }

  async listMemoryCandidatesPage(request: MemoryPageRequest): Promise<MemoryPage<MemoryCandidateRecord>> {
    return this.loadMemoryPage<MemoryCandidateRecord>('memory-candidates', request);
  }

  async getMemoryCandidateStats(filters: Readonly<Record<string, string | number>> = {}): Promise<MemoryCandidateStats> {
    const chatKey = this.requireChatKey();
    const floorFilter = filters.floor === undefined || filters.floor === '' ? undefined : Number(filters.floor);
    const filter = Object.fromEntries(Object.entries(filters).filter(([key, value]) => key !== 'floor' && value !== '' && value !== undefined));
    const rows: MemoryCandidateRecord[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await this.loadMemoryPage<MemoryCandidateRecord>('memory-candidates', {
        limit: 500,
        ...(cursor ? { cursor } : {}),
        filter: filter as unknown as Readonly<Record<string, PlainData>>,
      });
      rows.push(...page.items);
      if (!page.nextCursor) break;
      if (seen.has(page.nextCursor)) throw createSSHelperError('INTERNAL_ERROR', { stage: 'memory.ui.memory-candidates.stats-pagination' });
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    } while (cursor);
    const scopedRows = floorFilter === undefined || !Number.isFinite(floorFilter)
      ? rows
      : rows.filter(row => row.evidence.some(span => span.floor === floorFilter));
    const byStatus = scopedRows.reduce<Record<string, number>>((counts, row) => {
      counts[row.status] = (counts[row.status] ?? 0) + 1;
      return counts;
    }, {});
    const accepted = byStatus.accepted ?? 0;
    const rejectedOrIgnored = (byStatus.rejected ?? 0) + (byStatus.ignored ?? 0);
    const jobIds = [...new Set(scopedRows.map(row => row.jobId).filter((value): value is string => Boolean(value)))];
    const batchIndexes = new Set(scopedRows.map(row => row.batchIndex).filter((value): value is number => Number.isInteger(value)));
    return {
      total: scopedRows.length,
      accepted,
      notWritten: scopedRows.length - accepted,
      rejectedOrIgnored,
      byStatus,
      ...(jobIds.length === 1 ? { jobId: jobIds[0] } : {}),
      batchCount: batchIndexes.size,
    };
  }

  async getMemoryCandidateSourcePreview(candidateId: string, sourceRef: string): Promise<MemoryCandidateSourcePreview> {
    const chatKey = this.requireChatKey();
    const page = await this.loadMemoryPage<MemoryCandidateRecord>('memory-candidates', {
      limit: 1,
      filter: { id: candidateId },
    });
    const candidate = page.items[0];
    if (!candidate || candidate.chatKey !== chatKey) throw createSSHelperError('WORKSPACE_NOT_FOUND', { stage: 'memory.ui.memory-candidates.lookup' });
    const saved = candidate.evidence.filter(span => span.sourceRef === sourceRef);
    const sources = await this.collectSources(chatKey);
    const source = sources.find(item => item.id === sourceRef);
    if (!source) {
      const fallback = saved[0];
      if (!fallback) throw createSSHelperError('WORKSPACE_NOT_FOUND', { stage: 'memory.ui.memory-candidates.source' });
      return {
        candidateId,
        sourceRef,
        sourceKind: fallback.sourceKind,
        ...(fallback.floor === undefined ? {} : { floor: fallback.floor }),
        ...(fallback.floor === undefined ? {} : { messageIndex: fallback.floor }),
        text: fallback.text,
        digest: fallback.sourceDigest,
        sourceChanged: true,
        warning: 'source_missing',
        highlights: [{ start: fallback.start, end: fallback.end, text: fallback.text }],
      };
    }
    const digest = candidateSourceDigest(source.content);
    const highlights: Array<{ start: number; end: number; text: string }> = [];
    let warning: MemoryCandidateSourcePreview['warning'];
    for (const span of saved) {
      if (digest === span.sourceDigest && span.start >= 0 && span.end <= source.content.length && source.content.slice(span.start, span.end) === span.text) {
        highlights.push({ start: span.start, end: span.end, text: span.text });
        continue;
      }
      const positions: number[] = [];
      let offset = source.content.indexOf(span.text);
      while (offset >= 0) {
        positions.push(offset);
        offset = source.content.indexOf(span.text, offset + Math.max(1, span.text.length));
      }
      if (positions.length === 1) highlights.push({ start: positions[0]!, end: positions[0]! + span.text.length, text: span.text });
      else warning = positions.length === 0 ? 'no_match' : 'ambiguous_match';
    }
    return {
      candidateId,
      sourceRef,
      sourceKind: source.kind,
      ...(source.floor === undefined ? {} : { floor: source.floor }),
      ...(source.floor === undefined ? {} : { messageIndex: source.floor }),
      text: source.content,
      digest,
      sourceChanged: digest !== (saved[0]?.sourceDigest ?? digest),
      ...(warning && !highlights.length && saved.length ? { savedText: saved.map(span => span.text).join('\n') } : {}),
      ...(warning ? { warning } : {}),
      highlights,
    };
  }

  onSettingsChanged(listener: (settings: MemoryUiSettings) => void): () => void {
    this.settingsListeners.add(listener);
    return () => this.settingsListeners.delete(listener);
  }

  onOverviewChanged(listener: () => void): () => void {
    this.overviewListeners.add(listener);
    return () => this.overviewListeners.delete(listener);
  }

  onGenerationRecallDetailsChanged(listener: (kind: 'updated' | 'cleared') => void): () => void {
    this.generationRecallDetailListeners.add(listener);
    return () => this.generationRecallDetailListeners.delete(listener);
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
      this.scheduleVectorSync(chatKey);
      this.scheduleGraph(chatKey);
      this.emitOverviewChanged();
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
    this.scheduleVectorSync(chatKey);
    this.scheduleGraph(chatKey);
    this.emitOverviewChanged();
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

  async getSqliteStatus(options: { readonly detailed?: boolean } = {}): Promise<MemorySqliteStatus> {
    try {
      traceMemoryStartup('application:sqlite-status-begin');
      const health = options.detailed === true
        ? await this.repository.refreshHealth(this.getChatKey())
        : await this.repository.readHealth();
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
        ...(health.failure ? { failure: health.failure } : {}),
      };
    } catch (error) {
      this.sqliteAvailable = false;
      this.vectorIndex.stop();
      this.setRuntimeError(error, 'WORKSPACE_DATABASE_UNAVAILABLE', 'health');
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
        failure: readSSHelperFailure(error, {
          reasonCode: 'WORKSPACE_DATABASE_UNAVAILABLE',
          stage: 'memory.health',
        })!,
      };
    }
  }

  private setRuntimeError(error: unknown, fallbackCode: SSHelperReasonCode, stage: Parameters<typeof describeMemoryError>[2]): void {
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
    if (!this.sqliteAvailable) throw createSSHelperError('WORKSPACE_UNAVAILABLE', { stage: 'memory.archive.export' });
    return this.repository.exportBackup();
  }

  async importSqliteBackup(_file: File): Promise<void> {
    // v0 deliberately starts from a clean WorkspacePort model. Importing an
    // archive would silently reintroduce retired facts, slots and ownership
    // semantics, so the old archive route is fail-closed rather than treated
    // as a migration helper.
    throw createSSHelperError('MEMORY_ARCHIVE_IMPORT_DISABLED', { stage: 'memory.archive.import' });
  }

  async checkSqliteIntegrity(): Promise<{ ok: boolean; message: string }> {
    if (!this.sqliteAvailable) return { ok: false, message: 'Memory workspace 不可用。' };
    return this.repository.checkIntegrity();
  }

  async clearCurrentChatData(): Promise<void> {
    const chatKey = this.requireChatKey();
    if (this.multiActorRepository) await this.multiActorRepository.clearCurrentChatData();
    else await this.repository.clearCurrentChatData(chatKey);
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
    this.lastSceneState = null;
    this.lastPreparedGeneration = null;
    this.lastIncludedTraceIds = [];
    this.lastActorRecall = null;
    this.actorExposureTracker = new RecallExposureTracker();
    this.lastExposureIds.clear();
    this.lastOrganizedAt = null;
    this.activeCaptureProgress = null;
    this.activeExtractionSnapshot = null;
    this.captureStartedAt = 0;
    this.cancelRequested = false;
    this.clearRuntimeError();
    this.scheduleGraph(chatKey);
    this.emitGenerationRecallDetailsChanged('cleared');
    this.emitOverviewChanged();
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
    this.lastSceneState = null;
    this.lastPreparedGeneration = null;
    this.lastIncludedTraceIds = [];
    this.lastActorRecall = null;
    this.actorExposureTracker = new RecallExposureTracker();
    this.lastExposureIds.clear();
    if (this.hostContext && this.multiActorRepository) {
      this.bindStorageScope(this.hostContext.getWorkspaceId(), this.getChatKey());
    }
    this.emitGenerationRecallDetailsChanged('cleared');
    await this.bindCurrentChat();
  }

  private async loadSettings(): Promise<void> {
    const [enabled, autoOrganize, extractionMode, agentConcurrency, agentToolPolicy, summaryBatchMode, summaryBatchFloors, summaryBatchChars, summaryIntervalFloors, summaryOverlapFloors, maxRecallItems, promptMaxChars, answerMode, recallMode, rerankMode, preExtractReferenceEnabled, preExtractReferenceItems, preExtractReferenceMode, preExtractReferenceMaxChars, structuredRepairEnabled, structuredRepairBeforeFloors, structuredRepairAfterFloors, structuredRepairMaxItems, graphEnabled, graphLlmRelationEnabled, graphMaxHops, graphMaxEdges, chatOverrides, summaryProgressByChat] = await Promise.all([
      this.repository.getSetting<boolean>('enabled'),
      this.repository.getSetting<boolean>('autoOrganize'),
      this.repository.getSetting<MemoryGlobalSettings['extractionMode']>('extractionMode'),
      this.repository.getSetting<number>('agentConcurrency'),
      this.repository.getSetting<MemoryGlobalSettings['agentToolPolicy']>('agentToolPolicy'),
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
      this.repository.getSetting<boolean>('structuredRepairEnabled'),
      this.repository.getSetting<number>('structuredRepairBeforeFloors'),
      this.repository.getSetting<number>('structuredRepairAfterFloors'),
      this.repository.getSetting<number>('structuredRepairMaxItems'),
      this.repository.getSetting<boolean>('graphEnabled'),
      this.repository.getSetting<boolean>('graphLlmRelationEnabled'),
      this.repository.getSetting<number>('graphMaxHops'),
      this.repository.getSetting<number>('graphMaxEdges'),
      this.repository.getSetting<Record<string, boolean>>('chatOverrides'),
      this.repository.getSetting<Record<string, SummaryProgress>>('summaryProgressByChat'),
    ]);
    const [castPlanningMode, focusLookbackFloors, actorScanLookbackFloors, persistPresenceUntilTransition, plannerCandidateThreshold, plannerConfidenceThreshold, likelyActorRecall, backgroundActorRecall, provisionalActorEnabled, plannerCanProposeActors, unplannedActorPolicy, maxPlannerCallsPerTurn] = await Promise.all([
      this.repository.getSetting<MemoryGlobalSettings['castPlanningMode']>('castPlanningMode'),
      this.repository.getSetting<number>('focusLookbackFloors'),
      this.repository.getSetting<number>('actorScanLookbackFloors'),
      this.repository.getSetting<boolean>('persistPresenceUntilTransition'),
      this.repository.getSetting<number>('plannerCandidateThreshold'),
      this.repository.getSetting<number>('plannerConfidenceThreshold'),
      this.repository.getSetting<MemoryGlobalSettings['likelyActorRecall']>('likelyActorRecall'),
      this.repository.getSetting<MemoryGlobalSettings['backgroundActorRecall']>('backgroundActorRecall'),
      this.repository.getSetting<boolean>('provisionalActorEnabled'),
      this.repository.getSetting<boolean>('plannerCanProposeActors'),
      this.repository.getSetting<MemoryGlobalSettings['unplannedActorPolicy']>('unplannedActorPolicy'),
      this.repository.getSetting<number>('maxPlannerCallsPerTurn'),
    ]);
    this.settings = {
      enabled: enabled ?? DEFAULT_SETTINGS.enabled,
      autoOrganize: autoOrganize ?? DEFAULT_SETTINGS.autoOrganize,
      extractionMode: extractionMode === 'agent' ? 'agent' : 'single',
      agentConcurrency: agentConcurrency === 1 ? 1 : 2,
      agentToolPolicy: agentToolPolicy === 'read_only' ? 'read_only' : 'off',
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
      structuredRepairEnabled: structuredRepairEnabled ?? DEFAULT_SETTINGS.structuredRepairEnabled,
      structuredRepairBeforeFloors: Math.min(10, Math.max(0, Math.trunc(structuredRepairBeforeFloors ?? DEFAULT_SETTINGS.structuredRepairBeforeFloors))),
      structuredRepairAfterFloors: Math.min(10, Math.max(0, Math.trunc(structuredRepairAfterFloors ?? DEFAULT_SETTINGS.structuredRepairAfterFloors))),
      structuredRepairMaxItems: Math.min(8, Math.max(1, Math.trunc(structuredRepairMaxItems ?? DEFAULT_SETTINGS.structuredRepairMaxItems))),
      graphEnabled: graphEnabled ?? DEFAULT_SETTINGS.graphEnabled,
      graphLlmRelationEnabled: graphLlmRelationEnabled ?? DEFAULT_SETTINGS.graphLlmRelationEnabled,
      graphMaxHops: clampGraphMaxHops(graphMaxHops ?? DEFAULT_SETTINGS.graphMaxHops),
      graphMaxEdges: clampGraphMaxEdges(graphMaxEdges ?? DEFAULT_SETTINGS.graphMaxEdges),
      castPlanningMode: castPlanningMode === 'fast' || castPlanningMode === 'director' ? castPlanningMode : 'hybrid',
      focusLookbackFloors: clampFocusLookbackFloors(focusLookbackFloors ?? DEFAULT_SETTINGS.focusLookbackFloors),
      actorScanLookbackFloors: clampActorScanLookbackFloors(actorScanLookbackFloors ?? DEFAULT_SETTINGS.actorScanLookbackFloors),
      persistPresenceUntilTransition: persistPresenceUntilTransition ?? DEFAULT_SETTINGS.persistPresenceUntilTransition,
      plannerCandidateThreshold: clampPlannerCandidateThreshold(plannerCandidateThreshold ?? DEFAULT_SETTINGS.plannerCandidateThreshold),
      plannerConfidenceThreshold: clampPlannerConfidenceThreshold(plannerConfidenceThreshold ?? DEFAULT_SETTINGS.plannerConfidenceThreshold),
      likelyActorRecall: likelyActorRecall === 'identity_only' || likelyActorRecall === 'none' ? likelyActorRecall : 'public_only',
      backgroundActorRecall: backgroundActorRecall === 'public_only' || backgroundActorRecall === 'none' ? backgroundActorRecall : 'identity_only',
      mentionedActorRecall: 'none',
      provisionalActorEnabled: provisionalActorEnabled ?? DEFAULT_SETTINGS.provisionalActorEnabled,
      plannerCanProposeActors: plannerCanProposeActors ?? DEFAULT_SETTINGS.plannerCanProposeActors,
      unplannedActorPolicy: unplannedActorPolicy === 'allow_without_private_memory' || unplannedActorPolicy === 'regenerate_once'
        ? unplannedActorPolicy
        : 'allow_public_only',
      maxPlannerCallsPerTurn: maxPlannerCallsPerTurn === 0 ? 0 : 1,
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
    this.capturePromise = this.runCapture(mode, resumeJob, selectedSourceGroups, options).finally(() => {
      this.finishInitializationVectorSync();
      this.capturePromise = null;
      this.emitOverviewChanged();
    });
    return this.capturePromise;
  }

  /** Production multi-owner Capture uses the configured summary window and batching settings. */
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
    const captureSettings = this.getEffectiveSettings();
    if (mode === 'initialize') this.initializationVectorSyncBarrier = true;
    const strategy = summaryStrategyFromSettings(captureSettings);
    const includeHiddenMessageFloors = mode === 'initialize'
      && (resumeJob?.checkpoint.includeHiddenMessageFloors ?? options.includeHiddenMessageFloors ?? true);
    const [baselineFacts, referenceScope] = captureSettings.preExtractReferenceEnabled
      ? await Promise.all([
        actorRepository.listFacts(),
        context.getRecallContext?.() ?? Promise.resolve(undefined),
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
    const allSources = selectSourceGroups(
      await context.collectSources(chatKey).then(sources => filterSourceBlocks(sources, { includeHiddenMessageFloors })),
      mode === 'incremental' ? undefined : (resumeJob?.checkpoint.selectedSourceGroupIds ?? selectedSourceGroups),
    );
    this.assertCaptureCurrent(captureVersion, chatKey);
    const existingProgress = await this.ensureSummaryProgress(chatKey, allSources);
    if (existingProgress) {
      const waiting = getSummaryWaitingFloors(allSources, existingProgress, strategy);
      if (waiting !== undefined) this.summaryWaitingByChat.set(chatKey, waiting);
      this.emitSettingsChanged();
    }
    const automaticWindow = mode === 'incremental'
      ? selectAutomaticSummaryWindow(allSources, existingProgress, strategy)
      : undefined;
    const sources = automaticWindow?.sources ?? (mode === 'incremental' ? [] : allSources);
    await this.retryEvidenceChangedCaptureRepairs(
      actorRepository,
      allSources,
      captureSettings,
      captureVersion,
      chatKey,
      includeHiddenMessageFloors,
    ).catch((error) => logger.warn(
      '隔离记忆将在下次证据变化时继续复核。',
      readSSHelperFailure(error, { reasonCode: 'REPAIR_UNRESOLVED', stage: 'memory.repair.evidence-change' }),
    ));
    if (sources.length === 0) return;
    const summaryOptions = {
      includeHiddenMessageFloors,
      ...(automaticWindow ? { writableSourceRefs: automaticWindow.writableSourceRefs } : {}),
    };
    const messageSources = visibleConversationMessages(sources, summaryOptions);
    const allPlans = buildSummaryBatchPlans(sources, strategy, summaryOptions);
    const availableBatchCount = allPlans.length;
    const requestedRangeStart = mode === 'initialize'
      ? resumeJob?.checkpoint.batchRangeStart ?? options.batchRange?.start ?? 1
      : 1;
    const requestedRangeEnd = mode === 'initialize'
      ? resumeJob?.checkpoint.batchRangeEnd ?? options.batchRange?.end ?? availableBatchCount
      : availableBatchCount;
    const batchRangeStart = availableBatchCount === 0
      ? 0
      : Math.min(availableBatchCount, Math.max(1, Math.trunc(Number(requestedRangeStart) || 1)));
    const batchRangeEnd = availableBatchCount === 0
      ? 0
      : Math.min(availableBatchCount, Math.max(batchRangeStart, Math.trunc(Number(requestedRangeEnd) || availableBatchCount)));
    const selectedPlans = allPlans.slice(Math.max(0, batchRangeStart - 1), batchRangeEnd);
    const totalBatches = selectedPlans.length;
    const requestedResumeBatchIndex = Math.min(totalBatches, Math.max(0, resumeJob?.checkpoint.batchIndex ?? 0));
    const resumeBatchIndex = requestedResumeBatchIndex;
    const resumedProcessedCount = Math.max(0, resumeJob?.checkpoint.processedCount ?? 0);
    const plans = selectedPlans.slice(resumeBatchIndex);
    const selectedWritableFloors = selectedPlans.flatMap((plan) => {
      const writableRefs = new Set(plan.writableSourceRefs);
      return plan.sources
        .filter((source) => source.kind === 'message' && writableRefs.has(source.id))
        .map((source) => source.floor)
        .filter((floor): floor is number => Number.isFinite(floor));
    });
    const selectedStartFloor = selectedWritableFloors.length > 0 ? Math.min(...selectedWritableFloors) : undefined;
    const selectedEndFloor = selectedWritableFloors.length > 0 ? Math.max(...selectedWritableFloors) : undefined;
    const selectedEndMessage = selectedEndFloor === undefined
      ? undefined
      : [...messageSources].reverse().find((source) => source.floor === selectedEndFloor);
    const target = automaticWindow
      ? { startFloor: automaticWindow.startFloor, endFloor: automaticWindow.endFloor, endMessageId: automaticWindow.endMessageId }
      : selectedStartFloor !== undefined && selectedEndFloor !== undefined
        ? { startFloor: selectedStartFloor, endFloor: selectedEndFloor, endMessageId: selectedEndMessage?.id ?? '' }
        : undefined;
    const selectedGroups = resumeJob?.checkpoint.selectedSourceGroupIds
      ?? selectedSourceGroups
      ?? summarizeSourceGroups(allSources).map(group => group.id);
    const jobId = resumeJob?.id ?? createId('job');
    const createdAt = resumeJob?.createdAt ?? Date.now();
    const baseCheckpoint: MemoryJob['checkpoint'] = {
      batchIndex: resumeBatchIndex,
      lastScannedBatch: resumeJob?.checkpoint.lastScannedBatch ?? Math.max(0, batchRangeStart - 1),
      completedBatchCount: resumeJob?.checkpoint.completedBatchCount ?? resumeBatchIndex,
      pendingRepairCount: resumeJob?.checkpoint.pendingRepairCount ?? 0,
      totalBatches,
      batchRangeStart,
      batchRangeEnd,
      availableBatchCount,
      processedCount: resumedProcessedCount,
      ...(resumeJob?.checkpoint.lastSourceRef === undefined ? {} : { lastSourceRef: resumeJob.checkpoint.lastSourceRef }),
      ...(resumeJob?.checkpoint.overlapSourceRefs === undefined ? {} : { overlapSourceRefs: resumeJob.checkpoint.overlapSourceRefs }),
      ...(resumeJob?.checkpoint.metadataSourceRefs === undefined ? {} : { metadataSourceRefs: resumeJob.checkpoint.metadataSourceRefs }),
      selectedSourceGroupIds: selectedGroups,
      includeHiddenMessageFloors,
      ...(target === undefined ? {} : { summaryStartFloor: target.startFloor, summaryEndFloor: target.endFloor, summaryEndMessageId: target.endMessageId }),
      phase: 'capture',
      extractionMode: resumeJob?.checkpoint.extractionMode ?? captureSettings.extractionMode,
      agentConcurrency: resumeJob?.checkpoint.agentConcurrency ?? captureSettings.agentConcurrency,
      agentToolPolicy: resumeJob?.checkpoint.agentToolPolicy ?? captureSettings.agentToolPolicy,
      ...(resumeJob?.checkpoint.actualUsage ? { actualUsage: resumeJob.checkpoint.actualUsage } : {}),
      ...(resumeJob?.checkpoint.usageRequestCount === undefined ? {} : { usageRequestCount: resumeJob.checkpoint.usageRequestCount }),
      ...(resumeJob?.checkpoint.usageReportedCount === undefined ? {} : { usageReportedCount: resumeJob.checkpoint.usageReportedCount }),
    };
    this.activeExtractionSnapshot = {
      extractionMode: baseCheckpoint.extractionMode,
      agentConcurrency: baseCheckpoint.agentConcurrency,
      agentToolPolicy: baseCheckpoint.agentToolPolicy,
    };
    const persistJob = (job: MemoryJob): Promise<void> => actorRepository.upsertCaptureJob({
      ...job,
      workspaceId: actorRepository.boundWorkspaceId,
    });
    let checkpoint = baseCheckpoint;
    let pendingCaptureCheckpoint: MemoryJob['checkpoint'] | undefined;
    const recordUsage = (usage: MemoryLlmUsage | undefined): void => {
      const fields = {
        actualUsage: mergeActualUsage(checkpoint.actualUsage, usage),
        usageRequestCount: (checkpoint.usageRequestCount ?? 0) + 1,
        usageReportedCount: (checkpoint.usageReportedCount ?? 0) + (hasReportedUsage(usage) ? 1 : 0),
      };
      checkpoint = { ...checkpoint, ...fields };
      if (pendingCaptureCheckpoint) Object.assign(pendingCaptureCheckpoint, fields);
      if (this.activeCaptureProgress?.jobId === jobId) {
        this.activeCaptureProgress = { ...this.activeCaptureProgress, ...fields };
      }
      this.emitOverviewChanged();
    };
    if (plans.length === 0) {
      if (resumeJob) {
        if (resumeJob.status === 'needs_repair' || (resumeJob.checkpoint.pendingRepairCount ?? 0) > 0) {
          this.status = 'working';
          this.captureStartedAt = Date.now();
          const repair = await this.runDeferredCaptureRepairs(
            actorRepository,
            jobId,
            allSources,
            captureSettings,
            captureVersion,
            chatKey,
            includeHiddenMessageFloors,
            recordUsage,
          );
          const finalQueue = await actorRepository.listCaptureRepairQueue(jobId);
          const reconciledJob = (await actorRepository.listCaptureJobs())
            .find(job => String(job.id ?? '') === jobId) as unknown as MemoryJob | undefined;
          const repairBaseJob = reconciledJob ?? resumeJob;
          const queueByRejectionId = new Map(finalQueue.flatMap(record =>
            (record.rejectionIds?.length ? record.rejectionIds : record.rejectionId ? [record.rejectionId] : [])
              .map(rejectionId => [rejectionId, record] as const)));
          const rejections = (repairBaseJob.rejections ?? []).map(rejection => {
            const queueRecord = rejection.id ? queueByRejectionId.get(rejection.id) : undefined;
            if (!queueRecord) return rejection;
            if (queueRecord.waitingForEvidenceChange === true) return {
              ...rejection,
              status: 'unresolved' as const,
              waitingForEvidenceChange: true,
              repairAttempts: queueRecord.attemptCount,
            };
            if (queueRecord.status === 'ignored') return {
              ...rejection,
              status: 'ignored' as const,
              waitingForEvidenceChange: false,
              repairAttempts: queueRecord.attemptCount,
              ignoredAt: queueRecord.resolvedAt ?? Date.now(),
            };
            if (queueRecord.status !== 'resolved') return rejection;
            return {
              ...rejection,
              status: 'repaired' as const,
              waitingForEvidenceChange: false,
              repairAttempts: queueRecord.attemptCount,
              repairedAt: queueRecord.resolvedAt ?? Date.now(),
            };
          });
          const unresolvedCount = rejections.filter(rejection => (rejection.status ?? 'unresolved') === 'unresolved').length;
          const repairCounts = this.captureRepairQueueCounts(finalQueue);
          const retryableRepairCount = repairCounts.retryable;
          const exhaustedRepairCount = repairCounts.exhausted;
          const reviewRequiredCount = 0;
          const repairedCount = rejections.filter(rejection => rejection.status === 'repaired').length;
          const ignoredCount = rejections.filter(rejection => rejection.status === 'ignored').length;
          const nextStatus = retryableRepairCount > 0
            ? 'needs_repair' as const
            : 'completed' as const;
          const nextCheckpoint = {
            ...checkpoint,
            phase: 'repair' as const,
            pendingRepairCount: retryableRepairCount,
            retryableRepairCount,
            exhaustedRepairCount,
            quarantinedCount: repairCounts.quarantined,
            reviewRequiredCount,
            unresolvedRejectionCount: unresolvedCount,
            repairedCount,
            degradedCount: repair.degraded,
            ignoredCount,
          };
          const repairJobWithoutFailure = { ...repairBaseJob };
          delete repairJobWithoutFailure.failure;
          await persistJob({
            ...repairJobWithoutFailure,
            status: nextStatus,
            outcome: unresolvedCount > 0 ? 'partial' : 'complete',
            rejectionCount: unresolvedCount,
            rejections,
            checkpoint: nextCheckpoint,
            updatedAt: Date.now(),
          });
          this.activeCaptureProgress = {
            status: nextStatus,
            jobId,
            batchIndex: totalBatches,
            totalBatches,
            completedBatchCount: nextCheckpoint.completedBatchCount ?? totalBatches,
            batchRangeStart,
            batchRangeEnd,
            availableBatchCount,
            processedCount: nextCheckpoint.processedCount,
            elapsedMs: Date.now() - this.captureStartedAt,
            phase: 'repair',
            outcome: unresolvedCount > 0 ? 'partial' : 'complete',
            rejectedCount: unresolvedCount,
            pendingRepairCount: retryableRepairCount,
            retryableRepairCount,
            exhaustedRepairCount,
            reviewRequiredCount,
            unresolvedRejectionCount: unresolvedCount,
            repairedCount,
            degradedCount: repair.degraded,
            ignoredCount,
            ...usageProgress(nextCheckpoint),
          };
          this.status = 'ready';
          return;
        }
        await this.rebuildCaptureProjections(actorRepository).catch((error) => {
          logger.warn('Capture 已全部提交，派生投影将在后续重建。', error);
        });
        const { failure: _previousFailure, ...completedJob } = resumeJob;
        await persistJob({
          ...completedJob,
          status: 'completed',
          checkpoint,
          updatedAt: Date.now(),
        });
      }
      return;
    }
    this.status = 'working';
    this.cancelRequested = false;
    this.captureStartedAt = Date.now();
    this.activeCaptureProgress = {
      status: 'running',
      jobId,
      batchIndex: resumeBatchIndex,
      totalBatches,
      completedBatchCount: baseCheckpoint.completedBatchCount ?? resumeBatchIndex,
      batchRangeStart,
      batchRangeEnd,
      availableBatchCount,
      processedCount: baseCheckpoint.processedCount,
      elapsedMs: 0,
      phase: 'capture',
      ...usageProgress(baseCheckpoint),
    };
    await persistJob({ id: jobId, chatKey, type: mode, status: 'running', checkpoint: baseCheckpoint, createdAt, updatedAt: Date.now() });
    let processedCount = baseCheckpoint.processedCount;
    const processedMetadataRefs = new Set(baseCheckpoint.metadataSourceRefs ?? []);
    const captureResults: import('./actors').MultiActorCaptureResult[] = [];
    let aggregatedRejections = [...(resumeJob?.rejections ?? [])];
    const replaceRejectionsForSources = (
      previous: readonly AutomaticIngestRejection[],
      writableSourceRefs: readonly string[],
      incoming: readonly AutomaticIngestRejection[],
    ): AutomaticIngestRejection[] => {
      const writable = new Set(writableSourceRefs);
      const retained = previous.filter((rejection) => {
        const refs = rejection.sourceRefs ?? [];
        // Reprocessing a batch replaces its old validation result. Rejections
        // without source provenance are retained because they cannot safely be
        // attributed to this batch.
        return refs.length === 0 || !refs.some(ref => writable.has(ref));
      });
      const byId = new Map<string, AutomaticIngestRejection>();
      for (const rejection of [...retained, ...incoming]) {
        const key = rejection.id
          ?? `${rejection.recordType ?? 'batch'}:${rejection.index}:${rejection.code}:${rejection.fieldPath ?? ''}:${(rejection.sourceRefs ?? []).join('|')}`;
        byId.set(key, rejection);
      }
      return [...byId.values()];
    };
    try {
      for (let index = 0; index < plans.length; index += 1) {
        const plan = plans[index]!;
        const scopedBatchIndex = resumeBatchIndex + index + 1;
        const sourceBatchIndex = Math.max(0, batchRangeStart - 1) + scopedBatchIndex;
        this.activeCaptureProgress = {
          status: 'running',
          jobId,
          batchIndex: scopedBatchIndex,
          totalBatches,
          completedBatchCount: checkpoint.completedBatchCount ?? resumeBatchIndex,
          batchRangeStart,
          batchRangeEnd,
          availableBatchCount,
          processedCount,
          elapsedMs: Date.now() - this.captureStartedAt,
          phase: 'capture',
          ...usageProgress(checkpoint),
        };
        this.emitOverviewChanged();
        const existingMemoryContext = referenceRetriever ? await referenceRetriever.load({
          chatKey,
          sources: plan.sources,
          maxItems: captureSettings.preExtractReferenceItems,
          maxChars: captureSettings.preExtractReferenceMaxChars,
          // Initialization must not issue one query embedding per source batch.
          // Formal chat recall keeps its configured lexical/vector/hybrid mode.
          mode: mode === 'initialize' ? 'lexical' : captureSettings.preExtractReferenceMode,
          characterKeys: referenceScope?.characterKeys ?? [],
          worldKeys: referenceScope?.worldKeys ?? [],
          graphMaxHops: captureSettings.graphMaxHops,
          graphMaxEdges: captureSettings.graphMaxEdges,
        }) : [];
        this.assertCaptureCurrent(captureVersion, chatKey);
        const writableRefs = new Set(plan.writableSourceRefs);
        const nextMetadataRefs = new Set(processedMetadataRefs);
        plan.sources
          .filter((source) => source.kind !== 'message' && writableRefs.has(source.id))
          .forEach((source) => nextMetadataRefs.add(source.id));
        const nextCheckpoint: MemoryJob['checkpoint'] = {
          ...checkpoint,
          batchIndex: scopedBatchIndex,
          lastScannedBatch: sourceBatchIndex,
          completedBatchCount: (checkpoint.completedBatchCount ?? resumeBatchIndex) + 1,
          processedCount: processedCount + plan.messageCount,
          lastSourceRef: plan.sources.at(-1)?.id,
          overlapSourceRefs: plan.sources.filter((source) => !writableRefs.has(source.id)).map((source) => source.id),
          metadataSourceRefs: [...nextMetadataRefs],
        };
        pendingCaptureCheckpoint = nextCheckpoint;
        let result: import('./actors').MultiActorCaptureResult;
        try {
          result = await this.executeActorCapture(plan.sources, {
            captureJobId: jobId,
            captureJob: {
              id: jobId,
              chatKey,
              type: mode,
              status: 'running',
              checkpoint: nextCheckpoint,
              ...(aggregatedRejections.length > 0 ? { rejections: aggregatedRejections } : {}),
              createdAt,
              updatedAt: Date.now(),
            },
            writableSourceRefs: plan.writableSourceRefs,
            existingMemoryContext,
            graphLlmRelationEnabled: captureSettings.graphEnabled && captureSettings.graphLlmRelationEnabled,
            idempotencyKey: `capture:${jobId}:batch:${sourceBatchIndex}`,
            includeHiddenMessageFloors,
            onUsage: recordUsage,
          });
        } finally {
          pendingCaptureCheckpoint = undefined;
        }
        captureResults.push(result);
        aggregatedRejections = replaceRejectionsForSources(
          aggregatedRejections,
          plan.writableSourceRefs,
          result.rejections ?? [],
        );
        processedCount = nextCheckpoint.processedCount;
        for (const ref of nextMetadataRefs) processedMetadataRefs.add(ref);
        checkpoint = nextCheckpoint;
        this.activeCaptureProgress = {
          status: 'running',
          jobId,
          batchIndex: checkpoint.batchIndex,
          totalBatches,
          completedBatchCount: checkpoint.completedBatchCount ?? checkpoint.batchIndex,
          batchRangeStart,
          batchRangeEnd,
          availableBatchCount,
          processedCount,
          elapsedMs: Date.now() - this.captureStartedAt,
          phase: 'capture',
          ...usageProgress(checkpoint),
        };
        this.emitOverviewChanged();
      }
      let finalRejections = aggregatedRejections.map(rejection =>
        (rejection.status ?? 'unresolved') === 'unresolved'
          && !isAiRepairableProposalCode(rejection.code)
          ? { ...rejection, status: 'ignored' as const, ignoredAt: Date.now(), waitingForEvidenceChange: false }
          : rejection);
      const initiallyRepairable = finalRejections.filter(rejection =>
        (rejection.status ?? 'unresolved') === 'unresolved'
        && isAiRepairableProposalCode(rejection.code)).length;
      if (initiallyRepairable > 0) {
        checkpoint = {
          ...checkpoint,
          phase: 'repair',
          pendingRepairCount: initiallyRepairable,
          ...usageProgress(checkpoint),
        };
        this.activeCaptureProgress = {
          status: captureSettings.structuredRepairEnabled ? 'repairing' : 'needs_repair',
          jobId,
          batchIndex: 0,
          totalBatches: initiallyRepairable,
          batchRangeStart,
          batchRangeEnd,
          availableBatchCount,
          processedCount: 0,
          elapsedMs: Date.now() - this.captureStartedAt,
          phase: 'repair',
          outcome: 'partial',
          rejectedCount: initiallyRepairable,
          pendingRepairCount: initiallyRepairable,
          ...usageProgress(checkpoint),
        };
        this.emitOverviewChanged();
        await persistJob({
          id: jobId,
          chatKey,
          type: mode,
          status: captureSettings.structuredRepairEnabled ? 'repairing' : 'needs_repair',
          outcome: 'partial',
          rejectionCount: finalRejections.filter(rejection => (rejection.status ?? 'unresolved') === 'unresolved').length,
          rejections: finalRejections,
          checkpoint,
          createdAt,
          updatedAt: Date.now(),
        });
        const repair = await this.runDeferredCaptureRepairs(
          actorRepository,
          jobId,
          allSources,
          captureSettings,
          captureVersion,
          chatKey,
          includeHiddenMessageFloors,
          recordUsage,
        );
        captureResults.push(...repair.results);
        const repairQueue = await actorRepository.listCaptureRepairQueue(jobId);
        const queueByRejectionId = new Map(repairQueue.flatMap(record =>
          (record.rejectionIds?.length ? record.rejectionIds : record.rejectionId ? [record.rejectionId] : [])
            .map(rejectionId => [rejectionId, record] as const)));
        finalRejections = finalRejections.map(rejection => {
          const queueRecord = rejection.id ? queueByRejectionId.get(rejection.id) : undefined;
          if (queueRecord?.waitingForEvidenceChange === true) return {
            ...rejection,
            status: 'unresolved' as const,
            waitingForEvidenceChange: true,
            repairAttempts: queueRecord.attemptCount,
          };
          if (queueRecord?.status === 'ignored') return {
            ...rejection,
            status: 'ignored' as const,
            waitingForEvidenceChange: false,
            repairAttempts: queueRecord.attemptCount,
            ignoredAt: queueRecord.resolvedAt ?? Date.now(),
          };
          return queueRecord?.status === 'resolved' ? {
              ...rejection,
              status: 'repaired' as const,
              waitingForEvidenceChange: false,
              repairAttempts: queueRecord.attemptCount,
              repairedAt: queueRecord.resolvedAt ?? Date.now(),
            } : rejection;
        });
        const repairCounts = this.captureRepairQueueCounts(repairQueue);
        const retryableRepairCount = repairCounts.retryable;
        const exhaustedRepairCount = repairCounts.exhausted;
        checkpoint = {
          ...checkpoint,
          pendingRepairCount: retryableRepairCount,
          retryableRepairCount,
          exhaustedRepairCount,
          quarantinedCount: repairCounts.quarantined,
          reviewRequiredCount: 0,
          unresolvedRejectionCount: finalRejections.filter(rejection => (rejection.status ?? 'unresolved') === 'unresolved').length,
          repairedCount: finalRejections.filter(rejection => rejection.status === 'repaired').length,
          degradedCount: repair.degraded,
          ignoredCount: finalRejections.filter(rejection => rejection.status === 'ignored').length,
        };
      }
      const acceptedFacts = captureResults.flatMap(result => result.facts);
      const acceptedFactIds = new Set([...baselineFacts.map(fact => fact.id), ...acceptedFacts.map(fact => fact.id)]);
      const orphanTraceCount = captureResults
        .flatMap(result => result.traces)
        .filter(trace => !acceptedFactIds.has(trace.factId))
        .length;
      if (orphanTraceCount > 0) {
        throw createSSHelperError('MEMORY_CAPTURE_INTEGRITY_FAILED', {
          stage: 'memory.capture.integrity',
        });
      }
      try {
        await this.finalizeActorCaptureResults(captureResults, sources, captureVersion, chatKey, false);
      } catch (error) {
        // Base facts, evidence, traces, the root ChangeSet and the batch
        // checkpoint were already committed atomically. Rebuildable
        // projections must never turn that successful commit into a paused
        // capture job.
        this.assertCaptureCurrent(captureVersion, chatKey);
        logger.warn('Capture 基础事实已提交，派生投影将在后续重建。', error);
      }
      this.assertCaptureCurrent(captureVersion, chatKey);
      const outcome = finalRejections.some(rejection => (rejection.status ?? 'unresolved') === 'unresolved')
        ? 'partial' as const
        : 'complete' as const;
      const unresolvedCount = finalRejections
        .filter(rejection => (rejection.status ?? 'unresolved') === 'unresolved').length;
      checkpoint = {
        ...checkpoint,
        degradedCount: captureResults.filter(result => result.resolutionMode === 'degraded').length,
      };
      const retryableRepairCount = checkpoint.retryableRepairCount ?? checkpoint.pendingRepairCount ?? 0;
      const nextStatus = retryableRepairCount > 0
        ? 'needs_repair' as const
        : 'completed' as const;
      if (unresolvedCount > 0) {
        checkpoint = {
          ...checkpoint,
          phase: 'repair',
          // This counter represents records that are still present in the
          // repair queue, not the number that entered the phase. Resolved
          // records must therefore reduce it instead of being restored by
          // the original repairable count.
          pendingRepairCount: checkpoint.pendingRepairCount ?? initiallyRepairable,
        };
      }
      await persistJob({
        id: jobId,
        chatKey,
        type: mode,
        status: nextStatus,
        outcome,
        rejectionCount: unresolvedCount,
        rejections: finalRejections,
        checkpoint,
        createdAt,
        updatedAt: Date.now(),
      });
      await this.bindCurrentChat();
      this.lastOrganizedAt = Date.now();
      if (target && (mode === 'incremental' || batchRangeStart === 1)) {
        await this.saveSummaryProgress(chatKey, target.endFloor, target.endMessageId, jobId);
        const waiting = getSummaryWaitingFloors(allSources, this.summaryProgressByChat[chatKey], strategy);
        if (waiting !== undefined) this.summaryWaitingByChat.set(chatKey, waiting);
        this.emitSettingsChanged();
      }
      this.status = 'ready';
      this.clearRuntimeError();
      this.activeCaptureProgress = {
        status: nextStatus,
        jobId,
        batchIndex: totalBatches,
        totalBatches,
        completedBatchCount: checkpoint.completedBatchCount ?? totalBatches,
        batchRangeStart,
        batchRangeEnd,
        availableBatchCount,
        processedCount,
        elapsedMs: Date.now() - this.captureStartedAt,
        phase: unresolvedCount > 0 ? 'repair' : 'capture',
        outcome,
        rejectedCount: finalRejections.filter(item => (item.status ?? 'unresolved') === 'unresolved').length,
        pendingRepairCount: checkpoint.pendingRepairCount ?? 0,
        retryableRepairCount: checkpoint.retryableRepairCount ?? 0,
        exhaustedRepairCount: checkpoint.exhaustedRepairCount ?? 0,
        reviewRequiredCount: checkpoint.reviewRequiredCount ?? 0,
        unresolvedRejectionCount: checkpoint.unresolvedRejectionCount ?? unresolvedCount,
        repairedCount: checkpoint.repairedCount ?? 0,
        degradedCount: checkpoint.degradedCount ?? 0,
        ignoredCount: checkpoint.ignoredCount ?? 0,
        ...usageProgress(checkpoint),
      };
    } catch (error) {
      const failure = readSSHelperFailure(error, {
        reasonCode: 'INTERNAL_ERROR',
        stage: 'memory.capture',
      })!;
      if (this.stopped || captureVersion !== this.captureVersion || this.getChatKey() !== chatKey) {
        if (failure.reasonCode === 'MEMORY_CAPTURE_ROLLBACK_FAILED') {
          checkpoint = { ...baseCheckpoint, ...usageProgress(checkpoint) };
          this.setRuntimeError(error, 'MEMORY_CAPTURE_ROLLBACK_FAILED', 'operation');
          if (!this.stopped && this.getChatKey() === chatKey) {
            await persistJob({
              id: jobId,
              chatKey,
              type: mode,
              status: 'failed',
              checkpoint,
              failure,
              createdAt,
              updatedAt: Date.now(),
            });
          }
          this.activeCaptureProgress = {
            status: 'failed', jobId, batchIndex: checkpoint.batchIndex, totalBatches,
            completedBatchCount: checkpoint.completedBatchCount ?? 0,
            batchRangeStart, batchRangeEnd, availableBatchCount,
            processedCount: checkpoint.processedCount, elapsedMs: Date.now() - this.captureStartedAt,
            failure, phase: 'capture',
            ...usageProgress(checkpoint),
          };
          throw error;
        }
        if (!this.stopped) await persistJob({ id: jobId, chatKey, type: mode, status: 'paused', checkpoint, createdAt, updatedAt: Date.now() });
        this.status = this.getEffectiveSettings().enabled ? 'ready' : 'disabled';
        this.activeCaptureProgress = {
          status: this.cancelRequested ? 'cancelled' : 'paused',
          jobId,
          batchIndex: checkpoint.batchIndex,
          totalBatches,
          completedBatchCount: checkpoint.completedBatchCount ?? 0,
          batchRangeStart,
          batchRangeEnd,
          availableBatchCount,
          processedCount: checkpoint.processedCount,
          elapsedMs: Date.now() - this.captureStartedAt,
          phase: 'capture',
          ...usageProgress(checkpoint),
        };
        return;
      }
      this.setRuntimeError(error, 'INTERNAL_ERROR', 'operation');
      const pauseForRetry = isRetryableCaptureError(error);
      const contextualFailure: SSHelperFailureContext = {
        ...failure,
        batchIndex: checkpoint.batchIndex,
      };
      await persistJob({
        id: jobId,
        chatKey,
        type: mode,
        status: pauseForRetry ? 'paused' : 'failed',
        checkpoint,
        failure: contextualFailure,
        createdAt,
        updatedAt: Date.now(),
      });
      this.activeCaptureProgress = {
        status: pauseForRetry ? 'paused' : 'failed',
        jobId,
        batchIndex: checkpoint.batchIndex,
        totalBatches,
        completedBatchCount: checkpoint.completedBatchCount ?? 0,
        batchRangeStart,
        batchRangeEnd,
        availableBatchCount,
        processedCount: checkpoint.processedCount,
        elapsedMs: Date.now() - this.captureStartedAt,
        failure: contextualFailure,
        phase: 'capture',
        ...usageProgress(checkpoint),
      };
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
    const settings = this.getEffectiveSettings();
    if (!settings.enabled) return;
    if (!this.actorCapture || !this.multiActorRepository) {
      throw createSSHelperError('MEMORY_CAPTURE_NOT_BOUND', { stage: 'memory.capture.bind' });
    }
    await this.runMultiActorCaptureWorkflow(mode, resumeJob, selectedSourceGroups, options);
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
    if (this.stopped) return;
    this.overviewListeners.forEach((listener) => {
      try { listener(); } catch { /* a stale popup listener must not affect application state */ }
    });
  }

  private emitGenerationRecallDetailsChanged(kind: 'updated' | 'cleared'): void {
    if (this.stopped) return;
    this.generationRecallDetailListeners.forEach((listener) => {
      try { listener(kind); } catch { /* a stale chat action listener must not affect application state */ }
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
      throw createSSHelperError('CANCELLED', { stage: 'memory.capture.cancel' });
    }
  }

}
