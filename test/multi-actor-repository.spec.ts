import { describe, expect, it, vi } from 'vitest';
import { createSSHelperError, type WorkspacePort, type WorkspaceQueryOptions, type WorkspaceRecord, type WorkspaceSession } from '@ss-helper/sdk';
import { MultiActorMemoryRepository, type CaptureCommit } from '../src/infrastructure/multi-actor-memory-repository';

type RecordRequest = { workspaceId?: string; collection?: string; recordId?: string; value?: unknown };
type QueryRequest = { collection?: string; filter?: Record<string, unknown> };
type TransactionRequest = { operations: readonly { action: 'delete' | 'upsert'; collection: string; recordId: string; value?: unknown }[] };
type LegacyRecord = WorkspaceRecord & { readonly recordId: string; readonly version: number };
type TestWorkspacePort = WorkspacePort & {
  defineCollection(request: { name: string; indexes?: readonly string[] }): Promise<void>;
  get(request: RecordRequest): Promise<LegacyRecord | null>;
  upsert(request: RecordRequest): Promise<LegacyRecord>;
  delete(request: RecordRequest): Promise<boolean>;
  query(request: QueryRequest): Promise<{ records: LegacyRecord[]; nextCursor: string | null }>;
  transaction(request: TransactionRequest): Promise<{ operationCount: number; replayed: boolean; results: unknown[] }>;
};

function port(): TestWorkspacePort {
  const collections = new Map<string, Map<string, { value: unknown; version: number; updatedAt: number }>>();
  const declaredIndexes = new Map<string, Set<string>>();
  const key = (collection: string, id: string) => `${collection}:${id}`;
  const legacy = {
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
      const records: LegacyRecord[] = [...bucket.entries()].map(([compound, value]) => {
        const recordId = compound.slice(collection.length + 1);
        return { id: recordId, recordId, value: value.value as never, revision: value.version, version: value.version, updatedAt: value.updatedAt };
      }).filter(record => Object.entries(request.filter ?? {}).every(([field, expected]) => (record.value as Record<string, unknown>)[field] === expected));
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
  };
  const workspace = {
    admin: {
      health: async () => ({ ready: true, status: 'ready' as const, database: 'memory', schemaVersion: 0 }),
      integrity: async () => ({ ok: true, messages: [] }),
      reset: async () => 0,
      backup: async () => ({ archive: {} as never, sha256: '' }),
    },
    open: async (request: Parameters<WorkspacePort['open']>[0]) => {
      for (const declaration of request.schema.collections) await workspace.defineCollection(declaration);
      return {
        id: request.id,
        get: async (collection: string, id: string) => {
          const record = await workspace.get({ collection, recordId: id });
          return record ? { id, value: record.value as never, revision: record.version, updatedAt: record.updatedAt } : null;
        },
        query: async (collection: string, options: WorkspaceQueryOptions = {}) => {
          const page = await workspace.query({ collection, filter: options.filter as Record<string, unknown> });
          return { records: page.records.map((record) => ({ id: record.recordId, value: record.value, revision: record.version, updatedAt: record.updatedAt })), nextCursor: page.nextCursor };
        },
        commit: async (request: Parameters<WorkspaceSession['commit']>[0]) => {
          if (request.idempotencyKey.length > 128 || !/^[\w.:-]+$/u.test(request.idempotencyKey)) {
            throw Object.assign(new Error('idempotencyKey is invalid'), { code: 'INVALID_PAYLOAD' });
          }
          await workspace.transaction({
            operations: request.operations.map((operation) => operation.action === 'put'
              ? { action: 'upsert' as const, collection: operation.collection, recordId: operation.id, value: operation.value }
              : { action: 'delete' as const, collection: operation.collection, recordId: operation.id }),
          });
          const results = await Promise.all(request.operations.map(async (operation) => {
            if (operation.action === 'delete') {
              return {
                collection: operation.collection,
                id: operation.id,
                action: operation.action,
                revision: (operation.expectedRevision ?? 0) + 1,
                removed: true,
              };
            }
            const stored = await workspace.get({ collection: operation.collection, recordId: operation.id });
            return {
              collection: operation.collection,
              id: operation.id,
              action: operation.action,
              revision: stored?.version ?? 1,
            };
          }));
          return { requestId: request.idempotencyKey, replayed: false, results };
        },
        vectors: {
          upsert: async () => undefined,
          search: async () => [],
          delete: async () => false,
          list: async () => ({ vectors: [], nextCursor: null }),
          clear: async () => 0,
        },
      };
    },
    ...legacy,
  } as unknown as TestWorkspacePort;
  return workspace;
}

function commit(traceStrength: number, rehearsalCount: number): CaptureCommit {
  const fact = { id: 'fact:f', workspaceId: 'w', chatKey: 'chat', kind: 'event' as const, subjectKey: 'A', predicateKey: '知道', canonicalKey: 'A::知道', content: 'A知道铜钥匙位置', entityKeys: ['owner:actor:a'], confidence: 0.9, status: 'active' as const, sourceRefs: ['source:s'], evidenceIds: ['evidence:f'], freshestEvidenceAt: 1, origin: 'automatic' as const, revision: 1, createdAt: 1, updatedAt: 1 };
  return {
    envelope: { workspaceId: 'w', chatKey: 'chat', sourceRefs: ['source:s'], actorCandidates: [], locationCandidates: [], episodes: [], claimLocalIds: ['claim:f'], capturedAt: 1 },
    owners: [], aliases: [], locations: [], locationAliases: [], episodes: [], observations: [], facts: [fact], evidence: [{ id: 'evidence:f', workspaceId: 'w', chatKey: 'chat', factId: fact.id, sourceRef: 'source:s', excerpt: 'A知道铜钥匙位置', occurredAt: 1, createdAt: 1 }],
    traces: [{ id: 'trace:owner:actor:a:fact:f', workspaceId: 'w', chatKey: 'chat', ownerId: 'owner:actor:a', factId: fact.id, sourceObservationIds: ['o1'], knowledgeMode: 'experienced', privacy: 'public', strength: traceStrength, clarity: 80, beliefConfidence: 0.8, emotionalSalience: 0.2, rehearsalCount, traceRevision: 1, learnedAt: 1, createdAt: 1, updatedAt: 1 }],
  };
}

function legacyStableKey(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function currentStableKey(value: string): string {
  const normalized = value.normalize('NFKC');
  const words: string[] = [];
  for (let variant = 0; variant < 4; variant += 1) {
    let hash = 2_166_136_261;
    for (const character of `${variant}\0${normalized}`) {
      hash ^= character.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 16_777_619);
    }
    words.push((hash >>> 0).toString(16).padStart(8, '0'));
  }
  return words.join('');
}

describe('multi-actor repository transaction semantics', () => {
  it('persists and clears the additive scene, cast, coverage and usage records', async () => {
    const workspace = port();
    const repository = new MultiActorMemoryRepository(workspace);
    repository.bind('w', 'chat');
    await repository.open();
    const state = {
      id: 'scene-state:w:chat', workspaceId: 'w', chatKey: 'chat', sceneId: 'scene:1', sceneEpoch: 1,
      locationKeys: ['加油站'], viewpointOwnerId: 'owner:actor:a', presentOwnerIds: ['owner:actor:a'],
      nearbyOwnerIds: [], exitedOwnerIds: [], recentSpeakerOwnerIds: ['owner:actor:a'], mentionedOwnerIds: [],
      startedAtFloor: 1, updatedAtFloor: 2, confidence: 0.9, revision: 1, sourceRefs: ['message:2'], createdAt: 1, updatedAt: 2,
    } as const;
    const transition = {
      id: 'transition:1', workspaceId: 'w', chatKey: 'chat', sceneId: 'scene:1', floor: 2,
      enteredOwnerIds: ['owner:actor:a'], exitedOwnerIds: [], previousLocationKeys: [], currentLocationKeys: ['加油站'],
      currentViewpointOwnerId: 'owner:actor:a', reason: 'explicit_entry' as const, confidence: 1,
      sourceRefs: ['message:2'], createdAt: 2,
    };
    const plan = {
      id: 'plan:1', workspaceId: 'w', chatKey: 'chat', sceneId: 'scene:1', basedOnFloor: 2,
      mode: 'single_actor' as const, viewpointOwnerId: 'owner:actor:a', requiredOwnerIds: ['owner:actor:a'],
      likelyOwnerIds: [], backgroundOwnerIds: [], mentionedOnlyOwnerIds: [], excludedOwnerIds: [],
      permissionByOwner: { 'owner:actor:a': 'full' as const }, plannerMode: 'deterministic' as const,
      confidence: 1, evidence: [], newActorProposals: [], createdAt: 2,
    };
    await repository.saveSceneState(state, transition);
    await repository.saveGenerationCastPlan(plan);
    await repository.recordCastPlanAudit({
      id: 'audit:plan:1', workspaceId: 'w', chatKey: 'chat', planId: plan.id,
      plannedOwnerIds: ['owner:actor:a'], actualOwnerIds: ['owner:actor:a'], unplannedOwnerIds: [], missingOwnerIds: [],
      result: 'matched', leakageRisk: false, createdAt: 3,
    });
    await repository.recordRecallCoverage({
      id: 'coverage:1', workspaceId: 'w', chatKey: 'chat', planId: plan.id, covered: true,
      missingSubQueryIds: [], missingOwnerIds: [], missingTimeDimensions: [], privacyViolations: [], temporalConflicts: [],
      requiresExpansion: false, expanded: false, createdAt: 3,
    });
    await repository.recordMemoryUsage([{
      id: 'usage:1', workspaceId: 'w', chatKey: 'chat', planId: plan.id, ownerId: 'owner:actor:a',
      traceId: 'trace:1', factId: 'fact:1', usage: 'explicit', confidence: 1, createdAt: 3,
    }]);
    await workspace.upsert({ workspaceId: 'w', collection: 'generation-prompt-snapshots', recordId: 'snapshot:1', value: { id: 'snapshot:1', workspaceId: 'w', chatKey: 'chat' } });
    await workspace.upsert({ workspaceId: 'w', collection: 'generation-prompt-snapshot-chunks', recordId: 'snapshot:1:chunk:0', value: { id: 'snapshot:1:chunk:0', workspaceId: 'w', chatKey: 'chat', snapshotId: 'snapshot:1', index: 0 } });

    expect(await repository.getSceneState()).toMatchObject({ sceneId: 'scene:1', presentOwnerIds: ['owner:actor:a'] });
    expect(await repository.listSceneTransitions()).toMatchObject([{ reason: 'explicit_entry' }]);
    expect(await repository.listGenerationCastPlans()).toMatchObject([{ id: 'plan:1' }]);
    expect(await repository.listCastPlanAudits()).toMatchObject([{ result: 'matched' }]);
    expect(await repository.listRecallCoverageLogs()).toMatchObject([{ covered: true }]);
    expect(await repository.listMemoryUsageLogs()).toMatchObject([{ usage: 'explicit' }]);

    await repository.clearCurrentChatData();
    expect(await repository.getSceneState()).toBeUndefined();
    expect(await repository.listGenerationCastPlans()).toEqual([]);
    expect(await repository.listMemoryUsageLogs()).toEqual([]);
    expect((await workspace.query({ collection: 'generation-prompt-snapshots', filter: { chatKey: 'chat' } })).records).toEqual([]);
    expect((await workspace.query({ collection: 'generation-prompt-snapshot-chunks', filter: { chatKey: 'chat' } })).records).toEqual([]);
  });

  it('ignores a damaged persisted SceneState so callers can rebuild from SceneCast and recent floors', async () => {
    const workspace = port();
    const repository = new MultiActorMemoryRepository(workspace);
    repository.bind('w', 'chat');
    await repository.open();
    await workspace.upsert({
      workspaceId: 'w', collection: 'scene-states', recordId: 'scene-state:w:chat',
      value: { id: 'scene-state:w:chat', workspaceId: 'w', chatKey: 'chat', sceneId: 'broken', presentOwnerIds: 'not-an-array' } as never,
    });
    expect(await repository.getSceneState()).toBeUndefined();
    expect(await repository.listSceneStates()).toEqual([]);
  });

  it('merges trace history and rolls back derived records with the same ChangeSet', async () => {
    const workspace = port();
    const repository = new MultiActorMemoryRepository(workspace); repository.bind('w', 'chat'); await repository.open();
    await repository.commitCapture({ ...commit(40, 3), idempotencyKey: 'capture:trace:first' });
    const audit = await repository.commitCapture({ ...commit(30, 0), idempotencyKey: 'capture:trace:second' });
    const trace = (await repository.listTraces())[0]!;
    expect(trace.rehearsalCount).toBe(3);
    expect(trace.strength).toBe(40);
    expect(trace.traceRevision).toBe(2);
    await repository.upsertDerivedForChangeSet(audit.id, [{ collection: 'memory-details', records: [{ id: 'detail:new', workspaceId: 'w', chatKey: 'chat', sourceChangeSetId: audit.id }] }]);
    await repository.rollbackChangeSet(audit.id);
    expect((await repository.listTraces())[0]!.rehearsalCount).toBe(3);
    expect((await workspace.get({ workspaceId: 'w', collection: 'memory-details', recordId: 'detail:new' }))).toBeNull();
  });

  it('commits repair descriptors with the batch checkpoint and closes them when ignored', async () => {
    const repository = new MultiActorMemoryRepository(port());
    repository.bind('w', 'chat');
    await repository.open();
    const rejection = {
      id: 'rejection:schema:1',
      index: 2,
      code: 'schema_validation_failed' as const,
      message: 'expected property to be present',
      recordType: 'claim' as const,
      fieldPath: '$.claims[2].objectRef',
      sourceRefs: ['source:s'],
      requestId: 'request:capture:1',
      status: 'unresolved' as const,
      repairAttempts: 0,
    };
    const base = commit(40, 0);
    const audit = await repository.commitCapture({
      ...base,
      captureJobId: 'capture-job:repair',
      captureJob: {
        id: 'capture-job:repair',
        workspaceId: 'w',
        chatKey: 'chat',
        status: 'running',
        checkpoint: {
          batchIndex: 1,
          lastScannedBatch: 1,
          completedBatchCount: 1,
          pendingRepairCount: 0,
          processedCount: 1,
          phase: 'capture',
        },
      },
      outcome: 'partial',
      rejections: [rejection],
      idempotencyKey: 'capture:repair:atomic',
    });

    const queue = await repository.listCaptureRepairQueue('capture-job:repair');
    expect(queue).toEqual([
      expect.objectContaining({
        jobId: 'capture-job:repair',
        batchIndex: 0,
        collection: 'claims',
        itemIndex: 2,
        originalRequestId: 'request:capture:1',
        rejectionId: rejection.id,
        status: 'queued',
        attemptCount: 0,
      }),
    ]);
    expect((await repository.listCaptureJobs())[0]).toMatchObject({
      outcome: 'partial',
      rejectionCount: 1,
      checkpoint: { pendingRepairCount: 1 },
    });
    expect(audit.entries.some(entry => entry.collection === 'capture-repair-queue')).toBe(true);

    await repository.updateCaptureAuditRejections(audit.id, [{
      ...rejection,
      status: 'ignored',
      ignoredAt: 2,
    }]);
    expect((await repository.listCaptureRepairQueue('capture-job:repair'))[0]).toMatchObject({ status: 'ignored' });
    expect((await repository.listCaptureJobs())[0]).toMatchObject({
      status: 'completed',
      outcome: 'complete',
      rejectionCount: 0,
      checkpoint: { phase: 'repair', pendingRepairCount: 0 },
    });
  });

  it('keeps all 130 unresolved items visible from a 146-rejection historical distribution', async () => {
    const workspace = port();
    const repository = new MultiActorMemoryRepository(workspace);
    repository.bind('w', 'chat');
    await repository.open();
    const rejections = Array.from({ length: 146 }, (_, index) => ({
      id: `historical:${index}`,
      index,
      code: index < 55 ? 'dependency_invalid' as const
        : index < 108 ? 'excerpt_mismatch' as const
          : 'invalid_reference' as const,
      message: 'safe issue',
      recordType: 'claim' as const,
      fieldPath: index < 55 ? 'episodeLocalId' : index < 108 ? 'evidenceExcerpt' : 'subjectRef',
      sourceRefs: ['source:s'],
      requestId: 'request:historical',
      status: index < 13 ? 'repaired' as const : index < 16 ? 'ignored' as const : 'unresolved' as const,
      repairAttempts: index < 13 ? 1 : 0,
    }));
    const base = commit(41, 0);
    await repository.commitCapture({
      ...base,
      captureJobId: 'capture-job:historical',
      captureJob: {
        id: 'capture-job:historical',
        workspaceId: 'w',
        chatKey: 'chat',
        status: 'running',
        checkpoint: { batchIndex: 1, processedCount: 1, phase: 'capture' },
      },
      outcome: 'partial',
      rejections,
      idempotencyKey: 'capture:historical',
    });
    expect(await repository.listCaptureRepairQueue('capture-job:historical')).toHaveLength(130);
    expect((await repository.listCaptureJobs())[0]).toMatchObject({
      rejectionCount: 130,
      checkpoint: {
        pendingRepairCount: 130,
        retryableRepairCount: 130,
        unresolvedRejectionCount: 130,
        repairedCount: 13,
        ignoredCount: 3,
      },
    });
  });

  it('reconciliation writes legacy resolved queue state back to its Change Audit and job', async () => {
    const workspace = port();
    const repository = new MultiActorMemoryRepository(workspace);
    repository.bind('w', 'chat');
    await repository.open();
    const rejection = {
      id: 'legacy:resolved',
      index: 0,
      code: 'invalid_reference' as const,
      message: 'safe issue',
      recordType: 'claim' as const,
      fieldPath: 'subjectRef',
      sourceRefs: ['source:s'],
      requestId: 'request:legacy',
      status: 'unresolved' as const,
      repairAttempts: 0,
    };
    const audit = await repository.commitCapture({
      ...commit(42, 0),
      captureJobId: 'capture-job:legacy-resolved',
      captureJob: {
        id: 'capture-job:legacy-resolved',
        workspaceId: 'w',
        chatKey: 'chat',
        status: 'running',
        checkpoint: { batchIndex: 1, processedCount: 1, phase: 'capture' },
      },
      outcome: 'partial',
      rejections: [rejection],
      idempotencyKey: 'capture:legacy-resolved',
    });
    const [repair] = await repository.listCaptureRepairQueue('capture-job:legacy-resolved');
    await repository.updateCaptureRepairRecord({
      ...repair!,
      status: 'resolved',
      attemptCount: 1,
      resolutionMode: 'repaired',
      resolvedAt: 20,
      updatedAt: 20,
    });

    await repository.reconcileCaptureRepairQueue('capture-job:legacy-resolved');

    const repairedAudit = await repository.getChangeAudit(audit.id);
    expect((repairedAudit?.metadata as { rejections: Array<{ status: string; repairAttempts: number }> }).rejections[0])
      .toMatchObject({ status: 'repaired', repairAttempts: 1 });
    expect((await repository.listCaptureJobs())[0]).toMatchObject({
      status: 'completed',
      rejectionCount: 0,
      checkpoint: { pendingRepairCount: 0, repairedCount: 1 },
    });
  });

  it('reconciliation restores historical repairAttempts when rebuilding a missing queue row', async () => {
    const workspace = port();
    const repository = new MultiActorMemoryRepository(workspace);
    repository.bind('w', 'chat');
    await repository.open();
    await repository.commitCapture({
      ...commit(43, 0),
      captureJobId: 'capture-job:legacy-attempt',
      captureJob: {
        id: 'capture-job:legacy-attempt',
        workspaceId: 'w',
        chatKey: 'chat',
        status: 'running',
        checkpoint: { batchIndex: 1, processedCount: 1, phase: 'capture' },
      },
      outcome: 'partial',
      rejections: [{
        id: 'legacy:attempt',
        index: 0,
        code: 'invalid_reference',
        message: 'safe issue',
        recordType: 'claim',
        fieldPath: 'subjectRef',
        sourceRefs: ['source:s'],
        requestId: 'request:legacy-attempt',
        status: 'unresolved',
        repairAttempts: 1,
      }],
      idempotencyKey: 'capture:legacy-attempt',
    });
    const [created] = await repository.listCaptureRepairQueue('capture-job:legacy-attempt');
    await workspace.delete({ collection: 'capture-repair-queue', recordId: created!.id });

    const [rebuilt] = await repository.reconcileCaptureRepairQueue('capture-job:legacy-attempt');
    expect(rebuilt).toMatchObject({ attemptCount: 1, maxAttempts: 2, status: 'queued' });
  });

  it('reconciliation coalesces one-based rejection diagnostics with the zero-based queue batch', async () => {
    const repository = new MultiActorMemoryRepository(port());
    repository.bind('w', 'chat');
    await repository.open();
    const jobId = 'capture-job:batch-normalization';
    await repository.commitCapture({
      ...commit(44, 0),
      captureJobId: jobId,
      captureJob: {
        id: jobId,
        workspaceId: 'w',
        chatKey: 'chat',
        status: 'running',
        checkpoint: { batchIndex: 1, lastScannedBatch: 1, processedCount: 1, phase: 'capture' },
      },
      outcome: 'partial',
      rejections: [{
        id: 'rejection:batch-normalization',
        index: 0,
        batchIndex: 1,
        code: 'invalid_reference',
        message: 'safe issue',
        recordType: 'claim',
        fieldPath: 'subjectRef',
        sourceRefs: ['source:s'],
        requestId: 'request:batch-normalization',
        status: 'unresolved',
      }],
      idempotencyKey: 'capture:batch-normalization',
    });

    expect(await repository.listCaptureRepairQueue(jobId)).toEqual([
      expect.objectContaining({ batchIndex: 0 }),
    ]);
    const reconciled = await repository.reconcileCaptureRepairQueue(jobId);
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]).toMatchObject({
      batchIndex: 0,
      rejectionIds: ['rejection:batch-normalization'],
    });
  });

  it('does not turn repair-attempt audits into new work and removes their legacy queue rows', async () => {
    const workspace = port();
    const repository = new MultiActorMemoryRepository(workspace);
    repository.bind('w', 'chat');
    await repository.open();
    const jobId = 'capture-job:repair-audit';
    const originalRejection = {
      id: 'rejection:original',
      index: 0,
      code: 'invalid_reference' as const,
      message: 'safe issue',
      recordType: 'claim' as const,
      fieldPath: 'subjectRef',
      sourceRefs: ['source:s'],
      requestId: 'request:original',
      status: 'unresolved' as const,
      repairAttempts: 0,
    };
    const originalAudit = await repository.commitCapture({
      ...commit(44, 0),
      captureJobId: jobId,
      captureJob: {
        id: jobId,
        workspaceId: 'w',
        chatKey: 'chat',
        status: 'running',
        checkpoint: { batchIndex: 1, processedCount: 1, phase: 'capture' },
      },
      outcome: 'partial',
      rejections: [originalRejection],
      idempotencyKey: 'capture:repair-audit:original',
    });
    const repairRejection = {
      ...originalRejection,
      id: 'rejection:repair-attempt',
      // A provider may replay the parent request id. Cleanup must distinguish
      // records by rejection lineage rather than deleting this whole key.
      requestId: 'request:original',
    };
    await repository.commitCapture({
      ...commit(45, 0),
      captureJobId: jobId,
      outcome: 'partial',
      rejections: [repairRejection],
      // Simulates an audit written before capturePhase was persisted. The
      // stable repair transaction namespace remains available for recovery.
      idempotencyKey: `capture:${jobId}:repair:queue-record:1`,
    });
    await workspace.upsert({
      workspaceId: 'w',
      collection: 'capture-repair-queue',
      recordId: 'legacy-derived-repair-row',
      value: {
        id: 'legacy-derived-repair-row',
        workspaceId: 'w',
        chatKey: 'chat',
        jobId,
        batchIndex: 0,
        collection: 'claims',
        itemIndex: 0,
        issues: [{ path: 'subjectRef', keyword: 'validation', expected: 'supported ref' }],
        sourceRefs: ['source:s'],
        fallbackSourceRefs: ['source:s'],
        originalRequestId: 'request:original',
        rejectionIds: ['rejection:repair-attempt'],
        status: 'queued',
        attemptCount: 0,
        maxAttempts: 2,
        createdAt: 1,
        updatedAt: 1,
      },
    });

    const queue = await repository.reconcileCaptureRepairQueue(jobId);

    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      originalRequestId: 'request:original',
      rejectionIds: ['rejection:original'],
    });
    expect(await workspace.get({
      workspaceId: 'w',
      collection: 'capture-repair-queue',
      recordId: 'legacy-derived-repair-row',
    })).toBeNull();
    await repository.updateCaptureAuditRejections(originalAudit.id, [{
      ...originalRejection,
      status: 'repaired',
      repairedAt: 2,
      repairAttempts: 1,
    }]);
    expect((await repository.listCaptureJobs())[0]).toMatchObject({
      status: 'completed',
      rejectionCount: 0,
      checkpoint: { unresolvedRejectionCount: 0 },
    });
  });

  it('serializes concurrent writes to the same repair queue record', async () => {
    const repository = new MultiActorMemoryRepository(port());
    repository.bind('w', 'chat');
    await repository.open();
    const record = {
      id: 'repair:serialized',
      workspaceId: 'w',
      chatKey: 'chat',
      jobId: 'job:serialized',
      batchIndex: 0,
      collection: 'claims' as const,
      itemIndex: 0,
      issues: [{ path: '$.claims[0]', keyword: 'schema', expected: 'valid claim' }],
      sourceRefs: ['source:s'],
      fallbackSourceRefs: [],
      status: 'queued' as const,
      attemptCount: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    await repository.updateCaptureRepairRecord(record);

    await expect(Promise.all([
      repository.updateCaptureRepairRecord({ ...record, status: 'running', updatedAt: 2 }),
      repository.updateCaptureRepairRecord({ ...record, status: 'queued', updatedAt: 3 }),
    ])).resolves.toEqual([undefined, undefined]);
  });

  it('rejects repair queue updates outside the bound workspace through the canonical error center', async () => {
    const repository = new MultiActorMemoryRepository(port());
    repository.bind('w', 'chat');
    await repository.open();

    await expect(repository.updateCaptureRepairRecord({
      id: 'repair:foreign',
      workspaceId: 'foreign-workspace',
      chatKey: 'chat',
      jobId: 'job:repair',
      batchIndex: 0,
      collection: 'claims',
      itemIndex: 0,
      issues: [{ path: '$.claims[0]', keyword: 'schema', expected: 'valid claim' }],
      sourceRefs: ['source:s'],
      fallbackSourceRefs: [],
      status: 'queued',
      attemptCount: 0,
      createdAt: 1,
      updatedAt: 1,
    })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: {
        reasonCode: 'WORKSPACE_ACCESS_DENIED',
        stage: 'memory.repair.queue.ownership',
        collection: 'capture-repair-queue',
      },
    });
  });

  it('folds duplicate record mutations and rebuilds once after an optimistic conflict', async () => {
    const workspace = port();
    const transaction = workspace.transaction.bind(workspace);
    let transactionCalls = 0;
    const transactionSpy = vi.spyOn(workspace, 'transaction').mockImplementation(async request => {
      transactionCalls += 1;
      if (transactionCalls === 1) {
        throw createSSHelperError('WORKSPACE_CONFLICT', { stage: 'test.workspace.commit' });
      }
      return transaction(request);
    });
    const repository = new MultiActorMemoryRepository(workspace);
    repository.bind('w', 'chat');
    await repository.open();
    const base = commit(40, 0);
    const duplicateFact = {
      ...base.facts[0]!,
      content: 'A最终知道铜钥匙位置',
      updatedAt: 2,
    };

    const audit = await repository.commitCapture({
      ...base,
      idempotencyKey: 'capture:conflict:once',
      facts: [base.facts[0]!, duplicateFact],
    });

    expect(transactionSpy).toHaveBeenCalledTimes(2);
    for (const [request] of transactionSpy.mock.calls) {
      const keys = request.operations.map(operation => `${operation.collection}\0${operation.recordId}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
    expect(audit.entries.filter(entry => entry.collection === 'facts' && entry.recordId === 'fact:f')).toHaveLength(1);
    expect((await repository.listFacts())[0]?.content).toBe('A最终知道铜钥匙位置');
  });

  it('refuses to roll back an older Capture after a newer independent Capture changed the same record', async () => {
    const repository = new MultiActorMemoryRepository(port());
    repository.bind('w', 'chat');
    await repository.open();
    const older = await repository.commitCapture({ ...commit(40, 0), idempotencyKey: 'capture:older' });
    const newer = await repository.commitCapture({
      ...commit(90, 0),
      idempotencyKey: 'capture:newer',
      traces: [{ ...commit(90, 0).traces[0]!, sourceObservationIds: ['o1', 'o2'], updatedAt: 2 }],
    });

    await expect(repository.rollbackChangeSet(older.id)).rejects.toMatchObject({
      code: 'CONFLICT',
      details: {
        reasonCode: 'WORKSPACE_CONFLICT',
        stage: 'memory.repository.rollback.preflight',
        collection: 'memory-traces',
      },
    });
    expect((await repository.listTraces())[0]).toMatchObject({ strength: 90, sourceObservationIds: ['o1', 'o2'] });
    expect((await repository.getChangeAudit(older.id))?.rolledBackAt).toBeUndefined();

    await repository.rollbackChangeSet(newer.id);
    await expect(repository.rollbackChangeSet(older.id)).resolves.toContain('fact:f');
    expect(await repository.listFacts()).toEqual([]);
  });

  it('writes large derived projections as rebuildable chunks without child ChangeSets', async () => {
    const workspace = port();
    const repository = new MultiActorMemoryRepository(workspace); repository.bind('w', 'chat'); await repository.open();
    const parent = await repository.commitCapture(commit(40, 0));
    const transaction = vi.spyOn(workspace, 'transaction');
    const details = Array.from({ length: 300 }, (_, index) => ({
      id: `detail:${index}`,
      workspaceId: 'w',
      chatKey: 'chat',
      ownerId: 'owner:actor:a',
      factId: 'fact:f',
      content: `detail-${index}`,
    }));

    await repository.upsertDerivedForChangeSet(parent.id, [{ collection: 'memory-details', records: details }]);

    expect(await repository.listChangeAudits()).toHaveLength(1);
    expect((await repository.getChangeAudit(parent.id))?.entries).toHaveLength(parent.entries.length);
    expect(Math.max(...transaction.mock.calls.map(([request]) => request.operations.length))).toBeLessThanOrEqual(128);
    expect(await workspace.get({ workspaceId: 'w', collection: 'memory-details', recordId: 'detail:0' })).not.toBeNull();
    expect(await workspace.get({ workspaceId: 'w', collection: 'memory-details', recordId: 'detail:299' })).not.toBeNull();

    await repository.rollbackChangeSet(parent.id);

    expect(await workspace.get({ workspaceId: 'w', collection: 'memory-details', recordId: 'detail:0' })).toBeNull();
    expect(await workspace.get({ workspaceId: 'w', collection: 'memory-details', recordId: 'detail:299' })).toBeNull();
    expect((await repository.listChangeAudits()).filter(audit => audit.id !== parent.id)).toEqual([]);
  });

  it('uses a fresh deterministic idempotency key when replaying a rolled-back Capture batch', async () => {
    const repository = new MultiActorMemoryRepository(port());
    repository.bind('w', 'chat');
    await repository.open();
    const input = { ...commit(40, 0), captureJobId: 'job:init', idempotencyKey: 'capture:job:init:batch:1' };

    const first = await repository.commitCapture(input);
    expect(await repository.listFacts()).toHaveLength(1);
    await repository.rollbackChangeSet(first.id);
    expect(await repository.listFacts()).toEqual([]);

    const replay = await repository.commitCapture(input);
    expect(replay.id).not.toBe(first.id);
    expect(replay.metadata).toMatchObject({
      retryAttempt: 1,
      retriedTransactionKey: 'capture:job:init:batch:1',
    });
    expect(await repository.listFacts()).toHaveLength(1);
    expect((await repository.getChangeAudit(first.id))?.rolledBackAt).toBeTypeOf('number');
    expect((await repository.getChangeAudit(replay.id))?.rolledBackAt).toBeUndefined();
  });

  it('rejects an active idempotency-key replay whose semantic payload changed', async () => {
    const repository = new MultiActorMemoryRepository(port());
    repository.bind('w', 'chat');
    await repository.open();
    const original = { ...commit(40, 0), idempotencyKey: 'capture:stable-payload' };
    await repository.commitCapture(original);

    const changedFact = {
      ...original.facts[0]!,
      content: '同一个幂等键下出现了不同的模型事实内容',
      canonicalKey: 'A::不同内容',
    };
    await expect(repository.commitCapture({ ...original, facts: [changedFact] }))
      .rejects.toMatchObject({
        code: 'CONFLICT',
        details: { reasonCode: 'WORKSPACE_CONFLICT', stage: 'memory.repository.capture.idempotency' },
      });
    expect((await repository.listFacts()).map(fact => fact.content)).toEqual(['A知道铜钥匙位置']);
  });

  it('rolls back exactly one root batch without cascading to another batch in the same job', async () => {
    const repository = new MultiActorMemoryRepository(port());
    repository.bind('w', 'chat');
    await repository.open();
    const first = await repository.commitCapture({
      ...commit(40, 0),
      captureJobId: 'job:ordered',
      idempotencyKey: 'capture:job:ordered:batch:1',
    });
    const emptySecond = commit(0, 0);
    const second = await repository.commitCapture({
      ...emptySecond,
      captureJobId: 'job:ordered',
      idempotencyKey: 'capture:job:ordered:batch:2',
      envelope: { ...emptySecond.envelope, sourceRefs: ['source:second'] },
      facts: [],
      evidence: [],
      traces: [],
    });

    await expect(repository.rollbackChangeSet(first.id)).resolves.toEqual(['fact:f']);
    expect((await repository.getChangeAudit(first.id))?.rolledBackAt).toBeTypeOf('number');
    expect((await repository.getChangeAudit(second.id))?.rolledBackAt).toBeUndefined();
  });

  it('invalidates detached derived caches and Dreams by affected fact/trace dependency', async () => {
    const workspace = port();
    const repository = new MultiActorMemoryRepository(workspace);
    repository.bind('w', 'chat');
    await repository.open();
    const parent = await repository.commitCapture({
      ...commit(40, 0),
      idempotencyKey: 'capture:dependency-invalidation',
    });
    const traceId = commit(40, 0).traces[0]!.id;
    const rows = [
      { collection: 'memory-details' as const, id: 'detail:detached', value: { traceId, sourceFactId: 'fact:f' } },
      { collection: 'memory-links' as const, id: 'link:detached', value: { traceId, factId: 'fact:f' } },
      { collection: 'vector-index' as const, id: 'vector:fact:f', value: { recordId: 'fact:f' } },
      { collection: 'graph-edges' as const, id: 'edge:detached', value: { backingFactId: 'fact:f' } },
      { collection: 'profile-claims' as const, id: 'profile:detached', value: { ownerId: 'owner:actor:a', supportingTraceIds: [traceId] } },
      { collection: 'relationship-claims' as const, id: 'relationship:detached', value: { fromOwnerId: 'owner:actor:a', toOwnerId: 'owner:actor:b', supportingTraceIds: [traceId] } },
      { collection: 'recall-exposures' as const, id: 'exposure:detached', value: { ownerId: 'owner:actor:a', traceId } },
      { collection: 'dream-jobs' as const, id: 'dream-job:detached', value: { ownerId: 'owner:actor:a', traceIds: [traceId], status: 'queued' } },
      { collection: 'dream-audits' as const, id: 'dream-audit:detached', value: { ownerId: 'owner:actor:a', jobId: 'dream-job:detached' } },
      { collection: 'dream-narratives' as const, id: 'dream-narrative:detached', value: { ownerId: 'owner:actor:a', jobId: 'dream-job:detached' } },
    ];
    for (const row of rows) {
      await repository.upsertDerived(row.collection, [{
        id: row.id,
        workspaceId: 'w',
        chatKey: 'chat',
        ...row.value,
      }]);
    }

    await repository.rollbackChangeSet(parent.id);

    for (const row of rows) {
      expect(await workspace.get({ workspaceId: 'w', collection: row.collection, recordId: row.id })).toBeNull();
    }
  });

  it('writes each rebuildable derived record once without an optimistic revision guard', async () => {
    const workspace = port();
    const originalOpen = workspace.open.bind(workspace);
    let commitCalls = 0;
    const committedOperationKeys: string[][] = [];
    workspace.open = (async (request: Parameters<WorkspacePort['open']>[0]) => {
      const session = await originalOpen(request);
      return {
        ...session,
        commit: async (commitRequest: Parameters<WorkspaceSession['commit']>[0]) => {
          commitCalls += 1;
          committedOperationKeys.push(commitRequest.operations.map(operation => `${operation.collection}\0${operation.id}`));
          expect(commitRequest.operations.every(operation => operation.expectedRevision === undefined)).toBe(true);
          return session.commit(commitRequest);
        },
      };
    }) as WorkspacePort['open'];
    const repository = new MultiActorMemoryRepository(workspace);
    repository.bind('w', 'chat');
    await repository.open();

    await repository.upsertDerived('memory-details', [{
      id: 'detail:race',
      workspaceId: 'w',
      chatKey: 'chat',
      ownerId: 'owner:actor:a',
      traceId: 'trace:a',
    }, {
      id: 'detail:race',
      workspaceId: 'w',
      chatKey: 'chat',
      ownerId: 'owner:actor:a',
      traceId: 'trace:final',
    }]);

    expect(commitCalls).toBe(1);
    for (const keys of committedOperationKeys) expect(new Set(keys).size).toBe(keys.length);
    await expect(workspace.get({
      workspaceId: 'w',
      collection: 'memory-details',
      recordId: 'detail:race',
    })).resolves.toMatchObject({ recordId: 'detail:race', value: { traceId: 'trace:final' } });
  });

  it('serializes concurrent derived projection writes in one repository session', async () => {
    const workspace = port();
    const originalOpen = workspace.open.bind(workspace);
    let activeCommits = 0;
    let maxActiveCommits = 0;
    workspace.open = (async (request: Parameters<WorkspacePort['open']>[0]) => {
      const session = await originalOpen(request);
      return {
        ...session,
        commit: async (commitRequest: Parameters<WorkspaceSession['commit']>[0]) => {
          activeCommits += 1;
          maxActiveCommits = Math.max(maxActiveCommits, activeCommits);
          await new Promise(resolve => setTimeout(resolve, 5));
          try {
            return await session.commit(commitRequest);
          } finally {
            activeCommits -= 1;
          }
        },
      };
    }) as WorkspacePort['open'];
    const repository = new MultiActorMemoryRepository(workspace);
    repository.bind('w', 'chat');
    await repository.open();

    await Promise.all([
      repository.upsertDerived('memory-details', [{
        id: 'detail:serialized',
        workspaceId: 'w',
        chatKey: 'chat',
        traceId: 'trace:first',
      }]),
      repository.upsertDerived('memory-details', [{
        id: 'detail:serialized',
        workspaceId: 'w',
        chatKey: 'chat',
        traceId: 'trace:second',
      }]),
    ]);

    expect(maxActiveCommits).toBe(1);
    await expect(workspace.get({
      workspaceId: 'w',
      collection: 'memory-details',
      recordId: 'detail:serialized',
    })).resolves.toMatchObject({ value: { traceId: 'trace:second' } });
  });

  it('returns the persisted audit without executing a duplicate active idempotency request again', async () => {
    const workspace = port();
    const repository = new MultiActorMemoryRepository(workspace);
    repository.bind('w', 'chat');
    await repository.open();
    const transaction = vi.spyOn(workspace, 'transaction');
    const input = { ...commit(40, 0), captureJobId: 'job:duplicate', idempotencyKey: 'capture:duplicate' };

    const first = await repository.commitCapture(input);
    const second = await repository.commitCapture({
      ...input,
      // A replaying caller can have different wall-clock values. The durable
      // audit, not a newly synthesized object, must remain authoritative.
      envelope: { ...input.envelope, capturedAt: 99 },
    });

    expect(second).toEqual(first);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect((await repository.listChangeAudits()).filter(audit => audit.kind === 'capture-change-set-v0')).toHaveLength(1);
  });

  it('rejects an active legacy audit without a semantic digest instead of blindly reusing it', async () => {
    const workspace = port();
    const repository = new MultiActorMemoryRepository(workspace);
    repository.bind('w', 'chat');
    await repository.open();
    const input = { ...commit(40, 0), captureJobId: 'job:legacy-digest', idempotencyKey: 'capture:legacy-digest' };
    const auditId = `change-audit:${currentStableKey(input.idempotencyKey)}`;
    await workspace.upsert({
      workspaceId: 'w',
      collection: 'change-audits',
      recordId: auditId,
      value: {
        id: auditId,
        workspaceId: 'w',
        chatKey: 'chat',
        kind: 'capture-change-set-v0',
        createdAt: 1,
        entries: [],
        metadata: {
          transactionKey: input.idempotencyKey,
          sourceRefs: input.envelope.sourceRefs,
          captureJobId: input.captureJobId,
        },
      } as never,
    });

    await expect(repository.commitCapture(input)).rejects.toMatchObject({
      code: 'INTERNAL',
      details: {
        reasonCode: 'MEMORY_CAPTURE_INTEGRITY_FAILED',
        stage: 'memory.repository.capture.idempotency',
      },
    });
  });

  it('does not overwrite an unrelated audit that occupies the legacy short-hash id', async () => {
    const workspace = port();
    const repository = new MultiActorMemoryRepository(workspace);
    repository.bind('w', 'chat');
    await repository.open();
    const transactionKey = 'capture:hash-collision-sentinel';
    const occupiedId = `change-audit:${legacyStableKey(transactionKey)}`;
    await workspace.upsert({
      workspaceId: 'w', collection: 'change-audits', recordId: occupiedId,
      value: {
        id: occupiedId, workspaceId: 'w', chatKey: 'chat', kind: 'capture-change-set-v0', createdAt: 1, entries: [],
        metadata: { transactionKey: 'another-transaction', sourceRefs: ['source:other'], captureJobId: 'job:other' },
      },
    });

    const audit = await repository.commitCapture({ ...commit(40, 0), captureJobId: 'job:collision', idempotencyKey: transactionKey });

    expect(audit.id).not.toBe(occupiedId);
    expect(audit.metadata).toMatchObject({ transactionKey, baseTransactionKey: transactionKey });
    expect((await workspace.get({ workspaceId: 'w', collection: 'change-audits', recordId: occupiedId }))?.value)
      .toMatchObject({ metadata: { transactionKey: 'another-transaction' } });
  });

  it('increments rehearsal only when a merged trace has a novel observation', async () => {
    const repository = new MultiActorMemoryRepository(port()); repository.bind('w', 'chat'); await repository.open();
    await repository.commitCapture({ ...commit(40, 0), idempotencyKey: 'capture:rehearsal:first' });
    expect((await repository.listTraces())[0]!.rehearsalCount).toBe(0);
    await repository.commitCapture({
      ...commit(40, 0),
      idempotencyKey: 'capture:rehearsal:second',
      traces: [{ ...commit(40, 0).traces[0]!, sourceObservationIds: ['o2'] }],
    });
    expect((await repository.listTraces())[0]!.rehearsalCount).toBe(1);
  });

  it('writes one fact head for a superseded predecessor and its replacement', async () => {
    const workspace = port();
    const repository = new MultiActorMemoryRepository(workspace); repository.bind('w', 'chat'); await repository.open();
    const base = commit(0, 0);
    const predecessor = { ...base.facts[0]!, kind: 'state' as const, status: 'superseded' as const, supersededById: 'fact:new', revision: 2, updatedAt: 2 };
    const replacement = { ...base.facts[0]!, kind: 'state' as const, id: 'fact:new', content: 'A知道新的铜钥匙位置', revision: 1, supersedesId: predecessor.id, updatedAt: 3 };
    await repository.commitCapture({ ...base, facts: [predecessor, replacement], traces: [], evidence: [] });
    const head = await workspace.get({ workspaceId: 'w', collection: 'fact-heads', recordId: 'fact-head:chat:A%3A%3A%E7%9F%A5%E9%81%93' });
    expect(head?.value).toMatchObject({ factId: 'fact:new' });
  });

  it('keeps an existing Active fact as slot head when a later low-confidence fact is Pending', async () => {
    const workspace = port();
    const repository = new MultiActorMemoryRepository(workspace);
    repository.bind('w', 'chat');
    await repository.open();
    const base = commit(0, 0);
    const active = { ...base.facts[0]!, kind: 'state' as const };
    await repository.commitCapture({ ...base, idempotencyKey: 'capture:active-head', facts: [active] });
    const pending = {
      ...active,
      id: 'fact:pending',
      canonicalKey: 'A::知道::另一个位置',
      content: 'A可能知道另一个铜钥匙位置',
      confidence: 0.6,
      status: 'pending' as const,
      sourceRefs: ['source:pending'],
      evidenceIds: ['evidence:pending'],
      freshestEvidenceAt: 2,
      createdAt: 2,
      updatedAt: 2,
    };
    await repository.commitCapture({
      ...base,
      idempotencyKey: 'capture:pending-head',
      envelope: { ...base.envelope, sourceRefs: ['source:pending'] },
      facts: [pending],
      evidence: [{ id: 'evidence:pending', workspaceId: 'w', chatKey: 'chat', factId: pending.id, sourceRef: 'source:pending', excerpt: pending.content, occurredAt: 2, createdAt: 2 }],
      traces: [],
    });

    const headId = 'fact-head:chat:A%3A%3A%E7%9F%A5%E9%81%93';
    expect(await workspace.get({ workspaceId: 'w', collection: 'fact-heads', recordId: headId }))
      .toMatchObject({ value: { factId: 'fact:f' } });
    expect(await repository.listFacts()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'fact:f', status: 'active' }),
      expect.objectContaining({ id: 'fact:pending', status: 'pending' }),
    ]));
  });

  it('keeps event, goal and commitment rows headless and append-only', async () => {
    for (const kind of ['event', 'goal', 'commitment'] as const) {
      const workspace = port();
      const repository = new MultiActorMemoryRepository(workspace);
      repository.bind('w', 'chat');
      await repository.open();
      const base = commit(0, 0);
      const first = { ...base.facts[0]!, kind, id: `fact:${kind}:1`, content: `${kind} 第一条`, canonicalKey: `A::知道::${kind}:1` };
      const second = { ...base.facts[0]!, kind, id: `fact:${kind}:2`, content: `${kind} 第二条`, canonicalKey: `A::知道::${kind}:2`, freshestEvidenceAt: 2, updatedAt: 2 };

      await repository.commitCapture({ ...base, idempotencyKey: `capture:${kind}:1`, facts: [first], traces: [], evidence: [] });
      await repository.commitCapture({ ...base, idempotencyKey: `capture:${kind}:2`, facts: [second], traces: [], evidence: [] });

      expect((await repository.listFacts()).filter(fact => fact.kind === kind).map(fact => fact.id).sort())
        .toEqual([first.id, second.id].sort());
      expect(await workspace.get({
        workspaceId: 'w',
        collection: 'fact-heads',
        recordId: 'fact-head:chat:A%3A%3A%E7%9F%A5%E9%81%93',
      })).toBeNull();
    }
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

  it('leaves progress aggregation to MemoryApplication instead of overwriting the job per batch', async () => {
    const repository = new MultiActorMemoryRepository(port());
    repository.bind('w', 'chat');
    await repository.open();
    await repository.upsertCaptureJob({ id: 'job:init', workspaceId: 'w', chatKey: 'chat', type: 'initialize', status: 'running', checkpoint: { batchIndex: 0, totalBatches: 1, processedCount: 0 }, createdAt: 1, updatedAt: 1 });
    const audit = await repository.commitCapture({ ...commit(40, 0), captureJobId: 'job:init' });
    expect((await repository.listCaptureJobs()).find(item => item.id === 'job:init')).toMatchObject({ status: 'running', type: 'initialize' });
    await repository.rollbackChangeSet(audit.id);
    expect((await repository.listCaptureJobs()).find(item => item.id === 'job:init')).toMatchObject({ status: 'running', type: 'initialize' });
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
      kind: 'state',
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
    await workspace.upsert({ workspaceId: 'w', collection: 'memory-traces', recordId: traceId, value: { id: traceId, workspaceId: 'w', chatKey: 'chat', ownerId: 'owner:actor:a', factId: fact.id, sourceObservationIds: [], knowledgeMode: 'asserted', privacy: 'public', strength: 80, clarity: 80, beliefConfidence: 1, emotionalSalience: 0, rehearsalCount: 0, traceRevision: 1, learnedAt: 1, createdAt: 1, updatedAt: 1 } });
    await workspace.upsert({ workspaceId: 'w', collection: 'profile-claims', recordId: 'profile:test', value: { id: 'profile:test', workspaceId: 'w', ownerId: 'owner:actor:a', claim: fact.content, level: 3, supportingTraceIds: [traceId], confidence: 1, status: 'active', createdAt: 1, updatedAt: 1 } });
    const updated = await repository.upsertManualFact({ ...fact, id: fact.id, content: 'A知道新的铜钥匙位置' });
    expect(updated.revision).toBe(2);
    expect((await repository.listFacts())[0]?.content).toBe('A知道新的铜钥匙位置');
    expect(await workspace.get({ workspaceId: 'w', collection: 'profile-claims', recordId: 'profile:test' })).toBeNull();
    expect(await repository.removeFact(fact.id)).toBe(true);
    expect(await repository.listFacts()).toEqual([]);
    expect(await workspace.get({ workspaceId: 'w', collection: 'fact-heads', recordId: headId })).toBeNull();
  });

  it('keeps an Active manual state head when a lower-confidence competing state is Pending', async () => {
    const workspace = port();
    const repository = new MultiActorMemoryRepository(workspace);
    repository.bind('w', 'chat');
    await repository.open();
    const active = await repository.upsertManualFact({
      kind: 'state',
      subjectKey: '仓库',
      predicateKey: '库存数量',
      objectKey: '十五盒',
      content: '仓库当前保存十五盒肉类罐头。',
      confidence: 0.95,
    });
    const pending = await repository.upsertManualFact({
      kind: 'state',
      subjectKey: '仓库',
      predicateKey: '库存数量',
      objectKey: '十一盒',
      content: '仓库可能只剩十一盒肉类罐头。',
      confidence: 0.4,
    });
    const headId = `fact-head:${encodeURIComponent('chat')}:${encodeURIComponent(active.slotKey!)}`;
    expect(await workspace.get({ workspaceId: 'w', collection: 'fact-heads', recordId: headId }))
      .toMatchObject({ value: { factId: active.id } });
    expect(pending.status).toBe('pending');
    expect((await repository.listFacts()).find(item => item.id === active.id)).toMatchObject({ status: 'active' });
  });

  it('removes a mutable FactHead when a manual edit changes the fact into an append-only event', async () => {
    const workspace = port();
    const repository = new MultiActorMemoryRepository(workspace);
    repository.bind('w', 'chat');
    await repository.open();
    const fact = await repository.upsertManualFact({
      kind: 'state',
      subjectKey: '观察员',
      predicateKey: '所在位置',
      objectKey: '北门',
      content: '观察员当前位于北门。',
      confidence: 1,
    });
    const headId = `fact-head:${encodeURIComponent('chat')}:${encodeURIComponent(fact.slotKey!)}`;
    expect(await workspace.get({ workspaceId: 'w', collection: 'fact-heads', recordId: headId })).not.toBeNull();

    await repository.upsertManualFact({
      ...fact,
      kind: 'event',
      content: '观察员曾经抵达北门并完成检查。',
    });
    expect(await workspace.get({ workspaceId: 'w', collection: 'fact-heads', recordId: headId })).toBeNull();
  });

  it('rejects traces from the retired schema instead of inferring their chat', async () => {
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

    await expect(repository.listTraces()).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
      details: { reasonCode: 'SCHEMA_VALIDATION_FAILED', stage: 'memory.repository.trace.read' },
    });
  });

  it('rejects foreign-chat audits and derived records at the repository boundary', async () => {
    const workspace = port();
    const repository = new MultiActorMemoryRepository(workspace);
    repository.bind('w', 'chat-a');
    await repository.open();
    const foreignAudit = { id: 'audit:foreign', workspaceId: 'w', chatKey: 'chat-b', kind: 'derived-change-set-v0', createdAt: 1, entries: [] };
    await workspace.upsert({ workspaceId: 'w', collection: 'change-audits', recordId: foreignAudit.id, value: foreignAudit });

    await expect(repository.getChangeAudit(foreignAudit.id)).resolves.toBeUndefined();
    await expect(repository.rollbackChangeSet(foreignAudit.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      details: { reasonCode: 'WORKSPACE_NOT_FOUND', stage: 'memory.repository.rollback.lookup' },
    });
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

  it('stops on a repeated pagination cursor and clears one chat in one atomic change-set', async () => {
    const stalledWorkspace = port();
    const originalQuery = stalledWorkspace.query.bind(stalledWorkspace);
    stalledWorkspace.query = async (request) => request.collection === 'facts'
      ? { records: [], nextCursor: 'same-cursor' }
      : originalQuery(request);
    const stalledRepository = new MultiActorMemoryRepository(stalledWorkspace);
    stalledRepository.bind('w', 'chat');
    await stalledRepository.open();
    await expect(stalledRepository.listFacts()).rejects.toMatchObject({
      code: 'CONFLICT',
      details: {
        reasonCode: 'WORKSPACE_CONFLICT',
        stage: 'memory.persistence.pagination',
        collection: 'facts',
      },
    });

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
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0]?.[0].operations).toHaveLength(501);
  });
});
