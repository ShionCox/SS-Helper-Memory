import { describe, expect, it } from 'vitest';

import { reduceInitializationBatches, type InitializationStagingBatch } from '../src/application/ingest/initialization-finalizer';
import type { MemoryFact, MemoryJob } from '../src/domain';
import { MemoryRepository } from '../src/infrastructure/memory-repository';
import type { WorkspacePort, WorkspaceRecord } from '@ss-helper/sdk';

function memoryWorkspace(): { port: WorkspacePort; records: Map<string, Map<string, WorkspaceRecord>> } {
  const records = new Map<string, Map<string, WorkspaceRecord>>();
  const collection = (name: string): Map<string, WorkspaceRecord> => {
    const current = records.get(name);
    if (current) return current;
    const created = new Map<string, WorkspaceRecord>();
    records.set(name, created);
    return created;
  };
  const port = {
    health: async () => ({ ready: true, database: 'ss-helper.sqlite3', schemaVersion: 4 }),
    integrity: async () => ({ ok: true, messages: [] }),
    open: async () => ({ ownerPluginId: 'test', workspaceId: 'character:c1', created: false }),
    defineCollection: async () => undefined,
    get: async (request: { collection: string; recordId: string }) => collection(request.collection).get(request.recordId) ?? null,
    upsert: async (request: { collection: string; recordId: string; value: unknown }) => {
      const record = { recordId: request.recordId, value: structuredClone(request.value), version: 1, updatedAt: 1 } as WorkspaceRecord;
      collection(request.collection).set(request.recordId, record);
      return record;
    },
    query: async (request: { collection: string; filter?: Record<string, unknown> }) => ({
      records: [...collection(request.collection).values()].filter((record) => Object.entries(request.filter ?? {}).every(([key, value]) => (record.value as Record<string, unknown>)[key] === value)),
      nextCursor: null,
    }),
    transaction: async (request: { operations: Array<{ action: string; collection: string; recordId: string; value?: unknown }> }) => {
      for (const operation of request.operations) {
        if (operation.action === 'delete') collection(operation.collection).delete(operation.recordId);
        else collection(operation.collection).set(operation.recordId, { recordId: operation.recordId, value: structuredClone(operation.value), version: 1, updatedAt: 1 } as WorkspaceRecord);
      }
      return { operationCount: request.operations.length, replayed: false, results: [] };
    },
    list: async () => ({ workspaces: [], nextCursor: null }), removeWorkspace: async () => undefined, clearOwned: async () => 0,
    delete: async () => false,
    vectorUpsert: async () => undefined, vectorSearch: async () => [], vectorDelete: async () => false, vectorList: async () => ({ vectors: [], nextCursor: null }), vectorClear: async () => 0,
    grant: async () => undefined, revoke: async () => undefined, export: async () => new Blob(), import: async () => undefined, exportAll: async () => new Blob(), importAll: async () => undefined,
  } as unknown as WorkspacePort;
  return { port, records };
}

function staging(): InitializationStagingBatch {
  const excerpt = '盖乌斯确认训练成果已经达到当前阶段的要求。';
  return {
    id: '', kind: 'initialization-staging-v1', chatKey: 'chat-a', jobId: 'job-a', batchIndex: 1, totalBatches: 1, processedCount: 1,
    sources: [{ id: 'message:1', type: 'message', occurredAt: 100 }],
    facts: [{
      kind: 'state', subjectKey: '盖乌斯', predicateKey: '训练评价', objectKey: '认可',
      content: '盖乌斯已确认当前训练成果达到要求，并认可墨染尘在这一阶段的稳定表现。', entityKeys: ['盖乌斯', '墨染尘'], confidence: 0.96,
      sourceRef: 'message:1', evidenceExcerpt: excerpt, actionHint: 'supersede', canonicalKey: 'state|盖乌斯|训练评价|认可',
    }],
    rejections: [],
    audit: {
      requestId: 'req-1', resourceId: '__builtin_tavern__', model: 'deepseek-chat', latencyMs: 321,
      usage: { promptTokens: 100, completionTokens: 20, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: 120 },
    },
    createdAt: 100, updatedAt: 100,
  };
}

describe('initialization finalization repository transaction', () => {
  it('writes final facts and evidence atomically, then removes bulky staging rows', async () => {
    const { port, records } = memoryWorkspace();
    const repository = new MemoryRepository(port);
    repository.bind('character:c1', 'chat-a');
    const staged = staging();
    await repository.putInitializationStagingBatch(staged);
    const batches = await repository.listInitializationStagingBatches('chat-a', 'job-a');
    const reduction = reduceInitializationBatches('job-a', batches);
    await repository.putInitializationResolution({ id: '', kind: 'initialization-resolution-v1', chatKey: 'chat-a', jobId: 'job-a', reduction, createdAt: 100, updatedAt: 100 });
    const job: MemoryJob = { id: 'job-a', chatKey: 'chat-a', type: 'initialize', status: 'running', checkpoint: { batchIndex: 1, totalBatches: 1, processedCount: 1, phase: 'apply' }, createdAt: 100, updatedAt: 100 };

    await repository.applyInitializationFinalization({ chatKey: 'chat-a', job, batches, reduction });

    const facts = [...records.get('facts')!.values()];
    expect(facts).toHaveLength(1);
    expect(facts[0]!.value).toMatchObject({ status: 'active', origin: 'automatic' });
    expect(records.get('evidence')?.size).toBe(1);
    expect(records.get('fact-slots')?.size).toBe(1);
    expect([...records.get('job-audits')!.values()].some((record) => (record.value as { kind?: string }).kind === 'initialization-staging-v1')).toBe(false);
    expect(await repository.getInitializationResolution('chat-a', 'job-a')).toBeUndefined();
    expect(records.get('jobs')?.get('job-a')?.value).toMatchObject({ status: 'completed' });
    const finalAudit = [...records.get('job-audits')!.values()].find((record) => (record.value as { kind?: string }).kind === 'initialization-finalization-v1');
    expect(finalAudit?.value).toMatchObject({
      routeSummary: {
        requestCount: 1,
        resourceIds: ['__builtin_tavern__'],
        models: ['deepseek-chat'],
        latencyMs: 321,
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      },
      resourceId: '__builtin_tavern__',
      model: 'deepseek-chat',
    });
  });

  it('keeps a manual fact protected when an automatic initialization targets its slot', async () => {
    const { port, records } = memoryWorkspace();
    const repository = new MemoryRepository(port);
    repository.bind('character:c1', 'chat-a');
    const manual: MemoryFact = {
      id: 'manual:training-evaluation', chatKey: 'chat-a', kind: 'state', subjectKey: '盖乌斯', predicateKey: '训练评价', objectKey: '手工确认',
      canonicalKey: 'state|盖乌斯|训练评价|手工确认', slotKey: '盖乌斯::训练评价', content: '手工维护的训练评价应始终优先于自动初始化结果。', entityKeys: ['盖乌斯'], confidence: 1,
      status: 'active', sourceRefs: [], evidenceIds: [], freshestEvidenceAt: 90, origin: 'manual', revision: 1, createdAt: 90, updatedAt: 90,
    };
    records.set('facts', new Map([[manual.id, { recordId: manual.id, value: manual, version: 1, updatedAt: 90 } as unknown as WorkspaceRecord]]));
    const staged = staging();
    await repository.putInitializationStagingBatch(staged);
    const batches = await repository.listInitializationStagingBatches('chat-a', 'job-a');
    const reduction = reduceInitializationBatches('job-a', batches);
    const job: MemoryJob = { id: 'job-a', chatKey: 'chat-a', type: 'initialize', status: 'running', checkpoint: { batchIndex: 1, totalBatches: 1, processedCount: 1, phase: 'apply' }, createdAt: 100, updatedAt: 100 };

    const stats = await repository.applyInitializationFinalization({ chatKey: 'chat-a', job, batches, reduction });

    const facts = [...records.get('facts')!.values()].map((record) => record.value as unknown as MemoryFact);
    expect(facts.find((fact) => fact.id === manual.id)?.status).toBe('active');
    expect(facts.find((fact) => fact.origin === 'automatic')?.status).toBe('pending');
    expect(stats.qualityStatus).toBe('needs_review');
  });
});
