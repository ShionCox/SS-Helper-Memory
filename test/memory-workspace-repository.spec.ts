import { describe, expect, it, vi } from 'vitest';
import type { WorkspacePort, WorkspaceRecord } from '@ss-helper/sdk';
import type { IngestCommit } from '../src/application/ingest/types';
import { MemoryApplication } from '../src/application/memory-application';
import { MemoryRepository } from '../src/infrastructure/memory-repository';

function commitInput(): IngestCommit {
  const excerpt = '角色确认仓库中仍保存着足够饮用水和高热量口粮。';
  return {
    chatKey: 'chat-a', jobId: 'job-a',
    sources: [{ id: 'source-a', chatKey: 'chat-a', kind: 'message', role: 'assistant', content: excerpt, createdAt: 100 }],
    facts: [{ kind: 'state', subjectKey: '仓库', predicateKey: '储备', objectKey: '充足', content: '仓库当前仍保存着足够的饮用水和高热量口粮，可继续支持队伍行动。', entityKeys: ['仓库'], confidence: 0.95, sourceRef: 'source-a', evidenceExcerpt: excerpt, actionHint: 'supersede', canonicalKey: 'ignored' }],
    checkpoint: { sourceIds: ['source-a'], completedAt: 100, batchIndex: 1, processedCount: 1 },
  };
}

function workspace(overrides: Partial<WorkspacePort> = {}): WorkspacePort {
  return {
    health: vi.fn(async () => ({ ready: true, database: 'ss-helper.sqlite3', schemaVersion: 2 })),
    integrity: vi.fn(async () => ({ ok: true, messages: ['ok'] })),
    open: vi.fn(async (request) => ({ ownerPluginId: 'ss-helper.memory', workspaceId: request.workspaceId, created: false })),
    list: vi.fn(async () => ({ workspaces: [], nextCursor: null })),
    removeWorkspace: vi.fn(async () => undefined), clearOwned: vi.fn(async () => 0),
    defineCollection: vi.fn(async () => undefined), get: vi.fn(async () => null),
    upsert: vi.fn(async (request) => ({ recordId: request.recordId, value: request.value!, version: 1, updatedAt: 1 })),
    delete: vi.fn(async () => false), query: vi.fn(async () => ({ records: [], nextCursor: null })),
    transaction: vi.fn(async (request) => ({ operationCount: request.operations.length, replayed: false, results: [] })),
    vectorUpsert: vi.fn(async () => undefined), vectorSearch: vi.fn(async () => []), vectorDelete: vi.fn(async () => false), vectorList: vi.fn(async () => ({ vectors: [], nextCursor: null })), vectorClear: vi.fn(async () => 0),
    grant: vi.fn(async () => undefined), revoke: vi.fn(async () => undefined),
    export: vi.fn(), import: vi.fn(), exportAll: vi.fn(), importAll: vi.fn(),
    ...overrides,
  } as WorkspacePort;
}

describe('MemoryRepository workspace concurrency', () => {
  it('keeps global settings available while no character or group workspace is selected', async () => {
    const port = workspace();
    const repository = new MemoryRepository(port);
    await expect(repository.open()).resolves.toBeUndefined();
    expect(port.open).toHaveBeenCalledTimes(1);
    expect(port.open).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'settings:global' }));
  });

  it('starts in safe standby when SillyTavern has no selected character', async () => {
    const application = new MemoryApplication(new MemoryRepository(workspace()));
    application.useHostContext({
      getChatKey: () => '',
      getWorkspaceId: () => '',
      collectSources: async () => [],
    });
    await application.start();
    await expect(application.getSqliteStatus()).resolves.toMatchObject({ connected: true });
    expect(application.getSettings().enabled).toBe(false);
  });

  it('keeps Memory domain writes in a generic CAS transaction', async () => {
    const previous = {
      id: 'fact-current', chatKey: 'chat-a', kind: 'state' as const, subjectKey: '小时', predicateKey: '武器数量', objectKey: '2', canonicalKey: '小时::武器数量::2', slotKey: '小时::武器数量', content: '当前有两把武器。', entityKeys: ['小时'], confidence: 1, status: 'active' as const, sourceRefs: ['manual:fact-current'], evidenceIds: ['evidence:old'], freshestEvidenceAt: 100, origin: 'manual' as const, revision: 4, supersedesId: 'fact-history', createdAt: 50, updatedAt: 100,
    };
    const get = vi.fn(async (request: { collection?: string; recordId: string }) => {
      if (request.collection === 'facts' && request.recordId === previous.id) return { recordId: previous.id, value: previous, version: 7, updatedAt: 100 } as WorkspaceRecord;
      if (request.collection === 'fact-slots') return { recordId: previous.slotKey, value: { factId: previous.id }, version: 3, updatedAt: 100 } as WorkspaceRecord;
      return null;
    });
    const query = vi.fn(async (request: { collection?: string }) => ({ records: request.collection === 'facts' ? [{ recordId: previous.id, value: previous, version: 7, updatedAt: 100 }] : [], nextCursor: null }));
    const transaction = vi.fn(async (request) => ({ operationCount: request.operations.length, replayed: false, results: [] }));
    const repository = new MemoryRepository(workspace({ get: get as never, query: query as never, transaction })); repository.bind('character:c1', 'chat-b');

    const saved = await repository.upsertManualFact('chat-b', { id: previous.id, kind: previous.kind, subjectKey: previous.subjectKey, predicateKey: previous.predicateKey, objectKey: previous.objectKey, content: '编辑后仍有两把武器。', entityKeys: previous.entityKeys, confidence: 1, status: 'active' });

    expect(saved).toMatchObject({ chatKey: 'chat-b', supersedesId: 'fact-history', revision: 5 });
    expect(transaction).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'character:c1', operations: expect.arrayContaining([expect.objectContaining({ collection: 'facts', recordId: previous.id, expectedVersion: 7 }), expect.objectContaining({ collection: 'fact-slots', expectedVersion: 3 })]) }));
  });

  it('reconciles once after WORKSPACE_CONFLICT and then stops', async () => {
    const transaction = vi.fn().mockRejectedValueOnce(Object.assign(new Error('conflict'), { code: 'WORKSPACE_CONFLICT' })).mockResolvedValueOnce({ operationCount: 5, replayed: false, results: [] });
    const repository = new MemoryRepository(workspace({ transaction })); repository.bind('character:c1', 'chat-a');
    await expect(repository.commitIngest(commitInput())).resolves.toMatchObject({ accepted: 1 });
    expect(transaction).toHaveBeenCalledTimes(2);

    transaction.mockReset(); transaction.mockRejectedValue(Object.assign(new Error('conflict'), { code: 'WORKSPACE_CONFLICT' }));
    await expect(repository.commitIngest(commitInput())).rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' });
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('uses cursor pagination for audit records', async () => {
    const first = Array.from({ length: 1000 }, (_, index) => ({ recordId: `audit:${index}`, value: { id: `audit:${index}`, chatKey: 'chat-a' }, version: 1, updatedAt: index }));
    const query = vi.fn().mockResolvedValueOnce({ records: first, nextCursor: 'next' }).mockResolvedValueOnce({ records: [{ recordId: 'audit:1000', value: { id: 'audit:1000', chatKey: 'chat-a' }, version: 1, updatedAt: 1000 }], nextCursor: null });
    const repository = new MemoryRepository(workspace({ query })); repository.bind('character:c1', 'chat-a');
    await expect(repository.listJobBatchAudits('chat-a')).resolves.toHaveLength(1001);
    expect(query).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: 'next' }));
  });
});
