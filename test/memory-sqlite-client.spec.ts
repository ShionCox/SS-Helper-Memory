import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

import { MemorySqliteClient, MemorySqliteError } from '../src/infrastructure/memory-sqlite-client';
import { MemoryRepository } from '../src/infrastructure/memory-repository';

function sqliteHealth() {
  return {
    connected: true, serverVersion: '0.0.1', nodeVersion: 'v24.14.0', protocolVersion: 1,
    sqliteVersion: '3.49.1', schemaVersion: 2, databasePath: '_memory/memory.sqlite3',
    databaseSizeBytes: 4096, walMode: 'wal', tableCounts: {}, tableBytes: {},
  };
}

function jsonClient(data: unknown = sqliteHealth()): { client: MemorySqliteClient; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async () => ({ status: 200, ok: true, body: { ok: true, data } }));
  const client = new MemorySqliteClient();
  client.useRequestPort({ send });
  return { client, send };
}

afterEach(() => vi.unstubAllGlobals());

describe('MemorySqliteClient', () => {
  it('routes JSON persistence through the authenticated HostPort plugin request capability', async () => {
    const { client, send } = jsonClient();
    await expect(client.health('chat-a')).resolves.toMatchObject({ connected: true, protocolVersion: 1 });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      path: '/api/plugins/ss-helper-memory/v1/health', method: 'GET', query: { chatKey: 'chat-a' },
    }));
  });

  it('preserves HostPort server error codes and transport failure normalization', async () => {
    const serverFailure = new MemorySqliteClient();
    serverFailure.useRequestPort({ send: async () => ({
      status: 409, ok: false, body: { ok: false, error: { code: 'STALE_REVISION', message: '版本冲突' } },
    }) });
    await expect(serverFailure.health()).rejects.toMatchObject({ code: 'STALE_REVISION', status: 409, message: '版本冲突' });

    const transportFailure = new MemorySqliteClient();
    transportFailure.useRequestPort({ send: async () => { throw new Error('Core disconnected'); } });
    await expect(transportFailure.health()).rejects.toMatchObject({ code: 'SQLITE_SERVICE_UNAVAILABLE' });
  });

  it('fails closed when the Core JSON request capability is unavailable', async () => {
    await expect(new MemorySqliteClient().health()).rejects.toMatchObject({ code: 'REQUEST_CAPABILITY_UNAVAILABLE' });
  });

  it('routes exact SQLite export/import bytes exclusively through Core binaryRequest', async () => {
    const sqliteBytes = new Uint8Array([0x53, 0x51, 0x4c, 0x69]);
    const sqlite = sqliteBytes.buffer;
    const sha256 = createHash('sha256').update(sqliteBytes).digest('hex');
    const send = vi.fn()
      .mockResolvedValueOnce({
        version: 1, mode: 'binary', status: 200, ok: true, encoding: 'base64',
        contentType: 'application/vnd.sqlite3', data: 'U1FMaQ==', byteLength: 4, sha256,
        filename: 'memory-export.sqlite3',
      })
      .mockResolvedValueOnce({ version: 1, mode: 'json', status: 200, ok: true, body: { ok: true, data: null } });
    const client = new MemorySqliteClient();
    client.useBinaryRequestPort({ send: send as never });

    const exported = await client.exportBackup();
    expect(exported).toBeInstanceOf(Blob);
    expect(exported.type).toBe('application/vnd.sqlite3');
    expect(await exported.arrayBuffer()).toEqual(sqlite);
    expect((exported as File).name).toBe('memory-export.sqlite3');
    await expect(client.importBackup(sqlite)).resolves.toBeUndefined();
    expect(send).toHaveBeenNthCalledWith(1, {
      version: 1, path: '/api/plugins/ss-helper-memory/v1/backup/export', method: 'POST', responseMode: 'binary',
    });
    expect(send).toHaveBeenNthCalledWith(2, {
      version: 1, path: '/api/plugins/ss-helper-memory/v1/backup/import', method: 'POST', responseMode: 'json',
      body: {
        encoding: 'base64', contentType: 'application/vnd.sqlite3', data: 'U1FMaQ==', byteLength: 4, sha256,
      },
    });
    expect(send.mock.calls.every(call => call.length === 1)).toBe(true);
  });

  it('rejects export content type, byte length, hash, status and base64 corruption', async () => {
    const sha256 = createHash('sha256').update(new Uint8Array([0x53, 0x51, 0x4c, 0x69])).digest('hex');
    const valid = {
      version: 1, mode: 'binary', status: 200, ok: true, encoding: 'base64',
      contentType: 'application/vnd.sqlite3', data: 'U1FMaQ==', byteLength: 4, sha256,
    } as const;
    const invalidResponses = [
      { ...valid, contentType: 'application/octet-stream' },
      { ...valid, version: 2 },
      { ...valid, mode: 'json' },
      { ...valid, encoding: 'hex' },
      { ...valid, byteLength: 5 },
      { ...valid, byteLength: -1 },
      { ...valid, sha256: '0'.repeat(64) },
      { ...valid, status: 500, ok: false },
      { ...valid, data: '***not-base64***' },
      { ...valid, filename: '../memory.sqlite3' },
      { ...valid, filename: 'memory\\escape.sqlite3' },
      { ...valid, filename: ' '.repeat(4) },
      { ...valid, filename: 'x'.repeat(256) },
    ];

    for (const response of invalidResponses) {
      const client = new MemorySqliteClient();
      client.useBinaryRequestPort({ send: vi.fn(async () => response) as never });
      await expect(client.exportBackup()).rejects.toBeInstanceOf(MemorySqliteError);
    }
  });

  it('requires the exact retained JSON acknowledgement for binary import', async () => {
    const invalidAcknowledgements = [
      { version: 1, mode: 'json', status: 200, ok: true, body: { ok: true } },
      { version: 1, mode: 'json', status: 200, ok: true, body: { ok: false, data: null } },
      { version: 1, mode: 'json', status: 200, ok: true, body: { ok: true, data: null, extra: true } },
      { version: 1, mode: 'json', status: 500, ok: false, body: { ok: true, data: null } },
      { version: 2, mode: 'json', status: 200, ok: true, body: { ok: true, data: null } },
      { version: 1, mode: 'binary', status: 200, ok: true, body: { ok: true, data: null } },
      { version: 1, mode: 'json', status: 302, ok: true, body: { ok: true, data: null } },
      { version: 1, mode: 'json', status: 200, ok: true, body: null },
    ];
    for (const response of invalidAcknowledgements) {
      const client = new MemorySqliteClient();
      client.useBinaryRequestPort({ send: vi.fn(async () => response) as never });
      await expect(client.importBackup(new Uint8Array([0x53, 0x51, 0x4c, 0x69]).buffer))
        .rejects.toMatchObject({ code: 'INVALID_BINARY_RESPONSE' });
    }
  });

  it('preserves arbitrary Blob bytes across base64 chunk boundaries', async () => {
    const bytes = Uint8Array.from({ length: 0x8005 }, (_, index) => index % 251);
    bytes[0] = 0;
    bytes[1] = 0xff;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const data = Buffer.from(bytes).toString('base64');
    const send = vi.fn(async () => ({
      version: 1, mode: 'json', status: 200, ok: true, body: { ok: true, data: { imported: true } },
    }));
    const client = new MemorySqliteClient();
    client.useBinaryRequestPort({ send: send as never });

    await expect(client.importBackup(new Blob([bytes.slice().buffer], { type: 'application/octet-stream' })))
      .resolves.toBeUndefined();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      responseMode: 'json',
      body: { encoding: 'base64', contentType: 'application/vnd.sqlite3', data, byteLength: bytes.byteLength, sha256 },
    }));
  });

  it('fails closed without binary capability and preserves abort/timeout errors and options', async () => {
    const unavailable = new MemorySqliteClient();
    await expect(unavailable.exportBackup()).rejects.toMatchObject({ code: 'BINARY_CAPABILITY_UNAVAILABLE' });
    await expect(unavailable.importBackup(new ArrayBuffer(0))).rejects.toMatchObject({ code: 'BINARY_CAPABILITY_UNAVAILABLE' });

    const aborted = Object.assign(new Error('caller aborted'), { name: 'AbortError', code: 'CALL_ABORTED' });
    const timeout = Object.assign(new Error('deadline exceeded'), { code: 'CALL_TIMEOUT' });
    const signal = new AbortController().signal;
    const abortSend = vi.fn(async () => { throw aborted; });
    const abortClient = new MemorySqliteClient();
    abortClient.useBinaryRequestPort({ send: abortSend as never });
    await expect(abortClient.exportBackup({ signal, timeoutMs: 1234 })).rejects.toBe(aborted);
    expect(abortSend).toHaveBeenCalledWith(expect.objectContaining({ responseMode: 'binary' }), { signal, timeoutMs: 1234 });

    const timeoutSend = vi.fn(async () => { throw timeout; });
    const timeoutClient = new MemorySqliteClient();
    timeoutClient.useBinaryRequestPort({ send: timeoutSend as never });
    await expect(timeoutClient.importBackup(new ArrayBuffer(0), { timeoutMs: 50 })).rejects.toBe(timeout);
    expect(timeoutSend).toHaveBeenCalledWith(expect.objectContaining({ responseMode: 'json' }), { timeoutMs: 50 });
  });

  it('quarantines late export/import responses after Core reload and reconnects to the new port', async () => {
    const bytes = new Uint8Array([0x53, 0x51, 0x4c, 0x69]);
    const valid = {
      version: 1, mode: 'binary', status: 200, ok: true, encoding: 'base64',
      contentType: 'application/vnd.sqlite3', data: 'U1FMaQ==', byteLength: 4,
      sha256: createHash('sha256').update(bytes).digest('hex'), filename: 'memory.sqlite3',
    } as const;
    let resolveOld!: (value: typeof valid) => void;
    const client = new MemorySqliteClient();
    client.useBinaryRequestPort({ send: vi.fn(() => new Promise(resolve => { resolveOld = resolve; })) as never });
    const pending = client.exportBackup();

    client.useBinaryRequestPort({ send: vi.fn(async () => valid) as never });
    resolveOld(valid);
    await expect(pending).rejects.toMatchObject({ code: 'CORE_RELOADED' });
    await expect(client.exportBackup()).resolves.toMatchObject({ type: 'application/vnd.sqlite3', name: 'memory.sqlite3' });

    const acknowledgement = { version: 1, mode: 'json', status: 200, ok: true, body: { ok: true, data: null } } as const;
    let resolveOldImport!: (value: typeof acknowledgement) => void;
    client.useBinaryRequestPort({ send: vi.fn(() => new Promise(resolve => { resolveOldImport = resolve; })) as never });
    const pendingImport = client.importBackup(bytes.buffer);
    await vi.waitFor(() => expect(resolveOldImport).toBeTypeOf('function'));
    client.useBinaryRequestPort({ send: vi.fn(async () => acknowledgement) as never });
    resolveOldImport(acknowledgement);
    await expect(pendingImport).rejects.toMatchObject({ code: 'CORE_RELOADED' });
    await expect(client.importBackup(bytes.buffer)).resolves.toBeUndefined();
  });

  it('启动时拒绝不兼容的协议、schema 或服务端主版本', async () => {
    const base = {
      connected: true, serverVersion: '0.0.1', nodeVersion: 'v24.14.0', protocolVersion: 1,
      sqliteVersion: '3.49.1', schemaVersion: 2, databasePath: '_memory/memory.sqlite3',
      databaseSizeBytes: 4096, walMode: 'wal', tableCounts: {}, tableBytes: {},
    };
    for (const health of [
      { ...base, protocolVersion: 2 },
      { ...base, schemaVersion: 3 },
      { ...base, serverVersion: '0.1.0' },
    ]) {
      const repository = new MemoryRepository({ health: async () => health } as MemorySqliteClient);
      await expect(repository.open()).rejects.toThrow(/不兼容/u);
    }
  });

  it('command 写入 action、幂等 requestId 与类型化 payload', async () => {
    const { client, send } = jsonClient({ removed: true });

    await client.command('fact.remove', { chatKey: 'chat-a', id: 'fact-a' }, 'request-a');

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      path: '/api/plugins/ss-helper-memory/v1/command', method: 'POST',
      body: { requestId: 'request-a', action: 'fact.remove', payload: { chatKey: 'chat-a', id: 'fact-a' } },
    }));
  });

  it('向量搜索只传数值数组，不在客户端访问持久化数据库', async () => {
    const { client, send } = jsonClient([{ factId: 'fact-a', score: 0.9 }]);

    const result = await client.vectorSearch({ chatKey: 'chat-a', vector: new Float32Array([1, 0]) });

    expect(result).toEqual([{ factId: 'fact-a', score: 0.9 }]);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ vector: [1, 0] }) }));
  });

  it('保留服务端错误码并拒绝静默降级', async () => {
    const client = new MemorySqliteClient();
    client.useRequestPort({ send: async () => ({
      status: 503, ok: false, body: { ok: false, error: { code: 'SQLITE_BUSY', message: '数据库正忙' } },
    }) });

    const error = await client.query('facts', { chatKey: 'chat-a' }).catch(value => value);

    expect(error).toBeInstanceOf(MemorySqliteError);
    expect(error).toMatchObject({ code: 'SQLITE_BUSY', status: 503, message: '数据库正忙' });
  });
});
