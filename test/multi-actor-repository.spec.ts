import { describe, expect, it, vi } from 'vitest';
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

  it('legacy traces without chatKey are visible only when their fact belongs to the current chat', async () => {
    const workspace = port();
    const repository = new MultiActorMemoryRepository(workspace);
    repository.bind('w', 'chat-a');
    await repository.open();
    const base = commit(40, 0);
    const factA = { ...base.facts[0]!, id: 'fact:a', chatKey: 'chat-a' };
    const factB = { ...base.facts[0]!, id: 'fact:b', chatKey: 'chat-b' };
    const { chatKey: _traceChatKey, ...legacyTrace } = base.traces[0]!;
    await workspace.upsert({ workspaceId: 'w', collection: 'facts', recordId: factA.id, value: factA as never });
    await workspace.upsert({ workspaceId: 'w', collection: 'facts', recordId: factB.id, value: factB as never });
    await workspace.upsert({ workspaceId: 'w', collection: 'memory-traces', recordId: 'trace:a', value: { ...legacyTrace, id: 'trace:a', factId: factA.id } as never });
    await workspace.upsert({ workspaceId: 'w', collection: 'memory-traces', recordId: 'trace:b', value: { ...legacyTrace, id: 'trace:b', factId: factB.id } as never });

    expect((await repository.listTraces()).map(item => item.id)).toEqual(['trace:a']);
  });

  it('rejects foreign-chat audits and derived records at the repository boundary', async () => {
    const workspace = port();
    const repository = new MultiActorMemoryRepository(workspace);
    repository.bind('w', 'chat-a');
    await repository.open();
    const foreignAudit = { id: 'audit:foreign', workspaceId: 'w', chatKey: 'chat-b', kind: 'derived-change-set-v0', createdAt: 1, entries: [] };
    await workspace.upsert({ workspaceId: 'w', collection: 'change-audits', recordId: foreignAudit.id, value: foreignAudit });

    await expect(repository.getChangeAudit(foreignAudit.id)).resolves.toBeUndefined();
    await expect(repository.rollbackChangeSet(foreignAudit.id)).rejects.toThrow('当前聊天');
    await expect(repository.upsertDerivedForChangeSet(foreignAudit.id, [{
      collection: 'memory-details', records: [{ id: 'detail:foreign', workspaceId: 'w', chatKey: 'chat-a' }],
    }])).rejects.toThrow('当前聊天');
    await expect(repository.upsertDerived('memory-details', [{ id: 'detail:wrong-chat', workspaceId: 'w', chatKey: 'chat-b' }])).rejects.toThrow('当前聊天');
  });

  it('does not mutate a foreign-chat fact referenced by a forged version link', async () => {
    const workspace = port();
    const repository = new MultiActorMemoryRepository(workspace);
    repository.bind('w', 'chat-a');
    await repository.open();
    const base = commit(0, 0).facts[0]!;
    const target = { ...base, id: 'fact:target', chatKey: 'chat-a', supersededById: 'fact:foreign' };
    const foreign = { ...base, id: 'fact:foreign', chatKey: 'chat-b', supersedesId: target.id, content: '另一聊天的事实' };
    await workspace.upsert({ workspaceId: 'w', collection: 'facts', recordId: target.id, value: target as never });
    await workspace.upsert({ workspaceId: 'w', collection: 'facts', recordId: foreign.id, value: foreign as never });

    expect(await repository.removeFact(target.id)).toBe(true);
    expect(await workspace.get({ workspaceId: 'w', collection: 'facts', recordId: target.id })).toBeNull();
    expect(await workspace.get({ workspaceId: 'w', collection: 'facts', recordId: foreign.id })).toMatchObject({ value: foreign });
  });

  it('atomically migrates every current-chat owner reference and rolls the migration back', async () => {
    const workspace = port();
    const repository = new MultiActorMemoryRepository(workspace);
    repository.bind('w', 'chat');
    await repository.open();
    const fromOwnerId = 'owner:actor:pending';
    const toOwnerId = 'owner:actor:confirmed';
    const factId = 'fact:migration';
    const oldTraceId = `trace:${fromOwnerId}:${factId}`;
    const newTraceId = `trace:${toOwnerId}:${factId}`;
    const oldNodeId = `graph-node:w:${encodeURIComponent('chat')}:${encodeURIComponent(fromOwnerId)}`;
    const newNodeId = `graph-node:w:${encodeURIComponent('chat')}:${encodeURIComponent(toOwnerId)}`;
    const sourceOwner = { id: fromOwnerId, workspaceId: 'w', kind: 'actor', displayName: '临时人物', canonicalName: '临时人物', aliases: ['临时人物'], status: 'pending', discoverySources: ['prompt'], confidence: 0.8, createdAt: 1, updatedAt: 1 };
    const targetOwner = { ...sourceOwner, id: toOwnerId, displayName: '正式人物', canonicalName: '正式人物', aliases: ['正式人物'], status: 'confirmed' };
    await workspace.upsert({ workspaceId: 'w', collection: 'actors', recordId: fromOwnerId, value: sourceOwner as never });
    await workspace.upsert({ workspaceId: 'w', collection: 'actors', recordId: toOwnerId, value: targetOwner as never });
    await workspace.upsert({ workspaceId: 'w', collection: 'episodes', recordId: 'episode:migration', value: { id: 'episode:migration', workspaceId: 'w', chatKey: 'chat', sourceRefs: ['m1'], participantIds: [fromOwnerId], presentOwnerIds: [fromOwnerId], mentionedOwnerIds: [fromOwnerId], occurredAt: 1, createdAt: 1 } });
    await workspace.upsert({ workspaceId: 'w', collection: 'observations', recordId: 'observation:migration', value: { id: 'observation:migration', workspaceId: 'w', episodeId: 'episode:migration', sourceRef: 'm1', speakerOwnerId: fromOwnerId, viewpointOwnerId: fromOwnerId, observerOwnerIds: [fromOwnerId], channel: 'public_speech', privacy: 'public', knowledgeMode: 'self_reported', excerpt: '临时人物说话', mentionedOwnerIds: [fromOwnerId], presentOwnerIds: [fromOwnerId], factLocalIds: [factId], occurredAt: 1, createdAt: 1 } });
    await workspace.upsert({ workspaceId: 'w', collection: 'facts', recordId: factId, value: { ...commit(0, 0).facts[0]!, id: factId, subjectEntityId: fromOwnerId, entityKeys: [fromOwnerId] } as never });
    await workspace.upsert({ workspaceId: 'w', collection: 'memory-traces', recordId: oldTraceId, value: { ...commit(40, 1).traces[0]!, id: oldTraceId, ownerId: fromOwnerId, factId } as never });
    await workspace.upsert({ workspaceId: 'w', collection: 'scene-casts', recordId: 'scene:migration', value: { id: 'scene:migration', workspaceId: 'w', chatKey: 'chat', floor: 1, members: [{ ownerId: fromOwnerId, role: 'speaker', confidence: 1, sourceRefs: ['m1'] }], viewpointOwnerId: fromOwnerId, speakerOwnerIds: [fromOwnerId], presentOwnerIds: [fromOwnerId], mentionedOwnerIds: [fromOwnerId], createdAt: 1 } });
    await workspace.upsert({ workspaceId: 'w', collection: 'profile-claims', recordId: 'claim:migration', value: { id: 'claim:migration', workspaceId: 'w', chatKey: 'chat', ownerId: fromOwnerId, claim: '临时人物是守门人', level: 3, supportingTraceIds: [oldTraceId], confidence: 1, status: 'active', createdAt: 1, updatedAt: 1 } });
    await workspace.upsert({ workspaceId: 'w', collection: 'relationship-claims', recordId: 'relationship:migration', value: { id: 'relationship:migration', workspaceId: 'w', chatKey: 'chat', fromOwnerId, toOwnerId: fromOwnerId, claim: '自我关系', supportingTraceIds: [oldTraceId], confidence: 1, status: 'active', createdAt: 1, updatedAt: 1 } });
    await workspace.upsert({ workspaceId: 'w', collection: 'dream-jobs', recordId: 'dream:migration', value: { id: 'dream:migration', workspaceId: 'w', chatKey: 'chat', ownerId: fromOwnerId, status: 'queued', phase: 'gather', trigger: 'manual', traceIds: [oldTraceId], createdAt: 1, updatedAt: 1 } });
    await workspace.upsert({ workspaceId: 'w', collection: 'recall-exposures', recordId: 'exposure:migration', value: { id: 'exposure:migration', workspaceId: 'w', chatKey: 'chat', ownerId: fromOwnerId, traceId: oldTraceId, sceneEpoch: '1', included: true, used: false, confidence: 1, createdAt: 1 } });
    await workspace.upsert({ workspaceId: 'w', collection: 'memory-details', recordId: `detail:${oldTraceId}:gist`, value: { id: `detail:${oldTraceId}:gist`, workspaceId: 'w', chatKey: 'chat', traceId: oldTraceId, sourceFactId: factId } });
    await workspace.upsert({ workspaceId: 'w', collection: 'memory-links', recordId: `memory-link:${oldTraceId}`, value: { id: `memory-link:${oldTraceId}`, workspaceId: 'w', chatKey: 'chat', ownerId: fromOwnerId, traceIds: [oldTraceId], factId } });
    await workspace.upsert({ workspaceId: 'w', collection: 'graph-nodes', recordId: oldNodeId, value: { id: oldNodeId, workspaceId: 'w', chatKey: 'chat', entityKey: fromOwnerId, updatedAt: 1 } });
    await workspace.upsert({ workspaceId: 'w', collection: 'graph-edges', recordId: 'graph-edge:migration', value: { id: 'graph-edge:migration', workspaceId: 'w', chatKey: 'chat', fromNodeId: oldNodeId, toNodeId: oldNodeId, backingFactId: factId, updatedAt: 1 } });
    await workspace.upsert({ workspaceId: 'w', collection: 'change-audits', recordId: 'audit:old', value: { id: 'audit:old', workspaceId: 'w', chatKey: 'chat', kind: 'capture-change-set-v0', createdAt: 1, entries: [], metadata: { ownerId: fromOwnerId, traceId: oldTraceId } } });

    const audit = await repository.upsertActorRegistryState([targetOwner as never], [], { operation: 'confirm' }, { fromOwnerId, toOwnerId }, []);

    expect(await workspace.get({ workspaceId: 'w', collection: 'memory-traces', recordId: oldTraceId })).toBeNull();
    expect(await workspace.get({ workspaceId: 'w', collection: 'memory-traces', recordId: newTraceId })).toMatchObject({ value: { ownerId: toOwnerId } });
    expect(await workspace.get({ workspaceId: 'w', collection: 'episodes', recordId: 'episode:migration' })).toMatchObject({ value: { participantIds: [toOwnerId], presentOwnerIds: [toOwnerId] } });
    expect(await workspace.get({ workspaceId: 'w', collection: 'observations', recordId: 'observation:migration' })).toMatchObject({ value: { speakerOwnerId: toOwnerId, viewpointOwnerId: toOwnerId } });
    expect(await workspace.get({ workspaceId: 'w', collection: 'facts', recordId: factId })).toMatchObject({ value: { subjectEntityId: toOwnerId, entityKeys: [toOwnerId] } });
    expect(await workspace.get({ workspaceId: 'w', collection: 'scene-casts', recordId: 'scene:migration' })).toMatchObject({ value: { viewpointOwnerId: toOwnerId, members: [{ ownerId: toOwnerId, role: 'speaker', confidence: 1, sourceRefs: ['m1'] }] } });
    expect(await workspace.get({ workspaceId: 'w', collection: 'profile-claims', recordId: 'claim:migration' })).toMatchObject({ value: { ownerId: toOwnerId, supportingTraceIds: [newTraceId] } });
    expect(await workspace.get({ workspaceId: 'w', collection: 'relationship-claims', recordId: 'relationship:migration' })).toMatchObject({ value: { fromOwnerId: toOwnerId, toOwnerId } });
    expect(await workspace.get({ workspaceId: 'w', collection: 'dream-jobs', recordId: 'dream:migration' })).toMatchObject({ value: { ownerId: toOwnerId, traceIds: [newTraceId] } });
    expect(await workspace.get({ workspaceId: 'w', collection: 'recall-exposures', recordId: 'exposure:migration' })).toMatchObject({ value: { ownerId: toOwnerId, traceId: newTraceId } });
    expect(await workspace.get({ workspaceId: 'w', collection: 'memory-details', recordId: `detail:${newTraceId}:gist` })).not.toBeNull();
    expect(await workspace.get({ workspaceId: 'w', collection: 'memory-links', recordId: `memory-link:${newTraceId}` })).not.toBeNull();
    expect(await workspace.get({ workspaceId: 'w', collection: 'graph-nodes', recordId: newNodeId })).toMatchObject({ value: { entityKey: toOwnerId } });
    expect(await workspace.get({ workspaceId: 'w', collection: 'graph-edges', recordId: 'graph-edge:migration' })).toMatchObject({ value: { fromNodeId: newNodeId, toNodeId: newNodeId } });
    expect(await workspace.get({ workspaceId: 'w', collection: 'change-audits', recordId: 'audit:old' })).toMatchObject({ value: { metadata: { ownerId: toOwnerId, traceId: newTraceId } } });

    await repository.rollbackChangeSet(audit.id);
    expect(await workspace.get({ workspaceId: 'w', collection: 'memory-traces', recordId: oldTraceId })).not.toBeNull();
    expect(await workspace.get({ workspaceId: 'w', collection: 'memory-traces', recordId: newTraceId })).toBeNull();
    expect(await workspace.get({ workspaceId: 'w', collection: 'facts', recordId: factId })).toMatchObject({ value: { subjectEntityId: fromOwnerId } });
  });

  it('stops on a repeated pagination cursor and batches large destructive clears', async () => {
    const stalledWorkspace = port();
    const originalQuery = stalledWorkspace.query.bind(stalledWorkspace);
    stalledWorkspace.query = async (request) => request.collection === 'facts'
      ? { records: [], nextCursor: 'same-cursor' }
      : originalQuery(request);
    const stalledRepository = new MultiActorMemoryRepository(stalledWorkspace);
    stalledRepository.bind('w', 'chat');
    await stalledRepository.open();
    await expect(stalledRepository.listFacts()).rejects.toMatchObject({ code: 'WORKSPACE_PAGINATION_STALLED' });

    const workspace = port();
    const transaction = vi.fn(workspace.transaction.bind(workspace));
    workspace.transaction = transaction;
    const repository = new MultiActorMemoryRepository(workspace);
    repository.bind('w', 'chat');
    await repository.open();
    for (let index = 0; index < 501; index += 1) {
      await workspace.upsert({ workspaceId: 'w', collection: 'facts', recordId: `fact:${index}`, value: { ...commit(0, 0).facts[0]!, id: `fact:${index}` } as never });
    }
    transaction.mockClear();
    await repository.clearCurrentChatData();
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(transaction.mock.calls.every(call => call[0].operations.length <= 500)).toBe(true);
  });
});
