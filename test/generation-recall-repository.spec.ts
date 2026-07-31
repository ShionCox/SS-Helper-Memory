import { describe, expect, it, vi } from 'vitest';
import type { PlainData, WorkspacePort, WorkspaceSession } from '@ss-helper/sdk';
import type { GenerationRecallDetail, MainChatUsage } from '../src/domain';
import { MemoryRepository } from '../src/infrastructure/memory-repository';

function workspaceFixture() {
  const recordsByWorkspace = new Map<string, Map<string, { value: PlainData; revision: number }>>();
  const commits: Array<{ workspaceId: string; request: Parameters<WorkspaceSession['commit']>[0] }> = [];
  const sessions = new Map<string, WorkspaceSession>();
  const open = vi.fn(async ({ id }: Parameters<WorkspacePort['open']>[0]) => {
    let session = sessions.get(id);
    if (session) return session;
    const records = recordsByWorkspace.get(id) ?? new Map();
    recordsByWorkspace.set(id, records);
    session = {
      id,
      get: vi.fn(async (collection: string, recordId: string) => {
        const record = records.get(`${collection}\0${recordId}`);
        return record ? { id: recordId, value: record.value, revision: record.revision, updatedAt: 1 } : null;
      }),
      query: vi.fn(async (collection: string, options: {
        filter?: Record<string, PlainData>;
        where?: Array<{ field: string; op: 'eq' | 'in'; value: PlainData }>;
        orderBy?: { field: string; direction: 'asc' | 'desc' };
      }) => ({
        records: [...records.entries()].flatMap(([key, record]) => {
          const [storedCollection, recordId] = key.split('\0');
          if (storedCollection !== collection) return [];
          const value = record.value as Record<string, PlainData>;
          if (options.filter && Object.entries(options.filter).some(([field, expected]) => value[field] !== expected)) return [];
          if (options.where?.some((predicate) => {
            const current = value[predicate.field];
            return predicate.op === 'in'
              ? !Array.isArray(predicate.value) || !predicate.value.includes(current)
              : current !== predicate.value;
          })) return [];
          return [{ id: recordId!, value: record.value, revision: record.revision, updatedAt: 1 }];
        }).sort((left, right) => {
          if (!options.orderBy) return 0;
          const leftValue = (left.value as Record<string, PlainData>)[options.orderBy.field];
          const rightValue = (right.value as Record<string, PlainData>)[options.orderBy.field];
          const direction = options.orderBy.direction === 'desc' ? -1 : 1;
          return typeof leftValue === 'number' && typeof rightValue === 'number'
            ? (leftValue - rightValue) * direction
            : String(leftValue).localeCompare(String(rightValue)) * direction;
        }),
        nextCursor: null,
      })),
      commit: vi.fn(async (request: Parameters<WorkspaceSession['commit']>[0]) => {
        commits.push({ workspaceId: id, request });
        const results = request.operations.map((operation) => {
          const key = `${operation.collection}\0${operation.id}`;
          const previous = records.get(key);
          if (operation.action === 'put') records.set(key, { value: operation.value, revision: (previous?.revision ?? 0) + 1 });
          else records.delete(key);
          return {
            collection: operation.collection,
            id: operation.id,
            action: operation.action,
            revision: (previous?.revision ?? 0) + 1,
          };
        });
        return { requestId: request.idempotencyKey, replayed: false, results };
      }),
      vectors: {
        upsert: vi.fn(),
        search: vi.fn(async () => []),
        delete: vi.fn(async () => false),
        list: vi.fn(async () => ({ vectors: [], nextCursor: null })),
        clear: vi.fn(async () => 0),
      },
    } as unknown as WorkspaceSession;
    sessions.set(id, session);
    return session;
  });
  const port = {
    open,
    admin: {
      health: vi.fn(async () => ({ ready: true, database: 'test.sqlite', schemaVersion: 0 })),
      integrity: vi.fn(),
      reset: vi.fn(),
      backup: vi.fn(),
    },
  } as unknown as WorkspacePort;
  return { port, commits, sessions, open };
}

describe('generation recall persistence', () => {
  it('never carries a previous chat usage number into a newly bound chat', async () => {
    const fixture = workspaceFixture();
    const repository = new MemoryRepository(fixture.port);
    repository.bind('character:test', 'chat-a');
    await repository.open();
    (repository as unknown as { healthSnapshot: Record<string, unknown> }).healthSnapshot = {
      connected: true,
      currentChatSizeBytes: 9_999,
      workspaceSizeBytes: 20_000,
      tableCounts: {},
      tableBytes: {},
    };
    repository.bind('character:test', 'chat-b');
    expect(repository.getHealthSnapshot()?.currentChatSizeBytes).toBe(0);
  });

  it('atomically stores and verifies a chunked final prompt snapshot without placing it in the recall detail', async () => {
    const fixture = workspaceFixture();
    const repository = new MemoryRepository(fixture.port);
    repository.bind('character:test', 'chat');
    await repository.open();
    fixture.commits.length = 0;
    const secret = 'SENSITIVE_CHAT_SENTINEL';
    const snapshot = await repository.prepareGenerationPromptSnapshot(
      { workspaceId: 'character:test', chatKey: 'chat' },
      'generation-recall:snapshot',
      'MEMORY_INJECTION_SENTINEL',
      { kind: 'chat', messages: [{ role: 'user', content: secret }, { role: 'system', content: 'MEMORY_INJECTION_SENTINEL' }] },
      10,
    );
    const detail = {
      id: 'generation-recall:snapshot', workspaceId: 'character:test', chatKey: 'chat', planId: 'plan', messageId: '16', messageIndex: 16,
      outputFingerprint: 'hash', triggerFloor: 15, createdAt: 10, viewpointOwnerId: 'owner:a',
      coverage: { covered: true, missingSubQueryIds: [], missingOwnerIds: [], missingTimeDimensions: [], privacyViolations: [], temporalConflicts: [], requiresExpansion: false },
      expanded: false,
      prompt: { maxChars: 8000, usedChars: 25, includedCount: 1, omittedCount: 0, includedTraceIds: ['trace:1'], omittedTraceIds: [] },
      promptSnapshot: snapshot.metadata,
      attempts: [],
    } satisfies GenerationRecallDetail;
    const usage = {
      id: 'main-usage:generation-recall:snapshot', chatKey: 'chat', messageId: '16', generationRecallDetailId: detail.id,
      promptTokens: null, completionTokens: null, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null, capturedAt: 10,
    } satisfies MainChatUsage;
    await repository.commitMainChatGeneration(usage, detail, snapshot);
    expect(fixture.commits.at(-1)?.request.operations.map(operation => operation.collection)).toEqual([
      'usage', 'generation-recall-details', 'generation-prompt-snapshots', 'generation-prompt-snapshot-chunks',
    ]);
    expect(JSON.stringify(detail)).not.toContain(secret);
    const loaded = await repository.loadGenerationPromptSnapshot('character:test', 'chat', snapshot.manifest.id);
    expect(loaded?.manifest.verifiedIncludesMemory).toBe(true);
    expect(loaded?.request).toEqual({ kind: 'chat', messages: [{ role: 'user', content: secret }, { role: 'system', content: 'MEMORY_INJECTION_SENTINEL' }] });
    await expect(repository.applyGenerationRecallMessageDeletion('chat', 16, 1, 20)).resolves.toBe(1);
    await expect(repository.loadGenerationPromptSnapshot('character:test', 'chat', snapshot.manifest.id)).resolves.toBeUndefined();
    const [invalidated] = await repository.listGenerationRecallDetails('chat');
    expect(invalidated).toEqual(expect.objectContaining({ id: detail.id, previewState: 'invalidated', invalidationReason: 'message_deleted' }));
    expect(invalidated).not.toHaveProperty('promptSnapshot');
  });

  it('commits usage and message detail atomically and treats the duplicate event as a no-op', async () => {
    const fixture = workspaceFixture();
    const repository = new MemoryRepository(fixture.port);
    repository.bind('character:test', 'chat');
    await repository.open();
    fixture.commits.length = 0;
    const detail = {
      id: 'generation-recall:1',
      workspaceId: 'character:test',
      chatKey: 'chat',
      planId: 'plan',
      messageId: '14',
      messageIndex: 14,
      outputFingerprint: 'hash',
      triggerFloor: 13,
      createdAt: 10,
      viewpointOwnerId: 'owner:a',
      coverage: {
        covered: true,
        missingSubQueryIds: [],
        missingOwnerIds: [],
        missingTimeDimensions: [],
        privacyViolations: [],
        temporalConflicts: [],
        requiresExpansion: false,
      },
      expanded: false,
      prompt: {
        maxChars: 8000,
        usedChars: 200,
        includedCount: 1,
        omittedCount: 0,
        includedTraceIds: ['trace:1'],
        omittedTraceIds: [],
      },
      attempts: [],
    } satisfies GenerationRecallDetail;
    const usage = {
      id: 'main-usage:generation-recall:1',
      chatKey: 'chat',
      messageId: '14',
      generationRecallDetailId: detail.id,
      promptTokens: null,
      completionTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: null,
      capturedAt: 10,
    } satisfies MainChatUsage;

    await repository.commitMainChatGeneration(usage, detail);
    expect(fixture.commits).toHaveLength(1);
    await expect(repository.getGenerationRecallDetail('character:test', 'chat', detail.id)).resolves.toEqual(detail);
    await expect(repository.getGenerationRecallDetail('character:test', 'chat', 'generation-recall:missing')).resolves.toBeUndefined();
    await expect(repository.getGenerationRecallDetail('character:test', 'other-chat', detail.id)).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
      details: { stage: 'memory.repository.generation-recall.detail-scope' },
    });
    expect(fixture.commits[0]?.request.operations.map(operation => operation.collection))
      .toEqual(['usage', 'generation-recall-details']);
    expect(fixture.commits[0]?.request.idempotencyKey).toBe(`generation-recall:${detail.id}`);

    await repository.commitMainChatGeneration(usage, detail);
    expect(fixture.commits).toHaveLength(1);
    await expect(repository.listGenerationRecallDetails('chat')).resolves.toEqual([detail]);
    await expect(repository.findGenerationRecallDetailsForTargets('character:test', 'chat', [{
      messageIds: ['14'],
      messageIndex: 14,
    }])).resolves.toEqual([detail]);
    await expect(repository.findGenerationRecallDetailsForTargets('character:test', 'chat', [{
      messageIds: ['missing-id'],
      messageIndex: 14,
    }])).resolves.toEqual([detail]);
    await expect(repository.findGenerationRecallDetailsForTargets('character:test', 'chat', [{
      messageIds: ['14'],
      messageIndex: 999,
    }])).resolves.toEqual([detail]);
    const query = fixture.sessions.get('character:test')!.query as ReturnType<typeof vi.fn>;
    expect(query.mock.calls.some(([, options]) =>
      options.where?.some((predicate: { field: string; op: string }) =>
        predicate.field === 'messageId' && predicate.op === 'in'))).toBe(true);
    expect(query.mock.calls.some(([, options]) =>
      options.where?.some((predicate: { field: string; op: string }) =>
        predicate.field === 'messageIndex' && predicate.op === 'in'))).toBe(true);

    const laterDetail = { ...detail, id: 'generation-recall:later', messageId: '16', messageIdIsSynthetic: true as const, messageIndex: 16 };
    const laterUsage = { ...usage, id: 'main-usage:generation-recall:later', messageId: '16', generationRecallDetailId: laterDetail.id };
    const deletedDetail = { ...detail, id: 'generation-recall:deleted', messageId: '15', messageIndex: 15 };
    const deletedUsage = { ...usage, id: 'main-usage:generation-recall:deleted', messageId: '15', generationRecallDetailId: deletedDetail.id };
    await repository.commitMainChatGeneration(deletedUsage, deletedDetail);
    await repository.commitMainChatGeneration(laterUsage, laterDetail);
    await expect(repository.applyGenerationRecallMessageDeletion('chat', 15, 1, 20)).resolves.toBe(2);
    await expect(repository.listGenerationRecallDetails('chat')).resolves.toEqual(expect.arrayContaining([
      detail,
      expect.objectContaining({ id: deletedDetail.id, previewState: 'invalidated', invalidatedAt: 20, invalidationReason: 'message_deleted' }),
      expect.objectContaining({ id: laterDetail.id, messageId: '15', messageIndex: 15 }),
    ]));
    await expect(repository.findGenerationRecallDetailsForTargets('character:test', 'chat', [{ messageIds: ['15'], messageIndex: 15 }]))
      .resolves.toEqual([expect.objectContaining({ id: laterDetail.id, messageIndex: 15 })]);
  });

  it('opens only the recall-detail collection for an early action lookup', async () => {
    const fixture = workspaceFixture();
    const repository = new MemoryRepository(fixture.port);

    await expect(repository.findGenerationRecallDetailsForTargets('character:early', 'chat', [{
      messageIds: ['8'],
      messageIndex: 8,
    }])).resolves.toEqual([]);

    const request = fixture.open.mock.calls[0]?.[0];
    expect(request?.schema.collections).toEqual([{
      name: 'generation-recall-details',
      indexes: ['workspaceId', 'chatKey', 'messageId', 'messageIndex', 'variantId', 'createdAt'],
    }]);
  });

  it('rejects an incomplete Workspace commit result instead of treating the dual write as successful', async () => {
    const fixture = workspaceFixture();
    const repository = new MemoryRepository(fixture.port);
    repository.bind('character:test', 'chat');
    await repository.open();
    const session = fixture.sessions.get('character:test')!;
    session.commit = vi.fn(async (request) => ({
      requestId: request.idempotencyKey,
      replayed: false,
      results: [],
    }));
    const detail = {
      id: 'generation-recall:invalid-result',
      workspaceId: 'character:test',
      chatKey: 'chat',
      planId: 'plan',
      messageId: '15',
      messageIndex: 15,
      outputFingerprint: 'hash',
      triggerFloor: 14,
      createdAt: 10,
      viewpointOwnerId: 'owner:a',
      coverage: { covered: true, missingSubQueryIds: [], missingOwnerIds: [], missingTimeDimensions: [], privacyViolations: [], temporalConflicts: [], requiresExpansion: false },
      expanded: false,
      prompt: { maxChars: 8000, usedChars: 200, includedCount: 1, omittedCount: 0, includedTraceIds: ['trace:1'], omittedTraceIds: [] },
      attempts: [],
    } satisfies GenerationRecallDetail;
    const usage = {
      id: 'main-usage:generation-recall:invalid-result',
      chatKey: 'chat',
      messageId: '15',
      generationRecallDetailId: detail.id,
      promptTokens: null,
      completionTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: null,
      capturedAt: 10,
    } satisfies MainChatUsage;

    await expect(repository.commitMainChatGeneration(usage, detail)).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
      details: { reasonCode: 'INVALID_PAYLOAD', stage: 'memory.repository.generation-recall.result' },
    });
  });

  it('invalidates edited and deleted swipe variants while reindexing later variants', async () => {
    const fixture = workspaceFixture();
    const repository = new MemoryRepository(fixture.port);
    repository.bind('character:test', 'chat');
    await repository.open();
    const base = {
      workspaceId: 'character:test', chatKey: 'chat', planId: 'plan', messageId: '8', messageIndex: 8,
      outputFingerprint: 'old-fingerprint', triggerFloor: 7, createdAt: 10, viewpointOwnerId: 'owner:a',
      coverage: { covered: true, missingSubQueryIds: [], missingOwnerIds: [], missingTimeDimensions: [], privacyViolations: [], temporalConflicts: [], requiresExpansion: false },
      expanded: false,
      prompt: { maxChars: 8000, usedChars: 10, includedCount: 0, omittedCount: 0, includedTraceIds: [], omittedTraceIds: [] },
      attempts: [],
    } satisfies Omit<GenerationRecallDetail, 'id' | 'variantId'>;
    for (const variantId of ['0', '1', '2']) {
      const detail = { ...base, id: `generation-recall:swipe:${variantId}`, variantId } satisfies GenerationRecallDetail;
      await repository.commitMainChatGeneration({
        id: `main-usage:${detail.id}`, chatKey: 'chat', messageId: '8', generationRecallDetailId: detail.id,
        promptTokens: null, completionTokens: null, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null, capturedAt: 10,
      }, detail);
    }

    await expect(repository.applyGenerationRecallSwipeDeletion('chat', 8, '1', 20)).resolves.toBe(2);
    let details = await repository.listGenerationRecallDetails('chat');
    expect(details.find(item => item.id.endsWith(':1'))).toEqual(expect.objectContaining({ previewState: 'invalidated', invalidationReason: 'swipe_deleted' }));
    expect(details.find(item => item.id.endsWith(':2'))?.variantId).toBe('1');

    await expect(repository.applyGenerationRecallMessageEdit('chat', {
      id: '8', index: 8, role: 'assistant', text: 'new body', variantId: '0', author: { kind: 'assistant' },
    }, 30)).resolves.toBe(1);
    details = await repository.listGenerationRecallDetails('chat');
    expect(details.find(item => item.id.endsWith(':0'))).toEqual(expect.objectContaining({ previewState: 'invalidated', invalidationReason: 'message_edited' }));
  });
});
