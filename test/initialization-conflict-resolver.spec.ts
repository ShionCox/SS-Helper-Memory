import { describe, expect, it, vi } from 'vitest';

import { resolveInitializationConflicts } from '../src/application/ingest/initialization-conflict-resolver';
import type { InitializationConflictBucket, InitializationReducedFact } from '../src/application/ingest/initialization-finalizer';

const facts: InitializationReducedFact[] = [
  {
    id: 'record-a', kind: 'world_rule', subjectKey: '魔法', predicateKey: '限制', objectKey: '媒介', canonicalKey: 'a', slotKey: '魔法::限制',
    content: '这个世界的施法通常需要稳定媒介来维持魔力输出和法术结构。', entityKeys: ['魔法'], confidence: 0.9,
    evidence: [{ sourceRef: 'message:1', excerpt: '施法通常需要媒介。' }], sourceRefs: ['message:1'], freshestEvidenceAt: 100, status: 'pending', conflictBucketId: 'bucket-a',
  },
  {
    id: 'record-b', kind: 'world_rule', subjectKey: '魔法', predicateKey: '限制', objectKey: '无媒介', canonicalKey: 'b', slotKey: '魔法::限制',
    content: '少数高阶施法者能够在无需媒介的情况下直接构成完整法术并稳定释放。', entityKeys: ['魔法'], confidence: 0.86,
    evidence: [{ sourceRef: 'message:2', excerpt: '高阶施法者无需媒介。' }], sourceRefs: ['message:2'], freshestEvidenceAt: 200, status: 'pending', conflictBucketId: 'bucket-a',
  },
];

const buckets: InitializationConflictBucket[] = [{ id: 'bucket-a', kind: 'world_rule', slotKey: '魔法::限制', mode: 'stable', recordIds: ['record-a', 'record-b'] }];

describe('initialization conflict resolver', () => {
  it('accepts only record-id selections from the current conflict bucket', async () => {
    const runTask = vi.fn(async () => ({ ok: true as const, data: { resolutions: [
      { bucketId: 'bucket-a', action: 'supersede', primaryId: 'record-b', secondaryIds: ['record-a'] },
      { bucketId: 'bucket-a', action: 'merge', primaryId: 'invented', secondaryIds: ['record-a'] },
    ] } }));
    const result = await resolveInitializationConflicts({ llm: { runTask } as never, buckets, facts });

    expect(runTask).toHaveBeenCalledWith(expect.objectContaining({ taskKey: 'memory_initialize_conflict_resolve' }));
    expect(result.resolutions).toEqual([expect.objectContaining({ bucketId: 'bucket-a', primaryId: 'record-b', secondaryIds: ['record-a'], resolver: 'llm' })]);
  });

  it('returns a reviewable fallback when no generation route is available', async () => {
    await expect(resolveInitializationConflicts({ llm: null, buckets, facts })).resolves.toMatchObject({ resolutions: [], error: expect.stringContaining('不可用') });
  });
});
