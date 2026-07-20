import { describe, expect, it, vi } from 'vitest';
import type { MemoryFact } from '../src/domain';
import { ExistingMemoryContextRetriever } from '../src/application/ingest/existing-memory-context';
import type { SourceBlock } from '../src/application/ingest/types';
import type { MemoryVectorIndexService } from '../src/application/recall';

function fact(id: string, content: string, chatKey = 'chat-a'): MemoryFact {
  return {
    id, chatKey, kind: 'preference', subjectKey: 'Aerin', predicateKey: 'fears', objectKey: 'thunder',
    canonicalKey: `preference|aerin|fears|thunder|${id}`, slotKey: 'aerin|fears', content, entityKeys: ['Aerin', 'thunder'],
    confidence: 0.95, status: 'active', sourceRefs: ['message:old'], evidenceIds: [], freshestEvidenceAt: 1,
    origin: 'automatic', revision: 1, createdAt: 1, updatedAt: 1,
  };
}

const source: SourceBlock = {
  id: 'message:new', chatKey: 'chat-a', kind: 'message', role: 'user',
  content: 'Aerin fears thunder whenever storms arrive.', createdAt: 2,
};

describe('提取前旧记忆上下文', () => {
  it('在向量不可用时回退关键词，并返回不含持久化 ID 或证据的顺序引用', async () => {
    const search = vi.fn(async () => { throw new Error('embedding unavailable'); });
    const retriever = new ExistingMemoryContextRetriever(
      [fact('fact-baseline', 'Aerin fears thunder because of a childhood storm.')],
      { search } as unknown as MemoryVectorIndexService,
    );

    const context = await retriever.load({ chatKey: 'chat-a', sources: [source], maxItems: 1, maxChars: 500, mode: 'auto' });

    expect(search).toHaveBeenCalledOnce();
    expect(context).toEqual([expect.objectContaining({
      referenceId: 'M1', content: 'Aerin fears thunder because of a childhood storm.',
    })]);
    expect(context[0]).not.toHaveProperty('id');
    expect(context[0]).not.toHaveProperty('sourceRef');
    expect(context[0]).not.toHaveProperty('evidenceExcerpt');
  });

  it('永远不会从 capture 开始后才出现的向量候选读取事实', async () => {
    const search = vi.fn(async () => ({
      candidates: [{ factId: 'fact-written-during-job', score: 0.99, rank: 1 }],
      cutoff: 0.2,
      audit: { inputCount: 1, latencyMs: 1, usage: null },
    }));
    const retriever = new ExistingMemoryContextRetriever(
      [fact('fact-baseline', 'An unrelated baseline preference.')],
      { search } as unknown as MemoryVectorIndexService,
    );

    await expect(retriever.load({ chatKey: 'chat-a', sources: [source], maxItems: 8, maxChars: 2_400, mode: 'vector' })).resolves.toEqual([]);
    expect(search).toHaveBeenCalledWith('chat-a', expect.any(String), 60);
  });

  it('不截断超出预算的单条事实，并继续选择后续可完整放入的候选', async () => {
    const search = vi.fn(async () => ({
      candidates: [
        { factId: 'fact-too-long', score: 0.99, rank: 1 },
        { factId: 'fact-fits', score: 0.90, rank: 2 },
      ],
      cutoff: 0.2,
      audit: { inputCount: 1, latencyMs: 1, usage: null },
    }));
    const retriever = new ExistingMemoryContextRetriever(
      [
        { ...fact('fact-too-long', '很长的旧事实。'.repeat(120)), predicateKey: 'long-topic', slotKey: 'aerin|long-topic' },
        { ...fact('fact-fits', 'Aerin fears thunder because of a childhood storm.'), predicateKey: 'short-topic', slotKey: 'aerin|short-topic' },
      ],
      { search } as unknown as MemoryVectorIndexService,
    );

    const context = await retriever.load({ chatKey: 'chat-a', sources: [source], maxItems: 1, maxChars: 500, mode: 'vector' });

    expect(context).toEqual([expect.objectContaining({ referenceId: 'M1', content: 'Aerin fears thunder because of a childhood storm.' })]);
  });
});
