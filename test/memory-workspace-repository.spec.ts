import { describe, expect, it, vi } from 'vitest';
import type { WorkspacePort, WorkspaceRecord } from '@ss-helper/sdk';
import type { IngestCommit } from '../src/application/ingest/types';
import { MemoryApplication } from '../src/application/memory-application';
import { createFactSlotKey, deriveMemoryGraphProjection } from '../src/domain';
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
    health: vi.fn(async () => ({ ready: true, database: 'ss-helper.sqlite3', schemaVersion: 4 })),
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
  const fact = (id: string, chatKey: string, slotKey = '角色::位置') => ({
    id, chatKey, kind: 'state' as const, subjectKey: '角色', predicateKey: '位置', objectKey: id,
    canonicalKey: `角色::位置::${id}`, slotKey, content: `${chatKey} 的独立记忆`, entityKeys: ['角色'],
    confidence: 1, status: 'active' as const, sourceRefs: [`source:${id}`], evidenceIds: [`evidence:${id}`],
    freshestEvidenceAt: 100, origin: 'automatic' as const, revision: 1, createdAt: 100, updatedAt: 100,
  });

  it('keeps global settings available while no character or group workspace is selected', async () => {
    const port = workspace();
    const repository = new MemoryRepository(port);
    await expect(repository.open()).resolves.toBeUndefined();
    expect(port.open).toHaveBeenCalledTimes(1);
    expect(port.open).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'settings:global' }));
  });

  it('creates a newly selected chat workspace and its collections before querying it', async () => {
    const port = workspace();
    const repository = new MemoryRepository(port);
    repository.bind('character:new-chat', 'chat-new');

    await expect(repository.bootstrap('chat-new')).resolves.toMatchObject({ connected: true, facts: [] });

    expect(port.open).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'character:new-chat', create: true }));
    expect(port.defineCollection).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'character:new-chat', name: 'facts' }));
    expect(vi.mocked(port.open).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(port.query).mock.invocationCallOrder[0]);
  });

  it('reports real server size and estimates current-chat share of the role workspace', async () => {
    const records: WorkspaceRecord[] = [
      { recordId: 'fact-a', value: { chatKey: 'chat-a', content: '当前聊天记忆' }, version: 1, updatedAt: 1 },
      { recordId: 'fact-b', value: { chatKey: 'chat-b', content: '其他聊天记忆更长一些' }, version: 1, updatedAt: 1 },
    ];
    const port = workspace({
      health: vi.fn(async () => ({ ready: true, database: 'ss-helper.sqlite3', schemaVersion: 4, nodeVersion: 'v22.17.0', databaseSizeBytes: 65_536 })),
      query: vi.fn(async (request) => ({ records: request.collection === 'facts' ? records : [], nextCursor: null })) as never,
      vectorList: vi.fn(async () => ({
        vectors: [
          { collection: 'facts', recordId: 'fact-a', model: 'embed', metadata: { chatKey: 'chat-a' }, dimensions: 4, createdAt: 1, updatedAt: 1 },
          { collection: 'facts', recordId: 'fact-b', model: 'embed', metadata: { chatKey: 'chat-b' }, dimensions: 4, createdAt: 1, updatedAt: 1 },
        ],
        nextCursor: null,
      })) as never,
    });
    const repository = new MemoryRepository(port);
    repository.bind('character:hero', 'chat-a');

    const health = await repository.refreshHealth('chat-a');

    expect(health).toMatchObject({ nodeVersion: 'v22.17.0', databaseSizeBytes: 65_536 });
    expect(health.tableBytes.facts).toBeGreaterThan(0);
    expect(health.tableBytes.fact_vectors).toBeGreaterThan(0);
    expect(health.currentChatSizeBytes).toBeGreaterThan(0);
    expect(health.workspaceSizeBytes).toBeGreaterThan(health.currentChatSizeBytes);
  });

  it('keeps the global enabled preference while SillyTavern has no selected character', async () => {
    const application = new MemoryApplication(new MemoryRepository(workspace()));
    application.useHostContext({
      getChatKey: () => '',
      getWorkspaceId: () => '',
      collectSources: async () => [],
    });
    await application.start();
    await expect(application.getSqliteStatus()).resolves.toMatchObject({ connected: true });
    expect(application.getSettings().enabled).toBe(true);
    const overview = await application.getOverview();
    expect(overview).toMatchObject({ status: 'unselected', bound: false });
    expect(overview.error).toBeUndefined();
  });

  it('keeps SQLite failure ahead of the unselected-chat status', async () => {
    const application = new MemoryApplication(new MemoryRepository(workspace({
      health: vi.fn(async () => ({ ready: false, database: 'ss-helper.sqlite3', schemaVersion: 4, error: 'database unavailable' })),
    })));
    application.useHostContext({ getChatKey: () => '', getWorkspaceId: () => '', collectSources: async () => [] });
    await application.start();
    await expect(application.getOverview()).resolves.toMatchObject({
      status: 'error', bound: false, errorCode: 'SQLITE_SERVICE_UNAVAILABLE',
      errorDiagnostic: expect.objectContaining({ title: 'SQLite 工作区服务未连接', reason: expect.stringContaining('工作区接口') }),
    });
  });

  it('rejects editing a fact that belongs to another chat', async () => {
    const previous = {
      id: 'fact-current', chatKey: 'chat-a', kind: 'state' as const, subjectKey: '小时', predicateKey: '武器数量', objectKey: '2', canonicalKey: '小时::武器数量::2', slotKey: '小时::武器数量', content: '当前有两把武器。', entityKeys: ['小时'], confidence: 1, status: 'active' as const, sourceRefs: ['manual:fact-current'], evidenceIds: ['evidence:old'], freshestEvidenceAt: 100, origin: 'manual' as const, revision: 4, supersedesId: 'fact-history', createdAt: 50, updatedAt: 100,
    };
    const get = vi.fn(async (request: { collection?: string; recordId: string }) => {
      if (request.collection === 'facts' && request.recordId === previous.id) return { recordId: previous.id, value: previous, version: 7, updatedAt: 100 } as WorkspaceRecord;
      return null;
    });
    const query = vi.fn(async (request: { collection?: string }) => ({ records: request.collection === 'facts' ? [{ recordId: previous.id, value: previous, version: 7, updatedAt: 100 }] : [], nextCursor: null }));
    const transaction = vi.fn(async (request) => ({ operationCount: request.operations.length, replayed: false, results: [] }));
    const repository = new MemoryRepository(workspace({ get: get as never, query: query as never, transaction })); repository.bind('character:c1', 'chat-b');

    await expect(repository.upsertManualFact('chat-b', { id: previous.id, kind: previous.kind, subjectKey: previous.subjectKey, predicateKey: previous.predicateKey, objectKey: previous.objectKey, content: '编辑后仍有两把武器。', entityKeys: previous.entityKeys, confidence: 1, status: 'active' }))
      .rejects.toMatchObject({ code: 'MEMORY_FACT_NOT_FOUND' });
    expect(transaction).not.toHaveBeenCalled();
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

  it('does not reconcile an incoming fact against the same slot in another chat', async () => {
    const slotKey = createFactSlotKey('仓库', '储备');
    const otherChatFact = {
      ...fact('fact-chat-b', 'chat-b', slotKey), subjectKey: '仓库', predicateKey: '储备', objectKey: '不足',
      canonicalKey: '仓库::储备::不足', content: '聊天 B 的仓库储备不足。',
    };
    const query = vi.fn(async (request: { collection?: string; filter?: Record<string, unknown> }) => ({
      records: request.collection === 'facts' && (!request.filter?.chatKey || request.filter.chatKey === 'chat-b')
        ? [{ recordId: otherChatFact.id, value: otherChatFact, version: 1, revision: 1, updatedAt: 100 }]
        : [],
      nextCursor: null,
    }));
    const transaction = vi.fn(async (request) => ({ operationCount: request.operations.length, replayed: false, results: [] }));
    const repository = new MemoryRepository(workspace({ query: query as never, transaction }));
    repository.bind('character:c1', 'chat-a');

    await repository.commitIngest(commitInput());

    const operations = transaction.mock.calls[0][0].operations;
    expect(operations).not.toEqual(expect.arrayContaining([expect.objectContaining({ collection: 'facts', recordId: otherChatFact.id })]));
    expect(operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ collection: 'fact-slots', recordId: `fact-slot:${encodeURIComponent('chat-a')}:${encodeURIComponent(slotKey)}` }),
    ]));
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ collection: 'facts', filter: { chatKey: 'chat-a' } }));
  });

  it('uses cursor pagination for audit records', async () => {
    const first = Array.from({ length: 1000 }, (_, index) => ({ recordId: `audit:${index}`, value: { id: `audit:${index}`, chatKey: 'chat-a' }, version: 1, updatedAt: index }));
    const query = vi.fn().mockResolvedValueOnce({ records: first, nextCursor: 'next' }).mockResolvedValueOnce({ records: [{ recordId: 'audit:1000', value: { id: 'audit:1000', chatKey: 'chat-a' }, version: 1, updatedAt: 1000 }], nextCursor: null });
    const repository = new MemoryRepository(workspace({ query })); repository.bind('character:c1', 'chat-a');
    await expect(repository.listJobBatchAudits('chat-a')).resolves.toHaveLength(1001);
    expect(query).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: 'next' }));
  });

  it('uses workspace revisions and replays a committed job batch idempotently', async () => {
    const slotKey = createFactSlotKey('仓库', '储备');
    const previous = {
      id: 'fact-existing', chatKey: 'chat-a', kind: 'state' as const, subjectKey: '仓库', predicateKey: '储备', objectKey: '不足',
      canonicalKey: '仓库::储备::不足', slotKey, content: '仓库储备已经不足。', entityKeys: ['仓库'], confidence: 0.8,
      status: 'active' as const, sourceRefs: ['source-old'], evidenceIds: [], freshestEvidenceAt: 50, origin: 'automatic' as const,
      revision: 2, createdAt: 50, updatedAt: 50,
    };
    const slotRecordId = `fact-slot:${encodeURIComponent('chat-a')}:${encodeURIComponent(slotKey)}`;
    let committedUndo: WorkspaceRecord | null = null;
    const get = vi.fn(async (request: { collection?: string; recordId: string }) => {
      if (request.collection === 'job-audits' && request.recordId === 'undo-v2:job-a:1') return committedUndo;
      if (request.collection === 'fact-slots') return { recordId: slotRecordId, value: { chatKey: 'chat-a', slotKey, factId: previous.id }, version: 2, revision: 5, updatedAt: 50 } as WorkspaceRecord;
      return null;
    });
    const query = vi.fn(async (request: { collection?: string }) => ({
      records: request.collection === 'facts' ? [{ recordId: previous.id, value: previous, version: 7, revision: 11, updatedAt: 50 }] : [],
      nextCursor: null,
    }));
    const transaction = vi.fn(async (request) => {
      const undo = request.operations.find((operation: { recordId: string }) => operation.recordId === 'undo-v2:job-a:1');
      committedUndo = { recordId: undo.recordId, value: undo.value, version: 1, revision: 1, updatedAt: 100 } as WorkspaceRecord;
      return { operationCount: request.operations.length, replayed: false, results: [] };
    });
    const repository = new MemoryRepository(workspace({ get: get as never, query: query as never, transaction }));
    repository.bind('character:c1', 'chat-a');

    const first = await repository.commitIngest(commitInput());
    const second = await repository.commitIngest(commitInput());

    expect(second).toEqual(first);
    expect(transaction).toHaveBeenCalledTimes(1);
    const request = transaction.mock.calls[0][0];
    expect(request.idempotencyKey).toBe('undo-v2:job-a:1');
    expect(request.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ collection: 'facts', recordId: previous.id, expectedRevision: 11 }),
      expect.objectContaining({ collection: 'fact-slots', recordId: slotRecordId, expectedRevision: 5 }),
    ]));
    const undoValue = request.operations.find((operation: { recordId: string }) => operation.recordId === 'undo-v2:job-a:1').value;
    expect(undoValue.entries).toEqual(expect.arrayContaining([expect.objectContaining({ collection: 'facts', recordId: previous.id, beforeRevision: 11, afterRevision: 12 })]));
  });

  it('collapses consecutive UndoLogV2 changes into one atomic inverse write', async () => {
    const before = { id: 'fact-a', chatKey: 'chat-a', content: 'A' }; const middle = { id: 'fact-a', chatKey: 'chat-a', content: 'B' }; const after = { id: 'fact-a', chatKey: 'chat-a', content: 'C' };
    const logs = [
      { id: 'undo-v2:job-a:1', kind: 'undo-log-v2', chatKey: 'chat-a', jobId: 'job-a', batchIndex: 1, transactionId: 'tx-1', committedSequence: 1, createdAt: 1, entries: [{ collection: 'facts', recordId: 'fact-a', before, after: middle, beforeRevision: 1, afterRevision: 2 }] },
      { id: 'undo-v2:job-a:2', kind: 'undo-log-v2', chatKey: 'chat-a', jobId: 'job-a', batchIndex: 2, transactionId: 'tx-2', committedSequence: 2, createdAt: 2, entries: [{ collection: 'facts', recordId: 'fact-a', before: middle, after, beforeRevision: 2, afterRevision: 3 }] },
    ];
    const rows = logs.map((value, index) => ({ recordId: value.id, value, version: 1, revision: 1, updatedAt: index + 1 }));
    const get = vi.fn(async (request: { collection?: string; recordId: string }) => {
      if (request.recordId === 'rollback-v2:job-a:1') return null;
      if (request.collection === 'facts') return { recordId: 'fact-a', value: after, version: 3, revision: 3, updatedAt: 3 } as WorkspaceRecord;
      if (request.collection === 'jobs') return { recordId: 'job-a', value: { id: 'job-a', chatKey: 'chat-a', type: 'incremental', status: 'completed', checkpoint: { batchIndex: 2, processedCount: 2 }, createdAt: 1, updatedAt: 2 }, version: 2, revision: 2, updatedAt: 2 } as WorkspaceRecord;
      return null;
    });
    const query = vi.fn(async (request: { collection?: string }) => ({ records: request.collection === 'job-audits' ? rows : [], nextCursor: null }));
    const transaction = vi.fn(async (request) => ({ operationCount: request.operations.length, replayed: false, results: request.operations.map((operation: { collection?: string; recordId: string }) => ({ collection: operation.collection ?? 'default', recordId: operation.recordId, action: 'upsert' as const, version: 4, revision: 4 })) }));
    const vectorDelete = vi.fn(async () => true); const upsert = vi.fn(async (request) => ({ recordId: request.recordId, value: request.value!, version: 5, revision: 5, updatedAt: 5 }));
    const repository = new MemoryRepository(workspace({ get: get as never, query: query as never, transaction, vectorDelete, upsert })); repository.bind('character:c1', 'chat-a');

    await repository.rollbackJobBatch('job-a', 1, 'chat-a');

    const request = transaction.mock.calls[0][0];
    expect(request.operations.filter((operation: { collection?: string; recordId: string }) => operation.collection === 'facts' && operation.recordId === 'fact-a')).toEqual([{ action: 'upsert', collection: 'facts', recordId: 'fact-a', value: before, expectedRevision: 3 }]);
    expect(request.operations).toEqual(expect.arrayContaining([expect.objectContaining({ recordId: 'rollback-v2:job-a:1', collection: 'job-audits' })]));
    expect(vectorDelete).toHaveBeenCalledWith(expect.objectContaining({ recordId: 'fact-a' }));
  });

  it('rejects UndoLogV2 rollback when the latest record revision changed', async () => {
    const after = { id: 'fact-a', content: 'C' };
    const log = { id: 'undo-v2:job-a:1', kind: 'undo-log-v2', chatKey: 'chat-a', jobId: 'job-a', batchIndex: 1, transactionId: 'tx-1', committedSequence: 1, createdAt: 1, entries: [{ collection: 'facts', recordId: 'fact-a', before: { id: 'fact-a', content: 'A' }, after, beforeRevision: 1, afterRevision: 2 }] };
    const get = vi.fn(async (request: { recordId: string }) => request.recordId === 'rollback-v2:job-a:1' ? null : ({ recordId: 'fact-a', value: after, version: 3, revision: 3, updatedAt: 3 } as WorkspaceRecord));
    const query = vi.fn(async () => ({ records: [{ recordId: log.id, value: log, version: 1, revision: 1, updatedAt: 1 }], nextCursor: null }));
    const transaction = vi.fn(); const repository = new MemoryRepository(workspace({ get: get as never, query: query as never, transaction })); repository.bind('character:c1', 'chat-a');
    await expect(repository.rollbackJobBatch('job-a', 1, 'chat-a')).rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('scopes facts, evidence and record ownership to the bound chat key', async () => {
    const chatA = fact('fact-a', 'chat-a');
    const chatB = fact('fact-b', 'chat-b');
    const query = vi.fn(async (request: { collection?: string; filter?: Record<string, unknown> }) => {
      if (request.collection === 'facts') {
        const values = [chatA, chatB].filter(item => !request.filter?.chatKey || item.chatKey === request.filter.chatKey);
        return { records: values.map(value => ({ recordId: value.id, value, version: 1, updatedAt: 100 })), nextCursor: null };
      }
      if (request.collection === 'evidence') {
        const values = [
          { id: 'evidence:fact-a', factId: 'fact-a', chatKey: 'chat-a', sourceRef: 'source:a', sourceType: 'message', excerpt: 'A', occurredAt: 1, createdAt: 1 },
          { id: 'evidence:fact-b', factId: 'fact-b', chatKey: 'chat-b', sourceRef: 'source:b', sourceType: 'message', excerpt: 'B', occurredAt: 1, createdAt: 1 },
        ].filter(item => (!request.filter?.chatKey || item.chatKey === request.filter.chatKey) && (!request.filter?.factId || item.factId === request.filter.factId));
        return { records: values.map(value => ({ recordId: value.id, value, version: 1, updatedAt: 1 })), nextCursor: null };
      }
      return { records: [], nextCursor: null };
    });
    const get = vi.fn(async (request: { collection?: string; recordId: string }) => request.collection === 'facts' && request.recordId === chatB.id
      ? ({ recordId: chatB.id, value: chatB, version: 1, updatedAt: 100 } as WorkspaceRecord)
      : null);
    const transaction = vi.fn();
    const repository = new MemoryRepository(workspace({ query: query as never, get: get as never, transaction }));
    repository.bind('character:c1', 'chat-a');

    await expect(repository.listFacts('chat-a')).resolves.toEqual([chatA]);
    await expect(repository.searchFacts('chat-a', '独立记忆')).resolves.toEqual([chatA]);
    await expect(repository.listEvidence('chat-a', 'fact-a')).resolves.toHaveLength(1);
    await expect(repository.getFact('chat-a', 'fact-b')).resolves.toBeUndefined();
    await expect(repository.removeFact('chat-a', 'fact-b')).resolves.toBe(false);
    expect(transaction).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ collection: 'facts', filter: expect.objectContaining({ chatKey: 'chat-a' }) }));
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ collection: 'evidence', filter: { chatKey: 'chat-a', factId: 'fact-a' } }));
  });

  it('migrates legacy global slots into independent chat slots exactly once', async () => {
    const chatA = fact('fact-a', 'chat-a');
    const chatB = fact('fact-b', 'chat-b');
    const legacySlot = { recordId: chatA.slotKey, value: { factId: chatA.id }, version: 3, updatedAt: 100 } as WorkspaceRecord;
    const query = vi.fn(async (request: { collection?: string; filter?: Record<string, unknown> }) => {
      if (request.collection === 'facts') {
        const values = [chatA, chatB].filter(item => !request.filter?.chatKey || item.chatKey === request.filter.chatKey);
        return { records: values.map(value => ({ recordId: value.id, value, version: 1, updatedAt: 100 })), nextCursor: null };
      }
      if (request.collection === 'fact-slots') return { records: [legacySlot], nextCursor: null };
      return { records: [], nextCursor: null };
    });
    const writes: string[] = [];
    const upsert = vi.fn(async (request) => {
      writes.push(`upsert:${request.recordId}`);
      return { recordId: request.recordId, value: request.value!, version: 1, updatedAt: 1 };
    });
    const remove = vi.fn(async (request) => { writes.push(`delete:${request.recordId}`); return true; });
    const repository = new MemoryRepository(workspace({ query: query as never, upsert, delete: remove }));
    repository.bind('character:c1', 'chat-a');

    await repository.bootstrap('chat-a');
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ recordId: `fact-slot:${encodeURIComponent('chat-a')}:${encodeURIComponent(chatA.slotKey)}`, value: expect.objectContaining({ chatKey: 'chat-a', factId: 'fact-a' }) }));
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ recordId: `fact-slot:${encodeURIComponent('chat-b')}:${encodeURIComponent(chatB.slotKey)}`, value: expect.objectContaining({ chatKey: 'chat-b', factId: 'fact-b' }) }));
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ recordId: chatA.slotKey, expectedVersion: 3 }));
    expect(writes.slice(0, 2).every((entry) => entry.startsWith('upsert:'))).toBe(true);
    expect(writes.at(-1)).toBe(`delete:${chatA.slotKey}`);
    const firstRepairWriteCount = writes.length;
    await repository.bootstrap('chat-a');
    expect(writes).toHaveLength(firstRepairWriteCount);
  });

  it('filters vector coverage, search and clearing by chat metadata', async () => {
    const chatA = fact('fact-a', 'chat-a');
    const query = vi.fn(async (request: { collection?: string; filter?: Record<string, unknown> }) => ({
      records: request.collection === 'facts' && request.filter?.chatKey === 'chat-a'
        ? [{ recordId: chatA.id, value: chatA, version: 1, updatedAt: 100 }]
        : [],
      nextCursor: null,
    }));
    const vectorList = vi.fn(async (request) => ({ vectors: [{ collection: 'facts', recordId: chatA.id, model: 'embed-a', metadata: { chatKey: 'chat-a', resourceId: 'embedding-a', dimensions: 2 }, dimensions: 2, createdAt: 1, updatedAt: 1 }], nextCursor: null }));
    const vectorSearch = vi.fn(async () => [{ collection: 'facts', recordId: chatA.id, score: 0.9 }]);
    const vectorClear = vi.fn(async () => 1);
    const repository = new MemoryRepository(workspace({ query: query as never, vectorList, vectorSearch, vectorClear }));
    repository.bind('character:c1', 'chat-a');

    await expect(repository.getFactVectorCoverage('chat-a', { resourceId: 'embedding-a', model: 'embed-a', dimensions: 2 })).resolves.toMatchObject({ totalFacts: 1, ready: 1 });
    await repository.vectorSearch({ chatKey: 'chat-a', vector: [1, 0], resourceId: 'embedding-a', model: 'embed-a' });
    await repository.clearFactVectors('chat-a');

    expect(vectorList).toHaveBeenCalledWith(expect.objectContaining({ collection: 'facts', metadata: { chatKey: 'chat-a' } }));
    expect(vectorSearch).toHaveBeenCalledWith(expect.objectContaining({ metadata: { chatKey: 'chat-a', resourceId: 'embedding-a' } }));
    expect(vectorClear).toHaveBeenCalledWith(expect.objectContaining({ collection: 'facts', metadata: { chatKey: 'chat-a' } }));
  });

  it('clears only records and vectors owned by the current chat', async () => {
    const chatA = fact('fact-a', 'chat-a');
    const chatB = fact('fact-b', 'chat-b');
    const slotA = { chatKey: 'chat-a', slotKey: chatA.slotKey, factId: chatA.id };
    const slotB = { chatKey: 'chat-b', slotKey: chatB.slotKey, factId: chatB.id };
    const query = vi.fn(async (request: { collection?: string; filter?: Record<string, unknown> }) => {
      const source = request.collection === 'facts' ? [chatA, chatB]
        : request.collection === 'fact-slots' ? [slotA, slotB]
          : [];
      const values = source.filter(item => !request.filter?.chatKey || item.chatKey === request.filter.chatKey);
      return { records: values.map((value, index) => ({ recordId: 'id' in value ? value.id : `slot-${value.chatKey}`, value, version: index + 1, updatedAt: 1 })), nextCursor: null };
    });
    const transaction = vi.fn(async (request) => ({ operationCount: request.operations.length, replayed: false, results: [] }));
    const vectorClear = vi.fn(async () => 1);
    const repository = new MemoryRepository(workspace({ query: query as never, transaction, vectorClear }));
    repository.bind('character:c1', 'chat-a');

    await repository.clearCurrentChatData('chat-a');

    const deleted = transaction.mock.calls.flatMap(call => call[0].operations);
    expect(deleted).toEqual(expect.arrayContaining([
      expect.objectContaining({ collection: 'facts', recordId: 'fact-a' }),
      expect.objectContaining({ collection: 'fact-slots', recordId: 'slot-chat-a' }),
    ]));
    expect(deleted).not.toEqual(expect.arrayContaining([expect.objectContaining({ recordId: 'fact-b' })]));
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ collection: 'facts', filter: { chatKey: 'chat-a' } }));
    expect(new Set(query.mock.calls.map(call => call[0].collection))).toEqual(new Set([
      'evidence', 'jobs', 'job-audits', 'usage', 'recall-logs', 'facts', 'fact-slots', 'graph-nodes', 'graph-edges',
    ]));
    expect(vectorClear).toHaveBeenCalledWith(expect.objectContaining({ metadata: { chatKey: 'chat-a' } }));
  });

  it('reconciles fact-derived graph records idempotently and never writes another chat projection', async () => {
    const records = new Map<string, Map<string, { value: unknown; version: number }>>();
    const query = vi.fn(async (request: { collection: string; filter?: { chatKey?: string } }) => {
      const collection = records.get(request.collection) ?? new Map();
      const rows = [...collection.entries()]
        .filter(([, record]) => !request.filter?.chatKey || (record.value as { chatKey?: string }).chatKey === request.filter.chatKey)
        .map(([recordId, record]) => ({ recordId, value: record.value, version: record.version, updatedAt: 1 }));
      return { records: rows, nextCursor: null };
    });
    const transaction = vi.fn(async (request: { operations: Array<{ action: string; collection: string; recordId: string; value?: unknown }> }) => {
      for (const operation of request.operations) {
        const collection = records.get(operation.collection) ?? new Map();
        records.set(operation.collection, collection);
        if (operation.action === 'delete') collection.delete(operation.recordId);
        else collection.set(operation.recordId, { value: operation.value, version: (collection.get(operation.recordId)?.version ?? 0) + 1 });
      }
      return { operationCount: request.operations.length, replayed: false, results: [] };
    });
    const repository = new MemoryRepository(workspace({ query: query as never, transaction: transaction as never }));
    repository.bind('character:c1', 'chat-a');
    const relationA = { ...fact('relation-a', 'chat-a'), kind: 'relationship' as const, subjectKey: '艾琳', predicateKey: '认识', objectKey: '贝塔', confidence: 0.9 };
    const relationB = { ...fact('relation-b', 'chat-b'), kind: 'relationship' as const, subjectKey: '艾琳', predicateKey: '认识', objectKey: '跨聊天对象', confidence: 0.9 };
    const projection = deriveMemoryGraphProjection([relationA, relationB]);

    await repository.reconcileGraphProjection('chat-a', projection);
    await repository.reconcileGraphProjection('chat-a', projection);

    expect(records.get('graph-edges')?.size).toBe(1);
    expect([...records.get('graph-edges')!.values()][0]?.value).toMatchObject({ chatKey: 'chat-a', backingFactId: 'relation-a' });
    expect(records.get('graph-nodes')?.size).toBe(2);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('reports missing and conflicting chat identity during integrity checks', async () => {
    const chatA = fact('fact-a', 'chat-a');
    const query = vi.fn(async (request: { collection?: string }) => {
      if (request.collection === 'facts') return { records: [{ recordId: chatA.id, value: chatA, version: 1, updatedAt: 1 }], nextCursor: null };
      if (request.collection === 'evidence') return { records: [{ recordId: 'evidence:bad', value: { id: 'evidence:bad', factId: chatA.id, chatKey: 'chat-b' }, version: 1, updatedAt: 1 }], nextCursor: null };
      if (request.collection === 'fact-slots') return { records: [{ recordId: chatA.slotKey, value: { factId: chatA.id }, version: 1, updatedAt: 1 }], nextCursor: null };
      return { records: [], nextCursor: null };
    });
    const repository = new MemoryRepository(workspace({ query: query as never }));
    repository.bind('character:c1', 'chat-a');

    await expect(repository.checkIntegrity()).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/属于不同聊天.*旧式槽位/),
    });
  });
});
