import './memory.css';
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
  vectorCoverage: {
    indexedFacts: number;
    eligibleFacts: number;
    ratio: number;
  };
  lastError?: string;
}

export interface MemorySqliteIntegrityResult {
  ok: boolean;
  message: string;
}

export const EXPECTED_SQLITE_SCHEMA_VERSION = 2;

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
  /** 当前 Memory 实例是否已绑定到酒馆聊天。 */
  bound?: boolean;
  /** 仅用于诊断当前绑定目标；界面默认不直接暴露完整标识。 */
  chatKey?: string;
  factCount: number;
  lastOrganizedAt: number | null;
  pendingJobs: number;
  llmAvailable: boolean;
  /** 当前 memory_extract 路由资源；不得包含凭据。 */
  llmResource?: string;
  /** 当前 memory_extract 模型；不得包含凭据。 */
  llmModel?: string;
  /** 最近一次可安全展示的错误码，例如 401。 */
  errorCode?: string;
  error?: string;
}

export interface MemoryInitializationSourceOption {
  kind: string;
  label: string;
  count: number;
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
  getInitializationSources?(): Promise<MemoryInitializationSourceOption[]>;
  initialize(selectedKinds?: string[]): Promise<void>;
  getCaptureProgress?(): Promise<MemoryCaptureProgress>;
  cancelCapture?(): Promise<void>;
  retry(): Promise<void>;
  listFacts(query?: string): Promise<MemoryUiFact[]>;
  updateFact(id: string, content: string): Promise<void>;
  removeFact(id: string): Promise<void>;
  getLastRecall(): Promise<unknown>;
  listAuditRecords?(): Promise<MemoryAuditRecord[]>;
  getMainChatUsage?(): Promise<unknown[]>;
  getRecallStatus?(): Promise<MemoryRecallStatus>;
  rebuildVectorIndex?(): Promise<void>;
  rollbackBatch?(jobId: string, batchIndex: number): Promise<void>;
  getSqliteStatus(): Promise<MemorySqliteStatus>;
  exportSqliteBackup(): Promise<Blob>;
  importSqliteBackup(file: File): Promise<void>;
  checkSqliteIntegrity(): Promise<MemorySqliteIntegrityResult>;
  clearCurrentChatData(): Promise<void>;
  clearAllMemoryData(): Promise<void>;
}

const WORKBENCH_ID = 'stx-memory-workbench';

const FACT_KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  identity: '身份',
  relationship: '关系',
  location: '地点',
  world_rule: '世界规则',
  state: '状态',
  goal: '目标',
  commitment: '承诺',
  event: '事件',
  preference: '偏好',
  other: '其他',
});

const FACT_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  active: '有效',
  pending: '待确认',
  superseded: '已替代',
  invalid: '无效',
});

const OVERVIEW_STATUS_LABELS: Readonly<Record<MemoryUiOverview['status'], string>> = Object.freeze({
  ready: '就绪',
  working: '整理中',
  error: '异常',
  disabled: '已停用',
});

export const MEMORY_CAPABILITY_BOUNDARIES = Object.freeze([
  { name: '证据优先整理', status: '可用', detail: '只保存能够追溯到当前聊天来源的事实，避免把缺少来源的推测写成记忆。' },
  { name: '向量召回', status: '可用', detail: '使用 LLMHub 的 embedding 资源建立可再生成索引，并保留实体、证据、状态和时间硬过滤。' },
  { name: '混合召回与 rerank', status: '可用', detail: '关键词与向量通过 RRF 融合；自适应策略仅在排序有歧义时调用 LLMHub rerank，失败会自动降级。' },
  { name: '关系图谱', status: '未实现', detail: '当前版本不建立关系图谱，也不会把语义相似度当作实体关系；后续实现前保持明确边界。' },
  { name: '类型工坊', status: '替代', detail: '由固定中文事实类型、搜索筛选和手工编辑替代；未知扩展类型仍可原样展示。' },
  { name: '遗忘与失真', status: '停止', detail: '不会静默删减或改写用户事实，删除必须由用户明确操作。' },
  { name: '世界风格', status: '保留来源', detail: '不再复制为独立配置；角色卡和已启用世界书会作为可选择、可追溯的初始化来源。' },
] as const);

export interface FactViewOptions {
  kind: string;
  status: string;
  sort: 'updated_desc' | 'confidence_desc' | 'kind_asc';
}

export type MemoryInitializationEstimate = InitializationEstimate;

/** 将事实类型转换为用户可读术语，未知扩展值保持原样。 */
export function translateFactKind(value: string): string {
  return FACT_KIND_LABELS[value] ?? value;
}

/** 将事实状态转换为用户可读术语，未知扩展值保持原样。 */
export function translateFactStatus(value: string): string {
  return FACT_STATUS_LABELS[value] ?? value;
}

/** 将运行状态转换为用户可读术语。 */
export function translateOverviewStatus(value: MemoryUiOverview['status']): string {
  return OVERVIEW_STATUS_LABELS[value];
}

/** 将可选绑定状态转换为明确且不会误报的文案。 */
export function translateChatBinding(value: boolean | undefined): string {
  if (value === true) return '已绑定';
  if (value === false) return '未绑定';
  return '待确认';
}

/** 对控制器返回的事实做纯展示筛选和排序，不改变底层事实状态。 */
export function filterAndSortFacts(
  facts: readonly MemoryUiFact[],
  options: FactViewOptions,
): MemoryUiFact[] {
  const filtered = facts.filter((fact) => (
    (!options.kind || fact.kind === options.kind)
    && (!options.status || fact.status === options.status)
  ));
  return [...filtered].sort((left, right) => {
    if (options.sort === 'confidence_desc') return right.confidence - left.confidence || right.updatedAt - left.updatedAt;
    if (options.sort === 'kind_asc') return left.kind.localeCompare(right.kind, 'zh-CN') || right.updatedAt - left.updatedAt;
    return right.updatedAt - left.updatedAt;
  });
}

export interface SafeLlmErrorDetails {
  code: string;
  resource: string;
  model: string;
}

/** 从错误文案中只提取可公开诊断字段，永不展示凭据。 */
export function readSafeLlmErrorDetails(overview: MemoryUiOverview): SafeLlmErrorDetails {
  const message = overview.error ?? '';
  const code = overview.errorCode
    ?? message.match(/(?:HTTP\s*)?\b(4\d\d|5\d\d)\b/i)?.[1]
    ?? '未知';
  const resource = overview.llmResource
    ?? message.match(/(?:resource|资源)\s*[:：=]\s*([^\s,，;；]+)/i)?.[1]
    ?? 'memory_extract 路由';
  const model = overview.llmModel
    ?? message.match(/(?:model|模型)\s*[:：=]\s*([^\s,，;；]+)/i)?.[1]
    ?? '由 LLMHub 决定';
  return { code, resource, model };
}

/**
 * 根据当前页面可见消息粗估初始化成本。
 * 该值不含角色卡、世界书和供应商侧附加提示词，不能替代 LLMHub 的实际 usage。
 */
export function estimateInitializationCost(messages: readonly string[]): MemoryInitializationEstimate {
  const visibleMessages = messages.map((message) => message.trim()).filter(Boolean);
  const normalizedMessages = visibleMessages.flatMap((content) => {
    const parts: string[] = [];
    for (let offset = 0; offset < content.length; offset += HISTORY_BATCH_MAX_CHARS) {
      parts.push(content.slice(offset, offset + HISTORY_BATCH_MAX_CHARS));
    }
    return parts;
  });
  const batchCharCounts: number[] = [];
  let cursor = 0;
  while (cursor < normalizedMessages.length) {
    let index = cursor;
    let charCount = 0;
    let itemCount = 0;
    while (index < normalizedMessages.length && itemCount < HISTORY_BATCH_MAX_MESSAGES) {
      const length = normalizedMessages[index]!.length;
      if (itemCount > 0 && charCount + length > HISTORY_BATCH_MAX_CHARS) break;
      charCount += length;
      itemCount += 1;
      index += 1;
    }
    batchCharCounts.push(charCount);
    if (index >= normalizedMessages.length) break;
    cursor = Math.max(cursor + 1, index - HISTORY_BATCH_OVERLAP);
  }
  return estimateHistoryInitialization(
    visibleMessages.length,
    batchCharCounts.map((charCount, index) => [{
      id: `estimate:${index}`,
      chatKey: 'estimate',
      kind: 'message' as const,
      role: 'user' as const,
      content: '0'.repeat(charCount),
      createdAt: index,
    }]),
  );
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]!);
}

function formatTime(value: number | null): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '尚未整理';
}

function downloadSqlite(content: Blob): void {
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(content);
  anchor.download = content instanceof File && content.name
    ? content.name
    : `ss-helper-memory-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return 'N/A';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let amount = value / 1024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024;
    unit = units[index]!;
  }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${unit}`;
}

function renderSqliteStatus(status: MemorySqliteStatus): string {
  const coverage = Math.max(0, Math.min(1, status.vectorCoverage.ratio));
  const schemaMatches = status.schemaVersion === EXPECTED_SQLITE_SCHEMA_VERSION;
  const tables = Object.entries(status.tableCounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => {
      const bytes = status.tableBytes[name];
      return `<div><dt class="stx-memory-muted text-xs">${escapeHtml(name)}</dt><dd class="mt-1 font-semibold">${formatNumber(count)}</dd><dd class="stx-memory-muted mt-1">${bytes === null || bytes === undefined ? 'N/A' : escapeHtml(formatBytes(bytes))}</dd></div>`;
    })
    .join('');
  return `
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div><strong>SQLite 唯一存储</strong><p class="stx-memory-muted mt-1 text-xs">所有记忆、设置、审计与向量均保存在酒馆服务端。</p></div>
      <span class="stx-memory-tag ${status.connected ? '' : 'stx-memory-warning'}">${status.connected ? '已连接' : '不可用'}</span>
    </div>
    <dl class="memory-sqlite-summary mt-3 grid gap-2 text-sm sm:grid-cols-3">
      <div><dt class="stx-memory-muted text-xs">服务端 / 协议 / Schema</dt><dd class="mt-1">${escapeHtml(status.serverVersion)} / v${escapeHtml(status.protocolVersion)} / v${escapeHtml(status.schemaVersion)}${schemaMatches ? '' : `（需要 v${EXPECTED_SQLITE_SCHEMA_VERSION}）`}</dd></div>
      <div><dt class="stx-memory-muted text-xs">SQLite / WAL</dt><dd class="mt-1">${escapeHtml(status.sqliteVersion)} / ${escapeHtml(status.walMode)}</dd></div>
      <div><dt class="stx-memory-muted text-xs">Node / 数据库大小</dt><dd class="mt-1">${escapeHtml(status.nodeVersion)} / ${escapeHtml(formatBytes(status.databaseSizeBytes))}</dd></div>
    </dl>
    <p class="stx-memory-muted mt-3 break-all text-xs" title="${escapeHtml(status.databasePath)}">相对路径：${escapeHtml(status.databasePath)}</p>
    <div class="mt-3"><div class="flex justify-between gap-3 text-xs"><span>向量覆盖率</span><span>${formatNumber(status.vectorCoverage.indexedFacts)} / ${formatNumber(status.vectorCoverage.eligibleFacts)}（${Math.round(coverage * 100)}%）</span></div><progress class="memory-vector-coverage mt-2 w-full" max="1" value="${coverage}">${Math.round(coverage * 100)}%</progress></div>
    <details class="stx-memory-details mt-3 text-xs"><summary>各表记录数与占用</summary><dl class="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">${tables || '<p class="stx-memory-muted">暂无表统计。</p>'}</dl></details>
    ${schemaMatches ? '' : `<p class="stx-memory-alert mt-3 rounded border p-2 text-xs" role="alert">Schema 版本不匹配：当前 v${escapeHtml(status.schemaVersion)}，Memory 要求 v${EXPECTED_SQLITE_SCHEMA_VERSION}。请重启酒馆并确认服务端插件已更新。</p>`}
    ${status.lastError ? `<p class="stx-memory-alert mt-3 rounded border p-2 text-xs" role="alert">最近事务错误：${escapeHtml(status.lastError)}</p>` : '<p class="stx-memory-muted mt-3 text-xs">最近事务错误：无</p>'}
  `;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

function renderFactRows(facts: readonly MemoryUiFact[]): string {
  if (facts.length === 0) return '<p class="py-10 text-center text-sm opacity-60">没有匹配的记忆。</p>';
  return facts.map((fact) => `
    <article class="stx-memory-card rounded-lg border p-3" data-fact-id="${escapeHtml(fact.id)}" aria-label="${escapeHtml(translateFactKind(fact.kind))}记忆">
      <div class="stx-memory-fact-meta mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span class="stx-memory-tag">${escapeHtml(translateFactKind(fact.kind))}</span>
        <span class="stx-memory-tag">${escapeHtml(translateFactStatus(fact.status))}</span>
        <span class="stx-memory-muted">置信度 ${Math.round(fact.confidence * 100)}%</span>
      </div>
      <p class="memory-fact-content whitespace-pre-wrap text-sm leading-6">${escapeHtml(fact.content)}</p>
      <p class="stx-memory-muted mt-2 text-xs">来源 ${fact.sourceRefs.length} 项 · ${escapeHtml(formatTime(fact.updatedAt))}</p>
      ${fact.supersedesId || fact.supersededById ? `<p class="stx-memory-muted mt-1 text-xs">替代链：${fact.supersedesId ? `替代 ${escapeHtml(fact.supersedesId)}` : ''}${fact.supersedesId && fact.supersededById ? ' · ' : ''}${fact.supersededById ? `被 ${escapeHtml(fact.supersededById)} 替代` : ''}</p>` : ''}
      ${fact.auditBatches?.length ? `<p class="stx-memory-muted mt-1 text-xs">整理批次：${fact.auditBatches.map((item) => `${escapeHtml(item.jobId)} / #${item.batchIndex + 1}（${escapeHtml(item.status)}）`).join('；')}</p>` : '<p class="stx-memory-warning mt-1 text-xs">此事实没有可匹配的批次审计（手工事实或旧数据）。</p>'}
      ${fact.evidence.length > 0 ? `<details class="stx-memory-details mt-2 text-xs"><summary class="cursor-pointer">查看 ${fact.evidence.length} 条来源证据</summary>${fact.evidence.map((item) => `<blockquote class="stx-memory-evidence mt-2 border-l-2 pl-2">${escapeHtml(item.excerpt)}<br><small>sourceRef: ${escapeHtml(item.sourceRef)}</small></blockquote>`).join('')}</details>` : '<p class="stx-memory-warning mt-2 text-xs">此条目没有可展示的来源证据。</p>'}
      <div class="mt-3 flex gap-2">
        <button class="memory-edit stx-memory-button stx-memory-button-secondary rounded border px-3 py-1 text-xs" type="button">编辑</button>
        <button class="memory-remove stx-memory-button stx-memory-button-danger rounded border px-3 py-1 text-xs" type="button">删除</button>
      </div>
    </article>`).join('');
}

function getFocusableElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
  )].filter((element) => element.offsetParent !== null || element === document.activeElement);
}

function installDialogKeyboard(dialog: HTMLDialogElement, returnFocus: HTMLElement | null): void {
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      dialog.close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = getFocusableElements(dialog);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  dialog.addEventListener('close', () => returnFocus?.focus(), { once: true });
}

function renderAuditRecords(records: readonly MemoryAuditRecord[], usages: readonly unknown[]): string {
  if (records.length === 0 && usages.length === 0) {
    return '<p class="stx-memory-muted text-xs">暂无批次审计或主聊天 usage；新整理完成后会在这里出现。</p>';
  }
  const recordHtml = records.map((record, index) => {
    const rejected = Array.isArray(record.rejected) ? record.rejected.length : 0;
    const sourceCount = Array.isArray(record.sourceRefs) ? record.sourceRefs.length : 0;
    const title = record.type === 'recall' ? '召回' : `批次 ${record.batchIndex ?? index + 1}`;
    const canRollback = Boolean(record.jobId && Number.isInteger(record.batchIndex) && !record.rolledBackAt);
    return `<article class="stx-memory-audit-card rounded border p-3">
      <div class="flex flex-wrap items-center justify-between gap-2"><strong>${escapeHtml(title)}</strong><span class="stx-memory-tag">${escapeHtml(record.status ?? '已记录')}</span></div>
      <p class="stx-memory-muted mt-2 text-xs">来源 ${sourceCount} · 接受 ${Number(record.accepted ?? 0)} · 拒绝 ${rejected} · 资源 ${escapeHtml(record.resourceId ?? '未记录')} · 模型 ${escapeHtml(record.model ?? '未记录')} · Token ${escapeHtml((record.usage && typeof record.usage === 'object' ? (record.usage as Record<string, unknown>).totalTokens : null) ?? '供应商未返回')}</p>
      <details class="stx-memory-details mt-2 text-xs"><summary>查看完整审计</summary><pre class="stx-memory-code mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded p-3">${escapeHtml(JSON.stringify(record, null, 2))}</pre></details>
      ${canRollback ? `<button class="memory-batch-rollback stx-memory-button stx-memory-button-danger mt-2 rounded border px-3 py-1 text-xs" type="button" data-job-id="${escapeHtml(record.jobId)}" data-batch-index="${Number(record.batchIndex)}">回滚此批及后续批次</button>` : ''}
    </article>`;
  }).join('');
  const usageHtml = usages.length > 0
    ? `<details class="stx-memory-details mt-3 text-xs"><summary>主聊天 Token / usage（${usages.length} 条）</summary><pre class="stx-memory-code mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded p-3">${escapeHtml(JSON.stringify(usages, null, 2))}</pre></details>`
    : '<p class="stx-memory-muted mt-3 text-xs">宿主未返回主聊天精确 usage，界面不会把估算冒充实测。</p>';
  return `<div class="grid gap-2">${recordHtml}</div>${usageHtml}`;
}

async function openWorkbench(controller: MemoryUiController, container?: HTMLElement): Promise<void> {
  if (!container) document.getElementById(WORKBENCH_ID)?.remove();
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const [overview, facts, diagnostics] = await Promise.all([
    controller.getOverview(), controller.listFacts(), controller.getLastRecall(),
  ]);
  const llmError = readSafeLlmErrorDetails(overview);
  const dialog = container ? document.createElement('section') : document.createElement('dialog');
  dialog.id = WORKBENCH_ID;
  dialog.className = 'stx-memory-surface m-auto h-[min(88vh,760px)] w-[min(94vw,880px)] rounded-xl border p-0 shadow-2xl';
  dialog.setAttribute('aria-labelledby', 'stx-memory-workbench-title');
  dialog.setAttribute('aria-describedby', 'stx-memory-workbench-description');
  dialog.innerHTML = `
    <div class="flex h-full flex-col">
      <header class="stx-memory-divider flex items-center justify-between border-b px-5 py-4">
        <div><h2 id="stx-memory-workbench-title" class="text-lg font-semibold">记忆工作台</h2><p id="stx-memory-workbench-description" class="stx-memory-muted mt-1 text-xs">只保留可验证、与当前聊天隔离的事实。</p></div>
        <button class="memory-close stx-memory-button stx-memory-button-quiet rounded px-3 py-2 text-lg" type="button" aria-label="关闭">×</button>
      </header>
      <div class="stx-memory-divider grid gap-3 border-b p-4 sm:grid-cols-5">
        <div><p class="stx-memory-muted text-xs">运行状态</p><strong class="text-sm">${escapeHtml(translateOverviewStatus(overview.status))}</strong></div>
        <div title="${escapeHtml(overview.chatKey ?? '')}"><p class="stx-memory-muted text-xs">当前聊天</p><strong class="text-sm">${escapeHtml(translateChatBinding(overview.bound))}</strong></div>
        <div><p class="stx-memory-muted text-xs">记忆数量</p><strong class="text-sm">${overview.factCount}</strong></div>
        <div><p class="stx-memory-muted text-xs">最近整理</p><strong class="text-sm">${escapeHtml(formatTime(overview.lastOrganizedAt))}</strong></div>
        <div><p class="stx-memory-muted text-xs">LLM</p><strong class="text-sm">${overview.llmAvailable ? '可用' : '不可用'}</strong></div>
      </div>
      ${overview.error || !overview.llmAvailable ? `<div class="stx-memory-alert stx-memory-divider border-b px-4 py-3 text-sm" role="alert">
        <div class="flex flex-wrap items-center justify-between gap-3"><strong>${escapeHtml(overview.error ?? 'LLMHub 当前不可用')}</strong><button class="memory-retry stx-memory-button stx-memory-button-danger rounded border px-3 py-1" type="button">修复后重试</button></div>
        <dl class="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs"><div><dt class="inline font-semibold">错误码：</dt><dd class="inline">${escapeHtml(llmError.code)}</dd></div><div><dt class="inline font-semibold">资源：</dt><dd class="inline">${escapeHtml(llmError.resource)}</dd></div><div><dt class="inline font-semibold">模型：</dt><dd class="inline">${escapeHtml(llmError.model)}</dd></div></dl>
      </div>` : ''}
      <div class="stx-memory-divider grid gap-2 border-b p-3 sm:grid-cols-[minmax(12rem,1fr)_auto_auto_auto]">
        <label class="stx-memory-sr-only" for="stx-memory-search">搜索记忆</label>
        <input id="stx-memory-search" class="memory-search stx-memory-input min-w-0 rounded-lg border px-3 py-2 text-sm" placeholder="搜索记忆内容、人物或地点" />
        <label class="stx-memory-sr-only" for="stx-memory-kind-filter">事实类型</label>
        <select id="stx-memory-kind-filter" class="memory-kind-filter stx-memory-input rounded-lg border px-3 py-2 text-sm"><option value="">全部类型</option>${Object.entries(FACT_KIND_LABELS).map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join('')}</select>
        <label class="stx-memory-sr-only" for="stx-memory-status-filter">事实状态</label>
        <select id="stx-memory-status-filter" class="memory-status-filter stx-memory-input rounded-lg border px-3 py-2 text-sm"><option value="">全部状态</option>${Object.entries(FACT_STATUS_LABELS).map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join('')}</select>
        <label class="stx-memory-sr-only" for="stx-memory-sort">排序</label>
        <select id="stx-memory-sort" class="memory-sort stx-memory-input rounded-lg border px-3 py-2 text-sm"><option value="updated_desc">最近更新</option><option value="confidence_desc">置信度</option><option value="kind_asc">类型</option></select>
      </div>
      <div class="stx-memory-divider flex items-center justify-between gap-2 border-b px-4 py-2 text-xs"><span class="memory-result-summary stx-memory-muted" aria-live="polite">共 ${facts.length} 条</span>
        <button class="memory-refresh stx-memory-button stx-memory-button-secondary rounded-lg border px-3 py-2 text-sm" type="button">刷新</button>
      </div>
      <main class="memory-list grid flex-1 content-start gap-3 overflow-y-auto p-4">${renderFactRows(facts)}</main>
      <details class="stx-memory-details stx-memory-divider border-t px-4 py-3 text-xs">
        <summary class="cursor-pointer select-none">召回诊断、批次审计与数据</summary>
        <div class="mt-3 flex items-center justify-between gap-2"><strong>批次与拒绝审计</strong><button class="memory-audit-refresh stx-memory-button stx-memory-button-secondary rounded border px-3 py-1" type="button">刷新审计</button></div>
        <div class="memory-audit-list mt-2" aria-live="polite"><p class="stx-memory-muted">展开后点击“刷新审计”读取记录。</p></div>
        <strong class="mt-4 block">最后一次召回</strong>
        <pre class="stx-memory-code mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded p-3">${escapeHtml(JSON.stringify(diagnostics, null, 2) || '暂无召回记录')}</pre>
        <div class="mt-3 flex flex-wrap gap-2">
          <button class="memory-export-sqlite stx-memory-button stx-memory-button-secondary rounded border px-3 py-2" type="button">导出 Memory 归档</button>
          <label class="stx-memory-button stx-memory-button-secondary cursor-pointer rounded border px-3 py-2">恢复 Memory 归档<input class="memory-import-sqlite hidden" type="file" accept="application/json,.json" /></label>
          <button class="memory-integrity stx-memory-button stx-memory-button-secondary rounded border px-3 py-2" type="button">完整性检查</button>
          <button class="memory-clear stx-memory-button stx-memory-button-danger rounded border px-3 py-2" type="button">清空当前聊天来源</button>
          <button class="memory-clear-all stx-memory-button stx-memory-button-danger rounded border px-3 py-2" type="button">清空全部角色记忆</button>
        </div>
        <p class="memory-integrity-result stx-memory-muted mt-2 text-xs" aria-live="polite">恢复会原子替换当前用户的完整 Memory 数据库；操作前请先导出快照。</p>
      </details>
    </div>`;
  (container ?? document.body).append(dialog);

  const refresh = async (): Promise<void> => {
    const query = (dialog.querySelector<HTMLInputElement>('.memory-search')?.value ?? '').trim();
    const kind = dialog.querySelector<HTMLSelectElement>('.memory-kind-filter')?.value ?? '';
    const status = dialog.querySelector<HTMLSelectElement>('.memory-status-filter')?.value ?? '';
    const sort = (dialog.querySelector<HTMLSelectElement>('.memory-sort')?.value ?? 'updated_desc') as FactViewOptions['sort'];
    const list = dialog.querySelector<HTMLElement>('.memory-list');
    const nextFacts = filterAndSortFacts(await controller.listFacts(query), { kind, status, sort });
    if (list) list.innerHTML = renderFactRows(nextFacts);
    const summary = dialog.querySelector<HTMLElement>('.memory-result-summary');
    if (summary) summary.textContent = `筛选结果 ${nextFacts.length} 条`;
  };
  const refreshAudit = async (): Promise<void> => {
    const list = dialog.querySelector<HTMLElement>('.memory-audit-list');
    if (!list) return;
    list.innerHTML = '<p class="stx-memory-muted">正在读取审计…</p>';
    const [records, usages] = await Promise.all([
      controller.listAuditRecords?.() ?? Promise.resolve([]),
      controller.getMainChatUsage?.() ?? Promise.resolve([]),
    ]);
    list.innerHTML = renderAuditRecords(records, usages);
  };
  dialog.querySelector('.memory-close')?.addEventListener('click', () => {
    if (dialog instanceof HTMLDialogElement) dialog.close();
    else dialog.remove();
  });
  dialog.querySelector('.memory-refresh')?.addEventListener('click', () => void refresh());
  dialog.querySelector('.memory-retry')?.addEventListener('click', () => void controller.retry().then(refresh));
  dialog.querySelector('.memory-audit-refresh')?.addEventListener('click', () => void refreshAudit());
  dialog.querySelector('.memory-audit-list')?.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.memory-batch-rollback');
    const jobId = button?.dataset.jobId ?? '';
    const batchIndex = Number(button?.dataset.batchIndex);
    if (!button || !controller.rollbackBatch || !jobId || !Number.isInteger(batchIndex)) return;
    if (!window.confirm(formatRollbackConfirmation(jobId, batchIndex))) return;
    button.disabled = true;
    void controller.rollbackBatch(jobId, batchIndex)
      .then(() => Promise.all([refresh(), refreshAudit()]))
      .catch((error: unknown) => window.alert(error instanceof Error ? error.message : String(error)))
      .finally(() => { button.disabled = false; });
  });
  dialog.querySelector('.memory-search')?.addEventListener('input', () => void refresh());
  dialog.querySelector('.memory-kind-filter')?.addEventListener('change', () => void refresh());
  dialog.querySelector('.memory-status-filter')?.addEventListener('change', () => void refresh());
  dialog.querySelector('.memory-sort')?.addEventListener('change', () => void refresh());
  dialog.querySelector('.memory-list')?.addEventListener('click', async (event) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>('[data-fact-id]');
    if (!row) return;
    const id = row.dataset.factId ?? '';
    if (target.closest('.memory-remove') && window.confirm('删除这条记忆？删除后不会影响原聊天消息。')) {
      await controller.removeFact(id);
    }
    if (target.closest('.memory-edit')) {
      const current = row.querySelector('.memory-fact-content')?.textContent ?? '';
      const next = window.prompt('编辑记忆事实', current)?.trim();
      if (next && next !== current) await controller.updateFact(id, next);
    }
    await refresh();
  });
  dialog.querySelector('.memory-export-sqlite')?.addEventListener('click', () => {
    void controller.exportSqliteBackup()
      .then(downloadSqlite)
      .catch((error: unknown) => window.alert(error instanceof Error ? error.message : String(error)));
  });
  dialog.querySelector<HTMLInputElement>('.memory-import-sqlite')?.addEventListener('change', (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (!window.confirm(`确认恢复 ${file.name}？这会原子替换当前用户的完整 Memory SQLite 数据库。`)) return;
    void controller.importSqliteBackup(file)
      .then(refresh)
      .then(() => window.alert('Memory 归档恢复成功。'))
      .catch((error: unknown) => window.alert(error instanceof Error ? error.message : String(error)))
      .finally(() => { (event.target as HTMLInputElement).value = ''; });
  });
  dialog.querySelector<HTMLButtonElement>('.memory-integrity')?.addEventListener('click', (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const resultNode = dialog.querySelector<HTMLElement>('.memory-integrity-result');
    button.disabled = true;
    if (resultNode) resultNode.textContent = '正在执行 SQLite 完整性检查…';
    void controller.checkSqliteIntegrity()
      .then((result) => {
        if (resultNode) {
          resultNode.textContent = `${result.ok ? '通过' : '失败'}：${result.message}`;
          resultNode.classList.toggle('stx-memory-warning', !result.ok);
        }
      })
      .catch((error: unknown) => {
        if (resultNode) {
          resultNode.textContent = `检查失败：${error instanceof Error ? error.message : String(error)}`;
          resultNode.classList.add('stx-memory-warning');
        }
      })
      .finally(() => { button.disabled = false; });
  });
  dialog.querySelector('.memory-clear')?.addEventListener('click', () => {
    if (window.confirm('只清空当前聊天产生的记忆来源？其他聊天仍有证据支持的事实会保留。此操作无法撤销。')) {
      void controller.clearCurrentChatData().then(refresh);
    }
  });
  dialog.querySelector('.memory-clear-all')?.addEventListener('click', () => {
    if (window.confirm('清空 Memory 插件的全部角色卡和群组记忆？全局设置会保留，此操作无法撤销。')) {
      void controller.clearAllMemoryData().then(refresh);
    }
  });
  if (dialog instanceof HTMLDialogElement) {
    installDialogKeyboard(dialog, returnFocus);
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    dialog.showModal();
  }
  dialog.querySelector<HTMLInputElement>('.memory-search')?.focus();
}

/** Render the personalized workbench inside the Core-owned popup surface. */
export function renderMemoryWorkbench(container: HTMLElement, controller: MemoryUiController): () => void {
  container.replaceChildren();
  let disposed = false;
  void openWorkbench(controller, container).then(() => {
    if (disposed) container.replaceChildren();
  });
  return () => {
    disposed = true;
    container.replaceChildren();
  };
}
