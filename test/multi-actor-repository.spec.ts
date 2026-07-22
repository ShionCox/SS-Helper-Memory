import { describe, expect, it } from 'vitest';
import type { WorkspacePort, WorkspaceRecord } from '@ss-helper/sdk';
import { MultiActorMemoryRepository, type CaptureCommit } from '../src/infrastructure/multi-actor-memory-repository';

type RecordRequest = { collection?: string; recordId?: string; value?: unknown };
type QueryRequest = { collection?: string; filter?: Record<string, unknown> };
type TransactionRequest = { operations: readonly { action: 'delete' | 'upsert'; collection: string; recordId: string; value?: unknown }[] };

function port(): WorkspacePort {
  const collections = new Map<string, Map<string, { value: unknown; version: number; updatedAt: number }>>();
  const declaredIndexes = new Map<string, Set<string>>();
  const key = (collection: string, id: string) => `${collection}:${id}`;
  return {
    health: async () => ({ ready: true, database: 'memory', schemaVersion: 0 }),
    integrity: async () => ({ ok: true, messages: [] }),
    open: async (request: { workspaceId: string }) => ({ ownerPluginId: 'test', workspaceId: request.workspaceId, created: false }),
    list: async () => ({ workspaces: [], nextCursor: null }),
    removeWorkspace: async () => false,
    clearOwned: async () => 0,
    defineCollection: async (request: { name: string; indexes?: readonly string[] }) => {
      collections.set(request.name, collections.get(request.name) ?? new Map());
      declaredIndexes.set(request.name, new Set(request.indexes ?? []));
    },
    get: async (request: RecordRequest) => {
      const collection = request.collection ?? ''; const recordId = request.recordId ?? '';
      const record = collections.get(collection)?.get(key(collection, recordId));
      return record ? { recordId, ...record } : null;
    },
    upsert: async (request: RecordRequest) => {
      const collection = request.collection ?? ''; const recordId = request.recordId ?? '';
      const bucket = collections.get(collection) ?? new Map(); collections.set(collection, bucket);
      const current = bucket.get(key(collection, recordId)); const next = { value: structuredClone(request.value), version: (current?.version ?? 0) + 1, updatedAt: Date.now() };
      bucket.set(key(collection, recordId), next); return { recordId, ...next };
    },
    delete: async (request: RecordRequest) => { const collection = request.collection ?? ''; const recordId = request.recordId ?? ''; return Boolean(collections.get(collection)?.delete(key(collection, recordId))); },
    query: async (request: QueryRequest) => {
      const collection = request.collection ?? '';
      for (const field of Object.keys(request.filter ?? {})) {
        if (!declaredIndexes.get(collection)?.has(field)) {
          throw Object.assign(new Error(`Index ${field} must be declared first`), { code: 'WORKSPACE_INDEX_REQUIRED' });
        }
      }
      const bucket = collections.get(collection) ?? new Map();
      const records: WorkspaceRecord[] = [...bucket.entries()].map(([compound, value]) => ({ recordId: compound.slice(collection.length + 1), ...value } as WorkspaceRecord)).filter(record => Object.entries(request.filter ?? {}).every(([field, expected]) => (record.value as Record<string, unknown>)[field] === expected));
      return { records, nextCursor: null };
    },
    transaction: async (request: TransactionRequest) => {
      // The closure cannot call the object while constructing it; replay the
      // small operation set directly against the same maps instead.
      for (const operation of request.operations) {
        const bucket = collections.get(operation.collection) ?? new Map(); collections.set(operation.collection, bucket);
        if (operation.action === 'delete') bucket.delete(key(operation.collection, operation.recordId));
        else {
          const current = bucket.get(key(operation.collection, operation.recordId));
          bucket.set(key(operation.collection, operation.recordId), { value: structuredClone(operation.value), version: (current?.version ?? 0) + 1, updatedAt: Date.now() });
        }
      }
      return { operationCount: request.operations.length, replayed: false, results: [] };
    },
    vectorUpsert: async () => undefined, vectorSearch: async () => [], vectorDelete: async () => false, vectorList: async () => ({ vectors: [], nextCursor: null }), vectorClear: async () => 0,
    repair: async () => ({ repaired: true, backupId: 'test' }),
    grant: async () => undefined, revoke: async () => undefined, export: async () => new Blob(), import: async () => undefined, exportAll: async () => ({ archive: {}, sha256: '' }), importAll: async () => undefined,
  } as unknown as WorkspacePort;
}

function commit(traceStrength: number, rehearsalCount: number): CaptureCommit {
  const fact = { id: 'fact:f', workspaceId: 'w', chatKey: 'chat', kind: 'event' as const, subjectKey: 'A', predicateKey: '知道', canonicalKey: 'A::知道', content: 'A知道铜钥匙位置', entityKeys: ['owner:actor:a'], confidence: 0.9, status: 'active' as const, sourceRefs: ['source:s'], evidenceIds: ['evidence:f'], freshestEvidenceAt: 1, origin: 'automatic' as const, revision: 1, createdAt: 1, updatedAt: 1 };
  return {
    envelope: { workspaceId: 'w', chatKey: 'chat', sourceRefs: ['source:s'], actorCandidates: [], episodes: [], observations: [], facts: [], capturedAt: 1 },
    owners: [], aliases: [], episodes: [], observations: [], facts: [fact], evidence: [{ id: 'evidence:f', workspaceId: 'w', chatKey: 'chat', factId: fact.id, sourceRef: 'source:s', excerpt: 'A知道铜钥匙位置', occurredAt: 1, createdAt: 1 }],
    traces: [{ id: 'trace:owner:actor:a:fact:f', workspaceId: 'w', chatKey: 'chat', ownerId: 'owner:actor:a', factId: fact.id, sourceObservationIds: ['o1'], knowledgeMode: 'experienced', privacy: 'public', strength: traceStrength, clarity: 80, beliefConfidence: 0.8, emotionalSalience: 0.2, rehearsalCount, traceRevision: 1, createdAt: 1, updatedAt: 1 }],
  };
}

describe('multi-actor repository transaction semantics', () => {
  it('fails closed when a retired collection contains rows without workspace metadata', async () => {
    const workspace = port();
    const originalQuery = workspace.query.bind(workspace);
    workspace.query = async (request) => {
      if (request.collection === 'fact-slots') return { records: [{ recordId: 'legacy-slot', value: { chatKey: 'chat', slotKey: 'A::知道', factId: 'fact:f' }, version: 1, updatedAt: 1 }], nextCursor: null };
      return originalQuery(request);
    };
    const repository = new MultiActorMemoryRepository(workspace);
    repository.bind('w', 'chat');
    await expect(repository.open()).rejects.toMatchObject({ code: 'MEMORY_RETIRED_STORAGE_DETECTED' });
  });

  it('merges trace history and rolls back derived records with the same ChangeSet', async () => {
    const repository = new MultiActorMemoryRepository(port()); repository.bind('w', 'chat'); await repository.open();
    await repository.commitCapture(commit(40, 3));
    const audit = await repository.commitCapture(commit(30, 0));
    const trace = (await repository.listTraces())[0]!;
    expect(trace.rehearsalCount).toBe(3);
    expect(trace.strength).toBe(40);
    expect(trace.traceRevision).toBe(2);
    await repository.upsertDerivedForChangeSet(audit.id, [{ collection: 'memory-details', records: [{ id: 'detail:new', workspaceId: 'w', chatKey: 'chat', sourceChangeSetId: audit.id }] }]);
    await repository.rollbackChangeSet(audit.id);
    expect((await repository.listTraces())[0]!.rehearsalCount).toBe(3);
    expect((await repository.workspace.get({ workspaceId: 'w', collection: 'memory-details', recordId: 'detail:new' }))).toBeNull();
  });

  it('increments rehearsal only when a merged trace has a novel observation', async () => {
    const repository = new MultiActorMemoryRepository(port()); repository.bind('w', 'chat'); await repository.open();
    await repository.commitCapture(commit(40, 0));
    await repository.commitCapture({ ...commit(40, 0), traces: [{ ...commit(40, 0).traces[0]!, sourceObservationIds: ['o2'] }] });
    expect((await repository.listTraces())[0]!.rehearsalCount).toBe(1);
  });

  it('writes one fact head for a superseded predecessor and its replacement', async () => {
    const workspace = port();
    const repository = new MultiActorMemoryRepository(workspace); repository.bind('w', 'chat'); await repository.open();
    const base = commit(0, 0);
    const predecessor = { ...base.facts[0]!, status: 'superseded' as const, supersededById: 'fact:new', revision: 2, updatedAt: 2 };
    const replacement = { ...base.facts[0]!, id: 'fact:new', content: 'A知道新的铜钥匙位置', revision: 1, supersedesId: predecessor.id, updatedAt: 3 };
    await repository.commitCapture({ ...base, facts: [predecessor, replacement], traces: [], evidence: [] });
    const head = await workspace.get({ workspaceId: 'w', collection: 'fact-heads', recordId: 'fact-head:chat:A%3A%3A%E7%9F%A5%E9%81%93' });
    expect(head?.value).toMatchObject({ factId: 'fact:new' });
  });

  it('persists pending actor candidates and removes them after confirmation state is committed', async () => {
    const repository = new MultiActorMemoryRepository(port()); repository.bind('w', 'chat'); await repository.open();
    const pending = { localId: 'candidate:1', displayName: '疑似人物', aliases: [], sourceRefs: ['source:s'], evidenceExcerpts: ['A知道铜钥匙位置'], confidence: 0.5, status: 'pending' as const };
    await repository.commitCapture({ ...commit(40, 0), pendingCandidates: [pending] });
    expect(await repository.listPendingCandidates()).toMatchObject([pending]);
    await repository.upsertActorRegistryState([], [], { operation: 'confirm' }, undefined, []);
    expect(await repository.listPendingCandidates()).toEqual([]);
  });

  it('stores leakage diagnostics as hashed metrics without output text', async () => {
    const repository = new MultiActorMemoryRepository(port()); repository.bind('w', 'chat'); await repository.open();
    await repository.recordKnowledgeLeakageAudit({
      outputHash: 'out-hash', checkedOwners: ['owner:actor:a', 'owner:actor:b'], violationCount: 1,
      violations: [{ ownerId: 'owner:actor:b', leakedFromOwnerId: 'owner:actor:a', marker: 'marker-hash' }],
    });
    const audit = (await repository.listChangeAudits()).at(-1)!;
    expect(audit.metadata).toMatchObject({ diagnosticType: 'knowledge-leakage', outputHash: 'out-hash', violationCount: 1 });
    expect(JSON.stringify(audit)).not.toContain('秘密正文');
  });

  it('persists capture progress through the v0 capture-jobs surface', async () => {
    const repository = new MultiActorMemoryRepository(port());
    repository.bind('w', 'chat');
    await repository.open();
    await repository.upsertCaptureJob({
      id: 'capture-job:init',
      workspaceId: 'w',
      chatKey: 'chat',
      type: 'initialize',
      status: 'running',
      checkpoint: { batchIndex: 0, totalBatches: 1, processedCount: 0, phase: 'capture' },
      createdAt: 1,
      updatedAt: 1,
    });
    expect(await repository.listCaptureJobs()).toMatchObject([{ id: 'capture-job:init', type: 'initialize', status: 'running' }]);
    await expect(repository.upsertCaptureJob({ id: 'capture-job:other', workspaceId: 'w', chatKey: 'other', status: 'failed' })).rejects.toThrow('当前聊天');
  });

  it('folds the progress job into Capture undo instead of leaving a completed initialization behind', async () => {
    const repository = new MultiActorMemoryRepository(port());
    repository.bind('w', 'chat');
    await repository.open();
    await repository.upsertCaptureJob({ id: 'job:init', workspaceId: 'w', chatKey: 'chat', type: 'initialize', status: 'running', checkpoint: { batchIndex: 0, totalBatches: 1, processedCount: 0 }, createdAt: 1, updatedAt: 1 });
    const audit = await repository.commitCapture({ ...commit(40, 0), captureJobId: 'job:init' });
    expect((await repository.listCaptureJobs()).find(item => item.id === 'job:init')).toMatchObject({ status: 'completed', type: 'initialize' });
    await repository.rollbackChangeSet(audit.id);
    expect((await repository.listCaptureJobs()).find(item => item.id === 'job:init')).toMatchObject({ status: 'paused', type: 'initialize' });
  });

  it('clears observations through their current-chat episode without touching another chat', async () => {
    const repository = new MultiActorMemoryRepository(port());
    repository.bind('w', 'chat-a');
    await repository.open();
    const observation = {
      id: 'observation:chat-a:1', workspaceId: 'w', episodeId: 'episode:chat-a:1', sourceRef: 'source:a',
      speakerOwnerId: 'owner:actor:a', viewpointOwnerId: 'owner:actor:a', observerOwnerIds: ['owner:actor:a'],
      channel: 'public_speech' as const, privacy: 'public' as const, knowledgeMode: 'self_reported' as const,
      excerpt: 'A说话。', mentionedOwnerIds: [], presentOwnerIds: ['owner:actor:a'], factLocalIds: [], occurredAt: 1, createdAt: 1,
    };
    const episode = { id: 'episode:chat-a:1', workspaceId: 'w', chatKey: 'chat-a', sourceRefs: ['source:a'], participantIds: ['owner:actor:a'], presentOwnerIds: ['owner:actor:a'], mentionedOwnerIds: [], occurredAt: 1, createdAt: 1 };
    await repository.commitCapture({ ...commit(0, 0), envelope: { ...commit(0, 0).envelope, chatKey: 'chat-a' }, episodes: [episode], observations: [observation], facts: [], traces: [] });
    repository.bind('w', 'chat-b');
    await repository.commitCapture({ ...commit(0, 0), envelope: { ...commit(0, 0).envelope, chatKey: 'chat-b' }, episodes: [{ ...episode, id: 'episode:chat-b:1', chatKey: 'chat-b', sourceRefs: ['source:b'] }], observations: [{ ...observation, id: 'observation:chat-b:1', episodeId: 'episode:chat-b:1', sourceRef: 'source:b' }], facts: [], traces: [] });
    repository.bind('w', 'chat-a');
    await repository.clearCurrentChatData();
    const remaining = await repository.listObservations();
    expect(remaining.map(item => item.id)).toEqual(['observation:chat-b:1']);
  });

  it('routes manual fact edits through v0 evidence, head and trace invalidation', async () => {
    const workspace = port();
    const repository = new MultiActorMemoryRepository(workspace);
    repository.bind('w', 'chat');
    await repository.open();
    const fact = await repository.upsertManualFact({
      kind: 'event',
      subjectKey: 'A',
      predicateKey: '知道',
      content: 'A知道铜钥匙位置',
      entityKeys: ['owner:actor:a'],
      confidence: 0.9,
    });
    expect((await repository.listFacts()).map(item => item.id)).toEqual([fact.id]);
    expect(await repository.listEvidence(fact.id)).toMatchObject([{ factId: fact.id, sourceType: 'manual', excerpt: fact.content }]);
    const headId = `fact-head:${encodeURIComponent('chat')}:${encodeURIComponent(fact.slotKey!)}`;
    expect(await workspace.get({ workspaceId: 'w', collection: 'fact-heads', recordId: headId })).toMatchObject({ value: { factId: fact.id } });
    const traceId = `trace:owner:actor:a:${fact.id}`;
    await workspace.upsert({ workspaceId: 'w', collection: 'memory-traces', recordId: traceId, value: { id: traceId, workspaceId: 'w', chatKey: 'chat', ownerId: 'owner:actor:a', factId: fact.id, sourceObservationIds: [], knowledgeMode: 'asserted', privacy: 'public', strength: 80, clarity: 80, beliefConfidence: 1, emotionalSalience: 0, rehearsalCount: 0, traceRevision: 1, createdAt: 1, updatedAt: 1 } });
    await workspace.upsert({ workspaceId: 'w', collection: 'profile-claims', recordId: 'profile:test', value: { id: 'profile:test', workspaceId: 'w', ownerId: 'owner:actor:a', claim: fact.content, level: 3, supportingTraceIds: [traceId], confidence: 1, status: 'active', createdAt: 1, updatedAt: 1 } });
    const updated = await repository.upsertManualFact({ ...fact, id: fact.id, content: 'A知道新的铜钥匙位置' });
    expect(updated.revision).toBe(2);
    expect((await repository.listFacts())[0]?.content).toBe('A知道新的铜钥匙位置');
    expect(await workspace.get({ workspaceId: 'w', collection: 'profile-claims', recordId: 'profile:test' })).toBeNull();
    expect(await repository.removeFact(fact.id)).toBe(true);
    expect(await repository.listFacts()).toEqual([]);
    expect(await workspace.get({ workspaceId: 'w', collection: 'fact-heads', recordId: headId })).toBeNull();
  });
});
