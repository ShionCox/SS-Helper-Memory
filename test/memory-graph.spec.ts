import { describe, expect, it, vi } from 'vitest';
import {
  deriveMemoryGraphProjection,
  graphEdgeId,
  graphNodeId,
  normalizeGraphEntityKey,
  type MemoryFact,
} from '../src/domain';
import { MemoryGraphRecallIndex, MemoryGraphService } from '../src/application/graph';

function fact(
  id: string,
  chatKey: string,
  subjectKey: string,
  predicateKey: string,
  objectKey: string,
  overrides: Partial<MemoryFact> = {},
): MemoryFact {
  return {
    id,
    chatKey,
    kind: 'relationship',
    subjectKey,
    predicateKey,
    objectKey,
    canonicalKey: `${subjectKey}|${predicateKey}|${objectKey}`,
    slotKey: `${subjectKey}|${predicateKey}`,
    content: `${subjectKey} 已明确表示与 ${objectKey} 存在 ${predicateKey} 关系，该关系有当前聊天来源证据支持。`,
    entityKeys: [subjectKey, objectKey],
    confidence: 0.9,
    status: 'active',
    sourceRefs: [`message:${id}`],
    evidenceIds: [`evidence:${id}`],
    freshestEvidenceAt: 10,
    origin: 'automatic',
    revision: 1,
    createdAt: 1,
    updatedAt: 10,
    ...overrides,
  };
}

describe('事实关系图谱', () => {
  it('用字面 NFKC/空白归一化生成确定性节点和 backing fact 边，不做语义别名合并', () => {
    const relation = fact('f-1', 'chat-a', ' Ａ　莉  ', '认识', '  贝　塔 ');
    const similarName = fact('f-2', 'chat-a', '艾琳', '认识', '艾琳娜');
    const projection = deriveMemoryGraphProjection([relation, similarName]);

    expect(normalizeGraphEntityKey(' Ａ　莉  ')).toBe('A 莉');
    expect(projection.nodes.map((node) => node.id)).toContain(graphNodeId('chat-a', 'A 莉'));
    expect(projection.nodes.map((node) => node.label)).toEqual(expect.arrayContaining(['A 莉', '贝 塔', '艾琳', '艾琳娜']));
    expect(new Set(projection.nodes.filter((node) => ['艾琳', '艾琳娜'].includes(node.label)).map((node) => node.id)).size).toBe(2);
    expect(projection.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: graphEdgeId('f-1'), backingFactId: 'f-1', predicateKey: '认识', status: 'active' }),
    ]));
  });

  it('只为有效、有证据、高置信度的允许事实类型建边，并让聊天键绝对隔离', () => {
    const valid = fact('active', 'chat-a', '艾琳', '前往', '灯塔', { kind: 'event' });
    const noEvidence = fact('no-evidence', 'chat-a', '艾琳', '认识', '贝塔', { sourceRefs: [], evidenceIds: [] });
    const pending = fact('pending', 'chat-a', '艾琳', '认识', '贝塔', { status: 'pending' });
    const lowConfidence = fact('low-confidence', 'chat-a', '艾琳', '认识', '贝塔', { confidence: 0.74 });
    const identity = fact('identity', 'chat-a', '艾琳', '身份', '巡林者', { kind: 'identity' });
    const crossChat = fact('cross-chat', 'chat-b', '艾琳', '认识', '贝塔');
    const projection = deriveMemoryGraphProjection([valid, noEvidence, pending, lowConfidence, identity, crossChat]);

    expect(projection.edges.map((edge) => edge.backingFactId)).toEqual(['active', 'cross-chat']);
    expect(projection.edges.find((edge) => edge.backingFactId === 'cross-chat')?.fromNodeId).toBe(graphNodeId('chat-b', '艾琳'));
    expect(graphNodeId('chat-a', '艾琳')).not.toBe(graphNodeId('chat-b', '艾琳'));
    expect(graphNodeId('chat-a', '艾琳')).not.toBe(graphNodeId(' chat-a ', '艾琳'));
  });

  it('按一到两跳提名 backing facts、去重循环并遵守边上限', async () => {
    const projection = deriveMemoryGraphProjection([
      fact('f-a-b', 'chat-a', '艾琳', '认识', '贝塔'),
      fact('f-b-c', 'chat-a', '贝塔', '前往', '灯塔', { kind: 'event' }),
      fact('f-c-a', 'chat-a', '灯塔', '守护', '艾琳', { kind: 'world_rule' }),
      fact('f-other', 'chat-b', '艾琳', '认识', '跨聊天对象'),
    ]);
    const graph = new MemoryGraphRecallIndex(projection);

    const oneHop = await graph.search({ chatKey: 'chat-a', query: '艾琳', seedEntityKeys: ['艾琳'], maxHops: 1, maxEdges: 12 });
    const twoHops = await graph.search({ chatKey: 'chat-a', query: '艾琳', seedEntityKeys: ['艾琳'], maxHops: 2, maxEdges: 12 });
    const limited = await graph.search({ chatKey: 'chat-a', query: '艾琳', seedEntityKeys: ['艾琳'], maxHops: 2, maxEdges: 4 });

    expect(oneHop.candidates.map((candidate) => candidate.factId)).toEqual(expect.arrayContaining(['f-a-b', 'f-c-a']));
    expect(twoHops.candidates.map((candidate) => candidate.factId)).toEqual(expect.arrayContaining(['f-a-b', 'f-b-c', 'f-c-a']));
    expect(new Set(twoHops.candidates.map((candidate) => candidate.factId)).size).toBe(twoHops.candidates.length);
    expect(twoHops.candidates.map((candidate) => candidate.factId)).not.toContain('f-other');
    expect(limited.edgeHitCount).toBeLessThanOrEqual(4);
  });

  it('协调失败只暴露安全状态并允许调用方降级', async () => {
    const service = new MemoryGraphService({
      listFacts: async () => [],
      reconcileGraphProjection: async () => { throw new Error('raw workspace diagnostic'); },
    } as never);

    await expect(service.rebuild('chat-a')).rejects.toThrow('raw workspace diagnostic');
    expect(service.getStatus('chat-a')).toMatchObject({
      phase: 'degraded',
      lastError: '关系图谱协调暂时不可用。',
    });
  });

  it('状态观察者异常不会阻断后台协调', async () => {
    const reconcileGraphProjection = vi.fn(async () => undefined);
    const service = new MemoryGraphService({
      listFacts: async () => [],
      reconcileGraphProjection,
    } as never);
    service.onStatusChanged(() => { throw new Error('presentation subscriber failed'); });

    expect(() => service.schedule('chat-a')).not.toThrow();
    await vi.waitFor(() => expect(reconcileGraphProjection).toHaveBeenCalledOnce());
    expect(service.getStatus('chat-a')).toMatchObject({ phase: 'ready' });
  });
});
