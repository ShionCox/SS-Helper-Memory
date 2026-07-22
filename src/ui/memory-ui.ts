import './memory.css';
import {
  UI_CONTROL_ATTRIBUTE,
  UI_CONTROL_TONE_ATTRIBUTE,
  type PopupUiContext,
  type ToastNotification,
  type UiControlKind,
  type UiControlTone,
  type ChatNavigationTarget,
} from '@ss-helper/sdk';
import type { SummaryInitializationEstimate } from '../application/ingest/summary-strategy';
import type { MemoryGraphPreview, MemoryGraphStatus } from '../domain';
import { describeMemoryError, type MemoryErrorDiagnostic } from '../diagnostics/memory-error';
import { traceMemoryStartup } from '../host/runtime-feedback';
import { mountRelationshipGraphThree, type RelationshipGraphCommand, type RelationshipGraphRenderer } from './relationship-graph-three';
import { selectGraphView } from './relationship-graph-layout';

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
  /** Optional notification for background overview diagnostics finishing. */
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
  listSceneCasts?(): Promise<readonly import('../domain').SceneCast[]>;
  listActorTraces?(ownerId?: string): Promise<readonly import('../domain').ActorMemoryTrace[]>;
  listActorProfiles?(ownerId?: string): Promise<readonly Record<string, unknown>[]>;
  listActorDreams?(ownerId?: string): Promise<readonly Record<string, unknown>[]>;
  runActorDream?(jobId: string, options?: { readonly dryRun?: boolean; readonly narrative?: boolean }): Promise<import('../application/dream').DreamAudit>;
  rollbackActorDream?(auditId: string): Promise<void>;
  listActorCorrectionReviews?(): Promise<readonly ActorCorrectionReview[]>;
  resolveActorCorrection?(auditId: string, action: 'confirm' | 'undo'): Promise<void>;
  listPendingActorCandidates?(): Promise<readonly import('../domain').ActorCandidate[]>;
  confirmActorCandidate?(candidateId: string, canonicalName?: string): Promise<void>;
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
  { id: 'actors', label: '人物与别名', description: '主体发现与待确认归属', icon: 'users' },
  { id: 'scenes', label: '场景与事件', description: '在场、提及与事件来源', icon: 'timeline' },
  { id: 'library', label: '记忆库', description: '浏览与编辑事实', icon: 'book-open' },
  { id: 'actor-memory', label: '角色记忆', description: '按主体查看记忆痕迹', icon: 'brain' },
  { id: 'profiles', label: '画像与关系', description: '来源支撑的增量画像', icon: 'address-card' },
  { id: 'dreams', label: 'Dream', description: '逐主体巩固、审计与回滚', icon: 'moon' },
  { id: 'recall', label: '召回与索引', description: '检查检索链路', icon: 'magnifying-glass-chart' },
  { id: 'audit', label: '审计记录', description: '查看整理批次', icon: 'list-check' },
];
const INTERNAL_PAGES: ReadonlyArray<{ id: MemoryWorkbenchPage; label: string; description: string; icon: string }> = [
  { id: 'initialize', label: '初始化', description: '捕获当前聊天来源（场景页内）', icon: 'wand-magic-sparkles' },
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
  pendingActors: Array<import('../domain').ActorCandidate>;
  actorCorrectionReviews: ActorCorrectionReview[];
  scenes: Array<import('../domain').SceneCast>;
  actorTraces: Array<import('../domain').ActorMemoryTrace>;
  profiles: Array<Record<string, unknown>>;
  dreams: Array<Record<string, unknown>>;
  facts: MemoryUiFact[];
  query: string;
  selectedKinds: string[];
  selectedStatuses: string[];
  openFilter: '' | 'kind' | 'status';
  sort: FactViewOptions['sort'];
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
  dangerConfirm: '' | 'current' | 'all';
}

function uiControl(kind: UiControlKind, tone?: UiControlTone): string {
  return `${UI_CONTROL_ATTRIBUTE}="${kind}"${tone === undefined ? '' : ` ${UI_CONTROL_TONE_ATTRIBUTE}="${tone}"`}`;
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
  let pageRequestId = 0;
  let graphRenderer: RelationshipGraphRenderer | undefined;
  const requestedGraphPage = initialActionId === 'open-relationship-graph' || initialActionId === 'rebuild-relationship-graph';
  const state: WorkbenchState = {
    page: requestedGraphPage ? 'graph' : 'library', loading: true, pageLoading: false, busyAction: '', errorCode: '', actors: [], pendingActors: [], actorCorrectionReviews: [], scenes: [], actorTraces: [], profiles: [], dreams: [], facts: [], query: '', selectedKinds: Object.keys(FACT_KIND_LABELS), selectedStatuses: Object.keys(FACT_STATUS_LABELS), openFilter: '', sort: 'updated_desc',
    selectedFactId: '', editingFactId: '', confirmFactId: '', sources: [], selectedSourceKinds: [], includeInvisibleHistory: false, reinitializeOpen: false, audits: [], usages: [], integrityText: '尚未执行完整性检查。', confirmBatchKey: '', dangerConfirm: '', graphQuery: '', graphKind: '', graphStatusFilter: '', graphListMode: 'edges', selectedGraphEdgeId: '', selectedGraphEventId: '', selectedGraphNodeId: '', graphNeighborFocus: false,
  };

  const toast = (level: ToastNotification['level'], title: string, message: string, code: string): void => {
    notify({ level, title, message, code, durationMs: level === 'error' ? 0 : 3200 });
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
      ? `<button class="stx-memory-reference-jump" ${uiControl('button', 'neutral')} type="button" ${action}><ss-helper-icon name="link" decorative></ss-helper-icon></button><span>${label}</span>`
      : `<button class="stx-memory-reference-link" ${uiControl('button', 'neutral')} type="button" ${action}>${label}</button>`;
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
    try { state.progress = await controller.getCaptureProgress(); } catch { state.progress = undefined; }
    if (disposed || requestId !== progressRequestId) return;
    rerender('', true);
    scheduleProgress();
  };
  const refreshFacts = async (): Promise<void> => {
    if (state.overview?.bound === false) {
      state.facts = [];
      state.selectedFactId = '';
      return;
    }
    state.facts = await controller.listFacts(state.query);
    if (!state.facts.some((fact) => fact.id === state.selectedFactId)) state.selectedFactId = state.facts[0]?.id ?? '';
  };
  const loadOverview = async (): Promise<void> => {
    state.loading = true; state.errorCode = ''; state.errorDiagnostic = undefined; rerender();
    try {
      state.overview = await controller.getOverview();
      state.facts = state.overview.bound === false ? [] : await controller.listFacts(state.query);
      state.selectedFactId = state.facts[0]?.id ?? '';
      state.loading = false; state.errorDiagnostic = undefined; rerender();
      void updateProgress();
    } catch (error) {
      const diagnostic = describeMemoryError(error, 'MEMORY_WORKBENCH_LOAD_FAILED', 'workbench-load');
      state.loading = false; state.errorCode = diagnostic.code; state.errorDiagnostic = diagnostic; rerender();
      toast('error', diagnostic.title, diagnostic.reason, diagnostic.code);
    }
  };
  const refreshOverviewSnapshot = async (): Promise<void> => {
    if (disposed) return;
    try {
      const overview = await controller.getOverview();
      if (disposed) return;
      state.overview = overview;
      rerender('', true);
    } catch { /* background route diagnostics must not interrupt the workbench */ }
  };
  const loadPage = async (page: MemoryWorkbenchPage): Promise<void> => {
    if (disposed) return;
    const requestId = ++pageRequestId;
    const enteringInitialize = page === 'initialize' && state.page !== 'initialize';
    if (enteringInitialize) state.includeInvisibleHistory = false;
    state.page = page; state.pageLoading = true; state.pageError = undefined; rerender();
    const isCurrent = (): boolean => !disposed && requestId === pageRequestId;
    try {
      if (page === 'overview') {
        state.overview = await controller.getOverview();
      } else if (page === 'actors') {
        const [actors, pending, reviews] = await Promise.all([
          controller.listActors ? controller.listActors() : Promise.resolve([]),
          controller.listPendingActorCandidates ? controller.listPendingActorCandidates() : Promise.resolve([]),
          controller.listActorCorrectionReviews ? controller.listActorCorrectionReviews() : Promise.resolve([]),
        ]);
        state.actors = [...actors]; state.pendingActors = [...pending]; state.actorCorrectionReviews = [...reviews];
      } else if (page === 'scenes') {
        const [scenes, sources, initialization] = await Promise.all([
          controller.listSceneCasts ? controller.listSceneCasts() : Promise.resolve([]),
          controller.getInitializationSources({ includeInvisibleHistory: state.includeInvisibleHistory }),
          controller.getInitializationState(),
        ]);
        state.scenes = [...scenes];
        state.sources = sources;
        state.initialization = initialization;
        state.selectedSourceKinds = state.sources.filter((source) => source.selected).map((source) => source.kind);
        state.estimate = await controller.getInitializationEstimate(state.selectedSourceKinds, { includeInvisibleHistory: state.includeInvisibleHistory });
        state.progress = await controller.getCaptureProgress();
      } else if (page === 'actor-memory') {
        state.actorTraces = controller.listActorTraces ? [...await controller.listActorTraces()] : [];
      } else if (page === 'profiles') {
        state.profiles = controller.listActorProfiles ? [...await controller.listActorProfiles()] : [];
      } else if (page === 'dreams') {
        state.dreams = controller.listActorDreams ? [...await controller.listActorDreams()] : [];
      } else if (page === 'initialize') {
        const [sources, initialization] = await Promise.all([
          controller.getInitializationSources({ includeInvisibleHistory: state.includeInvisibleHistory }),
          controller.getInitializationState(),
        ]);
        if (!isCurrent()) return;
        state.sources = sources;
        state.initialization = initialization;
        state.selectedSourceKinds = state.sources.filter((source) => source.selected).map((source) => source.kind);
        state.estimate = await controller.getInitializationEstimate(state.selectedSourceKinds, { includeInvisibleHistory: state.includeInvisibleHistory });
        if (!isCurrent()) return;
        state.progress = await controller.getCaptureProgress();
        if (!isCurrent()) return;
        scheduleProgress();
      } else if (page === 'recall') {
        state.recall = await controller.getRecallStatus();
        if (!isCurrent()) return;
        state.diagnostics = state.overview?.bound === false ? null : await controller.getLastRecall();
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
          state.audits = await controller.listAuditRecords();
          if (!isCurrent()) return;
          state.usages = await controller.getMainChatUsage();
        }
        state.sqlite = await controller.getSqliteStatus();
      } else if (page === 'data') {
        state.sqlite = await controller.getSqliteStatus();
        if (state.overview) state.overview = {
          ...state.overview,
          currentChatSizeBytes: state.sqlite.currentChatSizeBytes,
          currentChatUsageRatio: state.sqlite.currentChatUsageRatio,
        };
      }
      if (!isCurrent()) return;
    } catch (error) {
      if (!isCurrent()) return;
      const diagnostic = describeMemoryError(error, 'MEMORY_WORKBENCH_PAGE_FAILED', 'workbench-page');
      state.errorCode = diagnostic.code;
      state.pageError = diagnostic;
      toast('error', diagnostic.title, diagnostic.reason, diagnostic.code);
    } finally {
      if (isCurrent()) { state.pageLoading = false; rerender(); }
    }
  };
  const refreshAll = async (): Promise<void> => {
    state.busyAction = 'refresh'; rerender();
    try { state.sqlite = await controller.getSqliteStatus(); await controller.getOverview().then((overview) => { state.overview = overview; }); await refreshFacts(); state.actionError = undefined; toast('success', '已刷新', '记忆工作台数据已更新。', 'MEMORY_WORKBENCH_REFRESHED'); }
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
  const refreshInitialization = async (preferredKinds?: readonly string[]): Promise<void> => {
    await controller.getSqliteStatus().catch(() => undefined);
    const [overview, initialization, sources, progress, facts] = await Promise.all([
      controller.getOverview(),
      controller.getInitializationState(),
      controller.getInitializationSources({ includeInvisibleHistory: state.includeInvisibleHistory }),
      controller.getCaptureProgress(),
      controller.listFacts(state.query),
    ]);
    state.overview = overview;
    state.initialization = initialization;
    state.sources = sources;
    state.progress = progress;
    state.facts = facts;
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
    return `<section class="stx-memory-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">当前工作区</span><h3>${escapeHtml(overview.chatName ?? overview.chatKey ?? '未选择聊天')}</h3></div>${renderStatusChip(overview.status === 'ready' ? '已就绪' : overview.status, overview.status === 'ready' ? 'success' : overview.status === 'error' ? 'error' : 'neutral')}</div><dl class="stx-memory-detail-grid"><div><dt>事实</dt><dd>${formatNumber(overview.factCount)}</dd></div><div><dt>待处理任务</dt><dd>${formatNumber(overview.pendingJobs)}</dd></div><div><dt>向量模型</dt><dd>${escapeHtml(overview.embedding?.model ?? '未配置')}</dd></div><div><dt>当前聊天</dt><dd>${escapeHtml(overview.bound ? '已绑定' : '未选择')}</dd></div></dl></section><section class="stx-memory-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">多主体链路</span><h3>角色认知状态</h3></div></div><p class="stx-memory-muted">人物、场景、角色记忆、画像和 Dream 均按主体独立保存；世界规范不会自动广播给人物。</p></section>`;
  };

  const renderActors = (): string => `<section class="stx-memory-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">Actor Registry</span><h3>人物与别名</h3></div><span>${formatNumber(state.actors.length)} 个主体</span></div>${state.actors.length === 0 ? renderEmpty('尚未发现卡内人物', '进入聊天并完成一次 Capture 后，明确人物会出现在这里。') : `<div class="stx-memory-reference-list">${state.actors.map(actor => `<article class="stx-memory-evidence"><strong>${escapeHtml(actor.displayName)}</strong>${renderStatusChip(actor.kind === 'actor' ? actor.status : actor.kind, actor.status === 'confirmed' ? 'success' : 'warning')}<p>${escapeHtml(actor.aliases.join('、') || '无别名')}</p><small>owner_id：${escapeHtml(actor.id)} · 置信度 ${Math.round(actor.confidence * 100)}%</small></article>`).join('')}</div>`}</section>${state.pendingActors.length > 0 ? `<section class="stx-memory-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">Pending</span><h3>待确认归属</h3></div><span>${formatNumber(state.pendingActors.length)} 条</span></div><div class="stx-memory-reference-list">${state.pendingActors.map(candidate => `<article class="stx-memory-evidence"><strong>${escapeHtml(candidate.displayName)}</strong><p>来源：${escapeHtml(candidate.sourceRefs.join('、') || '无')}；置信度 ${Math.round(candidate.confidence * 100)}%</p><button ${uiControl('button', 'primary')} type="button" data-action="confirm-actor" data-candidate-id="${escapeHtml(candidate.localId)}">确认归属</button></article>`).join('')}</div></section>` : ''}${state.actorCorrectionReviews.length > 0 ? `<section class="stx-memory-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">Audit</span><h3>人物纠正审计</h3></div><span>${formatNumber(state.actorCorrectionReviews.length)} 条</span></div><div class="stx-memory-reference-list">${state.actorCorrectionReviews.map(review => `<article class="stx-memory-evidence"><strong>${escapeHtml(review.operation)}</strong>${renderStatusChip(review.status, review.status === 'undone' ? 'neutral' : 'success')}<small>${escapeHtml(review.id)}</small>${controller.resolveActorCorrection && review.status === 'applied' ? `<button ${uiControl('button', 'neutral')} type="button" data-action="undo-actor-correction" data-audit-id="${escapeHtml(review.id)}">撤销</button>` : ''}</article>`).join('')}</div></section>` : ''}`;

  const renderScenes = (): string => `${state.scenes.length === 0
    ? renderEmpty('暂无场景事件', '完成一次 Capture 后，这里显示参与者、在场者、提及者和来源楼层。')
    : `<section class="stx-memory-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">SceneCast</span><h3>场景与事件</h3></div><span>${formatNumber(state.scenes.length)} 个场景</span></div><div class="stx-memory-reference-list">${state.scenes.map(scene => `<article class="stx-memory-evidence"><strong>第 ${scene.floor} 层 · ${escapeHtml(scene.chatKey)}</strong><p>发言：${escapeHtml(scene.speakerOwnerIds.join('、') || '无')}；在场：${escapeHtml(scene.presentOwnerIds.join('、') || '无')}；提及：${escapeHtml(scene.mentionedOwnerIds.join('、') || '无')}</p><small>视角：${escapeHtml(scene.viewpointOwnerId)}</small></article>`).join('')}</div></section>`}
    <section class="stx-memory-panel stx-memory-capture-inline"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">Capture</span><h3>初始化与重新捕获</h3></div></div><p class="stx-memory-muted">来源选择、进度与重新初始化操作已收口到本页；聊天原文不会被改写。</p></section>${renderInitialize()}`;

  const renderActorMemory = (): string => state.actorTraces.length === 0
    ? renderEmpty('暂无角色记忆痕迹', '只有有来源观察支撑的主体认知才会显示。')
    : `<section class="stx-memory-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">ActorMemoryTrace</span><h3>角色记忆</h3></div><span>${formatNumber(state.actorTraces.length)} 条痕迹</span></div><div class="stx-memory-reference-list">${state.actorTraces.map(trace => `<article class="stx-memory-evidence"><strong>${escapeHtml(trace.ownerId)} · ${escapeHtml(trace.factId)}</strong>${renderStatusChip(trace.knowledgeMode, trace.privacy === 'private' || trace.privacy === 'secret' ? 'warning' : 'neutral')}<p>强度 ${Math.round(trace.strength)} · 清晰度 ${Math.round(trace.clarity)} · 置信度 ${Math.round(trace.beliefConfidence * 100)}%</p><small>观察来源：${escapeHtml(trace.sourceObservationIds.join('、') || '无')}</small></article>`).join('')}</div></section>`;

  const renderProfiles = (): string => state.profiles.length === 0
    ? renderEmpty('暂无画像增量', '画像必须满足证据重复门槛或高情绪显著度，并且每条声明都引用 Trace。')
    : `<section class="stx-memory-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">L0–L5</span><h3>画像与关系</h3></div><span>${formatNumber(state.profiles.length)} 条声明</span></div><div class="stx-memory-reference-list">${state.profiles.map(profile => `<article class="stx-memory-evidence"><strong>${escapeHtml(String(profile.ownerId ?? profile.fromOwnerId ?? '主体'))}</strong><p>${escapeHtml(String(profile.claim ?? ''))}</p><small>引用：${escapeHtml(Array.isArray(profile.supportingTraceIds) ? profile.supportingTraceIds.join('、') : '无')}</small></article>`).join('')}</div></section>`;

  const renderDreams = (): string => state.dreams.length === 0
    ? renderEmpty('暂无 Dream 任务', 'Dream 默认按主体自动排队；也可以从后续操作入口手动 dry-run。')
    : `<section class="stx-memory-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">Dream Audit</span><h3>巩固任务</h3></div><span>${formatNumber(state.dreams.length)} 个任务</span></div><div class="stx-memory-reference-list">${state.dreams.map(job => `<article class="stx-memory-evidence"><strong>${escapeHtml(String(job.ownerId ?? '主体'))}</strong>${renderStatusChip(String(job.status ?? 'queued'), job.status === 'applied' ? 'success' : job.status === 'failed' ? 'error' : 'neutral')}<p>阶段：${escapeHtml(String(job.phase ?? 'gather'))}</p><small>任务：${escapeHtml(String(job.id ?? ''))}</small>${controller.runActorDream && job.id ? `<button ${uiControl('button', 'neutral')} type="button" data-action="dream-dry-run" data-job-id="${escapeHtml(String(job.id))}">dry-run 预览</button>` : ''}</article>`).join('')}</div></section>`;

  const renderLibrary = (): string => {
    const visibleFacts = filterAndSortFacts(state.facts, { kind: state.selectedKinds, status: state.selectedStatuses, sort: state.sort });
    const selected = visibleFacts.find((fact) => fact.id === state.selectedFactId) ?? visibleFacts[0];
    const list = visibleFacts.length === 0
      ? renderEmpty('没有匹配的记忆', state.query ? '尝试缩短关键词或清除筛选条件。' : '当前聊天还没有可展示的事实。')
      : visibleFacts.map((fact) => `<button class="stx-memory-fact-row" ${uiControl('button', 'neutral')} type="button" data-action="select-fact" data-fact-id="${escapeHtml(fact.id)}" aria-selected="${fact.id === selected?.id ? 'true' : 'false'}"><span class="stx-memory-fact-row-top"><strong>${escapeHtml(translateFactKind(fact.kind))}</strong><time datetime="${new Date(fact.updatedAt).toISOString()}">${escapeHtml(formatTime(fact.updatedAt))}</time></span><span class="stx-memory-fact-snippet">${escapeHtml(fact.content)}</span><span class="stx-memory-fact-row-footer">${renderStatusChip(translateFactStatus(fact.status), fact.status === 'active' ? 'success' : fact.status === 'invalid' ? 'error' : 'neutral')}<span class="stx-memory-fact-confidence"><span>置信度</span><strong>${Math.round(fact.confidence * 100)}%</strong></span></span></button>`).join('');
    const detail = !selected ? renderEmpty('选择一条记忆', '右侧会显示证据、替代链和可执行操作。') : (() => {
      const editing = state.editingFactId === selected.id;
      const confirming = state.confirmFactId === selected.id;
      const replacement = [selected.supersedesId ? '替代上一版本' : '', selected.supersededById ? '已被新版本替代' : ''].filter(Boolean).join(' · ') || '无';
      return `<div class="stx-memory-detail-head"><div><span class="stx-memory-kicker">记忆审阅</span><h3>${escapeHtml(translateFactKind(selected.kind))}</h3></div><time class="stx-memory-detail-time" datetime="${new Date(selected.updatedAt).toISOString()}">${escapeHtml(formatTime(selected.updatedAt))}</time></div>
        <div class="stx-memory-detail-summary">${renderStatusChip(translateFactStatus(selected.status), selected.status === 'active' ? 'success' : selected.status === 'invalid' ? 'error' : 'neutral')}<div><span>置信度</span><strong>${Math.round(selected.confidence * 100)}%</strong></div><div><span>证据</span><strong>${selected.evidence.length} 条</strong></div></div>
        ${editing ? `<label class="stx-memory-field-label" for="stx-memory-edit-content">编辑记忆内容</label><textarea id="stx-memory-edit-content" class="stx-memory-textarea-layout" ${uiControl('textarea')} data-edit-content>${escapeHtml(selected.content)}</textarea><div class="stx-memory-actions"><button ${uiControl('button', 'primary')} type="button" data-action="save-fact" data-fact-id="${escapeHtml(selected.id)}" ${state.busyAction === 'save-fact' ? 'disabled' : ''}>保存</button><button ${uiControl('button', 'neutral')} type="button" data-action="cancel-edit">取消</button></div>` : `<section class="stx-memory-content-card" aria-labelledby="stx-memory-content-label"><h4 id="stx-memory-content-label">记忆内容</h4><p class="stx-memory-fact-content">${escapeHtml(selected.content)}</p></section><div class="stx-memory-actions"><button ${uiControl('button', 'primary')} type="button" data-action="edit-fact" data-fact-id="${escapeHtml(selected.id)}">编辑</button>${confirming ? `<span class="stx-memory-confirm-inline"><span>确认删除？</span><button ${uiControl('button', 'danger')} type="button" data-action="confirm-delete" data-fact-id="${escapeHtml(selected.id)}">确认</button><button ${uiControl('button', 'neutral')} type="button" data-action="cancel-delete">取消</button></span>` : `<button ${uiControl('button', 'danger')} type="button" data-action="delete-fact" data-fact-id="${escapeHtml(selected.id)}">删除</button>`}</div>`}
        <section class="stx-memory-detail-section"><div class="stx-memory-section-heading"><div><h4>来源与证据</h4><p>核对记忆是否忠于聊天原文</p></div><span>${selected.evidence.length} 条</span></div><div class="stx-memory-evidence-list">${selected.evidence.length ? selected.evidence.map((item) => `<blockquote class="stx-memory-evidence"><p>${escapeHtml(item.excerpt)}</p><footer>${renderSourceReference(item.sourceRef, 'evidence')}</footer></blockquote>`).join('') : '<p class="stx-memory-muted">没有可展示的来源证据。</p>'}</div></section>
        <div class="stx-memory-detail-grid"><section><h4>来源引用</h4><div class="stx-memory-reference-list">${selected.sourceRefs.length ? selected.sourceRefs.map((item) => renderSourceReference(item)).join('') : '<span>无</span>'}</div></section><section><h4>版本关系</h4><p>${escapeHtml(replacement)}</p></section></div>
        <section class="stx-memory-detail-section"><h4>捕获记录</h4><div class="stx-memory-reference-list">${selected.auditBatches?.length ? selected.auditBatches.map((item) => { const batch = Math.max(1, Number(item.batchIndex) || 1); return `<span>第 ${batch} 批 · ${escapeHtml(translateRecordStatus(item.status))}</span>`; }).join('') : '<span>暂无匹配批次</span>'}</div></section>`;
    })();
    const chatIdentity = formatChatIdentity(state.overview);
    const renderMultiFilter = (filter: 'kind' | 'status', allLabel: string, selectedValues: readonly string[], options: Readonly<Record<string, string>>): string => {
      const entries = Object.entries(options);
      const allSelected = selectedValues.length === entries.length;
      const partiallySelected = selectedValues.length > 0 && !allSelected;
      const selectedLabel = allSelected ? allLabel : selectedValues.length === 0 ? `未选择${filter === 'kind' ? '类型' : '状态'}` : selectedValues.length === 1 ? options[selectedValues[0]!] : `已选 ${selectedValues.length} 项`;
      const triggerId = `stx-memory-${filter}-filter-trigger`;
      const menuId = `stx-memory-${filter}-filter-menu`;
      const allStateLabel = allSelected ? '已全部选择' : partiallySelected ? `已选 ${selectedValues.length} / ${entries.length}` : '未选择';
      const allMark = allSelected ? '<ss-helper-icon name="check" decorative></ss-helper-icon>' : partiallySelected ? '<ss-helper-icon name="minus" decorative></ss-helper-icon>' : '';
      return `<div class="stx-memory-control-wrap stx-memory-multi-filter" data-multi-filter="${filter}"><button id="${triggerId}" class="stx-memory-multi-filter-trigger" ${uiControl('button', 'neutral')} type="button" data-action="toggle-filter-menu" data-filter-menu="${filter}" aria-haspopup="true" aria-expanded="${state.openFilter === filter}" aria-controls="${menuId}"><span>${escapeHtml(selectedLabel)}</span><ss-helper-icon name="chevron-${state.openFilter === filter ? 'up' : 'down'}" decorative></ss-helper-icon></button>${state.openFilter === filter ? `<div id="${menuId}" class="stx-memory-multi-filter-menu" role="group" aria-labelledby="${triggerId}"><label class="stx-memory-multi-filter-option stx-memory-multi-filter-all ${allSelected ? 'is-selected' : partiallySelected ? 'is-partial' : ''}"><span class="stx-memory-multi-filter-option-label"><strong>${allLabel}</strong><small>${allStateLabel}</small></span><span class="stx-memory-multi-filter-mark" aria-hidden="true">${allMark}</span><input class="stx-memory-multi-filter-native stx-memory-sr-only" ${uiControl('checkbox')} type="checkbox" data-filter-all="${filter}" data-selected-count="${selectedValues.length}" data-option-count="${entries.length}" aria-checked="${partiallySelected ? 'mixed' : allSelected}" ${allSelected ? 'checked' : ''}></label>${entries.map(([value, label]) => { const selected = selectedValues.includes(value); return `<label class="stx-memory-multi-filter-option ${selected ? 'is-selected' : ''}"><span class="stx-memory-multi-filter-option-label">${escapeHtml(label)}</span><span class="stx-memory-multi-filter-mark" aria-hidden="true">${selected ? '<ss-helper-icon name="check" decorative></ss-helper-icon>' : ''}</span><input class="stx-memory-multi-filter-native stx-memory-sr-only" ${uiControl('checkbox')} type="checkbox" data-filter-option="${filter}" value="${escapeHtml(value)}" ${selected ? 'checked' : ''}></label>`; }).join('')}</div>` : ''}</div>`;
    };
    return `<div class="stx-memory-toolbar"><label class="stx-memory-search-wrap"><span class="stx-memory-sr-only">搜索记忆</span><ss-helper-icon name="magnifying-glass" decorative></ss-helper-icon><input ${uiControl('input')} data-filter="query" value="${escapeHtml(state.query)}" placeholder="搜索记忆内容、人物或地点" /></label>${renderMultiFilter('kind', '全部类型', state.selectedKinds, FACT_KIND_LABELS)}${renderMultiFilter('status', '全部状态', state.selectedStatuses, FACT_STATUS_LABELS)}<label class="stx-memory-control-wrap"><span class="stx-memory-sr-only">排序</span><select ${uiControl('select')} aria-label="排序" data-filter="sort"><option value="updated_desc" ${state.sort === 'updated_desc' ? 'selected' : ''}>最近更新</option><option value="confidence_desc" ${state.sort === 'confidence_desc' ? 'selected' : ''}>置信度</option><option value="kind_asc" ${state.sort === 'kind_asc' ? 'selected' : ''}>类型</option></select></label><button ${uiControl('button', 'neutral')} type="button" data-action="refresh" ${state.busyAction ? 'disabled' : ''}><ss-helper-icon name="rotate" decorative></ss-helper-icon>刷新</button></div><div class="stx-memory-result-line"><span aria-live="polite">共 ${visibleFacts.length} 条记忆</span><span>当前聊天：${escapeHtml(chatIdentity.label)}</span></div><div class="stx-memory-library-grid"><section class="stx-memory-fact-list" aria-label="记忆列表">${list}</section><section class="stx-memory-inspector" aria-label="记忆详情">${detail}</section></div>`;
  };
  const renderInitialize = (): string => {
    const progress = state.progress;
    const initialization = state.initialization;
    const summarySettings = controller.getSettings();
    const { summaryBatchMode, summaryBatchFloors, summaryBatchChars, summaryIntervalFloors, summaryOverlapFloors } = summarySettings;
    const summaryNote = (summaryBatchMode === 'chars'
      ? `按每批最多 ${formatNumber(summaryBatchChars)} 字符拆分，批次间保留 ${formatNumber(summaryOverlapFloors)} 层前置上下文；自动触发仍按 ${formatNumber(summaryIntervalFloors)} 层间隔判断。`
      : `按每批 ${formatNumber(summaryBatchFloors)} 层可见用户/助手消息拆分，批次间保留 ${formatNumber(summaryOverlapFloors)} 层前置上下文；自动触发间隔为 ${formatNumber(summaryIntervalFloors)} 层。`);
    const storageUnavailable = state.overview?.status === 'error' || state.overview?.errorCode === 'SQLITE_SERVICE_UNAVAILABLE';
    const running = !storageUnavailable && Boolean(progress && ['queued', 'running'].includes(progress.status));
    const storageAlert = storageUnavailable
      ? `<p class="stx-memory-inline-alert" role="alert">Memory workspace 当前不可用，已安全停用整理与召回。请先删除旧 SQLite 数据并重新启动酒馆；当前实现不会自动迁移或清空旧库。${state.overview?.errorCode ? `（错误码：${escapeHtml(safeInlineError(state.overview.errorCode, 'SQLITE_SERVICE_UNAVAILABLE'))}）` : ''}</p>`
      : '';
    const submitting = ['initialize', 'reinitialize'].includes(state.busyAction);
    const phaseLabel = '捕获记忆';
    const statusLabel = submitting && (!progress || progress.status === 'idle')
      ? '正在提交 LLM 请求'
      : progress
      ? progress.status === 'running' ? `正在${phaseLabel}`
          : progress.status === 'queued' ? '已提交，等待 LLM'
            : progress.status === 'completed' ? '已完成'
              : progress.status === 'cancelled' ? '已取消'
              : progress.status === 'failed' ? '失败'
                : progress.status === 'paused' ? '已暂停' : '空闲'
        : '尚未读取';
    const feedback = submitting
      ? progress?.status === 'running'
        ? '正在提取并写入结构化记忆，事件、观察、事实和主体痕迹在同一事务中提交。'
        : progress?.status === 'queued' ? '请求已进入 LLM 队列，等待模型反馈。'
          : '正在读取当前聊天来源并提交 LLM 请求…'
      : progress?.status === 'completed' ? '捕获流程已完成，结构化结果已写入数据库。'
        : progress?.status === 'paused' ? '可重试错误已暂停当前捕获任务，可直接继续。' : '';
    const sourceLabel = (kind: string): string => state.sources.find((source) => source.kind === kind)?.label ?? kind;
    const selectedCount = state.selectedSourceKinds.length;
    const latestAttempt = initialization?.attempts[0];
    const sourceCoverage = initialization?.selectedSourceKinds.length || selectedCount;
    const sourceTotal = state.sources.length;
    const messageSource = state.sources.find((source) => source.kind === 'message');
    const invisibleHistoryCount = messageSource?.invisibleCount
      ?? Math.max(0, (messageSource?.rawCount ?? 0) - (messageSource?.defaultCount ?? 0));
    const hasInvisibleHistory = Boolean(messageSource && invisibleHistoryCount > 0);
    const renderSourceChoices = (locked: boolean): string => `<div class="stx-memory-source-list">${state.sources.length ? state.sources.map((source) => `<label class="stx-memory-source-option ${state.selectedSourceKinds.includes(source.kind) ? 'is-selected' : ''}"><input ${uiControl('checkbox')} type="checkbox" data-source-kind="${escapeHtml(source.kind)}" ${state.selectedSourceKinds.includes(source.kind) ? 'checked' : ''} ${locked || source.count === 0 ? 'disabled' : ''}><span><strong>${escapeHtml(source.label)}</strong><small>${formatNumber(source.count)} / ${formatNumber(source.rawCount)} 项${source.excludedCount > 0 ? ` · 排除 ${formatNumber(source.excludedCount)}` : ''}</small></span></label>`).join('') : renderEmpty('当前没有可初始化来源', '请先选择角色或打开聊天。')}</div>`;
    const renderInvisibleHistoryOption = (locked: boolean): string => {
      if (!hasInvisibleHistory) return '';
      const current = messageSource?.count ?? 0;
      const raw = messageSource?.rawCount ?? 0;
      const defaultCount = messageSource?.defaultCount ?? current;
      const excluded = messageSource?.excludedCount ?? Math.max(0, raw - current);
      return `<section class="stx-memory-invisible-history-option"><label><input ${uiControl('checkbox')} type="checkbox" data-option="include-invisible-history" ${state.includeInvisibleHistory ? 'checked' : ''} ${locked ? 'disabled' : ''}><span><strong>包含 AI 不可见历史正文（本次）</strong><small>当前 ${formatNumber(current)} / ${formatNumber(raw)} 条；默认安全范围为 ${formatNumber(defaultCount)} 条。</small></span></label>${state.includeInvisibleHistory ? `<p class="stx-memory-inline-alert" role="status">已纳入被酒馆标记为不可见的历史正文；仍会排除工具输出、隐藏推理和清洗后为空的控制块（当前仍排除 ${formatNumber(excluded)} 条）。</p>` : '<p class="stx-memory-muted">默认只处理 AI 可见的用户/助手消息。此选项只对本次初始化生效，暂停后继续会沿用任务断点。</p>'}</section>`;
    };
    const estimateMarkup = state.estimate ? `<dl class="stx-memory-estimate-grid"><div><dt>预计批次</dt><dd>${formatNumber(state.estimate.batchCount)}</dd></div><div><dt>Token 下限</dt><dd>${formatNumber(state.estimate.tokenLow)}</dd></div><div><dt>Token 上限</dt><dd>${formatNumber(state.estimate.tokenHigh)}</dd></div></dl>` : '';
    const progressMarkup = `<section class="stx-memory-panel stx-memory-initialize-progress"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">正在捕获 · ${escapeHtml(phaseLabel)}</span><h3>${escapeHtml(statusLabel)}</h3></div>${progress?.jobId ? renderStatusChip('任务进行中', 'warning') : ''}</div>${feedback ? `<p class="stx-memory-capture-feedback" role="status" aria-live="polite"><ss-helper-icon name="sparkles" decorative></ss-helper-icon>${escapeHtml(feedback)}</p>` : ''}<div class="stx-memory-locked-sources"><span>已锁定来源</span><strong>${escapeHtml(state.selectedSourceKinds.map(sourceLabel).join('、') || '无')}</strong></div>${progress ? `<div class="stx-memory-progress-copy"><span>当前批次 ${progress.batchIndex} / ${progress.totalBatches || 0}</span><span>${formatNumber(progress.processedCount)} 项 · ${Math.round(progress.elapsedMs / 1000)} 秒</span></div><progress ${uiControl('progress')} max="${Math.max(progress.totalBatches, 1)}" value="${Math.min(progress.batchIndex, Math.max(progress.totalBatches, 1))}">${progress.batchIndex}</progress>${progress.error ? `<p class="stx-memory-inline-alert" role="alert">错误码：${escapeHtml(safeInlineError(progress.error, 'MEMORY_CAPTURE_FAILED'))}</p>` : ''}` : ''}<div class="stx-memory-actions"><button ${uiControl('button', 'danger')} type="button" data-action="initialize-cancel" ${state.busyAction ? 'disabled' : ''}><ss-helper-icon name="stop" decorative></ss-helper-icon>取消任务</button></div></section>`;
    const activities = initialization?.attempts.length ? initialization.attempts.map((attempt) => {
      const tone = attempt.status === 'completed' ? 'success' : attempt.status === 'failed' ? 'error' : attempt.status === 'running' || attempt.status === 'queued' ? 'warning' : 'neutral';
      const icon = attempt.status === 'completed' ? 'circle-check' : attempt.status === 'failed' ? 'circle-xmark' : 'clock';
      const sourceNames = attempt.selectedSourceKinds.map(sourceLabel).join('、') || '全部可用来源';
      return `<article class="stx-memory-activity-item is-${escapeHtml(attempt.status)}"><ss-helper-icon name="${icon}" decorative></ss-helper-icon><div><div><strong>${escapeHtml(translateRecordStatus(attempt.status))}</strong>${renderStatusChip(`${formatNumber(attempt.totalBatches)} 批`, tone)}</div><time datetime="${new Date(attempt.updatedAt).toISOString()}">${escapeHtml(formatTime(attempt.updatedAt))}</time><p>${escapeHtml(sourceNames)} · ${attempt.includeInvisibleHistory ? '含不可见历史正文' : '仅 AI 可见消息'}</p>${attempt.error ? `<small title="${escapeHtml(attempt.error)}">${escapeHtml(safeInlineError(attempt.error, 'MEMORY_CAPTURE_FAILED'))}</small>` : ''}</div></article>`;
    }).join('') : renderEmpty('暂无初始化记录', '完成初始化后会在这里保留最近 5 次活动。');
    const drawerDisabled = storageUnavailable || !selectedCount || !state.overview?.llmAvailable || running || Boolean(state.busyAction);
    const drawer = !state.reinitializeOpen ? '' : `<div class="stx-memory-reinitialize-layer"><button class="stx-memory-drawer-backdrop" type="button" data-action="cancel-reinitialize" aria-label="关闭重新初始化确认"></button><aside class="stx-memory-reinitialize-drawer" role="alertdialog" aria-modal="true" aria-labelledby="stx-memory-reinitialize-title" aria-describedby="stx-memory-reinitialize-description"><header><div><span class="stx-memory-kicker">危险操作确认</span><h3 id="stx-memory-reinitialize-title">重新初始化当前聊天</h3></div><button ${uiControl('button', 'neutral')} type="button" data-action="cancel-reinitialize" aria-label="关闭"><ss-helper-icon name="xmark" decorative></ss-helper-icon></button></header><div class="stx-memory-drawer-body"><p id="stx-memory-reinitialize-description" class="stx-memory-drawer-warning"><ss-helper-icon name="triangle-exclamation" decorative></ss-helper-icon><span><strong>这会清空当前聊天的全部 Memory 派生数据</strong><small>清空后立即按下方来源重新开始初始化；如果新任务失败，旧数据无法恢复。</small></span></p><section><div class="stx-memory-section-heading"><div><h4>选择重新整理的来源</h4><p>估算会随勾选结果实时更新</p></div><span>${selectedCount} / ${sourceTotal}</span></div>${renderSourceChoices(false)}</section>${renderInvisibleHistoryOption(false)}${estimateMarkup}<section class="stx-memory-clear-scope"><h4>将清理</h4><ul><li>事实、证据、主体痕迹与派生索引</li><li>捕获任务、审计与 Usage</li><li>召回日志和总结进度</li></ul></section><section class="stx-memory-safe-scope"><h4>不会影响</h4><ul><li>聊天原文与消息</li><li>角色卡、世界书和其他聊天</li></ul></section>${!state.overview?.llmAvailable ? '<p class="stx-memory-inline-alert" role="alert">大语言模型不可用，暂时不能重新初始化。</p>' : !selectedCount ? '<p class="stx-memory-inline-alert" role="alert">请至少选择一个来源。</p>' : ''}</div><footer><button id="stx-memory-reinitialize-cancel" ${uiControl('button', 'neutral')} type="button" data-action="cancel-reinitialize">取消</button><button ${uiControl('button', 'danger')} type="button" data-action="confirm-reinitialize" ${drawerDisabled ? 'disabled' : ''}><ss-helper-icon name="trash-can-arrow-up" decorative></ss-helper-icon>清空并重新初始化</button></footer></aside></div>`;
    if (running || submitting) return `<div class="stx-memory-initialize-shell"><div class="stx-memory-initialize-layout is-running">${progressMarkup}<section class="stx-memory-panel stx-memory-activity-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">最近活动</span><h3>初始化记录</h3></div><span>${initialization?.attempts.length ?? 0} / 5</span></div><div class="stx-memory-activity-list">${activities}</div></section></div></div>`;
    if (initialization?.initialized) {
      return `<div class="stx-memory-initialize-shell"><div class="stx-memory-initialize-layout"><section class="stx-memory-panel stx-memory-initialize-summary">${storageAlert}<div class="stx-memory-initialize-success"><span><ss-helper-icon name="circle-check" decorative></ss-helper-icon></span><div><span class="stx-memory-kicker">初始化状态</span><h3>已初始化</h3><p>完成于 ${escapeHtml(formatTime(initialization.lastCompletedAt))}</p></div>${renderStatusChip('召回可用', 'success')}</div><dl class="stx-memory-initialize-metrics"><div><dt>来源覆盖</dt><dd>${formatNumber(sourceCoverage)} / ${formatNumber(sourceTotal)}</dd></div><div><dt>记忆事实</dt><dd>${formatNumber(state.overview?.factCount ?? 0)}</dd></div><div><dt>占用空间</dt><dd>${escapeHtml(formatBytes(state.overview?.currentChatSizeBytes ?? 0))}</dd></div><div><dt>预计批次</dt><dd>${formatNumber(state.estimate?.batchCount ?? 0)}</dd></div></dl><p class="stx-memory-initialize-note"><ss-helper-icon name="circle-info" decorative></ss-helper-icon><span>当前聊天已经可以使用记忆召回。最近的失败任务只会记录在右侧，不会覆盖这次有效初始化。</span></p><div class="stx-memory-actions"><button ${uiControl('button', 'primary')} type="button" data-action="view-library"><ss-helper-icon name="book-open" decorative></ss-helper-icon>查看记忆库</button><button id="stx-memory-reinitialize-trigger" ${uiControl('button', 'neutral')} type="button" data-action="open-reinitialize" ${storageUnavailable || state.busyAction || !state.overview?.llmAvailable ? 'disabled' : ''}><ss-helper-icon name="rotate" decorative></ss-helper-icon>重新初始化</button></div></section><section class="stx-memory-panel stx-memory-activity-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">最近活动</span><h3>初始化记录</h3></div><span>${initialization.attempts.length} / 5</span></div><div class="stx-memory-activity-list">${activities}</div></section></div>${drawer}</div>`;
    }
    const clearedAfterFailure = latestAttempt?.status === 'failed';
    const resumable = latestAttempt?.status === 'paused';
    const setupKicker = resumable ? '可继续' : clearedAfterFailure ? '需要重试' : '首次使用';
    const setupHeading = resumable ? '初始化已暂停' : clearedAfterFailure ? '当前未初始化' : '初始化当前聊天';
    const setupNotice = resumable
      ? '<p class="stx-memory-inline-alert" role="status">已保留已完成批次及整理进度。可直接继续，无需重新提取已暂存内容。</p>'
      : clearedAfterFailure
        ? '<p class="stx-memory-inline-alert" role="alert">旧 Memory 数据已清空，上一次重新初始化失败。请选择来源后直接重试。</p>'
        : '<p class="stx-memory-muted">选择用于建立记忆的来源。初始化只读取内容，不会改写聊天原文、角色卡或世界书。</p>';
    const setupAction = resumable
      ? `<button ${uiControl('button', 'primary')} type="button" data-action="initialize-resume" ${storageUnavailable || state.busyAction || !state.overview?.llmAvailable ? 'disabled' : ''}><ss-helper-icon name="play" decorative></ss-helper-icon>继续初始化</button>`
      : `<button ${uiControl('button', 'primary')} type="button" data-action="initialize-start" ${storageUnavailable || !selectedCount || !state.sources.length || state.busyAction || !state.overview?.llmAvailable ? 'disabled' : ''}><ss-helper-icon name="play" decorative></ss-helper-icon>${clearedAfterFailure ? '重新尝试初始化' : '开始初始化'}</button>`;
    return `<div class="stx-memory-initialize-shell"><div class="stx-memory-initialize-layout"><section class="stx-memory-panel stx-memory-initialize-setup"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">${setupKicker}</span><h3>${setupHeading}</h3></div>${state.estimate ? renderStatusChip(`${formatNumber(state.estimate.messageCount)} 条消息`, 'neutral') : ''}</div>${storageAlert}${setupNotice}${resumable ? '' : `${renderSourceChoices(false)}${renderInvisibleHistoryOption(false)}${estimateMarkup}<p class="stx-memory-estimate-note">${escapeHtml(summaryNote)} 实际批次会随清洗和长消息拆分结果变化。</p>`}<div class="stx-memory-actions">${setupAction}</div></section><section class="stx-memory-panel stx-memory-activity-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">最近活动</span><h3>初始化记录</h3></div><span>${initialization?.attempts.length ?? 0} / 5</span></div><div class="stx-memory-activity-list">${activities}</div></section></div></div>`;
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
    return `<section class="stx-memory-panel stx-memory-graph-status-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">图谱状态</span><h3>当前聊天</h3></div><div class="stx-memory-graph-status-actions">${renderStatusChip(phaseLabel, phaseTone)}<button class="stx-memory-graph-icon-button" ${uiControl('button', 'neutral')} type="button" data-action="rebuild-graph" aria-label="重建关系图谱" title="重建关系图谱" ${state.busyAction || status.phase === 'rebuilding' ? 'disabled' : ''}><ss-helper-icon name="arrows-rotate" decorative></ss-helper-icon></button></div></div><p class="stx-memory-muted">仅以当前聊天中已验证事实为准；视觉聚类只用于浏览，不会写入记忆。</p><dl class="stx-memory-graph-metric-grid"><div><dt>节点</dt><dd>${formatNumber(graph.nodes.length)}</dd></div><div><dt>已载入关系</dt><dd>${formatNumber(graph.edges.length)} / ${formatNumber(status.edgeCount)}</dd></div><div><dt>最后协调</dt><dd>${escapeHtml(status.lastRebuiltAt ? formatTime(status.lastRebuiltAt) : '尚未完成')}</dd></div></dl>${status.lastError ? '<p class="stx-memory-inline-alert" role="alert">图谱暂时降级，普通整理和召回不受影响。</p>' : ''}<div class="stx-memory-graph-filter-row"><label>类型<select ${uiControl('select')} data-graph-filter="kind"><option value="">全部</option>${kinds.map((kind) => `<option value="${escapeHtml(kind)}" ${state.graphKind === kind ? 'selected' : ''}>${escapeHtml(translateFactKind(kind))}</option>`).join('')}</select></label><label>状态<select ${uiControl('select')} data-graph-filter="status"><option value="">全部</option>${statuses.map((value) => `<option value="${escapeHtml(value)}" ${state.graphStatusFilter === value ? 'selected' : ''}>${escapeHtml(translateFactStatus(value))}</option>`).join('')}</select></label></div></section><section class="stx-memory-panel stx-memory-graph-relations-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">已验证关系</span><h3 data-graph-list-heading>${listLabel}</h3></div><span data-graph-list-count>${formatNumber(listCount)} 条</span></div><div class="stx-memory-graph-list-switch" role="tablist" aria-label="已验证关系显示模式"><button ${uiControl('button', 'neutral')} type="button" role="tab" data-action="set-graph-list-mode" data-graph-list-mode="edges" aria-selected="${state.graphListMode === 'edges'}"><ss-helper-icon name="link" decorative></ss-helper-icon>边列表</button><button ${uiControl('button', 'neutral')} type="button" role="tab" data-action="set-graph-list-mode" data-graph-list-mode="events" aria-selected="${state.graphListMode === 'events'}"><ss-helper-icon name="bolt" decorative></ss-helper-icon>事件列表</button></div><div class="stx-memory-graph-list-stack"><div class="stx-memory-graph-edge-list" data-graph-edge-list data-graph-list-mode="edges" data-graph-list-count="${view.edges.length}" ${state.graphListMode === 'edges' ? '' : 'hidden'}>${relationRows}</div><div class="stx-memory-graph-edge-list" data-graph-edge-list data-graph-list-mode="events" data-graph-list-count="${eventEdges.length}" ${state.graphListMode === 'events' ? '' : 'hidden'}>${eventRows}</div></div></section><section class="stx-memory-panel stx-memory-graph-detail-panel" data-graph-inspector-detail>${detail}</section>`;
  };
  const renderGraph = (): string => {
    const graph = state.graph ? localizeLegacyGraphPreview(state.graph) : undefined;
    const status = state.graphStatus;
    if (!graph || !status) return renderEmpty('正在读取关系图谱', '图谱只会展示当前聊天中由已验证事实派生的关系。');
    if (!status.enabled) return `<section class="stx-memory-panel">${renderEmpty('关系图谱已关闭', '可在“高级 → 关系图谱”中开启；关闭时不会影响普通整理或召回。')}</section>`;
    const focusNodeId = state.selectedGraphNodeId || state.selectedGraphEdgeId || state.selectedGraphEventId;
    return `<div class="stx-memory-graph-shell"><section class="stx-memory-graph-stage-panel" aria-label="关系图谱画布"><div class="stx-memory-graph-toolbar"><label class="stx-memory-graph-search"><ss-helper-icon name="magnifying-glass" decorative></ss-helper-icon><span class="stx-memory-sr-only">搜索节点或关系</span><input id="stx-memory-graph-query" ${uiControl('input')} data-filter="graph-query" value="${escapeHtml(state.graphQuery)}" placeholder="搜索节点或关系"></label><div class="stx-memory-graph-command-group" aria-label="图谱视图控制"><button ${uiControl('button', 'neutral')} type="button" data-action="graph-command" data-graph-command="zoom-out" aria-label="缩小图谱" title="缩小图谱"><ss-helper-icon name="minus" decorative></ss-helper-icon></button><button ${uiControl('button', 'neutral')} type="button" data-action="graph-command" data-graph-command="zoom-in" aria-label="放大图谱" title="放大图谱"><ss-helper-icon name="plus" decorative></ss-helper-icon></button><button ${uiControl('button', 'neutral')} type="button" data-action="graph-command" data-graph-command="fit" aria-label="适配视图" title="适配视图"><ss-helper-icon name="expand" decorative></ss-helper-icon></button><button ${uiControl('button', 'neutral')} type="button" data-action="graph-command" data-graph-command="reset-layout" aria-label="重新布局" title="重新布局"><ss-helper-icon name="shuffle" decorative></ss-helper-icon></button></div><button class="stx-memory-graph-focus-button stx-memory-graph-icon-button" ${uiControl('button', 'neutral')} type="button" data-action="toggle-graph-neighbor-focus" aria-pressed="${state.graphNeighborFocus}" aria-label="${state.graphNeighborFocus ? '显示全部关系' : '只看选中邻接'}" title="${state.graphNeighborFocus ? '显示全部关系' : '只看选中邻接'}" ${focusNodeId ? '' : 'disabled'}><ss-helper-icon name="${state.graphNeighborFocus ? 'eye' : 'eye-slash'}" decorative></ss-helper-icon></button><button class="stx-memory-graph-orbit-button stx-memory-graph-icon-button" ${uiControl('button', 'neutral')} type="button" data-action="graph-command" data-graph-command="toggle-orbit" aria-label="切换自动旋转" title="切换自动旋转"><ss-helper-icon name="rotate" decorative></ss-helper-icon></button></div><div class="stx-memory-relationship-graph-stage"><div class="stx-memory-relationship-graph-three-host" data-relationship-graph-three-host></div><div class="stx-memory-graph-overlay"><span><ss-helper-icon name="arrows-to-circle" decorative></ss-helper-icon> 拖动旋转 · 右键平移 · 滚轮缩放</span></div></div></section><aside class="stx-memory-graph-inspector" data-relationship-graph-inspector>${renderGraphInspector()}</aside></div>`;
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
      return `<article class="stx-memory-audit-item"><div class="stx-memory-audit-heading"><div><span class="stx-memory-kicker">${kicker}</span><h3>${escapeHtml(heading)}</h3></div>${renderStatusChip(`${formatNumber(acceptedCount)} 条事实`, 'neutral')}</div><dl class="stx-memory-audit-metrics">${metrics.map(([label, value]) => `<div title="${escapeHtml(value)}"><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl><details class="stx-memory-audit-details"><summary>查看技术明细</summary><pre class="stx-memory-code">${escapeHtml(formatJson(record))}</pre></details>${rollback ? `<div class="stx-memory-audit-actions">${rollback}</div>` : ''}</article>`;
    }).join('') : renderEmpty('暂无捕获审计', '新 Capture 完成后会在这里出现。');
    return `<div class="stx-memory-page-actions"><p class="stx-memory-muted">审计记录只读展示已提交的整理结果。</p><button ${uiControl('button', 'neutral')} type="button" data-action="refresh-audit" ${state.busyAction ? 'disabled' : ''}><ss-helper-icon name="rotate" decorative></ss-helper-icon>刷新审计</button></div><div class="stx-memory-audit-list">${records}</div><details class="stx-memory-panel stx-memory-usage"><summary>主聊天 Token / usage（${state.usages.length} 条）</summary><pre class="stx-memory-code">${escapeHtml(formatJson(state.usages))}</pre></details>`;
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
    root.innerHTML = `<div class="stx-memory-statusbar"><div class="stx-memory-chat-identity"><span class="stx-memory-kicker">当前聊天</span><strong>${escapeHtml(chatIdentity.label)}</strong></div><div><span class="stx-memory-kicker">运行状态</span>${renderStatusChip(overview ? translateOverviewStatus(overview.status) : '读取中', statusTone)}</div><div><span class="stx-memory-kicker">记忆数量</span><strong>${overview ? formatNumber(overview.factCount) : '—'}</strong></div><div class="stx-memory-status-storage"><span class="stx-memory-kicker">本聊天记忆占用</span><strong>${escapeHtml(chatStorageLabel)}</strong><small>占角色记忆 ${escapeHtml(chatStorageRatio)}</small></div><div><span class="stx-memory-kicker">大语言模型</span>${renderStatusChip(overview ? (overview.llmAvailable ? '可用' : '不可用') : '读取中', overview?.llmAvailable ? 'success' : overview ? 'warning' : 'neutral')}</div>${renderOverviewRouteStatus('向量模型', overview?.embedding)}${renderOverviewRouteStatus('重排序模型', overview?.rerank)}${alertMarkup}</div><div class="stx-memory-workspace-layout"><nav class="stx-memory-nav" aria-label="记忆工作台页面"><span class="stx-memory-nav-label">工作区</span>${PAGES.map((page) => `<button class="stx-memory-nav-item" type="button" data-action="navigate" data-page="${page.id}" aria-current="${page.id === state.page ? 'page' : 'false'}"><ss-helper-icon name="${page.icon}" decorative></ss-helper-icon><span><strong>${page.label}</strong><small>${page.description}</small></span></button>`).join('')}<div class="stx-memory-nav-meta">${overview?.lastOrganizedAt ? `最近整理<br>${escapeHtml(formatTime(overview.lastOrganizedAt))}` : '仅展示当前已实现能力'}</div></nav><main class="stx-memory-main"><header class="stx-memory-page-heading"><div><h2>${currentPage.label}</h2><p>${currentPage.description}</p></div><span class="stx-memory-page-counter">${currentPageIndex >= 0 ? `${currentPageIndex + 1} / ${PAGES.length}` : '诊断内页'}</span></header><section class="stx-memory-page-content" tabindex="-1">${renderPage()}</section><div class="stx-memory-internal-routes" hidden aria-hidden="true">${INTERNAL_PAGES.map((page) => `<button type="button" data-action="navigate-internal" data-page="${page.id}" aria-current="${page.id === state.page ? 'page' : 'false'}">${page.label}</button>`).join('')}</div></main></div>`;
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
  };

  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const actionNode = target.closest<HTMLElement>('[data-action]');
    const clickedFilter = target.closest<HTMLElement>('[data-multi-filter]');
    const closeOpenFilter = Boolean(state.openFilter && !clickedFilter);
    if (closeOpenFilter) state.openFilter = '';
    if (!actionNode || disposed) { if (closeOpenFilter) rerender(); return; }
    const action = actionNode.dataset.action;
    if (action === 'toggle-filter-menu') { const filter = actionNode.dataset.filterMenu as 'kind' | 'status'; state.openFilter = state.openFilter === filter ? '' : filter; rerender(`#stx-memory-${filter}-filter-trigger`); return; }
    if (action === 'navigate') { const page = actionNode.dataset.page as MemoryWorkbenchPage; if (PAGES.some((item) => item.id === page)) void loadPage(page); return; }
    if (action === 'navigate-internal') { const page = actionNode.dataset.page as MemoryWorkbenchPage; if (INTERNAL_PAGES.some((item) => item.id === page)) void loadPage(page); return; }
    if (action === 'dream-dry-run') {
      const jobId = actionNode.dataset.jobId;
      if (!jobId || !controller.runActorDream) return;
      void runAction('dream-dry-run', () => controller.runActorDream!(jobId, { dryRun: true }).then(() => undefined), 'Dream 预览完成', '本次 dry-run 未写入巩固结果。', 'MEMORY_DREAM_DRY_RUN_COMPLETED', () => loadPage('dreams'));
      return;
    }
    if (action === 'confirm-actor') {
      const candidateId = actionNode.dataset.candidateId;
      if (!candidateId || !controller.confirmActorCandidate) return;
      void runAction('confirm-actor', () => controller.confirmActorCandidate!(candidateId), '人物归属已确认', '已写入人物注册表和审计记录。', 'MEMORY_ACTOR_CONFIRMED', () => loadPage('actors'));
      return;
    }
    if (action === 'undo-actor-correction') {
      const auditId = actionNode.dataset.auditId;
      if (!auditId || !controller.resolveActorCorrection) return;
      void runAction('undo-actor-correction', () => controller.resolveActorCorrection!(auditId, 'undo'), '人物纠正已撤销', '主体、别名和审计状态已恢复。', 'MEMORY_ACTOR_CORRECTION_UNDONE', () => loadPage('actors'));
      return;
    }
    if (action === 'refresh') { void refreshAll(); return; }
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
    if (action === 'select-fact') { state.selectedFactId = actionNode.dataset.factId ?? ''; state.editingFactId = ''; state.confirmFactId = ''; rerender(); return; }
    if (action === 'edit-fact') { state.editingFactId = actionNode.dataset.factId ?? ''; rerender('#stx-memory-edit-content'); return; }
    if (action === 'cancel-edit') { state.editingFactId = ''; rerender(); return; }
    if (action === 'save-fact') { const id = actionNode.dataset.factId ?? ''; const textarea = root.querySelector<HTMLTextAreaElement>('[data-edit-content]'); const content = textarea?.value.trim() ?? ''; if (!id || !content) return; void runAction('save-fact', () => controller.updateFact(id, content), '记忆已保存', '事实内容已更新。', 'MEMORY_FACT_UPDATED', async () => { state.editingFactId = ''; await refreshFacts(); }); return; }
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
    if (input.dataset.filter === 'query') {
      state.query = input.value;
      if (searchTimer) window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => { void refreshFacts().then(() => rerender('', true)).catch((error) => toast('error', '搜索失败', '无法读取筛选结果，请稍后重试。', safeErrorCode(error, 'MEMORY_SEARCH_FAILED'))); }, 220);
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
    if (input.dataset.filterAll) {
      const checkbox = input as HTMLInputElement;
      const filter = input.dataset.filterAll;
      const values = Object.keys(filter === 'kind' ? FACT_KIND_LABELS : FACT_STATUS_LABELS);
      if (filter === 'kind') state.selectedKinds = checkbox.checked ? values : [];
      else state.selectedStatuses = checkbox.checked ? values : [];
      rerender(); return;
    }
    if (input.dataset.filterOption) {
      const checkbox = input as HTMLInputElement;
      const filter = input.dataset.filterOption;
      const current = filter === 'kind' ? state.selectedKinds : state.selectedStatuses;
      const next = checkbox.checked ? [...new Set([...current, checkbox.value])] : current.filter((value) => value !== checkbox.value);
      if (filter === 'kind') state.selectedKinds = next;
      else state.selectedStatuses = next;
      rerender(); return;
    }
    if (input.dataset.filter === 'sort') { state.sort = input.value as FactViewOptions['sort']; rerender(); return; }
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
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
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

  removeOverviewChanged = controller.onOverviewChanged?.(() => { void refreshOverviewSnapshot(); });
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
    disposed = true; pageRequestId += 1; progressRequestId += 1; abortController.abort();
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
    root.replaceChildren();
  };
}
