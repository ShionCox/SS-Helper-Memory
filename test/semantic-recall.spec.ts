import { describe, expect, it, vi } from 'vitest';
import { MemoryRecallIndex, type RecallFact } from '../src/application/recall/memory-recall-index';
import { SemanticRecallService, semanticRecallLimits } from '../src/application/recall/semantic-recall-service';
import type { MemoryLlmApi } from '../src/application/ingest/llm-extractor';
import type { VectorSearchResult } from '../src/application/recall/vector-index-service';

const NOW = Date.parse('2026-07-13T12:00:00+08:00');

function fact(id: string, content: string, overrides: Partial<RecallFact> = {}): RecallFact {
  return {
    id,
    chatKey: 'chat-a',
    kind: 'event',
    subjectKey: '白夕小时',
    predicateKey: '记录',
    content,
    entityKeys: ['白夕小时'],
    confidence: 0.92,
    status: 'active',
    evidenceRefs: [`evidence:${id}`],
    updatedAt: NOW,
    ...overrides,
  };
}

function vectorResult(scores: Array<[string, number]>, extra: Partial<VectorSearchResult['audit']> = {}): VectorSearchResult {
  return {
    candidates: scores.map(([factId, score], index) => ({ factId, score, rank: index + 1 })),
    cutoff: scores.at(-1)?.[1] ?? null,
    audit: {
      resourceId: 'giteeFREE', model: 'BAAI/bge-m3', dimensions: 1024,
      inputCount: 1, latencyMs: 32, usage: null, ...extra,
    },
  };
}

function service(
  facts: RecallFact[],
  scores: Array<[string, number]>,
  rerank?: MemoryLlmApi['rerank'],
): SemanticRecallService {
  const vectors = { search: vi.fn(async () => vectorResult(scores)) };
  const llm = rerank ? ({ rerank } as MemoryLlmApi) : null;
  return new SemanticRecallService(new MemoryRecallIndex(facts), vectors as never, () => llm);
}

describe('语义、混合召回与 LLM rerank', () => {
  it('为真实 rerank 保留 15 秒窗口及完整额外召回预算', () => {
    expect(semanticRecallLimits).toEqual({ rerankTimeoutMs: 15_000, totalExtraBudgetMs: 19_000 });
  });

  it('纯向量能召回没有关键词重叠的同义改写', async () => {
    const target = fact('early-stock', '白夕小时最早从超市带回饮用水和高热量长期口粮。');
    const result = await service([target], [['early-stock', 0.86]])
      .recall({ chatKey: 'chat-a', query: '起初为了长期生存囤了哪些应急补给？', now: NOW }, 'vector', 'off');

    expect(result.items.map(item => item.fact.id)).toEqual(['early-stock']);
    expect(result.items[0]).toMatchObject({ vectorScore: 0.86, reason: { vector: true } });
    expect(result.diagnostics).toMatchObject({ requestedMode: 'vector', resolvedMode: 'vector', vectorCandidateCount: 1 });
  });

  it('混合召回用 RRF 合并关键词和向量排名', async () => {
    const lexical = fact('lexical', '泳池战斗中发现了危险核心。');
    const semantic = fact('semantic', '沈夜败退后留下的黯欲之种具有高风险。', { entityKeys: ['沈夜', '黯欲之种'] });
    const result = await service([lexical, semantic], [['semantic', 0.91], ['lexical', 0.84]])
      .recall({ chatKey: 'chat-a', query: '泳池战斗危险核心', now: NOW }, 'hybrid', 'off');

    expect(result.items.map(item => item.fact.id)).toEqual(expect.arrayContaining(['lexical', 'semantic']));
    expect(result.items.find(item => item.fact.id === 'lexical')?.fusionScore).toBeGreaterThan(0);
    expect(result.items.find(item => item.fact.id === 'semantic')?.vectorRank).toBe(1);
  });

  it('最早期多子主题查询在词法、向量和混合模式都保留每个物资分面', async () => {
    const supplies = [
      fact('water', '最初清点了3箱纯净水和60瓶气泡水。', {
        status: 'superseded', updatedAt: NOW - 4_000,
      }),
      fact('food', '最初储备包含高热量罐头、脱水蔬菜和长期口粮。', { updatedAt: NOW - 3_000 }),
      fact('melee', '最初近战装备包含5把战术折叠刀。', { updatedAt: NOW - 2_000 }),
      fact('power', '备用供能包含2个便携式高能电源、太阳能薄膜和备用电池。', { updatedAt: NOW - 1_000 }),
    ];
    const noise = Array.from({ length: 11 }, (_, index) => fact(
      `noise-${index}`,
      `后来补充的饮用水记录 ${index}，没有其他物资分面。`,
      { updatedAt: NOW + index },
    ));
    const currentWater = fact('water-current', '当前饮用水、水源、纯净水和气泡水都已经大量补充。', {
      updatedAt: NOW + 100,
    });
    const scores = [currentWater, ...noise, ...supplies].map((item, index): [string, number] => [item.id, 0.99 - index / 100]);
    const query = '最初避难时准备了哪些饮水、食物、近战装备和备用供能？';

    for (const mode of ['lexical', 'vector', 'hybrid'] as const) {
      const result = await service([...supplies, currentWater, ...noise], scores)
        .recall({ chatKey: 'chat-a', query, maxItems: 4, now: NOW }, mode, 'off');
      expect(new Set(result.items.map(item => item.fact.id)), mode).toEqual(new Set(['water', 'food', 'melee', 'power']));
    }
  });

  it('合并诊断问题会在条目预算内保留物资、泳池危险核心、雷达幼体和枪械状态分面', async () => {
    const essentials = [
      fact('water', '最初清点了3箱纯净水和60瓶气泡水。'),
      fact('food', '最初储备包含高热量罐头和长期口粮。'),
      fact('melee', '最初近战装备包含5把战术折叠刀。'),
      fact('power', '备用供能包含太阳能薄膜、备用电池和燃料电池。'),
      fact('pool-final', '泳池中的沈夜二段孵化后被彻底炸至碎裂死亡。'),
      fact('pool-core', '沈夜残骸遗留紫黑色危险核心黯欲之种，具有精神污染。'),
      fact('green-origin', '绿色人类幼体由紫罗分化而来，紫罗本体随后枯萎。'),
      fact('radar', '绿色小女孩可作为雷达扫描整栋楼的三维热源。'),
      fact('gun', '紫能高压手枪从核心碎裂到重新压入核心，剩余次数由10变9并最终确认10发。'),
    ];
    const noise = Array.from({ length: 20 }, (_, index) => fact(
      `noise-${index}`,
      `后来发生的普通行动记录 ${index}，没有诊断问题所需的关键细节。`,
      { updatedAt: NOW + index },
    ));
    const earlyDistractors = [
      fact('pool-early', '最早发现泳池有沈夜活动，但尚未交战。', { updatedAt: NOW - 20_000 }),
      fact('green-early', '最早只确认紫罗根系正在进化。', { updatedAt: NOW - 19_000 }),
    ];
    const allFacts = [...essentials, ...earlyDistractors, ...noise];
    const scores = [...earlyDistractors, ...noise, ...essentials]
      .map((item, index): [string, number] => [item.id, 0.99 - index / 1000]);
    const query = '[Memory SQLite E2E-20260714-FINAL] 饮水、食物、近战装备、备用供能；泳池敌人与危险核心；绿色小女孩来源及整栋楼雷达；紫能高压手枪最新次数和历史变化；银翼号在哪里？';

    for (const mode of ['lexical', 'vector', 'hybrid'] as const) {
      const result = await service(allFacts, scores)
        .recall({ chatKey: 'chat-a', query, maxItems: 12, now: NOW }, mode, 'off');
      expect(new Set(result.items.map(item => item.fact.id)), mode)
        .toEqual(expect.objectContaining(new Set(essentials.map(item => item.id))));
    }
  });

  it('明确不存在的银翼号不会被高语义相似度绕过实体硬过滤', async () => {
    const unrelated = fact('other-ship', '白夕小时曾经检查过一艘用于远航的飞船。');
    const result = await service([unrelated], [['other-ship', 0.99]])
      .recall({ chatKey: 'chat-a', query: '白夕小时是否拥有名为银翼号的飞船？', now: NOW }, 'vector', 'off');

    expect(result.items).toEqual([]);
    expect(result.candidates).toContainEqual(expect.objectContaining({ factId: 'other-ship', selected: false, omittedReason: '未命中查询中明确命名的实体' }));
  });

  it('带实体类型描述的未知号名仍会触发实体硬过滤', async () => {
    const similar = fact('semantic-spaceship', '白夕小时目前位于东京港区，并持有多种高科技装备。', {
      entityKeys: ['白夕小时', '东京港区'],
    });
    const result = await service([similar], [[similar.id, 0.99]])
      .recall({ chatKey: 'chat-a', query: '银翼号宇宙飞船目前停在哪里？', now: NOW }, 'vector', 'off');

    expect(result.items).toHaveLength(0);
    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ factId: similar.id, selected: false, omittedReason: '未命中查询中明确命名的实体' }),
    ]));
  });

  it('always 模式采用合法 rerank 结果并记录真实路由与 N/A usage', async () => {
    const rerank = vi.fn(async (input: { docs: string[] }) => {
      const preferred = input.docs.findIndex(doc => doc.includes('长期口粮'));
      const other = preferred === 0 ? 1 : 0;
      return {
        ok: true as const,
        results: [{ index: preferred, score: 0.97 }, { index: other, score: 0.31 }],
        meta: { requestId: 'rr-1', resourceId: 'Rerank', model: 'BAAI/bge-reranker-v2-m3', latencyMs: 45 },
      };
    });
    const result = await service(
      [fact('first', '物资记录包含饮用水。'), fact('second', '长期口粮是最早期储备的重点。')],
      [['first', 0.9], ['second', 0.88]],
      rerank,
    ).recall({ chatKey: 'chat-a', query: '早期储备', now: NOW }, 'hybrid', 'always');

    expect(rerank).toHaveBeenCalledTimes(1);
    expect(result.items[0]?.fact.id).toBe('second');
    expect(result.diagnostics.rerank).toMatchObject({ requested: true, success: true, resourceId: 'Rerank', usage: null });
  });

  it('只重排融合头部四条并保留未重排尾部', async () => {
    const rerank = vi.fn(async (input: { docs: string[] }) => ({
      ok: true as const,
      results: input.docs.map((_, index) => ({ index, score: 1 - index / 10 })),
      meta: { resourceId: 'Rerank', model: 'Qwen3-Reranker-4B', latencyMs: 40 },
    }));
    const facts = Array.from({ length: 8 }, (_, index) => fact(`fact-${index}`, `泳池战斗相关记忆 ${index}。`));
    const scores = facts.map((item, index): [string, number] => [item.id, 0.9 - index / 100]);
    const result = await service(facts, scores, rerank)
      .recall({ chatKey: 'chat-a', query: '泳池战斗', maxItems: 8, now: NOW }, 'hybrid', 'always');

    expect(rerank).toHaveBeenCalledWith(expect.objectContaining({ docs: expect.any(Array), topK: 4 }));
    expect(rerank.mock.calls[0]?.[0].docs).toHaveLength(4);
    expect(result.items).toHaveLength(8);
  });

  it('rerank 不会把显式最新状态排到旧事实之后', async () => {
    const rerank = vi.fn(async (input: { docs: string[] }) => ({
      ok: true as const,
      results: input.docs.map((_, index) => ({ index, score: 1 - index / 10 })),
      meta: { resourceId: 'Rerank', model: 'Qwen3-Reranker-4B', latencyMs: 40 },
    }));
    const current = fact('current-state', '最新变量状态确认：紫能高压手枪剩余击发次数为10。', {
      kind: 'state', subjectKey: '紫能高压手枪', predicateKey: '当前状态', entityKeys: ['紫能高压手枪'],
      sourceRefs: ['state:last:hash'], evidenceRefs: [], updatedAt: NOW + 10,
    });
    const old = fact('old-state', '紫能高压手枪当前剩余弹药为1发。', {
      kind: 'state', subjectKey: '紫能高压手枪', predicateKey: '剩余弹药', entityKeys: ['紫能高压手枪'],
      updatedAt: NOW,
    });
    const noise = Array.from({ length: 5 }, (_, index) => fact(`noise-${index}`, `紫色装备记录 ${index}。`));
    const result = await service(
      [current, old, ...noise],
      [['old-state', 0.95], ...noise.map((item, index): [string, number] => [item.id, 0.9 - index / 100])],
      rerank,
    ).recall({ chatKey: 'chat-a', query: '最后确认时紫色手枪还剩几次？', now: NOW + 20 }, 'hybrid', 'always');

    expect(result.items[0]?.fact.id).toBe('current-state');
    expect(rerank.mock.calls[0]?.[0].docs).not.toContain(current.content);
  });

  it('rerank 非法索引和 NaN 不会破坏原融合顺序', async () => {
    const rerank = vi.fn(async () => ({
      ok: true as const,
      results: [{ index: 99, score: 1 }, { index: 0, score: Number.NaN }],
      meta: { resourceId: 'Rerank', model: 'test' },
    }));
    const result = await service(
      [fact('first', '泳池战斗记录。'), fact('second', '危险核心记录。')],
      [['first', 0.9], ['second', 0.8]],
      rerank,
    ).recall({ chatKey: 'chat-a', query: '战斗记录', now: NOW }, 'hybrid', 'always');

    expect(result.items[0]?.fact.id).toBe('first');
    expect(result.diagnostics.rerank).toMatchObject({ requested: true, success: true });
  });

  it('rerank 路由缺少 API Key 时不调用 provider 并保留原排序', async () => {
    const rerank = vi.fn(async () => ({
      ok: true as const,
      results: [{ index: 1, score: 0.99 }],
    }));
    const llm: MemoryLlmApi = {
      rerank,
      inspect: {
        previewRoute: vi.fn(async () => ({
          resourceId: 'Rerank',
          model: 'Qwen3-Reranker-4B',
          blockedReason: '资源 gitee_Rerank 未配置 API Key',
        })),
      },
    } as unknown as MemoryLlmApi;
    const vectors = { search: vi.fn(async () => vectorResult([['first', 0.9], ['second', 0.8]])) };
    const result = await new SemanticRecallService(
      new MemoryRecallIndex([fact('first', '泳池战斗记录。'), fact('second', '危险核心记录。')]),
      vectors as never,
      () => llm,
    ).recall({ chatKey: 'chat-a', query: '战斗记录', now: NOW }, 'hybrid', 'always');

    expect(rerank).not.toHaveBeenCalled();
    expect(result.items[0]?.fact.id).toBe('first');
    expect(result.diagnostics.rerank).toMatchObject({
      requested: true,
      success: false,
      resourceId: 'Rerank',
      error: '资源 gitee_Rerank 未配置 API Key',
    });
  });

  it('embedding 路由失败时自动退回关键词且不阻塞召回', async () => {
    const index = new MemoryRecallIndex([fact('lexical', '紫电枪当前剩余十次击发。', { entityKeys: ['紫电枪'] })]);
    const vectors = { search: vi.fn(async () => { throw new Error('embedding route failed'); }) };
    const result = await new SemanticRecallService(index, vectors as never, () => null)
      .recall({ chatKey: 'chat-a', query: '紫电枪剩余几次？', now: NOW }, 'auto', 'adaptive');

    expect(result.items[0]?.fact.id).toBe('lexical');
    expect(result.diagnostics).toMatchObject({ resolvedMode: 'lexical', degradedReason: 'embedding route failed' });
  });
});
