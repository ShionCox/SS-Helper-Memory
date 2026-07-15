import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryVectorIndexService } from '../src/application/recall/vector-index-service';
import type { MemoryFact, MemoryFactVector } from '../src/domain';
import type { MemoryLlmApi } from '../src/application/ingest/llm-extractor';

function memoryFact(id: string): MemoryFact {
  return {
    id, chatKey: 'chat-a', kind: 'event', subjectKey: '人物', predicateKey: '经历',
    canonicalKey: `人物\u0000经历\u0000${id}`, content: `这是编号 ${id} 的完整事实内容，用于向量索引测试。`,
    entityKeys: ['人物'], confidence: 0.9, status: 'active', sourceRefs: [`source:${id}`],
    evidenceIds: [`evidence:${id}`], freshestEvidenceAt: 1, origin: 'automatic', revision: 1,
    createdAt: 1, updatedAt: 1,
  };
}

class FakeVectorRepository {
  readonly facts: MemoryFact[];
  readonly vectors: MemoryFactVector[] = [];
  readonly upsertFactVector = vi.fn(async (input: {
    factId: string; chatKey: string; content: string; resourceId: string; model: string; vector: Float32Array;
  }) => {
    this.vectors.push({
      factId: input.factId, chatKey: input.chatKey, contentHash: `hash:${input.content}`,
      resourceId: input.resourceId, model: input.model, dimensions: input.vector.length,
      vector: Float32Array.from(input.vector).buffer, createdAt: 1, updatedAt: 1,
    });
  });

  constructor(count = 2) {
    this.facts = Array.from({ length: count }, (_, index) => memoryFact(`fact-${index}`));
  }

  async clearFactVectors(): Promise<void> { this.vectors.length = 0; }
  async vectorSearch(input: { vector: Float32Array; resourceId?: string; model?: string }) {
    return this.vectors
      .filter(vector => vector.resourceId === input.resourceId && vector.model === input.model)
      .map(vector => ({
        factId: vector.factId,
        score: new Float32Array(vector.vector)[0] * input.vector[0] + new Float32Array(vector.vector)[1] * input.vector[1],
      }))
      .sort((left, right) => right.score - left.score);
  }
  async listFactsNeedingVectorRebuild(_chatKey: string, target: { resourceId: string; model: string; dimensions?: number }, limit: number): Promise<MemoryFact[]> {
    return this.facts.filter(fact => !this.vectors.some(vector => vector.factId === fact.id
      && vector.resourceId === target.resourceId && vector.model === target.model
      && (target.dimensions === undefined || vector.dimensions === target.dimensions))).slice(0, limit);
  }
  async getFactVectorCoverage(_chatKey: string, target: { resourceId: string; model: string; dimensions?: number }) {
    const ready = this.facts.filter(fact => this.vectors.some(vector => vector.factId === fact.id
      && vector.resourceId === target.resourceId && vector.model === target.model
      && (target.dimensions === undefined || vector.dimensions === target.dimensions))).length;
    return {
      chatKey: 'chat-a', totalFacts: this.facts.length, ready, missing: this.facts.length - ready,
      stale: 0, orphaned: 0, coverage: this.facts.length ? ready / this.facts.length : 1,
      readyFactIds: [], missingFactIds: [], staleFactIds: [], orphanedFactIds: [],
    };
  }
}

const routes = async () => ({
  embedding: { available: true, resourceId: 'giteeFREE', model: 'BAAI/bge-m3' },
  rerank: { available: true, resourceId: 'Rerank', model: 'BAAI/bge-reranker-v2-m3' },
});

afterEach(() => vi.useRealTimers());

describe('事实向量索引服务', () => {
  it('拒绝同批非法维度且不写入半批数据', async () => {
    const repository = new FakeVectorRepository();
    const embed = vi.fn(async () => ({ ok: true as const, vectors: [[1, 0], [1, 0, 0]], model: 'BAAI/bge-m3' }));
    const service = new MemoryVectorIndexService(repository as never, () => ({ embed } as unknown as MemoryLlmApi), routes);
    service.start();

    await service.rebuild('chat-a');
    const status = await service.getStatus('chat-a');

    expect(repository.upsertFactVector).not.toHaveBeenCalled();
    expect(status.lastError).toContain('维度不一致');
  });

  it('64 项 LRU 查询缓存会复用十分钟内的查询向量', async () => {
    const repository = new FakeVectorRepository(1);
    repository.vectors.push({
      factId: 'fact-0', chatKey: 'chat-a', contentHash: 'hash', resourceId: 'giteeFREE', model: 'BAAI/bge-m3',
      dimensions: 2, vector: new Float32Array([1, 0]).buffer, createdAt: 1, updatedAt: 1,
    });
    const embed = vi.fn(async () => ({ ok: true as const, vectors: [[1, 0]], model: 'BAAI/bge-m3' }));
    const service = new MemoryVectorIndexService(repository as never, () => ({ embed } as unknown as MemoryLlmApi), routes);
    service.start();

    const first = await service.search('chat-a', '同一个查询');
    const second = await service.search('chat-a', '同一个查询');

    expect(embed).toHaveBeenCalledTimes(1);
    expect(first.audit.cached).toBe(false);
    expect(second.audit.cached).toBe(true);
    expect(second.candidates[0]?.factId).toBe('fact-0');
  });

  it('embedding 超过 3 秒会失败并允许上层降级', async () => {
    vi.useFakeTimers();
    const repository = new FakeVectorRepository(0);
    const embed = vi.fn(() => new Promise<never>(() => undefined));
    const service = new MemoryVectorIndexService(repository as never, () => ({ embed } as unknown as MemoryLlmApi), routes);
    service.start();

    const pending = service.search('chat-a', '超时查询');
    const rejected = expect(pending).rejects.toThrow('超过 3000ms');
    await vi.advanceTimersByTimeAsync(3_001);
    await rejected;
  });

  it('stop 后丢弃在途 embedding 结果，不再写入 SQLite', async () => {
    const repository = new FakeVectorRepository(1);
    let release: ((value: { ok: true; vectors: number[][]; model: string }) => void) | undefined;
    const embed = vi.fn(() => new Promise<{ ok: true; vectors: number[][]; model: string }>((resolve) => { release = resolve; }));
    const service = new MemoryVectorIndexService(repository as never, () => ({ embed } as unknown as MemoryLlmApi), routes);
    service.start();

    const rebuilding = service.rebuild('chat-a');
    await Promise.resolve();
    service.stop();
    release?.({ ok: true, vectors: [[1, 0]], model: 'BAAI/bge-m3' });
    await rebuilding;

    expect(repository.upsertFactVector).not.toHaveBeenCalled();
  });
});
