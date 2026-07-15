import { describe, expect, it } from 'vitest';
import { MemoryRecallIndex, type RecallFact } from '../src/application/recall';

const KINDS = ['identity', 'relationship', 'location', 'world_rule', 'state', 'goal', 'commitment'] as const;

interface GoldenCase {
  query: string;
  entityKey: string;
  expectedId: string;
  critical: boolean;
}

const facts: RecallFact[] = Array.from({ length: 56 }, (_, index) => {
  const entityKey = `golden_entity_${String(index).padStart(2, '0')}`;
  const kind = KINDS[index % KINDS.length]!;
  return {
    id: `golden-fact-${index}`,
    chatKey: 'golden-chat',
    kind,
    subjectKey: entityKey,
    predicateKey: `predicate_${index}`,
    objectKey: `object_${index}`,
    content: `${entityKey} 对应的${kind}事实已经由第 ${index} 号原始证据明确确认，应在相关查询时完整召回。`,
    entityKeys: [entityKey],
    confidence: 0.95,
    status: 'active',
    evidenceRefs: [`golden-evidence-${index}`],
    updatedAt: Date.now() - index,
  };
});

const cases: GoldenCase[] = facts.map((fact, index) => ({
  query: `请根据已有证据回忆 ${fact.subjectKey} 已确认的${fact.kind}信息；如果没有依据就不要猜测。`,
  entityKey: fact.subjectKey,
  expectedId: fact.id,
  critical: ['identity', 'world_rule', 'goal', 'commitment'].includes(fact.kind) || index < 8,
}));

describe('50+ 黄金召回数据集', () => {
  it('Recall@12 >= 95%、Precision@12 >= 85%，关键事实零遗漏', () => {
    const recall = new MemoryRecallIndex(facts);
    let hits = 0;
    let selected = 0;
    let relevantSelected = 0;
    const omittedCritical: string[] = [];

    for (const item of cases) {
      const result = recall.recall({
        chatKey: 'golden-chat',
        query: item.query,
        maxItems: 12,
      });
      const selectedIds = result.items.map((resultItem) => resultItem.fact.id);
      const matched = selectedIds.includes(item.expectedId);
      if (matched) hits += 1;
      if (!matched && item.critical) omittedCritical.push(item.expectedId);
      selected += selectedIds.length;
      relevantSelected += selectedIds.filter((id) => id === item.expectedId).length;
    }

    const recallAt12 = hits / cases.length;
    const precisionAt12 = relevantSelected / Math.max(1, selected);
    expect(cases.length).toBeGreaterThanOrEqual(50);
    expect(recallAt12).toBeGreaterThanOrEqual(0.95);
    expect(precisionAt12).toBeGreaterThanOrEqual(0.85);
    expect(omittedCritical).toEqual([]);
  });
});
