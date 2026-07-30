import { describe, expect, it, vi } from 'vitest';
import type { WorkspacePort, WorkspaceSession } from '@ss-helper/sdk';
import { MemoryStore, memoryStoreFor } from '../src/infrastructure/memory-store';

function containsUndefined(value: unknown): boolean {
  if (value === undefined) return true;
  if (Array.isArray(value)) return value.some(containsUndefined);
  if (!value || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).some(containsUndefined);
}

describe('MemoryStore PlainData boundary', () => {
  it('shares one store per WorkspacePort and opens an unchanged schema once', async () => {
    const session = { id: 'workspace:1' } as unknown as WorkspaceSession;
    const open = vi.fn(async () => session);
    const port = { open, admin: {} } as unknown as WorkspacePort;
    const first = memoryStoreFor(port);
    const second = memoryStoreFor(port);
    const schema = [{ name: 'facts', indexes: ['chatKey'] }];

    expect(second).toBe(first);
    await Promise.all([
      first.bind('workspace:1', schema, { kind: 'first' }),
      second.bind('workspace:1', schema, { kind: 'second' }),
    ]);
    await first.bind('workspace:1', schema);

    expect(open).toHaveBeenCalledTimes(1);
  });

  it('omits absent optional fields from workspace and vector requests', async () => {
    const open = vi.fn(async (_request: Parameters<WorkspacePort['open']>[0]) => undefined as unknown as WorkspaceSession);
    const commit = vi.fn(async (request: Parameters<WorkspaceSession['commit']>[0]) => ({
      requestId: request.idempotencyKey,
      replayed: false,
      results: [{ collection: 'facts', id: 'fact:1', action: 'put' as const, revision: 1 }],
    }));
    const vectorUpsert = vi.fn(async (_request: Parameters<WorkspaceSession['vectors']['upsert']>[0]) => undefined);
    const vectorSearch = vi.fn(async (_request: Parameters<WorkspaceSession['vectors']['search']>[0]) => []);
    const vectorList = vi.fn(async (_request: Parameters<WorkspaceSession['vectors']['list']>[0]) => ({ vectors: [], nextCursor: null }));
    const vectorClear = vi.fn(async (_request: Parameters<WorkspaceSession['vectors']['clear']>[0]) => 0);
    const session = {
      id: 'workspace:1',
      get: vi.fn(async () => null),
      query: vi.fn(async () => ({ records: [], nextCursor: null })),
      commit,
      vectors: {
        upsert: vectorUpsert,
        search: vectorSearch,
        delete: vi.fn(async () => false),
        list: vectorList,
        clear: vectorClear,
      },
    } as unknown as WorkspaceSession;
    open.mockResolvedValue(session);
    const port = {
      open,
      admin: {
        health: vi.fn(),
        integrity: vi.fn(),
        reset: vi.fn(),
        backup: vi.fn(),
      },
    } as unknown as WorkspacePort;
    const store = new MemoryStore(port);

    await store.bind('workspace:1', []);
    await store.apply({
      workspaceId: 'workspace:1',
      idempotencyKey: 'commit:1',
      operations: [{ action: 'upsert', collection: 'facts', recordId: 'fact:1', value: { id: 'fact:1' } }],
    });
    await store.vectors.upsert({ workspaceId: 'workspace:1', recordId: 'fact:1', vector: [1, 0] });
    await store.vectors.search({ workspaceId: 'workspace:1', vector: [1, 0] });
    await store.vectors.list({ workspaceId: 'workspace:1' });
    await store.vectors.clear({ workspaceId: 'workspace:1' });

    for (const call of [
      open.mock.calls[0]?.[0],
      commit.mock.calls[0]?.[0],
      vectorUpsert.mock.calls[0]?.[0],
      vectorSearch.mock.calls[0]?.[0],
      vectorList.mock.calls[0]?.[0],
      vectorClear.mock.calls[0]?.[0],
    ]) {
      expect(containsUndefined(call)).toBe(false);
    }
    expect(vectorSearch.mock.calls[0]?.[0]).toEqual({ vector: [1, 0] });
  });

  it.each([
    ['empty result', []],
    ['wrong action', [{ collection: 'facts', id: 'fact:1', action: 'delete', revision: 1, removed: true }]],
    ['wrong record id', [{ collection: 'facts', id: 'fact:2', action: 'put', revision: 1 }]],
    ['invalid revision', [{ collection: 'facts', id: 'fact:1', action: 'put', revision: 0 }]],
  ])('rejects malformed write commit result: %s', async (_name, results) => {
    const session = {
      id: 'workspace:1',
      get: vi.fn(async () => null),
      query: vi.fn(),
      commit: vi.fn(async () => ({ requestId: 'request:1', replayed: false, results })),
      vectors: {},
    } as unknown as WorkspaceSession;
    const port = {
      open: vi.fn(async () => session),
      admin: {},
    } as unknown as WorkspacePort;
    const store = new MemoryStore(port);
    await store.bind('workspace:1', []);

    await expect(store.write({
      workspaceId: 'workspace:1',
      collection: 'facts',
      recordId: 'fact:1',
      value: { id: 'fact:1' },
    })).rejects.toMatchObject({
      details: { reasonCode: 'INVALID_PAYLOAD', stage: 'memory.store.write.result' },
    });
  });

  it.each([
    ['empty result', []],
    ['wrong action', [{ collection: 'facts', id: 'fact:1', action: 'put', revision: 1 }]],
    ['wrong record id', [{ collection: 'facts', id: 'fact:2', action: 'delete', revision: 1, removed: true }]],
    ['invalid revision', [{ collection: 'facts', id: 'fact:1', action: 'delete', revision: -1, removed: true }]],
    ['missing removed', [{ collection: 'facts', id: 'fact:1', action: 'delete', revision: 1 }]],
  ])('rejects malformed remove commit result: %s', async (_name, results) => {
    const session = {
      id: 'workspace:1',
      get: vi.fn(),
      query: vi.fn(),
      commit: vi.fn(async () => ({ requestId: 'request:1', replayed: false, results })),
      vectors: {},
    } as unknown as WorkspaceSession;
    const port = {
      open: vi.fn(async () => session),
      admin: {},
    } as unknown as WorkspacePort;
    const store = new MemoryStore(port);
    await store.bind('workspace:1', []);

    await expect(store.remove({
      workspaceId: 'workspace:1',
      collection: 'facts',
      recordId: 'fact:1',
    })).rejects.toMatchObject({
      details: { reasonCode: 'INVALID_PAYLOAD', stage: 'memory.store.remove.result' },
    });
  });
});
