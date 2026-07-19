import './memory.css';
import {
  UI_CONTROL_ATTRIBUTE,
  UI_CONTROL_TONE_ATTRIBUTE,
  type PopupUiContext,
  type ToastNotification,
  type UiControlKind,
  type UiControlTone,
} from '@ss-helper/sdk';
import type { SummaryInitializationEstimate } from '../application/ingest/summary-strategy';
import { describeMemoryError, type MemoryErrorDiagnostic } from '../diagnostics/memory-error';

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
export const EXPECTED_SQLITE_SCHEMA_VERSION = 4;

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
  auditBatches?: Array<{ jobId: string; batchIndex: number; status: string }>;
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
  errorCode?: string;
  error?: string;
  errorDiagnostic?: MemoryErrorDiagnostic;
}

export interface MemoryInitializationSourceOption { kind: string; label: string; count: number; selected: boolean }
export interface MemoryCaptureProgress {
  status: 'idle' | 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  jobId?: string;
  batchIndex: number;
  totalBatches: number;
  processedCount: number;
  elapsedMs: number;
  error?: string;
  phase?: 'extract' | 'reduce' | 'resolve' | 'apply';
  stagedBatchCount?: number;
  conflictBucketCount?: number;
  pendingReviewCount?: number;
  qualityStatus?: 'ready' | 'needs_review';
}

export interface MemoryInitializationAttempt {
  jobId: string;
  status: MemoryCaptureProgress['status'];
  updatedAt: number;
  totalBatches: number;
  selectedSourceKinds: string[];
  error?: string;
}

export interface MemoryInitializationState {
  initialized: boolean;
  lastCompletedAt: number | null;
  selectedSourceKinds: string[];
  attempts: MemoryInitializationAttempt[];
  qualityStatus?: 'ready' | 'needs_review';
  pendingReviewCount?: number;
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
  usage?: unknown;
  createdAt?: number;
  [key: string]: unknown;
}

export interface MemoryUiController {
  getSettings(): MemoryUiSettings;
  saveSettings(settings: MemoryUiSettings): Promise<void>;
  getOverview(): Promise<MemoryUiOverview>;
  getInitializationEstimate(selectedKinds?: string[]): Promise<MemoryInitializationEstimate>;
  getInitializationSources(): Promise<MemoryInitializationSourceOption[]>;
  getInitializationState(): Promise<MemoryInitializationState>;
  initialize(selectedKinds?: string[]): Promise<void>;
  reinitialize(selectedKinds?: string[]): Promise<void>;
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
  rollbackBatch(jobId: string, batchIndex: number): Promise<void>;
  getSqliteStatus(): Promise<MemorySqliteStatus>;
  exportSqliteBackup(): Promise<Blob>;
  importSqliteBackup(file: File): Promise<void>;
  checkSqliteIntegrity(): Promise<MemorySqliteIntegrityResult>;
  clearCurrentChatData(): Promise<void>;
  clearAllMemoryData(): Promise<void>;
}

export const MEMORY_CAPABILITY_BOUNDARIES = Object.freeze([
  { name: '证据优先整理', status: '可用', detail: '只保存能够追溯到当前聊天来源的事实，避免把缺少来源的推测写成记忆。' },
  { name: '向量召回', status: '可用', detail: '使用 LLM 的向量模型建立可再生成索引，并保留实体、证据、状态和时间硬过滤。' },
  { name: '混合召回与重排序', status: '可用', detail: '关键词与向量结果融合；自适应策略仅在排序有歧义时调用 LLM 重排序模型，失败会自动降级。' },
  { name: '关系图谱', status: '未实现', detail: '当前版本不建立关系图谱，也不会把语义相似度当作实体关系；后续实现前保持明确边界。' },
  { name: '类型工坊', status: '替代', detail: '由固定中文事实类型、搜索筛选和手工编辑替代；未知扩展类型仍可原样展示。' },
  { name: '遗忘与失真', status: '停止', detail: '不会静默删减或改写用户事实，删除必须由用户明确操作。' },
  { name: '世界风格', status: '保留来源', detail: '不再复制为独立配置；角色卡和已启用世界书会作为可选择、可追溯的初始化来源。' },
] as const);

export interface FactViewOptions { kind: string | readonly string[]; status: string | readonly string[]; sort: 'updated_desc' | 'confidence_desc' | 'kind_asc' }
export type MemoryInitializationEstimate = SummaryInitializationEstimate;

const FACT_KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  identity: '身份', relationship: '关系', location: '地点', world_rule: '世界规则', state: '状态',
  goal: '目标', commitment: '承诺', event: '事件', preference: '偏好', other: '其他',
});
const FACT_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({ active: '有效', pending: '待确认', superseded: '已替代', invalid: '无效' });
const RECORD_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  idle: '空闲', queued: '已排队', running: '进行中', paused: '已暂停', completed: '已完成', failed: '失败', cancelled: '已取消',
});
const OVERVIEW_STATUS_LABELS: Readonly<Record<MemoryUiOverview['status'], string>> = Object.freeze({ ready: '就绪', working: '整理中', error: '异常', disabled: '已停用', unselected: '未选择' });
const RECALL_MODE_LABELS: Readonly<Record<MemoryRecallStatus['resolvedMode'], string>> = Object.freeze({ lexical: '关键词检索', vector: '向量检索', hybrid: '混合检索' });

export function translateFactKind(value: string): string { return FACT_KIND_LABELS[value] ?? value; }
export function translateFactStatus(value: string): string { return FACT_STATUS_LABELS[value] ?? value; }
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
  if (base.startsWith('character:')) return `角色卡${suffix}`;
  if (base.startsWith('persona:')) return `用户设定${suffix}`;
  const worldbook = base.match(/^worldbook:[^:]+:([^:]+)/u);
  if (worldbook) return `世界书条目 #${worldbook[1]}${suffix}`;
  if (base.startsWith('manual:')) return `手工记录${suffix}`;
  return `来源记录${suffix}`;
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

export type MemoryWorkbenchPage = 'library' | 'initialize' | 'recall' | 'audit' | 'data';
const PAGES: ReadonlyArray<{ id: MemoryWorkbenchPage; label: string; description: string; icon: string }> = [
  { id: 'library', label: '记忆库', description: '浏览与编辑事实', icon: 'fa-book-open' },
  { id: 'initialize', label: '初始化', description: '导入已有聊天来源', icon: 'fa-wand-magic-sparkles' },
  { id: 'recall', label: '召回与索引', description: '检查检索链路', icon: 'fa-magnifying-glass-chart' },
  { id: 'audit', label: '审计记录', description: '查看整理批次', icon: 'fa-list-check' },
  { id: 'data', label: '数据维护', description: '备份与健康检查', icon: 'fa-database' },
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
  estimate?: MemoryInitializationEstimate;
  initialization?: MemoryInitializationState;
  progress?: MemoryCaptureProgress;
  reinitializeOpen: boolean;
  recall?: MemoryRecallStatus;
  diagnostics?: unknown;
  audits: MemoryAuditRecord[];
  usages: unknown[];
  sqlite?: MemorySqliteStatus;
  integrityText: string;
  confirmBatchKey: string;
  dangerConfirm: '' | 'current' | 'all';
  pendingImport?: File;
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
  return `<div class="stx-memory-error-details" role="alert"><span class="stx-memory-error-icon" aria-hidden="true"><i class="fa-solid fa-triangle-exclamation"></i></span><div class="stx-memory-error-copy"><div class="stx-memory-error-title"><strong>${escapeHtml(diagnostic.title)}</strong>${renderStatusChip(diagnostic.code, 'error')}</div><div class="stx-memory-error-guidance"><p><b>原因：</b><span>${escapeHtml(diagnostic.reason)}</span></p><p><b>处理建议：</b><span>${escapeHtml(diagnostic.action)}</span></p></div></div><div class="stx-memory-error-actions"><button ${uiControl('button', diagnostic.retryable && action !== 'dismiss-error' ? 'danger' : 'neutral')} type="button" data-action="${action}">${actionLabel}</button></div></div>`;
}
function renderRoute(label: string, route: MemoryRecallRouteStatus): string {
  const tone = route.available ? 'success' : 'error';
  const detail = route.available ? route.resourceId ?? '已配置' : route.blockedReason ?? '尚未在 LLM 中配置';
  return `<div class="stx-memory-route"><div><strong>${escapeHtml(label)}</strong>${renderStatusChip(route.available ? '可用' : '不可用', tone)}</div><small>${escapeHtml(detail)}</small>${route.model ? `<small>模型：${escapeHtml(route.model)}</small>` : ''}</div>`;
}

export function renderMemoryWorkbench(container: HTMLElement, controller: MemoryUiController, notify: (notification: ToastNotification) => void = () => undefined, popupUi?: PopupUiContext): () => void {
  const root = document.createElement('div');
  root.className = 'stx-memory-workbench';
  root.setAttribute('aria-label', '记忆工作台内容');
  container.replaceChildren(root);
  const abortController = new AbortController();
  let disposed = false;
  let searchTimer: number | undefined;
  let progressTimer: number | undefined;
  let progressRequestId = 0;
  let pageRequestId = 0;
  const state: WorkbenchState = {
    page: 'library', loading: true, pageLoading: false, busyAction: '', errorCode: '', facts: [], query: '', selectedKinds: Object.keys(FACT_KIND_LABELS), selectedStatuses: Object.keys(FACT_STATUS_LABELS), openFilter: '', sort: 'updated_desc',
    selectedFactId: '', editingFactId: '', confirmFactId: '', sources: [], selectedSourceKinds: [], reinitializeOpen: false, audits: [], usages: [], integrityText: '尚未执行完整性检查。', confirmBatchKey: '', dangerConfirm: '',
  };

  const toast = (level: ToastNotification['level'], title: string, message: string, code: string): void => {
    notify({ level, title, message, code, durationMs: level === 'error' ? 0 : 3200 });
  };
  const rerender = (focusSelector = ''): void => {
    if (disposed) return;
    const factListScrollTop = root.querySelector<HTMLElement>('.stx-memory-fact-list')?.scrollTop;
    render();
    const restoreFactListScroll = (): void => {
      if (disposed || factListScrollTop === undefined) return;
      const factList = root.querySelector<HTMLElement>('.stx-memory-fact-list');
      if (factList) factList.scrollTop = factListScrollTop;
    };
    restoreFactListScroll();
    if (focusSelector) window.setTimeout(() => root.querySelector<HTMLElement>(focusSelector)?.focus(), 0);
    // Native button focus can scroll the list after the click handler completes.
    // Restore once more after that browser-default step so selection never jumps.
    window.setTimeout(restoreFactListScroll, 0);
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
    rerender();
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
  const loadPage = async (page: MemoryWorkbenchPage): Promise<void> => {
    if (disposed) return;
    const requestId = ++pageRequestId;
    state.page = page; state.pageLoading = true; state.pageError = undefined; rerender();
    const isCurrent = (): boolean => !disposed && requestId === pageRequestId;
    try {
      if (page === 'initialize') {
        const [sources, initialization] = await Promise.all([
          controller.getInitializationSources(),
          controller.getInitializationState(),
        ]);
        if (!isCurrent()) return;
        state.sources = sources;
        state.initialization = initialization;
        state.selectedSourceKinds = state.sources.filter((source) => source.selected).map((source) => source.kind);
        state.estimate = await controller.getInitializationEstimate(state.selectedSourceKinds);
        if (!isCurrent()) return;
        state.progress = await controller.getCaptureProgress();
        if (!isCurrent()) return;
        scheduleProgress();
      } else if (page === 'recall') {
        state.recall = await controller.getRecallStatus();
        if (!isCurrent()) return;
        state.diagnostics = state.overview?.bound === false ? null : await controller.getLastRecall();
      } else if (page === 'audit') {
        if (state.overview?.bound === false) {
          state.audits = [];
          state.usages = [];
        } else {
          state.audits = await controller.listAuditRecords();
          if (!isCurrent()) return;
          state.usages = await controller.getMainChatUsage();
        }
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
      controller.getInitializationSources(),
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
    state.estimate = await controller.getInitializationEstimate(state.selectedSourceKinds);
  };

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
        <section class="stx-memory-detail-section"><div class="stx-memory-section-heading"><div><h4>来源与证据</h4><p>核对记忆是否忠于聊天原文</p></div><span>${selected.evidence.length} 条</span></div><div class="stx-memory-evidence-list">${selected.evidence.length ? selected.evidence.map((item) => `<blockquote class="stx-memory-evidence"><p>${escapeHtml(item.excerpt)}</p><footer><i class="fa-solid fa-link" aria-hidden="true"></i>${escapeHtml(formatSourceReference(item.sourceRef))}</footer></blockquote>`).join('') : '<p class="stx-memory-muted">没有可展示的来源证据。</p>'}</div></section>
        <div class="stx-memory-detail-grid"><section><h4>来源引用</h4><div class="stx-memory-reference-list">${selected.sourceRefs.length ? selected.sourceRefs.map((item) => `<span>${escapeHtml(formatSourceReference(item))}</span>`).join('') : '<span>无</span>'}</div></section><section><h4>版本关系</h4><p>${escapeHtml(replacement)}</p></section></div>
        <section class="stx-memory-detail-section"><h4>整理记录</h4><div class="stx-memory-reference-list">${selected.auditBatches?.length ? selected.auditBatches.map((item) => `<span>第 ${item.batchIndex + 1} 批 · ${escapeHtml(translateRecordStatus(item.status))}</span>`).join('') : '<span>暂无匹配批次</span>'}</div></section>`;
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
      const allMark = allSelected ? '<i class="fa-solid fa-check"></i>' : partiallySelected ? '<i class="fa-solid fa-minus"></i>' : '';
      return `<div class="stx-memory-control-wrap stx-memory-multi-filter" data-multi-filter="${filter}"><button id="${triggerId}" class="stx-memory-multi-filter-trigger" ${uiControl('button', 'neutral')} type="button" data-action="toggle-filter-menu" data-filter-menu="${filter}" aria-haspopup="true" aria-expanded="${state.openFilter === filter}" aria-controls="${menuId}"><span>${escapeHtml(selectedLabel)}</span><i class="fa-solid fa-chevron-${state.openFilter === filter ? 'up' : 'down'}" aria-hidden="true"></i></button>${state.openFilter === filter ? `<div id="${menuId}" class="stx-memory-multi-filter-menu" role="group" aria-labelledby="${triggerId}"><label class="stx-memory-multi-filter-option stx-memory-multi-filter-all ${allSelected ? 'is-selected' : partiallySelected ? 'is-partial' : ''}"><span class="stx-memory-multi-filter-option-label"><strong>${allLabel}</strong><small>${allStateLabel}</small></span><span class="stx-memory-multi-filter-mark" aria-hidden="true">${allMark}</span><input class="stx-memory-multi-filter-native stx-memory-sr-only" ${uiControl('checkbox')} type="checkbox" data-filter-all="${filter}" data-selected-count="${selectedValues.length}" data-option-count="${entries.length}" aria-checked="${partiallySelected ? 'mixed' : allSelected}" ${allSelected ? 'checked' : ''}></label>${entries.map(([value, label]) => { const selected = selectedValues.includes(value); return `<label class="stx-memory-multi-filter-option ${selected ? 'is-selected' : ''}"><span class="stx-memory-multi-filter-option-label">${escapeHtml(label)}</span><span class="stx-memory-multi-filter-mark" aria-hidden="true">${selected ? '<i class="fa-solid fa-check"></i>' : ''}</span><input class="stx-memory-multi-filter-native stx-memory-sr-only" ${uiControl('checkbox')} type="checkbox" data-filter-option="${filter}" value="${escapeHtml(value)}" ${selected ? 'checked' : ''}></label>`; }).join('')}</div>` : ''}</div>`;
    };
    return `<div class="stx-memory-toolbar"><label class="stx-memory-search-wrap"><span class="stx-memory-sr-only">搜索记忆</span><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input ${uiControl('input')} data-filter="query" value="${escapeHtml(state.query)}" placeholder="搜索记忆内容、人物或地点" /></label>${renderMultiFilter('kind', '全部类型', state.selectedKinds, FACT_KIND_LABELS)}${renderMultiFilter('status', '全部状态', state.selectedStatuses, FACT_STATUS_LABELS)}<label class="stx-memory-control-wrap"><span class="stx-memory-sr-only">排序</span><select ${uiControl('select')} aria-label="排序" data-filter="sort"><option value="updated_desc" ${state.sort === 'updated_desc' ? 'selected' : ''}>最近更新</option><option value="confidence_desc" ${state.sort === 'confidence_desc' ? 'selected' : ''}>置信度</option><option value="kind_asc" ${state.sort === 'kind_asc' ? 'selected' : ''}>类型</option></select></label><button ${uiControl('button', 'neutral')} type="button" data-action="refresh" ${state.busyAction ? 'disabled' : ''}><i class="fa-solid fa-rotate" aria-hidden="true"></i>刷新</button></div><div class="stx-memory-result-line"><span aria-live="polite">共 ${visibleFacts.length} 条记忆</span><span>当前聊天：${escapeHtml(chatIdentity.label)}</span></div><div class="stx-memory-library-grid"><section class="stx-memory-fact-list" aria-label="记忆列表">${list}</section><section class="stx-memory-inspector" aria-label="记忆详情">${detail}</section></div>`;
  };
  const renderInitialize = (): string => {
    const progress = state.progress;
    const initialization = state.initialization;
    const summarySettings = controller.getSettings();
    const { summaryBatchMode, summaryBatchFloors, summaryBatchChars, summaryIntervalFloors, summaryOverlapFloors } = summarySettings;
    const summaryNote = (summaryBatchMode === 'chars'
      ? `按每批最多 ${formatNumber(summaryBatchChars)} 字符拆分，批次间保留 ${formatNumber(summaryOverlapFloors)} 层前置上下文；自动触发仍按 ${formatNumber(summaryIntervalFloors)} 层间隔判断。`
      : `按每批 ${formatNumber(summaryBatchFloors)} 层可见用户/助手消息拆分，批次间保留 ${formatNumber(summaryOverlapFloors)} 层前置上下文；自动触发间隔为 ${formatNumber(summaryIntervalFloors)} 层。`)
      + ' 冲突整理仅在出现无法由规则确定的分歧时追加调用。';
    const running = Boolean(progress && ['queued', 'running'].includes(progress.status));
    const submitting = ['initialize', 'reinitialize'].includes(state.busyAction);
    const phaseLabel = progress?.phase === 'reduce' ? '整理归并'
      : progress?.phase === 'resolve' ? '解决冲突'
        : progress?.phase === 'apply' ? '写入记忆'
          : '提取记忆';
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
        ? !progress.phase || progress.phase === 'extract' ? 'LLM 正在提取结构化记忆，结果会先暂存，全部批次完成后统一整理。'
          : progress.phase === 'reduce' ? '正在跨批次合并重复记忆并检查时间顺序。'
            : progress.phase === 'resolve' ? '正在用规则优先处理冲突，仅疑难项才会请求 LLM 裁决。'
              : '正在一次性写入已整理的事实与证据。'
        : progress?.status === 'queued' ? '请求已进入 LLM 队列，等待模型反馈。'
          : '正在读取当前聊天来源并提交 LLM 请求…'
      : progress?.status === 'completed' ? '初始化流程已完成，整理结果已统一写入数据库。'
        : progress?.status === 'paused' ? '可重试错误已暂停当前阶段，已保留暂存结果，可直接继续。' : '';
    const sourceLabel = (kind: string): string => state.sources.find((source) => source.kind === kind)?.label ?? kind;
    const selectedCount = state.selectedSourceKinds.length;
    const latestAttempt = initialization?.attempts[0];
    const sourceCoverage = initialization?.selectedSourceKinds.length || selectedCount;
    const sourceTotal = state.sources.length;
    const renderSourceChoices = (locked: boolean): string => `<div class="stx-memory-source-list">${state.sources.length ? state.sources.map((source) => `<label class="stx-memory-source-option ${state.selectedSourceKinds.includes(source.kind) ? 'is-selected' : ''}"><input ${uiControl('checkbox')} type="checkbox" data-source-kind="${escapeHtml(source.kind)}" ${state.selectedSourceKinds.includes(source.kind) ? 'checked' : ''} ${locked ? 'disabled' : ''}><span><strong>${escapeHtml(source.label)}</strong><small>${formatNumber(source.count)} 项</small></span></label>`).join('') : renderEmpty('当前没有可初始化来源', '请先选择角色或打开聊天。')}</div>`;
    const estimateMarkup = state.estimate ? `<dl class="stx-memory-estimate-grid"><div><dt>预计批次</dt><dd>${formatNumber(state.estimate.batchCount)}</dd></div><div><dt>Token 下限</dt><dd>${formatNumber(state.estimate.tokenLow)}</dd></div><div><dt>Token 上限</dt><dd>${formatNumber(state.estimate.tokenHigh)}</dd></div></dl>` : '';
    const progressMarkup = `<section class="stx-memory-panel stx-memory-initialize-progress"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">正在初始化 · ${escapeHtml(phaseLabel)}</span><h3>${escapeHtml(statusLabel)}</h3></div>${progress?.jobId ? renderStatusChip('任务进行中', 'warning') : ''}</div>${feedback ? `<p class="stx-memory-capture-feedback" role="status" aria-live="polite"><i class="fa-solid fa-sparkles" aria-hidden="true"></i>${escapeHtml(feedback)}</p>` : ''}<div class="stx-memory-locked-sources"><span>已锁定来源</span><strong>${escapeHtml(state.selectedSourceKinds.map(sourceLabel).join('、') || '无')}</strong></div>${progress ? `<div class="stx-memory-progress-copy"><span>${progress.phase === 'extract' ? `当前批次 ${progress.batchIndex} / ${progress.totalBatches || 0}` : `${phaseLabel}阶段`}</span><span>${formatNumber(progress.processedCount)} 项 · ${Math.round(progress.elapsedMs / 1000)} 秒</span></div><progress ${uiControl('progress')} max="${Math.max(progress.totalBatches, 1)}" value="${progress.phase === 'extract' ? Math.min(progress.batchIndex, Math.max(progress.totalBatches, 1)) : Math.max(progress.totalBatches, 1)}">${progress.batchIndex}</progress>${progress.stagedBatchCount === undefined ? '' : `<p class="stx-memory-muted">已暂存 ${formatNumber(progress.stagedBatchCount)} 批${progress.conflictBucketCount === undefined ? '' : ` · 发现 ${formatNumber(progress.conflictBucketCount)} 组冲突`}${progress.pendingReviewCount === undefined ? '' : ` · ${formatNumber(progress.pendingReviewCount)} 项待审阅`}</p>`}${progress.error ? `<p class="stx-memory-inline-alert" role="alert">错误码：${escapeHtml(safeInlineError(progress.error, 'MEMORY_CAPTURE_FAILED'))}</p>` : ''}` : ''}<div class="stx-memory-actions"><button ${uiControl('button', 'danger')} type="button" data-action="initialize-cancel" ${state.busyAction ? 'disabled' : ''}><i class="fa-solid fa-stop" aria-hidden="true"></i>取消任务</button></div></section>`;
    const activities = initialization?.attempts.length ? initialization.attempts.map((attempt) => {
      const tone = attempt.status === 'completed' ? 'success' : attempt.status === 'failed' ? 'error' : attempt.status === 'running' || attempt.status === 'queued' ? 'warning' : 'neutral';
      const icon = attempt.status === 'completed' ? 'fa-circle-check' : attempt.status === 'failed' ? 'fa-circle-xmark' : 'fa-clock';
      const sourceNames = attempt.selectedSourceKinds.map(sourceLabel).join('、') || '全部可用来源';
      return `<article class="stx-memory-activity-item is-${escapeHtml(attempt.status)}"><i class="fa-solid ${icon}" aria-hidden="true"></i><div><div><strong>${escapeHtml(translateRecordStatus(attempt.status))}</strong>${renderStatusChip(`${formatNumber(attempt.totalBatches)} 批`, tone)}</div><time datetime="${new Date(attempt.updatedAt).toISOString()}">${escapeHtml(formatTime(attempt.updatedAt))}</time><p>${escapeHtml(sourceNames)}</p>${attempt.error ? `<small title="${escapeHtml(attempt.error)}">${escapeHtml(safeInlineError(attempt.error, 'MEMORY_CAPTURE_FAILED'))}</small>` : ''}</div></article>`;
    }).join('') : renderEmpty('暂无初始化记录', '完成初始化后会在这里保留最近 5 次活动。');
    const drawerDisabled = !selectedCount || !state.overview?.llmAvailable || running || Boolean(state.busyAction);
    const drawer = !state.reinitializeOpen ? '' : `<div class="stx-memory-reinitialize-layer"><button class="stx-memory-drawer-backdrop" type="button" data-action="cancel-reinitialize" aria-label="关闭重新初始化确认"></button><aside class="stx-memory-reinitialize-drawer" role="alertdialog" aria-modal="true" aria-labelledby="stx-memory-reinitialize-title" aria-describedby="stx-memory-reinitialize-description"><header><div><span class="stx-memory-kicker">危险操作确认</span><h3 id="stx-memory-reinitialize-title">重新初始化当前聊天</h3></div><button ${uiControl('button', 'neutral')} type="button" data-action="cancel-reinitialize" aria-label="关闭"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></header><div class="stx-memory-drawer-body"><p id="stx-memory-reinitialize-description" class="stx-memory-drawer-warning"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span><strong>这会清空当前聊天的全部 Memory 派生数据</strong><small>清空后立即按下方来源重新开始初始化；如果新任务失败，旧数据无法恢复。</small></span></p><section><div class="stx-memory-section-heading"><div><h4>选择重新整理的来源</h4><p>估算会随勾选结果实时更新</p></div><span>${selectedCount} / ${sourceTotal}</span></div>${renderSourceChoices(false)}</section>${estimateMarkup}<section class="stx-memory-clear-scope"><h4>将清理</h4><ul><li>事实、证据与事实槽位</li><li>任务、批次审计与 Usage</li><li>召回日志、向量索引与总结进度</li></ul></section><section class="stx-memory-safe-scope"><h4>不会影响</h4><ul><li>聊天原文与消息</li><li>角色卡、世界书和其他聊天</li></ul></section>${!state.overview?.llmAvailable ? '<p class="stx-memory-inline-alert" role="alert">大语言模型不可用，暂时不能重新初始化。</p>' : !selectedCount ? '<p class="stx-memory-inline-alert" role="alert">请至少选择一个来源。</p>' : ''}</div><footer><button id="stx-memory-reinitialize-cancel" ${uiControl('button', 'neutral')} type="button" data-action="cancel-reinitialize">取消</button><button ${uiControl('button', 'danger')} type="button" data-action="confirm-reinitialize" ${drawerDisabled ? 'disabled' : ''}><i class="fa-solid fa-trash-can-arrow-up" aria-hidden="true"></i>清空并重新初始化</button></footer></aside></div>`;
    if (running || submitting) return `<div class="stx-memory-initialize-shell"><div class="stx-memory-initialize-layout is-running">${progressMarkup}<section class="stx-memory-panel stx-memory-activity-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">最近活动</span><h3>初始化记录</h3></div><span>${initialization?.attempts.length ?? 0} / 5</span></div><div class="stx-memory-activity-list">${activities}</div></section></div></div>`;
    if (initialization?.initialized) {
      const reviewRequired = initialization.qualityStatus === 'needs_review' && (initialization.pendingReviewCount ?? 0) > 0;
      return `<div class="stx-memory-initialize-shell"><div class="stx-memory-initialize-layout"><section class="stx-memory-panel stx-memory-initialize-summary"><div class="stx-memory-initialize-success"><span><i class="fa-solid fa-circle-check" aria-hidden="true"></i></span><div><span class="stx-memory-kicker">初始化状态</span><h3>已初始化</h3><p>完成于 ${escapeHtml(formatTime(initialization.lastCompletedAt))}</p></div>${renderStatusChip(reviewRequired ? `有 ${formatNumber(initialization.pendingReviewCount ?? 0)} 项待审阅` : '召回可用', reviewRequired ? 'warning' : 'success')}</div><dl class="stx-memory-initialize-metrics"><div><dt>来源覆盖</dt><dd>${formatNumber(sourceCoverage)} / ${formatNumber(sourceTotal)}</dd></div><div><dt>记忆事实</dt><dd>${formatNumber(state.overview?.factCount ?? 0)}</dd></div><div><dt>占用空间</dt><dd>${escapeHtml(formatBytes(state.overview?.currentChatSizeBytes ?? 0))}</dd></div><div><dt>预计批次</dt><dd>${formatNumber(state.estimate?.batchCount ?? 0)}</dd></div></dl><p class="stx-memory-initialize-note"><i class="fa-solid fa-circle-info" aria-hidden="true"></i><span>${reviewRequired ? '可靠记忆已可用于召回；存在无法自动裁决的冲突，已保留为待审阅状态。' : '当前聊天已经可以使用记忆召回。最近的失败任务只会记录在右侧，不会覆盖这次有效初始化。'}</span></p><div class="stx-memory-actions"><button ${uiControl('button', 'primary')} type="button" data-action="view-library"><i class="fa-solid fa-book-open" aria-hidden="true"></i>查看记忆库</button><button id="stx-memory-reinitialize-trigger" ${uiControl('button', 'neutral')} type="button" data-action="open-reinitialize" ${state.busyAction || !state.overview?.llmAvailable ? 'disabled' : ''}><i class="fa-solid fa-rotate" aria-hidden="true"></i>重新初始化</button></div></section><section class="stx-memory-panel stx-memory-activity-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">最近活动</span><h3>初始化记录</h3></div><span>${initialization.attempts.length} / 5</span></div><div class="stx-memory-activity-list">${activities}</div></section></div>${drawer}</div>`;
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
      ? `<button ${uiControl('button', 'primary')} type="button" data-action="initialize-resume" ${state.busyAction || !state.overview?.llmAvailable ? 'disabled' : ''}><i class="fa-solid fa-play" aria-hidden="true"></i>继续初始化</button>`
      : `<button ${uiControl('button', 'primary')} type="button" data-action="initialize-start" ${!selectedCount || !state.sources.length || state.busyAction || !state.overview?.llmAvailable ? 'disabled' : ''}><i class="fa-solid fa-play" aria-hidden="true"></i>${clearedAfterFailure ? '重新尝试初始化' : '开始初始化'}</button>`;
    return `<div class="stx-memory-initialize-shell"><div class="stx-memory-initialize-layout"><section class="stx-memory-panel stx-memory-initialize-setup"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">${setupKicker}</span><h3>${setupHeading}</h3></div>${state.estimate ? renderStatusChip(`${formatNumber(state.estimate.messageCount)} 条消息`, 'neutral') : ''}</div>${setupNotice}${resumable ? '' : `${renderSourceChoices(false)}${estimateMarkup}<p class="stx-memory-estimate-note">${escapeHtml(summaryNote)} 实际批次会随清洗和长消息拆分结果变化。</p>`}<div class="stx-memory-actions">${setupAction}</div></section><section class="stx-memory-panel stx-memory-activity-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">最近活动</span><h3>初始化记录</h3></div><span>${initialization?.attempts.length ?? 0} / 5</span></div><div class="stx-memory-activity-list">${activities}</div></section></div></div>`;
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
    return `<div class="stx-memory-card-grid"><section class="stx-memory-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">当前策略</span><h3>${escapeHtml(translateRecallMode(recall.resolvedMode))}</h3></div>${renderStatusChip(recall.rebuilding ? '重建中' : '运行正常', recall.rebuilding ? 'warning' : 'success')}</div><div class="stx-memory-route-grid">${renderRoute('向量模型', recall.embedding)}${renderRoute('重排序模型', recall.rerank)}</div><div class="stx-memory-metric-grid"><div><span>已建立索引</span><strong>${formatNumber(recall.indexedFacts)}</strong></div><div><span>可索引事实</span><strong>${formatNumber(recall.eligibleFacts)}</strong></div><div><span>待处理</span><strong>${formatNumber(recall.pendingFacts)}</strong></div></div><div class="stx-memory-progress-copy"><span>向量覆盖率</span><strong>${coverage}%</strong></div><progress ${uiControl('progress')} max="100" value="${coverage}">${coverage}%</progress>${recallError ? `<p class="stx-memory-inline-alert" role="alert">错误码：${escapeHtml(safeInlineError(recallError, 'MEMORY_RECALL_DEGRADED'))}</p>` : ''}<div class="stx-memory-actions"><button ${uiControl('button', 'primary')} type="button" data-action="rebuild-index" ${rebuildDisabled ? 'disabled' : ''}><i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i>重建向量索引</button></div>${recall.embedding.available ? '' : '<p class="stx-memory-muted">请先在 LLM 中配置可用的向量模型，再重建索引。</p>'}</section><section class="stx-memory-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">最近召回</span><h3>诊断摘要</h3></div></div>${diagnostic}${recall.batches.length ? `<div class="stx-memory-batch-table"><div class="stx-memory-table-row stx-memory-table-head"><span>批次</span><span>输入</span><span>延迟</span><span>接受</span></div>${recall.batches.map((batch) => `<div class="stx-memory-table-row"><span>#${batch.batchIndex + 1}</span><span>${formatNumber(batch.inputCount)}</span><span>${formatNumber(batch.latencyMs)} 毫秒</span><span>${formatNumber(batch.accepted)} / ${formatNumber(batch.rejected)}</span></div>`).join('')}</div>` : '<p class="stx-memory-muted">暂无向量批次记录。</p>'}</section></div>`;
  };
  const renderAudit = (): string => {
    const records = state.audits.length ? state.audits.map((record, index) => {
      const key = `${record.jobId ?? record.id ?? index}:${Number(record.batchIndex ?? index)}`;
      const canRollback = Boolean(record.jobId && Number.isInteger(record.batchIndex));
      const confirming = state.confirmBatchKey === key;
      const resource = formatAuditResource(record.resourceId ?? record.resource);
      const metrics = [
        ['来源', `${Array.isArray(record.sourceRefs) ? record.sourceRefs.length : 0} 项`],
        ['拒绝', `${Array.isArray(record.rejected) ? record.rejected.length : 0} 项`],
        ['资源', resource],
        ['模型', String(record.model ?? '未记录')],
      ];
      const rollback = !canRollback ? '' : confirming
        ? `<div class="stx-memory-confirm-inline"><span>确认回滚此批及后续批次？</span><button ${uiControl('button', 'danger')} type="button" data-action="confirm-rollback" data-job-id="${escapeHtml(record.jobId)}" data-batch-index="${Number(record.batchIndex)}">确认回滚</button><button ${uiControl('button', 'neutral')} type="button" data-action="cancel-rollback">取消</button></div>`
        : `<button ${uiControl('button', 'danger')} type="button" data-action="rollback" data-rollback-key="${escapeHtml(key)}">回滚此批及后续批次</button>`;

      return `<article class="stx-memory-audit-item"><div class="stx-memory-audit-heading"><div><span class="stx-memory-kicker">${record.type === 'recall' ? '召回' : `批次 ${Number(record.batchIndex ?? index) + 1}`}</span><h3>${escapeHtml(translateRecordStatus(String(record.status ?? '已记录')))}</h3></div>${renderStatusChip(`${Number(record.accepted ?? 0)} 条已接纳`, 'neutral')}</div><dl class="stx-memory-audit-metrics">${metrics.map(([label, value]) => `<div title="${escapeHtml(value)}"><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl><details class="stx-memory-audit-details"><summary>查看技术明细</summary><pre class="stx-memory-code">${escapeHtml(formatJson(record))}</pre></details>${rollback ? `<div class="stx-memory-audit-actions">${rollback}</div>` : ''}</article>`;
    }).join('') : renderEmpty('暂无批次审计', '新整理完成后会在这里出现。');
    return `<div class="stx-memory-page-actions"><p class="stx-memory-muted">审计记录只读展示已提交的整理结果。</p><button ${uiControl('button', 'neutral')} type="button" data-action="refresh-audit" ${state.busyAction ? 'disabled' : ''}><i class="fa-solid fa-rotate" aria-hidden="true"></i>刷新审计</button></div><div class="stx-memory-audit-list">${records}</div><details class="stx-memory-panel stx-memory-usage"><summary>主聊天 Token / usage（${state.usages.length} 条）</summary><pre class="stx-memory-code">${escapeHtml(formatJson(state.usages))}</pre></details>`;
  };
  const renderData = (): string => {
    const sqlite = state.sqlite;
    if (!sqlite) return renderEmpty('暂无存储状态', '点击刷新或稍后重试。');
    const schemaMatches = sqlite.schemaVersion === EXPECTED_SQLITE_SCHEMA_VERSION;
    const tableEntries = Object.entries(sqlite.tableCounts).sort(([left], [right]) => left.localeCompare(right));
    const chatUsageRatio = Math.max(0, Math.min(1, sqlite.currentChatUsageRatio));
    const databaseSize = sqlite.databaseSizeBytes > 0 ? formatBytes(sqlite.databaseSizeBytes) : '暂不可用';
    return `<section class="stx-memory-panel stx-memory-storage-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">SQLite 唯一存储</span><h3>${sqlite.connected ? '已连接' : '不可用'}</h3></div>${renderStatusChip(sqlite.connected ? '服务正常' : '不可用', sqlite.connected ? 'success' : 'error')}</div><dl class="stx-memory-maintenance-grid"><div><dt>SDK / 协议 / Schema</dt><dd>${escapeHtml(sqlite.serverVersion)} / v${sqlite.protocolVersion} / v${sqlite.schemaVersion}</dd></div><div><dt>SQLite / WAL</dt><dd>${escapeHtml(sqlite.sqliteVersion)} / ${escapeHtml(sqlite.walMode)}</dd></div><div><dt>Node.js</dt><dd>${escapeHtml(sqlite.nodeVersion)}</dd></div><div><dt>数据库 / WAL 占用</dt><dd>${escapeHtml(databaseSize)}</dd></div></dl><div class="stx-memory-chat-storage"><div class="stx-memory-chat-storage-head"><span><span class="stx-memory-storage-icon" aria-hidden="true"><i class="fa-solid fa-hard-drive"></i></span><span><small>本聊天记忆占用</small><strong>${escapeHtml(formatBytes(sqlite.currentChatSizeBytes))}</strong></span></span><strong>${escapeHtml(formatPercent(chatUsageRatio))}</strong></div><progress ${uiControl('progress')} max="1" value="${chatUsageRatio}">${escapeHtml(formatPercent(chatUsageRatio))}</progress><p>占当前角色全部 Memory 数据；统计包含事实、证据、批次、Usage、召回日志和向量。</p></div><p class="stx-memory-muted stx-memory-path">相对路径：${escapeHtml(sqlite.databasePath)}</p><div class="stx-memory-progress-copy"><span>向量覆盖率</span><strong>${formatPercent(sqlite.vectorCoverage.ratio)}</strong></div><progress ${uiControl('progress')} max="1" value="${Math.max(0, Math.min(1, sqlite.vectorCoverage.ratio))}">${formatPercent(sqlite.vectorCoverage.ratio)}</progress>${schemaMatches ? '' : '<p class="stx-memory-inline-alert" role="alert">Schema 版本不匹配，请重启酒馆并确认服务端插件已更新。</p>'}${sqlite.lastError ? `<p class="stx-memory-inline-alert" role="alert">最近事务错误：${escapeHtml(safeInlineError(sqlite.lastError, 'MEMORY_SQLITE_TRANSACTION_FAILED'))}</p>` : ''}<details class="stx-memory-table-details"><summary>各表记录数与估算占用</summary><div class="stx-memory-table-list">${tableEntries.length ? tableEntries.map(([name, count]) => `<div><span>${escapeHtml(name)}</span><strong>${formatNumber(count)}</strong><small>${sqlite.tableBytes[name] == null ? 'N/A' : escapeHtml(formatBytes(sqlite.tableBytes[name]!))}</small></div>`).join('') : '<p class="stx-memory-muted">暂无表统计。</p>'}</div></details></section><section class="stx-memory-panel stx-memory-maintenance-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">备份与恢复</span><h3>维护工具</h3></div></div><div class="stx-memory-maintenance-actions"><button class="stx-memory-maintenance-action" ${uiControl('button', 'neutral')} type="button" data-action="export"><span class="stx-memory-maintenance-icon" aria-hidden="true"><i class="fa-solid fa-file-export"></i></span><span><strong>导出 Memory 归档</strong><small>下载完整数据快照</small></span><span class="stx-memory-maintenance-chevron" aria-hidden="true"><i class="fa-solid fa-chevron-right"></i></span></button><label class="stx-memory-file-label stx-memory-maintenance-action" ${uiControl('file-trigger', 'neutral')}><span class="stx-memory-maintenance-icon" aria-hidden="true"><i class="fa-solid fa-file-import"></i></span><span><strong>恢复 Memory 归档</strong><small>从本地快照原子恢复</small></span><span class="stx-memory-maintenance-chevron" aria-hidden="true"><i class="fa-solid fa-chevron-right"></i></span><input type="file" accept="application/json,.json" data-action="import-file" /></label><button class="stx-memory-maintenance-action" ${uiControl('button', 'neutral')} type="button" data-action="integrity" ${state.busyAction ? 'disabled' : ''}><span class="stx-memory-maintenance-icon" aria-hidden="true"><i class="fa-solid fa-shield-halved"></i></span><span><strong>完整性检查</strong><small>检查 SQLite 数据结构</small></span><span class="stx-memory-maintenance-chevron" aria-hidden="true"><i class="fa-solid fa-chevron-right"></i></span></button></div>${state.pendingImport ? `<div class="stx-memory-confirm-panel"><p>确认恢复 <strong>${escapeHtml(state.pendingImport.name)}</strong>？这会原子替换当前用户完整 Memory 数据库。</p><button ${uiControl('button', 'danger')} type="button" data-action="confirm-import">确认恢复</button><button ${uiControl('button', 'neutral')} type="button" data-action="cancel-import">取消</button></div>` : ''}<div class="stx-memory-integrity-result" aria-live="polite"><span class="stx-memory-state-icon" aria-hidden="true"><i class="fa-solid fa-circle-info"></i></span><span><strong>检查状态</strong><small>${escapeHtml(state.integrityText)}</small></span></div><section class="stx-memory-danger-zone"><div class="stx-memory-danger-heading"><span class="stx-memory-danger-icon" aria-hidden="true"><i class="fa-solid fa-triangle-exclamation"></i></span><span><strong>危险操作</strong><small>执行前需要再次确认，聊天原文不会被删除。</small></span></div><div class="stx-memory-danger-actions">${state.dangerConfirm === 'current' ? `<div class="stx-memory-confirm-panel"><p>确认清空当前聊天来源？其他聊天仍有证据支持的事实会保留。</p><button ${uiControl('button', 'danger')} type="button" data-action="confirm-clear-current">确认清空</button><button ${uiControl('button', 'neutral')} type="button" data-action="cancel-danger">取消</button></div>` : `<button class="stx-memory-danger-action" ${uiControl('button', 'danger')} type="button" data-action="clear-current"><span class="stx-memory-danger-action-icon" aria-hidden="true"><i class="fa-solid fa-eraser"></i></span><span class="stx-memory-danger-action-label">清空当前聊天来源</span></button>`}${state.dangerConfirm === 'all' ? `<div class="stx-memory-confirm-panel"><p>输入“清空全部记忆”后确认，此操作无法撤销。</p><input ${uiControl('input')} data-clear-all-text placeholder="清空全部记忆"><button ${uiControl('button', 'danger')} type="button" data-action="confirm-clear-all">确认清空全部</button><button ${uiControl('button', 'neutral')} type="button" data-action="cancel-danger">取消</button></div>` : `<button class="stx-memory-danger-action" ${uiControl('button', 'danger')} type="button" data-action="clear-all"><span class="stx-memory-danger-action-icon" aria-hidden="true"><i class="fa-solid fa-trash-can"></i></span><span class="stx-memory-danger-action-label">清空全部角色记忆</span></button>`}</div></section></section>`;
  };
  const renderPage = (): string => {
    if (state.loading) return renderLoading('正在读取记忆工作台…');
    if (state.errorDiagnostic && !state.overview) return renderErrorDetails(state.errorDiagnostic, 'retry-load');
    if (state.pageLoading) return renderLoading();
    if (state.pageError) return renderErrorDetails(state.pageError, 'retry-page');
    const actionError = state.actionError ? renderErrorDetails(state.actionError, 'dismiss-error') : '';
    const content = state.page === 'library' ? renderLibrary()
      : state.page === 'initialize' ? renderInitialize()
        : state.page === 'recall' ? renderRecall()
          : state.page === 'audit' ? renderAudit() : renderData();
    return `${actionError}${content}`;
  };
  const render = (): void => {
    const overview = state.overview;
    const currentPage = PAGES.find((page) => page.id === state.page)!;
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
    root.innerHTML = `<div class="stx-memory-statusbar"><div class="stx-memory-chat-identity"><span class="stx-memory-kicker">当前聊天</span><strong>${escapeHtml(chatIdentity.label)}</strong></div><div><span class="stx-memory-kicker">运行状态</span>${renderStatusChip(overview ? translateOverviewStatus(overview.status) : '读取中', statusTone)}</div><div><span class="stx-memory-kicker">记忆数量</span><strong>${overview ? formatNumber(overview.factCount) : '—'}</strong></div><div class="stx-memory-status-storage"><span class="stx-memory-kicker">本聊天占用</span><strong>${escapeHtml(chatStorageLabel)}</strong><small>占角色记忆 ${escapeHtml(chatStorageRatio)}</small></div><div><span class="stx-memory-kicker">大语言模型</span>${renderStatusChip(overview ? (overview.llmAvailable ? '可用' : '不可用') : '读取中', overview?.llmAvailable ? 'success' : overview ? 'warning' : 'neutral')}</div>${alertMarkup}</div><div class="stx-memory-workspace-layout"><nav class="stx-memory-nav" aria-label="记忆工作台页面"><span class="stx-memory-nav-label">工作区</span>${PAGES.map((page) => `<button class="stx-memory-nav-item" type="button" data-action="navigate" data-page="${page.id}" aria-current="${page.id === state.page ? 'page' : 'false'}"><i class="fa-solid ${page.icon}" aria-hidden="true"></i><span><strong>${page.label}</strong><small>${page.description}</small></span></button>`).join('')}<div class="stx-memory-nav-meta">${overview?.lastOrganizedAt ? `最近整理<br>${escapeHtml(formatTime(overview.lastOrganizedAt))}` : '仅展示当前已实现能力'}</div></nav><main class="stx-memory-main"><header class="stx-memory-page-heading"><div><h2>${currentPage.label}</h2><p>${currentPage.description}</p></div><span class="stx-memory-page-counter">${PAGES.findIndex((page) => page.id === state.page) + 1} / ${PAGES.length}</span></header><section class="stx-memory-page-content" tabindex="-1">${renderPage()}</section></main></div>`;
    popupUi?.refreshControls(root);
    root.querySelectorAll<HTMLInputElement>('[data-filter-all]').forEach((input) => {
      const selectedCount = Number(input.dataset.selectedCount ?? 0);
      const optionCount = Number(input.dataset.optionCount ?? 0);
      input.indeterminate = selectedCount > 0 && selectedCount < optionCount;
    });
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
    if (action === 'refresh') { void refreshAll(); return; }
    if (action === 'retry-load') { void loadOverview(); return; }
    if (action === 'retry-page') { void loadPage(state.page); return; }
    if (action === 'dismiss-error') { state.actionError = undefined; rerender(); return; }
    if (action === 'refresh-health') { void runAction('refresh-health', async () => { state.sqlite = await controller.getSqliteStatus(); await loadOverview(); }, '检查已完成', '工作台状态已重新读取。', 'MEMORY_HEALTH_REFRESHED'); return; }
    if (action === 'select-fact') { state.selectedFactId = actionNode.dataset.factId ?? ''; state.editingFactId = ''; state.confirmFactId = ''; rerender(); return; }
    if (action === 'edit-fact') { state.editingFactId = actionNode.dataset.factId ?? ''; rerender('#stx-memory-edit-content'); return; }
    if (action === 'cancel-edit') { state.editingFactId = ''; rerender(); return; }
    if (action === 'save-fact') { const id = actionNode.dataset.factId ?? ''; const textarea = root.querySelector<HTMLTextAreaElement>('[data-edit-content]'); const content = textarea?.value.trim() ?? ''; if (!id || !content) return; void runAction('save-fact', () => controller.updateFact(id, content), '记忆已保存', '事实内容已更新。', 'MEMORY_FACT_UPDATED', async () => { state.editingFactId = ''; await refreshFacts(); }); return; }
    if (action === 'delete-fact') { state.confirmFactId = actionNode.dataset.factId ?? ''; rerender(); return; }
    if (action === 'cancel-delete') { state.confirmFactId = ''; rerender(); return; }
    if (action === 'confirm-delete') { const id = actionNode.dataset.factId ?? ''; void runAction('delete-fact', () => controller.removeFact(id), '记忆已删除', '原聊天消息不受影响。', 'MEMORY_FACT_DELETED', async () => { state.confirmFactId = ''; await refreshFacts(); }); return; }
    if (action === 'initialize-start') { const selectedKinds = [...state.selectedSourceKinds]; if (!selectedKinds.length || state.busyAction || !state.overview?.llmAvailable) return; void runAction('initialize', () => controller.initialize(selectedKinds), '初始化已完成', '当前聊天已经可以使用记忆召回。', 'MEMORY_INITIALIZE_COMPLETED', async () => { await refreshInitialization(selectedKinds); }); return; }
    if (action === 'initialize-resume') { if (state.busyAction || !state.overview?.llmAvailable) return; void runAction('initialize-resume', () => controller.retry(), '初始化已完成', '已继续处理暂存结果，当前聊天已经可以使用记忆召回。', 'MEMORY_INITIALIZE_RESUMED', async () => { await refreshInitialization(state.selectedSourceKinds); }); return; }
    if (action === 'initialize-cancel') { void runAction('cancel-capture', () => controller.cancelCapture(), '初始化已取消', '已停止继续处理新批次。', 'MEMORY_INITIALIZE_CANCELLED', async () => { await updateProgress(); }); return; }
    if (action === 'view-library') { void loadPage('library'); return; }
    if (action === 'open-reinitialize') {
      if (state.busyAction || !state.overview?.llmAvailable) return;
      const successfulKinds = state.initialization?.selectedSourceKinds.filter((kind) => state.sources.some((source) => source.kind === kind)) ?? [];
      state.selectedSourceKinds = successfulKinds.length ? successfulKinds : state.sources.filter((source) => source.selected).map((source) => source.kind);
      state.reinitializeOpen = true;
      rerender('#stx-memory-reinitialize-cancel');
      void controller.getInitializationEstimate(state.selectedSourceKinds).then((estimate) => { if (!disposed && state.reinitializeOpen) { state.estimate = estimate; rerender('#stx-memory-reinitialize-cancel'); } }).catch((error) => toast('error', '估算失败', '无法更新重新初始化成本估算。', safeErrorCode(error, 'MEMORY_ESTIMATE_FAILED')));
      return;
    }
    if (action === 'cancel-reinitialize') { state.reinitializeOpen = false; rerender('#stx-memory-reinitialize-trigger'); return; }
    if (action === 'confirm-reinitialize') {
      const selectedKinds = [...state.selectedSourceKinds];
      if (!selectedKinds.length || state.busyAction || !state.overview?.llmAvailable || Boolean(state.progress && ['queued', 'running', 'paused'].includes(state.progress.status))) return;
      state.reinitializeOpen = false;
      void runAction('reinitialize', () => controller.reinitialize(selectedKinds), '重新初始化已完成', '旧 Memory 数据已替换，当前聊天已经可以使用记忆召回。', 'MEMORY_REINITIALIZE_COMPLETED', async () => { await refreshInitialization(selectedKinds); });
      return;
    }
    if (action === 'rebuild-index') { void runAction('rebuild-index', () => controller.rebuildVectorIndex(), '索引重建已开始', '向量覆盖率会在后台更新。', 'MEMORY_INDEX_REBUILD_STARTED', async () => { await loadPage('recall'); }); return; }
    if (action === 'refresh-audit') { void loadPage('audit'); return; }
    if (action === 'rollback') { state.confirmBatchKey = actionNode.dataset.rollbackKey ?? ''; rerender(); return; }
    if (action === 'cancel-rollback') { state.confirmBatchKey = ''; rerender(); return; }
    if (action === 'confirm-rollback') { const jobId = actionNode.dataset.jobId ?? ''; const batchIndex = Number(actionNode.dataset.batchIndex); if (!jobId || !Number.isInteger(batchIndex)) return; void runAction('rollback', () => controller.rollbackBatch(jobId, batchIndex), '批次已回滚', formatRollbackConfirmation(jobId, batchIndex), 'MEMORY_BATCH_ROLLED_BACK', async () => { state.confirmBatchKey = ''; await loadPage('audit'); await refreshFacts(); }); return; }
    if (action === 'export') { void controller.exportSqliteBackup().then(downloadSqlite).then(() => toast('success', '归档已导出', 'Memory 数据快照已下载。', 'MEMORY_ARCHIVE_EXPORTED')).catch((error) => toast('error', '导出失败', '无法生成 Memory 归档。', safeErrorCode(error, 'MEMORY_EXPORT_FAILED'))); return; }
    if (action === 'confirm-import') { const file = state.pendingImport; if (!file) return; void runAction('import', () => controller.importSqliteBackup(file), '归档已恢复', 'Memory 数据已原子替换。', 'MEMORY_ARCHIVE_IMPORTED', async () => { state.pendingImport = undefined; state.dangerConfirm = ''; await loadOverview(); await loadPage('data'); }); return; }
    if (action === 'cancel-import') { state.pendingImport = undefined; rerender(); return; }
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
      searchTimer = window.setTimeout(() => { void refreshFacts().then(() => rerender()).catch((error) => toast('error', '搜索失败', '无法读取筛选结果，请稍后重试。', safeErrorCode(error, 'MEMORY_SEARCH_FAILED'))); }, 220);
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
    if (input.dataset.sourceKind) { const selected = (input as HTMLInputElement).checked; state.selectedSourceKinds = selected ? [...new Set([...state.selectedSourceKinds, input.dataset.sourceKind])] : state.selectedSourceKinds.filter((kind) => kind !== input.dataset.sourceKind); void controller.getInitializationEstimate(state.selectedSourceKinds).then((estimate) => { if (!disposed) { state.estimate = estimate; rerender(); } }).catch((error) => toast('error', '估算失败', '无法更新初始化成本估算。', safeErrorCode(error, 'MEMORY_ESTIMATE_FAILED'))); return; }
    if (input.dataset.action === 'import-file') { const file = (input as HTMLInputElement).files?.[0]; if (file) { state.pendingImport = file; rerender(); } }
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

  render();
  void loadOverview();
  return () => {
    disposed = true; pageRequestId += 1; progressRequestId += 1; abortController.abort();
    if (searchTimer) window.clearTimeout(searchTimer);
    if (progressTimer) window.clearTimeout(progressTimer);
    root.replaceChildren();
  };
}
