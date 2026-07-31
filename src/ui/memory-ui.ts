import './memory.css';
import './initialization.css';
import './actor-memory.css';
import memoryPluginConfig from '../../plugin.config.json' with { type: 'json' };
import {
  UI_CONTROL_ATTRIBUTE,
  UI_CONTROL_ICON_ONLY_ATTRIBUTE,
  UI_CONTROL_SIZE_ATTRIBUTE,
  UI_CONTROL_TONE_ATTRIBUTE,
  describeSSHelperFailure,
  isSSHelperReasonCode,
  type PopupUiContext,
  type ToastNotification,
  type UiControlKind,
  type UiControlSize,
  type UiControlTone,
  type ChatNavigationTarget,
  type SSHelperFailureContext,
} from '@ss-helper/sdk';
import type { SummaryInitializationEstimate } from '../application/ingest/summary-strategy';
import {
  DEFAULT_MEMORY_TRAITS,
  type CastPlanningSettings,
  type GenerationRecallDetail,
  type MainChatUsage,
  type MemoryGraphPreview,
  type MemoryGraphStatus,
} from '../domain';
import { describeMemoryError, type MemoryErrorDiagnostic } from '../diagnostics/memory-error';
import { startMemoryPerformanceSpan, traceMemoryStartup } from '../host/runtime-feedback';
import { mountRelationshipGraphThree, type RelationshipGraphCommand, type RelationshipGraphRenderer } from './relationship-graph-three';
import {
  mountInventoryCardThree,
  type InventoryCardRenderer,
  type InventoryCardViewModel,
} from './inventory-card-three';
import { latestInventoryState, selectInventoryWorkbenchModel } from './inventory-workbench-model';
import { selectGraphView } from './relationship-graph-layout';
import {
  getSceneEventsHeader,
  normalizeSceneEventsSelection,
  renderSceneEventsPage,
  renderSceneEventRecordRow,
  renderSelectedSceneGraphDetail,
  sceneGraphOwnerKind,
  sceneGraphOwnerLabel,
  type SceneEventCategory,
  type SceneEventsState,
} from './scene-events-view';
import {
  mountSceneCastPixi,
  type SceneCastPixiCommand,
  type SceneCastPixiRenderer,
} from './scene-cast-pixi';
import { renderInitializationView } from './initialization-view';
import {
  renderMemoryLibraryFactRow,
  renderMemoryLibraryView,
  selectMemoryLibraryView,
  type MemoryLibrarySort,
} from './memory-library-view';
import type { MemoryPage, MemoryPageRequest, MemoryPageResource } from './memory-page';
import {
  normalizeActorMemorySelection,
  renderActorMemoryTraceRow,
  renderActorMemoryPage,
  updateActorMemoryGaugeZone,
  type ActorMemoryGroup,
  type ActorMemoryLevel,
  type ActorMemorySort,
  type ActorMemoryTab,
  type ActorMemoryViewState,
} from './actor-memory-view';

export interface MemoryUiSettings extends CastPlanningSettings {
  enabled: boolean;
  autoOrganize: boolean;
  summaryBatchMode: 'floors' | 'chars';
  summaryBatchFloors: number;
  summaryBatchChars: number;
  summaryIntervalFloors: number;
  summaryOverlapFloors: number;
  maxRecallItems: number;
  promptMaxChars: number;
  answerMode: 'auto' | 'roleplay' | 'diagnostic';
  recallMode: 'auto' | 'lexical' | 'vector' | 'hybrid';
  rerankMode: 'off' | 'adaptive' | 'always';
  preExtractReferenceEnabled: boolean;
  preExtractReferenceItems: number;
  preExtractReferenceMode: 'auto' | 'lexical' | 'vector' | 'hybrid';
  preExtractReferenceMaxChars: number;
  structuredRepairEnabled: boolean;
  structuredRepairBeforeFloors: number;
  structuredRepairAfterFloors: number;
  structuredRepairMaxItems: number;
  graphEnabled: boolean;
  graphLlmRelationEnabled: boolean;
  graphMaxHops: 1 | 2;
  graphMaxEdges: number;
  chatMode: 'inherit' | 'enabled' | 'disabled';
}

export interface MemoryRecallRouteStatus {
  available: boolean;
  resourceId?: string;
  model?: string;
  blockedReason?: string;
}

export interface MemoryRecallBatchStatus {
  batchIndex: number;
  inputCount: number;
  accepted: number;
  rejected: number;
  latencyMs: number;
  resourceId?: string;
  model?: string;
  dimensions?: number;
  usage: unknown;
}

export interface MemoryRecallStatus {
  resolvedMode: 'lexical' | 'vector' | 'hybrid';
  embedding: MemoryRecallRouteStatus;
  rerank: MemoryRecallRouteStatus;
  indexedFacts: number;
  eligibleFacts: number;
  pendingFacts: number;
  rebuilding: boolean;
  degradedReason?: string;
  lastError?: string;
  batches: readonly MemoryRecallBatchStatus[];
}

export interface MemorySqliteStatus {
  connected: boolean;
  serverVersion: string;
  nodeVersion: string;
  protocolVersion: number;
  sqliteVersion: string;
  schemaVersion: number;
  databasePath: string;
  databaseSizeBytes: number;
  workspaceSizeBytes: number;
  currentChatSizeBytes: number;
  currentChatUsageRatio: number;
  walMode: string;
  tableCounts: Readonly<Record<string, number>>;
  tableBytes: Readonly<Record<string, number | null>>;
  vectorCoverage: { indexedFacts: number; eligibleFacts: number; ratio: number };
  failure?: SSHelperFailureContext;
}

export interface MemorySqliteIntegrityResult { ok: boolean; message: string }
export const EXPECTED_SQLITE_SCHEMA_VERSION = 0;

export interface MemoryUiFact {
  id: string;
  content: string;
  subjectKey?: string;
  predicateKey?: string;
  kind: string;
  status: string;
  confidence: number;
  sourceRefs: string[];
  evidence: Array<{ sourceRef: string; excerpt: string }>;
  supersedesId?: string;
  supersededById?: string;
  auditBatches?: Array<{ jobId: string; batchIndex: number; status: string; kind?: string }>;
  updatedAt: number;
}

export interface MemoryUiOverview {
  status: 'ready' | 'working' | 'error' | 'disabled' | 'unselected';
  bound?: boolean;
  chatKey?: string;
  chatName?: string;
  factCount: number;
  currentChatSizeBytes?: number;
  currentChatUsageRatio?: number;
  lastOrganizedAt: number | null;
  pendingJobs: number;
  llmAvailable: boolean;
  llmResource?: string;
  llmModel?: string;
  /** Current vector-model route status, when the LLM capability probe has completed. */
  embedding?: MemoryRecallRouteStatus;
  /** Current reranking-model route status, when the LLM capability probe has completed. */
  rerank?: MemoryRecallRouteStatus;
  failure?: SSHelperFailureContext;
  errorDiagnostic?: MemoryErrorDiagnostic;
}

export interface MemoryInitializationOptions {
  /** 默认包含酒馆隐藏的普通聊天楼层；设为 false 时仅处理当前可见楼层。 */
  includeHiddenMessageFloors?: boolean;
}
export interface MemoryInitializationSourceOption {
  kind: string;
  label: string;
  /** Count after the currently selected visibility mode is applied. */
  count: number;
  /** Count before visibility/content filtering. */
  rawCount: number;
  /** Count under the default safe visible-only mode. */
  defaultCount: number;
  /** Raw entries still excluded under the current mode. */
  excludedCount: number;
  selected: boolean;
}
export interface MemoryCaptureProgress {
  status: 'idle' | 'queued' | 'running' | 'repairing' | 'needs_repair' | 'needs_review' | 'paused' | 'completed' | 'failed' | 'cancelled';
  jobId?: string;
  batchIndex: number;
  totalBatches: number;
  processedCount: number;
  elapsedMs: number;
  failure?: SSHelperFailureContext;
  phase?: 'capture' | 'repair';
  outcome?: 'complete' | 'partial';
  rejectedCount?: number;
  pendingRepairCount?: number;
  retryableRepairCount?: number;
  exhaustedRepairCount?: number;
  quarantinedCount?: number;
  reviewRequiredCount?: number;
  unresolvedRejectionCount?: number;
  repairedCount?: number;
  degradedCount?: number;
  ignoredCount?: number;
}

export interface MemoryInitializationAttempt {
  jobId: string;
  status: MemoryCaptureProgress['status'];
  updatedAt: number;
  totalBatches: number;
  selectedSourceKinds: string[];
  includeHiddenMessageFloors?: boolean;
  failure?: SSHelperFailureContext;
}

export interface MemoryInitializationState {
  initialized: boolean;
  lastCompletedAt: number | null;
  selectedSourceKinds: string[];
  attempts: MemoryInitializationAttempt[];
}

export type MemoryAuditStatus = 'completed' | 'partial' | 'rolled_back';
export type MemoryAuditIssueStatus = 'queued' | 'running' | 'unresolved' | 'repaired' | 'ignored';

/** UI-safe Capture issue. Candidate bodies and provider payloads never cross this boundary. */
export interface MemoryAuditIssue {
  id: string;
  /** Original Capture rejection id used by the real ignore operation. */
  rejectionId?: string;
  collection: string;
  itemIndex: number;
  batchIndex: number;
  path: string;
  keyword?: string;
  expected?: string;
  sourceRefs: string[];
  status: MemoryAuditIssueStatus;
  canIgnore: boolean;
  attemptCount: number;
  maxAttempts?: number;
  waitingForEvidenceChange: boolean;
  resolutionMode?: string;
  failure: SSHelperFailureContext;
}

/** Required, allow-listed audit projection consumed by the workbench. */
export interface MemoryAuditRecord {
  id: string;
  jobId: string;
  createdAt: number;
  rolledBackAt?: number;
  status: MemoryAuditStatus;
  outcome: 'complete' | 'partial';
  batchIndex: number;
  sourceRefs: string[];
  acceptedCount: number;
  rejectedCount: number;
  unresolvedCount: number;
  repairedCount: number;
  ignoredCount: number;
  issues: MemoryAuditIssue[];
  requestId?: string;
  resourceId?: string;
  model?: string;
  latencyMs?: number;
  fallbackUsed?: boolean;
}

export interface MemoryAuditSummary {
  auditTotal: number;
  pendingIssueCount: number;
  rolledBackCount: number;
  usageTotal: number;
  promptTokens: { value: number | null; known: number };
  completionTokens: { value: number | null; known: number };
  totalTokens: { value: number | null; known: number };
  incompleteUsageCount: number;
  models: string[];
}

export interface ActorCorrectionReview { readonly id: string; readonly operation: 'correction' | 'merge' | 'split' | 'rename' | 'alias'; readonly status: 'pending' | 'applied' | 'undone'; readonly ownerIds: readonly string[]; readonly createdAt: number; readonly sourceRef?: string; }

export interface MemoryUiController {
  getSettings(): MemoryUiSettings;
  saveSettings(settings: MemoryUiSettings): Promise<void>;
  getOverview(): Promise<MemoryUiOverview>;
  /** Optional notification for current-workspace data, binding, or health changes. */
  onOverviewChanged?: (listener: () => void) => () => void;
  getInitializationEstimate(selectedKinds?: string[], options?: MemoryInitializationOptions): Promise<MemoryInitializationEstimate>;
  getInitializationSources(options?: MemoryInitializationOptions): Promise<MemoryInitializationSourceOption[]>;
  getInitializationState(): Promise<MemoryInitializationState>;
  initialize(selectedKinds?: string[], options?: MemoryInitializationOptions): Promise<void>;
  reinitialize(selectedKinds?: string[], options?: MemoryInitializationOptions): Promise<void>;
  getCaptureProgress(): Promise<MemoryCaptureProgress>;
  cancelCapture(): Promise<void>;
  retry(): Promise<void>;
  listFacts(query?: string): Promise<MemoryUiFact[]>;
  listFactsPage?(request: MemoryPageRequest): Promise<MemoryPage<MemoryUiFact>>;
  getLibraryStats?(): Promise<{
    total: number;
    active: number;
    pending: number;
    evidenceCoverage: number;
    kindCounts: Readonly<Record<string, number>>;
    statusCounts: Readonly<Record<string, number>>;
  }>;
  loadMemoryPage?<T>(resource: MemoryPageResource, request: MemoryPageRequest): Promise<MemoryPage<T>>;
  updateFact(id: string, content: string): Promise<void>;
  removeFact(id: string): Promise<void>;
  getLastRecall(): Promise<unknown>;
  listAuditRecords(): Promise<MemoryAuditRecord[]>;
  listAuditRecordsPage?(request: MemoryPageRequest): Promise<MemoryPage<MemoryAuditRecord>>;
  getAuditSummary?(): Promise<MemoryAuditSummary>;
  ignoreCaptureRejections?(auditId: string, rejectionIds: readonly string[]): Promise<void>;
  getMainChatUsage(): Promise<MainChatUsage[]>;
  getMainChatUsagePage?(request: MemoryPageRequest): Promise<MemoryPage<MainChatUsage>>;
  getGenerationRecallDetail?(detailId: string): Promise<GenerationRecallDetail | undefined>;
  getRecallStatus(): Promise<MemoryRecallStatus>;
  rebuildVectorIndex(): Promise<void>;
  getGraphStatus(): MemoryGraphStatus;
  getRelationshipGraph(query?: string, limit?: number): Promise<MemoryGraphPreview>;
  rebuildGraph(): Promise<void>;
  getSqliteStatus(options?: { readonly detailed?: boolean }): Promise<MemorySqliteStatus>;
  exportSqliteBackup(): Promise<Blob>;
  importSqliteBackup(file: File): Promise<void>;
  checkSqliteIntegrity(): Promise<MemorySqliteIntegrityResult>;
  /** Optional multi-actor workbench read models. */
  listActors?(): Promise<readonly import('../domain').MemoryOwner[]>;
  listActorAliases?(): Promise<readonly import('../domain').ActorAlias[]>;
  listInventoryStates?(): Promise<{ readonly items: readonly import('../domain').InventoryItem[]; readonly states: readonly import('../domain').InventoryState[] }>;
  getInventoryHistory?(itemId: string): Promise<readonly import('../domain').InventoryEvent[]>;
  createInventoryItem?(input: { readonly canonicalName: string; readonly aliases?: readonly string[]; readonly category?: import('../domain').InventoryItemCategory }): Promise<import('../domain').InventoryItem>;
  applyInventoryCommand?(command: import('../domain').InventoryCommand, options?: { readonly expectedRevision?: number; readonly idempotencyKey?: string }): Promise<{ readonly state: import('../domain').InventoryState; readonly event: import('../domain').InventoryEvent }>;
  invalidateInventoryItem?(itemId: string): Promise<import('../domain').InventoryItem>;
  listSceneCasts?(): Promise<readonly import('../domain').SceneCast[]>;
  getCurrentSceneState?(): Promise<import('../domain').SceneState | null>;
  listSceneTransitions?(): Promise<readonly import('../domain').SceneTransition[]>;
  correctCurrentSceneState?(input: { readonly ownerId: string; readonly placement: 'present' | 'nearby' | 'exited' | 'viewpoint' }): Promise<void>;
  listGenerationCastPlans?(): Promise<readonly import('../domain').GenerationCastPlan[]>;
  listCastPlanAudits?(): Promise<readonly import('../domain').CastPlanAudit[]>;
  listRecallCoverageLogs?(): Promise<readonly import('../domain').RecallCoverageLog[]>;
  listMemoryUsageLogs?(): Promise<readonly import('../domain').MemoryUsageLog[]>;
  getActorRecallDiagnostics?(): Promise<import('../domain').ActorRecallResponse | null>;
  listEpisodes?(): Promise<readonly import('../domain').MemoryEpisode[]>;
  listObservations?(): Promise<readonly import('../domain').MemoryObservation[]>;
  listActorTraces?(ownerId?: string): Promise<readonly import('../domain').ActorMemoryTrace[]>;
  listActorProfiles?(ownerId?: string): Promise<readonly Record<string, unknown>[]>;
  listActorDreams?(ownerId?: string): Promise<readonly Record<string, unknown>[]>;
  runActorDream?(jobId: string, options?: { readonly dryRun?: boolean; readonly narrative?: boolean }): Promise<import('../application/dream').DreamAudit>;
  rollbackActorDream?(auditId: string): Promise<void>;
  listActorCorrectionReviews?(): Promise<readonly ActorCorrectionReview[]>;
  resolveActorCorrection?(auditId: string, action: 'confirm' | 'undo'): Promise<void>;
  listPendingActorCandidates?(): Promise<readonly import('../domain').ActorCandidate[]>;
  confirmActorCandidate?(candidateId: string, resolution?: import('../domain').ActorCandidateResolution): Promise<void>;
  mergeActors?(fromOwnerId: string, intoOwnerId: string): Promise<void>;
  splitActor?(ownerId: string, aliasValue: string, displayName?: string): Promise<void>;
  renameActor?(ownerId: string, displayName: string): Promise<void>;
  updateActorMemoryTraits?(ownerId: string, traits: import('../domain').MemoryTraits): Promise<void>;
  correctActorAlias?(aliasId: string, ownerId: string): Promise<void>;
  rollbackActorCapture?(auditId: string): Promise<void>;
  clearCurrentChatData(): Promise<void>;
  clearAllMemoryData(): Promise<void>;
}

export const MEMORY_CAPABILITY_BOUNDARIES = Object.freeze([
  { name: '证据优先整理', status: '可用', detail: '只保存能够追溯到当前聊天来源的事实，避免把缺少来源的推测写成记忆。' },
  { name: '向量召回', status: '可用', detail: '使用 LLM 的向量模型建立可再生成索引，并保留实体、证据、状态和时间硬过滤。' },
  { name: '混合召回与重排序', status: '可用', detail: '关键词与向量结果融合；自适应策略仅在排序有歧义时调用 LLM 重排序模型，失败会自动降级。' },
  { name: '关系图谱', status: '可用', detail: '只从当前聊天中已验证、带证据的事实派生关系；不会把语义相似度当作实体关系，也不允许手工建边。' },
  { name: '类型工坊', status: '替代', detail: '由固定中文事实类型、搜索筛选和手工编辑替代；未知扩展类型仍可原样展示。' },
  { name: '遗忘与失真', status: '停止', detail: '不会静默删减或改写用户事实，删除必须由用户明确操作。' },
  { name: '世界风格', status: '保留来源', detail: '不再复制为独立配置；角色卡和已启用世界书会作为可选择、可追溯的初始化来源。' },
] as const);

export interface FactViewOptions { kind: string | readonly string[]; status: string | readonly string[]; sort: 'updated_desc' | 'confidence_desc' | 'kind_asc' }
export type MemoryInitializationEstimate = SummaryInitializationEstimate;

const FACT_KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  identity: '身份', relationship: '关系', location: '地点', world_rule: '世界规则', state: '状态',
  goal: '目标', commitment: '承诺', event: '事件', preference: '偏好', capability: '能力', other: '其他',
});
const FACT_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({ active: '有效', pending: '待确认', superseded: '已替代', invalid: '无效' });
const INVENTORY_CATEGORY_LABELS: Readonly<Record<import('../domain').InventoryItemCategory, string>> = Object.freeze({ weapon: '武器', medicine: '药品', food: '食物', armor: '防具', special: '特殊道具', core: '核心', material: '材料', other: '其他' });
const RECORD_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  idle: '空闲', queued: '已排队', running: '进行中', paused: '已暂停', completed: '已完成', failed: '失败', cancelled: '已取消',
});
const OVERVIEW_STATUS_LABELS: Readonly<Record<MemoryUiOverview['status'], string>> = Object.freeze({ ready: '就绪', working: '整理中', error: '异常', disabled: '已停用', unselected: '未选择' });
const RECALL_MODE_LABELS: Readonly<Record<MemoryRecallStatus['resolvedMode'], string>> = Object.freeze({ lexical: '关键词检索', vector: '向量检索', hybrid: '混合检索' });

export function translateFactKind(value: string): string { return FACT_KIND_LABELS[value] ?? value; }
export function translateFactStatus(value: string): string { return FACT_STATUS_LABELS[value] ?? value; }
const HAN_CHARACTER = /\p{Script=Han}/u;
const LATIN_PREDICATE = /^[A-Za-z][A-Za-z0-9 _-]*$/u;
const MACHINE_ENTITY_KEY = /^(?:[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+|[a-z]+(?:[A-Z][A-Za-z0-9]*)+)$/u;

function isNonChinesePredicate(value: string): boolean {
  const key = value.trim();
  return Boolean(key) && !HAN_CHARACTER.test(key) && LATIN_PREDICATE.test(key);
}

function isMachineEntityKey(value: string): boolean {
  const key = value.trim();
  return Boolean(key) && !HAN_CHARACTER.test(key) && MACHINE_ENTITY_KEY.test(key);
}

export function localizeGraphPreview(graph: MemoryGraphPreview): MemoryGraphPreview {
  return {
    nodes: graph.nodes.map((node) => ({ ...node, label: isMachineEntityKey(node.label) ? '相关对象' : node.label })),
    edges: graph.edges.map((edge) => ({ ...edge, predicate: isNonChinesePredicate(edge.predicate) ? translateFactKind(edge.kind) : edge.predicate })),
  };
}
function translateRecordStatus(value: string): string { return RECORD_STATUS_LABELS[value] ?? value; }
export function formatAuditResource(value: unknown): string {
  const resource = String(value ?? '').trim();
  if (!resource) return '未记录';
  if (resource === '__builtin_tavern__') return '酒馆内置';
  return resource;
}
export function translateOverviewStatus(value: MemoryUiOverview['status']): string { return OVERVIEW_STATUS_LABELS[value]; }
export function translateChatBinding(value: boolean | undefined): string { return value === true ? '已绑定' : value === false ? '未绑定' : '待确认'; }
export function formatChatIdentity(overview: Pick<MemoryUiOverview, 'bound' | 'chatKey' | 'chatName'> | undefined): { label: string; fullKey?: string } {
  if (!overview?.bound || !overview.chatKey) return { label: translateChatBinding(overview?.bound) };
  const fullKey = overview.chatKey;
  const rawName = overview.chatName?.trim();
  const name = rawName === 'Assistant' ? '助手' : rawName === 'User' ? '用户' : rawName;
  const timestamp = fullKey.match(/(\d{4})-(\d{2})-(\d{2})@(\d{2})h(\d{2})m(\d{2})s(?:\d+ms)?(?:\s+imported)?$/u);
  const readableTime = timestamp
    ? `${Number(timestamp[1])}年${Number(timestamp[2])}月${Number(timestamp[3])}日 ${timestamp[4]}:${timestamp[5]}:${timestamp[6]}`
    : '';
  return { label: [name || '当前聊天', readableTime].filter(Boolean).join(' · '), fullKey };
}
export function formatSourceReference(value: string): string {
  const summaryPart = value.match(/:summary-part:(\d+)$/u);
  const base = summaryPart ? value.slice(0, summaryPart.index) : value;
  const suffix = summaryPart ? `（第 ${Number(summaryPart[1]) + 1} 段）` : '';
  const message = base.match(/^message:(.+)$/u);
  if (message) return `聊天消息 #${message[1]}${suffix}`;
  const state = base.match(/^state:([^:]+)/u);
  if (state) return `聊天状态 · 消息 #${state[1]}${suffix}`;
  if (base.startsWith('host_card:')) return `角色卡世界容器${suffix}`;
  if (base.startsWith('persona:')) return `用户设定${suffix}`;
  const worldbook = base.match(/^worldbook:[^:]+:([^:]+)/u);
  if (worldbook) return `世界书条目 #${worldbook[1]}${suffix}`;
  if (base.startsWith('manual:')) return `手工记录${suffix}`;
  return `来源记录${suffix}`;
}

export function parseMessageSourceReference(value: string): ChatNavigationTarget | undefined {
  const base = value.replace(/:summary-part:\d+$/u, '');
  const match = base.match(/^message:(.+)$/u);
  if (!match) return undefined;
  const messageId = match[1]!.trim();
  if (!messageId) return undefined;
  const numeric = /^\d+$/u.test(messageId) ? Number(messageId) : undefined;
  const floor = messageId.match(/(?:^|[-_])(?:floor|message)?[-_]?([0-9]+)$/iu)?.[1];
  const index = numeric !== undefined
    ? (Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : undefined)
    : floor === undefined ? undefined : Number(floor);
  return { messageId, ...(index === undefined || !Number.isSafeInteger(index) || index < 0 ? {} : { index }) };
}
export function translateRecallMode(value: MemoryRecallStatus['resolvedMode']): string { return RECALL_MODE_LABELS[value]; }

export function filterAndSortFacts(facts: readonly MemoryUiFact[], options: FactViewOptions): MemoryUiFact[] {
  const matches = (value: string, selected: string | readonly string[]): boolean => Array.isArray(selected) ? selected.includes(value) : !selected || value === selected;
  const filtered = facts.filter((fact) => matches(fact.kind, options.kind) && matches(fact.status, options.status));
  return [...filtered].sort((left, right) => {
    if (options.sort === 'confidence_desc') return right.confidence - left.confidence || right.updatedAt - left.updatedAt;
    if (options.sort === 'kind_asc') return left.kind.localeCompare(right.kind, 'zh-CN') || right.updatedAt - left.updatedAt;
    return right.updatedAt - left.updatedAt;
  });
}

export interface SafeLlmErrorDetails { code: string; resource: string; model: string }
export function readSafeLlmErrorDetails(overview: MemoryUiOverview): SafeLlmErrorDetails {
  const code = overview.failure?.reasonCode ?? 'INTERNAL_ERROR';
  const resource = overview.llmResource ?? 'memory_extract 路由';
  const model = overview.llmModel ?? '由 LLMHub 决定';
  return { code, resource, model };
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!);
}
function formatNumber(value: number): string { return new Intl.NumberFormat('zh-CN').format(value); }
function formatTime(value: number | null | undefined): string { return value ? new Date(value).toLocaleString('zh-CN') : '尚未整理'; }
function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return 'N/A';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB']; let amount = value / 1024; let unit = units[0]!;
  for (let index = 1; index < units.length && amount >= 1024; index += 1) { amount /= 1024; unit = units[index]!; }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${unit}`;
}
function formatPercent(value: number): string {
  const percent = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 100;
  return `${percent < 10 && percent > 0 ? percent.toFixed(1) : Math.round(percent)}%`;
}
function formatJson(value: unknown, fallback = '暂无记录'): string {
  if (value === null || value === undefined) return fallback;
  try { return JSON.stringify(value, null, 2) || fallback; } catch { return fallback; }
}
function downloadBlob(content: Blob, filename: string): void {
  const anchor = document.createElement('a'); const objectUrl = URL.createObjectURL(content); anchor.href = objectUrl;
  anchor.download = content instanceof File && content.name ? content.name : filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}
function downloadSqlite(content: Blob): void {
  downloadBlob(content, `ss-helper-memory-${new Date().toISOString().slice(0, 10)}.json`);
}
function safeErrorCode(error: unknown, _fallback: string): string {
  return describeSSHelperFailure(error, { reasonCode: 'INTERNAL_ERROR', stage: 'memory.ui.action' }).reasonCode;
}
function safeInlineError(value: unknown, _fallback: string): string {
  return isSSHelperReasonCode(value) ? value : 'INTERNAL_ERROR';
}

export type MemoryWorkbenchPage = 'overview' | 'actors' | 'inventory' | 'scenes' | 'library' | 'actor-memory' | 'profiles' | 'dreams' | 'recall' | 'audit' | 'initialize' | 'graph' | 'data';
const PAGES: ReadonlyArray<{ id: MemoryWorkbenchPage; label: string; description: string; icon: string }> = [
  { id: 'overview', label: '概览', description: '当前工作区与场景状态', icon: 'gauge-high' },
  { id: 'initialize', label: '初始化', description: '选择来源并捕获当前聊天记忆', icon: 'wand-magic-sparkles' },
  { id: 'actors', label: '人物与别名', description: '主体发现与待确认归属', icon: 'users' },
  { id: 'inventory', label: '物品与资源', description: '当前数量与完整变动账本', icon: 'boxes-stacked' },
  { id: 'scenes', label: '场景与事件', description: '在场、提及与事件来源', icon: 'timeline' },
  { id: 'library', label: '记忆块', description: '浏览、审阅与编辑事实', icon: 'book-open' },
  { id: 'actor-memory', label: '角色记忆', description: '按主体查看记忆痕迹', icon: 'brain' },
  { id: 'profiles', label: '画像与关系', description: '来源支撑的增量画像', icon: 'address-card' },
  { id: 'dreams', label: 'Dream', description: '逐主体巩固、审计与回滚', icon: 'moon' },
  { id: 'recall', label: '召回与索引', description: '检查检索链路', icon: 'magnifying-glass-chart' },
  { id: 'audit', label: '审计记录', description: '查看整理批次', icon: 'list-check' },
  { id: 'data', label: '数据维护', description: '存储健康、归档与清理', icon: 'database' },
];
const INTERNAL_PAGES: ReadonlyArray<{ id: MemoryWorkbenchPage; label: string; description: string; icon: string }> = [
  { id: 'graph', label: '关系图谱', description: '召回诊断中的只读图谱', icon: 'diagram-project' },
];
const INVENTORY_DETAIL_WIDTH_MIN = 300;
const INVENTORY_DETAIL_WIDTH_MAX = 560;
const INVENTORY_DETAIL_WIDTH_DEFAULT = 360;
const INVENTORY_PREVIEW_HEIGHT_MIN = 220;
const INVENTORY_PREVIEW_HEIGHT_MAX = 520;
const INVENTORY_PREVIEW_HEIGHT_DEFAULT = 330;
const INVENTORY_SPLITTER_KEYBOARD_STEP = 16;
const INVENTORY_CARD_TRANSITION_MS = 300;
const INVENTORY_CARD_ENTER_TRANSITION_MS = 380;
type InventorySplitterKind = 'detail' | 'preview';

const serializeInventoryCardModel = (model: InventoryCardViewModel): string => JSON.stringify(model);

interface WorkbenchState {
  page: MemoryWorkbenchPage;
  loading: boolean;
  pageLoading: boolean;
  busyAction: string;
  errorDiagnostic?: MemoryErrorDiagnostic;
  pageError?: MemoryErrorDiagnostic;
  actionError?: MemoryErrorDiagnostic;
  overview?: MemoryUiOverview;
  actors: Array<import('../domain').MemoryOwner>;
  actorAliases: Array<import('../domain').ActorAlias>;
  pendingActors: Array<import('../domain').ActorCandidate>;
  actorCorrectionReviews: ActorCorrectionReview[];
  actorView: 'people' | 'pending';
  actorQuery: string;
  actorStatus: '' | import('../domain').ActorResolutionStatus;
  selectedActorId: string;
  selectedCandidateId: string;
  renamingActorId: string;
  actorRenameValue: string;
  editingActorTraitsId: string;
  actorOperation: '' | 'merge' | 'split' | 'alias';
  actorOperationAliasId: string;
  actorOperationTargetId: string;
  actorOperationName: string;
  inventoryItems: Array<import('../domain').InventoryItem>;
  inventoryStates: Array<import('../domain').InventoryState>;
  inventoryEvents: Array<import('../domain').InventoryEvent>;
  inventoryScope: 'current' | 'catalog';
  inventoryQuery: string;
  inventoryCategory: '' | import('../domain').InventoryItemCategory;
  inventorySort: 'recent' | 'name' | 'amount' | 'confidence';
  inventoryView: 'grid' | 'list';
  selectedInventoryItemId: string;
  inventoryDetailWidth: number;
  inventoryPreviewHeight: number;
  inventoryCreateOpen: boolean;
  inventoryNewName: string;
  inventoryNewAliases: string;
  inventoryNewCategory: import('../domain').InventoryItemCategory;
  inventoryCommandOperation: import('../domain').InventoryOperation;
  inventoryCommandMeasure: import('../domain').InventoryMeasureKind;
  inventoryCommandAmount: string;
  inventoryCommandUnit: string;
  inventoryCommandPrecision: import('../domain').InventoryPrecision;
  candidateResolutionMode: 'existing' | 'new';
  candidateTargetOwnerId: string;
  candidateCanonicalName: string;
  scenes: Array<import('../domain').SceneCast>;
  currentSceneState?: import('../domain').SceneState;
  sceneTransitions: Array<import('../domain').SceneTransition>;
  generationCastPlans: Array<import('../domain').GenerationCastPlan>;
  castPlanAudits: Array<import('../domain').CastPlanAudit>;
  recallCoverageLogs: Array<import('../domain').RecallCoverageLog>;
  memoryUsageLogs: Array<import('../domain').MemoryUsageLog>;
  actorRecallDiagnostics?: import('../domain').ActorRecallResponse;
  episodes: Array<import('../domain').MemoryEpisode>;
  observations: Array<import('../domain').MemoryObservation>;
  sceneCategory: SceneEventCategory;
  sceneQuery: string;
  sceneFilter: string;
  selectedSceneId: string;
  selectedEpisodeId: string;
  selectedObservationId: string;
  selectedSceneOwnerId: string;
  showSceneBoundaries: boolean;
  showSceneSources: boolean;
  showSceneConfidence: boolean;
  actorTraces: Array<import('../domain').ActorMemoryTrace>;
  actorMemoryQuery: string;
  actorMemoryKnowledgeMode: '' | import('../domain').MemoryKnowledgeMode;
  actorMemoryPrivacy: '' | import('../domain').MemoryPrivacy;
  actorMemoryLevel: '' | ActorMemoryLevel;
  actorMemorySort: ActorMemorySort;
  actorMemorySelectedOwnerId: string;
  actorMemorySelectedTraceId: string;
  actorMemoryTab: ActorMemoryTab;
  actorMemoryCollapsedGroups: ActorMemoryGroup[];
  actorMemoryNow: number;
  profiles: Array<Record<string, unknown>>;
  dreams: Array<Record<string, unknown>>;
  facts: MemoryUiFact[];
  libraryResults: MemoryUiFact[];
  libraryStats?: Awaited<ReturnType<NonNullable<MemoryUiController['getLibraryStats']>>>;
  query: string;
  selectedKinds: string[];
  selectedStatuses: string[];
  openFilter: '' | 'kind' | 'status';
  sort: MemoryLibrarySort;
  selectedFactId: string;
  editingFactId: string;
  confirmFactId: string;
  sources: MemoryInitializationSourceOption[];
  selectedSourceKinds: string[];
  includeHiddenMessageFloors: boolean;
  estimate?: MemoryInitializationEstimate;
  initialization?: MemoryInitializationState;
  progress?: MemoryCaptureProgress;
  reinitializeOpen: boolean;
  recall?: MemoryRecallStatus;
  diagnostics?: unknown;
  graph?: MemoryGraphPreview;
  graphStatus?: MemoryGraphStatus;
  graphQuery: string;
  graphKind: string;
  graphStatusFilter: string;
  graphListMode: 'edges' | 'events';
  selectedGraphEdgeId: string;
  selectedGraphEventId: string;
  selectedGraphNodeId: string;
  graphNeighborFocus: boolean;
  audits: MemoryAuditRecord[];
  usages: MainChatUsage[];
  auditSummary?: MemoryAuditSummary;
  auditTotal: number;
  usageTotal: number;
  auditSummaryLoading: boolean;
  auditTab: 'records' | 'usage';
  auditQuery: string;
  auditStatus: 'all' | MemoryAuditStatus;
  auditIssuesOnly: boolean;
  auditMobileView: 'list' | 'detail';
  selectedAuditId: string;
  selectedUsageId: string;
  usageQuery: string;
  usageModel: string;
  usageCompleteness: 'all' | 'complete' | 'missing';
  usageRecallDetail?: GenerationRecallDetail;
  usageRecallLoading: boolean;
  sqlite?: MemorySqliteStatus;
  storageUsageStatus: 'loading' | 'ready' | 'error';
  integrityText: string;
  selectedRejectionIds: string[];
  dangerConfirm: '' | 'current' | 'all';
}

function uiControl(kind: UiControlKind, tone?: UiControlTone): string {
  return `${UI_CONTROL_ATTRIBUTE}="${kind}"${tone === undefined ? '' : ` ${UI_CONTROL_TONE_ATTRIBUTE}="${tone}"`}`;
}

function uiButton(tone: UiControlTone = 'neutral', size: UiControlSize = 'md', iconOnly = false): string {
  return `${uiControl('button', tone)} ${UI_CONTROL_SIZE_ATTRIBUTE}="${size}"${iconOnly ? ` ${UI_CONTROL_ICON_ONLY_ATTRIBUTE}` : ''}`;
}

function renderStatusChip(label: string, tone: 'neutral' | 'success' | 'warning' | 'error' = 'neutral'): string {
  return `<span ${uiControl('status', tone)}>${escapeHtml(label)}</span>`;
}
function renderLoading(message = '正在读取…'): string { return `<div class="stx-memory-loading" role="status"><span class="stx-memory-spinner" aria-hidden="true"></span>${escapeHtml(message)}</div>`; }
function renderEmpty(message: string, detail = ''): string { return `<div class="stx-memory-empty"><strong>${escapeHtml(message)}</strong>${detail ? `<p>${escapeHtml(detail)}</p>` : ''}</div>`; }
function renderErrorDetails(diagnostic: MemoryErrorDiagnostic, action: 'retry-load' | 'retry-page' | 'refresh-health' | 'dismiss-error'): string {
  const actionLabel = action === 'dismiss-error' ? '关闭提示' : action === 'refresh-health' ? '重新检查' : '重试';
  const request = diagnostic.requestId
    ? `<p class="stx-memory-error-request"><span>请求 ID</span><code>${escapeHtml(diagnostic.requestId)}</code></p>`
    : '';
  return `<div class="stx-memory-error-details" role="alert"><span class="stx-memory-error-icon" aria-hidden="true"><ss-helper-icon name="triangle-exclamation" decorative></ss-helper-icon></span><div class="stx-memory-error-copy"><div class="stx-memory-error-title"><strong>${escapeHtml(diagnostic.title)}</strong>${renderStatusChip(diagnostic.reasonCode, 'error')}</div><div class="stx-memory-error-guidance"><p class="stx-memory-error-summary"><span><b>原因：</b>${escapeHtml(diagnostic.reason)}</span><span><b>处理建议：</b>${escapeHtml(diagnostic.action)}</span></p>${request}</div></div><div class="stx-memory-error-actions"><button ${uiControl('button', diagnostic.retryable && action !== 'dismiss-error' ? 'danger' : 'neutral')} type="button" data-action="${action}">${actionLabel}</button></div></div>`;
}
function renderRoute(label: string, route: MemoryRecallRouteStatus): string {
  const tone = route.available ? 'success' : 'error';
  const detail = route.available ? route.resourceId ?? '已配置' : route.blockedReason ?? '尚未在 LLM 中配置';
  return `<div class="stx-memory-route"><div><strong>${escapeHtml(label)}</strong>${renderStatusChip(route.available ? '可用' : '不可用', tone)}</div><small>${escapeHtml(detail)}</small>${route.model ? `<small>模型：${escapeHtml(route.model)}</small>` : ''}</div>`;
}
function renderOverviewRouteStatus(label: string, route: MemoryRecallRouteStatus | undefined): string {
  const status = route === undefined ? '读取中' : route.available ? '可用' : '不可用';
  const tone = route === undefined ? 'neutral' : route.available ? 'success' : 'error';
  const detail = route === undefined
    ? ''
    : route.available
      ? route.model ?? route.resourceId ?? '已配置'
      : route.blockedReason ?? '尚未在 LLM 中配置';
  return `<div class="stx-memory-status-route"><span class="stx-memory-kicker">${escapeHtml(label)}</span>${renderStatusChip(status, tone)}${detail ? `<small class="stx-memory-status-route-detail" title="${escapeHtml(detail)}">${escapeHtml(detail)}</small>` : ''}</div>`;
}

export function renderMemoryWorkbench(
  container: HTMLElement,
  controller: MemoryUiController,
  notify: (notification: ToastNotification) => void = () => undefined,
  popupUi?: PopupUiContext,
  initialActionId?: string,
  navigateToMessage?: (target: ChatNavigationTarget) => Promise<void>,
): () => void {
  traceMemoryStartup('workbench:renderer-begin');
  const root = document.createElement('div');
  root.className = 'stx-memory-workbench';
  root.setAttribute('aria-label', '记忆工作台内容');
  container.replaceChildren(root);
  traceMemoryStartup('workbench:root-attached');
  const abortController = new AbortController();
  let disposed = false;
  let searchTimer: number | undefined;
  let inventorySearchTimer: number | undefined;
  let graphSearchTimer: number | undefined;
  let progressTimer: number | undefined;
  let storageUsageTimer: number | undefined;
  let auditFilterTimer: number | undefined;
  let removeOverviewChanged: (() => void) | undefined;
  let renderFrame: number | undefined;
  let graphMarqueeResizeFrame: number | undefined;
  let graphListModeFrame: number | undefined;
  let graphMarqueeResizeObserver: ResizeObserver | undefined;
  let pendingFocusSelector = '';
  let progressRequestId = 0;
  let librarySearchRequestId = 0;
  let overviewRequestId = 0;
  let storageUsageRequestId = 0;
  let pageRequestId = 0;
  let backgroundPageRequestId = 0;
  let auditListRequestId = 0;
  let auditSummaryRequestId = 0;
  let usageRecallRequestId = 0;
  let liveRefreshRunning = false;
  let liveRefreshRequested = false;
  let graphRenderer: RelationshipGraphRenderer | undefined;
  let inventoryCardRenderer: InventoryCardRenderer | undefined;
  let inventoryCardRendererToken = 0;
  let inventoryCardModel: InventoryCardViewModel | undefined;
  let inventoryCardRendererItemId = '';
  let inventoryCardRendererModelKey = '';
  let inventoryCardMountingItemId = '';
  let inventoryCardMountingModelKey = '';
  let inventoryCardHostToRestore: HTMLElement | undefined;
  let inventoryCardFlipped = false;
  let inventorySelectionTimer: number | undefined;
  let inventoryEnterTimer: number | undefined;
  let pendingInventorySelectionId = '';
  let inventoryEnteringItemId = '';
  let inventoryResizeDrag: { kind: InventorySplitterKind; pointerId: number; splitter: HTMLElement } | undefined;
  let sceneRenderer: SceneCastPixiRenderer | undefined;
  let sceneRendererToken = 0;
  const requestedGraphPage = initialActionId === 'open-relationship-graph' || initialActionId === 'rebuild-relationship-graph';
  const state: WorkbenchState = {
    page: requestedGraphPage ? 'graph' : 'library', loading: true, pageLoading: false, busyAction: '', actors: [], actorAliases: [], pendingActors: [], actorCorrectionReviews: [], actorView: 'people', actorQuery: '', actorStatus: '', selectedActorId: '', selectedCandidateId: '', renamingActorId: '', actorRenameValue: '', editingActorTraitsId: '', actorOperation: '', actorOperationAliasId: '', actorOperationTargetId: '', actorOperationName: '', candidateResolutionMode: 'existing', candidateTargetOwnerId: '', candidateCanonicalName: '', inventoryItems: [], inventoryStates: [], inventoryEvents: [], inventoryScope: 'current', inventoryQuery: '', inventoryCategory: '', inventorySort: 'recent', inventoryView: 'grid', selectedInventoryItemId: '', inventoryDetailWidth: INVENTORY_DETAIL_WIDTH_DEFAULT, inventoryPreviewHeight: INVENTORY_PREVIEW_HEIGHT_DEFAULT, inventoryCreateOpen: false, inventoryNewName: '', inventoryNewAliases: '', inventoryNewCategory: 'other', inventoryCommandOperation: 'set', inventoryCommandMeasure: 'quantity', inventoryCommandAmount: '', inventoryCommandUnit: '个', inventoryCommandPrecision: 'exact', scenes: [], sceneTransitions: [], generationCastPlans: [], castPlanAudits: [], recallCoverageLogs: [], memoryUsageLogs: [], episodes: [], observations: [], sceneCategory: 'scene', sceneQuery: '', sceneFilter: '', selectedSceneId: '', selectedEpisodeId: '', selectedObservationId: '', selectedSceneOwnerId: '', showSceneBoundaries: true, showSceneSources: false, showSceneConfidence: true, actorTraces: [], actorMemoryQuery: '', actorMemoryKnowledgeMode: '', actorMemoryPrivacy: '', actorMemoryLevel: '', actorMemorySort: 'updated_desc', actorMemorySelectedOwnerId: '', actorMemorySelectedTraceId: '', actorMemoryTab: 'overview', actorMemoryCollapsedGroups: [], actorMemoryNow: Date.now(), profiles: [], dreams: [], facts: [], libraryResults: [], query: '', selectedKinds: Object.keys(FACT_KIND_LABELS), selectedStatuses: Object.keys(FACT_STATUS_LABELS), openFilter: '', sort: 'updated_desc',
    selectedFactId: '', editingFactId: '', confirmFactId: '', sources: [], selectedSourceKinds: [], includeHiddenMessageFloors: true, reinitializeOpen: false, audits: [], usages: [], auditTotal: 0, usageTotal: 0, auditSummaryLoading: false, auditTab: 'records', auditQuery: '', auditStatus: 'all', auditIssuesOnly: false, auditMobileView: 'list', selectedAuditId: '', selectedUsageId: '', usageQuery: '', usageModel: '', usageCompleteness: 'all', usageRecallLoading: false, storageUsageStatus: 'loading', integrityText: '尚未执行完整性检查。', selectedRejectionIds: [], dangerConfirm: '', graphQuery: '', graphKind: '', graphStatusFilter: '', graphListMode: 'edges', selectedGraphEdgeId: '', selectedGraphEventId: '', selectedGraphNodeId: '', graphNeighborFocus: false,
  };
  const sceneEventsState = (): SceneEventsState => ({
    category: state.sceneCategory,
    query: state.sceneQuery,
    filter: state.sceneFilter,
    scenes: state.scenes,
    episodes: state.episodes,
    observations: state.observations,
    actors: state.actors,
    actorAliases: state.actorAliases,
    ...(state.currentSceneState ? { currentSceneState: state.currentSceneState } : {}),
    sceneTransitions: state.sceneTransitions,
    generationCastPlans: state.generationCastPlans,
    castPlanAudits: state.castPlanAudits,
    selectedSceneId: state.selectedSceneId,
    selectedEpisodeId: state.selectedEpisodeId,
    selectedObservationId: state.selectedObservationId,
    selectedSceneOwnerId: state.selectedSceneOwnerId,
    showSceneBoundaries: state.showSceneBoundaries,
    showSceneSources: state.showSceneSources,
    showSceneConfidence: state.showSceneConfidence,
  });
  const actorMemoryState = (): ActorMemoryViewState => ({
    actors: state.actors,
    traces: state.actorTraces,
    facts: state.facts,
    observations: state.observations,
    query: state.actorMemoryQuery,
    knowledgeMode: state.actorMemoryKnowledgeMode,
    privacy: state.actorMemoryPrivacy,
    level: state.actorMemoryLevel,
    sort: state.actorMemorySort,
    selectedOwnerId: state.actorMemorySelectedOwnerId,
    selectedTraceId: state.actorMemorySelectedTraceId,
    tab: state.actorMemoryTab,
    collapsedGroups: state.actorMemoryCollapsedGroups,
    now: state.actorMemoryNow,
  });
  const syncActorMemorySelection = (viewState: ActorMemoryViewState): void => {
    state.actorMemorySelectedOwnerId = viewState.selectedOwnerId;
    state.actorMemorySelectedTraceId = viewState.selectedTraceId;
  };
  const syncSceneSelection = (sceneState: SceneEventsState): void => {
    state.selectedSceneId = sceneState.selectedSceneId;
    state.selectedEpisodeId = sceneState.selectedEpisodeId;
    state.selectedObservationId = sceneState.selectedObservationId;
    state.selectedSceneOwnerId = sceneState.selectedSceneOwnerId;
  };
  const normalizeLibrarySelection = (): void => {
    const selection = selectMemoryLibraryView({
      allFacts: state.facts,
      queryFacts: state.libraryResults,
      query: state.query,
      selectedKinds: state.selectedKinds,
      selectedStatuses: state.selectedStatuses,
      openFilter: state.openFilter,
      sort: state.sort,
      selectedFactId: state.selectedFactId,
      editingFactId: state.editingFactId,
      confirmFactId: state.confirmFactId,
      busyAction: state.busyAction,
      chatLabel: '',
    });
    state.selectedFactId = selection.selected?.id ?? '';
  };

  const toast = (level: ToastNotification['level'], title: string, message: string, code: string): void => {
    notify({ level, title, message, code, durationMs: level === 'error' ? 0 : 3200 });
  };
  const elementFromMarkup = (markup: string): HTMLElement => {
    const shell = document.createElement('div');
    shell.innerHTML = markup;
    return (shell.firstElementChild as HTMLElement | null) ?? shell;
  };
  const initializationOptions = (): MemoryInitializationOptions => ({
    includeHiddenMessageFloors: state.includeHiddenMessageFloors,
  });
  const isChatUnbound = (overview: MemoryUiOverview | undefined = state.overview): boolean =>
    overview?.bound === false || overview?.status === 'unselected';
  const clearActorState = (): void => {
    state.actors = [];
    state.actorAliases = [];
    state.pendingActors = [];
    state.actorCorrectionReviews = [];
    state.selectedActorId = '';
    state.selectedCandidateId = '';
    state.renamingActorId = '';
    state.editingActorTraitsId = '';
    state.actorOperation = '';
    state.actorTraces = [];
    state.actorMemorySelectedOwnerId = '';
    state.actorMemorySelectedTraceId = '';
    state.actorMemoryTab = 'overview';
    state.actorMemoryCollapsedGroups = [];
    state.actorMemoryNow = Date.now();
  };
  const renderSourceReference = (value: string, mode: 'chip' | 'evidence' = 'chip'): string => {
    const label = escapeHtml(formatSourceReference(value));
    const target = parseMessageSourceReference(value);
    if (!target || !navigateToMessage) {
      return mode === 'evidence' ? `<ss-helper-icon name="link" decorative></ss-helper-icon><span>${label}</span>` : `<span>${label}</span>`;
    }
    const messageId = target.messageId === undefined ? '' : ` data-message-id="${escapeHtml(target.messageId)}"`;
    const index = target.index === undefined ? '' : ` data-message-index="${target.index}"`;
    const action = `data-action="jump-to-message"${messageId}${index} aria-label="跳转到${label}" title="点击跳转到对应聊天楼层"`;
    return mode === 'evidence'
      ? `<button class="stx-memory-reference-jump" ${uiButton('neutral', 'xs', true)} type="button" ${action}><ss-helper-icon name="link" decorative></ss-helper-icon></button><span>${label}</span>`
      : `<button class="stx-memory-reference-link" ${uiControl('button', 'neutral')} type="button" ${action}><ss-helper-icon name="link" decorative></ss-helper-icon><span>${label}</span></button>`;
  };
  const renderLibrarySourceReference = (value: string, mode: 'reference' | 'evidence' = 'reference'): string => {
    if (parseMessageSourceReference(value) && navigateToMessage) {
      return renderSourceReference(value, mode === 'evidence' ? 'evidence' : 'chip');
    }
    const label = escapeHtml(formatSourceReference(value));
    const action = `data-action="show-source-info" data-source-ref="${escapeHtml(value)}" aria-label="查看${label}来源说明"`;
    return mode === 'evidence'
      ? `<button class="stx-memory-reference-jump" ${uiButton('neutral', 'xs', true)} type="button" ${action}><ss-helper-icon name="link" decorative></ss-helper-icon></button><span>${label}</span>`
      : `<button class="stx-memory-reference-link" ${uiControl('button', 'neutral')} type="button" ${action}>${label}</button>`;
  };
  const openSceneSource = (sourceRef: string): void => {
    const target = parseMessageSourceReference(sourceRef);
    if (!target || !navigateToMessage) {
      toast('info', '此来源暂不支持跳转', '世界书、角色卡和状态来源仍会保留为可追溯引用。', 'MEMORY_SOURCE_NAVIGATION_UNAVAILABLE');
      return;
    }
    void navigateToMessage(target).catch(() => {
      toast('warning', '无法跳转聊天楼层', '对应消息可能尚未加载或已被删除。', 'MEMORY_MESSAGE_NAVIGATION_UNAVAILABLE');
    });
  };
  const disposeInventoryCardRenderer = (): void => {
    inventoryCardRendererToken += 1;
    inventoryCardRenderer?.dispose();
    inventoryCardRenderer = undefined;
    inventoryCardRendererItemId = '';
    inventoryCardRendererModelKey = '';
    inventoryCardMountingItemId = '';
    inventoryCardMountingModelKey = '';
    inventoryCardHostToRestore = undefined;
    inventoryCardFlipped = false;
  };
  const renderNow = (): void => {
    if (disposed) return;
    const focusSelector = pendingFocusSelector;
    pendingFocusSelector = '';
    const getFactListScroller = (): HTMLElement | null => root.querySelector<HTMLElement>(
      '.stx-memory-library-fact-list > .stx-popup-list',
    ) ?? root.querySelector<HTMLElement>('.stx-memory-fact-list');
    const factListScrollTop = getFactListScroller()?.scrollTop;
    const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    const activeId = active && root.contains(active) && active.id ? active.id : '';
    const activeValue = active && root.contains(active) && ('value' in active) ? active.value : undefined;
    const selectionStart = active?.selectionStart;
    const selectionEnd = active?.selectionEnd;
    graphRenderer?.dispose();
    graphRenderer = undefined;
    const currentInventoryCardHost = root.querySelector<HTMLElement>('[data-inventory-card-three-host]') ?? undefined;
    const activeInventoryCardId = inventoryCardMountingItemId || inventoryCardRendererItemId;
    const preserveInventoryCard = state.page === 'inventory'
      && Boolean(currentInventoryCardHost)
      && Boolean(activeInventoryCardId);
    inventoryCardHostToRestore = preserveInventoryCard ? currentInventoryCardHost : undefined;
    if (!preserveInventoryCard) disposeInventoryCardRenderer();
    sceneRenderer?.dispose();
    sceneRenderer = undefined;
    sceneRendererToken += 1;
    render();
    const restoreFactListScroll = (): void => {
      if (disposed || factListScrollTop === undefined) return;
      const factList = getFactListScroller();
      if (factList) factList.scrollTop = factListScrollTop;
    };
    restoreFactListScroll();
    const restoreFocus = (): void => {
      const target = focusSelector
        ? root.querySelector<HTMLElement>(focusSelector)
        : activeId && document.getElementById(activeId) && root.contains(document.getElementById(activeId))
          ? document.getElementById(activeId) as HTMLInputElement | HTMLTextAreaElement
          : null;
      if (!target) return;
      if (activeValue !== undefined && 'value' in target) {
        target.value = activeValue;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
          target.setSelectionRange(selectionStart ?? activeValue.length, selectionEnd ?? activeValue.length);
        }
      }
      target.focus();
    };
    if (focusSelector || activeId) window.setTimeout(restoreFocus, 0);
    // Native button focus can scroll the list after the click handler completes.
    // Restore once more after that browser-default step so selection never jumps.
    window.setTimeout(restoreFactListScroll, 0);
  };
  /**
   * Direct user actions render synchronously so controls, focus and screen-reader
   * state update in the same interaction turn. Background progress/status bursts
   * use the deferred mode and are merged to one full DOM replacement per frame.
   */
  const rerender = (focusSelector = '', deferred = false): void => {
    if (disposed) return;
    if (focusSelector) pendingFocusSelector = focusSelector;
    if (!deferred) {
      if (renderFrame !== undefined) window.cancelAnimationFrame(renderFrame);
      renderFrame = undefined;
      renderNow();
      return;
    }
    if (renderFrame !== undefined) return;
    renderFrame = window.requestAnimationFrame(() => {
      renderFrame = undefined;
      renderNow();
    });
  };
  const revealActorInspector = (): void => {
    if (!window.matchMedia?.('(max-width: 760px)').matches) return;
    const target = state.actorView === 'pending' ? '#stx-memory-actor-candidate-inspector' : '#stx-memory-actor-inspector';
    window.setTimeout(() => root.querySelector<HTMLElement>(target)?.scrollIntoView?.({ block: 'start' }), 0);
  };
  const revealInventoryInspector = (): void => {
    if (!window.matchMedia?.('(max-width: 900px)').matches) return;
    window.setTimeout(() => {
      const target = root.querySelector<HTMLElement>('#stx-memory-inventory-detail');
      target?.scrollIntoView?.({ block: 'start' });
      target?.focus();
    }, 0);
  };
  const inventoryDetailWidthMax = (): number => {
    const console = root.querySelector<HTMLElement>('.stx-memory-inventory-console');
    const width = console?.clientWidth ?? 0;
    if (width <= 0) return INVENTORY_DETAIL_WIDTH_MAX;
    const compact = width <= 1180;
    const reservedWidth = (compact ? 153 : 166) + (compact ? 330 : 360) + 12;
    return Math.max(INVENTORY_DETAIL_WIDTH_MIN, Math.min(INVENTORY_DETAIL_WIDTH_MAX, width - reservedWidth));
  };
  const syncInventorySplitters = (): void => {
    const console = root.querySelector<HTMLElement>('.stx-memory-inventory-console');
    const preview = root.querySelector<HTMLElement>('.stx-memory-inventory-preview');
    const detailSplitter = root.querySelector<HTMLElement>('[data-inventory-split="detail"]');
    const previewSplitter = root.querySelector<HTMLElement>('[data-inventory-split="preview"]');
    if (!console && !preview && !detailSplitter && !previewSplitter) return;
    const disabled = window.matchMedia?.('(max-width: 900px)').matches ?? false;
    const detailMax = inventoryDetailWidthMax();
    if (!disabled) state.inventoryDetailWidth = Math.max(INVENTORY_DETAIL_WIDTH_MIN, Math.min(detailMax, state.inventoryDetailWidth));
    state.inventoryPreviewHeight = Math.max(INVENTORY_PREVIEW_HEIGHT_MIN, Math.min(INVENTORY_PREVIEW_HEIGHT_MAX, state.inventoryPreviewHeight));
    console?.style.setProperty('--stx-inventory-detail-width', `${state.inventoryDetailWidth}px`);
    preview?.style.setProperty('--stx-inventory-preview-height', `${state.inventoryPreviewHeight}px`);
    if (detailSplitter) {
      detailSplitter.tabIndex = disabled ? -1 : 0;
      detailSplitter.setAttribute('aria-disabled', String(disabled));
      detailSplitter.setAttribute('aria-valuemax', String(detailMax));
      detailSplitter.setAttribute('aria-valuenow', String(Math.round(state.inventoryDetailWidth)));
      detailSplitter.setAttribute('aria-valuetext', `详情宽度 ${Math.round(state.inventoryDetailWidth)} 像素`);
    }
    if (previewSplitter) {
      previewSplitter.tabIndex = disabled ? -1 : 0;
      previewSplitter.setAttribute('aria-disabled', String(disabled));
      previewSplitter.setAttribute('aria-valuenow', String(Math.round(state.inventoryPreviewHeight)));
      previewSplitter.setAttribute('aria-valuetext', `卡片预览高度 ${Math.round(state.inventoryPreviewHeight)} 像素`);
    }
  };
  const setInventorySplitValue = (kind: InventorySplitterKind, requestedValue: number): void => {
    if (!Number.isFinite(requestedValue)) return;
    if (kind === 'detail') {
      state.inventoryDetailWidth = Math.max(INVENTORY_DETAIL_WIDTH_MIN, Math.min(inventoryDetailWidthMax(), requestedValue));
    } else {
      state.inventoryPreviewHeight = Math.max(INVENTORY_PREVIEW_HEIGHT_MIN, Math.min(INVENTORY_PREVIEW_HEIGHT_MAX, requestedValue));
    }
    syncInventorySplitters();
  };
  const updateInventoryResizeFromPointer = (event: PointerEvent): void => {
    if (!inventoryResizeDrag || event.pointerId !== inventoryResizeDrag.pointerId) return;
    if (inventoryResizeDrag.kind === 'detail') {
      const console = root.querySelector<HTMLElement>('.stx-memory-inventory-console');
      const rect = console?.getBoundingClientRect();
      if (rect && rect.width > 0) setInventorySplitValue('detail', rect.right - event.clientX);
    } else {
      const preview = root.querySelector<HTMLElement>('.stx-memory-inventory-preview');
      const rect = preview?.getBoundingClientRect();
      if (rect && rect.height > 0) setInventorySplitValue('preview', event.clientY - rect.top);
    }
  };
  const stopInventoryResize = (event?: PointerEvent): void => {
    const drag = inventoryResizeDrag;
    if (!drag) return;
    drag.splitter.closest<HTMLElement>('.stx-memory-inventory-console, .stx-memory-inventory-detail-scroll')?.classList.remove('is-resizing');
    const pointerId = event?.pointerId ?? drag.pointerId;
    if (drag.splitter.hasPointerCapture?.(pointerId)) drag.splitter.releasePointerCapture?.(pointerId);
    inventoryResizeDrag = undefined;
  };
  const cancelInventorySelectionTransition = (): void => {
    if (inventorySelectionTimer !== undefined) window.clearTimeout(inventorySelectionTimer);
    if (inventoryEnterTimer !== undefined) window.clearTimeout(inventoryEnterTimer);
    inventorySelectionTimer = undefined;
    inventoryEnterTimer = undefined;
    pendingInventorySelectionId = '';
    inventoryEnteringItemId = '';
  };
  const startInventoryCardEnterTransition = (itemId: string, stage: HTMLElement): void => {
    if (inventoryEnterTimer !== undefined) window.clearTimeout(inventoryEnterTimer);
    inventoryEnteringItemId = itemId;
    stage.setAttribute('data-inventory-transition', 'entering');
    inventoryCardRenderer?.enter();
    inventoryEnterTimer = window.setTimeout(() => {
      inventoryEnterTimer = undefined;
      if (inventoryEnteringItemId === itemId) inventoryEnteringItemId = '';
      if (stage.isConnected) stage.setAttribute('data-inventory-transition', 'idle');
    }, INVENTORY_CARD_ENTER_TRANSITION_MS);
  };
  const commitInventorySelection = (itemId: string): void => {
    if (disposed || state.page !== 'inventory' || !state.inventoryItems.some(item => item.id === itemId && item.status !== 'invalid')) return;
    if (inventoryEnterTimer !== undefined) window.clearTimeout(inventoryEnterTimer);
    inventoryEnterTimer = undefined;
    inventoryEnteringItemId = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? '' : itemId;
    state.selectedInventoryItemId = itemId;
    state.inventoryEvents = [];
    rerender();
    revealInventoryInspector();
    if (controller.getInventoryHistory) void controller.getInventoryHistory(itemId).then((events) => {
      if (disposed || state.selectedInventoryItemId !== itemId) return;
      state.inventoryEvents = [...events];
      rerender();
    }).catch((error) => {
      if (!disposed && state.selectedInventoryItemId === itemId) {
        toast('error', '账本读取失败', '无法读取该物品的变动历史。', safeErrorCode(error, 'INTERNAL_ERROR'));
      }
    });
  };
  const requestInventorySelection = (itemId: string): void => {
    const stage = root.querySelector<HTMLElement>('[data-inventory-card-three-host]');
    if (itemId === state.selectedInventoryItemId) {
      if (inventorySelectionTimer !== undefined) {
        window.clearTimeout(inventorySelectionTimer);
        inventorySelectionTimer = undefined;
        pendingInventorySelectionId = '';
        if (stage && !(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)) {
          startInventoryCardEnterTransition(itemId, stage);
        }
      }
      return;
    }
    pendingInventorySelectionId = itemId;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const visualCard = stage?.querySelector('.stx-memory-inventory-card-canvas, .stx-memory-inventory-card-fallback-image');
    if (reduceMotion || !stage || !visualCard) {
      cancelInventorySelectionTransition();
      commitInventorySelection(itemId);
      return;
    }
    if (inventorySelectionTimer !== undefined) return;
    stage.setAttribute('data-inventory-transition', 'leaving');
    inventoryCardRenderer?.leave();
    inventorySelectionTimer = window.setTimeout(() => {
      inventorySelectionTimer = undefined;
      const nextItemId = pendingInventorySelectionId;
      pendingInventorySelectionId = '';
      if (nextItemId) commitInventorySelection(nextItemId);
    }, INVENTORY_CARD_TRANSITION_MS);
  };
  const scheduleProgress = (): void => {
    if (progressTimer) window.clearTimeout(progressTimer);
    progressTimer = undefined;
    // 初始化的前置步骤（读取来源、创建任务）也可能需要一段时间；即使
    // 后端尚未写入 job，也要持续读取进度，让界面能马上反馈“正在提交 LLM”。
    if (!disposed && (['initialize', 'reinitialize'].includes(state.busyAction) || (state.progress && ['queued', 'running', 'repairing', 'paused'].includes(state.progress.status)))) {
      progressTimer = window.setTimeout(() => void updateProgress(), 900);
    }
  };
  const updateProgress = async (): Promise<void> => {
    if (disposed) return;
    const requestId = ++progressRequestId;
    if (progressTimer) window.clearTimeout(progressTimer);
    progressTimer = undefined;
    let progress: MemoryCaptureProgress | undefined;
    try { progress = await controller.getCaptureProgress(); } catch { progress = undefined; }
    if (disposed || requestId !== progressRequestId) return;
    state.progress = progress;
    rerender('', true);
    scheduleProgress();
  };
  const refreshFacts = async (isCurrent: () => boolean = () => !disposed): Promise<boolean> => {
    const query = state.query.trim();
    if (state.overview?.bound === false) {
      if (!isCurrent()) return false;
      state.facts = [];
      state.libraryResults = [];
      state.selectedFactId = '';
      return true;
    }
    const [allFacts, queryFacts, statistics, retainedSelected] = controller.listFactsPage
      ? await Promise.all([
          controller.listFactsPage({ limit: 50, includeTotal: true }),
          query ? controller.listFactsPage({ limit: 50, query }) : Promise.resolve(undefined),
          controller.getLibraryStats?.(),
          state.selectedFactId
              ? controller.listFactsPage({
                limit: 1,
                ...(query ? { query } : {}),
                where: [{ field: 'recordId', op: 'eq', value: state.selectedFactId }],
              }).then(page => page.items[0])
            : Promise.resolve(undefined),
        ]).then(([allPage, queryPage, stats, selected]) => [allPage.items, queryPage?.items, stats, selected] as const)
      : await Promise.all([
          controller.listFacts(),
          query ? controller.listFacts(query) : Promise.resolve(undefined),
        ]).then(([facts, results]) => [facts, results, undefined, undefined] as const);
    if (!isCurrent() || state.query.trim() !== query) return false;
    state.facts = [...allFacts];
    state.libraryResults = [...(queryFacts ?? allFacts)];
    if (retainedSelected && !state.facts.some(fact => fact.id === retainedSelected.id)) state.facts.push(retainedSelected);
    if (retainedSelected && !state.libraryResults.some(fact => fact.id === retainedSelected.id)) state.libraryResults.push(retainedSelected);
    state.libraryStats = statistics;
    normalizeLibrarySelection();
    return true;
  };
  const firstMemoryPage = async <T>(
    resource: MemoryPageResource,
    fallback: () => Promise<readonly T[]>,
    request: Partial<MemoryPageRequest> = {},
  ): Promise<readonly T[]> => controller.loadMemoryPage
    ? (await controller.loadMemoryPage<T>(resource, {
        limit: 50,
        includeTotal: true,
        ...request,
      })).items
    : fallback();
  const auditPageRequest = (
    limit: number,
    options: { cursor?: string; signal?: AbortSignal; includeTotal?: boolean } = {},
  ): MemoryPageRequest => ({
    limit,
    query: state.auditQuery.trim(),
    filter: {
      ...(state.auditStatus === 'all' ? {} : { auditStatus: state.auditStatus }),
      ...(state.auditIssuesOnly ? { auditIssuesOnly: true } : {}),
    },
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.includeTotal ? { includeTotal: true } : {}),
  });
  const usagePageRequest = (
    limit: number,
    options: { cursor?: string; signal?: AbortSignal; includeTotal?: boolean } = {},
  ): MemoryPageRequest => ({
    limit,
    query: state.usageQuery.trim(),
    filter: {
      ...(state.usageModel ? { usageModel: state.usageModel } : {}),
      ...(state.usageCompleteness === 'all' ? {} : { usageCompleteness: state.usageCompleteness }),
    },
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.includeTotal ? { includeTotal: true } : {}),
  });
  const refreshLibrarySearch = async (): Promise<boolean> => {
    const requestId = ++librarySearchRequestId;
    const query = state.query.trim();
    if (state.overview?.bound === false) {
      if (disposed || requestId !== librarySearchRequestId) return false;
      state.libraryResults = [];
      state.selectedFactId = '';
      return true;
    }
    const results = controller.listFactsPage
      ? (await controller.listFactsPage({ limit: 50, ...(query ? { query } : {}), includeTotal: true })).items
      : query
        ? await controller.listFacts(query)
        : state.facts.length ? state.facts : await controller.listFacts();
    if (disposed || requestId !== librarySearchRequestId || state.page !== 'library' || state.query.trim() !== query) return false;
    state.libraryResults = [...results];
    normalizeLibrarySelection();
    return true;
  };
  const acceptOverview = (overview: MemoryUiOverview): void => {
    const chatChanged = state.overview?.chatKey !== overview.chatKey;
    if (chatChanged) {
      storageUsageRequestId += 1;
      auditListRequestId += 1;
      auditSummaryRequestId += 1;
      usageRecallRequestId += 1;
      state.sqlite = undefined;
      state.storageUsageStatus = overview.bound ? 'loading' : 'ready';
      state.audits = [];
      state.usages = [];
      state.auditTotal = 0;
      state.usageTotal = 0;
      state.auditSummaryLoading = false;
      delete state.auditSummary;
      delete state.usageRecallDetail;
    }
    state.overview = state.storageUsageStatus === 'ready' && state.sqlite
      ? {
          ...overview,
          currentChatSizeBytes: state.sqlite.currentChatSizeBytes,
          currentChatUsageRatio: state.sqlite.currentChatUsageRatio,
        }
      : overview;
  };
  const refreshStorageUsage = async (background: boolean): Promise<void> => {
    const chatKey = state.overview?.chatKey;
    if (!state.overview?.bound || !chatKey) {
      state.storageUsageStatus = 'ready';
      return;
    }
    const requestId = ++storageUsageRequestId;
    state.storageUsageStatus = 'loading';
    rerender('', background);
    try {
      const sqlite = await controller.getSqliteStatus({ detailed: true });
      if (disposed || requestId !== storageUsageRequestId || state.overview?.chatKey !== chatKey) return;
      state.sqlite = sqlite;
      state.storageUsageStatus = 'ready';
      state.overview = {
        ...state.overview,
        currentChatSizeBytes: sqlite.currentChatSizeBytes,
        currentChatUsageRatio: sqlite.currentChatUsageRatio,
      };
      rerender('', background);
    } catch (error) {
      if (disposed || requestId !== storageUsageRequestId || state.overview?.chatKey !== chatKey) return;
      state.storageUsageStatus = 'error';
      rerender('', background);
      if (!background) throw error;
    }
  };
  const scheduleStorageUsageRefresh = (delay = 800): void => {
    if (storageUsageTimer) window.clearTimeout(storageUsageTimer);
    storageUsageTimer = window.setTimeout(() => {
      storageUsageTimer = undefined;
      void refreshStorageUsage(true);
    }, delay);
  };
  const loadOverview = async (): Promise<void> => {
    const requestId = ++overviewRequestId;
    const isCurrent = (): boolean => !disposed && requestId === overviewRequestId;
    state.loading = true; state.errorDiagnostic = undefined; rerender();
    try {
      const overview = await controller.getOverview();
      if (!isCurrent()) return;
      acceptOverview(overview);
      if (overview.bound === false) {
        state.facts = [];
        state.libraryResults = [];
      } else {
        if (!await refreshFacts(isCurrent)) return;
        state.recall = await controller.getRecallStatus().catch(() => undefined);
      }
      if (!isCurrent()) return;
      normalizeLibrarySelection();
      state.loading = false; state.errorDiagnostic = undefined; rerender();
      void updateProgress();
      void refreshStorageUsage(true);
    } catch (error) {
      if (!isCurrent()) return;
      const diagnostic = describeMemoryError(error, 'INTERNAL_ERROR', 'workbench-load');
      state.loading = false; state.errorDiagnostic = diagnostic; rerender();
      toast('error', diagnostic.title, diagnostic.reason, diagnostic.reasonCode);
    }
  };
  const refreshLiveSnapshot = async (): Promise<void> => {
    if (disposed) return;
    liveRefreshRequested = true;
    if (liveRefreshRunning) return;
    liveRefreshRunning = true;
    try {
      while (liveRefreshRequested && !disposed) {
        liveRefreshRequested = false;
        try {
          const requestId = ++overviewRequestId;
          const overview = await controller.getOverview();
          if (disposed || requestId !== overviewRequestId) continue;
          const previousChatKey = state.overview?.chatKey;
          acceptOverview(overview);
          if (previousChatKey !== overview.chatKey) scheduleStorageUsageRefresh(0);
          if (isChatUnbound(overview)) {
            clearActorState();
            state.facts = [];
            state.libraryResults = [];
            state.scenes = [];
            state.episodes = [];
            state.observations = [];
            state.profiles = [];
            state.dreams = [];
            state.audits = [];
            state.usages = [];
            state.auditTotal = 0;
            state.usageTotal = 0;
            state.auditSummaryLoading = false;
            delete state.auditSummary;
            state.graph = { nodes: [], edges: [] };
            state.loading = false;
            rerender('', true);
            continue;
          }
          state.loading = false;
          state.errorDiagnostic = undefined;
          await loadPage(state.page, { background: true });
          if (disposed || requestId !== overviewRequestId) continue;
        } catch {
          // 实时刷新失败时保留当前已展示数据；用户主动刷新仍会显示明确错误。
          if (state.loading) {
            state.loading = false;
            rerender('', true);
          }
        }
      }
    } finally {
      liveRefreshRunning = false;
    }
  };
  const refreshAuditSummary = async (chatKey = state.overview?.chatKey): Promise<void> => {
    if (!controller.getAuditSummary || !chatKey || state.overview?.bound === false) return;
    const requestId = ++auditSummaryRequestId;
    state.auditSummaryLoading = true;
    try {
      const summary = await controller.getAuditSummary();
      if (disposed || requestId !== auditSummaryRequestId || state.overview?.chatKey !== chatKey) return;
      state.auditSummary = summary;
      state.auditTotal = summary.auditTotal;
      state.usageTotal = summary.usageTotal;
    } catch {
      // The first safe pages stay usable when the non-blocking aggregate scan fails.
    } finally {
      if (!disposed && requestId === auditSummaryRequestId && state.overview?.chatKey === chatKey) {
        state.auditSummaryLoading = false;
        rerender('', true);
      }
    }
  };
  const loadAuditFirstPages = async (): Promise<{
    audits: MemoryPage<MemoryAuditRecord>;
    usages: MemoryPage<MainChatUsage>;
  }> => {
    const [audits, usages] = await Promise.all([
      controller.listAuditRecordsPage
        ? controller.listAuditRecordsPage(auditPageRequest(50, { includeTotal: true }))
        : controller.listAuditRecords().then(items => ({ items, nextCursor: null, total: items.length })),
      controller.getMainChatUsagePage
        ? controller.getMainChatUsagePage(usagePageRequest(50, { includeTotal: true }))
        : controller.getMainChatUsage().then(items => ({ items, nextCursor: null, total: items.length })),
    ]);
    return { audits, usages };
  };
  const refreshAuditList = async (tab: WorkbenchState['auditTab']): Promise<void> => {
    const requestId = ++auditListRequestId;
    if (tab === 'records' && controller.listAuditRecordsPage) {
      const retained = state.audits.find(record => record.id === state.selectedAuditId);
      const page = await controller.listAuditRecordsPage(auditPageRequest(50, { includeTotal: true }));
      if (disposed || requestId !== auditListRequestId || state.page !== 'audit' || state.auditTab !== tab) return;
      state.audits = [...page.items];
      if (retained && !state.audits.some(record => record.id === retained.id)) state.audits.push(retained);
      if (page.total !== undefined) state.auditTotal = page.total;
    } else if (tab === 'usage' && controller.getMainChatUsagePage) {
      const retained = state.usages.find(usage => usage.id === state.selectedUsageId);
      const page = await controller.getMainChatUsagePage(usagePageRequest(50, { includeTotal: true }));
      if (disposed || requestId !== auditListRequestId || state.page !== 'audit' || state.auditTab !== tab) return;
      state.usages = [...page.items];
      if (retained && !state.usages.some(usage => usage.id === retained.id)) state.usages.push(retained);
      if (page.total !== undefined) state.usageTotal = page.total;
    } else {
      if (disposed || requestId !== auditListRequestId || state.page !== 'audit' || state.auditTab !== tab) return;
    }
    normalizeAuditSelection();
    rerender('', true);
  };
  const scheduleAuditListRefresh = (tab: WorkbenchState['auditTab'], delay = 180): void => {
    if (auditFilterTimer) window.clearTimeout(auditFilterTimer);
    auditFilterTimer = window.setTimeout(() => {
      auditFilterTimer = undefined;
      void refreshAuditList(tab).catch((error) => {
        if (disposed) return;
        const diagnostic = describeMemoryError(error, 'INTERNAL_ERROR', 'workbench-page');
        toast('error', diagnostic.title, diagnostic.reason, diagnostic.reasonCode);
      });
    }, delay);
  };
  const loadPage = async (page: MemoryWorkbenchPage, options: { background?: boolean } = {}): Promise<void> => {
    if (disposed) return;
    const background = options.background === true;
    if (!background) cancelInventorySelectionTransition();
    if (background && page !== state.page) return;
    if (!background) {
      backgroundPageRequestId += 1;
      librarySearchRequestId += 1;
    }
    const requestId = background ? ++backgroundPageRequestId : ++pageRequestId;
    const finishLoad = startMemoryPerformanceSpan(`workbench.page.${page}.${background ? 'refresh' : 'load'}`);
    let loadStatus: 'success' | 'error' | 'aborted' = 'success';
    if (!background) {
      state.page = page;
      state.pageLoading = true;
      state.pageError = undefined;
      rerender();
    }
    const isCurrent = (): boolean => !disposed && (background
      ? requestId === backgroundPageRequestId && state.page === page
      : requestId === pageRequestId);
    try {
      if (page === 'overview') {
        const overview = await controller.getOverview();
        if (!isCurrent()) return;
        state.overview = overview;
      } else if (page === 'actors') {
        if (isChatUnbound()) {
          clearActorState();
        } else {
          const [actors, aliases, pending, reviews] = await Promise.all([
            firstMemoryPage('actors', () => controller.listActors ? controller.listActors() : Promise.resolve([]), { orderBy: { field: 'updatedAt', direction: 'desc' } }),
            firstMemoryPage('actor-aliases', () => controller.listActorAliases ? controller.listActorAliases() : Promise.resolve([]), { orderBy: { field: 'updatedAt', direction: 'desc' } }),
            firstMemoryPage('actor-candidates', () => controller.listPendingActorCandidates ? controller.listPendingActorCandidates() : Promise.resolve([]), { orderBy: { field: 'updatedAt', direction: 'desc' } }),
            controller.listActorCorrectionReviews ? controller.listActorCorrectionReviews() : Promise.resolve([]),
          ]);
          if (!isCurrent()) return;
          state.actors = [...actors];
          state.actorAliases = [...aliases];
          state.pendingActors = [...pending];
          state.actorCorrectionReviews = [...reviews];
          const userActors = state.actors.filter(actor => actor.kind === 'actor');
          if (!state.actors.some(actor => actor.id === state.selectedActorId)) state.selectedActorId = userActors[0]?.id ?? state.actors[0]?.id ?? '';
          if (!state.pendingActors.some(candidate => candidate.localId === state.selectedCandidateId)) state.selectedCandidateId = state.pendingActors[0]?.localId ?? '';
          if (state.pendingActors.length === 0 && state.actorView === 'pending') state.actorView = 'people';
        }
      } else if (page === 'inventory') {
        if (isChatUnbound()) {
          state.inventoryItems = [];
          state.inventoryStates = [];
          state.inventoryEvents = [];
          state.selectedInventoryItemId = '';
        } else {
          const inventory = controller.listInventoryStates
            ? await controller.listInventoryStates()
            : {
                items: await firstMemoryPage<import('../domain').InventoryItem>('inventory-items', () => Promise.resolve([]), { orderBy: { field: 'updatedAt', direction: 'desc' } }),
                states: await firstMemoryPage<import('../domain').InventoryState>('inventory-states', () => Promise.resolve([]), { orderBy: { field: 'updatedAt', direction: 'desc' } }),
              };
          if (!isCurrent()) return;
          state.inventoryItems = [...inventory.items];
          state.inventoryStates = [...inventory.states];
          const currentItemIds = new Set(state.inventoryStates.map(entry => entry.itemId));
          const visibleItems = state.inventoryItems.filter(item => item.status !== 'invalid'
            && (state.inventoryScope === 'catalog' || currentItemIds.has(item.id)));
          if (!visibleItems.some(item => item.id === state.selectedInventoryItemId)) state.selectedInventoryItemId = visibleItems[0]?.id ?? '';
          state.inventoryEvents = state.selectedInventoryItemId && controller.getInventoryHistory
            ? [...await controller.getInventoryHistory(state.selectedInventoryItemId)]
            : [];
          if (!isCurrent()) return;
        }
      } else if (page === 'scenes') {
        const [scenes, episodes, observations, actors, aliases, currentSceneState, transitions, plans, planAudits] = await Promise.all([
          firstMemoryPage('scene-casts', () => controller.listSceneCasts ? controller.listSceneCasts() : Promise.resolve([]), { orderBy: { field: 'floor', direction: 'desc' } }),
          firstMemoryPage('episodes', () => controller.listEpisodes ? controller.listEpisodes() : Promise.resolve([]), { orderBy: { field: 'occurredAt', direction: 'desc' } }),
          firstMemoryPage('observations', () => controller.listObservations ? controller.listObservations() : Promise.resolve([]), { orderBy: { field: 'occurredAt', direction: 'desc' } }),
          firstMemoryPage('actors', () => controller.listActors ? controller.listActors() : Promise.resolve([]), { orderBy: { field: 'updatedAt', direction: 'desc' } }),
          firstMemoryPage('actor-aliases', () => controller.listActorAliases ? controller.listActorAliases() : Promise.resolve([]), { orderBy: { field: 'updatedAt', direction: 'desc' } }),
          controller.getCurrentSceneState ? controller.getCurrentSceneState() : Promise.resolve(null),
          controller.listSceneTransitions ? controller.listSceneTransitions() : Promise.resolve([]),
          controller.listGenerationCastPlans ? controller.listGenerationCastPlans() : Promise.resolve([]),
          controller.listCastPlanAudits ? controller.listCastPlanAudits() : Promise.resolve([]),
        ]);
        if (!isCurrent()) return;
        state.scenes = [...scenes];
        state.episodes = [...episodes];
        state.observations = [...observations];
        state.actors = [...actors];
        state.actorAliases = [...aliases];
        if (currentSceneState) state.currentSceneState = currentSceneState;
        else delete state.currentSceneState;
        state.sceneTransitions = [...transitions];
        state.generationCastPlans = [...plans];
        state.castPlanAudits = [...planAudits];
        const normalized = sceneEventsState();
        normalizeSceneEventsSelection(normalized);
        syncSceneSelection(normalized);
      } else if (page === 'library') {
        if (!await refreshFacts(isCurrent)) return;
        const recall = await controller.getRecallStatus().catch(() => undefined);
        if (!isCurrent()) return;
        state.recall = recall;
      } else if (page === 'actor-memory') {
        if (isChatUnbound()) {
          clearActorState();
          state.observations = [];
          state.facts = [];
          return;
        }
        const [actors, aliases, traces, observations, facts] = await Promise.all([
          firstMemoryPage('actors', () => controller.listActors ? controller.listActors() : Promise.resolve([]), { orderBy: { field: 'updatedAt', direction: 'desc' } }),
          firstMemoryPage('actor-aliases', () => controller.listActorAliases ? controller.listActorAliases() : Promise.resolve([]), { orderBy: { field: 'updatedAt', direction: 'desc' } }),
          firstMemoryPage('memory-traces', () => controller.listActorTraces ? controller.listActorTraces() : Promise.resolve([]), { orderBy: { field: 'updatedAt', direction: 'desc' } }),
          firstMemoryPage('observations', () => controller.listObservations ? controller.listObservations() : Promise.resolve([]), { orderBy: { field: 'occurredAt', direction: 'desc' } }),
          state.overview?.bound === false ? Promise.resolve([]) : controller.listFactsPage ? controller.listFactsPage({ limit: 50 }).then(page => page.items) : controller.listFacts(),
        ]);
        if (!isCurrent()) return;
        state.actors = [...actors];
        state.actorAliases = [...aliases];
        state.actorTraces = [...traces];
        state.observations = [...observations];
        state.facts = [...facts];
        state.actorMemoryNow = Date.now();
        const actorMemory = actorMemoryState();
        normalizeActorMemorySelection(actorMemory);
        syncActorMemorySelection(actorMemory);
      } else if (page === 'profiles') {
        const profiles = [...await firstMemoryPage<Record<string, unknown>>('profile-claims', () => controller.listActorProfiles ? controller.listActorProfiles() : Promise.resolve([]), { orderBy: { field: 'updatedAt', direction: 'desc' } })];
        if (!isCurrent()) return;
        state.profiles = profiles;
      } else if (page === 'dreams') {
        const dreams = [...await firstMemoryPage<Record<string, unknown>>('dream-jobs', () => controller.listActorDreams ? controller.listActorDreams() : Promise.resolve([]), { orderBy: { field: 'updatedAt', direction: 'desc' } })];
        if (!isCurrent()) return;
        state.dreams = dreams;
      } else if (page === 'initialize') {
        const sourceOptions = initializationOptions();
        const [sources, initialization, sqlite] = await Promise.all([
          controller.getInitializationSources(sourceOptions),
          controller.getInitializationState(),
          controller.getSqliteStatus().catch(() => undefined),
        ]);
        if (!isCurrent()) return;
        state.sources = sources;
        state.initialization = initialization;
        if (sqlite) state.sqlite = sqlite;
        state.selectedSourceKinds = state.sources.filter((source) => source.selected).map((source) => source.kind);
        const estimate = await controller.getInitializationEstimate(state.selectedSourceKinds, sourceOptions);
        if (!isCurrent()) return;
        state.estimate = estimate;
        const progress = await controller.getCaptureProgress();
        if (!isCurrent()) return;
        state.progress = progress;
        scheduleProgress();
      } else if (page === 'recall') {
        const recall = await controller.getRecallStatus();
        if (!isCurrent()) return;
        state.recall = recall;
        const [diagnostics, actorRecall, plans, planAudits, coverageLogs, usageLogs] = state.overview?.bound === false
          ? [null, null, [], [], [], []] as const
          : await Promise.all([
            controller.getLastRecall(),
            controller.getActorRecallDiagnostics ? controller.getActorRecallDiagnostics() : Promise.resolve(null),
            firstMemoryPage('generation-cast-plans', () => controller.listGenerationCastPlans ? controller.listGenerationCastPlans() : Promise.resolve([]), { orderBy: { field: 'basedOnFloor', direction: 'desc' } }),
            firstMemoryPage('cast-plan-audits', () => controller.listCastPlanAudits ? controller.listCastPlanAudits() : Promise.resolve([]), { orderBy: { field: 'createdAt', direction: 'desc' } }),
            firstMemoryPage('recall-coverage-logs', () => controller.listRecallCoverageLogs ? controller.listRecallCoverageLogs() : Promise.resolve([]), { orderBy: { field: 'createdAt', direction: 'desc' } }),
            firstMemoryPage('memory-usage-logs', () => controller.listMemoryUsageLogs ? controller.listMemoryUsageLogs() : Promise.resolve([]), { orderBy: { field: 'createdAt', direction: 'desc' } }),
          ]);
        if (!isCurrent()) return;
        state.diagnostics = diagnostics;
        if (actorRecall) state.actorRecallDiagnostics = actorRecall;
        else delete state.actorRecallDiagnostics;
        state.generationCastPlans = [...plans];
        state.castPlanAudits = [...planAudits];
        state.recallCoverageLogs = [...coverageLogs];
        state.memoryUsageLogs = [...usageLogs];
        if (state.overview?.bound === false) {
          state.graph = { nodes: [], edges: [] };
          state.graphStatus = controller.getGraphStatus();
        } else {
          const [graph, facts] = await Promise.all([
            controller.getRelationshipGraph('', 50),
            controller.listFactsPage ? controller.listFactsPage({ limit: 50 }).then(page => page.items) : controller.listFacts(),
          ]);
          if (!isCurrent()) return;
          state.graph = graph;
          state.graphStatus = controller.getGraphStatus();
          state.facts = [...facts];
        }
      } else if (page === 'graph') {
        if (state.overview?.bound === false) {
          state.graph = { nodes: [], edges: [] };
          state.graphStatus = controller.getGraphStatus();
        } else {
          const [graph, facts] = await Promise.all([
            controller.getRelationshipGraph('', 50),
            controller.listFactsPage ? controller.listFactsPage({ limit: 50 }).then(page => page.items) : controller.listFacts(),
          ]);
          if (!isCurrent()) return;
          state.graph = graph;
          state.graphStatus = controller.getGraphStatus();
          state.facts = [...facts];
          if (!graph.edges.some((edge) => edge.id === state.selectedGraphEdgeId)) state.selectedGraphEdgeId = '';
          if (!graph.edges.some((edge) => edge.id === state.selectedGraphEventId && edge.kind === 'event')) state.selectedGraphEventId = '';
          if (!graph.nodes.some((node) => node.id === state.selectedGraphNodeId)) state.selectedGraphNodeId = '';
        }
      } else if (page === 'audit') {
        if (state.overview?.bound === false) {
          state.audits = [];
          state.usages = [];
          state.auditTotal = 0;
          state.usageTotal = 0;
          state.auditSummaryLoading = false;
          delete state.auditSummary;
        } else {
          const { audits, usages } = await loadAuditFirstPages();
          if (!isCurrent()) return;
          state.audits = [...audits.items].sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
          state.usages = [...usages.items].sort((left, right) => right.capturedAt - left.capturedAt || right.id.localeCompare(left.id));
          state.auditTotal = audits.total ?? state.audits.length;
          state.usageTotal = usages.total ?? state.usages.length;
          if (!state.audits.some(record => record.id === state.selectedAuditId)) state.selectedAuditId = state.audits[0]?.id ?? '';
          if (!state.usages.some(usage => usage.id === state.selectedUsageId)) {
            state.selectedUsageId = state.usages[0]?.id ?? '';
            delete state.usageRecallDetail;
          }
          if (!background || !state.auditSummary) void refreshAuditSummary();
        }
      } else if (page === 'data') {
        const sqlite = await controller.getSqliteStatus({ detailed: true });
        if (!isCurrent()) return;
        state.sqlite = sqlite;
        state.storageUsageStatus = 'ready';
        if (state.overview) state.overview = {
          ...state.overview,
          currentChatSizeBytes: sqlite.currentChatSizeBytes,
          currentChatUsageRatio: sqlite.currentChatUsageRatio,
        };
      }
      if (!isCurrent()) return;
    } catch (error) {
      loadStatus = isCurrent() ? 'error' : 'aborted';
      if (!isCurrent()) return;
      if (background) return;
      const diagnostic = describeMemoryError(error, 'INTERNAL_ERROR', 'workbench-page');
      state.pageError = diagnostic;
      toast('error', diagnostic.title, diagnostic.reason, diagnostic.reasonCode);
    } finally {
      if (!isCurrent() && loadStatus === 'success') loadStatus = 'aborted';
      finishLoad(loadStatus);
      if (isCurrent()) {
        if (!background) state.pageLoading = false;
        rerender('', background);
      }
    }
  };
  const refreshAll = async (): Promise<void> => {
    state.busyAction = 'refresh'; rerender();
    try {
      acceptOverview(await controller.getOverview());
      await refreshStorageUsage(false);
      await loadPage(state.page);
      if (state.pageError) state.actionError = state.pageError;
      else {
        state.actionError = undefined;
        toast('success', '已刷新', '当前页面和工作台状态已经重新读取。', 'MEMORY_WORKBENCH_REFRESHED');
      }
    }
    catch (error) { const diagnostic = describeMemoryError(error, 'INTERNAL_ERROR', 'operation'); state.actionError = diagnostic; toast('error', diagnostic.title, diagnostic.reason, diagnostic.reasonCode); }
    finally { state.busyAction = ''; rerender(); }
  };
  const runAction = async (action: string, task: () => Promise<void>, successTitle: string, successMessage: string, successCode: string, reload?: () => Promise<void>): Promise<void> => {
    state.busyAction = action; state.actionError = undefined; rerender();
    try {
      // 先启动任务，再读取进度。这样初始化的首次进度读取不会捕获到
      // “任务尚未开始”的旧快照而覆盖正在等待 LLM 的状态。
      const taskPromise = task();
      if (action === 'initialize' || action === 'reinitialize') {
        toast('info', action === 'reinitialize' ? '重新初始化已提交' : '初始化已提交', action === 'reinitialize' ? '正在取消旧任务、清空派生数据并提交新的初始化。' : '已提交当前聊天内容，正在等待 LLM 返回结果。', action === 'reinitialize' ? 'MEMORY_REINITIALIZE_QUEUED' : 'MEMORY_INITIALIZE_QUEUED');
        // 不等待初始化 Promise 才开始刷新；这里会先显示准备状态，任务写入后
        // 立即切换为“等待 LLM 返回”，并由 scheduleProgress 持续更新。
        void updateProgress();
        scheduleProgress();
      }
      await taskPromise;
      if (reload) await reload();
      state.actionError = undefined;
      toast('success', successTitle, successMessage, successCode);
    }
    catch (error) { const diagnostic = describeMemoryError(error, 'INTERNAL_ERROR', 'operation'); state.actionError = diagnostic; if (['initialize', 'reinitialize'].includes(action) && reload) await reload().catch(() => undefined); toast('error', diagnostic.title, diagnostic.reason, diagnostic.reasonCode); }
    finally { state.busyAction = ''; rerender(); }
  };
  const refreshLibrary = async (): Promise<void> => {
    await runAction(
      'refresh-library',
      async () => {
        state.overview = await controller.getOverview();
        await refreshFacts();
        state.recall = await controller.getRecallStatus().catch(() => undefined);
      },
      '记忆块已刷新',
      '当前聊天的事实、证据和召回状态已经重新读取。',
      'MEMORY_LIBRARY_REFRESHED',
    );
  };
  const refreshInitialization = async (preferredKinds?: readonly string[]): Promise<void> => {
    const sourceOptions = initializationOptions();
    const [overview, initialization, sources, progress, facts, sqlite] = await Promise.all([
      controller.getOverview(),
      controller.getInitializationState(),
      controller.getInitializationSources(sourceOptions),
      controller.getCaptureProgress(),
      controller.listFacts(),
      controller.getSqliteStatus().catch(() => undefined),
    ]);
    acceptOverview(overview);
    state.initialization = initialization;
    state.sources = sources;
    state.progress = progress;
    state.facts = facts;
    if (!state.query.trim()) state.libraryResults = facts;
    if (sqlite) state.sqlite = sqlite;
    const availableKinds = new Set(sources.map((source) => source.kind));
    const nextKinds = preferredKinds?.filter((kind) => availableKinds.has(kind));
    state.selectedSourceKinds = nextKinds?.length
      ? [...nextKinds]
      : sources.filter((source) => source.selected).map((source) => source.kind);
    state.estimate = await controller.getInitializationEstimate(state.selectedSourceKinds, sourceOptions);
  };

  const renderOverview = (): string => {
    const overview = state.overview;
    if (!overview) return renderEmpty('正在读取工作区概览');
    const identity = formatChatIdentity(overview);
    const ready = overview.status === 'ready';
    const working = overview.status === 'working';
    const statusTitle = ready ? '当前聊天已就绪' : working ? '记忆正在整理' : overview.status === 'error' ? '当前聊天需要检查' : '当前聊天尚未就绪';
    const statusCopy = overview.bound
      ? `${identity.label} · ${ready ? '已绑定，记忆可用' : translateOverviewStatus(overview.status)}`
      : '选择聊天并完成初始化后，即可建立和召回记忆。';
    const statusIcon = ready ? 'circle-check' : working ? 'clock' : overview.status === 'error' ? 'triangle-exclamation' : 'circle-info';
    const statusTone = ready ? 'success' : overview.status === 'error' ? 'error' : working ? 'warning' : 'neutral';
    const storage = !overview.bound ? '—' : state.storageUsageStatus === 'loading' ? '计算中' : state.storageUsageStatus === 'error' ? '暂不可用' : formatBytes(overview.currentChatSizeBytes ?? 0);
    const storageRatio = !overview.bound ? '—' : state.storageUsageStatus === 'loading' ? '计算中' : state.storageUsageStatus === 'error' ? '暂不可用' : formatPercent(overview.currentChatUsageRatio ?? 0);
    const lastOrganized = overview.lastOrganizedAt ? formatTime(overview.lastOrganizedAt) : '尚未整理';
    const routeRow = (label: string, icon: string, available: boolean | undefined, detail: string): string => {
      const status = available === undefined ? '读取中' : available ? '可用' : '未配置';
      const tone = available === undefined ? 'neutral' : available ? 'success' : 'error';
      return `<div class="stx-memory-overview-route"><span class="stx-memory-overview-route-icon" aria-hidden="true"><ss-helper-icon name="${icon}" decorative></ss-helper-icon></span><span><strong>${label}</strong><small>${escapeHtml(detail)}</small></span>${renderStatusChip(status, tone)}</div>`;
    };
    const shortcut = (page: MemoryWorkbenchPage, icon: string, label: string): string => `<button class="stx-memory-overview-shortcut" type="button" data-action="navigate" data-page="${page}"><ss-helper-icon name="${icon}" decorative></ss-helper-icon><span>${label}</span></button>`;
    return `<section class="stx-memory-overview" aria-labelledby="stx-memory-overview-title">
      <div class="stx-memory-overview-primary">
        <header class="stx-memory-overview-intro"><span class="stx-memory-kicker">当前工作区</span><h3 id="stx-memory-overview-title">状态简报</h3><p>快速了解当前聊天与记忆就绪情况。</p></header>
        <div class="stx-memory-overview-status"><span class="stx-memory-overview-status-icon is-${statusTone}" aria-hidden="true"><ss-helper-icon name="${statusIcon}" decorative></ss-helper-icon></span><span><strong>${statusTitle}</strong><small>${escapeHtml(statusCopy)}</small></span></div>
        <dl class="stx-memory-overview-metrics">
          <div><dt>记忆数量</dt><dd>${formatNumber(overview.factCount)} <small>条事实</small></dd></div>
          <div><dt>待处理任务</dt><dd>${formatNumber(overview.pendingJobs)} <small>个</small></dd></div>
          <div><dt>本聊天记忆占用</dt><dd>${escapeHtml(storage)}</dd><small>占角色记忆 ${escapeHtml(storageRatio)}</small></div>
          <div><dt>最近整理</dt><dd>${escapeHtml(lastOrganized)}</dd></div>
        </dl>
        <section class="stx-memory-overview-section" aria-labelledby="stx-memory-overview-content-title"><div class="stx-memory-overview-section-heading"><ss-helper-icon name="gear" decorative></ss-helper-icon><span><h4 id="stx-memory-overview-content-title">记忆当前掌握的内容</h4><p>基于现有事实，系统可在对话中理解并组织以下类型的内容。</p></span></div><div class="stx-memory-overview-tags">${shortcut('actor-memory', 'brain', '多角色记忆')}${shortcut('scenes', 'timeline', '场景与事件')}${shortcut('profiles', 'address-card', '画像与关系')}${shortcut('dreams', 'moon', 'Dream')}${shortcut('recall', 'magnifying-glass-chart', '召回与索引')}</div><p class="stx-memory-overview-note"><ss-helper-icon name="circle-info" decorative></ss-helper-icon>世界规则不会自动广播给人物；每个主体只保留有来源支撑的认知。</p></section>
        <section class="stx-memory-overview-section stx-memory-overview-recent" aria-labelledby="stx-memory-overview-recent-title"><h4 id="stx-memory-overview-recent-title">最近整理摘要</h4><p>${overview.lastOrganizedAt ? `上次整理完成于 ${escapeHtml(lastOrganized)}。系统已基于当前内容更新记忆库与索引。` : '当前聊天尚未完成一次整理；可前往独立的初始化页面选择来源并开始捕获。'}</p></section>
      </div>
      <aside class="stx-memory-overview-aside" aria-label="概览操作与能力状态">
        <section class="stx-memory-overview-aside-section"><h4>下一步操作</h4><p>尚未整理时先初始化；已有记忆时可直接浏览或检查召回。</p><div class="stx-memory-overview-actions"><button class="stx-memory-overview-action is-primary" ${uiControl('button', 'primary')} type="button" data-action="navigate" data-page="initialize"><ss-helper-icon name="wand-magic-sparkles" decorative></ss-helper-icon><span>初始化</span><ss-helper-icon name="chevron-right" decorative></ss-helper-icon></button><button class="stx-memory-overview-action" ${uiControl('button', 'neutral')} type="button" data-action="view-library"><ss-helper-icon name="book-open" decorative></ss-helper-icon><span>查看记忆库</span><ss-helper-icon name="chevron-right" decorative></ss-helper-icon></button><button class="stx-memory-overview-action" ${uiControl('button', 'neutral')} type="button" data-action="navigate" data-page="scenes"><ss-helper-icon name="timeline" decorative></ss-helper-icon><span>场景与事件</span><ss-helper-icon name="chevron-right" decorative></ss-helper-icon></button><button class="stx-memory-overview-action" ${uiControl('button', 'neutral')} type="button" data-action="navigate" data-page="recall"><ss-helper-icon name="magnifying-glass-chart" decorative></ss-helper-icon><span>检查召回</span><ss-helper-icon name="chevron-right" decorative></ss-helper-icon></button></div></section>
        <section class="stx-memory-overview-aside-section"><h4>能力与资源状态</h4><p>当前能力可用性一览。</p><div class="stx-memory-overview-routes">${routeRow('大语言模型（LLM）', 'comments', overview.llmAvailable, overview.llmAvailable ? overview.llmModel ?? overview.llmResource ?? '服务已就绪' : 'LLM 服务暂不可用')}${routeRow('向量资源（嵌入）', 'circle-nodes', overview.embedding?.available, overview.embedding?.available ? overview.embedding.model ?? overview.embedding.resourceId ?? '已配置' : overview.embedding?.blockedReason ?? '未配置向量资源')}${routeRow('重排资源（Rerank）', 'arrow-down-wide-short', overview.rerank?.available, overview.rerank?.available ? overview.rerank.model ?? overview.rerank.resourceId ?? '已配置' : overview.rerank?.blockedReason ?? '未配置重排资源')}</div></section>
        <section class="stx-memory-overview-aside-section"><h4>快速入口</h4><p>更多查看与管理选项。</p><div class="stx-memory-overview-quick-grid">${shortcut('actors', 'users', '查看人物与别名')}${shortcut('profiles', 'address-card', '画像与关系')}${shortcut('audit', 'list-check', '查看审计记录')}</div></section>
      </aside>
    </section>`;
  };

  const renderActors = (): string => {
    if (isChatUnbound()) {
      return `<section class="stx-memory-panel stx-memory-actor-unbound"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">Actor Registry</span><h3>人物与别名</h3></div><span>0 个主体</span></div>${renderEmpty('尚未进入聊天', '请先选择一个角色或加入群聊；进入聊天后，这里会显示人物及其别名归属。')}</section>`;
    }
    const actorStatusLabels: Readonly<Record<string, string>> = {
      confirmed: '已确认',
      pending: '待确认',
      unknown: '未识别',
      merged: '已合并',
    };
    const actorKindLabels: Readonly<Record<string, string>> = {
      actor: '人物',
      world: '世界',
      narrator: '旁白',
      player: '玩家',
      unknown: '未知主体',
    };
    const reviewOperationLabels: Readonly<Record<ActorCorrectionReview['operation'], string>> = {
      correction: '确认人物',
      merge: '合并人物',
      split: '拆分人物',
      rename: '人物改名',
      alias: '纠正别名',
    };
    const people = state.actors.filter(actor => actor.kind === 'actor');
    const systemActors = state.actors.filter(actor => actor.kind !== 'actor');
    const normalizeActorOptionText = (value: string): string => value
      .normalize('NFKC')
      .trim()
      .replace(/\s+/g, ' ')
      .toLocaleLowerCase('zh-CN');
    const actorOptionAliases = (actor: import('../domain').MemoryOwner): string[] => {
      const primaryName = (actor.canonicalName ?? actor.displayName).trim() || actor.displayName.trim();
      const primaryKey = normalizeActorOptionText(primaryName);
      const seen = new Set<string>([primaryKey]);
      return [actor.displayName, ...actor.aliases].map((value) => value.trim()).filter((value) => {
        const key = normalizeActorOptionText(value);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    const actorMatchesCandidate = (actor: import('../domain').MemoryOwner, candidate: import('../domain').ActorCandidate): boolean => {
      const candidateKeys = new Set([candidate.displayName, ...(candidate.aliases ?? [])].map(normalizeActorOptionText).filter(Boolean));
      return [actor.canonicalName ?? '', actor.displayName, ...actor.aliases]
        .some((value) => candidateKeys.has(normalizeActorOptionText(value)));
    };
    const renderActorTargetOptions = (candidate: import('../domain').ActorCandidate, selectedId: string): string => {
      const byName = (left: import('../domain').MemoryOwner, right: import('../domain').MemoryOwner): number =>
        (left.canonicalName ?? left.displayName).localeCompare(right.canonicalName ?? right.displayName, 'zh-CN');
      const recommended = people.filter((actor) => actor.id === candidate.ownerRef || actorMatchesCandidate(actor, candidate)).sort(byName);
      const recommendedIds = new Set(recommended.map((actor) => actor.id));
      const confirmed = people.filter((actor) => !recommendedIds.has(actor.id) && actor.status === 'confirmed').sort(byName);
      const pending = people.filter((actor) => !recommendedIds.has(actor.id) && actor.status !== 'confirmed').sort(byName);
      const renderOptions = (actors: readonly import('../domain').MemoryOwner[]): string => actors.map((actor) => {
        const aliases = actorOptionAliases(actor);
        const description = [
          actorStatusLabels[actor.status] ?? actor.status,
          `置信度 ${Math.round(actor.confidence * 100)}%`,
          ...(aliases.length ? [`别名：${aliases.slice(0, 3).join('、')}`] : []),
        ].join(' · ');
        return `<option value="${escapeHtml(actor.id)}" data-ss-helper-description="${escapeHtml(description)}" ${actor.id === selectedId ? 'selected' : ''}>${escapeHtml((actor.canonicalName ?? actor.displayName).trim() || actor.displayName)}</option>`;
      }).join('');
      return [
        recommended.length ? `<optgroup label="推荐匹配">${renderOptions(recommended)}</optgroup>` : '',
        confirmed.length ? `<optgroup label="已确认人物">${renderOptions(confirmed)}</optgroup>` : '',
        pending.length ? `<optgroup label="待确认人物">${renderOptions(pending)}</optgroup>` : '',
      ].join('');
    };
    const normalizedQuery = state.actorQuery.trim().toLocaleLowerCase('zh-CN');
    const matchesActor = (actor: import('../domain').MemoryOwner): boolean =>
      (!state.actorStatus || actor.status === state.actorStatus)
      && (!normalizedQuery || [actor.displayName, actor.canonicalName ?? '', ...actor.aliases].some(value => value.toLocaleLowerCase('zh-CN').includes(normalizedQuery)));
    const visiblePeople = people.filter(matchesActor);
    const visibleSystemActors = systemActors.filter(matchesActor);
    const visibleActorIds = new Set([...visiblePeople, ...visibleSystemActors].map(actor => actor.id));
    const selectedActor = state.actors.find(actor => actor.id === state.selectedActorId && visibleActorIds.has(actor.id))
      ?? visiblePeople[0]
      ?? visibleSystemActors[0];
    const selectedCandidate = state.pendingActors.find(candidate => candidate.localId === state.selectedCandidateId)
      ?? state.pendingActors[0];
    const aliasesForSelected = selectedActor
      ? state.actorAliases.filter(alias => alias.ownerId === selectedActor.id).sort((left, right) => right.updatedAt - left.updatedAt)
      : [];
    const aliasCount = state.actorAliases.length || people.reduce((total, actor) => total + actor.aliases.length, 0);
    const busy = Boolean(state.busyAction);
    const renderActorRows = (actors: readonly import('../domain').MemoryOwner[], label: string): string => {
      if (actors.length === 0) return '';
      return `<div class="stx-memory-actor-group"><div class="stx-memory-actor-group-title"><span>${label}</span><small>${actors.length}</small></div>${actors.map(actor => {
        const aliasSummary = actor.aliases.length ? actor.aliases.slice(0, 3).join('、') : '暂无别名';
        const statusLabel = actor.kind === 'actor' ? actorStatusLabels[actor.status] ?? actor.status : actorKindLabels[actor.kind] ?? actor.kind;
        return `<button class="stx-memory-actor-row" ${uiControl('button', 'neutral')} type="button" data-action="select-actor" data-owner-id="${escapeHtml(actor.id)}" aria-selected="${actor.id === selectedActor?.id}"><span class="stx-memory-actor-symbol" aria-hidden="true"><ss-helper-icon name="${actor.kind === 'actor' ? 'user' : actor.kind === 'world' ? 'globe' : actor.kind === 'narrator' ? 'microphone-lines' : actor.kind === 'player' ? 'user-pen' : 'circle-question'}" decorative></ss-helper-icon></span><span class="stx-memory-actor-row-copy"><strong>${escapeHtml(actor.displayName)}</strong><small>${escapeHtml(aliasSummary)}</small></span><span class="stx-memory-actor-row-meta">${renderStatusChip(statusLabel, actor.status === 'confirmed' ? 'success' : actor.status === 'unknown' ? 'warning' : 'neutral')}<small>${Math.round(actor.confidence * 100)}%</small></span></button>`;
      }).join('')}</div>`;
    };
    const actorList = visiblePeople.length || visibleSystemActors.length
      ? `${renderActorRows(visiblePeople, '人物')}${renderActorRows(visibleSystemActors, '系统主体 · 只读')}`
      : renderEmpty('没有匹配的人物', state.actorQuery || state.actorStatus ? '请尝试清除搜索词或状态筛选。' : '完成一次 Capture 后，明确人物会出现在这里。');
    const pendingList = state.pendingActors.length
      ? state.pendingActors.map(candidate => `<button class="stx-memory-actor-row stx-memory-candidate-row" ${uiControl('button', 'neutral')} type="button" data-action="select-candidate" data-candidate-id="${escapeHtml(candidate.localId)}" aria-selected="${candidate.localId === selectedCandidate?.localId}"><span class="stx-memory-actor-symbol is-pending" aria-hidden="true"><ss-helper-icon name="user-clock" decorative></ss-helper-icon></span><span class="stx-memory-actor-row-copy"><strong>${escapeHtml(candidate.displayName)}</strong><small>${candidate.sourceRefs.length} 条来源${candidate.aliases?.length ? ` · ${candidate.aliases.length} 个候选别名` : ''}</small></span><span class="stx-memory-actor-row-meta">${renderStatusChip('待确认', 'warning')}<small>${Math.round(candidate.confidence * 100)}%</small></span></button>`).join('')
      : renderEmpty('没有待确认项', '当前人物和别名归属已处理完成。');
    const recentReviews = [...state.actorCorrectionReviews].sort((left, right) => right.createdAt - left.createdAt).slice(0, 6);
    const renderReviews = (): string => recentReviews.length
      ? `<div class="stx-memory-actor-review-list">${recentReviews.map(review => `<article class="stx-memory-actor-review"><span class="stx-memory-actor-review-icon" aria-hidden="true"><ss-helper-icon name="${review.status === 'undone' ? 'rotate-left' : 'clock-rotate-left'}" decorative></ss-helper-icon></span><span><strong>${escapeHtml(reviewOperationLabels[review.operation] ?? review.operation)}</strong><small>${escapeHtml(formatTime(review.createdAt))}</small></span>${renderStatusChip(review.status === 'undone' ? '已撤销' : '已应用', review.status === 'undone' ? 'neutral' : 'success')}${controller.resolveActorCorrection && review.status === 'applied' ? `<button ${uiControl('button', 'neutral')} type="button" data-action="undo-actor-correction" data-audit-id="${escapeHtml(review.id)}" ${busy ? 'disabled' : ''}>撤销</button>` : ''}</article>`).join('')}</div>`
      : '<p class="stx-memory-muted">还没有人物纠正记录。</p>';
    const actorDetail = !selectedActor ? renderEmpty('选择一个人物', '右侧会显示名称、别名来源和可执行操作。') : (() => {
      const editable = selectedActor.kind === 'actor';
      const renaming = state.renamingActorId === selectedActor.id;
      const editingTraits = state.editingActorTraitsId === selectedActor.id;
      const memoryTraits = { ...DEFAULT_MEMORY_TRAITS, ...(selectedActor.memoryTraits ?? {}) };
      const halfLifeDays = Math.max(1, Math.round(memoryTraits.halfLifeMs / (1000 * 60 * 60 * 24)));
      const traitBars = {
        halfLife: Math.min(100, Math.max(4, Math.round((halfLifeDays / 45) * 100))),
        rehearsal: Math.min(100, Math.max(4, Math.round((memoryTraits.rehearsalGain / .1) * 100))),
        emotional: Math.min(100, Math.max(4, Math.round((memoryTraits.emotionalGain / .2) * 100))),
        interference: Math.min(100, Math.max(4, Math.round((memoryTraits.interference / .2) * 100))),
      };
      const aliasRows = aliasesForSelected.length
        ? aliasesForSelected.map(alias => {
          const canonical = alias.value.trim().toLocaleLowerCase('zh-CN') === (selectedActor.canonicalName ?? selectedActor.displayName).trim().toLocaleLowerCase('zh-CN');
          return `<article class="stx-memory-alias-row"><div><strong>${escapeHtml(alias.value)}</strong>${renderStatusChip(actorStatusLabels[alias.status] ?? alias.status, alias.status === 'confirmed' ? 'success' : 'warning')}${canonical ? '<span class="stx-memory-actor-canonical-chip">规范名称</span>' : ''}</div><div class="stx-memory-alias-meta"><span>置信度 ${Math.round(alias.confidence * 100)}%</span><span>${renderSourceReference(alias.sourceRef)}</span></div>${editable && controller.correctActorAlias && people.length > 1 ? `<button ${uiControl('button', 'neutral')} type="button" data-action="open-actor-operation" data-operation="alias" data-alias-id="${escapeHtml(alias.id)}" ${busy ? 'disabled' : ''}>纠正归属</button>` : ''}</article>`;
        }).join('')
        : selectedActor.aliases.length
          ? selectedActor.aliases.map(alias => `<article class="stx-memory-alias-row"><div><strong>${escapeHtml(alias)}</strong>${renderStatusChip('已确认', 'success')}</div><p class="stx-memory-muted">暂无可展示的别名来源记录。</p></article>`).join('')
          : renderEmpty('暂无别名', '后续 Capture 发现新称呼后会显示在这里。');
      return `<div class="stx-memory-actor-detail-head"><div><span class="stx-memory-kicker">${editable ? '人物主档' : '系统主体'}</span><div class="stx-memory-actor-headline"><h3>${escapeHtml(selectedActor.displayName)}</h3>${renderStatusChip(editable ? actorStatusLabels[selectedActor.status] ?? selectedActor.status : actorKindLabels[selectedActor.kind] ?? selectedActor.kind, selectedActor.status === 'confirmed' ? 'success' : 'warning')}</div><p>${editable ? '维护规范名称、别名归属与该人物的记忆特性。' : '系统主体用于标记叙事范围，不支持人物操作。'}</p></div></div>
        ${renaming ? `<section class="stx-memory-actor-edit" aria-labelledby="stx-memory-actor-rename-label"><label id="stx-memory-actor-rename-label" for="stx-memory-actor-rename-input">新的规范名称</label><input id="stx-memory-actor-rename-input" ${uiControl('input')} data-actor-input="rename" value="${escapeHtml(state.actorRenameValue)}" autocomplete="off"><div class="stx-memory-actions"><button ${uiControl('button', 'primary')} type="button" data-action="save-actor-rename" ${!state.actorRenameValue.trim() || busy ? 'disabled' : ''}>保存名称</button><button ${uiControl('button', 'neutral')} type="button" data-action="cancel-actor-rename">取消</button></div></section>` : editable ? `<div class="stx-memory-actor-primary-actions"><button id="stx-memory-actor-rename-trigger" ${uiControl('button', 'primary')} type="button" data-action="start-actor-rename" ${busy ? 'disabled' : ''}><ss-helper-icon name="pen" decorative></ss-helper-icon>改名</button><button id="stx-memory-actor-split-trigger" ${uiControl('button', 'neutral')} type="button" data-action="open-actor-operation" data-operation="split" ${busy || selectedActor.aliases.length === 0 ? 'disabled' : ''}><ss-helper-icon name="code-branch" decorative></ss-helper-icon>拆分人物</button><button id="stx-memory-actor-merge-trigger" ${uiControl('button', 'danger')} type="button" data-action="open-actor-operation" data-operation="merge" ${busy || people.length < 2 ? 'disabled' : ''}><ss-helper-icon name="object-group" decorative></ss-helper-icon>合并人物</button></div>` : ''}
        <dl class="stx-memory-actor-summary"><div><dt>规范名称</dt><dd>${escapeHtml(selectedActor.canonicalName ?? selectedActor.displayName)}</dd></div><div><dt>别名数量</dt><dd>${formatNumber(selectedActor.aliases.length)}</dd></div><div><dt>置信度</dt><dd>${Math.round(selectedActor.confidence * 100)}%</dd></div></dl>
        <section class="stx-memory-actor-section" aria-labelledby="stx-memory-aliases-title"><div class="stx-memory-section-heading"><div><h4 id="stx-memory-aliases-title">别名与来源</h4><p>每个称呼都保留发现来源与确认状态</p></div><span>${selectedActor.aliases.length} 个</span></div><div class="stx-memory-alias-list">${aliasRows}</div></section>
        ${editable ? `<section class="stx-memory-actor-section stx-memory-actor-traits"><div class="stx-memory-section-heading"><div><h4>人物记忆特性</h4><p>影响这个人物记忆的衰减、复述强化、情绪强化和干扰程度</p></div>${editingTraits ? '' : `<button ${uiControl('button', 'neutral')} type="button" data-action="start-actor-traits" ${busy ? 'disabled' : ''}>编辑特性</button>`}</div>${editingTraits ? `<div class="stx-memory-actor-traits-form"><label><span>记忆半衰期</span><span class="stx-memory-trait-input"><input ${uiControl('input')} type="number" min="1" step="1" value="${halfLifeDays}" data-actor-trait="half-life-days"><em>天</em></span><small>时间越长，未复述的记忆衰减越慢。</small></label><label><span>复述增益</span><input ${uiControl('input')} type="number" min="0" step="0.01" value="${memoryTraits.rehearsalGain}" data-actor-trait="rehearsal-gain"><small>成功召回后增加的记忆强度。</small></label><label><span>情绪增益</span><input ${uiControl('input')} type="number" min="0" step="0.01" value="${memoryTraits.emotionalGain}" data-actor-trait="emotional-gain"><small>高情绪显著内容获得的额外强化。</small></label><label><span>干扰惩罚</span><input ${uiControl('input')} type="number" min="0" step="0.01" value="${memoryTraits.interference}" data-actor-trait="interference"><small>相似或冲突记忆造成的固定削弱。</small></label></div><div class="stx-memory-actions"><button ${uiControl('button', 'primary')} type="button" data-action="save-actor-traits" ${busy ? 'disabled' : ''}>保存特性</button><button ${uiControl('button', 'neutral')} type="button" data-action="cancel-actor-traits">取消</button></div>` : `<dl class="stx-memory-actor-trait-grid"><div><span><dt>记忆半衰期</dt><dd>${halfLifeDays} 天</dd></span><i><b style="--stx-memory-trait-value:${traitBars.halfLife}%"></b></i></div><div><span><dt>复述增益</dt><dd>${memoryTraits.rehearsalGain.toFixed(2)}</dd></span><i><b style="--stx-memory-trait-value:${traitBars.rehearsal}%"></b></i></div><div><span><dt>情绪增益</dt><dd>${memoryTraits.emotionalGain.toFixed(2)}</dd></span><i><b style="--stx-memory-trait-value:${traitBars.emotional}%"></b></i></div><div><span><dt>干扰惩罚</dt><dd>${memoryTraits.interference.toFixed(2)}</dd></span><i><b style="--stx-memory-trait-value:${traitBars.interference}%"></b></i></div></dl>`}</section>` : ''}
        <section class="stx-memory-actor-section"><div class="stx-memory-section-heading"><div><h4>发现方式</h4><p>用于解释人物是如何进入当前注册表的</p></div></div><div class="stx-memory-reference-list">${selectedActor.discoverySources.map(source => `<span>${escapeHtml(source)}</span>`).join('') || '<span>未记录</span>'}</div></section>
        <details class="stx-memory-actor-technical"><summary>查看技术信息</summary><dl><div><dt>人物 ID</dt><dd>${escapeHtml(selectedActor.id)}</dd></div><div><dt>更新时间</dt><dd>${escapeHtml(formatTime(selectedActor.updatedAt))}</dd></div></dl></details>`;
    })();
    const candidateDetail = !selectedCandidate ? renderEmpty('没有待确认项', '当前人物归属已经处理完成。') : (() => {
      const suggestedTargetId = people.find((actor) => actorMatchesCandidate(actor, selectedCandidate))?.id;
      const targetId = state.candidateTargetOwnerId || selectedCandidate.ownerRef || suggestedTargetId || people[0]?.id || '';
      const canonicalName = state.candidateCanonicalName;
      const canConfirm = controller.confirmActorCandidate
        && !busy
        && (state.candidateResolutionMode === 'existing' ? Boolean(targetId) : Boolean(canonicalName.trim()));
      return `<div class="stx-memory-actor-detail-head"><div><span class="stx-memory-kicker">待确认归属</span><h3>${escapeHtml(selectedCandidate.displayName)}</h3><p>核对证据后，将这个称呼归入人物主档。</p></div>${renderStatusChip(`${Math.round(selectedCandidate.confidence * 100)}%`, 'warning')}</div>
        ${selectedCandidate.aliases?.length ? `<section class="stx-memory-actor-section"><h4>候选别名</h4><div class="stx-memory-reference-list">${selectedCandidate.aliases.map(alias => `<span>${escapeHtml(alias)}</span>`).join('')}</div></section>` : ''}
        <section class="stx-memory-actor-section"><div class="stx-memory-section-heading"><div><h4>来源证据</h4><p>确认前请核对上下文是否指向同一个人物</p></div><span>${selectedCandidate.sourceRefs.length} 条</span></div><div class="stx-memory-evidence-list">${selectedCandidate.evidenceExcerpts.length ? selectedCandidate.evidenceExcerpts.map((excerpt, index) => `<blockquote class="stx-memory-evidence"><p>${escapeHtml(excerpt)}</p><footer>${renderSourceReference(selectedCandidate.sourceRefs[index] ?? selectedCandidate.sourceRefs[0] ?? '', 'evidence')}</footer></blockquote>`).join('') : selectedCandidate.sourceRefs.map(source => `<div class="stx-memory-reference-list">${renderSourceReference(source)}</div>`).join('') || '<p class="stx-memory-muted">暂无可展示的证据片段。</p>'}</div></section>
        <section class="stx-memory-candidate-resolution" aria-labelledby="stx-memory-candidate-resolution-title"><h4 id="stx-memory-candidate-resolution-title">确认方式</h4><div class="stx-memory-actor-mode-switch" ${uiControl('segmented')} role="group" aria-label="候选人物确认方式"><button ${uiControl('button', 'neutral')} type="button" data-action="candidate-resolution-mode" data-mode="existing" aria-pressed="${state.candidateResolutionMode === 'existing'}">归入已有人物</button><button ${uiControl('button', 'neutral')} type="button" data-action="candidate-resolution-mode" data-mode="new" aria-pressed="${state.candidateResolutionMode === 'new'}">创建新人物</button></div>${state.candidateResolutionMode === 'existing' ? `<label for="stx-memory-candidate-target">目标人物</label><select id="stx-memory-candidate-target" ${uiControl('select')} data-actor-select="candidate-target" ${people.length === 0 ? 'disabled' : ''}>${renderActorTargetOptions(selectedCandidate, targetId)}</select>${people.length === 0 ? '<p class="stx-memory-inline-alert" role="alert">当前没有可归入的人物，请选择“创建新人物”。</p>' : ''}` : `<label for="stx-memory-candidate-name">规范名称</label><input id="stx-memory-candidate-name" ${uiControl('input')} data-actor-input="candidate-name" value="${escapeHtml(canonicalName)}" autocomplete="off">`}<button class="stx-memory-candidate-confirm" ${uiButton('primary', 'md')} type="button" data-action="confirm-actor" data-candidate-id="${escapeHtml(selectedCandidate.localId)}" ${canConfirm ? '' : 'disabled'}>确认归属</button></section>`;
    })();
    const selectedAlias = state.actorAliases.find(alias => alias.id === state.actorOperationAliasId);
    const operationOwner = state.actors.find(actor => actor.id === state.selectedActorId) ?? selectedActor;
    const operationTargets = people.filter(actor => actor.id !== operationOwner?.id);
    const defaultTargetId = state.actorOperationTargetId || operationTargets[0]?.id || '';
    const splitAliases = operationOwner
      ? state.actorAliases.filter(alias => alias.ownerId === operationOwner.id).map(alias => ({ id: alias.value, label: alias.value }))
      : [];
    const fallbackSplitAliases = operationOwner?.aliases.map(alias => ({ id: alias, label: alias })) ?? [];
    const availableSplitAliases = splitAliases.length ? splitAliases : fallbackSplitAliases;
    const selectedSplitAlias = state.actorOperationAliasId || availableSplitAliases[0]?.id || '';
    const operationTitle = state.actorOperation === 'merge' ? '合并人物'
      : state.actorOperation === 'split' ? '拆分人物'
        : state.actorOperation === 'alias' ? '纠正别名归属' : '';
    const drawer = !state.actorOperation || !operationOwner ? '' : `<div class="stx-memory-actor-drawer-layer"><button class="stx-memory-drawer-backdrop" type="button" data-action="close-actor-operation" aria-label="关闭${operationTitle}"></button><aside class="stx-memory-actor-drawer" role="${state.actorOperation === 'merge' ? 'alertdialog' : 'dialog'}" aria-modal="true" aria-labelledby="stx-memory-actor-operation-title" aria-describedby="stx-memory-actor-operation-description"><header><div><span class="stx-memory-kicker">人物主档操作</span><h3 id="stx-memory-actor-operation-title">${operationTitle}</h3></div><button ${uiButton('neutral', 'sm', true)} type="button" data-action="close-actor-operation" aria-label="关闭"><ss-helper-icon name="xmark" decorative></ss-helper-icon></button></header><div class="stx-memory-drawer-body">${state.actorOperation === 'merge' ? `<div class="stx-memory-drawer-warning"><ss-helper-icon name="triangle-exclamation" decorative></ss-helper-icon><span><strong id="stx-memory-actor-operation-description">将“${escapeHtml(operationOwner.displayName)}”合并到目标人物</strong><small>源人物会从人物列表中消失，它的别名与关联记忆会迁入目标人物。此操作可从最近人物操作中撤销。</small></span></div><label for="stx-memory-actor-operation-target">合并到</label><select id="stx-memory-actor-operation-target" ${uiControl('select')} data-actor-select="operation-target">${operationTargets.map(actor => `<option value="${escapeHtml(actor.id)}" ${actor.id === defaultTargetId ? 'selected' : ''}>${escapeHtml(actor.displayName)}</option>`).join('')}</select>` : state.actorOperation === 'split' ? `<p id="stx-memory-actor-operation-description" class="stx-memory-muted">从“${escapeHtml(operationOwner.displayName)}”移出一个现有别名，并用它建立独立人物。</p><label for="stx-memory-actor-operation-alias">要拆分的别名</label><select id="stx-memory-actor-operation-alias" ${uiControl('select')} data-actor-select="operation-alias">${availableSplitAliases.map(alias => `<option value="${escapeHtml(alias.id)}" ${alias.id === selectedSplitAlias ? 'selected' : ''}>${escapeHtml(alias.label)}</option>`).join('')}</select><label for="stx-memory-actor-operation-name">新人物名称</label><input id="stx-memory-actor-operation-name" ${uiControl('input')} data-actor-input="operation-name" value="${escapeHtml(state.actorOperationName || selectedSplitAlias)}" autocomplete="off">` : `<p id="stx-memory-actor-operation-description" class="stx-memory-muted">把别名“${escapeHtml(selectedAlias?.value ?? '')}”移动到正确的人物主档。</p><label for="stx-memory-actor-operation-target">目标人物</label><select id="stx-memory-actor-operation-target" ${uiControl('select')} data-actor-select="operation-target">${operationTargets.map(actor => `<option value="${escapeHtml(actor.id)}" ${actor.id === defaultTargetId ? 'selected' : ''}>${escapeHtml(actor.displayName)}</option>`).join('')}</select>`}</div><footer><button ${uiButton('neutral', 'md')} type="button" data-action="close-actor-operation">取消</button><button ${uiControl('button', state.actorOperation === 'merge' ? 'danger' : 'primary')} type="button" data-action="confirm-actor-operation" ${busy || (state.actorOperation === 'merge' && !defaultTargetId) || (state.actorOperation === 'split' && (!selectedSplitAlias || !(state.actorOperationName || selectedSplitAlias).trim())) || (state.actorOperation === 'alias' && (!selectedAlias || !defaultTargetId)) ? 'disabled' : ''}>${state.actorOperation === 'merge' ? '确认合并' : state.actorOperation === 'split' ? '确认拆分' : '确认纠正'}</button></footer></aside></div>`;
    const asideSuggestedTargetId = selectedCandidate ? people.find((actor) => actorMatchesCandidate(actor, selectedCandidate))?.id : undefined;
    const asideTargetId = state.candidateTargetOwnerId || selectedCandidate?.ownerRef || asideSuggestedTargetId || people[0]?.id || '';
    const asideCanConfirm = Boolean(controller.confirmActorCandidate)
      && !busy
      && Boolean(selectedCandidate)
      && (state.candidateResolutionMode === 'existing' ? Boolean(asideTargetId) : Boolean(state.candidateCanonicalName.trim()));
    const candidateQueue = state.pendingActors.filter(candidate => candidate.localId !== selectedCandidate?.localId).slice(0, 3);
    const candidateAside = selectedCandidate ? `<article class="stx-memory-actor-candidate-card">
      <div class="stx-memory-actor-candidate-head"><div><h4>${escapeHtml(selectedCandidate.displayName)}</h4><p>通用称呼 · 无安全自动归属</p></div>${renderStatusChip(`${Math.round(selectedCandidate.confidence * 100)}%`, 'warning')}</div>
      <blockquote class="stx-memory-actor-candidate-quote">${escapeHtml(selectedCandidate.evidenceExcerpts[0] ?? '暂无证据摘录')}<small>${selectedCandidate.sourceRefs[0] ? `${renderSourceReference(selectedCandidate.sourceRefs[0], 'evidence')}` : '暂无来源'}</small></blockquote>
      <div class="stx-memory-reference-list">${selectedCandidate.aliases?.map(alias => `<span>候选别名：${escapeHtml(alias)}</span>`).join('') ?? ''}<span>来源 ${selectedCandidate.sourceRefs.length} 条</span></div>
      <div class="stx-memory-actor-mode-switch" ${uiControl('segmented')} role="group" aria-label="候选人物确认方式"><button ${uiControl('button', 'neutral')} type="button" data-action="candidate-resolution-mode" data-mode="existing" aria-pressed="${state.candidateResolutionMode === 'existing'}">归入已有人物</button><button ${uiControl('button', 'neutral')} type="button" data-action="candidate-resolution-mode" data-mode="new" aria-pressed="${state.candidateResolutionMode === 'new'}">创建新人物</button></div>
      ${state.candidateResolutionMode === 'existing' ? `<label for="stx-memory-candidate-aside-target">目标人物</label><select id="stx-memory-candidate-aside-target" ${uiControl('select')} data-actor-select="candidate-target" ${people.length === 0 ? 'disabled' : ''}>${renderActorTargetOptions(selectedCandidate, asideTargetId)}</select>` : `<label for="stx-memory-candidate-aside-name">规范名称</label><input id="stx-memory-candidate-aside-name" ${uiControl('input')} data-actor-input="candidate-name" value="${escapeHtml(state.candidateCanonicalName)}" autocomplete="off">`}
      <button class="stx-memory-candidate-confirm" ${uiButton('primary', 'md')} type="button" data-action="confirm-actor" data-candidate-id="${escapeHtml(selectedCandidate.localId)}" ${asideCanConfirm ? '' : 'disabled'}>确认归属</button>
    </article>` : '<p class="stx-memory-muted">当前没有待确认人物。</p>';
    const actorAside = `<aside class="stx-memory-actor-aside" aria-label="待确认归属与最近人物操作"><section class="stx-memory-actor-aside-section"><div class="stx-memory-actor-side-head"><h4>待确认归属</h4><span>${state.pendingActors.length} 条</span></div>${candidateAside}${candidateQueue.length ? `<div class="stx-memory-actor-candidate-queue">${candidateQueue.map(candidate => `<button ${uiControl('button', 'neutral')} type="button" data-action="select-candidate-aside" data-candidate-id="${escapeHtml(candidate.localId)}"><span><strong>${escapeHtml(candidate.displayName)}</strong><small>${candidate.sourceRefs.length} 条证据 · ${Math.round(candidate.confidence * 100)}%</small></span>${renderStatusChip('待确认', 'warning')}</button>`).join('')}</div>` : ''}</section><section class="stx-memory-actor-aside-section"><div class="stx-memory-actor-side-head"><h4>最近人物操作</h4><span>可撤销</span></div>${renderReviews()}</section></aside>`;
    return `<div class="stx-memory-actor-shell">
      <div class="stx-memory-actor-toolbar"><label class="stx-memory-search-wrap" for="stx-memory-actor-query"><span class="stx-memory-sr-only">搜索人物或别名</span><ss-helper-icon name="magnifying-glass" decorative></ss-helper-icon><input id="stx-memory-actor-query" ${uiControl('input')} data-actor-input="query" value="${escapeHtml(state.actorQuery)}" placeholder="搜索人物名称或别名"></label><label class="stx-memory-control-wrap"><span class="stx-memory-sr-only">人物状态</span><select ${uiControl('select')} aria-label="人物状态" data-actor-select="status"><option value="" ${state.actorStatus === '' ? 'selected' : ''}>全部状态</option><option value="confirmed" ${state.actorStatus === 'confirmed' ? 'selected' : ''}>已确认</option><option value="pending" ${state.actorStatus === 'pending' ? 'selected' : ''}>待确认</option><option value="unknown" ${state.actorStatus === 'unknown' ? 'selected' : ''}>未识别</option></select></label><div class="stx-memory-actor-counts" aria-label="人物注册表统计"><span><strong>${people.length}</strong> 人物</span><span><strong>${aliasCount}</strong> 别名</span><button ${uiControl('button', state.pendingActors.length ? 'primary' : 'neutral')} type="button" data-action="actor-tab" data-view="pending"><strong>${state.pendingActors.length}</strong> 待确认</button></div></div>
      <div class="stx-memory-actor-grid"><section class="stx-memory-actor-list-panel" aria-label="人物与待确认列表"><div class="stx-memory-actor-tabs" role="tablist" aria-label="人物注册表视图"><button ${uiButton('neutral', 'sm')} type="button" role="tab" data-action="actor-tab" data-view="people" aria-selected="${state.actorView === 'people'}">人物 <span>${people.length + systemActors.length}</span></button><button ${uiButton('neutral', 'sm')} type="button" role="tab" data-action="actor-tab" data-view="pending" aria-selected="${state.actorView === 'pending'}">待确认 <span>${state.pendingActors.length}</span></button></div><div class="stx-memory-actor-list" role="tabpanel">${state.actorView === 'people' ? actorList : pendingList}</div></section><section class="stx-memory-actor-inspector" id="${state.actorView === 'people' ? 'stx-memory-actor-inspector' : 'stx-memory-actor-candidate-inspector'}" aria-label="${state.actorView === 'people' ? '人物详情' : '待确认人物详情'}" tabindex="-1">${state.actorView === 'people' ? actorDetail : candidateDetail}</section>${actorAside}</div>${drawer}
    </div>`;
  };

  const renderScenes = (): string => {
    const sceneState = sceneEventsState();
    const markup = renderSceneEventsPage(sceneState);
    syncSceneSelection(sceneState);
    return markup;
  };

  const renderActorMemory = (): string => {
    const viewState = actorMemoryState();
    normalizeActorMemorySelection(viewState);
    syncActorMemorySelection(viewState);
    return renderActorMemoryPage(viewState, {
      formatTime,
      renderSourceReference: renderLibrarySourceReference,
    });
  };

  const renderProfiles = (): string => state.profiles.length === 0
    ? renderEmpty('暂无画像增量', '画像必须满足证据重复门槛或高情绪显著度，并且每条声明都引用 Trace。')
    : `<section class="stx-memory-panel stx-memory-cold-page-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">L0–L5</span><h3>画像与关系</h3></div><span>${formatNumber(state.profiles.length)} 条声明</span></div><div class="stx-memory-reference-list" data-memory-page-list="profiles">${state.profiles.map(profile => `<article class="stx-memory-evidence"><strong>${escapeHtml(String(profile.ownerId ?? profile.fromOwnerId ?? '主体'))}</strong><p>${escapeHtml(String(profile.claim ?? ''))}</p><small>引用：${escapeHtml(Array.isArray(profile.supportingTraceIds) ? profile.supportingTraceIds.join('、') : '无')}</small></article>`).join('')}</div></section>`;

  const renderDreams = (): string => state.dreams.length === 0
    ? renderEmpty('暂无 Dream 任务', 'Dream 默认按主体自动排队；也可以从后续操作入口手动 dry-run。')
    : `<section class="stx-memory-panel stx-memory-cold-page-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">Dream Audit</span><h3>巩固任务</h3></div><span>${formatNumber(state.dreams.length)} 个任务</span></div><div class="stx-memory-reference-list" data-memory-page-list="dreams">${state.dreams.map(job => `<article class="stx-memory-evidence"><strong>${escapeHtml(String(job.ownerId ?? '主体'))}</strong>${renderStatusChip(String(job.status ?? 'queued'), job.status === 'applied' ? 'success' : job.status === 'failed' ? 'error' : 'neutral')}<p>阶段：${escapeHtml(String(job.phase ?? 'gather'))}</p><small>任务：${escapeHtml(String(job.id ?? ''))}</small>${controller.runActorDream && job.id ? `<button ${uiControl('button', 'neutral')} type="button" data-action="dream-dry-run" data-job-id="${escapeHtml(String(job.id))}">dry-run 预览</button>` : ''}</article>`).join('')}</div></section>`;

  const renderInventory = (): string => {
    const categoryLabels = INVENTORY_CATEGORY_LABELS;
    const categoryIcons: Readonly<Record<import('../domain').InventoryItemCategory | 'all', string>> = {
      all: 'boxes-stacked', weapon: 'sword', medicine: 'kit-medical', food: 'burger', armor: 'shield', special: 'gem', core: 'atom', material: 'cubes-stacked', other: 'cube',
    };
    const operationLabels: Readonly<Record<import('../domain').InventoryOperation, string>> = { set: '设置数量', increase: '增加', decrease: '减少', remove: '标记移除' };
    const reasonLabels: Readonly<Record<import('../domain').InventoryReason, string>> = { acquire: '获得', consume: '消耗', discard: '丢弃', lose: '损失', recount: '盘点', manual_correction: '人工修正', other: '其他' };
    const measureLabels: Readonly<Record<import('../domain').InventoryMeasureKind, string>> = { quantity: '数量', coverage_days: '可维持天数' };
    const precisionLabels: Readonly<Record<import('../domain').InventoryPrecision, string>> = { exact: '精确记录', approximate: '近似记录', unknown: '数量未知' };
    const formatState = (item: import('../domain').InventoryState): string => {
      if (item.availability === 'absent') return '已移除';
      if (item.amount === undefined || item.precision === 'unknown') return `清单中已确认存在，原文未注明数量${item.stateNote ? ` · ${item.stateNote}` : ''}`;
      return `${item.precision === 'approximate' ? '约 ' : ''}${item.amount}${item.unit || ''}${item.stateNote ? ` · ${item.stateNote}` : ''}`;
    };
    const formatStateAmount = (item: import('../domain').InventoryState | undefined): string => {
      if (!item) return '未记录';
      if (item.availability === 'absent') return '已移除';
      if (item.amount === undefined || item.precision === 'unknown') return '数量未知';
      return `${item.precision === 'approximate' ? '约 ' : ''}${item.amount}${item.unit || ''}`;
    };
    const isUnknownConfirmation = (event: import('../domain').InventoryEvent): boolean => event.operation === 'set'
      && event.precision === 'unknown'
      && event.beforeAmount === undefined
      && event.afterAmount === undefined;
    const formatEventChange = (event: import('../domain').InventoryEvent, firstUnknownConfirmation: boolean): string => {
      if (isUnknownConfirmation(event)) return firstUnknownConfirmation
        ? '确认物品存在，原文未注明数量'
        : '再次确认物品仍存在，原文仍未注明数量';
      if (event.operation === 'remove') return event.beforeAmount === undefined
        ? '标记为不再持有'
        : `从 ${event.beforeAmount}${event.unit} 标记为不再持有`;
      if (event.afterAmount === undefined) return '当前数量未注明';
      const after = `${event.precision === 'approximate' ? '约 ' : ''}${event.afterAmount}${event.unit}`;
      if (event.beforeAmount === undefined) return `首次记录：${after}`;
      if (event.beforeAmount === event.afterAmount) return `再次盘点：数量仍为 ${after}`;
      const action = event.operation === 'increase' ? '增加' : event.operation === 'decrease' ? '减少' : '盘点更新';
      return `${action}：${event.beforeAmount}${event.unit} → ${after}`;
    };
    const inventoryModel = selectInventoryWorkbenchModel({
      items: state.inventoryItems,
      states: state.inventoryStates,
      scope: state.inventoryScope,
      category: state.inventoryCategory,
      query: state.inventoryQuery,
      sort: state.inventorySort,
      selectedId: state.selectedInventoryItemId,
    });
    const { statesByItem, heldItems: currentHeldItems, precisionCounts, maxCoverageDays: maxCoverage, scopeItems, categoryCounts, filteredItems: filtered } = inventoryModel;
    state.selectedInventoryItemId = inventoryModel.selectedId;
    const newestState = (itemId: string, measureKind?: import('../domain').InventoryMeasureKind): import('../domain').InventoryState | undefined => latestInventoryState(statesByItem, itemId, measureKind);
    const renderStateSource = (inventoryState: import('../domain').InventoryState | undefined, emptyLabel = '暂无来源证据', compact = false): string => {
      const compactEmptyLabel = compact ? '无来源' : emptyLabel;
      if (!inventoryState) return `<span class="stx-memory-inventory-source is-muted">${escapeHtml(compactEmptyLabel)}</span>`;
      const sourceRef = inventoryState.sourceRefs[inventoryState.sourceRefs.length - 1];
      if (!sourceRef) return `<span class="stx-memory-inventory-source is-muted">${escapeHtml(compactEmptyLabel)}</span>`;
      const target = parseMessageSourceReference(sourceRef);
      const floor = inventoryState.updatedAtFloor ?? target?.index;
      const label = floor === undefined ? `来源：${formatSourceReference(sourceRef)}` : `来源：第 ${floor} 层`;
      const visibleLabel = compact && floor !== undefined ? `第 ${floor} 层` : label;
      if (!target || !navigateToMessage) return `<span class="stx-memory-inventory-source">${escapeHtml(visibleLabel)}</span>`;
      const messageId = target.messageId === undefined ? '' : ` data-message-id="${escapeHtml(target.messageId)}"`;
      const index = target.index === undefined ? '' : ` data-message-index="${target.index}"`;
      return `<button class="stx-memory-inventory-source" ${uiButton('neutral', 'xs')} type="button" data-action="jump-to-message"${messageId}${index} aria-label="跳转到${escapeHtml(label)}" title="点击跳转并高亮对应聊天楼层"><ss-helper-icon name="link" decorative></ss-helper-icon>${escapeHtml(visibleLabel)}</button>`;
    };
    const selected = filtered.find(item => item.id === state.selectedInventoryItemId);
    const selectedStates = selected ? [...(statesByItem.get(selected.id) ?? [])].sort((left, right) => right.updatedAt - left.updatedAt) : [];
    const itemRows = filtered.length === 0 ? renderEmpty('没有匹配的物品', '可调整搜索、分类或显示范围。') : filtered.map((item) => {
      const primary = newestState(item.id, 'quantity') ?? newestState(item.id);
      const selectedItem = item.id === state.selectedInventoryItemId;
      const statusLabel = primary?.availability === 'absent' ? '已移除' : primary?.precision === 'exact' ? '精确' : primary?.precision === 'approximate' ? '近似' : primary ? '未知' : '未记录';
      return `<article class="stx-memory-inventory-item" data-category="${item.category}" data-selected="${selectedItem}" data-view="${state.inventoryView}"><button ${uiControl('button', 'neutral')} type="button" class="stx-memory-inventory-item-main" data-action="inventory-select" data-item-id="${escapeHtml(item.id)}" aria-pressed="${selectedItem}"><span class="stx-memory-inventory-item-top"><small>${escapeHtml(categoryLabels[item.category])}</small><span>${escapeHtml(statusLabel)}</span></span><span class="stx-memory-inventory-item-body"><span class="stx-memory-inventory-item-icon" aria-hidden="true"><ss-helper-icon name="${categoryIcons[item.category]}" decorative></ss-helper-icon></span><span><strong>${escapeHtml(item.canonicalName)}</strong><b>${escapeHtml(formatStateAmount(primary))}</b></span></span><span class="stx-memory-inventory-item-foot"><small>${escapeHtml(categoryLabels[item.category])}</small><span>${Math.round(item.confidence * 100)}%</span></span></button></article>`;
    }).join('');
    const history = [...state.inventoryEvents].sort((left, right) => right.recordedAt - left.recordedAt);
    const firstUnknownConfirmationId = history.filter(isUnknownConfirmation).at(-1)?.id;
    const historyRows = history.length === 0 ? renderEmpty('暂无变动记录', '设置、增加、减少和移除都会写入追加式账本。') : history.map(event => `<article class="stx-memory-inventory-event"><header><strong>${escapeHtml(operationLabels[event.operation])}</strong><time>${escapeHtml(formatTime(event.recordedAt))}</time></header><p>${escapeHtml(formatEventChange(event, event.id === firstUnknownConfirmationId))}</p><footer><span>${escapeHtml(reasonLabels[event.reason])} · ${event.origin === 'automatic' ? '自动提取' : event.origin === 'manual' ? '人工操作' : '导入'}</span>${event.sourceRef ? renderLibrarySourceReference(event.sourceRef, 'evidence') : ''}</footer>${event.evidenceExcerpt ? `<blockquote>${escapeHtml(event.evidenceExcerpt)}</blockquote>` : ''}</article>`).join('');
    const currentStates = selectedStates.length === 0
      ? `<p class="stx-memory-inventory-no-state">当前聊天无状态</p>`
      : `<div class="stx-memory-inventory-current-states">${selectedStates.map(inventoryState => `<article><small>${escapeHtml(measureLabels[inventoryState.measureKind])} · ${escapeHtml(precisionLabels[inventoryState.precision])}</small><strong>${escapeHtml(formatState(inventoryState))}</strong>${renderStateSource(inventoryState, '暂无来源证据', true)}</article>`).join('')}</div>`;
    const selectedPrimary = selected ? newestState(selected.id, 'quantity') ?? newestState(selected.id) : undefined;
    const selectedSourceRef = selectedPrimary?.sourceRefs[selectedPrimary.sourceRefs.length - 1];
    const selectedFloor = selectedPrimary?.updatedAtFloor ?? (selectedSourceRef ? parseMessageSourceReference(selectedSourceRef)?.index : undefined);
    inventoryCardModel = selected ? {
      id: selected.id,
      name: selected.canonicalName,
      category: selected.category,
      categoryLabel: categoryLabels[selected.category],
      aliases: selected.aliases,
      confidence: selected.confidence,
      amountLabel: formatStateAmount(selectedPrimary),
      precisionLabel: selectedPrimary ? precisionLabels[selectedPrimary.precision] : '尚未记录',
      ...(selectedPrimary?.stateNote ? { stateNote: selectedPrimary.stateNote } : {}),
      ...(selectedFloor === undefined ? {} : { sourceFloor: selectedFloor }),
    } : undefined;
    const inventorySplitDisabled = window.matchMedia?.('(max-width: 900px)').matches ?? false;
    const inventorySplitTabIndex = inventorySplitDisabled ? -1 : 0;
    const inventoryCardTransition = selected && inventoryEnteringItemId === selected.id ? 'entering' : 'idle';
    const metricCards = [
      ['当前持有', formatNumber(currentHeldItems.length), 'boxes-stacked'],
      ['精确数量', formatNumber(precisionCounts.exact), 'circle-check'],
      ['近似数量', formatNumber(precisionCounts.approximate), 'wave-square'],
      ['数量未知', formatNumber(precisionCounts.unknown), 'circle-question'],
      ['最长维持', maxCoverage === undefined ? '未记录' : `${maxCoverage.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 天`, 'calendar-range'],
    ];
    const categoryButtons = ([
      ['', '全部物资', '按当前显示范围', scopeItems.length, 'all'],
      ...Object.entries(categoryLabels).map(([value, label]) => [value, label, value === 'weapon' ? '攻击与防卫' : value === 'medicine' ? '医疗与恢复' : value === 'food' ? '食物与饮水' : value === 'armor' ? '防护装备' : value === 'special' ? '特殊物品' : value === 'core' ? '能源核心' : value === 'material' ? '制作材料' : '未分类', categoryCounts[value as import('../domain').InventoryItemCategory], value]),
    ] as Array<[string, string, string, number, import('../domain').InventoryItemCategory | 'all']>)
      .map(([value, label, description, count, iconKey]) => `<button ${uiControl('button', 'neutral')} type="button" class="stx-memory-inventory-category" data-action="inventory-set-category" data-category="${value}" aria-pressed="${state.inventoryCategory === value}"><span aria-hidden="true"><ss-helper-icon name="${categoryIcons[iconKey]}" decorative></ss-helper-icon></span><span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(description)}</small></span><b>${formatNumber(count)}</b></button>`).join('');
    const createPanel = state.inventoryCreateOpen ? `<section class="stx-memory-inventory-create-panel" role="region" aria-labelledby="stx-memory-inventory-create-title"><div><h3 id="stx-memory-inventory-create-title">新增物品</h3><p>创建工作区级物品身份，随后再写入当前聊天数量。</p></div><div class="stx-memory-inventory-create-fields"><label><span>规范名称</span><input id="stx-memory-inventory-new-name" ${uiControl('input')} data-inventory-input="new-name" value="${escapeHtml(state.inventoryNewName)}" maxlength="120" autocomplete="off" placeholder="例如：瓶装水"></label><label><span>别名</span><input ${uiControl('input')} data-inventory-input="new-aliases" value="${escapeHtml(state.inventoryNewAliases)}" maxlength="300" autocomplete="off" placeholder="使用逗号分隔"></label><label><span>分类</span><select ${uiControl('select')} data-inventory-select="new-category">${Object.entries(categoryLabels).map(([value, label]) => `<option value="${value}" ${state.inventoryNewCategory === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></label></div><div class="stx-memory-inventory-create-actions"><button ${uiButton('primary', 'sm')} type="button" data-action="inventory-create" ${!controller.createInventoryItem || !state.inventoryNewName.trim() || Boolean(state.busyAction) ? 'disabled' : ''}>保存物品</button><button ${uiButton('neutral', 'sm')} type="button" data-action="inventory-create-cancel">取消</button></div></section>` : '';
    const detail = selected ? `<div class="stx-memory-inventory-detail-scroll">
      <section class="stx-memory-inventory-preview" data-category="${selected.category}" style="--stx-inventory-preview-height:${state.inventoryPreviewHeight}px" aria-label="三维物品卡牌预览"><div class="stx-memory-inventory-preview-stage" data-inventory-card-three-host data-inventory-transition="${inventoryCardTransition}" role="img" aria-label="${escapeHtml(selected.canonicalName)}三维卡牌预览"><div class="stx-memory-inventory-preview-loading" role="status">正在载入三维卡牌…</div></div><div class="stx-memory-inventory-preview-foot"><span>移动旋转 · 点击翻面</span><button ${uiButton('neutral', 'xs')} type="button" data-action="inventory-card-flip" aria-pressed="false" aria-label="显示卡牌背面" disabled><ss-helper-icon name="rotate" decorative></ss-helper-icon><span>翻面</span></button></div></section>
      <div class="stx-memory-inventory-splitter is-horizontal" role="separator" tabindex="${inventorySplitTabIndex}" aria-label="调整卡片预览与属性区域高度" aria-orientation="horizontal" aria-disabled="${inventorySplitDisabled}" aria-valuemin="${INVENTORY_PREVIEW_HEIGHT_MIN}" aria-valuemax="${INVENTORY_PREVIEW_HEIGHT_MAX}" aria-valuenow="${Math.round(state.inventoryPreviewHeight)}" aria-valuetext="卡片预览高度 ${Math.round(state.inventoryPreviewHeight)} 像素" data-inventory-split="preview"></div>
      <section class="stx-memory-inventory-hero" data-category="${selected.category}"><span class="stx-memory-inventory-hero-icon" aria-hidden="true"><ss-helper-icon name="${categoryIcons[selected.category]}" decorative></ss-helper-icon></span><span><small>分类 · ${escapeHtml(categoryLabels[selected.category])}</small><h3>${escapeHtml(selected.canonicalName)}</h3><span class="stx-memory-inventory-tags">${renderStatusChip(selected.status === 'confirmed' ? '已确认' : '待确认', selected.status === 'confirmed' ? 'success' : 'warning')}${selectedFloor === undefined ? renderStatusChip('暂无来源', 'neutral') : renderStatusChip(`来源 第 ${selectedFloor} 层`, 'neutral')}</span></span><button ${uiButton('danger', 'xs')} type="button" data-action="inventory-invalidate" ${!controller.invalidateInventoryItem || !popupUi || Boolean(state.busyAction) ? 'disabled' : ''}>作废错误物品</button></section>
      <section class="stx-memory-inventory-section"><div class="stx-memory-inventory-section-title"><span><h4>别名与识别</h4><p>工作区级物品身份</p></span><small>${selected.aliases.length} 个别名</small></div><div class="stx-memory-inventory-aliases">${selected.aliases.length ? selected.aliases.map(alias => `<span>${escapeHtml(alias)}</span>`).join('') : '<span>暂无别名</span>'}</div><div class="stx-memory-inventory-confidence"><span>可信度</span><progress ${uiControl('progress')} max="1" value="${Math.max(0, Math.min(1, selected.confidence))}">${formatPercent(selected.confidence)}</progress><strong>${formatPercent(selected.confidence)}</strong></div></section>
      <section class="stx-memory-inventory-section"><div class="stx-memory-inventory-section-title"><span><h4>当前状态</h4><p>属于当前聊天分支</p></span><small>${selectedStates.length} 条</small></div>${currentStates}</section>
      <section class="stx-memory-inventory-section"><div class="stx-memory-inventory-section-title"><span><h4>写入账本</h4><p>服务端计算变更前后数量</p></span><small>REV ${Math.max(0, ...selectedStates.map(entry => entry.revision))}</small></div><div class="stx-memory-inventory-operations" ${uiControl('segmented')} role="group" aria-label="库存操作">${(Object.entries(operationLabels) as Array<[import('../domain').InventoryOperation, string]>).map(([value, label]) => `<button ${uiControl('button', 'neutral')} type="button" data-action="inventory-set-operation" data-operation="${value}" aria-pressed="${state.inventoryCommandOperation === value}" ${state.inventoryCommandMeasure === 'coverage_days' && (value === 'increase' || value === 'decrease') ? 'disabled' : ''}>${escapeHtml(label.replace('数量', ''))}</button>`).join('')}</div><div class="stx-memory-inventory-command"><label><span>计量类型</span><select ${uiControl('select')} data-inventory-select="measure"><option value="quantity" ${state.inventoryCommandMeasure === 'quantity' ? 'selected' : ''}>数量</option><option value="coverage_days" ${state.inventoryCommandMeasure === 'coverage_days' ? 'selected' : ''}>可维持天数</option></select></label><label><span>数值</span><input ${uiControl('input')} data-inventory-input="amount" type="number" min="0" step="any" value="${escapeHtml(state.inventoryCommandAmount)}" ${state.inventoryCommandOperation === 'remove' || state.inventoryCommandPrecision === 'unknown' ? 'disabled' : ''}></label><label><span>单位</span><input ${uiControl('input')} data-inventory-input="unit" value="${escapeHtml(state.inventoryCommandUnit)}" maxlength="20" ${state.inventoryCommandMeasure === 'coverage_days' ? 'disabled' : ''}></label><label><span>精确度</span><select ${uiControl('select')} data-inventory-select="precision"><option value="exact" ${state.inventoryCommandPrecision === 'exact' ? 'selected' : ''}>精确</option><option value="approximate" ${state.inventoryCommandPrecision === 'approximate' ? 'selected' : ''} ${state.inventoryCommandOperation === 'increase' || state.inventoryCommandOperation === 'decrease' ? 'disabled' : ''}>近似</option><option value="unknown" ${state.inventoryCommandPrecision === 'unknown' ? 'selected' : ''} ${state.inventoryCommandOperation !== 'set' ? 'disabled' : ''}>未知</option></select></label><button ${uiButton('primary', 'md')} type="button" data-action="inventory-command" ${!controller.applyInventoryCommand || Boolean(state.busyAction) ? 'disabled' : ''}>确认写入账本</button></div></section>
      <section class="stx-memory-inventory-section stx-memory-inventory-history"><div class="stx-memory-inventory-section-title"><span><h4>完整变动历史</h4><p>追加式账本，不覆盖旧记录</p></span><small>${history.length} 条</small></div>${historyRows}</section>
    </div>` : renderEmpty('选择一个物品', '从物品网格选择后，可查看三维卡牌、当前状态、来源和完整账本。');
    return `<div class="stx-memory-inventory-shell">${createPanel}<section class="stx-memory-inventory-metrics" aria-label="当前聊天物品统计">${metricCards.map(([label, value, icon]) => `<article><span aria-hidden="true"><ss-helper-icon name="${icon}" decorative></ss-helper-icon></span><span><small>${label}</small><strong>${value}</strong></span></article>`).join('')}</section><div class="stx-memory-inventory-console" style="--stx-inventory-detail-width:${state.inventoryDetailWidth}px">
      <aside class="stx-memory-inventory-categories" aria-label="物资分类"><header><div><h3>物资分类</h3><p>按当前显示范围</p></div><span>${formatNumber(scopeItems.length)} 项</span></header><div class="stx-memory-inventory-scope" ${uiControl('segmented')} role="group" aria-label="物品显示范围"><button ${uiControl('button', 'neutral')} type="button" data-action="inventory-set-scope" data-scope="current" aria-pressed="${state.inventoryScope === 'current'}">当前聊天</button><button ${uiControl('button', 'neutral')} type="button" data-action="inventory-set-scope" data-scope="catalog" aria-pressed="${state.inventoryScope === 'catalog'}">全部目录</button></div><div class="stx-memory-inventory-category-list">${categoryButtons}</div><footer>已移除项目保留在当前聊天范围中，便于追溯完整账本。</footer></aside>
      <section class="stx-memory-inventory-browser" aria-label="${state.inventoryScope === 'current' ? '当前聊天物品' : '全部物品目录'}"><header><div><h3>${state.inventoryScope === 'current' ? '当前聊天物品' : '全部物品目录'}</h3><p>选择物品以查看详细状态与账本</p></div><span>${formatNumber(filtered.length)} 项</span></header><div class="stx-memory-inventory-toolbar"><label class="stx-memory-inventory-search"><span class="stx-memory-sr-only">搜索物品或别名</span><ss-helper-icon name="magnifying-glass" decorative></ss-helper-icon><input id="stx-memory-inventory-query" ${uiControl('input')} type="search" data-inventory-input="query" value="${escapeHtml(state.inventoryQuery)}" placeholder="搜索名称或别名"></label><label><span class="stx-memory-sr-only">物品排序</span><select ${uiControl('select')} data-inventory-select="sort" aria-label="物品排序"><option value="recent" ${state.inventorySort === 'recent' ? 'selected' : ''}>最近更新</option><option value="name" ${state.inventorySort === 'name' ? 'selected' : ''}>名称</option><option value="amount" ${state.inventorySort === 'amount' ? 'selected' : ''}>数值</option><option value="confidence" ${state.inventorySort === 'confidence' ? 'selected' : ''}>置信度</option></select></label><div class="stx-memory-inventory-view-switch" ${uiControl('segmented')} role="group" aria-label="物品列表布局"><button ${uiButton('neutral', 'sm', true)} type="button" data-action="inventory-set-view" data-view="grid" aria-pressed="${state.inventoryView === 'grid'}" aria-label="网格视图"><ss-helper-icon name="table-cells-large" decorative></ss-helper-icon></button><button ${uiButton('neutral', 'sm', true)} type="button" data-action="inventory-set-view" data-view="list" aria-pressed="${state.inventoryView === 'list'}" aria-label="列表视图"><ss-helper-icon name="list" decorative></ss-helper-icon></button></div></div><div class="stx-memory-inventory-grid" data-inventory-view="${state.inventoryView}" aria-label="物品与资源列表">${itemRows}</div></section>
      <div class="stx-memory-inventory-splitter is-vertical" role="separator" tabindex="${inventorySplitTabIndex}" aria-label="调整物品列表与详情区域宽度" aria-orientation="vertical" aria-disabled="${inventorySplitDisabled}" aria-valuemin="${INVENTORY_DETAIL_WIDTH_MIN}" aria-valuemax="${INVENTORY_DETAIL_WIDTH_MAX}" aria-valuenow="${Math.round(state.inventoryDetailWidth)}" aria-valuetext="详情宽度 ${Math.round(state.inventoryDetailWidth)} 像素" data-inventory-split="detail"></div>
      <section class="stx-memory-inventory-detail" id="stx-memory-inventory-detail" aria-label="物品详情" tabindex="-1"><header><h3>物品详情</h3><span>${selected ? `${filtered.findIndex(item => item.id === selected.id) + 1} / ${filtered.length}` : `0 / ${filtered.length}`}</span></header>${detail}</section>
    </div></div>`;
  };

  const renderLibrary = (): string => renderMemoryLibraryView({
    allFacts: state.facts,
    queryFacts: state.libraryResults,
    query: state.query,
    selectedKinds: state.selectedKinds,
    selectedStatuses: state.selectedStatuses,
    openFilter: state.openFilter,
    sort: state.sort,
    selectedFactId: state.selectedFactId,
    editingFactId: state.editingFactId,
    confirmFactId: state.confirmFactId,
    busyAction: state.busyAction,
    chatLabel: formatChatIdentity(state.overview).label,
    virtualized: Boolean(popupUi && controller.listFactsPage),
    totalCount: state.overview?.factCount ?? state.facts.length,
    ...(state.libraryStats ? { statistics: state.libraryStats } : {}),
  }, {
    kindLabels: FACT_KIND_LABELS,
    statusLabels: FACT_STATUS_LABELS,
    formatTime: value => formatTime(value),
    formatSource: renderLibrarySourceReference,
    translateRecordStatus,
  });
  const renderInitialize = (): string => {
    const settings = controller.getSettings();
    const initialization = state.initialization;
    const progress = state.progress;
    const storageUnavailable = state.sqlite?.connected === false
      || state.overview?.status === 'error'
      || state.overview?.failure?.reasonCode === 'WORKSPACE_DATABASE_UNAVAILABLE';
    const visibilityNote = state.includeHiddenMessageFloors ? '包含隐藏楼层' : '仅处理可见楼层';
    const summaryNote = settings.summaryBatchMode === 'chars'
      ? `按每批最多 ${formatNumber(settings.summaryBatchChars)} 字符拆分，批次间保留 ${formatNumber(settings.summaryOverlapFloors)} 层前置上下文；自动触发仍按 ${formatNumber(settings.summaryIntervalFloors)} 层间隔判断。`
      : `按每批 ${formatNumber(settings.summaryBatchFloors)} 层用户/助手正文拆分（${visibilityNote}），批次间保留 ${formatNumber(settings.summaryOverlapFloors)} 层前置上下文；自动触发间隔为 ${formatNumber(settings.summaryIntervalFloors)} 层。`;
    const llmDetails = state.overview && !state.overview.llmAvailable ? readSafeLlmErrorDetails(state.overview) : undefined;
    const chatIdentity = formatChatIdentity(state.overview);
    return renderInitializationView({
      chatLabel: chatIdentity.label,
      chatBound: state.overview?.bound === true,
      workspaceAvailable: !storageUnavailable,
      workspaceReason: state.sqlite?.failure
        ? (() => {
          const diagnostic = describeSSHelperFailure(state.sqlite.failure);
          return `${diagnostic.reasonCode} · ${diagnostic.title}：${diagnostic.reason} ${diagnostic.action}`;
        })()
        : state.overview?.failure ? (() => {
          const diagnostic = describeSSHelperFailure(state.overview.failure);
          return `${diagnostic.reasonCode} · ${diagnostic.title}：${diagnostic.reason} ${diagnostic.action}`;
        })() : undefined,
      llmAvailable: state.overview?.llmAvailable === true,
      llmReason: llmDetails ? `${llmDetails.code} · ${llmDetails.resource} · ${llmDetails.model}` : undefined,
      sources: state.sources,
      selectedSourceKinds: state.selectedSourceKinds,
      includeHiddenMessageFloors: state.includeHiddenMessageFloors,
      estimate: state.estimate,
      progress,
      initialized: initialization?.initialized === true,
      lastCompletedAt: initialization?.lastCompletedAt ?? null,
      successfulSourceKinds: initialization?.selectedSourceKinds ?? [],
      attempts: initialization?.attempts.slice(0, 5) ?? [],
      factCount: state.overview?.factCount ?? 0,
      storageBytes: state.overview?.currentChatSizeBytes ?? state.sqlite?.currentChatSizeBytes ?? 0,
      summaryNote,
      submitting: ['initialize', 'reinitialize'].includes(state.busyAction),
      busy: Boolean(state.busyAction),
      reinitializeOpen: state.reinitializeOpen,
    });
  };
  const renderGenerationRecallDiagnostics = (): string => {
    const response = state.actorRecallDiagnostics;
    const plan = [...state.generationCastPlans].sort((left, right) => right.basedOnFloor - left.basedOnFloor || right.createdAt - left.createdAt)[0] ?? response?.request.castPlan;
    const coverageLog = plan
      ? [...state.recallCoverageLogs].filter((item) => item.planId === plan.id).sort((left, right) => right.createdAt - left.createdAt)[0]
      : [...state.recallCoverageLogs].sort((left, right) => right.createdAt - left.createdAt)[0];
    const audit = plan
      ? [...state.castPlanAudits].filter((item) => item.planId === plan.id).sort((left, right) => right.createdAt - left.createdAt)[0]
      : undefined;
    if (!plan && !response && !coverageLog) return `<section class="stx-memory-panel stx-memory-recall-owner-panel">${renderEmpty('暂无逐角色召回诊断', '完成一次正式生成后，这里会显示选角计划、每个主体的独立候选池与覆盖验证。')}</section>`;
    const fixedNames: Readonly<Record<string, string>> = { 'owner:world': '世界', 'owner:narrator': '旁白', 'owner:player': '玩家', 'owner:unknown': '未知主体' };
    const ownerName = (ownerId: string): string => state.actors.find((actor) => actor.id === ownerId)?.displayName ?? fixedNames[ownerId] ?? ownerId;
    const permissionLabels: Readonly<Record<string, string>> = { full: '完整', focused: '聚焦', public_only: '仅公开', identity_only: '仅身份', none: '不召回' };
    const partitions = response ? [response.world, response.narrator, ...response.actors] : [];
    const ownerRows = partitions.map((partition) => {
      const permission = plan?.permissionByOwner[partition.ownerId] ?? response?.diagnostics.permissionByOwner?.[partition.ownerId] ?? 'none';
      const candidates = response?.diagnostics.ownerCandidateCounts?.[partition.ownerId] ?? partition.packets.length;
      const strength = partition.packets.length > 0 ? Math.round(partition.packets.reduce((sum, packet) => sum + packet.effectiveStrength, 0) / partition.packets.length) : 0;
      const retrievalLevel = response?.diagnostics.retrievalLevelByOwner?.[partition.ownerId];
      const retrievalStages = response?.diagnostics.retrievalStagesByOwner?.[partition.ownerId] ?? [];
      return `<div class="stx-memory-recall-owner-row"><span><strong>${escapeHtml(partition.ownerName || ownerName(partition.ownerId))}</strong><small>${escapeHtml(partition.role)}${retrievalLevel ? ` · Level ${retrievalLevel}` : ''}</small>${retrievalStages.length ? `<small title="${escapeHtml(retrievalStages.join(' → '))}">${escapeHtml(retrievalStages.join(' → '))}</small>` : ''}</span><span>${renderStatusChip(permissionLabels[permission] ?? permission, permission === 'none' ? 'neutral' : permission === 'full' ? 'success' : 'warning')}</span><span><small>候选</small><strong>${formatNumber(candidates)}</strong></span><span><small>入选</small><strong>${formatNumber(partition.packets.length)}</strong></span><span><small>平均强度</small><strong>${strength}</strong></span></div>`;
    }).join('');
    const explicitUsage = state.memoryUsageLogs.filter((item) => item.usage === 'explicit').length;
    const implicitUsage = state.memoryUsageLogs.filter((item) => item.usage === 'implicit').length;
    const notUsed = state.memoryUsageLogs.filter((item) => item.usage === 'not_used').length;
    const requiredNames = plan?.requiredOwnerIds.map(ownerName).join('、') || '无';
    const likelyNames = plan?.likelyOwnerIds.map(ownerName).join('、') || '无';
    const backgroundNames = plan?.backgroundOwnerIds.map(ownerName).join('、') || '无';
    const missing = coverageLog ? [...coverageLog.missingSubQueryIds, ...coverageLog.missingOwnerIds.map(ownerName), ...coverageLog.missingTimeDimensions] : [];
    return `<section class="stx-memory-panel stx-memory-recall-owner-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">生成前闭环</span><h3>逐角色召回诊断</h3></div>${coverageLog ? renderStatusChip(coverageLog.covered ? '覆盖完整' : '保留不确定', coverageLog.covered ? 'success' : 'warning') : renderStatusChip('等待覆盖验证')}</div><div class="stx-memory-recall-plan-summary"><div><small>计划模式</small><strong>${escapeHtml(plan?.plannerMode ?? '未记录')}</strong></div><div><small>确定参与</small><strong>${escapeHtml(requiredNames)}</strong></div><div><small>可能参与</small><strong>${escapeHtml(likelyNames)}</strong></div><div><small>背景在场</small><strong>${escapeHtml(backgroundNames)}</strong></div><div><small>计划置信度</small><strong>${plan ? `${Math.round(plan.confidence * 100)}%` : '未记录'}</strong></div><div><small>二次扩展</small><strong>${coverageLog?.expanded ? '已执行一次' : '未执行'}</strong></div></div><div class="stx-memory-recall-owner-table"><div class="stx-memory-recall-owner-row is-head"><span>主体</span><span>权限</span><span>候选</span><span>入选</span><span>平均强度</span></div>${ownerRows || '<p class="stx-memory-muted">本次计划尚未形成可展示的角色分区。</p>'}</div><div class="stx-memory-recall-audit-grid"><article><span class="stx-memory-kicker">覆盖验证</span><strong>${coverageLog?.covered ? '全部子问题已覆盖' : missing.length ? `缺失：${escapeHtml(missing.join('、'))}` : '尚无覆盖日志'}</strong><small>隐私违规 ${coverageLog?.privacyViolations.length ?? 0} · 时间冲突 ${coverageLog?.temporalConflicts.length ?? 0}</small></article><article><span class="stx-memory-kicker">计划与实际</span><strong>${audit ? audit.result === 'matched' ? '完全一致' : audit.result === 'partial' ? '部分一致' : '存在偏差' : '尚未核对'}</strong><small>意外角色 ${audit?.unplannedOwnerIds.length ?? 0} · 未出现 ${audit?.missingOwnerIds.length ?? 0}</small></article><article><span class="stx-memory-kicker">实际使用</span><strong>${explicitUsage} 明确 · ${implicitUsage} 隐含</strong><small>${notUsed} 条已注入但未使用，不会强化</small></article></div></section>`;
  };
  const renderRecall = (): string => {
    const recall = state.recall;
    if (!recall) return renderEmpty('暂无召回状态', '点击刷新或稍后重试。');
    const coverage = recall.eligibleFacts ? Math.round((recall.indexedFacts / recall.eligibleFacts) * 100) : 0;
    const recallError = recall.degradedReason ?? recall.lastError;
    const rebuildDisabled = !recall.embedding.available || recall.rebuilding || Boolean(state.busyAction);
    const diagnostic = state.diagnostics == null
      ? renderEmpty('暂无召回诊断', '完成一次召回后，这里会显示诊断摘要。')
      : `<pre class="stx-memory-code">${escapeHtml(formatJson(state.diagnostics))}</pre>`;
    return `<div class="stx-memory-card-grid"><section class="stx-memory-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">当前策略</span><h3>${escapeHtml(translateRecallMode(recall.resolvedMode))}</h3></div>${renderStatusChip(recall.rebuilding ? '重建中' : '运行正常', recall.rebuilding ? 'warning' : 'success')}</div><div class="stx-memory-route-grid">${renderRoute('向量模型', recall.embedding)}${renderRoute('重排序模型', recall.rerank)}</div><div class="stx-memory-metric-grid"><div><span>已建立索引</span><strong>${formatNumber(recall.indexedFacts)}</strong></div><div><span>可索引事实</span><strong>${formatNumber(recall.eligibleFacts)}</strong></div><div><span>待处理</span><strong>${formatNumber(recall.pendingFacts)}</strong></div></div><div class="stx-memory-progress-copy"><span>向量覆盖率</span><strong>${coverage}%</strong></div><progress ${uiControl('progress')} max="100" value="${coverage}">${coverage}%</progress>${recallError ? `<p class="stx-memory-inline-alert" role="alert">错误码：${escapeHtml(safeInlineError(recallError, 'MEMORY_RECALL_DEGRADED'))}</p>` : ''}<div class="stx-memory-actions"><button ${uiControl('button', 'primary')} type="button" data-action="rebuild-index" ${rebuildDisabled ? 'disabled' : ''}><ss-helper-icon name="arrows-rotate" decorative></ss-helper-icon>重建向量索引</button></div>${recall.embedding.available ? '' : '<p class="stx-memory-muted">请先在 LLM 中配置可用的向量模型，再重建索引。</p>'}</section><section class="stx-memory-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">最近召回</span><h3>客观检索诊断</h3></div></div><details><summary>查看原始召回日志</summary>${diagnostic}</details>${recall.batches.length ? `<div class="stx-memory-batch-table"><div class="stx-memory-table-row stx-memory-table-head"><span>批次</span><span>输入</span><span>延迟</span><span>接受</span></div>${recall.batches.map((batch) => `<div class="stx-memory-table-row"><span>#${batch.batchIndex + 1}</span><span>${formatNumber(batch.inputCount)}</span><span>${formatNumber(batch.latencyMs)} 毫秒</span><span>${formatNumber(batch.accepted)} / ${formatNumber(batch.rejected)}</span></div>`).join('')}</div>` : '<p class="stx-memory-muted">暂无向量批次记录。</p>'}</section>${renderGenerationRecallDiagnostics()}</div>`;
  };
  const graphView = (): ReturnType<typeof selectGraphView> => {
    const graph = localizeGraphPreview(state.graph ?? { nodes: [], edges: [] });
    return selectGraphView(graph, state.graphQuery, state.graphKind, state.graphStatusFilter, state.selectedGraphNodeId, state.graphNeighborFocus, state.selectedGraphEdgeId || state.selectedGraphEventId);
  };
  const graphRelationLabel = (edge: MemoryGraphPreview['edges'][number], nodes: ReadonlyMap<string, MemoryGraphPreview['nodes'][number]>): string => {
    const rawEdge = state.graph?.edges.find((item) => item.id === edge.id) ?? edge;
    const rawNodes = new Map(state.graph?.nodes.map((node) => [node.id, node] as const) ?? []);
    const rawFrom = rawNodes.get(rawEdge.from)?.label ?? '';
    const rawTo = rawNodes.get(rawEdge.to)?.label ?? '';
    if (isNonChinesePredicate(rawEdge.predicate) || isMachineEntityKey(rawFrom) || isMachineEntityKey(rawTo)) {
      const fact = state.facts.find((item) => item.id === rawEdge.backingFactId);
      if (fact?.content) return fact.content;
    }
    return `${nodes.get(edge.from)?.label ?? '未知节点'} — ${edge.predicate} → ${nodes.get(edge.to)?.label ?? '未知节点'}`;
  };
  const resolveGraphInspectorSelection = () => {
    if (!state.graph) return undefined;
    const graph = localizeGraphPreview(state.graph);
    const view = graphView();
    const nodes = new Map(graph.nodes.map((node) => [node.id, node] as const));
    const selectedNode = state.selectedGraphNodeId ? nodes.get(state.selectedGraphNodeId) : undefined;
    const selected = !selectedNode ? view.edges.find((edge) => edge.id === (state.selectedGraphEdgeId || state.selectedGraphEventId)) : undefined;
    return { graph, view, nodes, selectedNode, selected, selectedEvent: Boolean(selected && selected.id === state.selectedGraphEventId) };
  };
  type GraphInspectorSelection = NonNullable<ReturnType<typeof resolveGraphInspectorSelection>>;
  const renderGraphDetail = ({ graph, view, nodes, selectedNode, selected, selectedEvent }: GraphInspectorSelection): string => {
    const nodeEdges = selectedNode ? graph.edges.filter((edge) => edge.from === selectedNode.id || edge.to === selectedNode.id) : [];
    const visibleEdgeIds = new Set(view.edges.map((edge) => edge.id));
    const relationNeighbors = selected ? graph.edges.filter((edge) => edge.from === selected.from || edge.to === selected.from || edge.from === selected.to || edge.to === selected.to) : [];
    const fact = selected ? state.facts.find((item) => item.id === selected.backingFactId) : undefined;
    if (selectedNode) return `<div class="stx-memory-detail-head"><div><span class="stx-memory-kicker">实体节点</span><h3 class="stx-memory-graph-marquee" data-graph-marquee title="${escapeHtml(selectedNode.label)}"><span>${escapeHtml(selectedNode.label)}</span></h3></div>${renderStatusChip('已验证实体', 'success')}</div><div class="stx-memory-detail-summary"><div><span>关联关系</span><strong>${formatNumber(nodeEdges.length)}</strong></div><div><span>可见关系</span><strong>${formatNumber(nodeEdges.filter((edge) => visibleEdgeIds.has(edge.id)).length)}</strong></div></div><section class="stx-memory-detail-section"><div class="stx-memory-section-heading"><div><h4>节点关系</h4><p>选择任意关系可查看关联事实与来源证据</p></div><span>${formatNumber(nodeEdges.length)} 条</span></div><div class="stx-memory-reference-list">${nodeEdges.length ? nodeEdges.map((edge) => `<button ${uiControl('button', 'neutral')} type="button" data-action="select-graph-edge" data-edge-id="${escapeHtml(edge.id)}">${escapeHtml(graphRelationLabel(edge, nodes))}</button>`).join('') : '<span>暂无关联关系</span>'}</div></section><section class="stx-memory-detail-section"><h4>使用说明</h4><p>节点标签来自当前聊天中的实体键；拖动只会调整本次浏览的画布位置，不会改写实体或图边。</p></section>`;
    if (!selected) return renderEmpty('选择一个节点或关系', '右侧会显示关联事实、来源证据与相邻关系。');
    return `<div class="stx-memory-detail-head"><div><span class="stx-memory-kicker">${selectedEvent ? '事件事实' : '事实'}</span><h3 class="stx-memory-graph-marquee" data-graph-marquee title="${escapeHtml(graphRelationLabel(selected, nodes))}"><span>${escapeHtml(graphRelationLabel(selected, nodes))}</span></h3></div>${renderStatusChip(translateFactKind(selected.kind), 'neutral')}</div><div class="stx-memory-detail-summary">${renderStatusChip(translateFactStatus(selected.status), selected.status === 'active' ? 'success' : 'neutral')}<div><span>置信度</span><strong>${Math.round(selected.confidence * 100)}%</strong></div><div><span>${selectedEvent ? '关联高亮' : '相邻关系'}</span><strong>${formatNumber(relationNeighbors.length)}</strong></div></div><section class="stx-memory-detail-section"><div class="stx-memory-section-heading"><div><h4>关联事实</h4><p>${selectedEvent ? '事件两端的全部直接关系会在画布中同步高亮' : '图边不能脱离这条已验证事实独立存在'}</p></div></div>${fact ? `<p class="stx-memory-fact-content">${escapeHtml(fact.content)}</p><div class="stx-memory-evidence-list">${fact.evidence.length ? fact.evidence.map((evidence) => `<article class="stx-memory-evidence"><strong>${renderSourceReference(evidence.sourceRef)}</strong><blockquote>${escapeHtml(evidence.excerpt)}</blockquote></article>`).join('') : '<p class="stx-memory-muted">该事实没有可展示的证据。</p>'}</div>` : '<p class="stx-memory-inline-alert" role="alert">关联事实已变更或正在等待图谱协调；本页不会据此创建替代关系。</p>'}</section><section class="stx-memory-detail-section"><div class="stx-memory-section-heading"><div><h4>节点邻接</h4><p>仅展示同一聊天中由事实背书的相邻边</p></div><span>${formatNumber(relationNeighbors.length)} 条</span></div><div class="stx-memory-reference-list">${relationNeighbors.length ? relationNeighbors.map((edge) => `<button ${uiControl('button', 'neutral')} type="button" data-action="select-graph-edge" data-edge-id="${escapeHtml(edge.id)}">${escapeHtml(graphRelationLabel(edge, nodes))}</button>`).join('') : '<span>暂无其他相邻关系</span>'}</div></section>`;
  };
  const renderGraphInspector = (): string => {
    const graph = state.graph ? localizeGraphPreview(state.graph) : undefined;
    const status = state.graphStatus;
    if (!graph || !status) return renderEmpty('正在读取关系图谱', '图谱只会展示当前聊天中由已验证事实派生的关系。');
    const selection = resolveGraphInspectorSelection();
    if (!selection) return renderEmpty('正在读取关系图谱', '图谱只会展示当前聊天中由已验证事实派生的关系。');
    const { view, nodes, selectedNode, selected } = selection;
    const phaseLabel = status.phase === 'ready' ? '已就绪' : status.phase === 'rebuilding' ? '重建中' : status.phase === 'queued' ? '已排队' : status.phase === 'degraded' ? '已降级' : '等待协调';
    const phaseTone = status.phase === 'ready' ? 'success' : status.phase === 'degraded' ? 'warning' : 'neutral';
    const kinds = [...new Set(graph.edges.map((edge) => edge.kind))].sort();
    const statuses = [...new Set(graph.edges.map((edge) => edge.status))].sort();
    const relationRows = view.edges.length
      ? view.edges.map((edge) => `<button class="stx-memory-graph-edge-row stx-memory-fact-row" ${uiControl('button', 'neutral')} type="button" data-action="select-graph-edge" data-edge-id="${escapeHtml(edge.id)}" aria-selected="${edge.id === selected?.id && !selectedNode ? 'true' : 'false'}"><span class="stx-memory-graph-edge-top"><strong class="stx-memory-graph-marquee" data-graph-marquee title="${escapeHtml(graphRelationLabel(edge, nodes))}"><span>${escapeHtml(graphRelationLabel(edge, nodes))}</span></strong><span>${renderStatusChip(translateFactKind(edge.kind), 'neutral')}${renderStatusChip(translateFactStatus(edge.status), edge.status === 'active' ? 'success' : 'neutral')}</span></span><span class="stx-memory-graph-edge-meta"><span>置信度</span><strong>${Math.round(edge.confidence * 100)}%</strong></span></button>`).join('')
      : renderEmpty('没有匹配的关系', '图边只来自当前聊天中有来源证据、处于有效状态的关系事实。');
    const eventEdges = [...new Map(view.edges.filter((edge) => edge.kind === 'event').map((edge) => [edge.backingFactId, edge] as const)).values()];
    const eventRows = eventEdges.length
      ? eventEdges.map((edge) => {
        const fact = state.facts.find((item) => item.id === edge.backingFactId);
        const relatedCount = graph.edges.filter((item) => item.from === edge.from || item.to === edge.from || item.from === edge.to || item.to === edge.to).length;
        const title = fact?.content ?? graphRelationLabel(edge, nodes);
        return `<button class="stx-memory-graph-edge-row stx-memory-graph-event-row stx-memory-fact-row" ${uiControl('button', 'neutral')} type="button" data-action="select-graph-event" data-event-edge-id="${escapeHtml(edge.id)}" aria-selected="${edge.id === state.selectedGraphEventId ? 'true' : 'false'}"><span class="stx-memory-graph-edge-top"><strong class="stx-memory-graph-marquee" data-graph-marquee title="${escapeHtml(title)}"><span>${escapeHtml(title)}</span></strong><span>${renderStatusChip('事件', 'neutral')}${renderStatusChip(translateFactStatus(edge.status), edge.status === 'active' ? 'success' : 'neutral')}</span></span><span class="stx-memory-graph-edge-meta"><span>关联 ${formatNumber(relatedCount)} 条关系</span><strong>${Math.round(edge.confidence * 100)}%</strong></span></button>`;
      }).join('')
      : renderEmpty('没有匹配的事件', '事件列表只展示当前筛选范围中由已验证事件事实生成的关系。');
    const listCount = state.graphListMode === 'events' ? eventEdges.length : view.edges.length;
    const listLabel = state.graphListMode === 'events' ? '事件列表' : '边列表';
    const detail = renderGraphDetail(selection);
    return `<section class="stx-memory-panel stx-memory-graph-status-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">图谱状态</span><h3>当前聊天</h3></div><div class="stx-memory-graph-status-actions">${renderStatusChip(phaseLabel, phaseTone)}<button class="stx-memory-graph-icon-button" ${uiButton('neutral', 'sm', true)} type="button" data-action="rebuild-graph" aria-label="重建关系图谱" title="重建关系图谱" ${state.busyAction || status.phase === 'rebuilding' ? 'disabled' : ''}><ss-helper-icon name="arrows-rotate" decorative></ss-helper-icon></button></div></div><p class="stx-memory-muted">仅以当前聊天中已验证事实为准；视觉聚类只用于浏览，不会写入记忆。</p><dl class="stx-memory-graph-metric-grid"><div><dt>节点</dt><dd>${formatNumber(graph.nodes.length)}</dd></div><div><dt>已载入关系</dt><dd>${formatNumber(graph.edges.length)} / ${formatNumber(status.edgeCount)}</dd></div><div><dt>最后协调</dt><dd>${escapeHtml(status.lastRebuiltAt ? formatTime(status.lastRebuiltAt) : '尚未完成')}</dd></div></dl>${status.lastError ? '<p class="stx-memory-inline-alert" role="alert">图谱暂时降级，普通整理和召回不受影响。</p>' : ''}<div class="stx-memory-graph-filter-row"><label>类型<select ${uiControl('select')} data-graph-filter="kind"><option value="">全部</option>${kinds.map((kind) => `<option value="${escapeHtml(kind)}" ${state.graphKind === kind ? 'selected' : ''}>${escapeHtml(translateFactKind(kind))}</option>`).join('')}</select></label><label>状态<select ${uiControl('select')} data-graph-filter="status"><option value="">全部</option>${statuses.map((value) => `<option value="${escapeHtml(value)}" ${state.graphStatusFilter === value ? 'selected' : ''}>${escapeHtml(translateFactStatus(value))}</option>`).join('')}</select></label></div></section><section class="stx-memory-panel stx-memory-graph-relations-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">已验证关系</span><h3 data-graph-list-heading>${listLabel}</h3></div><span data-graph-list-count>${formatNumber(listCount)} 条</span></div><div class="stx-memory-graph-list-switch" role="tablist" aria-label="已验证关系显示模式"><button ${uiButton('neutral', 'sm')} type="button" role="tab" data-action="set-graph-list-mode" data-graph-list-mode="edges" aria-selected="${state.graphListMode === 'edges'}"><ss-helper-icon name="link" decorative></ss-helper-icon>边列表</button><button ${uiButton('neutral', 'sm')} type="button" role="tab" data-action="set-graph-list-mode" data-graph-list-mode="events" aria-selected="${state.graphListMode === 'events'}"><ss-helper-icon name="bolt" decorative></ss-helper-icon>事件列表</button></div><div class="stx-memory-graph-list-stack"><div class="stx-memory-graph-edge-list" data-graph-edge-list data-graph-list-mode="edges" data-graph-list-count="${view.edges.length}" ${state.graphListMode === 'edges' ? '' : 'hidden'}>${relationRows}</div><div class="stx-memory-graph-edge-list" data-graph-edge-list data-graph-list-mode="events" data-graph-list-count="${eventEdges.length}" ${state.graphListMode === 'events' ? '' : 'hidden'}>${eventRows}</div></div></section><section class="stx-memory-panel stx-memory-graph-detail-panel" data-graph-inspector-detail>${detail}</section>`;
  };
  const renderGraph = (): string => {
    const graph = state.graph ? localizeGraphPreview(state.graph) : undefined;
    const status = state.graphStatus;
    if (!graph || !status) return renderEmpty('正在读取关系图谱', '图谱只会展示当前聊天中由已验证事实派生的关系。');
    if (!status.enabled) return `<section class="stx-memory-panel">${renderEmpty('关系图谱已关闭', '可在“高级 → 关系图谱”中开启；关闭时不会影响普通整理或召回。')}</section>`;
    const focusNodeId = state.selectedGraphNodeId || state.selectedGraphEdgeId || state.selectedGraphEventId;
    return `<div class="stx-memory-graph-shell"><section class="stx-memory-graph-stage-panel" aria-label="关系图谱画布"><div class="stx-memory-graph-toolbar"><label class="stx-memory-graph-search"><ss-helper-icon name="magnifying-glass" decorative></ss-helper-icon><span class="stx-memory-sr-only">搜索节点或关系</span><input id="stx-memory-graph-query" ${uiControl('input')} data-filter="graph-query" value="${escapeHtml(state.graphQuery)}" placeholder="搜索节点或关系"></label><div class="stx-memory-graph-command-group" aria-label="图谱视图控制"><button ${uiButton('neutral', 'sm', true)} type="button" data-action="graph-command" data-graph-command="zoom-out" aria-label="缩小图谱" title="缩小图谱"><ss-helper-icon name="minus" decorative></ss-helper-icon></button><button ${uiButton('neutral', 'sm', true)} type="button" data-action="graph-command" data-graph-command="zoom-in" aria-label="放大图谱" title="放大图谱"><ss-helper-icon name="plus" decorative></ss-helper-icon></button><button ${uiButton('neutral', 'sm', true)} type="button" data-action="graph-command" data-graph-command="fit" aria-label="适配视图" title="适配视图"><ss-helper-icon name="expand" decorative></ss-helper-icon></button><button ${uiButton('neutral', 'sm', true)} type="button" data-action="graph-command" data-graph-command="reset-layout" aria-label="重新布局" title="重新布局"><ss-helper-icon name="shuffle" decorative></ss-helper-icon></button></div><button class="stx-memory-graph-focus-button stx-memory-graph-icon-button" ${uiButton('neutral', 'sm', true)} type="button" data-action="toggle-graph-neighbor-focus" aria-pressed="${state.graphNeighborFocus}" aria-label="${state.graphNeighborFocus ? '显示全部关系' : '只看选中邻接'}" title="${state.graphNeighborFocus ? '显示全部关系' : '只看选中邻接'}" ${focusNodeId ? '' : 'disabled'}><ss-helper-icon name="${state.graphNeighborFocus ? 'eye' : 'eye-slash'}" decorative></ss-helper-icon></button><button class="stx-memory-graph-orbit-button stx-memory-graph-icon-button" ${uiButton('neutral', 'sm', true)} type="button" data-action="graph-command" data-graph-command="toggle-orbit" aria-label="切换自动旋转" title="切换自动旋转"><ss-helper-icon name="rotate" decorative></ss-helper-icon></button></div><div class="stx-memory-relationship-graph-stage"><div class="stx-memory-relationship-graph-three-host" data-relationship-graph-three-host></div><div class="stx-memory-graph-overlay"><span><ss-helper-icon name="arrows-to-circle" decorative></ss-helper-icon> 拖动旋转 · 右键平移 · 滚轮缩放</span></div></div></section><aside class="stx-memory-graph-inspector" data-relationship-graph-inspector>${renderGraphInspector()}</aside></div>`;
  };
  const refreshGraphMarquees = (scope: ParentNode = root): void => {
    queueMicrotask(() => {
      if (disposed) return;
      scope.querySelectorAll<HTMLElement>('[data-graph-marquee]').forEach((container) => {
        const content = container.firstElementChild as HTMLElement | null;
        if (!content || !container.isConnected) return;
        const edgeTop = container.parentElement?.classList.contains('stx-memory-graph-edge-top') ? container.parentElement : null;
        const badges = edgeTop ? container.nextElementSibling as HTMLElement | null : null;
        const edgeTopWidth = edgeTop?.getBoundingClientRect().width ?? 0;
        const badgeWidth = badges?.getBoundingClientRect().width ?? 0;
        const columnGap = edgeTop ? Number.parseFloat(window.getComputedStyle(edgeTop).columnGap) || 0 : 0;
        const measuredWidth = edgeTopWidth > 0
          ? Math.max(0, edgeTopWidth - badgeWidth - columnGap)
          : container.getBoundingClientRect().width || container.clientWidth;
        if (edgeTop && measuredWidth > 0) container.style.width = `${measuredWidth}px`;
        const contentWidth = Math.max(content.scrollWidth, content.getBoundingClientRect().width);
        const distance = Math.max(0, contentWidth - measuredWidth);
        container.dataset.overflow = distance > 2 ? 'true' : 'false';
        container.style.setProperty('--stx-graph-marquee-distance', `${distance}px`);
        container.style.setProperty('--stx-graph-marquee-duration', `${Math.max(5, distance / 16).toFixed(2)}s`);
      });
    });
  };
  const observeGraphMarqueeResize = (): void => {
    graphMarqueeResizeObserver?.disconnect();
    graphMarqueeResizeObserver = undefined;
    const inspector = root.querySelector<HTMLElement>('[data-relationship-graph-inspector]');
    if (!inspector || typeof ResizeObserver === 'undefined') return;
    graphMarqueeResizeObserver = new ResizeObserver(() => {
      if (disposed || graphMarqueeResizeFrame !== undefined) return;
      graphMarqueeResizeFrame = window.requestAnimationFrame(() => {
        graphMarqueeResizeFrame = undefined;
        refreshGraphMarquees(inspector);
      });
    });
    graphMarqueeResizeObserver.observe(inspector);
  };
  const syncGraphUi = (selectionOnly = false): void => {
    if (disposed || !['graph', 'recall'].includes(state.page) || !state.graphStatus?.enabled || !state.graph) return;
    const view = graphView();
    const selectedEdgeId = state.selectedGraphNodeId ? '' : state.selectedGraphEdgeId && view.edges.some((edge) => edge.id === state.selectedGraphEdgeId) ? state.selectedGraphEdgeId : '';
    const selectedEventEdgeId = state.selectedGraphNodeId || selectedEdgeId ? '' : state.selectedGraphEventId && view.edges.some((edge) => edge.id === state.selectedGraphEventId && edge.kind === 'event') ? state.selectedGraphEventId : '';
    if (!state.selectedGraphNodeId && state.selectedGraphEdgeId !== selectedEdgeId) state.selectedGraphEdgeId = selectedEdgeId;
    if (!state.selectedGraphNodeId && state.selectedGraphEventId !== selectedEventEdgeId) state.selectedGraphEventId = selectedEventEdgeId;
    const inspector = root.querySelector<HTMLElement>('[data-relationship-graph-inspector]');
    if (inspector && selectionOnly) {
      inspector.querySelectorAll<HTMLElement>('[data-graph-edge-list] > [data-action="select-graph-edge"][data-edge-id]').forEach((row) => {
        row.setAttribute('aria-selected', String(!state.selectedGraphNodeId && row.dataset.edgeId === selectedEdgeId));
      });
      inspector.querySelectorAll<HTMLElement>('[data-graph-edge-list] > [data-action="select-graph-event"][data-event-edge-id]').forEach((row) => {
        row.setAttribute('aria-selected', String(!state.selectedGraphNodeId && row.dataset.eventEdgeId === selectedEventEdgeId));
      });
      const detail = inspector.querySelector<HTMLElement>('[data-graph-inspector-detail]');
      const selection = resolveGraphInspectorSelection();
      if (detail && selection) {
        detail.innerHTML = renderGraphDetail(selection);
        popupUi?.refreshControls(detail);
        refreshGraphMarquees(detail);
      }
    } else if (inspector) {
      inspector.innerHTML = renderGraphInspector();
      popupUi?.refreshControls(inspector);
      refreshGraphMarquees(inspector);
    }
    graphRenderer?.update({ graph: state.graph, visibleEdgeIds: new Set(view.edges.map((edge) => edge.id)), selectedNodeId: state.selectedGraphNodeId, selectedEdgeId, selectedEventEdgeId, reduceMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches });
    syncGraphFocusButton();
  };
  const syncGraphFocusButton = (): void => {
    const focusButton = root.querySelector<HTMLElement>('[data-action="toggle-graph-neighbor-focus"]');
    if (focusButton) {
      const label = state.graphNeighborFocus ? '显示全部关系' : '只看选中邻接';
      focusButton.setAttribute('aria-pressed', String(state.graphNeighborFocus));
      focusButton.setAttribute('aria-label', label);
      focusButton.setAttribute('title', label);
      focusButton.innerHTML = `<ss-helper-icon name="${state.graphNeighborFocus ? 'eye' : 'eye-slash'}" decorative></ss-helper-icon>`;
      focusButton.toggleAttribute('disabled', !(state.selectedGraphNodeId || state.selectedGraphEdgeId || state.selectedGraphEventId));
    }
  };
  const syncGraphListMode = (hadSelection: boolean): void => {
    const inspector = root.querySelector<HTMLElement>('[data-relationship-graph-inspector]');
    if (!inspector) return;
    inspector.querySelectorAll<HTMLElement>('[data-action="set-graph-list-mode"][data-graph-list-mode]').forEach((tab) => {
      tab.setAttribute('aria-selected', String(tab.dataset.graphListMode === state.graphListMode));
    });
    let activePane: HTMLElement | undefined;
    inspector.querySelectorAll<HTMLElement>('[data-graph-edge-list][data-graph-list-mode]').forEach((pane) => {
      const active = pane.dataset.graphListMode === state.graphListMode;
      pane.hidden = !active;
      if (active) activePane = pane;
    });
    const heading = inspector.querySelector<HTMLElement>('[data-graph-list-heading]');
    const count = inspector.querySelector<HTMLElement>('[data-graph-list-count]');
    if (heading) heading.textContent = state.graphListMode === 'events' ? '事件列表' : '边列表';
    if (count) count.textContent = `${formatNumber(Number(activePane?.dataset.graphListCount ?? 0))} 条`;
    if (hadSelection) {
      inspector.querySelectorAll<HTMLElement>('[data-graph-edge-list] > [aria-selected="true"]').forEach((row) => row.setAttribute('aria-selected', 'false'));
      const detail = inspector.querySelector<HTMLElement>('[data-graph-inspector-detail]');
      if (detail) detail.innerHTML = renderEmpty('选择一个节点或关系', '右侧会显示关联事实、来源证据与相邻关系。');
      syncGraphFocusButton();
    }
    if (graphListModeFrame !== undefined) window.cancelAnimationFrame(graphListModeFrame);
    graphListModeFrame = window.requestAnimationFrame(() => {
      graphListModeFrame = window.requestAnimationFrame(() => {
        graphListModeFrame = undefined;
        if (disposed || !['graph', 'recall'].includes(state.page)) return;
        if (hadSelection && !state.selectedGraphNodeId && !state.selectedGraphEdgeId && !state.selectedGraphEventId) graphRenderer?.clearSelection();
        if (activePane?.isConnected && !activePane.hidden) refreshGraphMarquees(activePane);
      });
    });
  };
  const loadUsageRecallDetail = async (usage: MainChatUsage): Promise<void> => {
    const detailId = usage.generationRecallDetailId?.trim();
    if (detailId && state.usageRecallDetail?.id === detailId && !state.usageRecallLoading) return;
    const requestId = ++usageRecallRequestId;
    delete state.usageRecallDetail;
    if (!detailId || !controller.getGenerationRecallDetail) {
      state.usageRecallLoading = false;
      rerender();
      return;
    }
    state.usageRecallLoading = true;
    rerender();
    try {
      const detail = await controller.getGenerationRecallDetail(detailId);
      if (!disposed && requestId === usageRecallRequestId && state.selectedUsageId === usage.id && detail?.id === detailId) state.usageRecallDetail = detail;
    } catch (error) {
      if (!disposed && requestId === usageRecallRequestId && state.selectedUsageId === usage.id) {
        const diagnostic = describeMemoryError(error, 'INTERNAL_ERROR', 'workbench-page');
        toast('error', diagnostic.title, diagnostic.reason, diagnostic.reasonCode);
      }
    } finally {
      if (!disposed && requestId === usageRecallRequestId) {
        state.usageRecallLoading = false;
        rerender();
      }
    }
  };
  const auditStatusLabel = (status: MemoryAuditStatus): string => status === 'rolled_back' ? '已回滚' : status === 'partial' ? '部分完成' : '已完成';
  const auditStatusTone = (status: MemoryAuditStatus): 'success' | 'warning' | 'neutral' => status === 'completed' ? 'success' : status === 'partial' ? 'warning' : 'neutral';
  const issueStatusLabel = (issue: MemoryAuditIssue): string => issue.status === 'repaired' ? '已修复'
    : issue.status === 'ignored' ? '已忽略'
      : issue.waitingForEvidenceChange ? '等待新证据'
        : issue.status === 'running' ? '处理中'
          : issue.status === 'queued' ? '已排队' : '待处理';
  const usageComplete = (usage: MainChatUsage): boolean => [
    usage.promptTokens,
    usage.completionTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.totalTokens,
  ].every(value => value !== null);
  const formatTokenCount = (value: number | null): string => value === null ? '未返回' : formatNumber(value);
  const visibleAudits = (): MemoryAuditRecord[] => {
    const query = state.auditQuery.trim().toLocaleLowerCase();
    return state.audits.filter((record) => {
      if (state.auditStatus !== 'all' && record.status !== state.auditStatus) return false;
      if (state.auditIssuesOnly && record.unresolvedCount === 0) return false;
      if (!query) return true;
      return [
        record.id,
        record.jobId,
        record.requestId,
        record.resourceId,
        record.model,
        ...record.sourceRefs,
        ...record.issues.flatMap(issue => [issue.collection, issue.path, issue.failure.reasonCode, issue.failure.requestId]),
      ].some(value => String(value ?? '').toLocaleLowerCase().includes(query));
    });
  };
  const visibleUsages = (): MainChatUsage[] => {
    const query = state.usageQuery.trim().toLocaleLowerCase();
    return state.usages.filter((usage) => {
      if (state.usageModel && (usage.model ?? '') !== state.usageModel) return false;
      const complete = usageComplete(usage);
      if (state.usageCompleteness === 'complete' && !complete) return false;
      if (state.usageCompleteness === 'missing' && complete) return false;
      if (!query) return true;
      return [usage.id, usage.messageId, usage.provider, usage.model].some(value => String(value ?? '').toLocaleLowerCase().includes(query));
    });
  };
  const collectPages = async <T,>(load: (cursor: string | undefined) => Promise<MemoryPage<T>>): Promise<T[]> => {
    const items: T[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await load(cursor);
      items.push(...page.items);
      if (page.nextCursor === null) break;
      if (seen.has(page.nextCursor)) throw new Error('分页游标重复。');
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  };
  const collectAuditExportRecords = (): Promise<MemoryAuditRecord[]> => controller.listAuditRecordsPage
    ? collectPages(cursor => controller.listAuditRecordsPage!(auditPageRequest(200, {
        cursor,
        signal: abortController.signal,
      })))
    : Promise.resolve(visibleAudits());
  const collectUsageExportRecords = (): Promise<MainChatUsage[]> => controller.getMainChatUsagePage
    ? collectPages(cursor => controller.getMainChatUsagePage!(usagePageRequest(500, {
        cursor,
        signal: abortController.signal,
      })))
    : Promise.resolve(visibleUsages());
  const downloadAuditExport = (sourceRecords: readonly MemoryAuditRecord[]): number => {
    const records = sourceRecords.map(record => ({
      id: record.id,
      jobId: record.jobId,
      createdAt: record.createdAt,
      ...(record.rolledBackAt === undefined ? {} : { rolledBackAt: record.rolledBackAt }),
      status: record.status,
      outcome: record.outcome,
      batchIndex: record.batchIndex,
      sourceRefs: [...record.sourceRefs],
      acceptedCount: record.acceptedCount,
      rejectedCount: record.rejectedCount,
      unresolvedCount: record.unresolvedCount,
      repairedCount: record.repairedCount,
      ignoredCount: record.ignoredCount,
      ...(record.requestId ? { requestId: record.requestId } : {}),
      ...(record.resourceId ? { resourceId: record.resourceId } : {}),
      ...(record.model ? { model: record.model } : {}),
      ...(record.latencyMs === undefined ? {} : { latencyMs: record.latencyMs }),
      ...(record.fallbackUsed === undefined ? {} : { fallbackUsed: record.fallbackUsed }),
      issues: record.issues.map(issue => ({
        id: issue.id,
        ...(issue.rejectionId ? { rejectionId: issue.rejectionId } : {}),
        collection: issue.collection,
        itemIndex: issue.itemIndex,
        batchIndex: issue.batchIndex,
        path: issue.path,
        ...(issue.keyword ? { keyword: issue.keyword } : {}),
        ...(issue.expected ? { expected: issue.expected } : {}),
        sourceRefs: [...issue.sourceRefs],
        status: issue.status,
        attemptCount: issue.attemptCount,
        ...(issue.maxAttempts === undefined ? {} : { maxAttempts: issue.maxAttempts }),
        waitingForEvidenceChange: issue.waitingForEvidenceChange,
        ...(issue.resolutionMode ? { resolutionMode: issue.resolutionMode } : {}),
        failure: {
          reasonCode: issue.failure.reasonCode,
          stage: issue.failure.stage,
          ...(issue.failure.requestId ? { requestId: issue.failure.requestId } : {}),
          ...(issue.failure.batchIndex === undefined ? {} : { batchIndex: issue.failure.batchIndex }),
          ...(issue.failure.collection ? { collection: issue.failure.collection } : {}),
          ...(issue.failure.path ? { path: issue.failure.path } : {}),
          ...(issue.failure.keyword ? { keyword: issue.failure.keyword } : {}),
          ...(issue.failure.expected ? { expected: issue.failure.expected } : {}),
          ...(issue.failure.resourceId ? { resourceId: issue.failure.resourceId } : {}),
          ...(issue.failure.model ? { model: issue.failure.model } : {}),
        },
      })),
    }));
    downloadBlob(new Blob([JSON.stringify({ schema: 'MEMORY_AUDIT_EXPORT_V0', exportedAt: new Date().toISOString(), records }, null, 2)], { type: 'application/json;charset=utf-8' }), `ss-helper-memory-audit-${new Date().toISOString().slice(0, 10)}.json`);
    return records.length;
  };
  const downloadUsageExport = (usages: readonly MainChatUsage[]): number => {
    const csvCell = (value: unknown): string => {
      const raw = String(value ?? '');
      const safe = typeof value === 'string' && /^[=+\-@]/u.test(raw) ? `'${raw}` : raw;
      return `"${safe.replaceAll('"', '""')}"`;
    };
    const header = ['id', 'messageId', 'recallLogId', 'generationRecallDetailId', 'promptTokens', 'completionTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'provider', 'model', 'capturedAt', 'completeness'];
    const rows = usages.map(usage => [
      usage.id,
      usage.messageId,
      usage.recallLogId ?? '',
      usage.generationRecallDetailId ?? '',
      usage.promptTokens ?? '',
      usage.completionTokens ?? '',
      usage.cacheReadTokens ?? '',
      usage.cacheWriteTokens ?? '',
      usage.totalTokens ?? '',
      usage.provider ?? '',
      usage.model ?? '',
      new Date(usage.capturedAt).toISOString(),
      usageComplete(usage) ? 'complete' : 'missing',
    ]);
    const csv = `\uFEFF${[header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n')}`;
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `ss-helper-memory-usage-${new Date().toISOString().slice(0, 10)}.csv`);
    return rows.length;
  };
  const normalizeAuditSelection = (): void => {
    const records = visibleAudits();
    if (!records.some(record => record.id === state.selectedAuditId)) state.selectedAuditId = records[0]?.id ?? '';
    const usages = visibleUsages();
    if (!usages.some(usage => usage.id === state.selectedUsageId)) {
      state.selectedUsageId = usages[0]?.id ?? '';
      delete state.usageRecallDetail;
    }
    if (!(state.auditTab === 'records' ? state.selectedAuditId : state.selectedUsageId)) state.auditMobileView = 'list';
  };
  const renderAuditRecord = (record: MemoryAuditRecord): string => `<button class="stx-memory-audit-row" type="button" data-action="select-audit-record" data-audit-record-id="${escapeHtml(record.id)}" aria-pressed="${record.id === state.selectedAuditId}"><span class="stx-memory-audit-row-head"><strong>Capture #${formatNumber(record.batchIndex + 1)}</strong>${renderStatusChip(auditStatusLabel(record.status), auditStatusTone(record.status))}</span><span class="stx-memory-audit-row-meta"><span>${escapeHtml(formatTime(record.createdAt))}</span><span>${formatNumber(record.acceptedCount)} 接受</span><span>${formatNumber(record.rejectedCount)} 拒绝</span></span>${record.unresolvedCount ? `<span class="stx-memory-audit-row-alert"><ss-helper-icon name="triangle-exclamation" decorative></ss-helper-icon>${formatNumber(record.unresolvedCount)} 项待处理</span>` : '<span class="stx-memory-audit-row-ok"><ss-helper-icon name="circle-check" decorative></ss-helper-icon>无需处理</span>'}</button>`;
  const renderAuditIssue = (issue: MemoryAuditIssue): string => {
    const diagnostic = describeSSHelperFailure(issue.failure);
    const actionableId = issue.rejectionId ?? issue.id;
    const selected = state.selectedRejectionIds.includes(actionableId);
    const selectable = issue.canIgnore && controller.ignoreCaptureRejections && !state.busyAction;
    const technical = [
      `reasonCode=${issue.failure.reasonCode}`,
      issue.failure.requestId ? `requestId=${issue.failure.requestId}` : '',
      `collection=${issue.collection}`,
      `path=${issue.path}`,
      `batchIndex=${issue.batchIndex}`,
    ].filter(Boolean).join(' · ');
    return `<article class="stx-memory-audit-issue" data-issue-status="${escapeHtml(issue.status)}"><div class="stx-memory-audit-issue-head">${selectable ? `<label class="stx-memory-audit-issue-check"><input ${uiControl('checkbox')} type="checkbox" data-capture-rejection-id="${escapeHtml(actionableId)}" ${selected ? 'checked' : ''}><span class="stx-memory-sr-only">选择 ${escapeHtml(diagnostic.title)}</span></label>` : '<span class="stx-memory-audit-issue-icon" aria-hidden="true"><ss-helper-icon name="triangle-exclamation" decorative></ss-helper-icon></span>'}<div><strong>${escapeHtml(diagnostic.title)}</strong><small>${escapeHtml(issue.collection)} · ${escapeHtml(issue.path)}</small></div>${renderStatusChip(issueStatusLabel(issue), issue.status === 'repaired' ? 'success' : issue.status === 'ignored' ? 'neutral' : 'warning')}</div><div class="stx-memory-audit-diagnostic"><p><b>原因：</b>${escapeHtml(diagnostic.reason)}</p><p><b>处理建议：</b>${escapeHtml(diagnostic.action)}</p><code>${escapeHtml(technical)}</code></div>${issue.sourceRefs.length ? `<div class="stx-memory-audit-sources">${issue.sourceRefs.map(ref => renderSourceReference(ref)).join('')}</div>` : ''}</article>`;
  };
  const renderAuditDetail = (record: MemoryAuditRecord | undefined): string => {
    if (!record) return `<section class="stx-memory-audit-detail" data-audit-detail>${renderEmpty('选择一条操作记录', '右侧会显示安全诊断、来源与真实可用操作。')}</section>`;
    const selectedIds = state.selectedRejectionIds.filter(id => record.issues.some(issue => (issue.rejectionId ?? issue.id) === id && issue.canIgnore));
    const issueMarkup = record.issues.length
      ? `<div class="stx-memory-audit-issue-list">${record.issues.map(renderAuditIssue).join('')}</div>`
      : renderEmpty('本次 Capture 没有失败项', '所有合法项目已按原事务提交。');
    const rollback = record.status !== 'rolled_back' && controller.rollbackActorCapture && popupUi
      ? `<button ${uiButton('danger', 'sm')} type="button" data-action="rollback-audit" data-audit-id="${escapeHtml(record.id)}"><ss-helper-icon name="rotate-left" decorative></ss-helper-icon>回滚 Capture</button>`
      : '';
    return `<section class="stx-memory-audit-detail" data-audit-detail><button class="stx-memory-audit-mobile-back" ${uiButton('neutral', 'sm')} type="button" data-action="audit-mobile-back"><ss-helper-icon name="arrow-left" decorative></ss-helper-icon>返回记录</button><header class="stx-memory-audit-detail-head"><div><span class="stx-memory-kicker">Capture #${formatNumber(record.batchIndex + 1)}</span><h3 id="stx-memory-audit-detail-heading" tabindex="-1">${escapeHtml(auditStatusLabel(record.status))}</h3><p>${escapeHtml(formatTime(record.createdAt))}</p></div><div class="stx-memory-audit-detail-actions">${rollback}</div></header><dl class="stx-memory-audit-summary"><div><dt>接受</dt><dd>${formatNumber(record.acceptedCount)}</dd></div><div><dt>拒绝</dt><dd>${formatNumber(record.rejectedCount)}</dd></div><div><dt>来源</dt><dd>${formatNumber(record.sourceRefs.length)}</dd></div><div><dt>耗时</dt><dd>${record.latencyMs === undefined ? '未记录' : `${formatNumber(record.latencyMs)} ms`}</dd></div></dl><div class="stx-memory-audit-route"><div><small>模型</small><strong>${escapeHtml(record.model ?? '未记录')}</strong></div><div><small>资源</small><strong>${escapeHtml(formatAuditResource(record.resourceId))}</strong></div><div><small>路由</small><strong>${record.fallbackUsed === true ? '使用回退' : record.fallbackUsed === false ? '主路由' : '未记录'}</strong></div>${record.requestId ? `<div><small>请求 ID</small><code>${escapeHtml(record.requestId)}</code></div>` : ''}</div>${record.sourceRefs.length ? `<section class="stx-memory-audit-source-block"><h4>来源消息</h4><div class="stx-memory-audit-sources">${record.sourceRefs.map(ref => renderSourceReference(ref)).join('')}</div></section>` : ''}<section class="stx-memory-audit-issues"><div class="stx-memory-audit-section-head"><div><h4>失败项</h4><p>${formatNumber(record.unresolvedCount)} 项待处理，${formatNumber(record.repairedCount)} 项已修复，${formatNumber(record.ignoredCount)} 项已忽略</p></div>${record.issues.some(issue => issue.canIgnore) ? `<button ${uiButton('neutral', 'sm')} type="button" data-action="ignore-capture-rejections" data-audit-id="${escapeHtml(record.id)}" ${selectedIds.length && controller.ignoreCaptureRejections && !state.busyAction ? '' : 'disabled'}><ss-helper-icon name="eye-slash" decorative></ss-helper-icon>忽略所选（${selectedIds.length}）</button>` : ''}</div>${issueMarkup}</section></section>`;
  };
  const renderUsageRecord = (usage: MainChatUsage): string => `<button class="stx-memory-usage-row" type="button" data-action="select-usage" data-usage-id="${escapeHtml(usage.id)}" aria-pressed="${usage.id === state.selectedUsageId}"><span><strong>${escapeHtml(usage.model ?? '模型未记录')}</strong><small>${escapeHtml(formatTime(usage.capturedAt))}</small></span><span>${formatTokenCount(usage.promptTokens)}</span><span>${formatTokenCount(usage.completionTokens)}</span><span class="stx-memory-usage-total">${formatTokenCount(usage.totalTokens)}</span><span>${renderStatusChip(usageComplete(usage) ? '完整' : '有缺失', usageComplete(usage) ? 'success' : 'warning')}</span></button>`;
  const renderGenerationRecallDetail = (usage: MainChatUsage): string => {
    if (!usage.generationRecallDetailId) return '<p class="stx-memory-muted">本条生成没有关联召回详情。</p>';
    if (state.usageRecallLoading) return renderLoading('正在读取召回详情…');
    const detail = state.usageRecallDetail?.id === usage.generationRecallDetailId ? state.usageRecallDetail : undefined;
    if (!detail) return '<p class="stx-memory-muted">召回详情暂未读取或已经失效。</p>';
    const finalAttempt = [...detail.attempts].reverse().find(attempt => attempt.final) ?? detail.attempts.at(-1);
    const candidates = detail.uniqueCandidateCount ?? finalAttempt?.uniqueCandidateCount ?? detail.candidateOccurrenceCount ?? finalAttempt?.candidateCount;
    const injected = detail.injectedUniqueCount ?? finalAttempt?.selectedCount ?? detail.prompt.includedCount;
    const owners = new Set(finalAttempt?.owners.map(owner => owner.ownerId) ?? []).size;
    return `<dl class="stx-memory-recall-detail-grid"><div><dt>候选数</dt><dd>${candidates === undefined ? '未返回' : formatNumber(candidates)}</dd></div><div><dt>注入数</dt><dd>${formatNumber(injected)}</dd></div><div><dt>主体数</dt><dd>${formatNumber(owners)}</dd></div><div><dt>Prompt 占用</dt><dd>${formatNumber(detail.prompt.usedChars)} / ${formatNumber(detail.prompt.maxChars)}</dd></div><div><dt>省略数</dt><dd>${formatNumber(detail.prompt.omittedCount)}</dd></div><div><dt>状态</dt><dd>${detail.previewState === 'invalidated' ? '已失效' : '有效'}</dd></div></dl>`;
  };
  const renderUsageDetail = (usage: MainChatUsage | undefined): string => {
    if (!usage) return `<section class="stx-memory-audit-detail" data-audit-detail>${renderEmpty('选择一条用量记录', '右侧会显示 Token 返回情况和召回范围。')}</section>`;
    const tokenFields: Array<[string, number | null]> = [
      ['Prompt', usage.promptTokens],
      ['Completion', usage.completionTokens],
      ['Cache read', usage.cacheReadTokens],
      ['Cache write', usage.cacheWriteTokens],
      ['总计', usage.totalTokens],
    ];
    return `<section class="stx-memory-audit-detail" data-audit-detail><button class="stx-memory-audit-mobile-back" ${uiButton('neutral', 'sm')} type="button" data-action="audit-mobile-back"><ss-helper-icon name="arrow-left" decorative></ss-helper-icon>返回用量</button><header class="stx-memory-audit-detail-head"><div><span class="stx-memory-kicker">主聊天生成</span><h3 id="stx-memory-usage-detail-heading" tabindex="-1">${escapeHtml(usage.model ?? '模型未记录')}</h3><p>${escapeHtml(formatTime(usage.capturedAt))}</p></div>${renderStatusChip(usageComplete(usage) ? 'Token 完整' : 'Token 有缺失', usageComplete(usage) ? 'success' : 'warning')}</header><dl class="stx-memory-token-detail">${tokenFields.map(([label, value]) => `<div><dt>${label}</dt><dd>${formatTokenCount(value)}</dd></div>`).join('')}</dl><div class="stx-memory-audit-route"><div><small>Provider</small><strong>${escapeHtml(usage.provider ?? '未记录')}</strong></div><div><small>消息 ID</small><code>${escapeHtml(usage.messageId)}</code></div>${usage.recallLogId ? `<div><small>Recall log</small><code>${escapeHtml(usage.recallLogId)}</code></div>` : ''}</div>${navigateToMessage ? `<div class="stx-memory-audit-detail-actions"><button ${uiButton('neutral', 'sm')} type="button" data-action="jump-to-message" data-message-id="${escapeHtml(usage.messageId)}"><ss-helper-icon name="arrow-up-right-from-square" decorative></ss-helper-icon>跳转来源消息</button></div>` : ''}<section class="stx-memory-audit-issues"><div class="stx-memory-audit-section-head"><div><h4>召回详情</h4><p>仅展示计数、Prompt 占用与失效状态。</p></div></div>${renderGenerationRecallDetail(usage)}</section></section>`;
  };
  const renderUsageTrend = (usages: readonly MainChatUsage[]): string => {
    const points = [...usages].sort((left, right) => left.capturedAt - right.capturedAt).slice(-30);
    const known = points.filter((usage): usage is MainChatUsage & { totalTokens: number } => usage.totalTokens !== null);
    const max = Math.max(1, ...known.map(usage => usage.totalTokens));
    const overlays = known.map((usage) => {
      const pointIndex = points.indexOf(usage);
      const x = points.length <= 1 ? 50 : 5 + (pointIndex / (points.length - 1)) * 90;
      const y = 88 - (usage.totalTokens / max) * 72;
      return `<button type="button" data-action="select-usage" data-usage-id="${escapeHtml(usage.id)}" class="stx-memory-usage-chart-point" style="--point-x:${x.toFixed(2)}%;--point-y:${y.toFixed(2)}%" aria-label="${escapeHtml(`${formatTime(usage.capturedAt)}，总 Token ${formatNumber(usage.totalTokens)}`)}"></button>`;
    }).join('');
    return `<section class="stx-memory-usage-chart"><div class="stx-memory-audit-section-head"><div><h3>Token 趋势</h3><p>最近 ${formatNumber(points.length)} 次生成；缺失 Token 不绘制为 0。</p></div></div><div class="stx-memory-usage-chart-stage"><canvas data-memory-usage-chart role="img" aria-label="最近主聊天生成的总 Token 趋势"></canvas>${overlays}</div><details class="stx-memory-usage-chart-table"><summary>查看趋势数据表</summary><div class="stx-memory-table-scroll"><table><thead><tr><th>时间</th><th>模型</th><th>总 Token</th></tr></thead><tbody>${points.map(usage => `<tr><td>${escapeHtml(formatTime(usage.capturedAt))}</td><td>${escapeHtml(usage.model ?? '未记录')}</td><td>${formatTokenCount(usage.totalTokens)}</td></tr>`).join('')}</tbody></table></div></details></section>`;
  };
  const drawUsageTrendChart = (): void => {
    if (navigator.userAgent.toLocaleLowerCase().includes('jsdom')) return;
    const canvas = root.querySelector<HTMLCanvasElement>('[data-memory-usage-chart]');
    if (!canvas) return;
    let context: CanvasRenderingContext2D | null = null;
    try { context = canvas.getContext('2d'); } catch { return; }
    if (!context) return;
    const points = [...visibleUsages()].sort((left, right) => left.capturedAt - right.capturedAt).slice(-30);
    const values = points.map(usage => usage.totalTokens);
    const known = values.filter((value): value is number => value !== null);
    const width = Math.max(320, Math.round(canvas.getBoundingClientRect().width || 640));
    const height = Math.max(180, Math.round(canvas.getBoundingClientRect().height || 220));
    const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.scale(ratio, ratio);
    context.clearRect(0, 0, width, height);
    const styles = getComputedStyle(root);
    const lineColor = styles.getPropertyValue('--stx-memory-accent').trim() || '#d7b86e';
    const gridColor = styles.getPropertyValue('--stx-memory-border').trim() || 'rgba(255,255,255,.12)';
    const fillColor = styles.getPropertyValue('--stx-memory-accent-soft').trim() || 'rgba(215,184,110,.12)';
    context.strokeStyle = gridColor;
    context.lineWidth = 1;
    for (let index = 0; index < 4; index += 1) {
      const y = 20 + (index / 3) * (height - 42);
      context.beginPath();
      context.moveTo(28, y);
      context.lineTo(width - 18, y);
      context.stroke();
    }
    if (!known.length) return;
    const max = Math.max(1, ...known);
    const coordinates = points.flatMap((usage, index) => {
      if (usage.totalTokens === null) return [];
      const x = points.length <= 1 ? width / 2 : 28 + (index / (points.length - 1)) * (width - 46);
      const y = height - 22 - (usage.totalTokens / max) * (height - 54);
      return [{ x, y }];
    });
    if (!coordinates.length) return;
    context.beginPath();
    context.moveTo(coordinates[0]!.x, height - 22);
    for (const point of coordinates) context.lineTo(point.x, point.y);
    context.lineTo(coordinates.at(-1)!.x, height - 22);
    context.closePath();
    context.fillStyle = fillColor;
    context.fill();
    context.beginPath();
    coordinates.forEach((point, index) => index === 0 ? context!.moveTo(point.x, point.y) : context!.lineTo(point.x, point.y));
    context.strokeStyle = lineColor;
    context.lineWidth = 2;
    context.stroke();
  };
  const renderAudit = (): string => {
    normalizeAuditSelection();
    const records = visibleAudits();
    const usages = visibleUsages();
    const selectedAudit = state.audits.find(record => record.id === state.selectedAuditId && records.some(item => item.id === record.id));
    const selectedUsage = state.usages.find(usage => usage.id === state.selectedUsageId && usages.some(item => item.id === usage.id));
    const aggregatePendingLabel = state.auditSummaryLoading ? '计算中' : '暂不可用';
    const hasAggregateProvider = Boolean(controller.getAuditSummary);
    const localPendingCount = state.audits.reduce((total, record) => total + record.unresolvedCount, 0);
    const pendingCount = state.auditSummary?.pendingIssueCount ?? (hasAggregateProvider ? undefined : localPendingCount);
    const currentFacts = state.overview?.factCount ?? state.libraryStats?.active ?? 0;
    const localRolledBack = state.audits.filter(record => record.status === 'rolled_back').length;
    const rolledBack = state.auditSummary?.rolledBackCount ?? (hasAggregateProvider ? undefined : localRolledBack);
    const models = [...new Set([
      ...(state.auditSummary?.models ?? []),
      ...state.usages.map(usage => usage.model).filter((value): value is string => Boolean(value)),
    ])].sort((left, right) => left.localeCompare(right, 'zh-CN'));
    const sumKnown = (field: 'promptTokens' | 'completionTokens' | 'totalTokens'): { value: number | null; known: number } => {
      const values = state.usages.map(usage => usage[field]).filter((value): value is number => value !== null);
      return { value: values.length ? values.reduce((total, value) => total + value, 0) : null, known: values.length };
    };
    const prompt = state.auditSummary?.promptTokens ?? sumKnown('promptTokens');
    const completion = state.auditSummary?.completionTokens ?? sumKnown('completionTokens');
    const total = state.auditSummary?.totalTokens ?? sumKnown('totalTokens');
    const incomplete = state.auditSummary?.incompleteUsageCount ?? (hasAggregateProvider ? undefined : state.usages.filter(usage => !usageComplete(usage)).length);
    const auditTotal = state.auditSummary?.auditTotal ?? state.auditTotal;
    const usageTotal = state.auditSummary?.usageTotal ?? state.usageTotal;
    const recordList = records.length || (popupUi && controller.listAuditRecordsPage)
      ? `<div class="stx-memory-audit-list" data-memory-page-list="audit">${popupUi ? '' : records.map(renderAuditRecord).join('')}</div>`
      : renderEmpty('没有符合条件的审计记录', '调整搜索、状态或待处理筛选后重试。');
    const usageList = usages.length || (popupUi && controller.getMainChatUsagePage)
      ? `<div class="stx-memory-usage-table" role="region" aria-label="主聊天 Token 用量"><div class="stx-memory-usage-table-head" aria-hidden="true"><span>模型 / 时间</span><span>Prompt</span><span>Completion</span><span>总计</span><span>完整性</span></div><div class="stx-memory-usage-list" data-memory-page-list="usage">${popupUi ? '' : usages.map(renderUsageRecord).join('')}</div></div>`
      : renderEmpty('没有符合条件的 Token 记录', '调整模型或完整性筛选后重试。');
    const toolbar = state.auditTab === 'records'
      ? `<div class="stx-memory-audit-toolbar"><label class="stx-memory-audit-search"><span class="stx-memory-sr-only">搜索审计记录</span><ss-helper-icon name="magnifying-glass" decorative></ss-helper-icon><input id="stx-memory-audit-query" ${uiControl('input')} type="search" value="${escapeHtml(state.auditQuery)}" data-audit-input="query" placeholder="搜索批次、请求 ID、来源或错误码"></label><label><span class="stx-memory-sr-only">审计状态</span><select ${uiControl('select')} data-audit-select="status"><option value="all" ${state.auditStatus === 'all' ? 'selected' : ''}>全部状态</option><option value="partial" ${state.auditStatus === 'partial' ? 'selected' : ''}>部分完成</option><option value="completed" ${state.auditStatus === 'completed' ? 'selected' : ''}>已完成</option><option value="rolled_back" ${state.auditStatus === 'rolled_back' ? 'selected' : ''}>已回滚</option></select></label><button ${uiControl('toggle')} type="button" data-action="toggle-audit-issues" aria-pressed="${state.auditIssuesOnly}">只看待处理</button><button ${uiButton('neutral', 'sm')} type="button" data-action="export-audit"><ss-helper-icon name="download" decorative></ss-helper-icon>导出 JSON</button></div>`
      : `<div class="stx-memory-audit-toolbar"><label class="stx-memory-audit-search"><span class="stx-memory-sr-only">搜索 Token 用量</span><ss-helper-icon name="magnifying-glass" decorative></ss-helper-icon><input id="stx-memory-usage-query" ${uiControl('input')} type="search" value="${escapeHtml(state.usageQuery)}" data-usage-input="query" placeholder="搜索模型、Provider 或消息 ID"></label><label><span class="stx-memory-sr-only">模型</span><select ${uiControl('select')} data-usage-select="model"><option value="">全部模型</option>${models.map(model => `<option value="${escapeHtml(model)}" ${state.usageModel === model ? 'selected' : ''}>${escapeHtml(model)}</option>`).join('')}</select></label><label><span class="stx-memory-sr-only">Token 完整性</span><select ${uiControl('select')} data-usage-select="completeness"><option value="all" ${state.usageCompleteness === 'all' ? 'selected' : ''}>全部完整性</option><option value="complete" ${state.usageCompleteness === 'complete' ? 'selected' : ''}>完整</option><option value="missing" ${state.usageCompleteness === 'missing' ? 'selected' : ''}>有缺失</option></select></label><button ${uiButton('neutral', 'sm')} type="button" data-action="export-usage"><ss-helper-icon name="download" decorative></ss-helper-icon>导出 CSV</button></div>`;
    const metrics = state.auditTab === 'records'
      ? [['总记录', hasAggregateProvider && !state.auditSummary ? aggregatePendingLabel : formatNumber(auditTotal), 'list-check'], ['待处理', pendingCount === undefined ? aggregatePendingLabel : formatNumber(pendingCount), 'triangle-exclamation'], ['当前事实', formatNumber(currentFacts), 'database'], ['已回滚', rolledBack === undefined ? aggregatePendingLabel : formatNumber(rolledBack), 'rotate-left']]
      : [['用量记录', formatNumber(usageTotal), 'list-check'], ['Prompt', hasAggregateProvider && !state.auditSummary ? aggregatePendingLabel : prompt.value === null ? '未返回' : formatNumber(prompt.value), 'arrow-up'], ['Completion', hasAggregateProvider && !state.auditSummary ? aggregatePendingLabel : completion.value === null ? '未返回' : formatNumber(completion.value), 'arrow-down'], ['缺失记录', incomplete === undefined ? aggregatePendingLabel : formatNumber(incomplete), 'triangle-exclamation']];
    const usageSummaryNote = hasAggregateProvider && !state.auditSummary
      ? state.auditSummaryLoading ? '正在后台计算完整 Token 汇总；列表与详情可继续使用。' : 'Token 汇总暂不可用；列表中的缺失值仍保留为“未返回”。'
      : `已返回汇总：Prompt ${prompt.known}/${usageTotal}，Completion ${completion.known}/${usageTotal}，总计 ${total.known}/${usageTotal}。缺失值始终保留为“未返回”。`;
    return `<div class="stx-memory-audit-shell" data-audit-tab="${state.auditTab}" data-audit-mobile-view="${state.auditMobileView}"><div class="stx-memory-audit-tabs" ${uiControl('segmented')} role="tablist" aria-label="审计视图"><button type="button" role="tab" data-action="audit-tab" data-audit-tab="records" aria-selected="${state.auditTab === 'records'}">操作记录</button><button type="button" role="tab" data-action="audit-tab" data-audit-tab="usage" aria-selected="${state.auditTab === 'usage'}">Token 用量</button></div><section class="stx-memory-audit-metric-grid" aria-label="${state.auditTab === 'records' ? '操作记录汇总' : 'Token 用量汇总'}">${metrics.map(([label, value, icon]) => `<article><span aria-hidden="true"><ss-helper-icon name="${icon}" decorative></ss-helper-icon></span><div><small>${label}</small><strong>${value}</strong></div></article>`).join('')}</section>${state.auditTab === 'usage' ? `<p class="stx-memory-usage-known-note">${usageSummaryNote}</p>` : ''}${toolbar}${state.auditTab === 'usage' ? renderUsageTrend(usages) : ''}<div class="stx-memory-audit-split"><section class="stx-memory-audit-master"><div class="stx-memory-audit-list-title"><h3>${state.auditTab === 'records' ? '操作记录' : '用量明细'}</h3><span>${formatNumber(state.auditTab === 'records' ? records.length : usages.length)} 条</span></div>${state.auditTab === 'records' ? recordList : usageList}</section>${state.auditTab === 'records' ? renderAuditDetail(selectedAudit) : renderUsageDetail(selectedUsage)}</div></div>`;
  };
  const renderData = (): string => {
    const sqlite = state.sqlite;
    if (!sqlite) return renderEmpty('暂无存储状态', '点击刷新或稍后重试。');
    const schemaMatches = sqlite.schemaVersion === EXPECTED_SQLITE_SCHEMA_VERSION;
    const tableEntries = Object.entries(sqlite.tableCounts).sort(([left], [right]) => left.localeCompare(right));
    const chatUsageRatio = Math.max(0, Math.min(1, sqlite.currentChatUsageRatio));
    const databaseSize = sqlite.databaseSizeBytes > 0 ? formatBytes(sqlite.databaseSizeBytes) : '暂不可用';
    return `<section class="stx-memory-panel stx-memory-storage-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">SQLite 唯一存储</span><h3>${sqlite.connected ? '已连接' : '不可用'}</h3></div>${renderStatusChip(sqlite.connected ? '服务正常' : '不可用', sqlite.connected ? 'success' : 'error')}</div><dl class="stx-memory-maintenance-grid"><div><dt>SDK / 协议 / Schema</dt><dd>${escapeHtml(sqlite.serverVersion)} / v${sqlite.protocolVersion} / v${sqlite.schemaVersion}</dd></div><div><dt>SQLite / WAL</dt><dd>${escapeHtml(sqlite.sqliteVersion)} / ${escapeHtml(sqlite.walMode)}</dd></div><div><dt>Node.js</dt><dd>${escapeHtml(sqlite.nodeVersion)}</dd></div><div><dt>数据库 / WAL 占用</dt><dd>${escapeHtml(databaseSize)}</dd></div></dl><div class="stx-memory-chat-storage"><div class="stx-memory-chat-storage-head"><span><span class="stx-memory-storage-icon" aria-hidden="true"><ss-helper-icon name="hard-drive" decorative></ss-helper-icon></span><span><small>本聊天记忆占用</small><strong>${escapeHtml(formatBytes(sqlite.currentChatSizeBytes))}</strong></span></span><strong>${escapeHtml(formatPercent(chatUsageRatio))}</strong></div><progress ${uiControl('progress')} max="1" value="${chatUsageRatio}">${escapeHtml(formatPercent(chatUsageRatio))}</progress><p>占当前角色全部 Memory 数据；统计包含事实、证据、批次、Usage、召回日志和向量。</p></div><p class="stx-memory-muted stx-memory-path">相对路径：${escapeHtml(sqlite.databasePath)}</p><div class="stx-memory-progress-copy"><span>向量覆盖率</span><strong>${formatPercent(sqlite.vectorCoverage.ratio)}</strong></div><progress ${uiControl('progress')} max="1" value="${Math.max(0, Math.min(1, sqlite.vectorCoverage.ratio))}">${formatPercent(sqlite.vectorCoverage.ratio)}</progress>${schemaMatches ? '' : '<p class="stx-memory-inline-alert" role="alert">Schema 版本不匹配，请重启酒馆并确认服务端插件已更新。</p>'}${sqlite.failure ? (() => { const diagnostic = describeSSHelperFailure(sqlite.failure); return `<p class="stx-memory-inline-alert" role="alert">${escapeHtml(diagnostic.reasonCode)} · ${escapeHtml(diagnostic.title)}：${escapeHtml(diagnostic.reason)} ${escapeHtml(diagnostic.action)}${diagnostic.requestId ? ` · 请求 ID：${escapeHtml(diagnostic.requestId)}` : ''}</p>`; })() : ''}<details class="stx-memory-table-details"><summary>各表记录数与估算占用</summary><div class="stx-memory-table-list">${tableEntries.length ? tableEntries.map(([name, count]) => `<div><span>${escapeHtml(name)}</span><strong>${formatNumber(count)}</strong><small>${sqlite.tableBytes[name] == null ? 'N/A' : escapeHtml(formatBytes(sqlite.tableBytes[name]!))}</small></div>`).join('') : '<p class="stx-memory-muted">暂无表统计。</p>'}</div></details></section><section class="stx-memory-panel stx-memory-maintenance-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">备份与恢复</span><h3>维护工具</h3></div></div><div class="stx-memory-maintenance-actions"><button class="stx-memory-maintenance-action" ${uiControl('button', 'neutral')} type="button" data-action="export"><span class="stx-memory-maintenance-icon" aria-hidden="true"><ss-helper-icon name="file-export" decorative></ss-helper-icon></span><span><strong>导出 Memory 归档</strong><small>下载完整数据快照</small></span><span class="stx-memory-maintenance-chevron" aria-hidden="true"><ss-helper-icon name="chevron-right" decorative></ss-helper-icon></span></button><button class="stx-memory-maintenance-action" ${uiControl('button', 'neutral')} type="button" data-action="integrity" ${state.busyAction ? 'disabled' : ''}><span class="stx-memory-maintenance-icon" aria-hidden="true"><ss-helper-icon name="shield-halved" decorative></ss-helper-icon></span><span><strong>完整性检查</strong><small>检查 SQLite 数据结构</small></span><span class="stx-memory-maintenance-chevron" aria-hidden="true"><ss-helper-icon name="chevron-right" decorative></ss-helper-icon></span></button></div><div class="stx-memory-integrity-result" aria-live="polite"><span class="stx-memory-state-icon" aria-hidden="true"><ss-helper-icon name="circle-info" decorative></ss-helper-icon></span><span><strong>检查状态</strong><small>${escapeHtml(state.integrityText)}</small></span></div><section class="stx-memory-danger-zone"><div class="stx-memory-danger-heading"><span class="stx-memory-danger-icon" aria-hidden="true"><ss-helper-icon name="triangle-exclamation" decorative></ss-helper-icon></span><span><strong>危险操作</strong><small>执行前需要再次确认，聊天原文不会被删除。</small></span></div><div class="stx-memory-danger-actions">${state.dangerConfirm === 'current' ? `<div class="stx-memory-confirm-panel"><p>确认清空当前聊天来源？其他聊天仍有证据支持的事实会保留。</p><button ${uiControl('button', 'danger')} type="button" data-action="confirm-clear-current">确认清空</button><button ${uiControl('button', 'neutral')} type="button" data-action="cancel-danger">取消</button></div>` : `<button class="stx-memory-danger-action" ${uiControl('button', 'danger')} type="button" data-action="clear-current"><span class="stx-memory-danger-action-icon" aria-hidden="true"><ss-helper-icon name="eraser" decorative></ss-helper-icon></span><span class="stx-memory-danger-action-label">清空当前聊天来源</span></button>`}${state.dangerConfirm === 'all' ? `<div class="stx-memory-confirm-panel"><p>输入“清空全部记忆”后确认，此操作无法撤销。</p><input ${uiControl('input')} data-clear-all-text placeholder="清空全部记忆"><button ${uiControl('button', 'danger')} type="button" data-action="confirm-clear-all">确认清空全部</button><button ${uiControl('button', 'neutral')} type="button" data-action="cancel-danger">取消</button></div>` : `<button class="stx-memory-danger-action" ${uiControl('button', 'danger')} type="button" data-action="clear-all"><span class="stx-memory-danger-action-icon" aria-hidden="true"><ss-helper-icon name="trash-can" decorative></ss-helper-icon></span><span class="stx-memory-danger-action-label">清空全部角色记忆</span></button>`}</div></section></section>`;
  };
  const renderPage = (): string => {
    if (state.loading) return renderLoading('正在读取记忆工作台…');
    if (state.errorDiagnostic && !state.overview) return renderErrorDetails(state.errorDiagnostic, 'retry-load');
    if (state.pageLoading) return renderLoading();
    if (state.pageError) return renderErrorDetails(state.pageError, 'retry-page');
    const actionError = state.actionError ? renderErrorDetails(state.actionError, 'dismiss-error') : '';
    const content = state.page === 'overview' ? renderOverview()
      : state.page === 'actors' ? renderActors()
        : state.page === 'inventory' ? renderInventory()
          : state.page === 'scenes' ? renderScenes()
            : state.page === 'library' ? renderLibrary()
              : state.page === 'actor-memory' ? renderActorMemory()
                : state.page === 'profiles' ? renderProfiles()
                  : state.page === 'dreams' ? renderDreams()
                    : state.page === 'initialize' ? renderInitialize()
                      : state.page === 'recall' ? `${renderRecall()}<section class="stx-memory-panel stx-memory-graph-inline"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">关系图谱</span><h3>已验证事实关系</h3></div></div>${renderGraph()}</section>`
                        : state.page === 'graph' ? renderGraph()
                          : state.page === 'audit' ? renderAudit() : renderData();
    return `${actionError}${content}`;
  };
  const render = (): void => {
    traceMemoryStartup('workbench:render-begin');
    inventoryCardModel = undefined;
    const overview = state.overview;
    const currentPage = PAGES.find((page) => page.id === state.page) ?? INTERNAL_PAGES.find((page) => page.id === state.page) ?? PAGES[0]!;
    const statusTone = overview?.status === 'error' ? 'error' : overview?.status === 'working' ? 'warning' : overview?.status === 'ready' ? 'success' : 'neutral';
    const runtimeDiagnostic = !overview ? undefined : !overview.llmAvailable
      ? describeMemoryError(
          { reasonCode: 'MEMORY_LLM_CLIENT_UNAVAILABLE', stage: 'memory.ui.health' },
          'MEMORY_LLM_CLIENT_UNAVAILABLE',
          'health',
        )
      : overview.status === 'error'
        ? overview.errorDiagnostic ?? describeMemoryError(overview.failure, 'INTERNAL_ERROR', 'health')
        : undefined;
    const alertMarkup = runtimeDiagnostic ? `<div class="stx-memory-alert">${renderErrorDetails(runtimeDiagnostic, 'refresh-health')}</div>` : '';
    const chatIdentity = formatChatIdentity(overview);
    const chatStorageLabel = !overview?.bound ? '—' : state.storageUsageStatus === 'loading' ? '计算中' : state.storageUsageStatus === 'error' ? '暂不可用' : formatBytes(overview.currentChatSizeBytes ?? 0);
    const chatStorageRatio = !overview?.bound ? '—' : state.storageUsageStatus === 'loading' ? '计算中' : state.storageUsageStatus === 'error' ? '暂不可用' : formatPercent(overview.currentChatUsageRatio ?? 0);
    const sceneHeader = state.page === 'scenes' ? getSceneEventsHeader(sceneEventsState()) : undefined;
    const pageDescription = sceneHeader?.description ?? currentPage.description;
    const pageTitle = state.page === 'initialize' ? '初始化记忆' : currentPage.label;
    const pageHeadingAction = `<div class="stx-memory-heading-actions"><button class='stx-memory-page-refresh' ${uiButton('neutral', 'sm')} type='button' data-action='refresh' ${state.busyAction ? 'disabled' : ''} aria-label='刷新当前页面'><ss-helper-icon name='rotate' decorative></ss-helper-icon>刷新</button>${state.page === 'inventory' ? `<button ${uiButton('primary', 'sm')} type="button" data-action="inventory-create-open" ${!controller.createInventoryItem || state.busyAction ? 'disabled' : ''}><ss-helper-icon name="plus-large" decorative></ss-helper-icon>新增物品</button>` : ''}</div>`;
    root.innerHTML = `<div class="stx-memory-statusbar"><div class="stx-memory-chat-identity"><span class="stx-memory-kicker">当前聊天</span><strong>${escapeHtml(chatIdentity.label)}</strong></div><div><span class="stx-memory-kicker">运行状态</span>${renderStatusChip(overview ? translateOverviewStatus(overview.status) : '读取中', statusTone)}</div><div><span class="stx-memory-kicker">记忆数量</span><strong>${overview ? formatNumber(overview.factCount) : '—'}</strong></div><div class="stx-memory-status-storage"><span class="stx-memory-kicker">本聊天记忆占用</span><strong>${escapeHtml(chatStorageLabel)}</strong><small>占角色记忆 ${escapeHtml(chatStorageRatio)}</small></div><div><span class="stx-memory-kicker">大语言模型</span>${renderStatusChip(overview ? (overview.llmAvailable ? '可用' : '不可用') : '读取中', overview?.llmAvailable ? 'success' : overview ? 'warning' : 'neutral')}</div>${renderOverviewRouteStatus('向量模型', overview?.embedding)}${renderOverviewRouteStatus('重排序模型', overview?.rerank)}${alertMarkup}</div><div class="stx-memory-workspace-layout"><nav class="stx-memory-nav" aria-label="记忆工作台页面"><span class="stx-memory-nav-label">工作区</span>${PAGES.map((page) => `<button class="stx-memory-nav-item" type="button" data-action="navigate" data-page="${page.id}" aria-current="${page.id === state.page ? 'page' : 'false'}"><ss-helper-icon name="${page.icon}" decorative></ss-helper-icon><span><strong>${page.label}</strong><small>${page.description}</small></span></button>`).join('')}<div class='stx-memory-nav-meta'>记忆插件 v${escapeHtml(memoryPluginConfig.manifest.version)}</div></nav><main class="stx-memory-main"><header class="stx-memory-page-heading"><div><h2>${pageTitle}</h2><p>${escapeHtml(pageDescription)}</p></div>${pageHeadingAction}</header><section class="stx-memory-page-content" tabindex="-1">${renderPage()}</section><div class="stx-memory-internal-routes" hidden aria-hidden="true">${INTERNAL_PAGES.map((page) => `<button type="button" data-action="navigate-internal" data-page="${page.id}" aria-current="${page.id === state.page ? 'page' : 'false'}">${page.label}</button>`).join('')}</div></main></div>`;
    traceMemoryStartup('workbench:dom-rendered');
    popupUi?.refreshControls(root);
    syncInventorySplitters();
    const inventoryCardPlaceholder = root.querySelector<HTMLElement>('[data-inventory-card-three-host]');
    const cardModel = inventoryCardModel as InventoryCardViewModel | undefined;
    const cardModelKey = cardModel ? serializeInventoryCardModel(cardModel) : '';
    const activeInventoryCardId = inventoryCardMountingItemId || inventoryCardRendererItemId;
    const activeInventoryCardModelKey = inventoryCardMountingModelKey || inventoryCardRendererModelKey;
    const restoredInventoryCardHost = inventoryCardHostToRestore;
    const canReuseInventoryCardHost = Boolean(
      inventoryCardPlaceholder
      && restoredInventoryCardHost
      && cardModel
      && state.page === 'inventory',
    );
    const inventoryCardAlreadyCurrent = Boolean(
      cardModel
      && activeInventoryCardId === cardModel.id
      && activeInventoryCardModelKey === cardModelKey,
    );
    const inventoryRendererAlreadyCurrent = Boolean(
      inventoryCardRenderer
      && cardModel
      && inventoryCardRendererItemId === cardModel.id
      && inventoryCardRendererModelKey === cardModelKey,
    );
    inventoryCardHostToRestore = undefined;
    let inventoryCardHost = inventoryCardPlaceholder;
    if (canReuseInventoryCardHost && inventoryCardPlaceholder && restoredInventoryCardHost) {
      if (inventoryCardPlaceholder.dataset.inventoryTransition === 'entering'
        && restoredInventoryCardHost.dataset.inventoryTransition !== 'entering') {
        restoredInventoryCardHost.dataset.inventoryTransition = 'entering';
      }
      inventoryCardPlaceholder.replaceWith(restoredInventoryCardHost);
      inventoryCardHost = restoredInventoryCardHost;
    } else if (restoredInventoryCardHost) {
      disposeInventoryCardRenderer();
    }
    if (inventoryCardHost && cardModel) {
      const cardHost = inventoryCardHost;
      const token = inventoryCardRendererToken;
      const syncFlipButton = (flipped: boolean, ready: boolean): void => {
        inventoryCardFlipped = flipped;
        const button = root.querySelector<HTMLButtonElement>('[data-action="inventory-card-flip"]');
        if (!button) return;
        button.disabled = !ready || cardHost.classList.contains('is-webgl-unavailable');
        button.setAttribute('aria-pressed', String(flipped));
        button.setAttribute('aria-label', flipped ? '显示卡牌正面' : '显示卡牌背面');
        const label = button.querySelector('span');
        if (label) label.textContent = flipped ? '正面' : '翻面';
      };
      if (inventoryCardAlreadyCurrent) {
        syncFlipButton(inventoryCardFlipped, inventoryRendererAlreadyCurrent);
      } else if (canReuseInventoryCardHost && inventoryCardRenderer) {
        const updatingRenderer = inventoryCardRenderer;
        inventoryCardMountingItemId = cardModel.id;
        inventoryCardMountingModelKey = cardModelKey;
        inventoryCardFlipped = false;
        syncFlipButton(false, false);
        void updatingRenderer.update(cardModel).then(() => {
          if (disposed || token !== inventoryCardRendererToken || inventoryCardRenderer !== updatingRenderer
            || state.page !== 'inventory' || state.selectedInventoryItemId !== cardModel.id) return;
          inventoryCardRendererItemId = cardModel.id;
          inventoryCardRendererModelKey = cardModelKey;
          inventoryCardMountingItemId = '';
          inventoryCardMountingModelKey = '';
          if (inventoryEnteringItemId === cardModel.id) startInventoryCardEnterTransition(cardModel.id, cardHost);
          syncFlipButton(false, true);
        }).catch(() => {
          if (disposed || token !== inventoryCardRendererToken || inventoryCardRenderer !== updatingRenderer) return;
          inventoryCardMountingItemId = '';
          inventoryCardMountingModelKey = '';
          updatingRenderer.enter();
          syncFlipButton(inventoryCardFlipped, true);
        });
      } else {
        if (restoredInventoryCardHost) disposeInventoryCardRenderer();
        inventoryCardMountingItemId = cardModel.id;
        inventoryCardMountingModelKey = cardModelKey;
        inventoryCardFlipped = false;
        void mountInventoryCardThree(cardHost, cardModel, {
          reduceMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
          entering: inventoryEnteringItemId === cardModel.id,
          onFlipChange: (flipped) => {
            if (disposed || token !== inventoryCardRendererToken || state.page !== 'inventory') return;
            syncFlipButton(flipped, true);
          },
        }).then((renderer) => {
          if (disposed || token !== inventoryCardRendererToken || state.page !== 'inventory' || state.selectedInventoryItemId !== cardModel.id) {
            renderer.dispose();
            return;
          }
          inventoryCardRenderer = renderer;
          inventoryCardRendererItemId = cardModel.id;
          inventoryCardRendererModelKey = cardModelKey;
          inventoryCardMountingItemId = '';
          inventoryCardMountingModelKey = '';
          if (inventoryEnteringItemId === cardModel.id) startInventoryCardEnterTransition(cardModel.id, cardHost);
          syncFlipButton(inventoryCardFlipped, true);
        }).catch(() => {
          if (disposed || token !== inventoryCardRendererToken) return;
          inventoryCardMountingItemId = '';
          inventoryCardMountingModelKey = '';
          const loading = cardHost.querySelector<HTMLElement>('.stx-memory-inventory-preview-loading');
          if (loading) loading.textContent = '三维预览暂不可用，物品详情和账本仍可使用。';
        });
      }
    } else if (state.page !== 'inventory' || !cardModel) {
      inventoryEnteringItemId = '';
    }
    const libraryListHost = state.page === 'library' && controller.listFactsPage
      ? root.querySelector<HTMLElement>('.stx-memory-library-fact-list')
      : null;
    if (popupUi && libraryListHost && controller.listFactsPage) {
      const options = {
        kindLabels: FACT_KIND_LABELS,
        statusLabels: FACT_STATUS_LABELS,
        formatTime: (value: number) => formatTime(value),
        formatSource: renderLibrarySourceReference,
        translateRecordStatus,
      };
      const where = [
        ...(state.selectedKinds.length === Object.keys(FACT_KIND_LABELS).length
          ? []
          : [{ field: 'kind', op: 'in' as const, value: state.selectedKinds }]),
        ...(state.selectedStatuses.length === Object.keys(FACT_STATUS_LABELS).length
          ? []
          : [{ field: 'status', op: 'in' as const, value: state.selectedStatuses }]),
      ];
      const orderBy = state.sort === 'confidence_desc'
        ? { field: 'confidence', direction: 'desc' as const }
        : state.sort === 'kind_asc'
          ? { field: 'kind', direction: 'asc' as const }
          : { field: 'updatedAt', direction: 'desc' as const };
      popupUi.mountList<MemoryUiFact>(libraryListHost, {
        id: `memory-library:${state.overview?.chatKey ?? 'unbound'}`,
        ariaLabel: '记忆块列表',
        queryKey: JSON.stringify([
          state.overview?.chatKey ?? '',
          state.query.trim(),
          state.selectedKinds,
          state.selectedStatuses,
          state.sort,
        ]),
        pageSize: 20,
        overscan: 6,
        maxCachedPages: 6,
        itemHeight: 116,
        itemGap: 8,
        selectable: true,
        selectedKey: state.selectedFactId,
        getKey: fact => fact.id,
        loadPage: ({ cursor, limit, signal }) => controller.listFactsPage!({
          ...(cursor === undefined ? {} : { cursor }),
          limit,
          signal,
          query: state.query.trim(),
          where,
          orderBy,
          includeTotal: true,
        }),
        renderItem: (fact, context) => {
          const shell = document.createElement('div');
          shell.innerHTML = renderMemoryLibraryFactRow(fact, context.selected, options);
          return (shell.firstElementChild as HTMLElement | null) ?? shell;
        },
        onSelect: (fact) => {
          state.selectedFactId = fact.id;
          if (!state.facts.some(item => item.id === fact.id)) state.facts = [...state.facts, fact];
          if (!state.libraryResults.some(item => item.id === fact.id)) state.libraryResults = [...state.libraryResults, fact];
          rerender();
        },
      });
      const selectedFact = state.libraryResults.find(item => item.id === state.selectedFactId)
        ?? state.facts.find(item => item.id === state.selectedFactId);
      if (selectedFact) {
        const evidenceHost = root.querySelector<HTMLElement>('[data-memory-detail-list="fact-evidence"]');
        if (evidenceHost) popupUi.mountList<import('../domain').MemoryEvidence>(evidenceHost, {
          id: `memory-fact-evidence:${state.overview?.chatKey ?? 'unbound'}`,
          ariaLabel: '事实来源证据',
          queryKey: JSON.stringify([state.overview?.chatKey ?? '', selectedFact.id, 'evidence']),
          pageSize: 20,
          overscan: 6,
          maxCachedPages: 6,
          estimatedItemHeight: 92,
          getKey: item => item.id,
          loadPage: ({ cursor, limit, signal }) => controller.loadMemoryPage!('evidence', {
            ...(cursor === undefined ? {} : { cursor }),
            limit,
            signal,
            filter: { factId: selectedFact.id },
            orderBy: { field: 'occurredAt', direction: 'desc' },
            includeTotal: true,
          }),
          renderItem: item => elementFromMarkup(`<blockquote class="stx-memory-library-evidence"><p>${escapeHtml(item.excerpt)}</p><footer>${renderLibrarySourceReference(item.sourceRef, 'evidence')}</footer></blockquote>`),
        });
        const mountStaticDetail = <T,>(
          selector: string,
          suffix: string,
          items: readonly T[],
          key: (item: T, index: number) => string,
          renderItem: (item: T) => HTMLElement,
        ): void => {
          const host = root.querySelector<HTMLElement>(selector);
          if (!host) return;
          popupUi.mountList<T>(host, {
            id: `memory-fact-${suffix}:${state.overview?.chatKey ?? 'unbound'}`,
            ariaLabel: suffix === 'sources' ? '事实来源引用' : '事实捕获记录',
            queryKey: JSON.stringify([selectedFact.id, suffix, items.length]),
            pageSize: 20,
            overscan: 6,
            maxCachedPages: 6,
            estimatedItemHeight: 44,
            getKey: (item) => key(item, items.indexOf(item)),
            loadPage: async ({ cursor, limit, signal }) => {
              if (signal.aborted) throw signal.reason;
              const offset = cursor ? Number(cursor) : 0;
              const pageItems = items.slice(offset, offset + limit);
              const next = offset + pageItems.length;
              return { items: pageItems, nextCursor: next < items.length ? String(next) : null, total: items.length };
            },
            renderItem,
          });
        };
        mountStaticDetail(
          '[data-memory-detail-list="fact-sources"]',
          'sources',
          selectedFact.sourceRefs,
          source => source,
          source => elementFromMarkup(`<div class="stx-memory-library-static-row">${renderLibrarySourceReference(source)}</div>`),
        );
        mountStaticDetail(
          '[data-memory-detail-list="fact-batches"]',
          'batches',
          selectedFact.auditBatches ?? [],
          item => `${item.jobId}:${item.batchIndex}`,
          item => elementFromMarkup(`<button ${uiButton('neutral', 'xs')} type="button" data-action="navigate" data-page="audit"><span>第 ${Math.max(1, Number(item.batchIndex) || 1)} 批 · ${escapeHtml(translateRecordStatus(item.status))}</span><small>${escapeHtml(item.jobId)}</small></button>`),
        );
      }
    }
    if (popupUi && controller.loadMemoryPage && state.page === 'actors') {
      const host = root.querySelector<HTMLElement>('.stx-memory-actor-list');
      if (host) {
        const pending = state.actorView === 'pending';
        popupUi.mountList<import('../domain').MemoryOwner | import('../domain').ActorCandidate>(host, {
          id: `memory-actors:${state.overview?.chatKey ?? 'unbound'}:${state.actorView}`,
          ariaLabel: pending ? '待确认人物列表' : '人物列表',
          queryKey: JSON.stringify([state.overview?.chatKey ?? '', state.actorView, state.actorQuery.trim(), state.actorStatus]),
          pageSize: 20,
          overscan: 6,
          maxCachedPages: 6,
          itemHeight: 70,
          itemGap: 8,
          selectable: true,
          selectedKey: pending ? state.selectedCandidateId : state.selectedActorId,
          getKey: item => pending ? (item as import('../domain').ActorCandidate).localId : (item as import('../domain').MemoryOwner).id,
          loadPage: ({ cursor, limit, signal }) => controller.loadMemoryPage!(
            pending ? 'actor-candidates' : 'actors',
            {
              ...(cursor === undefined ? {} : { cursor }),
              limit,
              signal,
              query: state.actorQuery.trim(),
              filter: !pending && state.actorStatus ? { status: state.actorStatus } : {},
              orderBy: { field: 'updatedAt', direction: 'desc' },
              includeTotal: true,
            },
          ),
          renderItem: (item, context) => {
            if (pending) {
              const candidate = item as import('../domain').ActorCandidate;
              return elementFromMarkup(`<button class="stx-memory-actor-row stx-memory-candidate-row" ${uiControl('button', 'neutral')} type="button" data-action="select-candidate" data-candidate-id="${escapeHtml(candidate.localId)}" aria-selected="${context.selected}"><span class="stx-memory-actor-symbol is-pending" aria-hidden="true"><ss-helper-icon name="user-clock" decorative></ss-helper-icon></span><span class="stx-memory-actor-row-copy"><strong>${escapeHtml(candidate.displayName)}</strong><small>${candidate.sourceRefs.length} 条来源</small></span><span class="stx-memory-actor-row-meta">${renderStatusChip('待确认', 'warning')}<small>${Math.round(candidate.confidence * 100)}%</small></span></button>`);
            }
            const actor = item as import('../domain').MemoryOwner;
            const aliasSummary = actor.aliases.length ? actor.aliases.slice(0, 3).join('、') : '暂无别名';
            return elementFromMarkup(`<button class="stx-memory-actor-row" ${uiControl('button', 'neutral')} type="button" data-action="select-actor" data-owner-id="${escapeHtml(actor.id)}" aria-selected="${context.selected}"><span class="stx-memory-actor-symbol" aria-hidden="true"><ss-helper-icon name="${actor.kind === 'actor' ? 'user' : actor.kind === 'world' ? 'globe' : actor.kind === 'narrator' ? 'microphone-lines' : actor.kind === 'player' ? 'user-pen' : 'circle-question'}" decorative></ss-helper-icon></span><span class="stx-memory-actor-row-copy"><strong>${escapeHtml(actor.displayName)}</strong><small>${escapeHtml(aliasSummary)}</small></span><span class="stx-memory-actor-row-meta">${renderStatusChip(actor.status === 'confirmed' ? '已确认' : actor.status === 'pending' ? '待确认' : '未识别', actor.status === 'confirmed' ? 'success' : 'warning')}<small>${Math.round(actor.confidence * 100)}%</small></span></button>`);
          },
          onSelect: (item) => {
            if (pending) {
              const candidate = item as import('../domain').ActorCandidate;
              state.selectedCandidateId = candidate.localId;
              if (!state.pendingActors.some(value => value.localId === candidate.localId)) state.pendingActors = [...state.pendingActors, candidate];
            } else {
              const actor = item as import('../domain').MemoryOwner;
              state.selectedActorId = actor.id;
              if (!state.actors.some(value => value.id === actor.id)) state.actors = [...state.actors, actor];
            }
            rerender();
          },
        });
      }
    }
    if (popupUi && controller.loadMemoryPage && state.page === 'scenes') {
      const host = root.querySelector<HTMLElement>('.stx-memory-scene-record-list');
      if (host) {
        type SceneRecord = import('../domain').SceneCast | import('../domain').MemoryEpisode | import('../domain').MemoryObservation;
        const resource: MemoryPageResource = state.sceneCategory === 'event' ? 'episodes' : state.sceneCategory === 'observation' ? 'observations' : 'scene-casts';
        const orderBy = state.sceneCategory === 'scene' ? { field: 'floor', direction: 'desc' as const } : { field: 'occurredAt', direction: 'desc' as const };
        popupUi.mountList<SceneRecord>(host, {
          id: `memory-scenes:${state.overview?.chatKey ?? 'unbound'}:${state.sceneCategory}`,
          ariaLabel: state.sceneCategory === 'event' ? '结构化事件列表' : state.sceneCategory === 'observation' ? '观察记录列表' : '即时场景列表',
          queryKey: JSON.stringify([state.overview?.chatKey ?? '', state.sceneCategory, state.sceneQuery.trim(), state.sceneFilter]),
          pageSize: 20,
          overscan: 6,
          maxCachedPages: 6,
          itemHeight: 116,
          itemGap: 8,
          selectable: true,
          selectedKey: state.sceneCategory === 'event' ? state.selectedEpisodeId : state.sceneCategory === 'observation' ? state.selectedObservationId : state.selectedSceneId,
          getKey: item => item.id,
          loadPage: ({ cursor, limit, signal }) => controller.loadMemoryPage!(resource, {
            ...(cursor === undefined ? {} : { cursor }),
            limit,
            signal,
            query: state.sceneQuery.trim(),
            orderBy,
            includeTotal: true,
          }),
          renderItem: (item) => elementFromMarkup(renderSceneEventRecordRow(sceneEventsState(), item)),
          onSelect: (item) => {
            if (state.sceneCategory === 'event') {
              const episode = item as import('../domain').MemoryEpisode;
              state.selectedEpisodeId = episode.id;
              if (!state.episodes.some(value => value.id === episode.id)) state.episodes = [...state.episodes, episode];
            } else if (state.sceneCategory === 'observation') {
              const observation = item as import('../domain').MemoryObservation;
              state.selectedObservationId = observation.id;
              if (!state.observations.some(value => value.id === observation.id)) state.observations = [...state.observations, observation];
            } else {
              const scene = item as import('../domain').SceneCast;
              state.selectedSceneId = scene.id;
              if (!state.scenes.some(value => value.id === scene.id)) state.scenes = [...state.scenes, scene];
            }
            rerender();
          },
        });
      }
    }
    if (popupUi && controller.loadMemoryPage && state.page === 'actor-memory') {
      const host = root.querySelector<HTMLElement>('.stx-memory-actor-memory-trace-list');
      if (host && state.actorMemorySelectedOwnerId) {
        const sortField = state.actorMemorySort === 'clarity_desc' ? 'clarity'
          : state.actorMemorySort === 'confidence_desc' ? 'beliefConfidence'
            : state.actorMemorySort === 'emotion_desc' ? 'emotionalSalience'
              : state.actorMemorySort === 'rehearsal_desc' ? 'rehearsalCount'
                : 'updatedAt';
        popupUi.mountList<import('../domain').ActorMemoryTrace>(host, {
          id: `memory-traces:${state.overview?.chatKey ?? 'unbound'}:${state.actorMemorySelectedOwnerId}`,
          ariaLabel: '角色记忆痕迹列表',
          queryKey: JSON.stringify([
            state.overview?.chatKey ?? '',
            state.actorMemorySelectedOwnerId,
            state.actorMemoryQuery.trim(),
            state.actorMemoryKnowledgeMode,
            state.actorMemoryPrivacy,
            state.actorMemoryLevel,
            state.actorMemorySort,
          ]),
          pageSize: 20,
          overscan: 6,
          maxCachedPages: 6,
          itemHeight: 112,
          selectable: true,
          selectedKey: state.actorMemorySelectedTraceId,
          getKey: trace => trace.id,
          loadPage: ({ cursor, limit, signal }) => controller.loadMemoryPage!('memory-traces', {
            ...(cursor === undefined ? {} : { cursor }),
            limit,
            signal,
            query: state.actorMemoryQuery.trim(),
            filter: {
              ownerId: state.actorMemorySelectedOwnerId,
              ...(state.actorMemoryKnowledgeMode ? { knowledgeMode: state.actorMemoryKnowledgeMode } : {}),
              ...(state.actorMemoryPrivacy ? { privacy: state.actorMemoryPrivacy } : {}),
            },
            orderBy: { field: sortField, direction: 'desc' },
            includeTotal: true,
          }),
          renderItem: trace => elementFromMarkup(renderActorMemoryTraceRow(actorMemoryState(), trace, {
            formatTime,
            renderSourceReference: renderLibrarySourceReference,
          })),
          onSelect: async (trace) => {
            state.actorMemorySelectedTraceId = trace.id;
            if (!state.actorTraces.some(value => value.id === trace.id)) state.actorTraces = [...state.actorTraces, trace];
            const [facts, observations] = await Promise.all([
              controller.loadMemoryPage!<MemoryUiFact>('facts', {
                limit: 1,
                where: [{ field: 'recordId', op: 'eq', value: trace.factId }],
              }),
              trace.sourceObservationIds.length
                ? controller.loadMemoryPage!<import('../domain').MemoryObservation>('observations', {
                    limit: Math.min(500, trace.sourceObservationIds.length),
                    where: [{ field: 'recordId', op: 'in', value: trace.sourceObservationIds }],
                  })
                : Promise.resolve({ items: [], nextCursor: null }),
            ]);
            for (const fact of facts.items) if (!state.facts.some(value => value.id === fact.id)) state.facts = [...state.facts, fact];
            for (const observation of observations.items) if (!state.observations.some(value => value.id === observation.id)) state.observations = [...state.observations, observation];
            rerender();
          },
        });
      }
    }
    if (popupUi && controller.loadMemoryPage && (state.page === 'profiles' || state.page === 'dreams')) {
      const resource: MemoryPageResource = state.page === 'profiles' ? 'profile-claims' : 'dream-jobs';
      const host = root.querySelector<HTMLElement>(`[data-memory-page-list="${state.page}"]`);
      if (host) popupUi.mountList<Record<string, unknown>>(host, {
        id: `memory-${state.page}:${state.overview?.chatKey ?? 'unbound'}`,
        ariaLabel: state.page === 'profiles' ? '画像与关系列表' : 'Dream 任务列表',
        queryKey: JSON.stringify([state.overview?.chatKey ?? '', state.page]),
        pageSize: 20,
        overscan: 6,
        maxCachedPages: 6,
        estimatedItemHeight: 104,
        getKey: item => String(item.id ?? `${item.ownerId ?? item.fromOwnerId ?? 'record'}:${item.updatedAt ?? item.createdAt ?? ''}`),
        loadPage: ({ cursor, limit, signal }) => controller.loadMemoryPage!(resource, {
          ...(cursor === undefined ? {} : { cursor }),
          limit,
          signal,
          orderBy: { field: 'updatedAt', direction: 'desc' },
          includeTotal: true,
        }),
        renderItem: (item) => state.page === 'profiles'
          ? elementFromMarkup(`<article class="stx-memory-evidence"><strong>${escapeHtml(String(item.ownerId ?? item.fromOwnerId ?? '主体'))}</strong><p>${escapeHtml(String(item.claim ?? ''))}</p><small>引用：${escapeHtml(Array.isArray(item.supportingTraceIds) ? item.supportingTraceIds.join('、') : '无')}</small></article>`)
          : elementFromMarkup(`<article class="stx-memory-evidence"><strong>${escapeHtml(String(item.ownerId ?? '主体'))}</strong>${renderStatusChip(String(item.status ?? 'queued'), item.status === 'applied' ? 'success' : item.status === 'failed' ? 'error' : 'neutral')}<p>阶段：${escapeHtml(String(item.phase ?? 'gather'))}</p><small>任务：${escapeHtml(String(item.id ?? ''))}</small>${controller.runActorDream && item.id ? `<button ${uiControl('button', 'neutral')} type="button" data-action="dream-dry-run" data-job-id="${escapeHtml(String(item.id))}">dry-run 预览</button>` : ''}</article>`),
      });
    }
    if (popupUi && state.page === 'audit') {
      const localPage = async <T,>(items: readonly T[], cursor: string | undefined, limit: number, signal: AbortSignal): Promise<MemoryPage<T>> => {
        if (signal.aborted) throw signal.reason;
        const offset = Math.max(0, Number(cursor ?? 0) || 0);
        const pageItems = items.slice(offset, offset + limit);
        const nextOffset = offset + pageItems.length;
        return {
          items: pageItems,
          nextCursor: nextOffset < items.length ? String(nextOffset) : null,
          total: items.length,
        };
      };
      if (state.auditTab === 'records') {
        const records = visibleAudits();
        const auditHost = root.querySelector<HTMLElement>('[data-memory-page-list="audit"]');
        if (auditHost) popupUi.mountList<MemoryAuditRecord>(auditHost, {
          id: `memory-audits:${state.overview?.chatKey ?? 'unbound'}`,
          ariaLabel: 'Capture 审计记录',
          queryKey: JSON.stringify([state.overview?.chatKey ?? '', state.auditQuery, state.auditStatus, state.auditIssuesOnly]),
          pageSize: 24,
          overscan: 8,
          maxCachedPages: 6,
          estimatedItemHeight: 112,
          getKey: record => record.id,
          loadPage: ({ cursor, limit, signal }) => controller.listAuditRecordsPage
            ? controller.listAuditRecordsPage(auditPageRequest(limit, { cursor, signal, includeTotal: true }))
            : localPage(records, cursor, limit, signal),
          renderItem: record => elementFromMarkup(renderAuditRecord(record)),
          selectable: true,
          selectedKey: state.selectedAuditId,
          onSelect: (record) => {
            state.selectedAuditId = record.id;
            if (!state.audits.some(item => item.id === record.id)) state.audits = [...state.audits, record];
            state.selectedRejectionIds = state.selectedRejectionIds.filter(id => record.issues.some(issue => (issue.rejectionId ?? issue.id) === id));
            state.auditMobileView = 'detail';
            rerender('#stx-memory-audit-detail-heading');
          },
        });
      } else {
        const usages = visibleUsages();
        const usageHost = root.querySelector<HTMLElement>('[data-memory-page-list="usage"]');
        if (usageHost) popupUi.mountList<MainChatUsage>(usageHost, {
          id: `memory-usage:${state.overview?.chatKey ?? 'unbound'}`,
          ariaLabel: '主聊天 Token 用量',
          queryKey: JSON.stringify([state.overview?.chatKey ?? '', state.usageQuery, state.usageModel, state.usageCompleteness]),
          pageSize: 30,
          overscan: 10,
          maxCachedPages: 6,
          estimatedItemHeight: 64,
          getKey: usage => usage.id,
          loadPage: ({ cursor, limit, signal }) => controller.getMainChatUsagePage
            ? controller.getMainChatUsagePage(usagePageRequest(limit, { cursor, signal, includeTotal: true }))
            : localPage(usages, cursor, limit, signal),
          renderItem: usage => elementFromMarkup(renderUsageRecord(usage)),
          selectable: true,
          selectedKey: state.selectedUsageId,
          onSelect: (usage) => {
            state.selectedUsageId = usage.id;
            if (!state.usages.some(item => item.id === usage.id)) state.usages = [...state.usages, usage];
            state.auditMobileView = 'detail';
            rerender('#stx-memory-usage-detail-heading');
            void loadUsageRecallDetail(usage);
          },
        });
      }
    }
    if (state.page === 'audit' && state.auditTab === 'usage') window.requestAnimationFrame(() => { if (!disposed) drawUsageTrendChart(); });
    refreshGraphMarquees(root);
    observeGraphMarqueeResize();
    traceMemoryStartup('workbench:controls-refreshed');
    root.querySelectorAll<HTMLInputElement>('[data-filter-all]').forEach((input) => {
      const selectedCount = Number(input.dataset.selectedCount ?? 0);
      const optionCount = Number(input.dataset.optionCount ?? 0);
      input.indeterminate = selectedCount > 0 && selectedCount < optionCount;
    });
    const graphHost = root.querySelector<HTMLElement>('[data-relationship-graph-three-host]');
    if (graphHost && state.graph && state.graphStatus?.enabled) {
      const view = graphView();
      const selectedEdgeId = state.selectedGraphNodeId ? '' : state.selectedGraphEdgeId && view.edges.some((edge) => edge.id === state.selectedGraphEdgeId) ? state.selectedGraphEdgeId : '';
      const selectedEventEdgeId = state.selectedGraphNodeId || selectedEdgeId ? '' : state.selectedGraphEventId && view.edges.some((edge) => edge.id === state.selectedGraphEventId && edge.kind === 'event') ? state.selectedGraphEventId : '';
      graphRenderer = mountRelationshipGraphThree(graphHost, {
        graph: localizeGraphPreview(state.graph),
        visibleEdgeIds: new Set(view.edges.map((edge) => edge.id)),
        selectedEdgeId,
        selectedEventEdgeId,
        selectedNodeId: state.selectedGraphNodeId,
        reduceMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
        onSelectEdge: (edgeId) => {
          if (disposed) return;
          const refocus = state.selectedGraphEdgeId === edgeId && !state.selectedGraphNodeId;
          state.selectedGraphEdgeId = edgeId;
          state.selectedGraphEventId = '';
          state.selectedGraphNodeId = '';
          syncGraphUi(true);
          if (refocus) graphRenderer?.focusEdge(edgeId);
        },
        onSelectNode: (nodeId) => {
          if (disposed) return;
          const refocus = state.selectedGraphNodeId === nodeId;
          state.selectedGraphNodeId = nodeId;
          state.selectedGraphEdgeId = '';
          state.selectedGraphEventId = '';
          syncGraphUi(true);
          if (refocus) graphRenderer?.focusNode(nodeId);
        },
      });
    }
    const sceneHost = root.querySelector<HTMLElement>('[data-scene-pixi-host]');
    const selectedScene = state.scenes.find((scene) => scene.id === state.selectedSceneId);
    if (sceneHost && selectedScene) {
      const token = sceneRendererToken;
      const updateSceneDetail = (): void => {
        const detail = root.querySelector<HTMLElement>('[data-scene-graph-detail]');
        if (detail) detail.innerHTML = renderSelectedSceneGraphDetail(sceneEventsState());
        root.querySelectorAll<HTMLElement>('[data-action="scene-focus-owner"]').forEach((button) => {
          button.setAttribute('aria-pressed', String(button.dataset.ownerId === state.selectedSceneOwnerId));
        });
        popupUi?.refreshControls(detail ?? root);
      };
      void mountSceneCastPixi(sceneHost, {
        scene: selectedScene,
        ownerName: (ownerId) => sceneGraphOwnerLabel(sceneEventsState(), ownerId),
        ownerKind: (ownerId) => sceneGraphOwnerKind(sceneEventsState(), ownerId),
        options: {
          showBoundaries: state.showSceneBoundaries,
          showSources: state.showSceneSources,
          showConfidence: state.showSceneConfidence,
          reduceMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
        },
        selectedOwnerId: state.selectedSceneOwnerId,
        onSelectOwner: (ownerId) => {
          if (disposed || token !== sceneRendererToken) return;
          state.selectedSceneOwnerId = ownerId;
          updateSceneDetail();
        },
        onSelectSource: openSceneSource,
        onZoomChange: (percent) => {
          if (disposed || token !== sceneRendererToken) return;
          const label = root.querySelector<HTMLElement>('[data-scene-zoom-label]');
          if (label) label.textContent = `${percent}%`;
        },
      }).then((renderer) => {
        if (disposed || token !== sceneRendererToken) {
          renderer.dispose();
          return;
        }
        sceneRenderer = renderer;
      }).catch(() => {
        if (!disposed && token === sceneRendererToken) {
          const fallback = sceneHost.querySelector<HTMLElement>('[data-scene-pixi-fallback]');
          fallback?.setAttribute('data-scene-pixi-status', 'failed');
        }
      });
    }
  };

  const updateGaugeZonePreview = (zone: HTMLElement, strength: number): void => {
    const traceId = zone.dataset.traceId ?? '';
    const factId = zone.dataset.factId ?? '';
    const trace = state.actorTraces.find(item => item.id === traceId);
    const fact = state.facts.find(item => item.id === factId);
    if (!trace || !fact) return;
    updateActorMemoryGaugeZone(zone, trace, fact, strength);
  };

  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const actionNode = target.closest<HTMLElement>('[data-action]');
    const clickedMemoryZone = target.closest<HTMLElement>('[data-actor-memory-zone]');
    if (!clickedMemoryZone) root.querySelectorAll<HTMLElement>('[data-actor-memory-zone].is-open').forEach(zone => zone.classList.remove('is-open'));
    const clickedFilter = target.closest<HTMLElement>('[data-multi-filter]');
    const closeOpenFilter = Boolean(state.openFilter && !clickedFilter);
    if (closeOpenFilter) state.openFilter = '';
    if (!actionNode || disposed) { if (closeOpenFilter) rerender(); return; }
    const action = actionNode.dataset.action;
    if (action === 'toggle-filter-menu') { const filter = actionNode.dataset.filterMenu as 'kind' | 'status'; state.openFilter = state.openFilter === filter ? '' : filter; rerender(`#stx-memory-${filter}-filter-trigger`); return; }
    if (action === 'navigate') { const page = actionNode.dataset.page as MemoryWorkbenchPage; if (PAGES.some((item) => item.id === page)) void loadPage(page); return; }
    if (action === 'navigate-internal') { const page = actionNode.dataset.page as MemoryWorkbenchPage; if (INTERNAL_PAGES.some((item) => item.id === page)) void loadPage(page); return; }
    if (action === 'audit-tab') {
      const tab = actionNode.dataset.auditTab;
      if (tab !== 'records' && tab !== 'usage') return;
      state.auditTab = tab;
      state.auditMobileView = 'list';
      normalizeAuditSelection();
      rerender(`[data-action="audit-tab"][data-audit-tab="${tab}"]`);
      if (tab === 'usage') {
        const usage = visibleUsages().find(item => item.id === state.selectedUsageId);
        if (usage) void loadUsageRecallDetail(usage);
      }
      return;
    }
    if (action === 'toggle-audit-issues') {
      state.auditIssuesOnly = !state.auditIssuesOnly;
      state.auditMobileView = 'list';
      normalizeAuditSelection();
      rerender('[data-action="toggle-audit-issues"]');
      scheduleAuditListRefresh('records', 0);
      return;
    }
    if (action === 'select-audit-record') {
      const auditId = actionNode.dataset.auditRecordId ?? '';
      const record = visibleAudits().find(item => item.id === auditId);
      if (!record) return;
      state.selectedAuditId = record.id;
      state.selectedRejectionIds = state.selectedRejectionIds.filter(id => record.issues.some(issue => (issue.rejectionId ?? issue.id) === id));
      state.auditMobileView = 'detail';
      rerender('#stx-memory-audit-detail-heading');
      return;
    }
    if (action === 'select-usage') {
      const usageId = actionNode.dataset.usageId ?? '';
      const usage = visibleUsages().find(item => item.id === usageId);
      if (!usage) return;
      state.selectedUsageId = usage.id;
      state.auditMobileView = 'detail';
      rerender('#stx-memory-usage-detail-heading');
      void loadUsageRecallDetail(usage);
      return;
    }
    if (action === 'audit-mobile-back') {
      const selector = state.auditTab === 'records'
        ? '[data-audit-record-id][aria-pressed="true"]'
        : '[data-usage-id][aria-pressed="true"]';
      state.auditMobileView = 'list';
      rerender(selector);
      return;
    }
    if (action === 'export-audit') {
      if (!controller.listAuditRecordsPage) {
        const count = downloadAuditExport(visibleAudits());
        toast('success', '审计记录已导出', `已导出 ${count} 条当前筛选结果。`, 'MEMORY_AUDIT_EXPORTED');
        return;
      }
      state.busyAction = 'export-audit';
      rerender();
      void collectAuditExportRecords().then((records) => {
        if (disposed) return;
        const count = downloadAuditExport(records);
        toast('success', '审计记录已导出', `已导出 ${count} 条当前筛选结果。`, 'MEMORY_AUDIT_EXPORTED');
      }).catch((error) => {
        if (disposed) return;
        const diagnostic = describeMemoryError(error, 'INTERNAL_ERROR', 'operation');
        toast('error', diagnostic.title, diagnostic.reason, diagnostic.reasonCode);
      }).finally(() => {
        if (!disposed) { state.busyAction = ''; rerender(); }
      });
      return;
    }
    if (action === 'export-usage') {
      if (!controller.getMainChatUsagePage) {
        const count = downloadUsageExport(visibleUsages());
        toast('success', 'Token 用量已导出', `已导出 ${count} 条当前筛选结果。`, 'MEMORY_USAGE_EXPORTED');
        return;
      }
      state.busyAction = 'export-usage';
      rerender();
      void collectUsageExportRecords().then((usages) => {
        if (disposed) return;
        const count = downloadUsageExport(usages);
        toast('success', 'Token 用量已导出', `已导出 ${count} 条当前筛选结果。`, 'MEMORY_USAGE_EXPORTED');
      }).catch((error) => {
        if (disposed) return;
        const diagnostic = describeMemoryError(error, 'INTERNAL_ERROR', 'operation');
        toast('error', diagnostic.title, diagnostic.reason, diagnostic.reasonCode);
      }).finally(() => {
        if (!disposed) { state.busyAction = ''; rerender(); }
      });
      return;
    }
    if (action === 'rollback-audit') {
      const auditId = actionNode.dataset.auditId ?? '';
      const record = state.audits.find(item => item.id === auditId && item.status !== 'rolled_back');
      if (!record || !controller.rollbackActorCapture || !popupUi) return;
      void popupUi.confirm({
        title: '确认回滚 Capture',
        message: `将撤销 Capture #${record.batchIndex + 1} 写入的事实、观察、痕迹与派生记录。此操作会保留审计记录。`,
        confirmLabel: '确认回滚',
        danger: true,
      }).then((confirmed) => {
        if (!confirmed || disposed) return;
        void runAction('rollback-actor-capture', () => controller.rollbackActorCapture!(auditId), 'Capture 已回滚', '多主体事实、观察、痕迹与派生记录已撤销。', 'MEMORY_ACTOR_CAPTURE_ROLLED_BACK', async () => { await loadPage('audit'); await refreshFacts(); });
      });
      return;
    }
    if (action === 'inventory-set-scope') {
      const scope = actionNode.dataset.scope;
      if (scope !== 'current' && scope !== 'catalog') return;
      state.inventoryScope = scope;
      state.inventoryEvents = [];
      void loadPage('inventory');
      return;
    }
    if (action === 'inventory-set-category') {
      const category = actionNode.dataset.category ?? '';
      if (category && !Object.hasOwn(INVENTORY_CATEGORY_LABELS, category)) return;
      state.inventoryCategory = category as WorkbenchState['inventoryCategory'];
      state.inventoryEvents = [];
      rerender();
      return;
    }
    if (action === 'inventory-set-view') {
      const view = actionNode.dataset.view;
      if (view !== 'grid' && view !== 'list') return;
      state.inventoryView = view;
      rerender(`[data-action="inventory-set-view"][data-view="${view}"]`);
      return;
    }
    if (action === 'inventory-set-operation') {
      const operation = actionNode.dataset.operation;
      if (operation !== 'set' && operation !== 'increase' && operation !== 'decrease' && operation !== 'remove') return;
      state.inventoryCommandOperation = operation;
      if (operation === 'increase' || operation === 'decrease' || (operation !== 'set' && state.inventoryCommandPrecision === 'unknown')) state.inventoryCommandPrecision = 'exact';
      rerender(`[data-action="inventory-set-operation"][data-operation="${operation}"]`);
      return;
    }
    if (action === 'inventory-card-flip') {
      const flipped = inventoryCardRenderer?.flip() ?? false;
      actionNode.setAttribute('aria-pressed', String(flipped));
      return;
    }
    if (action === 'inventory-select') {
      const itemId = actionNode.dataset.itemId ?? '';
      if (!itemId) return;
      requestInventorySelection(itemId);
      return;
    }
    if (action === 'inventory-create-open') {
      state.inventoryCreateOpen = true;
      rerender('#stx-memory-inventory-new-name');
      return;
    }
    if (action === 'inventory-create-cancel') {
      state.inventoryCreateOpen = false;
      state.inventoryNewName = '';
      state.inventoryNewAliases = '';
      state.inventoryNewCategory = 'other';
      rerender('[data-action="inventory-create-open"]');
      return;
    }
    if (action === 'inventory-create') {
      const canonicalName = state.inventoryNewName.trim();
      if (!canonicalName || !controller.createInventoryItem) return;
      const canonicalKey = canonicalName.normalize('NFKC').toLocaleLowerCase('zh-CN');
      const aliases = [...new Set(state.inventoryNewAliases.split(/[,，]/u)
        .map(value => value.normalize('NFKC').trim())
        .filter(value => value && value.toLocaleLowerCase('zh-CN') !== canonicalKey))];
      void runAction('inventory-create', async () => {
        const item = await controller.createInventoryItem!({ canonicalName, aliases, category: state.inventoryNewCategory });
        state.inventoryScope = 'catalog';
        state.inventoryCategory = '';
        state.selectedInventoryItemId = item.id;
        state.inventoryCreateOpen = false;
        state.inventoryNewName = '';
        state.inventoryNewAliases = '';
        state.inventoryNewCategory = 'other';
      }, '物品已新增', '物品目录已保存，可继续设置数量。', 'MEMORY_INVENTORY_ITEM_CREATED', () => loadPage('inventory'));
      return;
    }
    if (action === 'inventory-command') {
      const item = state.inventoryItems.find(entry => entry.id === state.selectedInventoryItemId && entry.status !== 'invalid');
      if (!item || !controller.applyInventoryCommand) return;
      const amount = state.inventoryCommandAmount.trim() === '' ? undefined : Number(state.inventoryCommandAmount);
      if (state.inventoryCommandOperation !== 'remove' && state.inventoryCommandPrecision !== 'unknown' && (!Number.isFinite(amount) || Number(amount) < 0)) {
        toast('warning', '数值无效', '请输入大于或等于 0 的数值。', 'INVALID_PAYLOAD');
        return;
      }
      if (state.inventoryCommandMeasure === 'coverage_days' && !['set', 'remove'].includes(state.inventoryCommandOperation)) {
        toast('warning', '操作不适用', '可维持天数只允许设置或移除，不能自动增减。', 'INVALID_PAYLOAD');
        return;
      }
      if (state.inventoryCommandPrecision === 'unknown' && state.inventoryCommandOperation !== 'set') {
        toast('warning', '精确度不适用', '数量未知只允许用于设置操作。', 'INVALID_PAYLOAD');
        return;
      }
      if (['increase', 'decrease'].includes(state.inventoryCommandOperation) && state.inventoryCommandPrecision !== 'exact') {
        toast('warning', '精确度不适用', '增加和减少必须基于精确数量。', 'INVALID_PAYLOAD');
        return;
      }
      const unit = state.inventoryCommandUnit.trim();
      if (!unit && !(state.inventoryCommandOperation === 'set' && state.inventoryCommandPrecision === 'unknown')) {
        toast('warning', '单位不能为空', '请填写当前计量类型对应的单位。', 'INVALID_PAYLOAD');
        return;
      }
      const current = state.inventoryStates.find(entry => entry.itemId === item.id
        && entry.measureKind === state.inventoryCommandMeasure
        && entry.unit.normalize('NFKC').trim().toLocaleLowerCase() === unit.normalize('NFKC').trim().toLocaleLowerCase());
      const reason: import('../domain').InventoryReason = state.inventoryCommandOperation === 'increase' ? 'acquire'
        : state.inventoryCommandOperation === 'decrease' ? 'consume'
          : state.inventoryCommandOperation === 'remove' ? 'discard' : 'manual_correction';
      void runAction('inventory-command', () => controller.applyInventoryCommand!({
        itemId: item.id,
        operation: state.inventoryCommandOperation,
        measureKind: state.inventoryCommandMeasure,
        ...(amount === undefined || state.inventoryCommandOperation === 'remove' || state.inventoryCommandPrecision === 'unknown' ? {} : { amount, rawAmount: state.inventoryCommandAmount.trim() }),
        unit,
        precision: state.inventoryCommandPrecision,
        reason,
        origin: 'manual',
        confidence: 1,
      }, {
        expectedRevision: current?.revision ?? 0,
        idempotencyKey: crypto.randomUUID(),
      }).then(() => undefined), '库存已更新', '变动已写入账本并同步当前状态。', 'MEMORY_INVENTORY_UPDATED', async () => {
        state.inventoryScope = 'current';
        await loadPage('inventory');
      });
      return;
    }
    if (action === 'inventory-invalidate') {
      const item = state.inventoryItems.find(entry => entry.id === state.selectedInventoryItemId && entry.status !== 'invalid');
      if (!item || !controller.invalidateInventoryItem || !popupUi) return;
      void popupUi.confirm({
        title: '确认作废错误物品',
        message: `“${item.canonicalName}”将从当前库存和全部目录中隐藏，历史账本仍会保留。`,
        confirmLabel: '确认作废',
        danger: true,
      }).then((confirmed) => {
        if (!confirmed || disposed) return;
        void runAction('inventory-invalidate', () => controller.invalidateInventoryItem!(item.id).then(() => undefined), '错误物品已作废', '历史账本仍然保留，该物品不再参与当前库存。', 'MEMORY_INVENTORY_ITEM_INVALIDATED', async () => {
          state.selectedInventoryItemId = '';
          await loadPage('inventory');
        });
      });
      return;
    }
    if (action === 'scene-set-category') {
      const category = actionNode.dataset.category;
      if (category !== 'scene' && category !== 'event' && category !== 'observation') return;
      state.sceneCategory = category;
      state.sceneQuery = '';
      state.sceneFilter = '';
      state.selectedSceneOwnerId = '';
      rerender();
      return;
    }
    if (action === 'scene-select-record' || action === 'scene-open-record') {
      const category = actionNode.dataset.category;
      const recordId = actionNode.dataset.recordId ?? '';
      if (category !== 'scene' && category !== 'event' && category !== 'observation') return;
      if (action === 'scene-open-record') {
        state.sceneCategory = category;
        state.sceneQuery = '';
        state.sceneFilter = '';
      }
      if (category === 'scene') {
        state.selectedSceneId = recordId;
        state.selectedSceneOwnerId = '';
      } else if (category === 'event') {
        state.selectedEpisodeId = recordId;
      } else {
        state.selectedObservationId = recordId;
      }
      rerender();
      return;
    }
    if (action === 'scene-open-source') {
      openSceneSource(actionNode.dataset.sourceRef ?? '');
      return;
    }
    if (action === 'scene-open-owner') {
      const ownerId = actionNode.dataset.ownerId ?? '';
      if (!ownerId) return;
      void loadPage('actors').then(() => {
        if (disposed) return;
        state.actorView = 'people';
        state.selectedActorId = ownerId;
        rerender();
      });
      return;
    }
    if (action === 'scene-correct-state') {
      const ownerId = actionNode.dataset.ownerId ?? '';
      const placement = actionNode.dataset.placement;
      if (!controller.correctCurrentSceneState || !ownerId || (placement !== 'present' && placement !== 'nearby' && placement !== 'exited' && placement !== 'viewpoint')) return;
      state.busyAction = `scene-correct:${ownerId}:${placement}`;
      rerender();
      void controller.correctCurrentSceneState({ ownerId, placement }).then(() => loadPage('scenes')).then(() => {
        if (!disposed) toast('success', '场景状态已纠正', '人工纠正已写入场景转移记录，并优先于低置信度推断。', 'MEMORY_SCENE_CORRECTED');
      }).catch((error: unknown) => {
        if (!disposed) toast('error', '场景纠正失败', '无法保存当前场景纠正。', safeErrorCode(error, 'MEMORY_SCENE_CORRECTION_FAILED'));
      }).finally(() => {
        if (!disposed) { state.busyAction = ''; rerender(); }
      });
      return;
    }
    if (action === 'scene-refresh') {
      void loadPage('scenes').then(() => {
        if (!disposed && !state.pageError) toast('success', '场景数据已刷新', '即时场景、事件与观察记录已经重新读取。', 'MEMORY_SCENES_REFRESHED');
      });
      return;
    }
    if (action === 'scene-graph-command') {
      const command = actionNode.dataset.command as SceneCastPixiCommand | undefined;
      if (command) sceneRenderer?.command(command);
      return;
    }
    if (action === 'scene-graph-toggle') {
      const option = actionNode.dataset.option;
      if (option === 'boundaries') state.showSceneBoundaries = !state.showSceneBoundaries;
      else if (option === 'sources') state.showSceneSources = !state.showSceneSources;
      else if (option === 'confidence') state.showSceneConfidence = !state.showSceneConfidence;
      else return;
      actionNode.setAttribute('aria-pressed', String(
        option === 'boundaries' ? state.showSceneBoundaries
          : option === 'sources' ? state.showSceneSources
            : state.showSceneConfidence,
      ));
      sceneRenderer?.setOptions({
        showBoundaries: state.showSceneBoundaries,
        showSources: state.showSceneSources,
        showConfidence: state.showSceneConfidence,
      });
      return;
    }
    if (action === 'scene-focus-owner') {
      const ownerId = actionNode.dataset.ownerId ?? '';
      if (!ownerId) return;
      state.selectedSceneOwnerId = ownerId;
      sceneRenderer?.focusOwner(ownerId);
      const detail = root.querySelector<HTMLElement>('[data-scene-graph-detail]');
      if (detail) detail.innerHTML = renderSelectedSceneGraphDetail(sceneEventsState());
      root.querySelectorAll<HTMLElement>('[data-action="scene-focus-owner"]').forEach((button) => {
        button.setAttribute('aria-pressed', String(button.dataset.ownerId === ownerId));
      });
      popupUi?.refreshControls(detail ?? root);
      return;
    }
    if (action === 'scene-show-event-observations') {
      const eventId = actionNode.dataset.eventId ?? '';
      const first = state.observations
        .filter((observation) => observation.episodeId === eventId)
        .sort((left, right) => right.occurredAt - left.occurredAt || left.id.localeCompare(right.id))[0];
      state.sceneCategory = 'observation';
      state.sceneQuery = '';
      state.sceneFilter = '';
      if (first) state.selectedObservationId = first.id;
      rerender();
      return;
    }
    if (action === 'actor-memory-select-owner') {
      state.actorMemorySelectedOwnerId = actionNode.dataset.ownerId ?? '';
      state.actorMemorySelectedTraceId = '';
      state.actorMemoryTab = 'overview';
      rerender();
      return;
    }
    if (action === 'actor-memory-toggle-group') {
      const group = actionNode.dataset.group;
      if (group !== 'people' && group !== 'system') return;
      state.actorMemoryCollapsedGroups = state.actorMemoryCollapsedGroups.includes(group)
        ? state.actorMemoryCollapsedGroups.filter(item => item !== group)
        : [...state.actorMemoryCollapsedGroups, group];
      rerender(`[data-action="actor-memory-toggle-group"][data-group="${group}"]`);
      return;
    }
    if (action === 'actor-memory-select-trace') {
      state.actorMemorySelectedTraceId = actionNode.dataset.traceId ?? '';
      state.actorMemoryTab = 'overview';
      rerender();
      if (window.matchMedia?.('(max-width: 760px)').matches) {
        window.setTimeout(() => root.querySelector<HTMLElement>('#stx-memory-actor-memory-inspector')?.scrollIntoView?.({ block: 'start' }), 0);
      }
      return;
    }
    if (action === 'actor-memory-set-tab') {
      const tab = actionNode.dataset.tab;
      if (tab !== 'overview' && tab !== 'source' && tab !== 'technical') return;
      state.actorMemoryTab = tab;
      rerender();
      return;
    }
    if (action === 'actor-memory-open-fact') {
      const factId = actionNode.dataset.factId ?? '';
      if (!factId) return;
      void loadPage('library').then(() => {
        if (disposed) return;
        state.query = '';
        state.selectedKinds = Object.keys(FACT_KIND_LABELS);
        state.selectedStatuses = Object.keys(FACT_STATUS_LABELS);
        state.libraryResults = state.facts;
        state.selectedFactId = factId;
        normalizeLibrarySelection();
        rerender();
      });
      return;
    }
    if (action === 'actor-memory-open-owner') {
      const ownerId = actionNode.dataset.ownerId ?? '';
      if (!ownerId) return;
      void loadPage('actors').then(() => {
        if (disposed) return;
        state.actorView = 'people';
        state.selectedActorId = ownerId;
        rerender();
      });
      return;
    }
    if (action === 'actor-memory-refresh') {
      void loadPage('actor-memory').then(() => {
        if (!disposed && !state.pageError) toast('success', '角色记忆已刷新', '人物、事实、观察和认知痕迹已经重新读取。', 'MEMORY_ACTOR_MEMORY_REFRESHED');
      });
      return;
    }
    if (action === 'actor-memory-toggle-gauge-zone') {
      event.stopPropagation();
      const open = actionNode.classList.contains('is-open');
      root.querySelectorAll<HTMLElement>('[data-actor-memory-zone].is-open').forEach(zone => zone.classList.remove('is-open'));
      if (!open) actionNode.classList.add('is-open');
      return;
    }
    if (action === 'dream-dry-run') {
      const jobId = actionNode.dataset.jobId;
      if (!jobId || !controller.runActorDream) return;
      void runAction('dream-dry-run', () => controller.runActorDream!(jobId, { dryRun: true }).then(() => undefined), 'Dream 预览完成', '本次 dry-run 未写入巩固结果。', 'MEMORY_DREAM_DRY_RUN_COMPLETED', () => loadPage('dreams'));
      return;
    }
    if (action === 'actor-tab') {
      state.actorView = actionNode.dataset.view === 'pending' ? 'pending' : 'people';
      state.renamingActorId = '';
      state.editingActorTraitsId = '';
      state.actorOperation = '';
      rerender();
      revealActorInspector();
      return;
    }
    if (action === 'select-actor') {
      state.actorView = 'people';
      state.selectedActorId = actionNode.dataset.ownerId ?? '';
      state.renamingActorId = '';
      state.editingActorTraitsId = '';
      state.actorOperation = '';
      rerender();
      return;
    }
    if (action === 'select-candidate') {
      const candidateId = actionNode.dataset.candidateId ?? '';
      const candidate = state.pendingActors.find(item => item.localId === candidateId);
      state.actorView = 'pending';
      state.selectedCandidateId = candidateId;
      state.candidateResolutionMode = candidate?.ownerRef ? 'existing' : state.actors.some(actor => actor.kind === 'actor') ? 'existing' : 'new';
      state.candidateTargetOwnerId = candidate?.ownerRef ?? state.actors.find(actor => actor.kind === 'actor')?.id ?? '';
      state.candidateCanonicalName = '';
      rerender();
      revealActorInspector();
      return;
    }
    if (action === 'select-candidate-aside') {
      const candidateId = actionNode.dataset.candidateId ?? '';
      const candidate = state.pendingActors.find(item => item.localId === candidateId);
      state.selectedCandidateId = candidateId;
      state.candidateResolutionMode = candidate?.ownerRef ? 'existing' : state.actors.some(actor => actor.kind === 'actor') ? 'existing' : 'new';
      state.candidateTargetOwnerId = candidate?.ownerRef ?? state.actors.find(actor => actor.kind === 'actor')?.id ?? '';
      state.candidateCanonicalName = '';
      rerender();
      return;
    }
    if (action === 'refresh-actors') { void loadPage('actors'); return; }
    if (action === 'start-actor-rename') {
      const actor = state.actors.find(item => item.id === state.selectedActorId);
      if (!actor || actor.kind !== 'actor') return;
      state.editingActorTraitsId = '';
      state.renamingActorId = actor.id;
      state.actorRenameValue = actor.displayName;
      rerender('#stx-memory-actor-rename-input');
      return;
    }
    if (action === 'cancel-actor-rename') {
      state.renamingActorId = '';
      state.actorRenameValue = '';
      rerender('#stx-memory-actor-rename-trigger');
      return;
    }
    if (action === 'save-actor-rename') {
      const ownerId = state.renamingActorId;
      const displayName = state.actorRenameValue.trim();
      if (!ownerId || !displayName || !controller.renameActor) {
        toast('warning', '名称不能为空', '请输入新的规范名称后再保存。', 'MEMORY_ACTOR_NAME_REQUIRED');
        return;
      }
      void runAction('rename-actor', () => controller.renameActor!(ownerId, displayName), '人物名称已更新', '新的规范名称和别名已经保存。', 'MEMORY_ACTOR_RENAMED', async () => {
        state.renamingActorId = '';
        state.actorRenameValue = '';
        await loadPage('actors');
      });
      return;
    }
    if (action === 'start-actor-traits') {
      const actor = state.actors.find(item => item.id === state.selectedActorId);
      if (!actor || actor.kind !== 'actor' || !controller.updateActorMemoryTraits) return;
      state.renamingActorId = '';
      state.editingActorTraitsId = actor.id;
      rerender('[data-actor-trait="half-life-days"]');
      return;
    }
    if (action === 'cancel-actor-traits') {
      state.editingActorTraitsId = '';
      rerender('[data-action="start-actor-traits"]');
      return;
    }
    if (action === 'save-actor-traits') {
      const ownerId = state.editingActorTraitsId;
      if (!ownerId || !controller.updateActorMemoryTraits) return;
      const readTrait = (name: string): number => Number(root.querySelector<HTMLInputElement>(`[data-actor-trait="${name}"]`)?.value ?? Number.NaN);
      const halfLifeDays = readTrait('half-life-days');
      const rehearsalGain = readTrait('rehearsal-gain');
      const emotionalGain = readTrait('emotional-gain');
      const interference = readTrait('interference');
      if (![halfLifeDays, rehearsalGain, emotionalGain, interference].every(Number.isFinite) || halfLifeDays < 1 || rehearsalGain < 0 || emotionalGain < 0 || interference < 0) {
        toast('warning', '记忆特性数值无效', '半衰期至少为 1 天，其余数值不能小于 0。', 'MEMORY_ACTOR_TRAITS_INVALID');
        return;
      }
      void runAction('update-actor-traits', () => controller.updateActorMemoryTraits!(ownerId, {
        halfLifeMs: Math.round(halfLifeDays * 24 * 60 * 60 * 1000),
        rehearsalGain,
        emotionalGain,
        interference,
      }), '人物记忆特性已更新', '新的衰减与强化参数已经保存。', 'MEMORY_ACTOR_TRAITS_UPDATED', async () => {
        state.editingActorTraitsId = '';
        await loadPage('actors');
      });
      return;
    }
    if (action === 'candidate-resolution-mode') {
      state.candidateResolutionMode = actionNode.dataset.mode === 'new' ? 'new' : 'existing';
      const candidate = state.pendingActors.find(item => item.localId === state.selectedCandidateId);
      if (state.candidateResolutionMode === 'existing' && !state.candidateTargetOwnerId) {
        state.candidateTargetOwnerId = candidate?.ownerRef ?? state.actors.find(actor => actor.kind === 'actor')?.id ?? '';
      }
      if (state.candidateResolutionMode === 'new') state.candidateCanonicalName = '';
      rerender(state.candidateResolutionMode === 'new' ? '#stx-memory-candidate-name' : '#stx-memory-candidate-target');
      return;
    }
    if (action === 'confirm-actor') {
      const candidateId = actionNode.dataset.candidateId;
      if (!candidateId || !controller.confirmActorCandidate) return;
      const resolution: import('../domain').ActorCandidateResolution = state.candidateResolutionMode === 'existing'
        ? { mode: 'existing', ownerId: state.candidateTargetOwnerId || state.pendingActors.find(candidate => candidate.localId === candidateId)?.ownerRef || state.actors.find(actor => actor.kind === 'actor')?.id || '' }
        : { mode: 'new', canonicalName: state.candidateCanonicalName.trim() };
      if ((resolution.mode === 'existing' && !resolution.ownerId) || (resolution.mode === 'new' && !resolution.canonicalName)) {
        toast('warning', '确认信息不完整', resolution.mode === 'existing' ? '请选择要归入的人物。' : '请输入新人物的规范名称。', 'MEMORY_ACTOR_RESOLUTION_REQUIRED');
        return;
      }
      void runAction('confirm-actor', () => controller.confirmActorCandidate!(candidateId, resolution), '人物归属已确认', '候选称呼、别名和来源已写入人物主档。', 'MEMORY_ACTOR_CONFIRMED', async () => {
        await loadPage('actors');
        state.actorView = state.pendingActors.length ? 'pending' : 'people';
      });
      return;
    }
    if (action === 'open-actor-operation') {
      const operation = actionNode.dataset.operation;
      if (operation !== 'merge' && operation !== 'split' && operation !== 'alias') return;
      const owner = state.actors.find(actor => actor.id === state.selectedActorId);
      if (!owner || owner.kind !== 'actor') return;
      const targets = state.actors.filter(actor => actor.kind === 'actor' && actor.id !== owner.id);
      const ownerAliases = state.actorAliases.filter(alias => alias.ownerId === owner.id);
      const initialAlias = operation === 'alias'
        ? actionNode.dataset.aliasId ?? ''
        : ownerAliases[0]?.value ?? owner.aliases[0] ?? '';
      state.actorOperation = operation;
      state.actorOperationAliasId = initialAlias;
      state.actorOperationTargetId = targets[0]?.id ?? '';
      state.actorOperationName = operation === 'split' ? initialAlias : '';
      rerender('#stx-memory-actor-operation-target, #stx-memory-actor-operation-alias');
      return;
    }
    if (action === 'close-actor-operation') {
      const operation = state.actorOperation;
      const aliasId = state.actorOperationAliasId;
      state.actorOperation = '';
      state.actorOperationAliasId = '';
      state.actorOperationTargetId = '';
      state.actorOperationName = '';
      const focusSelector = operation === 'merge' ? '#stx-memory-actor-merge-trigger'
        : operation === 'split' ? '#stx-memory-actor-split-trigger'
          : aliasId ? `[data-action="open-actor-operation"][data-alias-id="${aliasId}"]` : '';
      rerender(focusSelector);
      return;
    }
    if (action === 'confirm-actor-operation') {
      const owner = state.actors.find(actor => actor.id === state.selectedActorId);
      if (!owner || owner.kind !== 'actor') return;
      const operation = state.actorOperation;
      if (operation === 'merge' && controller.mergeActors) {
        const targetId = state.actorOperationTargetId || state.actors.find(actor => actor.kind === 'actor' && actor.id !== owner.id)?.id || '';
        if (!targetId || targetId === owner.id) {
          toast('warning', '请选择合并目标', '合并目标必须是另一个人物。', 'MEMORY_ACTOR_MERGE_TARGET_REQUIRED');
          return;
        }
        void runAction('merge-actors', () => controller.mergeActors!(owner.id, targetId), '人物已合并', '源人物的别名与关联记忆已迁入目标人物。', 'MEMORY_ACTORS_MERGED', async () => {
          state.selectedActorId = targetId;
          state.actorOperation = '';
          await loadPage('actors');
        });
        return;
      }
      if (operation === 'split' && controller.splitActor) {
        const aliasValue = state.actorOperationAliasId || owner.aliases[0] || '';
        const displayName = (state.actorOperationName || aliasValue).trim();
        if (!aliasValue || !displayName) {
          toast('warning', '拆分信息不完整', '请选择别名并填写新人物名称。', 'MEMORY_ACTOR_SPLIT_VALUES_REQUIRED');
          return;
        }
        void runAction('split-actor', () => controller.splitActor!(owner.id, aliasValue, displayName), '人物已拆分', '所选别名已建立为独立人物。', 'MEMORY_ACTOR_SPLIT', async () => {
          state.actorOperation = '';
          await loadPage('actors');
        });
        return;
      }
      if (operation === 'alias' && controller.correctActorAlias) {
        const aliasId = state.actorOperationAliasId;
        const targetId = state.actorOperationTargetId || state.actors.find(actor => actor.kind === 'actor' && actor.id !== owner.id)?.id || '';
        if (!aliasId || !targetId || targetId === owner.id) {
          toast('warning', '请选择目标人物', '别名必须移动到另一个人物主档。', 'MEMORY_ACTOR_ALIAS_TARGET_REQUIRED');
          return;
        }
        void runAction('correct-actor-alias', () => controller.correctActorAlias!(aliasId, targetId), '别名归属已纠正', '该称呼已移动到目标人物主档。', 'MEMORY_ACTOR_ALIAS_CORRECTED', async () => {
          state.actorOperation = '';
          await loadPage('actors');
        });
      }
      return;
    }
    if (action === 'undo-actor-correction') {
      const auditId = actionNode.dataset.auditId;
      if (!auditId || !controller.resolveActorCorrection) return;
      void runAction('undo-actor-correction', () => controller.resolveActorCorrection!(auditId, 'undo'), '人物纠正已撤销', '主体、别名和审计状态已恢复。', 'MEMORY_ACTOR_CORRECTION_UNDONE', () => loadPage('actors'));
      return;
    }
    if (action === 'refresh') { void refreshAll(); return; }
    if (action === 'refresh-library') { void refreshLibrary(); return; }
    if (action === 'refresh-initialization') {
      void runAction(
        'refresh-initialization',
        () => refreshInitialization(state.selectedSourceKinds),
        '初始化状态已刷新',
        '来源、估算、任务进度和最近活动已经重新读取。',
        'MEMORY_INITIALIZATION_REFRESHED',
      );
      return;
    }
    if (action === 'retry-load') { void loadOverview(); return; }
    if (action === 'retry-page') { void loadPage(state.page); return; }
    if (action === 'dismiss-error') { state.actionError = undefined; rerender(); return; }
    if (action === 'refresh-health') { void runAction('refresh-health', async () => { state.sqlite = await controller.getSqliteStatus({ detailed: true }); await loadOverview(); }, '检查已完成', '工作台状态已重新读取。', 'MEMORY_HEALTH_REFRESHED'); return; }
    if (action === 'jump-to-message') {
      if (!navigateToMessage) return;
      const messageId = actionNode.dataset.messageId?.trim();
      const rawIndex = actionNode.dataset.messageIndex;
      const index = rawIndex === undefined ? undefined : Number(rawIndex);
      const target: ChatNavigationTarget = {
        ...(messageId ? { messageId } : {}),
        ...(index !== undefined && Number.isSafeInteger(index) && index >= 0 ? { index } : {}),
      };
      void navigateToMessage(target)
        .then(() => popupUi?.close())
        .catch(() => toast('warning', '无法跳转聊天楼层', '对应消息可能尚未加载或已被删除。', 'MEMORY_MESSAGE_NAVIGATION_UNAVAILABLE'));
      return;
    }
    if (action === 'show-source-info') {
      openSceneSource(actionNode.dataset.sourceRef ?? '');
      return;
    }
    if (action === 'library-scope') {
      const filter = actionNode.dataset.scopeFilter;
      const value = actionNode.dataset.scopeValue ?? '';
      if (filter === 'kind') state.selectedKinds = value ? [value] : Object.keys(FACT_KIND_LABELS);
      else if (filter === 'status') state.selectedStatuses = value ? [value] : Object.keys(FACT_STATUS_LABELS);
      else return;
      state.openFilter = '';
      state.editingFactId = '';
      state.confirmFactId = '';
      normalizeLibrarySelection();
      rerender();
      return;
    }
    if (action === 'select-fact') {
      const factId = actionNode.dataset.factId ?? '';
      if (!factId) return;
      state.selectedFactId = factId;
      state.editingFactId = '';
      state.confirmFactId = '';
      rerender();
      return;
    }
    if (action === 'edit-fact') { state.editingFactId = actionNode.dataset.factId ?? ''; rerender('#stx-memory-edit-content'); return; }
    if (action === 'cancel-edit') { state.editingFactId = ''; rerender(); return; }
    if (action === 'save-fact') { const id = actionNode.dataset.factId ?? ''; const textarea = root.querySelector<HTMLTextAreaElement>('[data-edit-content]'); const content = textarea?.value.trim() ?? ''; if (!id || !content) { toast('warning', '记忆内容不能为空', '请输入事实文本后再保存。', 'MEMORY_FACT_CONTENT_REQUIRED'); return; } void runAction('save-fact', () => controller.updateFact(id, content), '记忆已保存', '事实内容已更新，聊天原文未被修改。', 'MEMORY_FACT_UPDATED', async () => { state.editingFactId = ''; await refreshFacts(); }); return; }
    if (action === 'delete-fact') { state.confirmFactId = actionNode.dataset.factId ?? ''; rerender(); return; }
    if (action === 'cancel-delete') { state.confirmFactId = ''; rerender(); return; }
    if (action === 'confirm-delete') { const id = actionNode.dataset.factId ?? ''; void runAction('delete-fact', () => controller.removeFact(id), '记忆已删除', '原聊天消息不受影响。', 'MEMORY_FACT_DELETED', async () => { state.confirmFactId = ''; await refreshFacts(); }); return; }
    if (action === 'initialize-start') { const selectedKinds = [...state.selectedSourceKinds]; const sourceOptions = initializationOptions(); if (!selectedKinds.length || state.busyAction || !state.overview?.llmAvailable) return; void runAction('initialize', () => controller.initialize(selectedKinds, sourceOptions), '初始化已完成', '当前聊天已经可以使用记忆召回。', 'MEMORY_INITIALIZE_COMPLETED', async () => { await refreshInitialization(selectedKinds); }); return; }
    if (action === 'initialize-resume') { if (state.busyAction || !state.overview?.llmAvailable || state.sqlite?.connected === false || state.overview?.status === 'error') return; void runAction('initialize-resume', () => controller.retry(), '初始化已完成', '已继续处理暂存结果，当前聊天已经可以使用记忆召回。', 'MEMORY_INITIALIZE_RESUMED', async () => { await refreshInitialization(state.selectedSourceKinds); }); return; }
    if (action === 'initialize-cancel') { void runAction('cancel-capture', () => controller.cancelCapture(), '初始化已取消', '已停止继续处理新批次。', 'MEMORY_INITIALIZE_CANCELLED', async () => { await updateProgress(); }); return; }
    if (action === 'view-library') { void loadPage('library'); return; }
    if (action === 'view-audit') { void loadPage('audit'); return; }
    if (action === 'open-reinitialize') {
      if (state.busyAction || !state.overview?.llmAvailable) return;
      const successfulKinds = state.initialization?.selectedSourceKinds.filter((kind) => state.sources.some((source) => source.kind === kind)) ?? [];
      state.selectedSourceKinds = successfulKinds.length ? successfulKinds : state.sources.filter((source) => source.selected).map((source) => source.kind);
      state.reinitializeOpen = true;
      rerender('#stx-memory-reinitialize-cancel');
      const sourceOptions = initializationOptions();
      void Promise.all([
        controller.getInitializationSources(sourceOptions),
        controller.getInitializationEstimate(state.selectedSourceKinds, sourceOptions),
      ]).then(([sources, estimate]) => {
        if (disposed || !state.reinitializeOpen) return;
        state.sources = sources.map((source) => ({ ...source, selected: state.selectedSourceKinds.includes(source.kind) && source.count > 0 }));
        state.selectedSourceKinds = state.selectedSourceKinds.filter((kind) => state.sources.some((source) => source.kind === kind && source.count > 0));
        state.estimate = estimate;
        rerender('#stx-memory-reinitialize-cancel');
      }).catch((error) => toast('error', '估算失败', '无法更新重新初始化成本估算。', safeErrorCode(error, 'MEMORY_ESTIMATE_FAILED')));
      return;
    }
    if (action === 'cancel-reinitialize') { state.reinitializeOpen = false; rerender('#stx-memory-reinitialize-trigger'); return; }
    if (action === 'confirm-reinitialize') {
      const selectedKinds = [...state.selectedSourceKinds];
      const sourceOptions = initializationOptions();
      if (!selectedKinds.length || state.busyAction || !state.overview?.llmAvailable || Boolean(state.progress && ['queued', 'running', 'repairing'].includes(state.progress.status))) return;
      state.reinitializeOpen = false;
      void runAction('reinitialize', () => controller.reinitialize(selectedKinds, sourceOptions), '重新初始化已完成', '旧 Memory 数据已替换，当前聊天已经可以使用记忆召回。', 'MEMORY_REINITIALIZE_COMPLETED', async () => { await refreshInitialization(selectedKinds); });
      return;
    }
    if (action === 'rebuild-index') { void runAction('rebuild-index', () => controller.rebuildVectorIndex(), '索引重建已开始', '向量覆盖率会在后台更新。', 'MEMORY_INDEX_REBUILD_STARTED', async () => { await loadPage('recall'); }); return; }
    if (action === 'graph-command') {
      const command = actionNode.dataset.graphCommand as RelationshipGraphCommand | undefined;
      if (command) graphRenderer?.command(command);
      return;
    }
    if (action === 'set-graph-list-mode') {
      const mode = actionNode.dataset.graphListMode;
      if (mode !== 'edges' && mode !== 'events') return;
      if (mode === state.graphListMode) return;
      const hadSelection = Boolean(state.selectedGraphEdgeId || state.selectedGraphEventId || state.selectedGraphNodeId || state.graphNeighborFocus);
      state.graphListMode = mode;
      state.selectedGraphEdgeId = '';
      state.selectedGraphEventId = '';
      state.selectedGraphNodeId = '';
      state.graphNeighborFocus = false;
      syncGraphListMode(hadSelection);
      return;
    }
    if (action === 'toggle-graph-neighbor-focus') { state.graphNeighborFocus = !state.graphNeighborFocus; syncGraphUi(); return; }
    if (action === 'select-graph-edge') { const edgeId = actionNode.dataset.edgeId ?? ''; const refocus = state.selectedGraphEdgeId === edgeId && !state.selectedGraphNodeId; state.selectedGraphEdgeId = edgeId; state.selectedGraphEventId = ''; state.selectedGraphNodeId = ''; syncGraphUi(true); if (refocus) graphRenderer?.focusEdge(edgeId); return; }
    if (action === 'select-graph-event') { const edgeId = actionNode.dataset.eventEdgeId ?? ''; const refocus = state.selectedGraphEventId === edgeId && !state.selectedGraphNodeId; state.selectedGraphEventId = edgeId; state.selectedGraphEdgeId = ''; state.selectedGraphNodeId = ''; syncGraphUi(true); if (refocus) graphRenderer?.focusEdge(edgeId); return; }
    if (action === 'rebuild-graph') { void runAction('rebuild-graph', () => controller.rebuildGraph(), '关系图谱已重建', '已依据当前聊天的已验证事实重新协调节点和关系边。', 'MEMORY_GRAPH_REBUILT', async () => { await loadPage(state.page === 'recall' ? 'recall' : 'graph'); }); return; }
    if (action === 'ignore-capture-rejections') {
      const auditId = actionNode.dataset.auditId ?? '';
      const record = state.audits.find(item => item.id === auditId);
      const validIds = new Set((record?.issues ?? [])
        .filter(item => item.canIgnore && item.status === 'unresolved')
        .map(item => item.rejectionId ?? item.id));
      const rejectionIds = state.selectedRejectionIds.filter(id => validIds.has(id));
      if (!auditId || rejectionIds.length === 0) {
        toast('warning', '请选择失败项', '至少选择一条待处理记录。', 'MEMORY_CAPTURE_REJECTION_SELECTION_REQUIRED');
        return;
      }
      if (controller.ignoreCaptureRejections) {
        void runAction('ignore-capture-rejections', () => controller.ignoreCaptureRejections!(auditId, rejectionIds), '失败项已忽略', '这些项目保留在审计中，不会写入记忆。', 'MEMORY_CAPTURE_REJECTIONS_IGNORED', async () => {
          state.selectedRejectionIds = state.selectedRejectionIds.filter(id => !validIds.has(id));
          await loadPage('audit');
        });
      }
      return;
    }
    if (action === 'refresh-audit') { void loadPage('audit'); return; }
    if (action === 'export') { void controller.exportSqliteBackup().then(downloadSqlite).then(() => toast('success', '归档已导出', 'Memory 数据快照已下载。', 'MEMORY_ARCHIVE_EXPORTED')).catch((error) => toast('error', '导出失败', '无法生成 Memory 归档。', safeErrorCode(error, 'MEMORY_EXPORT_FAILED'))); return; }
    if (action === 'integrity') { state.integrityText = '正在执行 SQLite 完整性检查…'; rerender(); void controller.checkSqliteIntegrity().then((result) => { state.integrityText = `${result.ok ? '通过' : '失败'}：${result.message}`; if (result.ok) toast('success', '完整性检查通过', 'SQLite 数据结构正常。', 'MEMORY_INTEGRITY_OK'); else toast('warning', '完整性检查未通过', '请导出快照后检查服务端状态。', 'MEMORY_INTEGRITY_FAILED'); }).catch((error) => { state.integrityText = '检查失败，请稍后重试。'; toast('error', '完整性检查失败', '无法完成 SQLite 检查。', safeErrorCode(error, 'MEMORY_INTEGRITY_ERROR')); }).finally(() => rerender()); return; }
    if (action === 'clear-current') { state.dangerConfirm = 'current'; rerender(); return; }
    if (action === 'clear-all') { state.dangerConfirm = 'all'; rerender(); return; }
    if (action === 'cancel-danger') { state.dangerConfirm = ''; rerender(); return; }
    if (action === 'confirm-clear-current') { void runAction('clear-current', () => controller.clearCurrentChatData(), '当前聊天来源已清空', '其他聊天来源保留。', 'MEMORY_CURRENT_CHAT_CLEARED', async () => { state.dangerConfirm = ''; await refreshFacts(); }); return; }
    if (action === 'confirm-clear-all') { const input = root.querySelector<HTMLInputElement>('[data-clear-all-text]'); if (input?.value !== '清空全部记忆') { toast('warning', '确认文本不匹配', '请输入“清空全部记忆”后再提交。', 'MEMORY_CLEAR_CONFIRMATION_REQUIRED'); return; } void runAction('clear-all', () => controller.clearAllMemoryData(), '全部记忆已清空', '全局设置保持不变。', 'MEMORY_ALL_CLEARED', async () => { state.dangerConfirm = ''; await refreshFacts(); }); }
  }, { signal: abortController.signal });
  root.addEventListener('input', (event) => {
    const input = event.target as HTMLInputElement;
    if (input.dataset.auditInput === 'query') {
      state.auditQuery = input.value;
      state.auditMobileView = 'list';
      normalizeAuditSelection();
      rerender('', true);
      scheduleAuditListRefresh('records');
      return;
    }
    if (input.dataset.usageInput === 'query') {
      state.usageQuery = input.value;
      state.auditMobileView = 'list';
      normalizeAuditSelection();
      rerender('', true);
      scheduleAuditListRefresh('usage');
      return;
    }
    if (input.dataset.inventoryInput === 'query') {
      state.inventoryQuery = input.value;
      if (inventorySearchTimer) window.clearTimeout(inventorySearchTimer);
      inventorySearchTimer = window.setTimeout(() => {
        inventorySearchTimer = undefined;
        state.inventoryEvents = [];
        rerender('', true);
      }, 120);
      return;
    }
    if (input.dataset.inventoryInput === 'new-name') {
      state.inventoryNewName = input.value;
      const save = root.querySelector<HTMLButtonElement>('[data-action="inventory-create"]');
      if (save) save.disabled = !controller.createInventoryItem || !state.inventoryNewName.trim() || Boolean(state.busyAction);
      return;
    }
    if (input.dataset.inventoryInput === 'new-aliases') { state.inventoryNewAliases = input.value; return; }
    if (input.dataset.inventoryInput === 'amount') { state.inventoryCommandAmount = input.value; return; }
    if (input.dataset.inventoryInput === 'unit') { state.inventoryCommandUnit = input.value; return; }
    if (input.dataset.actorMemoryInput === 'query') {
      state.actorMemoryQuery = input.value;
      rerender('', true);
      return;
    }
    if (input.dataset.sceneInput === 'query') {
      state.sceneQuery = input.value;
      rerender('', true);
      return;
    }
    if (input.dataset.actorInput === 'query') {
      state.actorQuery = input.value;
      rerender('', true);
      return;
    }
    if (input.dataset.actorInput === 'rename') {
      state.actorRenameValue = input.value;
      rerender();
      return;
    }
    if (input.dataset.actorInput === 'candidate-name') {
      state.candidateCanonicalName = input.value;
      rerender();
      return;
    }
    if (input.dataset.actorInput === 'operation-name') {
      state.actorOperationName = input.value;
      rerender();
      return;
    }
    if (input.dataset.filter === 'query') {
      state.query = input.value;
      if (searchTimer) window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => { void refreshLibrarySearch().then(() => rerender('', true)).catch((error) => toast('error', '搜索失败', '无法读取筛选结果，请稍后重试。', safeErrorCode(error, 'MEMORY_SEARCH_FAILED'))); }, 220);
      return;
    }
    if (input.dataset.filter === 'graph-query') {
      state.graphQuery = input.value;
      if (graphSearchTimer) window.clearTimeout(graphSearchTimer);
      graphSearchTimer = window.setTimeout(() => {
        graphSearchTimer = undefined;
        syncGraphUi();
      }, 120);
    }
  }, { signal: abortController.signal });
  root.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement | HTMLSelectElement;
    if (input.dataset.auditSelect === 'status') {
      const value = input.value;
      if (value !== 'all' && value !== 'completed' && value !== 'partial' && value !== 'rolled_back') return;
      state.auditStatus = value;
      state.auditMobileView = 'list';
      normalizeAuditSelection();
      rerender();
      scheduleAuditListRefresh('records', 0);
      return;
    }
    if (input.dataset.usageSelect === 'model') {
      state.usageModel = input.value;
      state.auditMobileView = 'list';
      normalizeAuditSelection();
      rerender();
      scheduleAuditListRefresh('usage', 0);
      return;
    }
    if (input.dataset.usageSelect === 'completeness') {
      if (input.value !== 'all' && input.value !== 'complete' && input.value !== 'missing') return;
      state.usageCompleteness = input.value;
      state.auditMobileView = 'list';
      normalizeAuditSelection();
      rerender();
      scheduleAuditListRefresh('usage', 0);
      return;
    }
    if (input.dataset.inventorySelect === 'new-category') { state.inventoryNewCategory = input.value as WorkbenchState['inventoryNewCategory']; return; }
    if (input.dataset.inventorySelect === 'sort') {
      if (input.value !== 'recent' && input.value !== 'name' && input.value !== 'amount' && input.value !== 'confidence') return;
      state.inventorySort = input.value;
      rerender();
      return;
    }
    if (input.dataset.inventorySelect === 'precision') {
      if (input.value !== 'exact' && input.value !== 'approximate' && input.value !== 'unknown') return;
      state.inventoryCommandPrecision = input.value;
      if (state.inventoryCommandPrecision === 'unknown') state.inventoryCommandAmount = '';
      rerender();
      return;
    }
    if (input.dataset.inventorySelect === 'measure') {
      state.inventoryCommandMeasure = input.value as import('../domain').InventoryMeasureKind;
      if (state.inventoryCommandMeasure === 'coverage_days' && !['set', 'remove'].includes(state.inventoryCommandOperation)) state.inventoryCommandOperation = 'set';
      if (state.inventoryCommandMeasure === 'coverage_days') state.inventoryCommandUnit = '天';
      if (state.inventoryCommandMeasure === 'quantity' && state.inventoryCommandUnit === '天') state.inventoryCommandUnit = '个';
      rerender();
      return;
    }
    if (input.dataset.actorMemorySelect === 'knowledge') {
      state.actorMemoryKnowledgeMode = input.value as WorkbenchState['actorMemoryKnowledgeMode'];
      state.actorMemorySelectedTraceId = '';
      rerender();
      return;
    }
    if (input.dataset.actorMemorySelect === 'privacy') {
      state.actorMemoryPrivacy = input.value as WorkbenchState['actorMemoryPrivacy'];
      state.actorMemorySelectedTraceId = '';
      rerender();
      return;
    }
    if (input.dataset.actorMemorySelect === 'level') {
      state.actorMemoryLevel = input.value as WorkbenchState['actorMemoryLevel'];
      state.actorMemorySelectedTraceId = '';
      rerender();
      return;
    }
    if (input.dataset.actorMemorySelect === 'sort') {
      state.actorMemorySort = input.value as ActorMemorySort;
      rerender();
      return;
    }
    if (input.dataset.sceneSelect === 'filter') {
      state.sceneFilter = input.value;
      rerender();
      return;
    }
    if (input.dataset.sceneSelect === 'correction-owner') {
      state.selectedSceneOwnerId = input.value;
      rerender();
      return;
    }
    if (input instanceof HTMLInputElement && input.dataset.captureRejectionId) {
      const rejectionId = input.dataset.captureRejectionId;
      state.selectedRejectionIds = input.checked
        ? [...new Set([...state.selectedRejectionIds, rejectionId])]
        : state.selectedRejectionIds.filter(id => id !== rejectionId);
      rerender();
      return;
    }
    if (input.dataset.actorSelect === 'status') {
      state.actorStatus = input.value as WorkbenchState['actorStatus'];
      rerender();
      return;
    }
    if (input.dataset.actorSelect === 'candidate-target') {
      state.candidateTargetOwnerId = input.value;
      return;
    }
    if (input.dataset.actorSelect === 'operation-target') {
      state.actorOperationTargetId = input.value;
      return;
    }
    if (input.dataset.actorSelect === 'operation-alias') {
      state.actorOperationAliasId = input.value;
      state.actorOperationName = input.value;
      rerender('#stx-memory-actor-operation-name');
      return;
    }
    if (input.dataset.filterAll) {
      const checkbox = input as HTMLInputElement;
      const filter = input.dataset.filterAll;
      const values = Object.keys(filter === 'kind' ? FACT_KIND_LABELS : FACT_STATUS_LABELS);
      if (filter === 'kind') state.selectedKinds = checkbox.checked ? values : [];
      else state.selectedStatuses = checkbox.checked ? values : [];
      normalizeLibrarySelection();
      rerender(); return;
    }
    if (input.dataset.filterOption) {
      const checkbox = input as HTMLInputElement;
      const filter = input.dataset.filterOption;
      const current = filter === 'kind' ? state.selectedKinds : state.selectedStatuses;
      const next = checkbox.checked ? [...new Set([...current, checkbox.value])] : current.filter((value) => value !== checkbox.value);
      if (filter === 'kind') state.selectedKinds = next;
      else state.selectedStatuses = next;
      normalizeLibrarySelection();
      rerender(); return;
    }
    if (input.dataset.filter === 'sort') { state.sort = input.value as MemoryLibrarySort; normalizeLibrarySelection(); rerender(); return; }
    if (input.dataset.graphFilter === 'kind') { state.graphKind = input.value; state.selectedGraphEdgeId = ''; state.selectedGraphEventId = ''; state.selectedGraphNodeId = ''; syncGraphUi(); return; }
    if (input.dataset.graphFilter === 'status') { state.graphStatusFilter = input.value; state.selectedGraphEdgeId = ''; state.selectedGraphEventId = ''; state.selectedGraphNodeId = ''; syncGraphUi(); return; }
    if (input.dataset.option === 'include-hidden-message-floors') {
      const includeHiddenMessageFloors = (input as HTMLInputElement).checked;
      const sourceOptions = { includeHiddenMessageFloors };
      const selectedKinds = [...state.selectedSourceKinds];
      void Promise.all([
        controller.getInitializationSources(sourceOptions),
        controller.getInitializationEstimate(selectedKinds, sourceOptions),
      ]).then(([sources, estimate]) => {
        if (disposed) return;
        state.includeHiddenMessageFloors = includeHiddenMessageFloors;
        state.sources = sources.map((source) => ({ ...source, selected: selectedKinds.includes(source.kind) && source.count > 0 }));
        state.selectedSourceKinds = selectedKinds.filter((kind) => state.sources.some((source) => source.kind === kind && source.count > 0));
        state.estimate = estimate;
        rerender();
      }).catch((error) => {
        if (disposed) return;
        rerender();
        toast('error', '隐藏楼层选项未更新', '来源或成本估算读取失败，已保留原来的处理范围。', safeErrorCode(error, 'INTERNAL_ERROR'));
      });
      return;
    }
    if (input.dataset.sourceKind) { const selected = (input as HTMLInputElement).checked; state.selectedSourceKinds = selected ? [...new Set([...state.selectedSourceKinds, input.dataset.sourceKind])] : state.selectedSourceKinds.filter((kind) => kind !== input.dataset.sourceKind); void controller.getInitializationEstimate(state.selectedSourceKinds, initializationOptions()).then((estimate) => { if (!disposed) { state.estimate = estimate; rerender(); } }).catch((error) => toast('error', '估算失败', '无法更新初始化成本估算。', safeErrorCode(error, 'INTERNAL_ERROR'))); return; }
  }, { signal: abortController.signal });
  root.addEventListener('pointerdown', (event) => {
    const splitter = (event.target as HTMLElement).closest<HTMLElement>('[data-inventory-split]');
    if (!splitter || state.page !== 'inventory' || splitter.getAttribute('aria-disabled') === 'true' || event.button !== 0) return;
    const kind = splitter.dataset.inventorySplit;
    if (kind !== 'detail' && kind !== 'preview') return;
    stopInventoryResize();
    inventoryResizeDrag = { kind, pointerId: event.pointerId, splitter };
    splitter.closest<HTMLElement>('.stx-memory-inventory-console, .stx-memory-inventory-detail-scroll')?.classList.add('is-resizing');
    splitter.setPointerCapture?.(event.pointerId);
    updateInventoryResizeFromPointer(event);
    event.preventDefault();
  }, { signal: abortController.signal });
  root.addEventListener('pointermove', (event) => {
    if (inventoryResizeDrag && event.pointerId === inventoryResizeDrag.pointerId) {
      updateInventoryResizeFromPointer(event);
      event.preventDefault();
      return;
    }
    const zone = (event.target as HTMLElement).closest<HTMLElement>('[data-actor-memory-zone]');
    if (!zone || state.page !== 'actor-memory') return;
    const start = Number(zone.dataset.start);
    const end = Number(zone.dataset.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
    const rect = zone.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
    const upper = end >= 100 ? 100 : end - 0.01;
    updateGaugeZonePreview(zone, start + (upper - start) * ratio);
  }, { signal: abortController.signal });
  root.addEventListener('pointerup', (event) => {
    if (inventoryResizeDrag?.pointerId === event.pointerId) stopInventoryResize(event);
  }, { signal: abortController.signal });
  root.addEventListener('pointercancel', (event) => {
    if (inventoryResizeDrag?.pointerId === event.pointerId) stopInventoryResize(event);
  }, { signal: abortController.signal });
  root.addEventListener('lostpointercapture', (event) => {
    if (inventoryResizeDrag?.pointerId === event.pointerId) stopInventoryResize(event);
  }, { signal: abortController.signal });
  root.addEventListener('pointerout', (event) => {
    const zone = (event.target as HTMLElement).closest<HTMLElement>('[data-actor-memory-zone]');
    if (!zone || zone.contains(event.relatedTarget as Node | null)) return;
    const start = Number(zone.dataset.start);
    const end = Number(zone.dataset.end);
    if (Number.isFinite(start) && Number.isFinite(end)) updateGaugeZonePreview(zone, start + (end - start) / 2);
  }, { signal: abortController.signal });
  root.addEventListener('focusin', (event) => {
    const zone = (event.target as HTMLElement).closest<HTMLElement>('[data-actor-memory-zone]');
    if (!zone) return;
    const start = Number(zone.dataset.start);
    const end = Number(zone.dataset.end);
    if (Number.isFinite(start) && Number.isFinite(end)) updateGaugeZonePreview(zone, start + (end - start) / 2);
  }, { signal: abortController.signal });
  root.addEventListener('keydown', (event) => {
    const splitter = (event.target as HTMLElement).closest<HTMLElement>('[data-inventory-split]');
    if (splitter && state.page === 'inventory' && splitter.getAttribute('aria-disabled') !== 'true') {
      const kind = splitter.dataset.inventorySplit;
      if (kind === 'detail' || kind === 'preview') {
        const current = kind === 'detail' ? state.inventoryDetailWidth : state.inventoryPreviewHeight;
        const minimum = kind === 'detail' ? INVENTORY_DETAIL_WIDTH_MIN : INVENTORY_PREVIEW_HEIGHT_MIN;
        const maximum = kind === 'detail' ? inventoryDetailWidthMax() : INVENTORY_PREVIEW_HEIGHT_MAX;
        const reset = kind === 'detail' ? INVENTORY_DETAIL_WIDTH_DEFAULT : INVENTORY_PREVIEW_HEIGHT_DEFAULT;
        const next = event.key === 'Home' ? minimum
          : event.key === 'End' ? maximum
            : event.key === 'Enter' || event.key === ' ' ? reset
              : kind === 'detail' && event.key === 'ArrowLeft' ? current + INVENTORY_SPLITTER_KEYBOARD_STEP
                : kind === 'detail' && event.key === 'ArrowRight' ? current - INVENTORY_SPLITTER_KEYBOARD_STEP
                  : kind === 'preview' && event.key === 'ArrowUp' ? current - INVENTORY_SPLITTER_KEYBOARD_STEP
                    : kind === 'preview' && event.key === 'ArrowDown' ? current + INVENTORY_SPLITTER_KEYBOARD_STEP
                      : undefined;
        if (next !== undefined) {
          setInventorySplitValue(kind, next);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
    }
    if (event.key !== 'Escape') return;
    if (state.actorOperation) {
      event.preventDefault();
      event.stopPropagation();
      const operation = state.actorOperation;
      const aliasId = state.actorOperationAliasId;
      state.actorOperation = '';
      state.actorOperationAliasId = '';
      state.actorOperationTargetId = '';
      state.actorOperationName = '';
      rerender(operation === 'merge' ? '#stx-memory-actor-merge-trigger' : operation === 'split' ? '#stx-memory-actor-split-trigger' : aliasId ? `[data-action="open-actor-operation"][data-alias-id="${aliasId}"]` : '');
      return;
    }
    if (state.reinitializeOpen) {
      event.preventDefault();
      event.stopPropagation();
      state.reinitializeOpen = false;
      rerender('#stx-memory-reinitialize-trigger');
      return;
    }
    if (!state.openFilter) return;
    event.preventDefault();
    event.stopPropagation();
    const filter = state.openFilter;
    state.openFilter = '';
    rerender(`#stx-memory-${filter}-filter-trigger`);
  }, { signal: abortController.signal });
  window.addEventListener('resize', syncInventorySplitters, { signal: abortController.signal });
  document.addEventListener('click', (event) => {
    if (!state.openFilter || event.composedPath().includes(root)) return;
    state.openFilter = '';
    rerender();
  }, { signal: abortController.signal });

  removeOverviewChanged = controller.onOverviewChanged?.(() => {
    scheduleStorageUsageRefresh();
    void refreshLiveSnapshot();
  });
  render();
  void document.fonts?.ready.then(() => refreshGraphMarquees(root));
  traceMemoryStartup('workbench:initial-rendered');
  traceMemoryStartup('workbench:overview-scheduled');
  void loadOverview().then(() => {
    if (disposed || !state.overview?.bound) return;
    if (initialActionId === 'rebuild-relationship-graph') {
      void runAction(
        'rebuild-graph',
        () => controller.rebuildGraph(),
        '关系图谱已重建',
        '已依据当前聊天的已验证事实重新协调节点和关系边。',
        'MEMORY_GRAPH_REBUILT',
        async () => { await loadPage('graph'); },
      );
    } else if (requestedGraphPage) {
      void loadPage('graph');
    }
  });
  return () => {
    disposed = true; pageRequestId += 1; backgroundPageRequestId += 1; progressRequestId += 1; librarySearchRequestId += 1; overviewRequestId += 1; storageUsageRequestId += 1; auditListRequestId += 1; auditSummaryRequestId += 1; usageRecallRequestId += 1; abortController.abort();
    stopInventoryResize();
    cancelInventorySelectionTransition();
    if (searchTimer) window.clearTimeout(searchTimer);
    if (inventorySearchTimer) window.clearTimeout(inventorySearchTimer);
    if (graphSearchTimer) window.clearTimeout(graphSearchTimer);
    if (progressTimer) window.clearTimeout(progressTimer);
    if (storageUsageTimer) window.clearTimeout(storageUsageTimer);
    if (auditFilterTimer) window.clearTimeout(auditFilterTimer);
    if (renderFrame !== undefined) window.cancelAnimationFrame(renderFrame);
    if (graphMarqueeResizeFrame !== undefined) window.cancelAnimationFrame(graphMarqueeResizeFrame);
    if (graphListModeFrame !== undefined) window.cancelAnimationFrame(graphListModeFrame);
    removeOverviewChanged?.();
    graphMarqueeResizeObserver?.disconnect();
    graphRenderer?.dispose();
    graphRenderer = undefined;
    disposeInventoryCardRenderer();
    sceneRendererToken += 1;
    sceneRenderer?.dispose();
    sceneRenderer = undefined;
    root.replaceChildren();
  };
}
