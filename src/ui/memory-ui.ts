import './memory.css';
import type { ToastNotification } from '@ss-helper/sdk';
import {
  HISTORY_BATCH_MAX_CHARS,
  HISTORY_BATCH_MAX_MESSAGES,
  HISTORY_BATCH_OVERLAP,
  estimateHistoryInitialization,
  type InitializationEstimate,
} from '../application/ingest/source-blocks';

export interface MemoryUiSettings {
  enabled: boolean;
  autoOrganize: boolean;
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
  status: 'ready' | 'working' | 'error' | 'disabled';
  bound?: boolean;
  chatKey?: string;
  factCount: number;
  lastOrganizedAt: number | null;
  pendingJobs: number;
  llmAvailable: boolean;
  llmResource?: string;
  llmModel?: string;
  errorCode?: string;
  error?: string;
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
  initialize(selectedKinds?: string[]): Promise<void>;
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
  { name: '向量召回', status: '可用', detail: '使用 LLMHub 的 embedding 资源建立可再生成索引，并保留实体、证据、状态和时间硬过滤。' },
  { name: '混合召回与 rerank', status: '可用', detail: '关键词与向量通过 RRF 融合；自适应策略仅在排序有歧义时调用 LLMHub rerank，失败会自动降级。' },
  { name: '关系图谱', status: '未实现', detail: '当前版本不建立关系图谱，也不会把语义相似度当作实体关系；后续实现前保持明确边界。' },
  { name: '类型工坊', status: '替代', detail: '由固定中文事实类型、搜索筛选和手工编辑替代；未知扩展类型仍可原样展示。' },
  { name: '遗忘与失真', status: '停止', detail: '不会静默删减或改写用户事实，删除必须由用户明确操作。' },
  { name: '世界风格', status: '保留来源', detail: '不再复制为独立配置；角色卡和已启用世界书会作为可选择、可追溯的初始化来源。' },
] as const);

export interface FactViewOptions { kind: string; status: string; sort: 'updated_desc' | 'confidence_desc' | 'kind_asc' }
export type MemoryInitializationEstimate = InitializationEstimate;

const FACT_KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  identity: '身份', relationship: '关系', location: '地点', world_rule: '世界规则', state: '状态',
  goal: '目标', commitment: '承诺', event: '事件', preference: '偏好', other: '其他',
});
const FACT_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({ active: '有效', pending: '待确认', superseded: '已替代', invalid: '无效' });
const OVERVIEW_STATUS_LABELS: Readonly<Record<MemoryUiOverview['status'], string>> = Object.freeze({ ready: '就绪', working: '整理中', error: '异常', disabled: '已停用' });

export function translateFactKind(value: string): string { return FACT_KIND_LABELS[value] ?? value; }
export function translateFactStatus(value: string): string { return FACT_STATUS_LABELS[value] ?? value; }
export function translateOverviewStatus(value: MemoryUiOverview['status']): string { return OVERVIEW_STATUS_LABELS[value]; }
export function translateChatBinding(value: boolean | undefined): string { return value === true ? '已绑定' : value === false ? '未绑定' : '待确认'; }

export function filterAndSortFacts(facts: readonly MemoryUiFact[], options: FactViewOptions): MemoryUiFact[] {
  const filtered = facts.filter((fact) => (!options.kind || fact.kind === options.kind) && (!options.status || fact.status === options.status));
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

export function estimateInitializationCost(messages: readonly string[]): MemoryInitializationEstimate {
  const visibleMessages = messages.map((message) => message.trim()).filter(Boolean);
  const normalizedMessages = visibleMessages.flatMap((content) => {
    const parts: string[] = [];
    for (let offset = 0; offset < content.length; offset += HISTORY_BATCH_MAX_CHARS) parts.push(content.slice(offset, offset + HISTORY_BATCH_MAX_CHARS));
    return parts;
  });
  const batchCharCounts: number[] = [];
  let cursor = 0;
  while (cursor < normalizedMessages.length) {
    let index = cursor; let charCount = 0; let itemCount = 0;
    while (index < normalizedMessages.length && itemCount < HISTORY_BATCH_MAX_MESSAGES) {
      const length = normalizedMessages[index]!.length;
      if (itemCount > 0 && charCount + length > HISTORY_BATCH_MAX_CHARS) break;
      charCount += length; itemCount += 1; index += 1;
    }
    batchCharCounts.push(charCount);
    if (index >= normalizedMessages.length) break;
    cursor = Math.max(cursor + 1, index - HISTORY_BATCH_OVERLAP);
  }
  return estimateHistoryInitialization(visibleMessages.length, batchCharCounts.map((charCount, index) => [{ id: `estimate:${index}`, chatKey: 'estimate', kind: 'message' as const, role: 'user' as const, content: '0'.repeat(charCount), createdAt: index }]));
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
function formatJson(value: unknown, fallback = '暂无记录'): string {
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
function safeErrorMessage(_error: unknown): string { return '操作失败，请稍后重试。'; }

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
  overview?: MemoryUiOverview;
  facts: MemoryUiFact[];
  query: string;
  kind: string;
  status: string;
  sort: FactViewOptions['sort'];
  selectedFactId: string;
  editingFactId: string;
  confirmFactId: string;
  sources: MemoryInitializationSourceOption[];
  selectedSourceKinds: string[];
  estimate?: MemoryInitializationEstimate;
  progress?: MemoryCaptureProgress;
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

function renderStatusChip(label: string, tone: 'neutral' | 'success' | 'warning' | 'error' = 'neutral'): string {
  return `<span class="stx-memory-chip stx-memory-chip-${tone}">${escapeHtml(label)}</span>`;
}
function renderLoading(message = '正在读取…'): string { return `<div class="stx-memory-loading" role="status"><span class="stx-memory-spinner" aria-hidden="true"></span>${escapeHtml(message)}</div>`; }
function renderEmpty(message: string, detail = ''): string { return `<div class="stx-memory-empty"><strong>${escapeHtml(message)}</strong>${detail ? `<p>${escapeHtml(detail)}</p>` : ''}</div>`; }
function renderRoute(label: string, route: MemoryRecallRouteStatus): string {
  const tone = route.available ? 'success' : 'warning';
  return `<div class="stx-memory-route"><div><strong>${escapeHtml(label)}</strong><span>${route.available ? '可用' : '不可用'}</span></div><small>${escapeHtml(route.resourceId ?? route.blockedReason ?? '未配置')}</small>${route.model ? `<small>模型：${escapeHtml(route.model)}</small>` : ''}</div>`;
}

export function renderMemoryWorkbench(container: HTMLElement, controller: MemoryUiController, notify: (notification: ToastNotification) => void = () => undefined): () => void {
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
    page: 'library', loading: true, pageLoading: false, busyAction: '', errorCode: '', facts: [], query: '', kind: '', status: '', sort: 'updated_desc',
    selectedFactId: '', editingFactId: '', confirmFactId: '', sources: [], selectedSourceKinds: [], audits: [], usages: [], integrityText: '尚未执行完整性检查。', confirmBatchKey: '', dangerConfirm: '',
  };

  const toast = (level: ToastNotification['level'], title: string, message: string, code: string): void => {
    notify({ level, title, message, code, durationMs: level === 'error' ? 0 : 3200 });
  };
  const rerender = (focusSelector = ''): void => {
    if (disposed) return;
    render();
    if (focusSelector) window.setTimeout(() => root.querySelector<HTMLElement>(focusSelector)?.focus(), 0);
  };
  const scheduleProgress = (): void => {
    if (progressTimer) window.clearTimeout(progressTimer);
    progressTimer = undefined;
    if (!disposed && state.progress && ['queued', 'running', 'paused'].includes(state.progress.status)) {
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
    state.loading = true; state.errorCode = ''; rerender();
    try {
      state.overview = await controller.getOverview();
      state.facts = state.overview.bound === false ? [] : await controller.listFacts(state.query);
      state.selectedFactId = state.facts[0]?.id ?? '';
      state.loading = false; rerender();
      void updateProgress();
    } catch (error) {
      state.loading = false; state.errorCode = safeErrorCode(error, 'MEMORY_WORKBENCH_LOAD_FAILED'); rerender();
      toast('error', '记忆工作台读取失败', '请检查当前聊天绑定和 Memory 服务状态。', state.errorCode);
    }
  };
  const loadPage = async (page: MemoryWorkbenchPage): Promise<void> => {
    if (disposed) return;
    const requestId = ++pageRequestId;
    state.page = page; state.pageLoading = true; rerender();
    const isCurrent = (): boolean => !disposed && requestId === pageRequestId;
    try {
      if (page === 'initialize') {
        const sources = await controller.getInitializationSources();
        if (!isCurrent()) return;
        state.sources = sources;
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
      }
      if (!isCurrent()) return;
    } catch (error) {
      if (!isCurrent()) return;
      state.errorCode = safeErrorCode(error, 'MEMORY_WORKBENCH_PAGE_FAILED');
      toast('error', '页面读取失败', '请稍后重试，当前页面状态未被修改。', state.errorCode);
    } finally {
      if (isCurrent()) { state.pageLoading = false; rerender(); }
    }
  };
  const refreshAll = async (): Promise<void> => {
    state.busyAction = 'refresh'; rerender();
    try { await controller.getOverview().then((overview) => { state.overview = overview; }); await refreshFacts(); toast('success', '已刷新', '记忆工作台数据已更新。', 'MEMORY_WORKBENCH_REFRESHED'); }
    catch (error) { toast('error', '刷新失败', '记忆数据未能更新。', safeErrorCode(error, 'MEMORY_WORKBENCH_REFRESH_FAILED')); }
    finally { state.busyAction = ''; rerender(); }
  };
  const runAction = async (action: string, task: () => Promise<void>, successTitle: string, successMessage: string, successCode: string, reload?: () => Promise<void>): Promise<void> => {
    state.busyAction = action; rerender();
    try { await task(); if (reload) await reload(); toast('success', successTitle, successMessage, successCode); }
    catch (error) { toast('error', '操作失败', safeErrorMessage(error), safeErrorCode(error, `MEMORY_${action.toUpperCase()}_FAILED`)); }
    finally { state.busyAction = ''; rerender(); }
  };

  const renderLibrary = (): string => {
    const visibleFacts = filterAndSortFacts(state.facts, { kind: state.kind, status: state.status, sort: state.sort });
    const selected = visibleFacts.find((fact) => fact.id === state.selectedFactId) ?? state.facts.find((fact) => fact.id === state.selectedFactId);
    const list = visibleFacts.length === 0
      ? renderEmpty('没有匹配的记忆', state.query ? '尝试缩短关键词或清除筛选条件。' : '当前聊天还没有可展示的事实。')
      : visibleFacts.map((fact) => `<button class="stx-memory-fact-row" type="button" data-action="select-fact" data-fact-id="${escapeHtml(fact.id)}" aria-selected="${fact.id === selected?.id ? 'true' : 'false'}"><span class="stx-memory-fact-row-top"><strong>${escapeHtml(translateFactKind(fact.kind))}</strong>${renderStatusChip(translateFactStatus(fact.status), fact.status === 'active' ? 'success' : fact.status === 'invalid' ? 'error' : 'neutral')}</span><span class="stx-memory-fact-snippet">${escapeHtml(fact.content)}</span><span class="stx-memory-fact-row-meta">置信度 ${Math.round(fact.confidence * 100)}% · ${escapeHtml(formatTime(fact.updatedAt))}</span></button>`).join('');
    const detail = !selected ? renderEmpty('选择一条记忆', '右侧会显示证据、替代链和可执行操作。') : (() => {
      const editing = state.editingFactId === selected.id;
      const confirming = state.confirmFactId === selected.id;
      return `<div class="stx-memory-detail-head"><div><span class="stx-memory-kicker">${escapeHtml(translateFactKind(selected.kind))}</span><h3>${escapeHtml(translateFactStatus(selected.status))} · 置信度 ${Math.round(selected.confidence * 100)}%</h3></div><span class="stx-memory-detail-time">${escapeHtml(formatTime(selected.updatedAt))}</span></div>
        ${editing ? `<label class="stx-memory-field-label" for="stx-memory-edit-content">编辑记忆事实</label><textarea id="stx-memory-edit-content" class="stx-memory-textarea" data-edit-content>${escapeHtml(selected.content)}</textarea><div class="stx-memory-actions"><button class="stx-memory-button stx-memory-button-primary" type="button" data-action="save-fact" data-fact-id="${escapeHtml(selected.id)}" ${state.busyAction === 'save-fact' ? 'disabled' : ''}>保存</button><button class="stx-memory-button" type="button" data-action="cancel-edit">取消</button></div>` : `<p class="stx-memory-fact-content">${escapeHtml(selected.content)}</p><div class="stx-memory-actions"><button class="stx-memory-button stx-memory-button-primary" type="button" data-action="edit-fact" data-fact-id="${escapeHtml(selected.id)}">编辑</button>${confirming ? `<span class="stx-memory-confirm-inline"><span>确认删除？</span><button class="stx-memory-button stx-memory-button-danger" type="button" data-action="confirm-delete" data-fact-id="${escapeHtml(selected.id)}">确认</button><button class="stx-memory-button" type="button" data-action="cancel-delete">取消</button></span>` : '<button class="stx-memory-button stx-memory-button-danger" type="button" data-action="delete-fact" data-fact-id="' + escapeHtml(selected.id) + '">删除</button>'}</div>`}
        <div class="stx-memory-detail-section"><h4>来源与证据</h4>${selected.evidence.length ? selected.evidence.map((item) => `<blockquote class="stx-memory-evidence"><p>${escapeHtml(item.excerpt)}</p><small>${escapeHtml(item.sourceRef)}</small></blockquote>`).join('') : '<p class="stx-memory-muted">没有可展示的来源证据。</p>'}</div>
        <div class="stx-memory-detail-grid"><div><h4>来源引用</h4><p>${selected.sourceRefs.length ? selected.sourceRefs.map(escapeHtml).join('、') : '无'}</p></div><div><h4>替代链</h4><p>${selected.supersedesId ? `替代 ${escapeHtml(selected.supersedesId)}` : ''}${selected.supersedesId && selected.supersededById ? ' · ' : ''}${selected.supersededById ? `被 ${escapeHtml(selected.supersededById)} 替代` : (!selected.supersedesId ? '无' : '')}</p></div></div>
        <div class="stx-memory-detail-section"><h4>整理批次</h4><p>${selected.auditBatches?.length ? selected.auditBatches.map((item) => `${escapeHtml(item.jobId)} / #${item.batchIndex + 1}（${escapeHtml(item.status)}）`).join('；') : '暂无匹配批次审计。'}</p></div>`;
    })();
    return `<div class="stx-memory-toolbar"><label class="stx-memory-search-wrap"><span class="stx-memory-sr-only">搜索记忆</span><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input class="stx-memory-input" data-filter="query" value="${escapeHtml(state.query)}" placeholder="搜索记忆内容、人物或地点" /></label><label class="stx-memory-select-wrap"><span class="stx-memory-sr-only">事实类型</span><select class="stx-memory-input" data-filter="kind"><option value="">全部类型</option>${Object.entries(FACT_KIND_LABELS).map(([value, label]) => `<option value="${value}" ${state.kind === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label class="stx-memory-select-wrap"><span class="stx-memory-sr-only">事实状态</span><select class="stx-memory-input" data-filter="status"><option value="">全部状态</option>${Object.entries(FACT_STATUS_LABELS).map(([value, label]) => `<option value="${value}" ${state.status === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label class="stx-memory-select-wrap"><span class="stx-memory-sr-only">排序</span><select class="stx-memory-input" data-filter="sort"><option value="updated_desc" ${state.sort === 'updated_desc' ? 'selected' : ''}>最近更新</option><option value="confidence_desc" ${state.sort === 'confidence_desc' ? 'selected' : ''}>置信度</option><option value="kind_asc" ${state.sort === 'kind_asc' ? 'selected' : ''}>类型</option></select></label><button class="stx-memory-button" type="button" data-action="refresh" ${state.busyAction ? 'disabled' : ''}><i class="fa-solid fa-rotate" aria-hidden="true"></i>刷新</button></div><div class="stx-memory-result-line"><span aria-live="polite">筛选结果 ${visibleFacts.length} 条</span><span>当前聊天：${escapeHtml(translateChatBinding(state.overview?.bound))}</span></div><div class="stx-memory-library-grid"><section class="stx-memory-fact-list" aria-label="记忆列表">${list}</section><section class="stx-memory-inspector" aria-label="记忆详情">${detail}</section></div>`;
  };
  const renderInitialize = (): string => {
    const progress = state.progress;
    const running = Boolean(progress && ['queued', 'running', 'paused'].includes(progress.status));
    return `<div class="stx-memory-card-grid"><section class="stx-memory-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">来源选择</span><h3>初始化当前聊天</h3></div>${state.estimate ? renderStatusChip(`${formatNumber(state.estimate.messageCount)} 条消息`, 'neutral') : ''}</div><p class="stx-memory-muted">只选择已有聊天、角色卡或世界书来源；不会改写原始聊天内容。</p><div class="stx-memory-source-list">${state.sources.length ? state.sources.map((source) => `<label class="stx-memory-source-option"><input type="checkbox" data-source-kind="${escapeHtml(source.kind)}" ${state.selectedSourceKinds.includes(source.kind) ? 'checked' : ''} ${running ? 'disabled' : ''}><span><strong>${escapeHtml(source.label)}</strong><small>${formatNumber(source.count)} 项</small></span></label>`).join('') : renderEmpty('当前没有可初始化来源', '请先选择角色或打开聊天。')}</div>${state.estimate ? `<dl class="stx-memory-estimate-grid"><div><dt>预计批次</dt><dd>${formatNumber(state.estimate.batchCount)}</dd></div><div><dt>Token 下限</dt><dd>${formatNumber(state.estimate.tokenLow)}</dd></div><div><dt>Token 上限</dt><dd>${formatNumber(state.estimate.tokenHigh)}</dd></div></dl>` : ''}<div class="stx-memory-actions"><button class="stx-memory-button stx-memory-button-primary" type="button" data-action="initialize-start" ${running || !state.sources.length || state.busyAction ? 'disabled' : ''}><i class="fa-solid fa-play" aria-hidden="true"></i>开始初始化</button></div></section><section class="stx-memory-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">任务状态</span><h3>${progress ? escapeHtml(progress.status === 'running' ? '正在整理' : progress.status === 'completed' ? '已完成' : progress.status === 'cancelled' ? '已取消' : progress.status === 'failed' ? '失败' : '空闲') : '尚未读取'}</h3></div>${progress?.jobId ? renderStatusChip(progress.jobId, 'neutral') : ''}</div>${progress ? `<div class="stx-memory-progress-copy"><span>批次 ${progress.batchIndex} / ${progress.totalBatches || 0}</span><span>${formatNumber(progress.processedCount)} 项 · ${Math.round(progress.elapsedMs / 1000)} 秒</span></div><progress class="stx-memory-progress" max="${Math.max(progress.totalBatches, 1)}" value="${Math.min(progress.batchIndex, Math.max(progress.totalBatches, 1))}">${progress.batchIndex}</progress>${progress.error ? `<p class="stx-memory-inline-alert" role="alert">错误码：${escapeHtml(safeInlineError(progress.error, 'MEMORY_CAPTURE_FAILED'))}</p>` : ''}${running ? `<button class="stx-memory-button stx-memory-button-danger" type="button" data-action="initialize-cancel" ${state.busyAction ? 'disabled' : ''}>取消任务</button>` : ''}` : renderEmpty('暂无初始化任务', '开始初始化后会在这里显示批次和耗时。')}</section></div>`;
  };
  const renderRecall = (): string => {
    const recall = state.recall;
    if (!recall) return renderEmpty('暂无召回状态', '点击刷新或稍后重试。');
    const coverage = recall.eligibleFacts ? Math.round((recall.indexedFacts / recall.eligibleFacts) * 100) : 0;
    const recallError = recall.degradedReason ?? recall.lastError;
    return `<div class="stx-memory-card-grid"><section class="stx-memory-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">当前策略</span><h3>${escapeHtml(recall.resolvedMode)}</h3></div>${renderStatusChip(recall.rebuilding ? '重建中' : '运行正常', recall.rebuilding ? 'warning' : 'success')}</div><div class="stx-memory-route-grid">${renderRoute('Embedding', recall.embedding)}${renderRoute('Rerank', recall.rerank)}</div><div class="stx-memory-metric-grid"><div><span>已建立索引</span><strong>${formatNumber(recall.indexedFacts)}</strong></div><div><span>可索引事实</span><strong>${formatNumber(recall.eligibleFacts)}</strong></div><div><span>待处理</span><strong>${formatNumber(recall.pendingFacts)}</strong></div></div><div class="stx-memory-progress-copy"><span>向量覆盖率</span><strong>${coverage}%</strong></div><progress class="stx-memory-progress" max="100" value="${coverage}">${coverage}%</progress>${recallError ? `<p class="stx-memory-inline-alert" role="alert">错误码：${escapeHtml(safeInlineError(recallError, 'MEMORY_RECALL_DEGRADED'))}</p>` : ''}<div class="stx-memory-actions"><button class="stx-memory-button stx-memory-button-primary" type="button" data-action="rebuild-index" ${recall.rebuilding || state.busyAction ? 'disabled' : ''}><i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i>重建向量索引</button></div></section><section class="stx-memory-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">最近召回</span><h3>诊断摘要</h3></div></div><pre class="stx-memory-code">${escapeHtml(formatJson(state.diagnostics))}</pre>${recall.batches.length ? `<div class="stx-memory-batch-table"><div class="stx-memory-table-row stx-memory-table-head"><span>批次</span><span>输入</span><span>延迟</span><span>接受</span></div>${recall.batches.map((batch) => `<div class="stx-memory-table-row"><span>#${batch.batchIndex + 1}</span><span>${formatNumber(batch.inputCount)}</span><span>${formatNumber(batch.latencyMs)} ms</span><span>${formatNumber(batch.accepted)} / ${formatNumber(batch.rejected)}</span></div>`).join('')}</div>` : '<p class="stx-memory-muted">暂无向量批次记录。</p>'}</section></div>`;
  };
  const renderAudit = (): string => {
    const records = state.audits.length ? state.audits.map((record, index) => { const key = `${record.jobId ?? record.id ?? index}:${Number(record.batchIndex ?? index)}`; const canRollback = Boolean(record.jobId && Number.isInteger(record.batchIndex)); const confirming = state.confirmBatchKey === key; return `<article class="stx-memory-audit-item"><div class="stx-memory-audit-heading"><div><span class="stx-memory-kicker">${record.type === 'recall' ? '召回' : `批次 ${Number(record.batchIndex ?? index) + 1}`}</span><h3>${escapeHtml(String(record.status ?? '已记录'))}</h3></div>${renderStatusChip(`${Number(record.accepted ?? 0)} 接受`, 'neutral')}</div><p class="stx-memory-muted">来源 ${Array.isArray(record.sourceRefs) ? record.sourceRefs.length : 0} 项 · 拒绝 ${Array.isArray(record.rejected) ? record.rejected.length : 0} · 资源 ${escapeHtml(record.resourceId ?? record.resource ?? '未记录')} · 模型 ${escapeHtml(record.model ?? '未记录')}</p><details><summary>查看完整审计</summary><pre class="stx-memory-code">${escapeHtml(formatJson(record))}</pre></details>${canRollback ? (confirming ? `<div class="stx-memory-confirm-inline"><span>确认回滚此批及后续批次？</span><button class="stx-memory-button stx-memory-button-danger" type="button" data-action="confirm-rollback" data-job-id="${escapeHtml(record.jobId)}" data-batch-index="${Number(record.batchIndex)}">确认回滚</button><button class="stx-memory-button" type="button" data-action="cancel-rollback">取消</button></div>` : `<button class="stx-memory-button stx-memory-button-danger" type="button" data-action="rollback" data-rollback-key="${escapeHtml(key)}">回滚此批及后续批次</button>`) : ''}</article>`; }).join('') : renderEmpty('暂无批次审计', '新整理完成后会在这里出现。');
    return `<div class="stx-memory-page-actions"><p class="stx-memory-muted">审计记录只读展示已提交的整理结果。</p><button class="stx-memory-button" type="button" data-action="refresh-audit" ${state.busyAction ? 'disabled' : ''}><i class="fa-solid fa-rotate" aria-hidden="true"></i>刷新审计</button></div><div class="stx-memory-audit-list">${records}</div><details class="stx-memory-panel stx-memory-usage"><summary>主聊天 Token / usage（${state.usages.length} 条）</summary><pre class="stx-memory-code">${escapeHtml(formatJson(state.usages))}</pre></details>`;
  };
  const renderData = (): string => {
    const sqlite = state.sqlite;
    if (!sqlite) return renderEmpty('暂无存储状态', '点击刷新或稍后重试。');
    const schemaMatches = sqlite.schemaVersion === EXPECTED_SQLITE_SCHEMA_VERSION;
    const tableEntries = Object.entries(sqlite.tableCounts).sort(([left], [right]) => left.localeCompare(right));
    return `<section class="stx-memory-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">SQLite 唯一存储</span><h3>${sqlite.connected ? '已连接' : '不可用'}</h3></div>${renderStatusChip(sqlite.connected ? '服务正常' : '不可用', sqlite.connected ? 'success' : 'error')}</div><dl class="stx-memory-maintenance-grid"><div><dt>服务端 / 协议 / Schema</dt><dd>${escapeHtml(sqlite.serverVersion)} / v${sqlite.protocolVersion} / v${sqlite.schemaVersion}</dd></div><div><dt>SQLite / WAL</dt><dd>${escapeHtml(sqlite.sqliteVersion)} / ${escapeHtml(sqlite.walMode)}</dd></div><div><dt>Node / 数据库大小</dt><dd>${escapeHtml(sqlite.nodeVersion)} / ${escapeHtml(formatBytes(sqlite.databaseSizeBytes))}</dd></div></dl><p class="stx-memory-muted stx-memory-path">相对路径：${escapeHtml(sqlite.databasePath)}</p><div class="stx-memory-progress-copy"><span>向量覆盖率</span><strong>${Math.round(sqlite.vectorCoverage.ratio * 100)}%</strong></div><progress class="stx-memory-progress" max="1" value="${Math.max(0, Math.min(1, sqlite.vectorCoverage.ratio))}">${Math.round(sqlite.vectorCoverage.ratio * 100)}%</progress>${schemaMatches ? '' : '<p class="stx-memory-inline-alert" role="alert">Schema 版本不匹配，请重启酒馆并确认服务端插件已更新。</p>'}${sqlite.lastError ? `<p class="stx-memory-inline-alert" role="alert">最近事务错误：${escapeHtml(safeInlineError(sqlite.lastError, 'MEMORY_SQLITE_TRANSACTION_FAILED'))}</p>` : ''}<details class="stx-memory-table-details"><summary>各表记录数与占用</summary><div class="stx-memory-table-list">${tableEntries.length ? tableEntries.map(([name, count]) => `<div><span>${escapeHtml(name)}</span><strong>${formatNumber(count)}</strong><small>${sqlite.tableBytes[name] == null ? 'N/A' : escapeHtml(formatBytes(sqlite.tableBytes[name]!))}</small></div>`).join('') : '<p class="stx-memory-muted">暂无表统计。</p>'}</div></details></section><section class="stx-memory-panel"><div class="stx-memory-panel-heading"><div><span class="stx-memory-kicker">备份与危险区</span><h3>维护操作</h3></div></div><div class="stx-memory-actions stx-memory-actions-wrap"><button class="stx-memory-button" type="button" data-action="export">导出 Memory 归档</button><label class="stx-memory-button stx-memory-file-label">恢复 Memory 归档<input type="file" accept="application/json,.json" data-action="import-file" /></label><button class="stx-memory-button" type="button" data-action="integrity" ${state.busyAction ? 'disabled' : ''}>完整性检查</button></div>${state.pendingImport ? `<div class="stx-memory-confirm-panel"><p>确认恢复 <strong>${escapeHtml(state.pendingImport.name)}</strong>？这会原子替换当前用户完整 Memory 数据库。</p><button class="stx-memory-button stx-memory-button-danger" type="button" data-action="confirm-import">确认恢复</button><button class="stx-memory-button" type="button" data-action="cancel-import">取消</button></div>` : ''}<p class="stx-memory-inline-result" aria-live="polite">${escapeHtml(state.integrityText)}</p><div class="stx-memory-danger-zone"><h4>危险操作</h4>${state.dangerConfirm === 'current' ? '<div class="stx-memory-confirm-panel"><p>确认清空当前聊天来源？其他聊天仍有证据支持的事实会保留。</p><button class="stx-memory-button stx-memory-button-danger" type="button" data-action="confirm-clear-current">确认清空</button><button class="stx-memory-button" type="button" data-action="cancel-danger">取消</button></div>' : '<button class="stx-memory-button stx-memory-button-danger" type="button" data-action="clear-current">清空当前聊天来源</button>'}${state.dangerConfirm === 'all' ? '<div class="stx-memory-confirm-panel"><p>输入“清空全部记忆”后确认，此操作无法撤销。</p><input class="stx-memory-input" data-clear-all-text placeholder="清空全部记忆"><button class="stx-memory-button stx-memory-button-danger" type="button" data-action="confirm-clear-all">确认清空全部</button><button class="stx-memory-button" type="button" data-action="cancel-danger">取消</button></div>' : '<button class="stx-memory-button stx-memory-button-danger" type="button" data-action="clear-all">清空全部角色记忆</button>'}</div></section>`;
  };
  const renderPage = (): string => {
    if (state.loading) return renderLoading('正在读取记忆工作台…');
    if (state.errorCode && !state.overview) return `<div class="stx-memory-error-state"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><h3>工作台暂时不可用</h3><p>错误码：${escapeHtml(state.errorCode)}</p><button class="stx-memory-button stx-memory-button-primary" type="button" data-action="retry-load">重试</button></div>`;
    if (state.pageLoading) return renderLoading();
    if (state.page === 'library') return renderLibrary();
    if (state.page === 'initialize') return renderInitialize();
    if (state.page === 'recall') return renderRecall();
    if (state.page === 'audit') return renderAudit();
    return renderData();
  };
  const render = (): void => {
    const overview = state.overview;
    const currentPage = PAGES.find((page) => page.id === state.page)!;
    const statusTone = overview?.status === 'error' ? 'error' : overview?.status === 'working' ? 'warning' : overview?.status === 'ready' ? 'success' : 'neutral';
    const diagnosticCode = overview ? readSafeLlmErrorDetails(overview).code : '未知';
    const alertMarkup = !overview ? '' : !overview.llmAvailable
      ? `<div class="stx-memory-alert" role="alert"><span>LLMHub 当前不可用</span><small>错误码：LLM_SERVICE_UNAVAILABLE</small><button class="stx-memory-button stx-memory-button-danger" type="button" data-action="refresh-health">重新检查</button></div>`
      : overview.status === 'error'
        ? `<div class="stx-memory-alert" role="alert"><span>Memory 当前异常</span><small>错误码：${escapeHtml(diagnosticCode === '未知' ? 'MEMORY_RUNTIME_ERROR' : diagnosticCode)}</small><button class="stx-memory-button stx-memory-button-danger" type="button" data-action="refresh-health">重新检查</button></div>`
        : '';
    root.innerHTML = `<div class="stx-memory-statusbar"><div><span class="stx-memory-kicker">当前聊天</span><strong>${escapeHtml(translateChatBinding(overview?.bound))}</strong></div><div><span class="stx-memory-kicker">运行状态</span>${renderStatusChip(overview ? translateOverviewStatus(overview.status) : '读取中', statusTone)}</div><div><span class="stx-memory-kicker">记忆数量</span><strong>${overview ? formatNumber(overview.factCount) : '—'}</strong></div><div><span class="stx-memory-kicker">LLM</span>${renderStatusChip(overview ? (overview.llmAvailable ? '可用' : '不可用') : '读取中', overview?.llmAvailable ? 'success' : overview ? 'warning' : 'neutral')}</div>${alertMarkup}</div><div class="stx-memory-workspace-layout"><nav class="stx-memory-nav" aria-label="记忆工作台页面"><span class="stx-memory-nav-label">工作区</span>${PAGES.map((page) => `<button class="stx-memory-nav-item" type="button" data-action="navigate" data-page="${page.id}" aria-current="${page.id === state.page ? 'page' : 'false'}"><i class="fa-solid ${page.icon}" aria-hidden="true"></i><span><strong>${page.label}</strong><small>${page.description}</small></span></button>`).join('')}<div class="stx-memory-nav-meta">${overview?.lastOrganizedAt ? `最近整理<br>${escapeHtml(formatTime(overview.lastOrganizedAt))}` : '仅展示当前已实现能力'}</div></nav><main class="stx-memory-main"><header class="stx-memory-page-heading"><div><span class="stx-memory-kicker">Memory workspace</span><h2>${currentPage.label}</h2><p>${currentPage.description}</p></div><span class="stx-memory-page-counter">${PAGES.findIndex((page) => page.id === state.page) + 1} / ${PAGES.length}</span></header><section class="stx-memory-page-content" tabindex="-1">${renderPage()}</section></main></div>`;
  };

  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const actionNode = target.closest<HTMLElement>('[data-action]');
    if (!actionNode || disposed) return;
    const action = actionNode.dataset.action;
    if (action === 'navigate') { const page = actionNode.dataset.page as MemoryWorkbenchPage; if (PAGES.some((item) => item.id === page)) void loadPage(page); return; }
    if (action === 'refresh') { void refreshAll(); return; }
    if (action === 'retry-load') { void loadOverview(); return; }
    if (action === 'refresh-health') { void runAction('refresh-health', async () => { state.sqlite = await controller.getSqliteStatus(); await loadOverview(); }, '检查已完成', '工作台状态已重新读取。', 'MEMORY_HEALTH_REFRESHED'); return; }
    if (action === 'select-fact') { state.selectedFactId = actionNode.dataset.factId ?? ''; state.editingFactId = ''; state.confirmFactId = ''; rerender(); return; }
    if (action === 'edit-fact') { state.editingFactId = actionNode.dataset.factId ?? ''; rerender('#stx-memory-edit-content'); return; }
    if (action === 'cancel-edit') { state.editingFactId = ''; rerender(); return; }
    if (action === 'save-fact') { const id = actionNode.dataset.factId ?? ''; const textarea = root.querySelector<HTMLTextAreaElement>('[data-edit-content]'); const content = textarea?.value.trim() ?? ''; if (!id || !content) return; void runAction('save-fact', () => controller.updateFact(id, content), '记忆已保存', '事实内容已更新。', 'MEMORY_FACT_UPDATED', async () => { state.editingFactId = ''; await refreshFacts(); }); return; }
    if (action === 'delete-fact') { state.confirmFactId = actionNode.dataset.factId ?? ''; rerender(); return; }
    if (action === 'cancel-delete') { state.confirmFactId = ''; rerender(); return; }
    if (action === 'confirm-delete') { const id = actionNode.dataset.factId ?? ''; void runAction('delete-fact', () => controller.removeFact(id), '记忆已删除', '原聊天消息不受影响。', 'MEMORY_FACT_DELETED', async () => { state.confirmFactId = ''; await refreshFacts(); }); return; }
    if (action === 'initialize-start') { void runAction('initialize', () => controller.initialize(state.selectedSourceKinds.length ? state.selectedSourceKinds : undefined), '初始化已开始', '正在按来源整理当前聊天。', 'MEMORY_INITIALIZE_STARTED', async () => { await updateProgress(); }); return; }
    if (action === 'initialize-cancel') { void runAction('cancel-capture', () => controller.cancelCapture(), '初始化已取消', '已停止继续处理新批次。', 'MEMORY_INITIALIZE_CANCELLED', async () => { await updateProgress(); }); return; }
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
    if (input.dataset.filter === 'kind') { state.kind = input.value; rerender(); return; }
    if (input.dataset.filter === 'status') { state.status = input.value; rerender(); return; }
    if (input.dataset.filter === 'sort') { state.sort = input.value as FactViewOptions['sort']; rerender(); return; }
    if (input.dataset.sourceKind) { const selected = (input as HTMLInputElement).checked; state.selectedSourceKinds = selected ? [...new Set([...state.selectedSourceKinds, input.dataset.sourceKind])] : state.selectedSourceKinds.filter((kind) => kind !== input.dataset.sourceKind); void controller.getInitializationEstimate(state.selectedSourceKinds).then((estimate) => { if (!disposed) { state.estimate = estimate; rerender(); } }).catch((error) => toast('error', '估算失败', '无法更新初始化成本估算。', safeErrorCode(error, 'MEMORY_ESTIMATE_FAILED'))); return; }
    if (input.dataset.action === 'import-file') { const file = (input as HTMLInputElement).files?.[0]; if (file) { state.pendingImport = file; rerender(); } }
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
