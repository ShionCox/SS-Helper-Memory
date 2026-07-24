import './memory.css';
import './initialization.css';
import './actor-memory.css';
import {
  UI_CONTROL_ATTRIBUTE,
  UI_CONTROL_ICON_ONLY_ATTRIBUTE,
  UI_CONTROL_SIZE_ATTRIBUTE,
  UI_CONTROL_TONE_ATTRIBUTE,
  type PopupUiContext,
  type ToastNotification,
  type UiControlKind,
  type UiControlSize,
  type UiControlTone,
  type ChatNavigationTarget,
} from '@ss-helper/sdk';
import type { SummaryInitializationEstimate } from '../application/ingest/summary-strategy';
import { DEFAULT_MEMORY_TRAITS, type MemoryGraphPreview, type MemoryGraphStatus } from '../domain';
import { describeMemoryError, type MemoryErrorDiagnostic } from '../diagnostics/memory-error';
import { traceMemoryStartup } from '../host/runtime-feedback';
import { mountRelationshipGraphThree, type RelationshipGraphCommand, type RelationshipGraphRenderer } from './relationship-graph-three';
import { selectGraphView } from './relationship-graph-layout';
import {
  getSceneEventsHeader,
  normalizeSceneEventsSelection,
  renderSceneEventsPage,
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
  renderMemoryLibraryView,
  selectMemoryLibraryView,
  type MemoryLibrarySort,
} from './memory-library-view';
import {
  normalizeActorMemorySelection,
  renderActorMemoryPage,
  updateActorMemoryGaugeZone,
  type ActorMemoryGroup,
  type ActorMemoryLevel,
  type ActorMemorySort,
  type ActorMemoryTab,
  type ActorMemoryViewState,
} from './actor-memory-view';

export interface MemoryUiSettings {
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
  lastError?: string;
}

export interface MemorySqliteIntegrityResult { ok: boolean; message: string }
export const EXPECTED_SQLITE_SCHEMA_VERSION = 0;

export function formatRollbackConfirmation(jobId: string, batchIndex: number): string {
  return `回滚任务 ${jobId} 的第 ${batchIndex} 批及其后续批次？这会恢复第 ${batchIndex} 批执行前的事实与替代链，之后批次的整理结果也会一并撤销。`;
}

export interface MemoryUiFact {
  id: string;
  content: string;
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
  errorCode?: string;
  error?: string;
  errorDiagnostic?: MemoryErrorDiagnostic;
}

export interface MemoryInitializationOptions {
  includeInvisibleHistory?: boolean;
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
  /** Entries that become eligible when the one-time invisible-history option is enabled. */
  invisibleCount?: number;
  selected: boolean;
}
export interface MemoryCaptureProgress {
  status: 'idle' | 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  jobId?: string;
  batchIndex: number;
  totalBatches: number;
  processedCount: number;
  elapsedMs: number;
  error?: string;
  phase?: 'capture';
  outcome?: 'complete' | 'partial';
  rejectedCount?: number;
}

export interface MemoryInitializationAttempt {
  jobId: string;
  status: MemoryCaptureProgress['status'];
  updatedAt: number;
  totalBatches: number;
  selectedSourceKinds: string[];
  includeInvisibleHistory?: boolean;
  error?: string;
}

export interface MemoryInitializationState {
  initialized: boolean;
  lastCompletedAt: number | null;
  selectedSourceKinds: string[];
  attempts: MemoryInitializationAttempt[];
}

export interface MemoryAuditRecord {
  id?: string;
  jobId?: string;
  type?: string;
  status?: string;
  batchIndex?: number;
  sourceRefs?: string[];
  accepted?: number;
  rejected?: unknown[];
  outcome?: 'complete' | 'partial';
  model?: string;
  resource?: string;
  resourceId?: string;
  kind?: string;
  routeSummary?: {
    requestCount?: number;
    resourceIds?: string[];
    models?: string[];
    latencyMs?: number | null;
    usage?: unknown;
  };
  usage?: unknown;
  createdAt?: number;
  [key: string]: unknown;
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
  updateFact(id: string, content: string): Promise<void>;
  removeFact(id: string): Promise<void>;
  getLastRecall(): Promise<unknown>;
  listAuditRecords(): Promise<MemoryAuditRecord[]>;
  getCaptureRepairEstimate?(auditId: string, rejectionIds: readonly string[]): Promise<{ requestCount: number; groupCounts: Partial<Record<'actor' | 'episode' | 'observation' | 'fact', number>> }>;
  repairCaptureRejections?(auditId: string, rejectionIds: readonly string[]): Promise<void>;
  ignoreCaptureRejections?(auditId: string, rejectionIds: readonly string[]): Promise<void>;
  getMainChatUsage(): Promise<unknown[]>;
  getRecallStatus(): Promise<MemoryRecallStatus>;
  rebuildVectorIndex(): Promise<void>;
  getGraphStatus(): MemoryGraphStatus;
  getRelationshipGraph(query?: string, limit?: number): Promise<MemoryGraphPreview>;
  rebuildGraph(): Promise<void>;
  rollbackBatch(jobId: string, batchIndex: number): Promise<void>;
  getSqliteStatus(): Promise<MemorySqliteStatus>;
  exportSqliteBackup(): Promise<Blob>;
  importSqliteBackup(file: File): Promise<void>;
  checkSqliteIntegrity(): Promise<MemorySqliteIntegrityResult>;
  /** Optional multi-actor workbench read models. */
  listActors?(): Promise<readonly import('../domain').MemoryOwner[]>;
  listActorAliases?(): Promise<readonly import('../domain').ActorAlias[]>;
  listSceneCasts?(): Promise<readonly import('../domain').SceneCast[]>;
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

export function localizeLegacyGraphPreview(graph: MemoryGraphPreview): MemoryGraphPreview {
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
function auditStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item ?? '').trim()).filter(Boolean))]
    : [];
}
function formatAuditRoute(values: unknown, fallback: string, formatter: (value: string) => string = (value) => value): string {
  const entries = auditStringList(values);
  if (entries.length === 0) return fallback;
  if (entries.length === 1) return formatter(entries[0]!);
  return `多个（${entries.length}）`;
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
  const message = overview.error ?? '';
  const code = overview.errorCode && /^[A-Z][A-Z0-9_]{2,63}$/u.test(overview.errorCode)
    ? overview.errorCode
    : message.match(/(?:HTTP\s*)?\b(4\d\d|5\d\d)\b/i)?.[1] ?? '未知';
  const resource = overview.llmResource ?? message.match(/(?:resource|资源)\s*[:：=]\s*([^\s,，;；]+)/i)?.[1] ?? 'memory_extract 路由';
  const model = overview.llmModel ?? message.match(/(?:model|模型)\s*[:：=]\s*([^\s,，;；]+)/i)?.[1] ?? '由 LLMHub 决定';
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
function downloadSqlite(content: Blob): void {
  const anchor = document.createElement('a'); const objectUrl = URL.createObjectURL(content); anchor.href = objectUrl;
  anchor.download = content instanceof File && content.name ? content.name : `ss-helper-memory-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}
function safeErrorCode(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/u.test(error.code)) return error.code;
  return fallback;
}
function safeInlineError(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const code = value.match(/\b[A-Z][A-Z0-9_]{2,63}\b/u)?.[0];
  if (code) return code;
  const status = value.match(/\b([45]\d\d)\b/u)?.[1];
  return status ? `HTTP ${status}` : fallback;
}

export type MemoryWorkbenchPage = 'overview' | 'actors' | 'scenes' | 'library' | 'actor-memory' | 'profiles' | 'dreams' | 'recall' | 'audit' | 'initialize' | 'graph' | 'data';
const PAGES: ReadonlyArray<{ id: MemoryWorkbenchPage; label: string; description: string; icon: string }> = [
  { id: 'overview', label: '概览', description: '当前工作区与场景状态', icon: 'gauge-high' },
  { id: 'initialize', label: '初始化', description: '选择来源并捕获当前聊天记忆', icon: 'wand-magic-sparkles' },
  { id: 'actors', label: '人物与别名', description: '主体发现与待确认归属', icon: 'users' },
  { id: 'scenes', label: '场景与事件', description: '在场、提及与事件来源', icon: 'timeline' },
  { id: 'library', label: '记忆块', description: '浏览、审阅与编辑事实', icon: 'book-open' },
  { id: 'actor-memory', label: '角色记忆', description: '按主体查看记忆痕迹', icon: 'brain' },
  { id: 'profiles', label: '画像与关系', description: '来源支撑的增量画像', icon: 'address-card' },
  { id: 'dreams', label: 'Dream', description: '逐主体巩固、审计与回滚', icon: 'moon' },
  { id: 'recall', label: '召回与索引', description: '检查检索链路', icon: 'magnifying-glass-chart' },
  { id: 'audit', label: '审计记录', description: '查看整理批次', icon: 'list-check' },
];
const INTERNAL_PAGES: ReadonlyArray<{ id: MemoryWorkbenchPage; label: string; description: string; icon: string }> = [
  { id: 'graph', label: '关系图谱', description: '召回诊断中的只读图谱', icon: 'diagram-project' },
  { id: 'data', label: '数据维护', description: '审计页内的存储健康状态', icon: 'database' },
];

interface WorkbenchState {
  page: MemoryWorkbenchPage;
  loading: boolean;
  pageLoading: boolean;
  busyAction: string;
  errorCode: string;
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
  candidateResolutionMode: 'existing' | 'new';
  candidateTargetOwnerId: string;
  candidateCanonicalName: string;
  scenes: Array<import('../domain').SceneCast>;
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
  includeInvisibleHistory: boolean;
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
  usages: unknown[];
  sqlite?: MemorySqliteStatus;
  integrityText: string;
  confirmBatchKey: string;
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
  return `<div class="stx-memory-error-details" role="alert"><span class="stx-memory-error-icon" aria-hidden="true"><ss-helper-icon name="triangle-exclamation" decorative></ss-helper-icon></span><div class="stx-memory-error-copy"><div class="stx-memory-error-title"><strong>${escapeHtml(diagnostic.title)}</strong>${renderStatusChip(diagnostic.code, 'error')}</div><div class="stx-memory-error-guidance"><p><b>原因：</b><span>${escapeHtml(diagnostic.reason)}</span></p><p><b>处理建议：</b><span>${escapeHtml(diagnostic.action)}</span></p></div></div><div class="stx-memory-error-actions"><button ${uiControl('button', diagnostic.retryable && action !== 'dismiss-error' ? 'danger' : 'neutral')} type="button" data-action="${action}">${actionLabel}</button></div></div>`;
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
  let graphSearchTimer: number | undefined;
  let progressTimer: number | undefined;
  let removeOverviewChanged: (() => void) | undefined;
  let renderFrame: number | undefined;
  let graphMarqueeResizeFrame: number | undefined;
  let graphListModeFrame: number | undefined;
  let graphMarqueeResizeObserver: ResizeObserver | undefined;
  let pendingFocusSelector = '';
  let progressRequestId = 0;
  let librarySearchRequestId = 0;
  let overviewRequestId = 0;
  let pageRequestId = 0;
  let backgroundPageRequestId = 0;
  let liveRefreshRunning = false;
  let liveRefreshRequested = false;
  let graphRenderer: RelationshipGraphRenderer | undefined;
  let sceneRenderer: SceneCastPixiRenderer | undefined;
  let sceneRendererToken = 0;
  const requestedGraphPage = initialActionId === 'open-relationship-graph' || initialActionId === 'rebuild-relationship-graph';
  const state: WorkbenchState = {
    page: requestedGraphPage ? 'graph' : 'library', loading: true, pageLoading: false, busyAction: '', errorCode: '', actors: [], actorAliases: [], pendingActors: [], actorCorrectionReviews: [], actorView: 'people', actorQuery: '', actorStatus: '', selectedActorId: '', selectedCandidateId: '', renamingActorId: '', actorRenameValue: '', editingActorTraitsId: '', actorOperation: '', actorOperationAliasId: '', actorOperationTargetId: '', actorOperationName: '', candidateResolutionMode: 'existing', candidateTargetOwnerId: '', candidateCanonicalName: '', scenes: [], episodes: [], observations: [], sceneCategory: 'scene', sceneQuery: '', sceneFilter: '', selectedSceneId: '', selectedEpisodeId: '', selectedObservationId: '', selectedSceneOwnerId: '', showSceneBoundaries: true, showSceneSources: false, showSceneConfidence: true, actorTraces: [], actorMemoryQuery: '', actorMemoryKnowledgeMode: '', actorMemoryPrivacy: '', actorMemoryLevel: '', actorMemorySort: 'updated_desc', actorMemorySelectedOwnerId: '', actorMemorySelectedTraceId: '', actorMemoryTab: 'overview', actorMemoryCollapsedGroups: [], actorMemoryNow: Date.now(), profiles: [], dreams: [], facts: [], libraryResults: [], query: '', selectedKinds: Object.keys(FACT_KIND_LABELS), selectedStatuses: Object.keys(FACT_STATUS_LABELS), openFilter: '', sort: 'updated_desc',
    selectedFactId: '', editingFactId: '', confirmFactId: '', sources: [], selectedSourceKinds: [], includeInvisibleHistory: false, reinitializeOpen: false, audits: [], usages: [], integrityText: '尚未执行完整性检查。', confirmBatchKey: '', selectedRejectionIds: [], dangerConfirm: '', graphQuery: '', graphKind: '', graphStatusFilter: '', graphListMode: 'edges', selectedGraphEdgeId: '', selectedGraphEventId: '', selectedGraphNodeId: '', graphNeighborFocus: false,
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
  const renderNow = (): void => {
    if (disposed) return;
    const focusSelector = pendingFocusSelector;
    pendingFocusSelector = '';
    const factListScrollTop = root.querySelector<HTMLElement>('.stx-memory-fact-list')?.scrollTop;
    const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    const activeId = active && root.contains(active) && active.id ? active.id : '';
    const activeValue = active && root.contains(active) && ('value' in active) ? active.value : undefined;
    const selectionStart = active?.selectionStart;
    const selectionEnd = active?.selectionEnd;
    graphRenderer?.dispose();
    graphRenderer = undefined;
    sceneRenderer?.dispose();
    sceneRenderer = undefined;
    sceneRendererToken += 1;
    render();
    const restoreFactListScroll = (): void => {
      if (disposed || factListScrollTop === undefined) return;
      const factList = root.querySelector<HTMLElement>('.stx-memory-fact-list');
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
  const scheduleProgress = (): void => {
    if (progressTimer) window.clearTimeout(progressTimer);
    progressTimer = undefined;
    // 初始化的前置步骤（读取来源、创建任务）也可能需要一段时间；即使
    // 后端尚未写入 job，也要持续读取进度，让界面能马上反馈“正在提交 LLM”。
    if (!disposed && (['initialize', 'reinitialize'].includes(state.busyAction) || (state.progress && ['queued', 'running', 'paused'].includes(state.progress.status)))) {
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
    const [allFacts, queryFacts] = await Promise.all([
      controller.listFacts(),
      query ? controller.listFacts(query) : Promise.resolve(undefined),
    ]);
    if (!isCurrent() || state.query.trim() !== query) return false;
    state.facts = allFacts;
    state.libraryResults = queryFacts ?? allFacts;
    normalizeLibrarySelection();
    return true;
  };
  const refreshLibrarySearch = async (): Promise<boolean> => {
    const requestId = ++librarySearchRequestId;
    const query = state.query.trim();
    if (state.overview?.bound === false) {
      if (disposed || requestId !== librarySearchRequestId) return false;
      state.libraryResults = [];
      state.selectedFactId = '';
      return true;
    }
    const results = query
      ? await controller.listFacts(query)
      : state.facts.length ? state.facts : await controller.listFacts();
    if (disposed || requestId !== librarySearchRequestId || state.page !== 'library' || state.query.trim() !== query) return false;
    state.libraryResults = results;
    normalizeLibrarySelection();
    return true;
  };
  const loadOverview = async (): Promise<void> => {
    const requestId = ++overviewRequestId;
    const isCurrent = (): boolean => !disposed && requestId === overviewRequestId;
    state.loading = true; state.errorCode = ''; state.errorDiagnostic = undefined; rerender();
    try {
      const overview = await controller.getOverview();
      if (!isCurrent()) return;
      state.overview = overview;
      if (overview.bound === false) {
        state.facts = [];
        state.libraryResults = [];
      } else {
        if (!await refreshFacts(isCurrent)) return;
        state.recall = await controller.getRecallStatus().catch(() => undefined);
      }
      if (!isCurrent()) return;
      state.selectedFactId = state.facts[0]?.id ?? '';
      state.loading = false; state.errorDiagnostic = undefined; rerender();
      void updateProgress();
    } catch (error) {
      if (!isCurrent()) return;
      const diagnostic = describeMemoryError(error, 'MEMORY_WORKBENCH_LOAD_FAILED', 'workbench-load');
      state.loading = false; state.errorCode = diagnostic.code; state.errorDiagnostic = diagnostic; rerender();
      toast('error', diagnostic.title, diagnostic.reason, diagnostic.code);
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
          state.overview = overview;
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
  const loadPage = async (page: MemoryWorkbenchPage, options: { background?: boolean } = {}): Promise<void> => {
    if (disposed) return;
    const background = options.background === true;
    if (background && page !== state.page) return;
    if (!background) {
      backgroundPageRequestId += 1;
      librarySearchRequestId += 1;
    }
    const requestId = background ? ++backgroundPageRequestId : ++pageRequestId;
    const enteringInitialize = !background && page === 'initialize' && state.page !== 'initialize';
    if (enteringInitialize) state.includeInvisibleHistory = false;
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
            controller.listActors ? controller.listActors() : Promise.resolve([]),
            controller.listActorAliases ? controller.listActorAliases() : Promise.resolve([]),
            controller.listPendingActorCandidates ? controller.listPendingActorCandidates() : Promise.resolve([]),
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
      } else if (page === 'scenes') {
        const [scenes, episodes, observations, actors, aliases] = await Promise.all([
          controller.listSceneCasts ? controller.listSceneCasts() : Promise.resolve([]),
          controller.listEpisodes ? controller.listEpisodes() : Promise.resolve([]),
          controller.listObservations ? controller.listObservations() : Promise.resolve([]),
          controller.listActors ? controller.listActors() : Promise.resolve([]),
          controller.listActorAliases ? controller.listActorAliases() : Promise.resolve([]),
        ]);
        if (!isCurrent()) return;
        state.scenes = [...scenes];
        state.episodes = [...episodes];
        state.observations = [...observations];
        state.actors = [...actors];
        state.actorAliases = [...aliases];
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
          controller.listActors ? controller.listActors() : Promise.resolve([]),
          controller.listActorAliases ? controller.listActorAliases() : Promise.resolve([]),
          controller.listActorTraces ? controller.listActorTraces() : Promise.resolve([]),
          controller.listObservations ? controller.listObservations() : Promise.resolve([]),
          state.overview?.bound === false ? Promise.resolve([]) : controller.listFacts(),
        ]);
        if (!isCurrent()) return;
        state.actors = [...actors];
        state.actorAliases = [...aliases];
        state.actorTraces = [...traces];
        state.observations = [...observations];
        state.facts = facts;
        state.actorMemoryNow = Date.now();
        const actorMemory = actorMemoryState();
        normalizeActorMemorySelection(actorMemory);
        syncActorMemorySelection(actorMemory);
      } else if (page === 'profiles') {
        const profiles = controller.listActorProfiles ? [...await controller.listActorProfiles()] : [];
        if (!isCurrent()) return;
        state.profiles = profiles;
      } else if (page === 'dreams') {
        const dreams = controller.listActorDreams ? [...await controller.listActorDreams()] : [];
        if (!isCurrent()) return;
        state.dreams = dreams;
      } else if (page === 'initialize') {
        const [sources, initialization, sqlite] = await Promise.all([
          controller.getInitializationSources({ includeInvisibleHistory: state.includeInvisibleHistory }),
          controller.getInitializationState(),
          controller.getSqliteStatus().catch(() => undefined),
        ]);
        if (!isCurrent()) return;
        state.sources = sources;
        state.initialization = initialization;
        if (sqlite) state.sqlite = sqlite;
        state.selectedSourceKinds = state.sources.filter((source) => source.selected).map((source) => source.kind);
        const estimate = await controller.getInitializationEstimate(state.selectedSourceKinds, { includeInvisibleHistory: state.includeInvisibleHistory });
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
        const diagnostics = state.overview?.bound === false ? null : await controller.getLastRecall();
        if (!isCurrent()) return;
        state.diagnostics = diagnostics;
        if (state.overview?.bound === false) {
          state.graph = { nodes: [], edges: [] };
          state.graphStatus = controller.getGraphStatus();
        } else {
          const [graph, facts] = await Promise.all([
            controller.getRelationshipGraph('', 50),
            controller.listFacts(),
          ]);
          if (!isCurrent()) return;
          state.graph = graph;
          state.graphStatus = controller.getGraphStatus();
          state.facts = facts;
        }
      } else if (page === 'graph') {
        if (state.overview?.bound === false) {
          state.graph = { nodes: [], edges: [] };
          state.graphStatus = controller.getGraphStatus();
        } else {
          const [graph, facts] = await Promise.all([
            controller.getRelationshipGraph('', 50),
            controller.listFacts(),
          ]);
          if (!isCurrent()) return;
          state.graph = graph;
          state.graphStatus = controller.getGraphStatus();
          state.facts = facts;
          if (!graph.edges.some((edge) => edge.id === state.selectedGraphEdgeId)) state.selectedGraphEdgeId = '';
          if (!graph.edges.some((edge) => edge.id === state.selectedGraphEventId && edge.kind === 'event')) state.selectedGraphEventId = '';
          if (!graph.nodes.some((node) => node.id === state.selectedGraphNodeId)) state.selectedGraphNodeId = '';
        }
      } else if (page === 'audit') {
        if (state.overview?.bound === false) {
          state.audits = [];
          state.usages = [];
        } else {
          const audits = await controller.listAuditRecords();
          if (!isCurrent()) return;
          const usages = await controller.getMainChatUsage();
          if (!isCurrent()) return;
          state.audits = audits;
          state.usages = usages;
        }
        const sqlite = await controller.getSqliteStatus();
        if (!isCurrent()) return;
        state.sqlite = sqlite;
      } else if (page === 'data') {
        const sqlite = await controller.getSqliteStatus();
        if (!isCurrent()) return;
        state.sqlite = sqlite;
        if (state.overview) state.overview = {
          ...state.overview,
          currentChatSizeBytes: sqlite.currentChatSizeBytes,
          currentChatUsageRatio: sqlite.currentChatUsageRatio,
        };
      }
      if (!isCurrent()) return;
    } catch (error) {
      if (!isCurrent()) return;
      if (background) return;
      const diagnostic = describeMemoryError(error, 'MEMORY_WORKBENCH_PAGE_FAILED', 'workbench-page');
      state.errorCode = diagnostic.code;
      state.pageError = diagnostic;
      toast('error', diagnostic.title, diagnostic.reason, diagnostic.code);
    } finally {
      if (isCurrent()) {
        if (!background) state.pageLoading = false;
        rerender('', background);
      }
    }
  };
  const refreshAll = async (): Promise<void> => {
    state.busyAction = 'refresh'; rerender();
    try {
      const [sqlite, overview] = await Promise.all([controller.getSqliteStatus(), controller.getOverview()]);
      state.sqlite = sqlite;
      state.overview = overview;
      await loadPage(state.page);
      if (state.pageError) state.actionError = state.pageError;
      else {
        state.actionError = undefined;
        toast('success', '已刷新', '当前页面和工作台状态已经重新读取。', 'MEMORY_WORKBENCH_REFRESHED');
      }
    }
    catch (error) { const diagnostic = describeMemoryError(error, 'MEMORY_WORKBENCH_REFRESH_FAILED', 'operation'); state.actionError = diagnostic; toast('error', diagnostic.title, diagnostic.reason, diagnostic.code); }
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
    catch (error) { const diagnostic = describeMemoryError(error, `MEMORY_${action.toUpperCase()}_FAILED`, 'operation'); state.actionError = diagnostic; if (['initialize', 'reinitialize'].includes(action) && reload) await reload().catch(() => undefined); toast('error', diagnostic.title, diagnostic.reason, diagnostic.code); }
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
    const [overview, initialization, sources, progress, facts, sqlite] = await Promise.all([
      controller.getOverview(),
      controller.getInitializationState(),
      controller.getInitializationSources({ includeInvisibleHistory: state.includeInvisibleHistory }),
      controller.getCaptureProgress(),
      controller.listFacts(),
      controller.getSqliteStatus().catch(() => undefined),
    ]);
    state.overview = overview;
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
    state.estimate = await controller.getInitializationEstimate(state.selectedSourceKinds, { includeInvisibleHistory: state.includeInvisibleHistory });
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
    const storage = overview.bound ? formatBytes(overview.currentChatSizeBytes ?? 0) : '—';
    const storageRatio = overview.bound ? formatPercent(overview.currentChatUsageRatio ?? 0) : '—';
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
        <section class="stx-memory-overview-aside-section"><h4>快速入口</h4><p>更多查看与管理选项。</p><div class="stx-memory-overview-quick-grid">${shortcut('actors', 'users', '查看人物与别名')}${shortcut('profiles', 'address-card', '画像与关系')}${shortcut('audit', 'list-check', '查看审计记录')}<button class="stx-memory-overview-shortcut" type="button" data-action="refresh-health"><ss-helper-icon name="rotate" decorative></ss-helper-icon><span>刷新运行状态</span></button></div></section>
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
      <div class="stx-memory-actor-toolbar"><label class="stx-memory-search-wrap" for="stx-memory-actor-query"><span class="stx-memory-sr-only">搜索人物或别名</span><ss-helper-icon name="magnifying-glass" decorative></ss-helper-icon><input id="stx-memory-actor-query" ${uiControl('input')} data-actor-input="query" value="${escapeHtml(state.actorQuery)}" placeholder="搜索人物名称或别名"></label><label class="stx-memory-control-wrap"><span class="stx-memory-sr-only">人物状态</span><select ${uiControl('select')} aria-label="人物状态" data-actor-select="status"><option value="" ${state.actorStatus === '' ? 'selected' : ''}>全部状态</option><option value="confirmed" ${state.actorStatus === 'confirmed' ? 'selected' : ''}>已确认</option><option value="pending" ${state.actorStatus === 'pending' ? 'selected' : ''}>待确认</option><option value="unknown" ${state.actorStatus === 'unknown' ? 'selected' : ''}>未识别</option></select></label><div class="stx-memory-actor-counts" aria-label="人物注册表统计"><span><strong>${people.length}</strong> 人物</span><span><strong>${aliasCount}</strong> 别名</span><button ${uiControl('button', state.pendingActors.length ? 'primary' : 'neutral')} type="button" data-action="actor-tab" data-view="pending"><strong>${state.pendingActors.length}</strong> 待确认</button></div><button ${uiControl('button', 'neutral')} type="button" data-action="refresh-actors" ${busy ? 'disabled' : ''}><ss-helper-icon name="rotate" decorative></ss-helper-icon>刷新</button></div>
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
    : `<section class="stx-memory-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">L0–L5</span><h3>画像与关系</h3></div><span>${formatNumber(state.profiles.length)} 条声明</span></div><div class="stx-memory-reference-list">${state.profiles.map(profile => `<article class="stx-memory-evidence"><strong>${escapeHtml(String(profile.ownerId ?? profile.fromOwnerId ?? '主体'))}</strong><p>${escapeHtml(String(profile.claim ?? ''))}</p><small>引用：${escapeHtml(Array.isArray(profile.supportingTraceIds) ? profile.supportingTraceIds.join('、') : '无')}</small></article>`).join('')}</div></section>`;

  const renderDreams = (): string => state.dreams.length === 0
    ? renderEmpty('暂无 Dream 任务', 'Dream 默认按主体自动排队；也可以从后续操作入口手动 dry-run。')
    : `<section class="stx-memory-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">Dream Audit</span><h3>巩固任务</h3></div><span>${formatNumber(state.dreams.length)} 个任务</span></div><div class="stx-memory-reference-list">${state.dreams.map(job => `<article class="stx-memory-evidence"><strong>${escapeHtml(String(job.ownerId ?? '主体'))}</strong>${renderStatusChip(String(job.status ?? 'queued'), job.status === 'applied' ? 'success' : job.status === 'failed' ? 'error' : 'neutral')}<p>阶段：${escapeHtml(String(job.phase ?? 'gather'))}</p><small>任务：${escapeHtml(String(job.id ?? ''))}</small>${controller.runActorDream && job.id ? `<button ${uiControl('button', 'neutral')} type="button" data-action="dream-dry-run" data-job-id="${escapeHtml(String(job.id))}">dry-run 预览</button>` : ''}</article>`).join('')}</div></section>`;

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
      || state.overview?.errorCode === 'SQLITE_SERVICE_UNAVAILABLE';
    const summaryNote = settings.summaryBatchMode === 'chars'
      ? `按每批最多 ${formatNumber(settings.summaryBatchChars)} 字符拆分，批次间保留 ${formatNumber(settings.summaryOverlapFloors)} 层前置上下文；自动触发仍按 ${formatNumber(settings.summaryIntervalFloors)} 层间隔判断。`
      : `按每批 ${formatNumber(settings.summaryBatchFloors)} 层可见用户/助手消息拆分，批次间保留 ${formatNumber(settings.summaryOverlapFloors)} 层前置上下文；自动触发间隔为 ${formatNumber(settings.summaryIntervalFloors)} 层。`;
    const llmDetails = state.overview && !state.overview.llmAvailable ? readSafeLlmErrorDetails(state.overview) : undefined;
    const chatIdentity = formatChatIdentity(state.overview);
    return renderInitializationView({
      chatLabel: chatIdentity.label,
      chatBound: state.overview?.bound === true,
      workspaceAvailable: !storageUnavailable,
      workspaceReason: state.sqlite?.lastError
        ? safeInlineError(state.sqlite.lastError, 'SQLITE_SERVICE_UNAVAILABLE')
        : state.overview?.errorCode ? safeInlineError(state.overview.errorCode, 'SQLITE_SERVICE_UNAVAILABLE') : undefined,
      llmAvailable: state.overview?.llmAvailable === true,
      llmReason: llmDetails ? `${llmDetails.code} · ${llmDetails.resource} · ${llmDetails.model}` : undefined,
      sources: state.sources,
      selectedSourceKinds: state.selectedSourceKinds,
      includeInvisibleHistory: state.includeInvisibleHistory,
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
  const renderRecall = (): string => {
    const recall = state.recall;
    if (!recall) return renderEmpty('暂无召回状态', '点击刷新或稍后重试。');
    const coverage = recall.eligibleFacts ? Math.round((recall.indexedFacts / recall.eligibleFacts) * 100) : 0;
    const recallError = recall.degradedReason ?? recall.lastError;
    const rebuildDisabled = !recall.embedding.available || recall.rebuilding || Boolean(state.busyAction);
    const diagnostic = state.diagnostics == null
      ? renderEmpty('暂无召回诊断', '完成一次召回后，这里会显示诊断摘要。')
      : `<pre class="stx-memory-code">${escapeHtml(formatJson(state.diagnostics))}</pre>`;
    return `<div class="stx-memory-card-grid"><section class="stx-memory-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">当前策略</span><h3>${escapeHtml(translateRecallMode(recall.resolvedMode))}</h3></div>${renderStatusChip(recall.rebuilding ? '重建中' : '运行正常', recall.rebuilding ? 'warning' : 'success')}</div><div class="stx-memory-route-grid">${renderRoute('向量模型', recall.embedding)}${renderRoute('重排序模型', recall.rerank)}</div><div class="stx-memory-metric-grid"><div><span>已建立索引</span><strong>${formatNumber(recall.indexedFacts)}</strong></div><div><span>可索引事实</span><strong>${formatNumber(recall.eligibleFacts)}</strong></div><div><span>待处理</span><strong>${formatNumber(recall.pendingFacts)}</strong></div></div><div class="stx-memory-progress-copy"><span>向量覆盖率</span><strong>${coverage}%</strong></div><progress ${uiControl('progress')} max="100" value="${coverage}">${coverage}%</progress>${recallError ? `<p class="stx-memory-inline-alert" role="alert">错误码：${escapeHtml(safeInlineError(recallError, 'MEMORY_RECALL_DEGRADED'))}</p>` : ''}<div class="stx-memory-actions"><button ${uiControl('button', 'primary')} type="button" data-action="rebuild-index" ${rebuildDisabled ? 'disabled' : ''}><ss-helper-icon name="arrows-rotate" decorative></ss-helper-icon>重建向量索引</button></div>${recall.embedding.available ? '' : '<p class="stx-memory-muted">请先在 LLM 中配置可用的向量模型，再重建索引。</p>'}</section><section class="stx-memory-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">最近召回</span><h3>诊断摘要</h3></div></div>${diagnostic}${recall.batches.length ? `<div class="stx-memory-batch-table"><div class="stx-memory-table-row stx-memory-table-head"><span>批次</span><span>输入</span><span>延迟</span><span>接受</span></div>${recall.batches.map((batch) => `<div class="stx-memory-table-row"><span>#${batch.batchIndex + 1}</span><span>${formatNumber(batch.inputCount)}</span><span>${formatNumber(batch.latencyMs)} 毫秒</span><span>${formatNumber(batch.accepted)} / ${formatNumber(batch.rejected)}</span></div>`).join('')}</div>` : '<p class="stx-memory-muted">暂无向量批次记录。</p>'}</section></div>`;
  };
  const graphView = (): ReturnType<typeof selectGraphView> => {
    const graph = localizeLegacyGraphPreview(state.graph ?? { nodes: [], edges: [] });
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
    const graph = localizeLegacyGraphPreview(state.graph);
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
    const graph = state.graph ? localizeLegacyGraphPreview(state.graph) : undefined;
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
    const graph = state.graph ? localizeLegacyGraphPreview(state.graph) : undefined;
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
  const renderAudit = (): string => {
    const records = state.audits.length ? state.audits.map((record, index) => {
      const key = `${record.jobId ?? record.id ?? index}:${Number(record.batchIndex ?? index)}`;
      const isActorCapture = record.kind === 'capture-change-set-v0';
      const canRollback = isActorCapture
        ? Boolean(record.id && controller.rollbackActorCapture)
        : Boolean(record.jobId && Number.isInteger(record.batchIndex));
      const confirming = state.confirmBatchKey === key;
      const sourceCount = Array.isArray(record.sourceRefs) ? record.sourceRefs.length : 0;
      const rejectedCount = Array.isArray(record.rejected) ? record.rejected.length : 0;
      const acceptedCount = Number(record.accepted ?? record.factCount ?? 0);
      const batchNumber = Number.isInteger(record.batchIndex) ? Math.max(1, record.batchIndex!) : index + 1;
      const resource = formatAuditResource(record.resourceId ?? record.resource);
      const model = String(record.model ?? '未记录');
      const metrics = [
        ['来源', `${formatNumber(sourceCount)} 项`],
        ['事实', `${formatNumber(acceptedCount)} 条`],
        ['拒绝', `${formatNumber(rejectedCount)} 项`],
        ['资源', resource],
        ['模型', model],
      ];
      const rollback = !canRollback ? '' : confirming
        ? `<div class="stx-memory-confirm-inline"><span>${isActorCapture ? '确认回滚本次多主体 Capture？' : '确认回滚此批及后续批次？'}</span><button ${uiControl('button', 'danger')} type="button" data-action="confirm-rollback" data-job-id="${escapeHtml(record.jobId ?? '')}" data-batch-index="${Number(record.batchIndex ?? 0)}" data-audit-id="${escapeHtml(record.id ?? '')}">确认回滚</button><button ${uiControl('button', 'neutral')} type="button" data-action="cancel-rollback">取消</button></div>`
        : `<button ${uiControl('button', 'danger')} type="button" data-action="rollback" data-rollback-key="${escapeHtml(key)}">${isActorCapture ? '回滚本次 Capture' : '回滚此批及后续批次'}</button>`;
      const kicker = isActorCapture ? '多主体 Capture' : record.type === 'recall' ? '召回' : `捕获批次 ${batchNumber}`;
      const heading = translateRecordStatus(String(record.status ?? '已记录'));
      const rejections = (Array.isArray(record.rejected) ? record.rejected : [])
        .filter((item): item is import('../domain').AutomaticIngestRejection => Boolean(item && typeof item === 'object' && ('code' in item || 'id' in item)));
      const unresolved = rejections.filter(item => (item.status ?? 'unresolved') === 'unresolved' && Boolean(item.id));
      const unresolvedIds = new Set(unresolved.map(item => item.id!));
      const selectedIds = state.selectedRejectionIds.filter(id => unresolvedIds.has(id));
      const selectedTypes = new Set(unresolved.filter(item => item.id && selectedIds.includes(item.id)).map(item => item.recordType).filter(Boolean));
      const rejectionDetails = rejections.length === 0 ? '' : `<details class="stx-memory-capture-rejections" ${unresolved.length ? 'open' : ''}><summary>失败项 ${unresolved.length} 条待处理 / ${rejections.length} 条总计</summary><div class="stx-memory-rejection-list">${rejections.map((rejection) => {
        const rejectionId = rejection.id ?? '';
        const pending = (rejection.status ?? 'unresolved') === 'unresolved';
        const sourceRefs = rejection.sourceRefs ?? [];
        const statusLabel = pending ? '待处理' : rejection.status === 'repaired' ? '已修复' : rejection.status === 'ignored' ? '已忽略' : '处理中';
        return `<article class="stx-memory-rejection-item" data-rejection-status="${escapeHtml(rejection.status ?? 'unresolved')}"><label><input ${uiControl('checkbox')} type="checkbox" data-capture-rejection-id="${escapeHtml(rejectionId)}" ${selectedIds.includes(rejectionId) ? 'checked' : ''} ${!pending || !rejectionId || state.busyAction ? 'disabled' : ''}><span><strong>${escapeHtml(String(rejection.recordType ?? '记录'))} · ${escapeHtml(rejection.fieldPath ?? '结构')}</strong><small>${escapeHtml(rejection.message)}</small></span>${renderStatusChip(statusLabel, pending ? 'warning' : rejection.status === 'repaired' ? 'success' : 'neutral')}</label>${sourceRefs.length ? `<div class="stx-memory-rejection-sources">${sourceRefs.map(ref => renderSourceReference(ref)).join('')}</div>` : ''}<details><summary>查看候选快照</summary><pre class="stx-memory-code">${escapeHtml(formatJson(rejection.candidateSnapshot ?? {}))}</pre></details></article>`;
      }).join('')}</div>${unresolved.length ? `<div class="stx-memory-rejection-actions"><span>已选 ${selectedIds.length} 项 · 预计 ${selectedTypes.size} 次请求</span><button ${uiControl('button', 'primary')} type="button" data-action="repair-capture-rejections" data-audit-id="${escapeHtml(record.id ?? '')}" ${!selectedIds.length || !controller.repairCaptureRejections || state.busyAction ? 'disabled' : ''}>定向修复</button><button ${uiControl('button', 'neutral')} type="button" data-action="ignore-capture-rejections" data-audit-id="${escapeHtml(record.id ?? '')}" ${!selectedIds.length || !controller.ignoreCaptureRejections || state.busyAction ? 'disabled' : ''}>忽略所选</button></div>` : ''}</details>`;
      return `<article class="stx-memory-audit-item"><div class="stx-memory-audit-heading"><div><span class="stx-memory-kicker">${kicker}</span><h3>${escapeHtml(heading)}</h3></div>${renderStatusChip(`${formatNumber(acceptedCount)} 条事实 · 已接受`, record.outcome === 'partial' ? 'warning' : 'neutral')}</div><dl class="stx-memory-audit-metrics">${metrics.map(([label, value]) => `<div title="${escapeHtml(value)}"><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>${rejectionDetails}<details class="stx-memory-audit-details"><summary>查看技术明细</summary><pre class="stx-memory-code">${escapeHtml(formatJson(record))}</pre></details>${rollback ? `<div class="stx-memory-audit-actions">${rollback}</div>` : ''}</article>`;
    }).join('') : renderEmpty('暂无捕获审计', '新 Capture 完成后会在这里出现。');
    return `<div class="stx-memory-page-actions"><p class="stx-memory-muted">合法项已经提交；失败项可在对应 Capture 中选择修复或忽略。</p><button ${uiControl('button', 'neutral')} type="button" data-action="refresh-audit" ${state.busyAction ? 'disabled' : ''}><ss-helper-icon name="rotate" decorative></ss-helper-icon>刷新审计</button></div><div class="stx-memory-audit-list">${records}</div><details class="stx-memory-panel stx-memory-usage"><summary>主聊天 Token / usage（${state.usages.length} 条）</summary><pre class="stx-memory-code">${escapeHtml(formatJson(state.usages))}</pre></details>`;
  };
  const renderData = (): string => {
    const sqlite = state.sqlite;
    if (!sqlite) return renderEmpty('暂无存储状态', '点击刷新或稍后重试。');
    const schemaMatches = sqlite.schemaVersion === EXPECTED_SQLITE_SCHEMA_VERSION;
    const tableEntries = Object.entries(sqlite.tableCounts).sort(([left], [right]) => left.localeCompare(right));
    const chatUsageRatio = Math.max(0, Math.min(1, sqlite.currentChatUsageRatio));
    const databaseSize = sqlite.databaseSizeBytes > 0 ? formatBytes(sqlite.databaseSizeBytes) : '暂不可用';
    return `<section class="stx-memory-panel stx-memory-storage-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">SQLite 唯一存储</span><h3>${sqlite.connected ? '已连接' : '不可用'}</h3></div>${renderStatusChip(sqlite.connected ? '服务正常' : '不可用', sqlite.connected ? 'success' : 'error')}</div><dl class="stx-memory-maintenance-grid"><div><dt>SDK / 协议 / Schema</dt><dd>${escapeHtml(sqlite.serverVersion)} / v${sqlite.protocolVersion} / v${sqlite.schemaVersion}</dd></div><div><dt>SQLite / WAL</dt><dd>${escapeHtml(sqlite.sqliteVersion)} / ${escapeHtml(sqlite.walMode)}</dd></div><div><dt>Node.js</dt><dd>${escapeHtml(sqlite.nodeVersion)}</dd></div><div><dt>数据库 / WAL 占用</dt><dd>${escapeHtml(databaseSize)}</dd></div></dl><div class="stx-memory-chat-storage"><div class="stx-memory-chat-storage-head"><span><span class="stx-memory-storage-icon" aria-hidden="true"><ss-helper-icon name="hard-drive" decorative></ss-helper-icon></span><span><small>本聊天记忆占用</small><strong>${escapeHtml(formatBytes(sqlite.currentChatSizeBytes))}</strong></span></span><strong>${escapeHtml(formatPercent(chatUsageRatio))}</strong></div><progress ${uiControl('progress')} max="1" value="${chatUsageRatio}">${escapeHtml(formatPercent(chatUsageRatio))}</progress><p>占当前角色全部 Memory 数据；统计包含事实、证据、批次、Usage、召回日志和向量。</p></div><p class="stx-memory-muted stx-memory-path">相对路径：${escapeHtml(sqlite.databasePath)}</p><div class="stx-memory-progress-copy"><span>向量覆盖率</span><strong>${formatPercent(sqlite.vectorCoverage.ratio)}</strong></div><progress ${uiControl('progress')} max="1" value="${Math.max(0, Math.min(1, sqlite.vectorCoverage.ratio))}">${formatPercent(sqlite.vectorCoverage.ratio)}</progress>${schemaMatches ? '' : '<p class="stx-memory-inline-alert" role="alert">Schema 版本不匹配，请重启酒馆并确认服务端插件已更新。</p>'}${sqlite.lastError ? `<p class="stx-memory-inline-alert" role="alert">最近事务错误：${escapeHtml(safeInlineError(sqlite.lastError, 'MEMORY_SQLITE_TRANSACTION_FAILED'))}</p>` : ''}<details class="stx-memory-table-details"><summary>各表记录数与估算占用</summary><div class="stx-memory-table-list">${tableEntries.length ? tableEntries.map(([name, count]) => `<div><span>${escapeHtml(name)}</span><strong>${formatNumber(count)}</strong><small>${sqlite.tableBytes[name] == null ? 'N/A' : escapeHtml(formatBytes(sqlite.tableBytes[name]!))}</small></div>`).join('') : '<p class="stx-memory-muted">暂无表统计。</p>'}</div></details></section><section class="stx-memory-panel stx-memory-maintenance-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">备份与恢复</span><h3>维护工具</h3></div></div><div class="stx-memory-maintenance-actions"><button class="stx-memory-maintenance-action" ${uiControl('button', 'neutral')} type="button" data-action="export"><span class="stx-memory-maintenance-icon" aria-hidden="true"><ss-helper-icon name="file-export" decorative></ss-helper-icon></span><span><strong>导出 Memory 归档</strong><small>下载完整数据快照</small></span><span class="stx-memory-maintenance-chevron" aria-hidden="true"><ss-helper-icon name="chevron-right" decorative></ss-helper-icon></span></button><button class="stx-memory-maintenance-action" ${uiControl('button', 'neutral')} type="button" data-action="integrity" ${state.busyAction ? 'disabled' : ''}><span class="stx-memory-maintenance-icon" aria-hidden="true"><ss-helper-icon name="shield-halved" decorative></ss-helper-icon></span><span><strong>完整性检查</strong><small>检查 SQLite 数据结构</small></span><span class="stx-memory-maintenance-chevron" aria-hidden="true"><ss-helper-icon name="chevron-right" decorative></ss-helper-icon></span></button></div><div class="stx-memory-integrity-result" aria-live="polite"><span class="stx-memory-state-icon" aria-hidden="true"><ss-helper-icon name="circle-info" decorative></ss-helper-icon></span><span><strong>检查状态</strong><small>${escapeHtml(state.integrityText)}</small></span></div><section class="stx-memory-danger-zone"><div class="stx-memory-danger-heading"><span class="stx-memory-danger-icon" aria-hidden="true"><ss-helper-icon name="triangle-exclamation" decorative></ss-helper-icon></span><span><strong>危险操作</strong><small>执行前需要再次确认，聊天原文不会被删除。</small></span></div><div class="stx-memory-danger-actions">${state.dangerConfirm === 'current' ? `<div class="stx-memory-confirm-panel"><p>确认清空当前聊天来源？其他聊天仍有证据支持的事实会保留。</p><button ${uiControl('button', 'danger')} type="button" data-action="confirm-clear-current">确认清空</button><button ${uiControl('button', 'neutral')} type="button" data-action="cancel-danger">取消</button></div>` : `<button class="stx-memory-danger-action" ${uiControl('button', 'danger')} type="button" data-action="clear-current"><span class="stx-memory-danger-action-icon" aria-hidden="true"><ss-helper-icon name="eraser" decorative></ss-helper-icon></span><span class="stx-memory-danger-action-label">清空当前聊天来源</span></button>`}${state.dangerConfirm === 'all' ? `<div class="stx-memory-confirm-panel"><p>输入“清空全部记忆”后确认，此操作无法撤销。</p><input ${uiControl('input')} data-clear-all-text placeholder="清空全部记忆"><button ${uiControl('button', 'danger')} type="button" data-action="confirm-clear-all">确认清空全部</button><button ${uiControl('button', 'neutral')} type="button" data-action="cancel-danger">取消</button></div>` : `<button class="stx-memory-danger-action" ${uiControl('button', 'danger')} type="button" data-action="clear-all"><span class="stx-memory-danger-action-icon" aria-hidden="true"><ss-helper-icon name="trash-can" decorative></ss-helper-icon></span><span class="stx-memory-danger-action-label">清空全部角色记忆</span></button>`}</div></section></section>`;
  };
  const renderPage = (): string => {
    if (state.loading) return renderLoading('正在读取记忆工作台…');
    if (state.errorDiagnostic && !state.overview) return renderErrorDetails(state.errorDiagnostic, 'retry-load');
    if (state.pageLoading) return renderLoading();
    if (state.pageError) return renderErrorDetails(state.pageError, 'retry-page');
    const actionError = state.actionError ? renderErrorDetails(state.actionError, 'dismiss-error') : '';
    const content = state.page === 'overview' ? renderOverview()
      : state.page === 'actors' ? renderActors()
        : state.page === 'scenes' ? renderScenes()
          : state.page === 'library' ? renderLibrary()
            : state.page === 'actor-memory' ? renderActorMemory()
              : state.page === 'profiles' ? renderProfiles()
                : state.page === 'dreams' ? renderDreams()
                  : state.page === 'initialize' ? renderInitialize()
                    : state.page === 'recall' ? `${renderRecall()}<section class="stx-memory-panel stx-memory-graph-inline"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">关系图谱</span><h3>已验证事实关系</h3></div></div>${renderGraph()}</section>`
                      : state.page === 'graph' ? renderGraph()
                        : state.page === 'audit' ? `${renderAudit()}${renderData()}` : renderData();
    return `${actionError}${content}`;
  };
  const render = (): void => {
    traceMemoryStartup('workbench:render-begin');
    const overview = state.overview;
    const currentPage = PAGES.find((page) => page.id === state.page) ?? INTERNAL_PAGES.find((page) => page.id === state.page) ?? PAGES[0]!;
    const currentPageIndex = PAGES.findIndex((page) => page.id === state.page);
    const statusTone = overview?.status === 'error' ? 'error' : overview?.status === 'working' ? 'warning' : overview?.status === 'ready' ? 'success' : 'neutral';
    const runtimeDiagnostic = !overview ? undefined : !overview.llmAvailable
      ? {
          code: 'LLM_SERVICE_UNAVAILABLE',
          title: '大语言模型服务不可用',
          reason: 'Memory 当前无法连接 LLM 插件，自动整理和需要模型的召回步骤会暂停或降级。',
          action: '请确认 LLM 插件已启用并完成资源配置，然后点击“重新检查”。',
          retryable: true,
        } satisfies MemoryErrorDiagnostic
      : overview.status === 'error'
        ? overview.errorDiagnostic ?? describeMemoryError(overview.error ?? overview.errorCode, overview.errorCode ?? 'MEMORY_RUNTIME_ERROR', 'health')
        : undefined;
    const alertMarkup = runtimeDiagnostic ? `<div class="stx-memory-alert">${renderErrorDetails(runtimeDiagnostic, 'refresh-health')}</div>` : '';
    const chatIdentity = formatChatIdentity(overview);
    const chatStorageLabel = overview?.bound ? formatBytes(overview.currentChatSizeBytes ?? 0) : '—';
    const chatStorageRatio = overview?.bound ? formatPercent(overview.currentChatUsageRatio ?? 0) : '—';
    const sceneHeader = state.page === 'scenes' ? getSceneEventsHeader(sceneEventsState()) : undefined;
    const pageDescription = sceneHeader?.description ?? currentPage.description;
    const pageCounter = sceneHeader?.count ?? (currentPageIndex >= 0 ? `${currentPageIndex + 1} / ${PAGES.length}` : '诊断内页');
    const pageTitle = state.page === 'initialize' ? '初始化记忆' : currentPage.label;
    const libraryRecallStatus = !state.recall
      ? renderStatusChip('召回状态未知', 'neutral')
      : state.recall.rebuilding
        ? renderStatusChip('索引重建中', 'warning')
        : state.recall.degradedReason || state.recall.lastError
          ? renderStatusChip('召回降级', 'warning')
          : renderStatusChip('召回可用', 'success');
    const pageHeadingAction = state.page === 'initialize'
      ? `<button class="stx-memory-initialize-refresh" ${uiButton('neutral', 'sm')} type="button" data-action="refresh-initialization" ${state.busyAction ? 'disabled' : ''}><ss-helper-icon name="rotate" decorative></ss-helper-icon>刷新状态</button>`
      : state.page === 'library'
        ? `<div class="stx-memory-library-heading-actions">${libraryRecallStatus}<button ${uiButton('neutral', 'sm')} type="button" data-action="refresh-library" ${state.busyAction ? 'disabled' : ''}><ss-helper-icon name="rotate" decorative></ss-helper-icon>刷新</button></div>`
        : `<span class="stx-memory-page-counter">${escapeHtml(pageCounter)}</span>`;
    root.innerHTML = `<div class="stx-memory-statusbar"><div class="stx-memory-chat-identity"><span class="stx-memory-kicker">当前聊天</span><strong>${escapeHtml(chatIdentity.label)}</strong></div><div><span class="stx-memory-kicker">运行状态</span>${renderStatusChip(overview ? translateOverviewStatus(overview.status) : '读取中', statusTone)}</div><div><span class="stx-memory-kicker">记忆数量</span><strong>${overview ? formatNumber(overview.factCount) : '—'}</strong></div><div class="stx-memory-status-storage"><span class="stx-memory-kicker">本聊天记忆占用</span><strong>${escapeHtml(chatStorageLabel)}</strong><small>占角色记忆 ${escapeHtml(chatStorageRatio)}</small></div><div><span class="stx-memory-kicker">大语言模型</span>${renderStatusChip(overview ? (overview.llmAvailable ? '可用' : '不可用') : '读取中', overview?.llmAvailable ? 'success' : overview ? 'warning' : 'neutral')}</div>${renderOverviewRouteStatus('向量模型', overview?.embedding)}${renderOverviewRouteStatus('重排序模型', overview?.rerank)}${alertMarkup}</div><div class="stx-memory-workspace-layout"><nav class="stx-memory-nav" aria-label="记忆工作台页面"><span class="stx-memory-nav-label">工作区</span>${PAGES.map((page) => `<button class="stx-memory-nav-item" type="button" data-action="navigate" data-page="${page.id}" aria-current="${page.id === state.page ? 'page' : 'false'}"><ss-helper-icon name="${page.icon}" decorative></ss-helper-icon><span><strong>${page.label}</strong><small>${page.description}</small></span></button>`).join('')}<div class="stx-memory-nav-meta">${overview?.lastOrganizedAt ? `最近整理<br>${escapeHtml(formatTime(overview.lastOrganizedAt))}` : '仅展示当前已实现能力'}</div></nav><main class="stx-memory-main"><header class="stx-memory-page-heading"><div><h2>${pageTitle}</h2><p>${escapeHtml(pageDescription)}</p></div>${pageHeadingAction}</header><section class="stx-memory-page-content" tabindex="-1">${renderPage()}</section><div class="stx-memory-internal-routes" hidden aria-hidden="true">${INTERNAL_PAGES.map((page) => `<button type="button" data-action="navigate-internal" data-page="${page.id}" aria-current="${page.id === state.page ? 'page' : 'false'}">${page.label}</button>`).join('')}</div></main></div>`;
    traceMemoryStartup('workbench:dom-rendered');
    popupUi?.refreshControls(root);
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
        graph: localizeLegacyGraphPreview(state.graph),
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
    if (action === 'refresh-health') { void runAction('refresh-health', async () => { state.sqlite = await controller.getSqliteStatus(); await loadOverview(); }, '检查已完成', '工作台状态已重新读取。', 'MEMORY_HEALTH_REFRESHED'); return; }
    if (action === 'jump-to-message') {
      if (!navigateToMessage) return;
      const messageId = actionNode.dataset.messageId?.trim();
      const rawIndex = actionNode.dataset.messageIndex;
      const index = rawIndex === undefined ? undefined : Number(rawIndex);
      const target: ChatNavigationTarget = {
        ...(messageId ? { messageId } : {}),
        ...(index !== undefined && Number.isSafeInteger(index) && index >= 0 ? { index } : {}),
      };
      void navigateToMessage(target).catch(() => toast('warning', '无法跳转聊天楼层', '对应消息可能尚未加载或已被删除。', 'MEMORY_MESSAGE_NAVIGATION_UNAVAILABLE'));
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
    if (action === 'initialize-start') { const selectedKinds = [...state.selectedSourceKinds]; if (!selectedKinds.length || state.busyAction || !state.overview?.llmAvailable) return; void runAction('initialize', () => controller.initialize(selectedKinds, { includeInvisibleHistory: state.includeInvisibleHistory }), '初始化已完成', '当前聊天已经可以使用记忆召回。', 'MEMORY_INITIALIZE_COMPLETED', async () => { await refreshInitialization(selectedKinds); }); return; }
    if (action === 'initialize-resume') { if (state.busyAction || !state.overview?.llmAvailable) return; void runAction('initialize-resume', () => controller.retry(), '初始化已完成', '已继续处理暂存结果，当前聊天已经可以使用记忆召回。', 'MEMORY_INITIALIZE_RESUMED', async () => { await refreshInitialization(state.selectedSourceKinds); }); return; }
    if (action === 'initialize-cancel') { void runAction('cancel-capture', () => controller.cancelCapture(), '初始化已取消', '已停止继续处理新批次。', 'MEMORY_INITIALIZE_CANCELLED', async () => { await updateProgress(); }); return; }
    if (action === 'view-library') { void loadPage('library'); return; }
    if (action === 'open-reinitialize') {
      if (state.busyAction || !state.overview?.llmAvailable) return;
      state.includeInvisibleHistory = false;
      const successfulKinds = state.initialization?.selectedSourceKinds.filter((kind) => state.sources.some((source) => source.kind === kind)) ?? [];
      state.selectedSourceKinds = successfulKinds.length ? successfulKinds : state.sources.filter((source) => source.selected).map((source) => source.kind);
      state.reinitializeOpen = true;
      rerender('#stx-memory-reinitialize-cancel');
      void Promise.all([
        controller.getInitializationSources({ includeInvisibleHistory: false }),
        controller.getInitializationEstimate(state.selectedSourceKinds, { includeInvisibleHistory: false }),
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
      if (!selectedKinds.length || state.busyAction || !state.overview?.llmAvailable || Boolean(state.progress && ['queued', 'running', 'paused'].includes(state.progress.status))) return;
      state.reinitializeOpen = false;
      void runAction('reinitialize', () => controller.reinitialize(selectedKinds, { includeInvisibleHistory: state.includeInvisibleHistory }), '重新初始化已完成', '旧 Memory 数据已替换，当前聊天已经可以使用记忆召回。', 'MEMORY_REINITIALIZE_COMPLETED', async () => { await refreshInitialization(selectedKinds); });
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
    if (action === 'repair-capture-rejections' || action === 'ignore-capture-rejections') {
      const auditId = actionNode.dataset.auditId ?? '';
      const record = state.audits.find(item => item.id === auditId);
      const validIds = new Set((Array.isArray(record?.rejected) ? record.rejected : [])
        .filter((item): item is import('../domain').AutomaticIngestRejection => Boolean(item && typeof item === 'object' && ('code' in item || 'id' in item)))
        .filter(item => (item.status ?? 'unresolved') === 'unresolved' && Boolean(item.id))
        .map(item => item.id!));
      const rejectionIds = state.selectedRejectionIds.filter(id => validIds.has(id));
      if (!auditId || rejectionIds.length === 0) {
        toast('warning', '请选择失败项', '至少选择一条待处理记录。', 'MEMORY_CAPTURE_REJECTION_SELECTION_REQUIRED');
        return;
      }
      if (action === 'repair-capture-rejections' && controller.repairCaptureRejections) {
        void runAction('repair-capture-rejections', () => controller.repairCaptureRejections!(auditId, rejectionIds), '定向修复已完成', '通过校验的记录已经写入，仍失败的项目继续保留。', 'MEMORY_CAPTURE_REJECTIONS_REPAIRED', async () => {
          state.selectedRejectionIds = state.selectedRejectionIds.filter(id => !validIds.has(id));
          await loadPage('audit');
          await refreshFacts();
        });
      } else if (action === 'ignore-capture-rejections' && controller.ignoreCaptureRejections) {
        void runAction('ignore-capture-rejections', () => controller.ignoreCaptureRejections!(auditId, rejectionIds), '失败项已忽略', '这些项目保留在审计中，不会写入记忆。', 'MEMORY_CAPTURE_REJECTIONS_IGNORED', async () => {
          state.selectedRejectionIds = state.selectedRejectionIds.filter(id => !validIds.has(id));
          await loadPage('audit');
        });
      }
      return;
    }
    if (action === 'refresh-audit') { void loadPage('audit'); return; }
    if (action === 'rollback') { state.confirmBatchKey = actionNode.dataset.rollbackKey ?? ''; rerender(); return; }
    if (action === 'cancel-rollback') { state.confirmBatchKey = ''; rerender(); return; }
    if (action === 'confirm-rollback') {
      const auditId = actionNode.dataset.auditId ?? '';
      if (auditId && controller.rollbackActorCapture) {
        void runAction('rollback-actor-capture', () => controller.rollbackActorCapture!(auditId), 'Capture 已回滚', '多主体事实、观察、痕迹与派生记录已撤销。', 'MEMORY_ACTOR_CAPTURE_ROLLED_BACK', async () => { state.confirmBatchKey = ''; await loadPage('audit'); await refreshFacts(); });
        return;
      }
      const jobId = actionNode.dataset.jobId ?? '';
      const batchIndex = Number(actionNode.dataset.batchIndex);
      if (!jobId || !Number.isInteger(batchIndex)) return;
      void runAction('rollback', () => controller.rollbackBatch(jobId, batchIndex), '批次已回滚', formatRollbackConfirmation(jobId, batchIndex), 'MEMORY_BATCH_ROLLED_BACK', async () => { state.confirmBatchKey = ''; await loadPage('audit'); await refreshFacts(); });
      return;
    }
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
    if (input.dataset.option === 'include-invisible-history') {
      state.includeInvisibleHistory = (input as HTMLInputElement).checked;
      void Promise.all([
        controller.getInitializationSources({ includeInvisibleHistory: state.includeInvisibleHistory }),
        controller.getInitializationEstimate(state.selectedSourceKinds, { includeInvisibleHistory: state.includeInvisibleHistory }),
      ]).then(([sources, estimate]) => {
        if (disposed) return;
        state.sources = sources.map((source) => ({ ...source, selected: state.selectedSourceKinds.includes(source.kind) && source.count > 0 }));
        state.selectedSourceKinds = state.selectedSourceKinds.filter((kind) => state.sources.some((source) => source.kind === kind && source.count > 0));
        state.estimate = estimate;
        rerender();
      }).catch((error) => toast('error', '估算失败', '无法更新初始化消息范围。', safeErrorCode(error, 'MEMORY_ESTIMATE_FAILED')));
      return;
    }
    if (input.dataset.sourceKind) { const selected = (input as HTMLInputElement).checked; state.selectedSourceKinds = selected ? [...new Set([...state.selectedSourceKinds, input.dataset.sourceKind])] : state.selectedSourceKinds.filter((kind) => kind !== input.dataset.sourceKind); void controller.getInitializationEstimate(state.selectedSourceKinds, { includeInvisibleHistory: state.includeInvisibleHistory }).then((estimate) => { if (!disposed) { state.estimate = estimate; rerender(); } }).catch((error) => toast('error', '估算失败', '无法更新初始化成本估算。', safeErrorCode(error, 'MEMORY_ESTIMATE_FAILED'))); return; }
  }, { signal: abortController.signal });
  root.addEventListener('pointermove', (event) => {
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
  document.addEventListener('click', (event) => {
    if (!state.openFilter || event.composedPath().includes(root)) return;
    state.openFilter = '';
    rerender();
  }, { signal: abortController.signal });

  removeOverviewChanged = controller.onOverviewChanged?.(() => { void refreshLiveSnapshot(); });
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
    disposed = true; pageRequestId += 1; backgroundPageRequestId += 1; progressRequestId += 1; librarySearchRequestId += 1; overviewRequestId += 1; abortController.abort();
    if (searchTimer) window.clearTimeout(searchTimer);
    if (graphSearchTimer) window.clearTimeout(graphSearchTimer);
    if (progressTimer) window.clearTimeout(progressTimer);
    if (renderFrame !== undefined) window.cancelAnimationFrame(renderFrame);
    if (graphMarqueeResizeFrame !== undefined) window.cancelAnimationFrame(graphMarqueeResizeFrame);
    if (graphListModeFrame !== undefined) window.cancelAnimationFrame(graphListModeFrame);
    removeOverviewChanged?.();
    graphMarqueeResizeObserver?.disconnect();
    graphRenderer?.dispose();
    graphRenderer = undefined;
    sceneRendererToken += 1;
    sceneRenderer?.dispose();
    sceneRenderer = undefined;
    root.replaceChildren();
  };
}
