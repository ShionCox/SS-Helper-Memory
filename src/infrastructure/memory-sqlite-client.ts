import {
  PLUGIN_BINARY_CONTENT_TYPE,
  type PluginBinaryRequestOptions,
  type PluginBinaryRequestV1,
  type PluginBinaryResponseForModeV1,
  type PluginBinaryResponseModeV1,
} from '@ss-helper/sdk';

const DEFAULT_BASE_URL = '/api/plugins/ss-helper-memory/v1';

export type MemorySqliteQueryResource =
  | 'facts'
  | 'fact'
  | 'evidence'
  | 'jobs'
  | 'job_batch_audits'
  | 'main_chat_usage'
  | 'settings'
  | 'recall_logs'
  | 'fact_vectors'
  | 'vector_coverage'
  | 'vector_rebuild'
  | 'chat_keys'
  | 'integrity';

export type MemorySqliteCommandAction =
  | 'fact.upsert'
  | 'fact.remove'
  | 'ingest.commit'
  | 'job.put'
  | 'batch.rollback'
  | 'setting.set'
  | 'settings.setMany'
  | 'recall_log.add'
  | 'main_chat_usage.add'
  | 'chat.clear'
  | 'vector.upsert'
  | 'vector.delete'
  | 'vector.clear';

export interface MemorySqliteHealth {
  connected: boolean;
  serverVersion: string;
  nodeVersion: string;
  protocolVersion: number;
  sqliteVersion: string;
  schemaVersion: number;
  databasePath: string;
  databaseSizeBytes: number;
  walMode: string;
  tableCounts: Record<string, number>;
  tableBytes: Record<string, number | null>;
  vectorCoverage?: {
    indexedFacts?: number;
    eligibleFacts?: number;
    ratio?: number;
    ready?: number;
    totalFacts?: number;
    coverage?: number;
  };
  lastError?: string | { code?: string; message?: string; at?: number } | null;
}

export interface MemorySqliteBootstrap<TFact = unknown> extends MemorySqliteHealth {
  facts: TFact[];
  settings: Array<{ key: string; value: unknown }>;
}

export interface MemorySqliteVectorSearchHit {
  factId: string;
  score: number;
}

interface RpcSuccess<T> {
  ok: true;
  data: T;
}

interface RpcFailure {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export class MemorySqliteError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MemorySqliteError';
  }
}

export interface MemoryPluginRequestPort {
  send(request: {
    path: `/${string}`;
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    query?: Readonly<Record<string, string | number | boolean>>;
    body?: unknown;
  }): Promise<{ status: number; ok: boolean; body?: unknown }>;
}

export interface MemoryPluginBinaryRequestPort {
  send<Mode extends PluginBinaryResponseModeV1>(
    request: PluginBinaryRequestV1<Mode>,
    options?: PluginBinaryRequestOptions,
  ): Promise<PluginBinaryResponseForModeV1<Mode>>;
}

function binaryPortError(error: unknown): Error {
  if (error instanceof Error && (error.name === 'AbortError' || typeof (error as Error & { code?: unknown }).code === 'string')) {
    return error;
  }
  return new MemorySqliteError(
    `Memory SQLite 二进制请求失败：${error instanceof Error ? error.message : String(error)}`,
    'SQLITE_SERVICE_UNAVAILABLE',
  );
}

function decodeBase64(value: string): Uint8Array {
  try {
    const decoded = atob(value);
    return Uint8Array.from(decoded, character => character.charCodeAt(0));
  } catch {
    throw new MemorySqliteError('Memory SQLite 备份包含无效 base64 数据。', 'INVALID_BINARY_RESPONSE');
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let output = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    output += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(output);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function createRequestId(): string {
  const id = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `memory:${id}`;
}

/** SillyTavern 服务端 SQLite 插件的唯一浏览器客户端。 */
export class MemorySqliteClient {
  private binaryPortGeneration = 0;

  constructor(
    readonly baseUrl = DEFAULT_BASE_URL,
    private requestPort?: MemoryPluginRequestPort,
    private binaryRequestPort?: MemoryPluginBinaryRequestPort,
  ) {}

  useRequestPort(port: MemoryPluginRequestPort): void { this.requestPort = port; }
  useBinaryRequestPort(port: MemoryPluginBinaryRequestPort): void {
    this.binaryRequestPort = port;
    this.binaryPortGeneration += 1;
  }

  async health(chatKey?: string): Promise<MemorySqliteHealth> {
    const query = chatKey?.trim() ? `?chatKey=${encodeURIComponent(chatKey.trim())}` : '';
    return this.request<MemorySqliteHealth>(`/health${query}`, { method: 'GET' });
  }

  async bootstrap<TFact = unknown>(chatKey: string): Promise<MemorySqliteBootstrap<TFact>> {
    return this.post<MemorySqliteBootstrap<TFact>>('/bootstrap', { chatKey });
  }

  async query<T>(
    resource: MemorySqliteQueryResource,
    options: {
      chatKey?: string;
      filters?: Record<string, unknown>;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<T> {
    return this.post<T>('/query', { resource, ...options });
  }

  async command<T>(
    action: MemorySqliteCommandAction,
    payload: Record<string, unknown>,
    requestId = createRequestId(),
  ): Promise<T> {
    return this.post<T>('/command', { requestId, action, payload });
  }

  async vectorSearch(input: {
    chatKey: string;
    vector: readonly number[] | Float32Array;
    limit?: number;
    resourceId?: string;
    model?: string;
  }): Promise<MemorySqliteVectorSearchHit[]> {
    return this.post<MemorySqliteVectorSearchHit[]>('/vector/search', {
      ...input,
      vector: Array.from(input.vector),
    });
  }

  async exportBackup(options?: PluginBinaryRequestOptions): Promise<Blob> {
    if (!this.binaryRequestPort) throw new MemorySqliteError('Memory Core 二进制请求能力不可用。', 'BINARY_CAPABILITY_UNAVAILABLE');
    const port = this.binaryRequestPort;
    const generation = this.binaryPortGeneration;
    let response: Awaited<ReturnType<MemoryPluginBinaryRequestPort['send']>>;
    try {
      const request = {
        version: 1,
        path: `${this.baseUrl}/backup/export` as `/api/plugins/${string}`,
        method: 'POST',
        responseMode: 'binary',
      } as const;
      response = options === undefined ? await port.send(request) : await port.send(request, options);
    } catch (error) {
      throw binaryPortError(error);
    }
    if (generation !== this.binaryPortGeneration) {
      throw new MemorySqliteError('Memory Core 已重载，旧二进制响应已丢弃。', 'CORE_RELOADED');
    }
    if (response.version !== 1 || response.mode !== 'binary' || response.ok !== true || response.status < 200 || response.status >= 300) {
      throw new MemorySqliteError('Memory SQLite 导出返回无效状态。', 'INVALID_BINARY_RESPONSE', response.status);
    }
    if (response.encoding !== 'base64' || response.contentType !== PLUGIN_BINARY_CONTENT_TYPE) {
      throw new MemorySqliteError('Memory SQLite 导出返回了非 SQLite 内容。', 'INVALID_BINARY_RESPONSE', response.status);
    }
    if (!Number.isSafeInteger(response.byteLength) || response.byteLength < 0 || !/^[a-f0-9]{64}$/u.test(response.sha256)) {
      throw new MemorySqliteError('Memory SQLite 导出元数据无效。', 'INVALID_BINARY_RESPONSE', response.status);
    }
    if (response.filename !== undefined
      && (!response.filename.trim() || response.filename.length > 255 || /[\\/\0]/u.test(response.filename))) {
      throw new MemorySqliteError('Memory SQLite 导出文件名无效。', 'INVALID_BINARY_RESPONSE', response.status);
    }
    const bytes = decodeBase64(response.data);
    if (bytes.byteLength !== response.byteLength || await sha256Hex(bytes) !== response.sha256) {
      throw new MemorySqliteError('Memory SQLite 导出内容校验失败。', 'BINARY_INTEGRITY_MISMATCH', response.status);
    }
    const content = bytes.slice().buffer;
    return response.filename
      ? new File([content], response.filename, { type: response.contentType })
      : new Blob([content], { type: response.contentType });
  }

  async importBackup(file: Blob | ArrayBuffer, options?: PluginBinaryRequestOptions): Promise<void> {
    if (!this.binaryRequestPort) throw new MemorySqliteError('Memory Core 二进制请求能力不可用。', 'BINARY_CAPABILITY_UNAVAILABLE');
    const port = this.binaryRequestPort;
    const generation = this.binaryPortGeneration;
    const buffer = file instanceof ArrayBuffer ? file : await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const sha256 = await sha256Hex(bytes);
    let response: Awaited<ReturnType<MemoryPluginBinaryRequestPort['send']>>;
    try {
      const request = {
        version: 1,
        path: `${this.baseUrl}/backup/import` as `/api/plugins/${string}`,
        method: 'POST',
        responseMode: 'json',
        body: {
          encoding: 'base64',
          contentType: PLUGIN_BINARY_CONTENT_TYPE,
          data: encodeBase64(bytes),
          byteLength: bytes.byteLength,
          sha256,
        },
      } as const;
      response = options === undefined ? await port.send(request) : await port.send(request, options);
    } catch (error) {
      throw binaryPortError(error);
    }
    if (generation !== this.binaryPortGeneration) {
      throw new MemorySqliteError('Memory Core 已重载，旧二进制响应已丢弃。', 'CORE_RELOADED');
    }
    const acknowledgementKeys = response.body && typeof response.body === 'object'
      ? Object.keys(response.body).sort()
      : [];
    if (response.version !== 1 || response.mode !== 'json' || response.ok !== true || response.status < 200 || response.status >= 300
      || response.body?.ok !== true || !Object.prototype.hasOwnProperty.call(response.body, 'data')
      || acknowledgementKeys.length !== 2 || acknowledgementKeys[0] !== 'data' || acknowledgementKeys[1] !== 'ok') {
      throw new MemorySqliteError('Memory SQLite 导入返回无效确认。', 'INVALID_BINARY_RESPONSE', response.status);
    }
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      body,
    });
  }

  private async request<T>(path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<T> {
    if (!this.requestPort) throw new MemorySqliteError('Memory Core JSON 请求能力不可用。', 'REQUEST_CAPABILITY_UNAVAILABLE');
    const [pathname, search = ''] = `${this.baseUrl}${path}`.split('?');
    const query = Object.fromEntries(new URLSearchParams(search).entries());
    let response: Awaited<ReturnType<MemoryPluginRequestPort['send']>>;
    try {
      response = await this.requestPort.send({
        path: pathname as `/${string}`,
        method: init.method,
        ...(Object.keys(query).length > 0 ? { query } : {}),
        ...(init.body === undefined ? {} : { body: init.body }),
      });
    } catch (error) {
      throw new MemorySqliteError(
        `无法连接 Memory SQLite 服务：${error instanceof Error ? error.message : String(error)}`,
        'SQLITE_SERVICE_UNAVAILABLE',
      );
    }
    if (!response.ok) {
      const failure = response.body as RpcFailure | undefined;
      throw new MemorySqliteError(
        failure?.error?.message ?? `Memory SQLite 服务返回 HTTP ${response.status}。`,
        failure?.error?.code ?? `HTTP_${response.status}`,
        response.status,
      );
    }
    const rpc = response.body as RpcSuccess<T> | RpcFailure | undefined;
    if (!rpc || typeof rpc !== 'object' || rpc.ok !== true) {
      const failure = rpc as RpcFailure | undefined;
      throw new MemorySqliteError(failure?.error?.message ?? 'Memory SQLite 服务返回无效响应。', failure?.error?.code ?? 'INVALID_RESPONSE', response.status);
    }
    return rpc.data;
  }
}

export const memorySqliteProtocol = Object.freeze({
  baseUrl: DEFAULT_BASE_URL,
  version: 1,
});
