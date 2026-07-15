import { MemorySqliteService } from './service.js';

export const info = Object.freeze({
  id: 'ss-helper-memory',
  name: 'SS Helper Memory SQLite',
  description: 'Memory 的用户隔离 SQLite 持久化服务',
});

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_BACKUP_BYTES = 512 * 1024 * 1024;
let service;

function userRoot(req) {
  return req.user?.directories?.root;
}

function sendError(res, error) {
  const code = error?.code ?? 'INTERNAL_ERROR';
  const status = code === 'UNAUTHENTICATED' ? 401
    : code === 'NOT_FOUND' ? 404
      : code === 'PAYLOAD_TOO_LARGE' ? 413
      : code === 'REVISION_CONFLICT' || code === 'IDEMPOTENCY_CONFLICT' ? 409
        : code === 'OVERLOADED' || code === 'WORKER_UNAVAILABLE' || code === 'SQLITE_BUSY' ? 503
        : code === 'INTERNAL_ERROR' || code === 'SQLITE_ERROR' ? 500
          : 400;
  res.status(status).json({ ok: false, error: { code, message: error?.message ?? 'Memory SQLite 请求失败。' } });
}

function jsonSize(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
}

function route(method, { maxBytes = MAX_JSON_BYTES } = {}) {
  return async (req, res) => {
    try {
      if (jsonSize(req.body) > maxBytes) {
        const error = new Error('请求体超过允许大小。');
        error.code = 'PAYLOAD_TOO_LARGE';
        throw error;
      }
      const data = await service.call(userRoot(req), method, req.body ?? {});
      res.json({ ok: true, data });
    } catch (error) {
      sendError(res, error);
    }
  };
}

async function readRawBody(req, maximum) {
  if (Buffer.isBuffer(req.body) || req.body instanceof Uint8Array) return Buffer.from(req.body);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) {
      const error = new Error('SQLite 备份超过允许大小。');
      error.code = 'PAYLOAD_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function init(router) {
  service ??= new MemorySqliteService();

  router.get('/v1/health', async (req, res) => {
    try {
      const data = await service.call(userRoot(req), 'health', { chatKey: req.query?.chatKey });
      res.json({ ok: true, data });
    } catch (error) {
      sendError(res, error);
    }
  });
  router.post('/v1/bootstrap', route('bootstrap'));
  router.post('/v1/query', route('query'));
  router.post('/v1/command', async (req, res) => {
    try {
      if (jsonSize(req.body) > MAX_JSON_BYTES) {
        const error = new Error('请求体超过允许大小。');
        error.code = 'PAYLOAD_TOO_LARGE';
        throw error;
      }
      const outcome = await service.call(userRoot(req), 'command', req.body ?? {});
      res.json({ ok: true, data: outcome.result, meta: { replayed: outcome.replayed } });
    } catch (error) {
      sendError(res, error);
    }
  });
  router.post('/v1/vector/search', route('vectorSearch'));
  router.post('/v1/integrity', route('integrity'));

  router.post('/v1/backup/export', async (req, res) => {
    try {
      const result = await service.call(userRoot(req), 'backupExport', {});
      const bytes = Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength);
      res.setHeader('Content-Type', 'application/vnd.sqlite3');
      res.setHeader('Content-Disposition', 'attachment; filename="ss-helper-memory.sqlite3"');
      res.setHeader('Content-Length', String(bytes.byteLength));
      res.setHeader('X-Content-SHA256', result.sha256);
      res.end(bytes);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/v1/backup/import', async (req, res) => {
    try {
      let bytes;
      let sha256;
      if (req.body && typeof req.body === 'object' && typeof req.body.dataBase64 === 'string') {
        bytes = Buffer.from(req.body.dataBase64, 'base64');
        sha256 = req.body.sha256;
      } else {
        bytes = await readRawBody(req, MAX_BACKUP_BYTES);
        sha256 = req.headers['x-content-sha256'];
      }
      if (bytes.byteLength > MAX_BACKUP_BYTES) {
        const error = new Error('SQLite 备份超过允许大小。');
        error.code = 'PAYLOAD_TOO_LARGE';
        throw error;
      }
      const data = await service.call(userRoot(req), 'backupImport', { data: bytes, sha256 });
      res.json({ ok: true, data });
    } catch (error) {
      sendError(res, error);
    }
  });
}

export async function exit() {
  const current = service;
  service = undefined;
  await current?.close();
}

export { MemorySqliteService, MemorySqliteWorkerClient } from './service.js';
export { BUSINESS_TABLES, PROTOCOL_VERSION, SCHEMA_VERSION } from './schema.js';
