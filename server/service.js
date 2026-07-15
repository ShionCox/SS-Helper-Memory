import path from 'node:path';
import { Worker } from 'node:worker_threads';

const MAX_PENDING_REQUESTS = 1_000;
const WORKER_IDLE_MS = 15 * 60 * 1_000;
const WORKER_SWEEP_MS = 5 * 60 * 1_000;

function normalizeWorkerError(error) {
  if (error?.code === 'SQLITE_BUSY'
    || error?.errcode === 5
    || (error?.code === 'ERR_SQLITE_ERROR' && /\b(?:busy|locked)\b/i.test(error?.message ?? ''))) {
    error.code = 'SQLITE_BUSY';
  } else if (error?.code === 'ERR_SQLITE_ERROR') {
    error.code = 'SQLITE_ERROR';
  } else if (!error?.code) {
    error.code = 'WORKER_UNAVAILABLE';
  }
  return error;
}

/** 单个 SillyTavern 用户数据库对应一个串行 SQLite Worker。 */
export class MemorySqliteWorkerClient {
  constructor(dbPath) {
    this.dbPath = path.resolve(dbPath);
    this.sequence = 0;
    this.pending = new Map();
    this.closed = false;
    this.failed = false;
    this.lastUsedAt = Date.now();
    this.worker = new Worker(new URL('./sqlite-worker.js', import.meta.url), {
      workerData: { dbPath: this.dbPath },
      name: 'ss-helper-memory-sqlite',
    });
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.worker.on('message', message => this.onMessage(message));
    this.worker.on('error', error => this.onFailure(error));
    this.worker.on('exit', code => {
      if (!this.closed) this.onFailure(new Error(`Memory SQLite Worker 意外退出：${code}`));
    });
  }

  onMessage(message) {
    if (message?.type === 'ready') {
      this.resolveReady();
      return;
    }
    const pending = this.pending.get(message?.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else {
      const error = new Error(message.error?.message ?? 'Memory SQLite Worker 请求失败。');
      error.code = message.error?.code ?? 'SQLITE_ERROR';
      pending.reject(error);
    }
  }

  onFailure(error) {
    if (this.failed || this.closed) return;
    this.failed = true;
    const normalized = normalizeWorkerError(error);
    this.rejectReady(normalized);
    for (const pending of this.pending.values()) pending.reject(normalized);
    this.pending.clear();
  }

  async call(method, payload) {
    if (this.closed) throw new Error('Memory SQLite Worker 已关闭。');
    if (this.failed) {
      const error = new Error('Memory SQLite Worker 不可用，需重新建立连接。');
      error.code = 'WORKER_UNAVAILABLE';
      throw error;
    }
    await this.ready;
    this.lastUsedAt = Date.now();
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      const error = new Error('Memory SQLite 请求队列已满。');
      error.code = 'OVERLOADED';
      throw error;
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, payload });
    });
  }

  async close() {
    if (this.closed) return;
    if (this.failed) {
      this.closed = true;
      await this.worker.terminate();
      return;
    }
    try {
      await this.call('close');
    } finally {
      this.closed = true;
      await this.worker.terminate();
    }
  }
}

export class MemorySqliteService {
  constructor() {
    this.clients = new Map();
    this.sweepTimer = setInterval(() => this.closeIdleClients(), WORKER_SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  closeIdleClients() {
    const cutoff = Date.now() - WORKER_IDLE_MS;
    for (const [dbPath, client] of this.clients) {
      if (client.pending.size === 0 && client.lastUsedAt < cutoff) {
        this.clients.delete(dbPath);
        void client.close();
      }
    }
  }

  /** 数据库路径完全来自 SillyTavern 鉴权用户目录，绝不接受前端路径。 */
  resolveUserDatabase(userRoot) {
    if (typeof userRoot !== 'string' || userRoot.trim() === '') {
      const error = new Error('请求缺少 SillyTavern 用户目录。');
      error.code = 'UNAUTHENTICATED';
      throw error;
    }
    const root = path.resolve(userRoot);
    const database = path.resolve(root, '_memory', 'memory.sqlite3');
    const relative = path.relative(root, database);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      const error = new Error('用户数据库路径越界。');
      error.code = 'INVALID_USER_ROOT';
      throw error;
    }
    return database;
  }

  forUser(userRoot) {
    const dbPath = this.resolveUserDatabase(userRoot);
    let client = this.clients.get(dbPath);
    if (!client || client.failed || client.closed) {
      if (client) void client.close();
      client = new MemorySqliteWorkerClient(dbPath);
      this.clients.set(dbPath, client);
    }
    return client;
  }

  async call(userRoot, method, payload) {
    return this.forUser(userRoot).call(method, payload);
  }

  async close() {
    clearInterval(this.sweepTimer);
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(clients.map(client => client.close()));
  }
}
