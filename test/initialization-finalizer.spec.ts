import { describe, expect, it } from 'vitest';

import {
  applyInitializationConflictResolutions,
  reduceInitializationBatches,
  type InitializationStagingBatch,
} from '../src/application/ingest/initialization-finalizer';
import type { ValidatedFactProposal } from '../src/application/ingest/types';

function proposal(input: Partial<ValidatedFactProposal> = {}): ValidatedFactProposal {
  return {
    kind: 'state',
    subjectKey: '盖乌斯',
    predicateKey: '所在地',
    objectKey: '训练场',
    content: '盖乌斯目前留在训练场，持续观察墨染尘的训练进度并给予指示。',
    entityKeys: ['盖乌斯', '训练场'],
    confidence: 0.92,
    sourceRef: 'message:1',
    evidenceExcerpt: '盖乌斯留在训练场观察训练进度。',
    actionHint: 'supersede',
    canonicalKey: 'state|盖乌斯|所在地|训练场',
    ...input,
  };
}

function batch(index: number, facts: ValidatedFactProposal[], occurredAt = index * 100): InitializationStagingBatch {
  return {
    id: `initialization-staging:job:${index}`,
    kind: 'initialization-staging-v0',
    chatKey: 'chat-a',
    jobId: 'job',
    batchIndex: index,
    totalBatches: 2,
    processedCount: index,
    sources: facts.map((fact, factIndex) => ({ id: fact.sourceRef, type: 'message', occurredAt: occurredAt + factIndex })),
    facts,
    rejections: [],
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
}

describe('initialization global finalizer', () => {
  it('merges exact facts across batches and retains every evidence reference', () => {
    const first = proposal();
    const second = proposal({ sourceRef: 'message:2', evidenceExcerpt: '盖乌斯仍在训练场观察训练进度。' });
    const reduced = reduceInitializationBatches('job', [batch(1, [first], 100), batch(2, [second], 200)]);

    expect(reduced.facts).toHaveLength(1);
    expect(reduced.facts[0]).toMatchObject({ status: 'active', sourceRefs: ['message:1', 'message:2'] });
    expect(reduced.facts[0]?.evidence).toHaveLength(2);
    expect(reduced.stats.mergedDuplicateCount).toBe(1);
  });

  it('keeps additive event and commitment facts independently addressable', () => {
    const eventA = proposal({ kind: 'event', predicateKey: '训练进展', objectKey: '第一周', canonicalKey: 'event|训练|进展|第一周' });
    const eventB = proposal({ kind: 'event', predicateKey: '训练进展', objectKey: '第二周', canonicalKey: 'event|训练|进展|第二周', sourceRef: 'message:2' });
    const reduced = reduceInitializationBatches('job', [batch(1, [eventA, eventB])]);

    expect(reduced.facts).toHaveLength(2);
    expect(reduced.facts.every((fact) => fact.status === 'active')).toBe(true);
    expect(new Set(reduced.facts.map((fact) => fact.slotKey)).size).toBe(2);
    expect(reduced.conflictBuckets).toHaveLength(0);
  });

  it('uses a local rule for newer high-confidence temporal facts', () => {
    const earlier = proposal({ objectKey: '训练场', canonicalKey: 'state|盖乌斯|所在地|训练场', confidence: 0.9 });
    const later = proposal({ objectKey: '书房', canonicalKey: 'state|盖乌斯|所在地|书房', content: '盖乌斯已返回书房整理训练笔记，并准备下一阶段的评估安排。', sourceRef: 'message:2', evidenceExcerpt: '盖乌斯回到书房整理训练笔记。', confidence: 0.95 });
    const reduced = reduceInitializationBatches('job', [batch(1, [earlier], 100), batch(2, [later], 200)]);

    expect(reduced.conflictBuckets).toHaveLength(0);
    expect(reduced.stats.ruleResolvedCount).toBe(1);
    expect(reduced.facts.find((fact) => fact.objectKey === '书房')?.status).toBe('active');
    expect(reduced.facts.find((fact) => fact.objectKey === '训练场')?.status).toBe('superseded');
  });

  it('keeps unresolved stable settings pending until a validated resolver selection arrives', () => {
    const first = proposal({ kind: 'world_rule', subjectKey: '魔法体系', predicateKey: '施法限制', objectKey: '需要媒介', canonicalKey: 'world_rule|魔法体系|施法限制|需要媒介' });
    const second = proposal({ kind: 'world_rule', subjectKey: '魔法体系', predicateKey: '施法限制', objectKey: '无需媒介', canonicalKey: 'world_rule|魔法体系|施法限制|无需媒介', sourceRef: 'message:2', content: '该世界的魔法体系允许少数施法者在无需媒介的情况下直接完成施法。', evidenceExcerpt: '少数施法者无需媒介也能施法。' });
    const reduced = reduceInitializationBatches('job', [batch(1, [first], 100), batch(2, [second], 200)]);

    expect(reduced.conflictBuckets).toHaveLength(1);
    expect(reduced.facts.every((fact) => fact.status === 'pending')).toBe(true);
    const [left, right] = reduced.facts;
    const resolved = applyInitializationConflictResolutions(reduced, [{
      bucketId: reduced.conflictBuckets[0]!.id,
      action: 'supersede',
      primaryId: right!.id,
      secondaryIds: [left!.id],
      resolver: 'llm',
    }]);
    expect(resolved.stats).toMatchObject({ llmResolvedCount: 1, pendingReviewCount: 0, qualityStatus: 'ready' });
    expect(resolved.facts.find((fact) => fact.id === right!.id)?.status).toBe('active');
  });
});
