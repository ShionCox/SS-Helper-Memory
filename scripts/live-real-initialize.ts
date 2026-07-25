import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  WorkspaceBackupExportRequest,
  WorkspaceBackupImportRequest,
  WorkspaceClearOwnedRequest,
  WorkspaceCollectionRequest,
  WorkspaceGrantRequest,
  WorkspaceHealth,
  WorkspaceInfo,
  WorkspaceIntegrity,
  WorkspaceListPage,
  WorkspaceListRequest,
  WorkspaceOpenRequest,
  WorkspaceOwnerBackupImportRequest,
  WorkspacePort,
  WorkspaceQueryPage,
  WorkspaceQueryRequest,
  WorkspaceRecord,
  WorkspaceRecordRequest,
  WorkspaceRemoveRequest,
  WorkspaceTransactionRequest,
  WorkspaceTransactionResult,
  WorkspaceVectorClearRequest,
  WorkspaceVectorListRequest,
  WorkspaceVectorPage,
  WorkspaceVectorRequest,
  WorkspaceVectorSearchHit,
  WorkspaceVectorSearchRequest,
} from '@ss-helper/sdk';
import { MemoryApplication } from '../src/application/memory-application';
import { normalizeActorName, normalizeLocationName } from '../src/domain';
import {
  configureMemoryLlmApi,
  type MemoryEmbedResult,
  type MemoryLlmApi,
  type MemoryRerankResult,
} from '../src/application/ingest/llm-extractor';
import { buildVisibleChatSourceBlocks } from '../src/host/source-adapter';
import { MemoryRepository } from '../src/infrastructure/memory-repository';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MONOREPO_ROOT = path.resolve(PROJECT_ROOT, '..');
const ST_ROOT = process.env.SS_HELPER_ST_ROOT?.trim() || 'I:\\SillyTavern';
const LIVE_DATA_DIR = path.join(ST_ROOT, 'data', '_ss-helper-v0');
const LIVE_DB = path.join(LIVE_DATA_DIR, 'ss-helper.sqlite3');
const BACKUP_ROOT = path.join(ST_ROOT, 'backups');
const DATASET_FILE = path.join(PROJECT_ROOT, 'test', '酒馆聊天数据.jsonl');
const ENV_FILE = path.join(PROJECT_ROOT, 'test', '.env');
const RUN_ID = (process.env.LIVE_INIT_RUN_ID?.trim() || 'live-real-initialize').replace(/[^A-Za-z0-9._-]+/gu, '-');
const STATE_FILE = path.join(PROJECT_ROOT, 'test-results', `${RUN_ID}-state.json`);
const REPORT_FILE = path.join(PROJECT_ROOT, 'test-results', `${RUN_ID}-report.json`);
const WORKSPACE_ID = 'character:default_Assistant.png';
const CHAT_KEY = 'Assistant - 2026-04-22@14h39m17s376ms imported';
const SETTINGS_WORKSPACE_ID = 'settings:global';
const RUN_WINDOW_MS = Math.max(60_000, Number(process.env.LIVE_INIT_WINDOW_MS ?? 300_000));
const GENERATION_TIMEOUT_MS = Math.max(60_000, Number(process.env.LIVE_GENERATION_TIMEOUT_MS ?? 180_000));
const CAPTURE_LEXICAL_ONLY = process.env.LIVE_CAPTURE_LEXICAL_ONLY === '1';

type JsonRecord = Record<string, unknown>;

interface LiveConfiguration {
  generation: { apiKey: string; baseUrl: string; model: string };
  embedding: { apiKey: string; baseUrl: string; model: string };
  rerank: { apiKey: string; url: string; model: string };
}

async function repairUnresolvedRejections(
  state: PersistentState,
  workspace: WorkspacePort,
  config: LiveConfiguration,
): Promise<void> {
  const metrics = newMetrics();
  const { application } = await createApplication(workspace, createLiveLlmApi(config, metrics));
  try {
    const initialization = await application.getInitializationState();
    if (!initialization.initialized) throw new Error('初始化尚未完成，不能执行失败项定向修复。');
    const currentSettings = application.getSettings();
    await application.saveSettings({
      ...currentSettings,
      autoOrganize: false,
      preExtractReferenceEnabled: false,
      graphEnabled: false,
      graphLlmRelationEnabled: false,
    });
    const audits = await application.listAuditRecords();
    const targets = audits.flatMap((audit) => {
      if (audit.type !== 'actor-capture') return [];
      const rejected = Array.isArray(audit.rejected)
        ? audit.rejected.filter((value): value is { id?: string; status?: string } => Boolean(value && typeof value === 'object'))
        : [];
      const ids = rejected
        .filter(rejection => (rejection.status ?? 'unresolved') === 'unresolved' && Boolean(rejection.id))
        .map(rejection => rejection.id!);
      const auditId = String(audit.id ?? '');
      return auditId && ids.length > 0 ? [{ auditId, rejectionIds: ids }] : [];
    });
    event('rejection-repair-start', { auditCount: targets.length, rejectionCount: targets.reduce((sum, item) => sum + item.rejectionIds.length, 0) });
    for (const target of targets) {
      await application.repairCaptureRejections(target.auditId, target.rejectionIds);
      event('rejection-repair-audit-complete', { auditId: target.auditId, rejectionCount: target.rejectionIds.length });
    }
    addMetrics(state, metrics);
    state.phase = targets.length > 0 ? 'rejections-repaired' : state.phase;
    state.rejectionRepair = {
      completedAt: new Date().toISOString(),
      auditCount: targets.length,
      rejectionCount: targets.reduce((sum, item) => sum + item.rejectionIds.length, 0),
      api: metrics,
    };
    await saveState(state);
    event('rejection-repair-complete', { targets, apiTotals: state.apiTotals });
  } finally {
    application.stop();
    configureMemoryLlmApi(null);
  }
}

interface PersistentState extends JsonRecord {
  version: 1;
  phase: string;
  workspaceId: string;
  chatKey: string;
  backupDirectory?: string;
  originalSettings?: JsonRecord;
  apiTotals?: {
    generationCalls: number;
    generationFailures: number;
    embeddingCalls: number;
    embeddingFailures: number;
    rerankCalls: number;
    rerankFailures: number;
  };
  attempts?: JsonRecord[];
  updatedAt: string;
}

interface ApiMetrics {
  generationCalls: number;
  generationFailures: number;
  embeddingCalls: number;
  embeddingFailures: number;
  rerankCalls: number;
  rerankFailures: number;
  requests: JsonRecord[];
}

function event(name: string, details: JsonRecord = {}): void {
  console.log(`LIVE_REAL_INIT_EVENT=${JSON.stringify({ at: new Date().toISOString(), name, ...details })}`);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}

async function loadConfiguration(): Promise<LiveConfiguration> {
  const values: Record<string, string> = {};
  for (const rawLine of (await readFile(ENV_FILE, 'utf8')).split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    values[line.slice(0, separator).trim()] = unquote(line.slice(separator + 1));
  }
  const required = [
    'test_api_key', 'test_api_url', 'test_models_name',
    'embedding_api_key', 'embedding_url', 'embedding_models_name',
    'rerank_api_key', 'rerank_url', 'rerank_models_name',
  ];
  const missing = required.filter(key => !values[key]?.trim());
  if (missing.length > 0) throw new Error(`test/.env 缺少配置：${missing.join('、')}`);
  return {
    generation: {
      apiKey: values.test_api_key!,
      baseUrl: values.test_api_url!.replace(/\/+$/u, ''),
      model: values.test_models_name!,
    },
    embedding: {
      apiKey: values.embedding_api_key!,
      baseUrl: values.embedding_url!.replace(/\/+$/u, ''),
      model: values.embedding_models_name!,
    },
    rerank: {
      apiKey: values.rerank_api_key!,
      url: values.rerank_url!,
      model: values.rerank_models_name!,
    },
  };
}

function completionEndpoint(baseUrl: string): string {
  return /\/chat\/completions$/u.test(baseUrl) ? baseUrl : `${baseUrl}/chat/completions`;
}

function embeddingEndpoint(baseUrl: string): string {
  return /\/embeddings$/u.test(baseUrl) ? baseUrl : `${baseUrl}/embeddings`;
}

function parseJsonObject(content: string): unknown {
  const text = content.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1]?.trim();
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  for (const candidate of [text, fenced, firstBrace >= 0 && lastBrace > firstBrace ? text.slice(firstBrace, lastBrace + 1) : undefined]) {
    if (!candidate) continue;
    try { return JSON.parse(candidate); } catch { /* try next representation */ }
  }
  throw new Error('模型返回内容无法解析为 JSON 对象。');
}

function createLiveLlmApi(config: LiveConfiguration, metrics: ApiMetrics): MemoryLlmApi {
  let apiTail: Promise<void> = Promise.resolve();
  const withApiPermit = async <T>(operation: () => Promise<T>): Promise<T> => {
    let release!: () => void;
    const previous = apiTail;
    apiTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  };
  return {
    inspect: {
      previewRoute(input) {
        if (input.taskKind === 'embedding') return { available: true, resourceId: 'test-env-embedding', model: config.embedding.model };
        if (input.taskKind === 'rerank') return { available: true, resourceId: 'test-env-rerank', model: config.rerank.model };
        return { available: true, resourceId: 'test-env-generation', model: config.generation.model };
      },
    },
    async runTask<T>(input: Parameters<MemoryLlmApi['runTask']>[0]) {
      metrics.generationCalls += 1;
      const call = metrics.generationCalls;
      const startedAt = performance.now();
      const inputChars = input.input.messages.reduce((sum, message) => sum + message.content.length, 0);
      event('generation-start', { call, taskKey: input.taskKey, inputChars });
      try {
        const messages = input.input.messages.map((message, index) => index === 0 && message.role === 'system'
          ? {
              ...message,
              content: [
                message.content,
                '你必须严格遵守下面的 JSON Schema。所有 required 字段都必须输出，additionalProperties=false 的对象禁止新增字段。',
                JSON.stringify(input.schema),
              ].join('\n\n'),
            }
          : message);
        const { response, raw } = await withApiPermit(async () => {
          const response = await fetch(completionEndpoint(config.generation.baseUrl), {
            method: 'POST',
            signal: AbortSignal.timeout(Math.min(GENERATION_TIMEOUT_MS, input.budget.maxLatencyMs ?? GENERATION_TIMEOUT_MS)),
            headers: { 'content-type': 'application/json', authorization: `Bearer ${config.generation.apiKey}` },
            body: JSON.stringify({
              model: config.generation.model,
              messages,
              temperature: 0,
              max_tokens: input.budget.maxTokens,
              stream: false,
              thinking: { type: 'disabled' },
              response_format: { type: 'json_object' },
            }),
          });
          return { response, raw: await response.text() };
        });
        if (!response.ok) throw Object.assign(new Error(`模型接口返回 HTTP ${response.status}`), { code: `HTTP_${response.status}` });
        const payload = JSON.parse(raw) as {
          id?: string;
          model?: string;
          choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        };
        const content = payload.choices?.[0]?.message?.content ?? '';
        const latencyMs = Number((performance.now() - startedAt).toFixed(1));
        const request = {
          kind: 'generation', call, taskKey: input.taskKey, inputChars, latencyMs,
          finishReason: payload.choices?.[0]?.finish_reason ?? null,
          model: payload.model ?? config.generation.model,
          promptTokens: payload.usage?.prompt_tokens ?? null,
          completionTokens: payload.usage?.completion_tokens ?? null,
          totalTokens: payload.usage?.total_tokens ?? null,
        };
        metrics.requests.push(request);
        event('generation-complete', request);
        return {
          ok: true as const,
          data: parseJsonObject(content) as T,
          meta: {
            requestId: payload.id,
            resourceId: 'test-env-generation',
            model: payload.model ?? config.generation.model,
            latencyMs,
          },
          usage: payload.usage ? {
            promptTokens: payload.usage.prompt_tokens ?? 0,
            completionTokens: payload.usage.completion_tokens ?? 0,
            totalTokens: payload.usage.total_tokens ?? 0,
          } : undefined,
        };
      } catch (error) {
        metrics.generationFailures += 1;
        const latencyMs = Number((performance.now() - startedAt).toFixed(1));
        const message = error instanceof Error ? error.message : String(error);
        const reasonCode = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code ?? '') : undefined;
        metrics.requests.push({ kind: 'generation', call, taskKey: input.taskKey, inputChars, latencyMs, error: message, reasonCode });
        event('generation-failed', { call, taskKey: input.taskKey, inputChars, latencyMs, error: message, reasonCode });
        return { ok: false as const, error: message, ...(reasonCode ? { reasonCode } : {}) };
      }
    },
    async embed(input): Promise<MemoryEmbedResult> {
      metrics.embeddingCalls += 1;
      const call = metrics.embeddingCalls;
      const startedAt = performance.now();
      event('embedding-start', { call, texts: input.texts.length });
      try {
        const { response, payload } = await withApiPermit(async () => {
          const response = await fetch(embeddingEndpoint(config.embedding.baseUrl), {
            method: 'POST',
            // Honour the actual Memory request budget so a timed-out request is
            // aborted and releases the shared API permit instead of blocking
            // every following embedding/rerank operation in the test run.
            signal: AbortSignal.timeout(Math.max(3_000, input.budget?.maxLatencyMs ?? 3_000)),
            headers: { 'content-type': 'application/json', authorization: `Bearer ${config.embedding.apiKey}` },
            body: JSON.stringify({ model: config.embedding.model, input: input.texts }),
          });
          return { response, payload: await response.json() };
        });
        const typedPayload = payload as {
          model?: string;
          data?: Array<{ embedding?: number[] }>;
          usage?: { prompt_tokens?: number; total_tokens?: number };
          error?: { message?: string };
        };
        if (!response.ok) throw Object.assign(new Error(typedPayload.error?.message || `Embedding 接口返回 HTTP ${response.status}`), { code: `HTTP_${response.status}` });
        const vectors = (typedPayload.data ?? []).map(item => item.embedding).filter((value): value is number[] => Array.isArray(value));
        if (vectors.length !== input.texts.length) throw new Error(`Embedding 数量不匹配：期望 ${input.texts.length}，实际 ${vectors.length}`);
        const latencyMs = Number((performance.now() - startedAt).toFixed(1));
        const request = { kind: 'embedding', call, texts: input.texts.length, dimensions: [...new Set(vectors.map(vector => vector.length))], latencyMs, model: typedPayload.model ?? config.embedding.model };
        metrics.requests.push(request);
        event('embedding-complete', request);
        return {
          ok: true,
          vectors,
          model: typedPayload.model ?? config.embedding.model,
          meta: { resourceId: 'test-env-embedding', model: typedPayload.model ?? config.embedding.model, latencyMs },
          usage: typedPayload.usage ? {
            promptTokens: typedPayload.usage.prompt_tokens ?? 0,
            completionTokens: 0,
            totalTokens: typedPayload.usage.total_tokens ?? typedPayload.usage.prompt_tokens ?? 0,
          } : undefined,
        };
      } catch (error) {
        metrics.embeddingFailures += 1;
        const latencyMs = Number((performance.now() - startedAt).toFixed(1));
        const message = error instanceof Error ? error.message : String(error);
        metrics.requests.push({ kind: 'embedding', call, texts: input.texts.length, latencyMs, error: message });
        event('embedding-failed', { call, texts: input.texts.length, latencyMs, error: message });
        return { ok: false, error: message, reasonCode: 'EMBEDDING_REQUEST_FAILED' };
      }
    },
    async rerank(input): Promise<MemoryRerankResult> {
      metrics.rerankCalls += 1;
      const call = metrics.rerankCalls;
      const startedAt = performance.now();
      event('rerank-start', { call, documents: input.docs.length, topK: input.topK ?? input.docs.length });
      try {
        const { response, payload } = await withApiPermit(async () => {
          const response = await fetch(config.rerank.url, {
            method: 'POST',
            signal: AbortSignal.timeout(Math.max(1_000, input.budget?.maxLatencyMs ?? 15_000)),
            headers: { 'content-type': 'application/json', authorization: `Bearer ${config.rerank.apiKey}` },
            body: JSON.stringify({
              model: config.rerank.model,
              query: input.query,
              documents: input.docs,
              top_n: input.topK ?? input.docs.length,
              return_documents: false,
            }),
          });
          return { response, payload: await response.json() };
        });
        const typedPayload = payload as {
          model?: string;
          results?: Array<{ index?: number; document_index?: number; relevance_score?: number; score?: number }>;
          data?: Array<{ index?: number; document_index?: number; relevance_score?: number; score?: number }>;
          error?: { message?: string };
        };
        if (!response.ok) throw Object.assign(new Error(typedPayload.error?.message || `Rerank 接口返回 HTTP ${response.status}`), { code: `HTTP_${response.status}` });
        const rows = Array.isArray(typedPayload.results) ? typedPayload.results : Array.isArray(typedPayload.data) ? typedPayload.data : [];
        const results = rows.map((item) => ({
          index: Number(item.index ?? item.document_index),
          score: Number(item.relevance_score ?? item.score),
          doc: input.docs[Number(item.index ?? item.document_index)],
        })).filter(item => Number.isInteger(item.index) && item.index >= 0 && item.index < input.docs.length && Number.isFinite(item.score));
        if (results.length === 0) throw new Error('Rerank 返回为空或格式异常。');
        const latencyMs = Number((performance.now() - startedAt).toFixed(1));
        const request = { kind: 'rerank', call, documents: input.docs.length, results: results.length, latencyMs, model: typedPayload.model ?? config.rerank.model, topIndex: results[0]?.index, topScore: results[0]?.score };
        metrics.requests.push(request);
        event('rerank-complete', request);
        return {
          ok: true,
          results,
          resource: 'test-env-rerank',
          meta: { resourceId: 'test-env-rerank', model: typedPayload.model ?? config.rerank.model, latencyMs },
        };
      } catch (error) {
        metrics.rerankFailures += 1;
        const latencyMs = Number((performance.now() - startedAt).toFixed(1));
        const message = error instanceof Error ? error.message : String(error);
        metrics.requests.push({ kind: 'rerank', call, documents: input.docs.length, latencyMs, error: message });
        event('rerank-failed', { call, documents: input.docs.length, latencyMs, error: message });
        return { ok: false, error: message, reasonCode: 'RERANK_REQUEST_FAILED' };
      }
    },
  };
}

function bridgeError(body: unknown, statusCode: number): Error & { code?: string; bridgeDetails?: JsonRecord } {
  const payload = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const rawError = payload.error;
  const details = rawError && typeof rawError === 'object' ? rawError as Record<string, unknown> : {};
  const code = String(details.code ?? payload.code ?? (typeof rawError === 'string' ? rawError : undefined) ?? `HTTP_${statusCode}`);
  const message = String(details.message ?? payload.message ?? rawError ?? code);
  const bridgeDetails = Object.fromEntries(Object.entries({ ...payload, ...details })
    .filter(([key, value]) => !['ok', 'data', 'error', 'stack'].includes(key)
      && (value === null || ['string', 'number', 'boolean'].includes(typeof value))));
  return Object.assign(new Error(message), { code, bridgeDetails });
}

async function createLiveWorkspacePort(): Promise<{ workspace: WorkspacePort; close(): void }> {
  process.env.SS_HELPER_ST_ROOT = ST_ROOT;
  let bridgeHandler: ((req: unknown, res: unknown) => unknown) | undefined;
  const router = {
    get() { return router; },
    use() { return router; },
    post(route: string, handler: (req: unknown, res: unknown) => unknown) {
      if (route === '/internal/bridge/v0/call') bridgeHandler = handler;
      return router;
    },
  };
  const sdkModule = await import(pathToFileURL(path.join(MONOREPO_ROOT, 'SS-Helper-SDK', 'server-plugin', 'index.js')).href);
  await sdkModule.init(router);
  if (!bridgeHandler) throw new Error('未能注册 SS-Helper SDK bridge 路由。');

  const call = <T>(operation: string, input: JsonRecord = {}): Promise<T> => new Promise<T>((resolve, reject) => {
    let settled = false;
    let statusCode = 200;
    const finish = (body: unknown): void => {
      if (settled) return;
      settled = true;
      const payload = body && typeof body === 'object' ? body as Record<string, unknown> : {};
      if (statusCode >= 400 || payload.ok === false) {
        const error = bridgeError(body, statusCode);
        const collection = typeof input.collection === 'string' ? input.collection : undefined;
        const recordId = typeof input.recordId === 'string' ? input.recordId : undefined;
        event('workspace-call-failed', {
          operation,
          statusCode,
          code: error.code,
          error: error.message,
          ...(collection ? { collection } : {}),
          ...(recordId ? { recordId } : {}),
          ...(error.bridgeDetails && Object.keys(error.bridgeDetails).length > 0 ? { details: error.bridgeDetails } : {}),
        });
        reject(error);
      }
      else resolve(payload.data as T);
    };
    const response = {
      status(code: number) { statusCode = code; return response; },
      json(body: unknown) { finish(body); return response; },
      end() { finish({ ok: statusCode < 400, data: null }); return response; },
      sendFile() { return response; },
    };
    try {
      const returned = bridgeHandler!({ body: { version: 0, pluginId: 'ss-helper.memory', operation, input } }, response);
      void Promise.resolve(returned).catch(reject);
    } catch (error) {
      reject(error);
    }
  });

  const workspace = {
    health: () => call<WorkspaceHealth>('workspace.health'),
    integrity: () => call<WorkspaceIntegrity>('workspace.integrity'),
    open: (input: WorkspaceOpenRequest) => call<WorkspaceInfo>('workspace.open', input as unknown as JsonRecord),
    list: (input: WorkspaceListRequest = {}) => call<WorkspaceListPage>('workspace.list', input as unknown as JsonRecord),
    removeWorkspace: (input: WorkspaceRemoveRequest) => call<void>('workspace.remove', input as unknown as JsonRecord),
    clearOwned: (input: WorkspaceClearOwnedRequest = {}) => call<number>('workspace.clearOwned', input as unknown as JsonRecord),
    defineCollection: (input: WorkspaceCollectionRequest) => call<void>('workspace.defineCollection', input as unknown as JsonRecord),
    get: (input: WorkspaceRecordRequest) => call<WorkspaceRecord | null>('workspace.get', input as unknown as JsonRecord),
    upsert: (input: WorkspaceRecordRequest) => call<WorkspaceRecord>('workspace.upsert', input as unknown as JsonRecord),
    delete: (input: Omit<WorkspaceRecordRequest, 'value'>) => call<boolean>('workspace.delete', input as unknown as JsonRecord),
    query: (input: WorkspaceQueryRequest) => call<WorkspaceQueryPage>('workspace.query', input as unknown as JsonRecord),
    transaction: async (input: WorkspaceTransactionRequest) => {
      const collections = [...new Set(input.operations.map(operation => operation.collection))];
      const payloadBytes = Buffer.byteLength(JSON.stringify(input), 'utf8');
      const operationKeys = input.operations.map(operation => `${operation.collection}\0${operation.recordId}`);
      const duplicateOperationKeys = [...new Set(operationKeys.filter((key, index) => operationKeys.indexOf(key) !== index))];
      const diagnostic = {
        idempotencyKey: input.idempotencyKey,
        operationCount: input.operations.length,
        payloadBytes,
        collections,
        duplicateOperationCount: duplicateOperationKeys.length,
        ...(duplicateOperationKeys.length > 0 ? { duplicateOperations: duplicateOperationKeys.slice(0, 8) } : {}),
      };
      event('workspace-transaction-start', diagnostic);
      try {
        const result = await call<WorkspaceTransactionResult>('workspace.transaction', input as unknown as JsonRecord);
        event('workspace-transaction-complete', { ...diagnostic, replayed: result.replayed });
        return result;
      } catch (error) {
        event('workspace-transaction-failed', {
          ...diagnostic,
          code: error && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code ?? '')
            : undefined,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    vectorUpsert: (input: WorkspaceVectorRequest) => call<void>('workspace.vectorUpsert', input as unknown as JsonRecord),
    vectorSearch: (input: WorkspaceVectorSearchRequest) => call<readonly WorkspaceVectorSearchHit[]>('workspace.vectorSearch', input as unknown as JsonRecord),
    vectorDelete: (input: Omit<WorkspaceVectorRequest, 'vector' | 'model' | 'metadata'>) => call<boolean>('workspace.vectorDelete', input as unknown as JsonRecord),
    vectorList: (input: WorkspaceVectorListRequest) => call<WorkspaceVectorPage>('workspace.vectorList', input as unknown as JsonRecord),
    vectorClear: (input: WorkspaceVectorClearRequest) => call<number>('workspace.vectorClear', input as unknown as JsonRecord),
    grant: (input: WorkspaceGrantRequest) => call<void>('workspace.grant', input as unknown as JsonRecord),
    revoke: (input: WorkspaceGrantRequest) => call<void>('workspace.revoke', input as unknown as JsonRecord),
    export: (input: WorkspaceBackupExportRequest) => call<never>('workspace.export', input as unknown as JsonRecord),
    import: (input: WorkspaceBackupImportRequest) => call<void>('workspace.import', input as unknown as JsonRecord),
    exportAll: () => call<never>('workspace.exportAll'),
    importAll: (input: WorkspaceOwnerBackupImportRequest) => call<void>('workspace.importAll', input as unknown as JsonRecord),
    repair: (input: { confirm: true }) => call<never>('workspace.repair', input),
  } satisfies WorkspacePort;
  return { workspace, close: () => sdkModule.exit() };
}

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

function backupTimestamp(): string {
  return new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z').replace('T', '-');
}

async function createBackup(): Promise<{ directory: string; files: JsonRecord[] }> {
  if (!await exists(LIVE_DB)) throw new Error(`找不到实时数据库：${LIVE_DB}`);
  const directory = path.join(BACKUP_ROOT, `${RUN_ID}-backup-${backupTimestamp()}`);
  await mkdir(directory, { recursive: true });
  const names = ['ss-helper.sqlite3', 'ss-helper.sqlite3-wal', 'ss-helper.sqlite3-shm', 'ss-helper-secrets.key'];
  const files: JsonRecord[] = [];
  for (const name of names) {
    const source = path.join(LIVE_DATA_DIR, name);
    if (!await exists(source)) continue;
    const target = path.join(directory, name);
    await copyFile(source, target);
    const info = await stat(target);
    files.push({ name, bytes: info.size, sha256: await sha256(target) });
  }
  const manifest = { format: 'ss-helper-live-memory-backup', version: 1, createdAt: new Date().toISOString(), source: LIVE_DATA_DIR, files };
  await writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { directory, files };
}

async function loadState(): Promise<PersistentState | null> {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')) as PersistentState; } catch { return null; }
}

async function saveState(state: PersistentState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await mkdir(path.dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function newMetrics(): ApiMetrics {
  return { generationCalls: 0, generationFailures: 0, embeddingCalls: 0, embeddingFailures: 0, rerankCalls: 0, rerankFailures: 0, requests: [] };
}

function addMetrics(state: PersistentState, metrics: ApiMetrics): void {
  const previous = state.apiTotals ?? {
    generationCalls: 0, generationFailures: 0, embeddingCalls: 0,
    embeddingFailures: 0, rerankCalls: 0, rerankFailures: 0,
  };
  state.apiTotals = {
    generationCalls: previous.generationCalls + metrics.generationCalls,
    generationFailures: previous.generationFailures + metrics.generationFailures,
    embeddingCalls: previous.embeddingCalls + metrics.embeddingCalls,
    embeddingFailures: previous.embeddingFailures + metrics.embeddingFailures,
    rerankCalls: previous.rerankCalls + metrics.rerankCalls,
    rerankFailures: previous.rerankFailures + metrics.rerankFailures,
  };
}

async function readDatasetSources() {
  const rows = (await readFile(DATASET_FILE, 'utf8'))
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(line => JSON.parse(line) as JsonRecord)
    .filter(row => typeof row.mes === 'string');
  return { rows, sources: buildVisibleChatSourceBlocks(CHAT_KEY, rows) };
}

async function prepareFreshRun(workspace: WorkspacePort): Promise<PersistentState> {
  await rm(STATE_FILE, { force: true });
  await rm(REPORT_FILE, { force: true });
  event('backup-start', { database: LIVE_DB });
  const backup = await createBackup();
  event('backup-complete', { directory: backup.directory, files: backup.files.map(file => file.name) });
  const state: PersistentState = {
    version: 1,
    phase: 'backed-up',
    workspaceId: WORKSPACE_ID,
    chatKey: CHAT_KEY,
    backupDirectory: backup.directory,
    apiTotals: {
      generationCalls: 0, generationFailures: 0, embeddingCalls: 0,
      embeddingFailures: 0, rerankCalls: 0, rerankFailures: 0,
    },
    attempts: [],
    updatedAt: new Date().toISOString(),
  };
  await saveState(state);
  const removed = await workspace.clearOwned({
    preserveWorkspaceIds: [SETTINGS_WORKSPACE_ID],
    idempotencyKey: `live-reinit-clear:${Date.now()}`,
  });
  const repository = new MemoryRepository(workspace);
  repository.bind(WORKSPACE_ID, CHAT_KEY);
  await repository.open();
  await repository.setSettings({ summaryProgressByChat: {} });
  repository.close();
  const integrity = await workspace.integrity();
  state.phase = 'prepared';
  state.clearResult = { removedWorkspaces: removed, integrity };
  await saveState(state);
  event('database-cleared', { removedWorkspaces: removed, integrityOk: integrity.ok });
  return state;
}

async function createApplication(workspace: WorkspacePort, llm: MemoryLlmApi) {
  configureMemoryLlmApi(llm);
  const { rows, sources } = await readDatasetSources();
  const repository = new MemoryRepository(workspace);
  repository.bind(WORKSPACE_ID, CHAT_KEY);
  // The full validation phase rebuilds every vector and executes real hybrid
  // recall. During a long 24-batch extraction run, background vector/graph
  // maintenance only competes with the generation provider and can make the
  // test take several extra time windows. Persist a lightweight capture mode
  // before application.start(), so no startup background sync is launched.
  if (CAPTURE_LEXICAL_ONLY) {
    await repository.open();
    await repository.setSettings({
      recallMode: 'lexical',
      rerankMode: 'off',
      preExtractReferenceMode: 'lexical',
      graphEnabled: false,
    });
    repository.close();
  }
  const application = new MemoryApplication(repository);
  application.useHostContext({
    getChatKey: () => CHAT_KEY,
    getWorkspaceId: () => WORKSPACE_ID,
    getChatName: () => CHAT_KEY,
    collectSources: async (chatKey) => chatKey === CHAT_KEY ? sources.map(source => structuredClone(source)) : [],
    getRecallContext: async () => ({ characterKeys: ['default_Assistant.png', '小時'], worldKeys: [] }),
    getHostContainerContext: async () => ({ hostCardId: 'default_Assistant.png', hostCardName: '小時', worldKeys: [] }),
  });
  application.bindStorageScope(WORKSPACE_ID, CHAT_KEY);
  await application.start();
  return { application, repository, rows, sources };
}

async function runCaptureChunk(state: PersistentState, workspace: WorkspacePort, config: LiveConfiguration): Promise<PersistentState> {
  const metrics = newMetrics();
  const { application, sources } = await createApplication(workspace, createLiveLlmApi(config, metrics));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancellationRequested = false;
  let runError: string | undefined;
  let runErrorCode: string | undefined;
  let runErrorDiagnostic: JsonRecord | undefined;
  try {
    const overview = await application.getOverview();
    if (overview.status === 'error') throw new Error(`Memory 启动失败：${overview.errorCode ?? ''} ${overview.error ?? ''}`.trim());
    const existingSettings = application.getSettings();
    if (!state.originalSettings) state.originalSettings = structuredClone(existingSettings) as unknown as JsonRecord;
    await application.saveSettings({
      ...existingSettings,
      enabled: true,
      autoOrganize: true,
      // 使用产品默认安全窗口；MemoryApplication 内部的 for/await 保证严格串行。
      summaryBatchMode: 'floors',
      summaryBatchFloors: 5,
      summaryOverlapFloors: 2,
      preExtractReferenceEnabled: true,
      preExtractReferenceMode: CAPTURE_LEXICAL_ONLY ? 'lexical' : 'auto',
      recallMode: CAPTURE_LEXICAL_ONLY ? 'lexical' : 'auto',
      rerankMode: CAPTURE_LEXICAL_ONLY ? 'off' : 'adaptive',
      graphEnabled: CAPTURE_LEXICAL_ONLY ? false : true,
      graphLlmRelationEnabled: true,
    });
    const estimate = await application.getInitializationEstimate(['message']);
    const beforeProgress = await application.getCaptureProgress();
    const beforeState = await application.getInitializationState();
    event('capture-chunk-start', {
      phase: state.phase,
      messages: sources.filter(source => source.kind === 'message').length,
      estimate,
      beforeProgress,
      initialized: beforeState.initialized,
      runWindowMs: RUN_WINDOW_MS,
    });
    if (!beforeState.initialized) {
      timer = setTimeout(() => {
        cancellationRequested = true;
        event('capture-timebox-reached', { runWindowMs: RUN_WINDOW_MS });
        void application.cancelCapture();
      }, RUN_WINDOW_MS);
      try {
        if (beforeProgress?.status === 'paused' || beforeProgress?.status === 'running') await application.retry();
        else await application.initialize(['message']);
      } catch (error) {
        runError = error instanceof Error ? error.message : String(error);
        runErrorCode = error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code ?? '') || undefined
          : undefined;
        const failedOverview = await application.getOverview().catch(() => undefined);
        runErrorDiagnostic = failedOverview?.errorDiagnostic
          ? structuredClone(failedOverview.errorDiagnostic) as unknown as JsonRecord
          : undefined;
        event('capture-run-error', {
          runError,
          runErrorCode,
          runErrorDiagnostic,
          cause: error && typeof error === 'object' && 'cause' in error
            ? String((error as { cause?: unknown }).cause ?? '')
            : undefined,
        });
      }
    }
    if (timer) clearTimeout(timer);
    const afterProgress = await application.getCaptureProgress();
    const afterState = await application.getInitializationState();
    const attempt = {
      startedAt: new Date(Date.now() - metrics.requests.reduce((sum, request) => sum + Number(request.latencyMs ?? 0), 0)).toISOString(),
      completedAt: new Date().toISOString(),
      cancellationRequested,
      runError,
      runErrorCode,
      runErrorDiagnostic,
      beforeProgress,
      afterProgress,
      initialized: afterState.initialized,
      api: metrics,
    };
    state.attempts = [...(state.attempts ?? []), attempt];
    addMetrics(state, metrics);
    if (afterState.initialized || afterProgress?.status === 'completed') state.phase = 'capture-completed';
    else if (afterProgress?.status === 'paused' || cancellationRequested) state.phase = 'capture-paused';
    else if (afterProgress?.status === 'failed') state.phase = 'capture-failed';
    else state.phase = 'capture-incomplete';
    await saveState(state);
    event('capture-chunk-complete', {
      phase: state.phase,
      afterProgress,
      initialized: afterState.initialized,
      runError,
      runErrorCode,
      runErrorDiagnostic,
      apiTotals: state.apiTotals,
    });
  } finally {
    if (timer) clearTimeout(timer);
    application.stop();
    configureMemoryLlmApi(null);
  }
  return state;
}

async function listAllVectors(workspace: WorkspacePort): Promise<WorkspaceVectorPage['vectors']> {
  const vectors: WorkspaceVectorPage['vectors'][number][] = [];
  let cursor: string | undefined;
  do {
    const page = await workspace.vectorList({ workspaceId: WORKSPACE_ID, collection: 'facts', ...(cursor ? { cursor } : {}), limit: 500 });
    vectors.push(...page.vectors);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return vectors;
}

async function validateCompletedRun(state: PersistentState, workspace: WorkspacePort, config: LiveConfiguration): Promise<void> {
  const metrics = newMetrics();
  const { application, sources } = await createApplication(workspace, createLiveLlmApi(config, metrics));
  try {
    const initialization = await application.getInitializationState();
    if (!initialization.initialized) throw new Error('初始化尚未完成，不能执行最终向量与重排序验证。');
    const original = state.originalSettings ?? {};
    const currentSettings = application.getSettings();
    // Validation must not compete with background capture, graph extraction or
    // pre-extraction references for the same remote API mutex.
    await application.saveSettings({
      ...currentSettings,
      autoOrganize: false,
      preExtractReferenceEnabled: false,
      graphEnabled: false,
      graphLlmRelationEnabled: false,
      recallMode: 'hybrid',
      rerankMode: 'always',
    });
    event('vector-rebuild-start', {});
    await application.rebuildVectorIndex();
    event('vector-rebuild-complete', {});

    const facts = await application.facts.list({});
    const episodes = await application.listEpisodes();
    const observations = await application.listObservations();
    const traces = await application.listActorTraces();
    const actors = await application.listActors();
    const pendingActors = await application.listPendingActorCandidates();
    const locations = await application.listLocations();
    const pendingLocations = await application.listPendingLocationCandidates();
    const audits = await application.listAuditRecords();
    const captureProgress = await application.getCaptureProgress();
    const factIds = new Set(facts.map(fact => fact.id));
    const episodeIds = new Set(episodes.map(episode => episode.id));
    const orphanTraces = traces.filter(trace => !factIds.has(trace.factId));
    const orphanObservations = observations.filter(observation => !episodeIds.has(observation.episodeId));
    const activeAudits = audits.filter(record => !record.rolledBackAt);
    const activeCaptureAudits = activeAudits.filter(record => String(record.type ?? record.kind ?? '') === 'actor-capture'
      || String(record.kind ?? '') === 'capture-change-set-v0');
    const rolledBackCaptureAudits = audits.filter(record => record.rolledBackAt
      && (String(record.type ?? record.kind ?? '') === 'actor-capture' || String(record.kind ?? '') === 'capture-change-set-v0'));
    const durableSourceRefs = new Set(activeCaptureAudits.flatMap(record => Array.isArray(record.sourceRefs) ? record.sourceRefs.map(String) : []));
    const expectedMessageSourceRefs = sources.filter(source => source.kind === 'message').map(source => source.id);
    const missingDurableSourceRefs = expectedMessageSourceRefs.filter(sourceRef => !durableSourceRefs.has(sourceRef));
    const rejections = activeAudits
      .flatMap(record => Array.isArray(record.rejected) ? record.rejected : [])
      .filter(value => String((value as { status?: unknown })?.status ?? 'unresolved') === 'unresolved');
    const vectors = await listAllVectors(workspace);

    const queries = [
      { query: '紫色晶雨最初发生时，白夕小时如何指挥大家应对？', entityKeys: ['紫色晶雨', '白夕小时'] },
      { query: '紫罗拥有什么能力，可以怎样帮助团队？', entityKeys: ['紫罗', '能力', '团队'] },
      { query: '加油站地下储油库目前还有多少燃油？', entityKeys: ['加油站', '地下储油库', '燃油'] },
      { query: '白夕琴乃·重构体可以怎样感知外界并协助侦察？', entityKeys: ['白夕琴乃·重构体', '琴乃', '感知', '侦察'] },
    ];
    const recall = [];
    for (const input of queries) {
      const result = await application.recall.preview({ ...input, maxItems: 12, now: Date.now() });
      recall.push({
        query: input.query,
        selectedCount: result.items.length,
        diagnostics: result.diagnostics,
        items: result.items.map((item, index) => ({
          rank: index + 1,
          score: item.score,
          kind: item.fact.kind,
          subjectKey: item.fact.subjectKey,
          predicateKey: item.fact.predicateKey,
          content: item.fact.content,
          sourceRefs: item.fact.sourceRefs,
        })),
      });
    }
    const actorRows = actors.filter(actor => actor.kind === 'actor');
    const actorNames = actorRows.map(actor => actor.canonicalName ?? actor.displayName);
    const actorNameCounts = actorNames.reduce<Record<string, number>>((counts, name) => {
      const normalized = normalizeActorName(name);
      counts[normalized] = (counts[normalized] ?? 0) + 1;
      return counts;
    }, {});
    const duplicateActorNames = Object.entries(actorNameCounts).filter(([, count]) => count > 1).map(([name]) => name);
    const falseActorNames = actorNames.filter(name => ['重构体', '表情的话', '状态栏', '剧情选项'].includes(name));
    const locationNameCounts = locations.reduce<Record<string, number>>((counts, location) => {
      const normalized = normalizeLocationName(location.canonicalName);
      counts[normalized] = (counts[normalized] ?? 0) + 1;
      return counts;
    }, {});
    const duplicateLocationNames = Object.entries(locationNameCounts).filter(([, count]) => count > 1).map(([name]) => name);
    const pendingLocationRefs = new Set(pendingLocations.map(candidate => candidate.locationRef).filter((value): value is string => Boolean(value)));
    const untrackedPendingLocations = locations
      .filter(location => location.status === 'pending' && !pendingLocationRefs.has(location.id))
      .map(location => location.canonicalName);
    const expectedVectorFacts = facts.filter(fact => fact.status === 'active' || fact.status === 'pending').length;
    const vectorCoverageRatio = expectedVectorFacts === 0 ? 1 : vectors.length / expectedVectorFacts;
    const searchable = (item: { subjectKey?: string; predicateKey?: string; content: string }): string =>
      [item.subjectKey ?? '', item.predicateKey ?? '', item.content].join(' ');
    const crystalRainItems = recall[0]?.items.slice(0, 6)
      .filter(item => (item.sourceRefs ?? []).some(sourceRef => /message:(?:floor-)?0$/u.test(sourceRef))) ?? [];
    const crystalRainText = crystalRainItems.map(searchable).join('\n');
    const recallChecks = {
      crystalRain: crystalRainItems.length > 0
        && /白夕小时|小时/u.test(crystalRainText)
        && /所有人.*室内/u.test(crystalRainText)
        && /叶.*监控/u.test(crystalRainText)
        && /莲.*保护/u.test(crystalRainText)
        && /琴乃.*分析/u.test(crystalRainText),
      violetCapability: recall[1]?.items.slice(0, 3).some(item => /紫罗/u.test(item.content) && /净化|晶尘|预警|感知|保护|尖刺|能量/u.test(item.content)) === true,
      fuel45Percent: recall[2]?.items.slice(0, 3).some(item => /加油站|地下储油库|燃油/u.test(searchable(item))
        && /45%|百分之四十五/u.test(searchable(item))) === true,
      kotonoSensing: recall[3]?.items.slice(0, 5).some(item => /琴乃/u.test(searchable(item))
        && /感知范围|九十五米|地面震动|能量波动|实时共享|协助侦察/u.test(searchable(item))) === true,
    };
    const expectedBatchCount = Math.max(0, Number(captureProgress.totalBatches ?? 0));
    // Targeted repair captures are additional durable ChangeSets. They should
    // not make the original 24 initialization batches appear incomplete as
    // long as every source is covered and at least all expected batches exist.
    const durableBatchCoverage = expectedBatchCount > 0 && activeCaptureAudits.length >= expectedBatchCount;
    const repairCaptureBatches = Math.max(0, activeCaptureAudits.length - expectedBatchCount);
    const quality = {
      passed: rejections.length === 0
        && orphanTraces.length === 0
        && orphanObservations.length === 0
        && falseActorNames.length === 0
        && duplicateActorNames.length === 0
        && duplicateLocationNames.length === 0
        && untrackedPendingLocations.length === 0
        && missingDurableSourceRefs.length === 0
        && durableBatchCoverage
        && vectorCoverageRatio >= 0.999
        && Object.values(recallChecks).every(Boolean),
      checks: {
        unresolvedRejections: rejections.length === 0,
        orphanTraces: orphanTraces.length === 0,
        orphanObservations: orphanObservations.length === 0,
        noFalseActors: falseActorNames.length === 0,
        uniqueActors: duplicateActorNames.length === 0,
        uniqueLocations: duplicateLocationNames.length === 0,
        pendingLocationCandidateCoverage: untrackedPendingLocations.length === 0,
        durableSourceCoverage: missingDurableSourceRefs.length === 0,
        durableBatchCoverage,
        vectorCoverage: vectorCoverageRatio >= 0.999,
        ...recallChecks,
      },
    };
    await application.saveSettings({
      ...application.getSettings(),
      autoOrganize: original.autoOrganize === true,
      preExtractReferenceEnabled: original.preExtractReferenceEnabled === true,
      graphEnabled: original.graphEnabled === true,
      graphLlmRelationEnabled: original.graphLlmRelationEnabled === true,
      recallMode: original.recallMode === 'lexical' || original.recallMode === 'vector' || original.recallMode === 'hybrid' ? original.recallMode : 'auto',
      rerankMode: original.rerankMode === 'off' || original.rerankMode === 'always' ? original.rerankMode : 'adaptive',
      // 保留安全的 5 层串行窗口，避免后续自动整理重新回到旧的 10 层超大批次。
      summaryBatchMode: 'floors',
      summaryBatchFloors: 5,
      summaryOverlapFloors: 2,
    });

    const overview = await application.getOverview();
    const integrity = await workspace.integrity();
    const report = {
      format: 'ss-helper-memory-live-real-initialize',
      version: 1,
      executedAt: new Date().toISOString(),
      workspaceId: WORKSPACE_ID,
      chatKey: CHAT_KEY,
      dataset: {
        file: DATASET_FILE,
        sourceMessages: sources.filter(source => source.kind === 'message').length,
        sourceChars: sources.reduce((sum, source) => sum + source.content.length, 0),
      },
      backupDirectory: state.backupDirectory,
      initialization,
      counts: {
        facts: facts.length,
        activeFacts: facts.filter(fact => fact.status === 'active').length,
        pendingFacts: facts.filter(fact => fact.status === 'pending').length,
        episodes: episodes.length,
        observations: observations.length,
        traces: traces.length,
        actors: actorRows.length,
        pendingActors: pendingActors.length,
        locations: locations.length,
        pendingLocations: pendingLocations.length,
        vectors: vectors.length,
        rejectionRows: rejections.length,
        partialBatches: activeAudits.filter(record => record.outcome === 'partial').length,
        activeCaptureBatches: activeCaptureAudits.length,
        repairCaptureBatches,
        rolledBackCaptureAttempts: rolledBackCaptureAudits.length,
        missingDurableSources: missingDurableSourceRefs.length,
        orphanTraces: orphanTraces.length,
        orphanObservations: orphanObservations.length,
      },
      actors: actorRows.map(actor => ({ id: actor.id, name: actor.canonicalName ?? actor.displayName, aliases: actor.aliases, status: actor.status })),
      pendingActors,
      locations: locations.map(location => ({ id: location.id, name: location.canonicalName, aliases: location.aliases, status: location.status })),
      pendingLocations,
      captureDurability: {
        expectedBatches: expectedBatchCount,
        activeBatches: activeCaptureAudits.length,
        rolledBackAttempts: rolledBackCaptureAudits.length,
        expectedMessageSources: expectedMessageSourceRefs.length,
        coveredMessageSources: expectedMessageSourceRefs.length - missingDurableSourceRefs.length,
        missingSourceRefs: missingDurableSourceRefs,
        untrackedPendingLocations,
      },
      duplicateActorNames,
      duplicateLocationNames,
      falseActorNames,
      rejectionCodes: rejections.reduce<Record<string, number>>((counts, value) => {
        const code = String((value as { code?: unknown })?.code ?? 'unknown');
        counts[code] = (counts[code] ?? 0) + 1;
        return counts;
      }, {}),
      integrity: {
        workspace: integrity,
        orphanTraceIds: orphanTraces.map(trace => trace.id),
        orphanObservationIds: orphanObservations.map(observation => observation.id),
      },
      vectors: {
        count: vectors.length,
        expectedFacts: expectedVectorFacts,
        coverageRatio: vectorCoverageRatio,
        models: [...new Set(vectors.map(vector => vector.model ?? 'unknown'))],
        dimensions: [...new Set(vectors.map(vector => vector.dimensions))],
      },
      recall,
      quality,
      overview,
      api: {
        accumulated: state.apiTotals,
        validation: metrics,
      },
      settingsLeftAfterTest: application.getSettings(),
    };
    await mkdir(path.dirname(REPORT_FILE), { recursive: true });
    await writeFile(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    addMetrics(state, metrics);
    state.phase = quality.passed ? 'validated' : 'quality-failed';
    state.finalReport = REPORT_FILE;
    state.finalCounts = report.counts;
    await saveState(state);
    event('validation-complete', { report: REPORT_FILE, quality, counts: report.counts, vectors: report.vectors, apiTotals: state.apiTotals });
  } finally {
    application.stop();
    configureMemoryLlmApi(null);
  }
}

async function printStatus(state: PersistentState | null, workspace: WorkspacePort): Promise<void> {
  const health = await workspace.health();
  const integrity = await workspace.integrity();
  console.log(JSON.stringify({ state, health, integrity, stateFile: STATE_FILE, reportFile: REPORT_FILE }, null, 2));
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'status';
  const config = await loadConfiguration();
  const live = await createLiveWorkspacePort();
  try {
    if (command === 'status') {
      await printStatus(await loadState(), live.workspace);
      return;
    }
    if (command === 'fresh') {
      const state = await prepareFreshRun(live.workspace);
      await runCaptureChunk(state, live.workspace, config);
      return;
    }
    const state = await loadState();
    if (!state) throw new Error(`缺少运行状态文件，请先执行 fresh：${STATE_FILE}`);
    if (command === 'resume') {
      await runCaptureChunk(state, live.workspace, config);
      return;
    }
    if (command === 'validate') {
      await validateCompletedRun(state, live.workspace, config);
      return;
    }
    if (command === 'repair-rejections') {
      await repairUnresolvedRejections(state, live.workspace, config);
      return;
    }
    throw new Error(`未知命令：${command}。可用命令：status、fresh、resume、repair-rejections、validate。`);
  } finally {
    live.close();
  }
}

export const liveRealInitializeRun = main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  throw error;
});
