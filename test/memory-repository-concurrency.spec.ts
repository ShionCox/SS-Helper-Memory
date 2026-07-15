import { describe, expect, it, vi } from 'vitest';
import type { IngestCommit } from '../src/application/ingest/types';
import { MemoryRepository } from '../src/infrastructure/memory-repository';
import { MemorySqliteError, type MemorySqliteClient } from '../src/infrastructure/memory-sqlite-client';

function commitInput(): IngestCommit {
  const excerpt = '角色确认仓库中仍保存着足够饮用水和高热量口粮。';
  return {
    chatKey: 'chat-a',
    jobId: 'job-a',
    sources: [{
      id: 'source-a', chatKey: 'chat-a', kind: 'message', role: 'assistant',
      content: excerpt, createdAt: 100,
    }],
    facts: [{
      kind: 'state', subjectKey: '仓库', predicateKey: '储备', objectKey: '充足',
      content: '仓库当前仍保存着足够的饮用水和高热量口粮，可继续支持队伍行动。',
      entityKeys: ['仓库'], confidence: 0.95, sourceRef: 'source-a', evidenceExcerpt: excerpt,
      actionHint: 'supersede', canonicalKey: 'ignored-by-domain-validation',
    }],
    checkpoint: { sourceIds: ['source-a'], completedAt: 100, batchIndex: 1, processedCount: 1 },
  };
}

describe('MemoryRepository 多标签乐观锁', () => {
  it('编辑历史链事实时保留双向关系并提交 revision 与 slot 基线', async () => {
    const previous = {
      id: 'fact-current', chatKey: 'chat-a', kind: 'state' as const,
      subjectKey: '小时', predicateKey: '武器数量', objectKey: '2',
      canonicalKey: '小时::武器数量::2', slotKey: '小时::武器数量',
      content: '当前有两把武器。', entityKeys: ['小时'], confidence: 1,
      status: 'active' as const, sourceRefs: ['manual:fact-current'], evidenceIds: ['evidence:old'],
      freshestEvidenceAt: 100, origin: 'manual' as const, revision: 4,
      supersedesId: 'fact-history', createdAt: 50, updatedAt: 100,
    };
    const query = vi.fn(async (resource: string) => {
      if (resource === 'fact') return previous;
      if (resource === 'facts') return [previous];
      return [];
    });
    const command = vi.fn(async (_action: string, payload: Record<string, unknown>) => payload.fact);
    const repository = new MemoryRepository({ query, command } as unknown as MemorySqliteClient);

    const saved = await repository.upsertManualFact('chat-a', {
      id: previous.id,
      kind: previous.kind,
      subjectKey: previous.subjectKey,
      predicateKey: previous.predicateKey,
      objectKey: previous.objectKey,
      content: '编辑后仍有两把武器。',
      entityKeys: previous.entityKeys,
      confidence: previous.confidence,
      status: previous.status,
    });

    expect(saved).toMatchObject({ supersedesId: 'fact-history', revision: 5 });
    expect(command).toHaveBeenCalledWith('fact.upsert', expect.objectContaining({
      expectedRevision: 4,
      expectedSlotFactId: previous.id,
      expectedRelatedRevisions: {},
    }));
  });

  it('revision 冲突后只重读并重算一次，同时提交 slot 基线', async () => {
    const query = vi.fn(async (resource: string) => resource === 'facts' ? [] : []);
    let calls = 0;
    const command = vi.fn(async (_action: string, payload: Record<string, unknown>) => {
      calls += 1;
      if (calls === 1) throw new MemorySqliteError('事实已变化', 'REVISION_CONFLICT', 409);
      return {
        facts: payload.facts, accepted: 1, duplicated: 0, pending: 0, superseded: 0, rejected: [],
      };
    });
    const repository = new MemoryRepository({ query, command } as unknown as MemorySqliteClient);

    const result = await repository.commitIngest(commitInput());

    expect(result.accepted).toBe(1);
    expect(query).toHaveBeenCalledTimes(2);
    expect(command).toHaveBeenCalledTimes(2);
    const payload = command.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(payload.baseRevisions).toEqual({});
    expect(payload.baseSlotFactIds).toEqual({ '仓库::储备': null });
  });

  it('第二次 revision 冲突明确失败，不进入无限重试', async () => {
    const query = vi.fn(async () => []);
    const command = vi.fn(async () => {
      throw new MemorySqliteError('持续冲突', 'REVISION_CONFLICT', 409);
    });
    const repository = new MemoryRepository({ query, command } as unknown as MemorySqliteClient);

    await expect(repository.commitIngest(commitInput())).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(query).toHaveBeenCalledTimes(2);
    expect(command).toHaveBeenCalledTimes(2);
  });

  it('分页读取全部批次审计，避免超过单页后重复整理早期来源', async () => {
    const query = vi.fn(async (resource: string, input: { offset?: number }) => {
      if (resource !== 'job_batch_audits') return [];
      const offset = input.offset ?? 0;
      if (offset === 0) return Array.from({ length: 1_000 }, (_, index) => ({ id: `audit:${index}` }));
      if (offset === 1_000) return [{ id: 'audit:1000' }];
      return [];
    });
    const repository = new MemoryRepository({ query } as unknown as MemorySqliteClient);

    const audits = await repository.listJobBatchAudits('chat-a');

    expect(audits).toHaveLength(1_001);
    expect(query).toHaveBeenNthCalledWith(1, 'job_batch_audits', expect.objectContaining({ limit: 1_000, offset: 0 }));
    expect(query).toHaveBeenNthCalledWith(2, 'job_batch_audits', expect.objectContaining({ limit: 1_000, offset: 1_000 }));
  });
});
