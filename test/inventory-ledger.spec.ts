import { describe, expect, it } from 'vitest';
import { buildMatchedInventoryPrompt, parseInventorySnapshots, selectKnownInventoryContext } from '../src/application/inventory';
import type { InventoryItem, InventoryState } from '../src/domain';
import type { SourceBlock } from '../src/application/ingest/types';

function source(id: string, floor: number, content: string): SourceBlock {
  return { id, chatKey: 'chat', kind: 'state', role: 'metadata', semanticSection: 'state_snapshot', floor, createdAt: floor * 1_000, content };
}

describe('deterministic inventory snapshot parser', () => {
  it('parses exact, approximate, unknown, nested and removed snapshot values', () => {
    const row = source('message:4', 4, [
      '【当前物资快照】',
      '食物: 高热量压缩口粮（约29天份）、瓶装水x22、真空包装食品若干（肉类x15包、蔬菜x10包）、新鲜生菜x2kg',
      '特殊道具: 隔离箱（已丢弃）、蘑菇孢子包x2（已接种）、豆类种子x120粒（已播种）、普通生菜x120株、紫色营养液x400ml（剩余）',
      '【角色状态】',
      '白夕小时：健康',
    ].join('\n'));
    const proposals = parseInventorySnapshots([row], new Set([row.id]));
    const byName = new Map(proposals.map(item => [item.itemName, item.command]));

    expect(byName.get('高热量压缩口粮')).toMatchObject({ measureKind: 'coverage_days', amount: 29, unit: '天份', precision: 'approximate', operation: 'set' });
    expect(byName.get('瓶装水')).toMatchObject({ measureKind: 'quantity', amount: 22, unit: '个', precision: 'exact', operation: 'set' });
    expect(byName.get('真空包装食品')).toMatchObject({ precision: 'unknown', operation: 'set' });
    expect(byName.get('肉类')).toMatchObject({ amount: 15, unit: '包' });
    expect(byName.get('蔬菜')).toMatchObject({ amount: 10, unit: '包' });
    expect(byName.get('新鲜生菜')).toMatchObject({ amount: 2, unit: 'kg' });
    expect(byName.get('隔离箱')).toMatchObject({ operation: 'remove' });
    expect(byName.get('蘑菇孢子包')).toMatchObject({ amount: 2, unit: '个' });
    expect(byName.get('豆类种子')).toMatchObject({ amount: 120, unit: '粒' });
    expect(byName.get('普通生菜')).toMatchObject({ amount: 120, unit: '株' });
    expect(byName.get('紫色营养液')).toMatchObject({ amount: 400, unit: 'ml' });
  });

  it('ignores ordinary narrative dates and harvest forecasts outside the explicit snapshot section', () => {
    const narrative = source('message:10', 10, '灾变第十八日。生菜25到30天可以收获，也许能缩短到20天。');
    expect(parseInventorySnapshots([narrative], new Set([narrative.id]))).toEqual([]);
  });

  it('supplies only exact-name matched current inventory and caps context at fifty items', () => {
    const items: InventoryItem[] = Array.from({ length: 55 }, (_, index) => ({
      id: `item:${index}`, workspaceId: 'w', canonicalName: `物品${index}`, aliases: index === 54 ? ['瓶装水'] : [], category: 'other', status: 'confirmed', confidence: 1, sourceRefs: [], createdAt: 1, updatedAt: 1,
    }));
    const states: InventoryState[] = [{
      id: 'state:54', workspaceId: 'w', chatKey: 'chat', itemId: 'item:54', measureKind: 'quantity', amount: 22, unit: '瓶', unitKey: '瓶', precision: 'exact', availability: 'active', lastEventId: 'event:1', sourceRefs: ['message:4'], revision: 1, createdAt: 1, updatedAt: 1,
    }];
    const context = selectKnownInventoryContext([source('message:6', 6, '小时拿起瓶装水。')], items, states);
    expect(context).toHaveLength(1);
    expect(context[0]).toMatchObject({ itemId: 'item:54', canonicalName: '物品54', states: [{ amount: 22 }] });
  });

  it('injects current inventory only when the user message exactly mentions a name or alias', () => {
    const item: InventoryItem = { id: 'water', workspaceId: 'w', canonicalName: '瓶装水', aliases: ['饮用水'], category: 'food', status: 'confirmed', confidence: 1, sourceRefs: [], createdAt: 1, updatedAt: 1 };
    const state: InventoryState = { id: 'water-state', workspaceId: 'w', chatKey: 'chat', itemId: item.id, measureKind: 'quantity', amount: 20, unit: '瓶', unitKey: '瓶', precision: 'exact', availability: 'active', lastEventId: 'water-event', sourceRefs: [], revision: 1, createdAt: 1, updatedAt: 1 };
    expect(buildMatchedInventoryPrompt('我们还有多少饮用水？', [item], [state], 2_000)).toContain('20瓶');
    expect(buildMatchedInventoryPrompt('我们还有多少资源？', [item], [state], 2_000)).toBe('');
  });
});
