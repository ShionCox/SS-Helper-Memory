import { describe, expect, it } from 'vitest';
import type { InventoryItem, InventoryState } from '../src/domain';
import { selectInventoryWorkbenchModel, type InventoryWorkbenchSort } from '../src/ui/inventory-workbench-model';

function item(id: string, canonicalName: string, overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id,
    workspaceId: 'workspace',
    canonicalName,
    aliases: [],
    category: 'other',
    status: 'confirmed',
    confidence: .5,
    sourceRefs: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function inventoryState(id: string, itemId: string, overrides: Partial<InventoryState> = {}): InventoryState {
  return {
    id,
    workspaceId: 'workspace',
    chatKey: 'chat',
    itemId,
    measureKind: 'quantity',
    unit: '个',
    unitKey: '个',
    precision: 'exact',
    availability: 'active',
    lastEventId: `event:${id}`,
    sourceRefs: [],
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const build = (
  items: readonly InventoryItem[],
  states: readonly InventoryState[],
  overrides: Partial<Parameters<typeof selectInventoryWorkbenchModel>[0]> = {},
) => selectInventoryWorkbenchModel({
  items,
  states,
  scope: 'current',
  category: '',
  query: '',
  sort: 'recent',
  selectedId: '',
  ...overrides,
});

describe('物品工作台纯读模型', () => {
  it('统计不受搜索和分类影响，已移除不计入持有且目录排除已作废项', () => {
    const items = [
      item('exact', '净水', { category: 'food' }),
      item('approx', '绷带', { category: 'medicine' }),
      item('unknown', '神秘钥匙', { category: 'special' }),
      item('removed', '旧护甲', { category: 'armor' }),
      item('catalog', '目录材料', { category: 'material' }),
      item('invalid', '错误物品', { category: 'weapon', status: 'invalid' }),
    ];
    const states = [
      inventoryState('exact-q', 'exact', { amount: 8, updatedAt: 8 }),
      inventoryState('exact-days', 'exact', { measureKind: 'coverage_days', amount: 12, unit: '天', unitKey: '天', updatedAt: 9 }),
      inventoryState('approx-q', 'approx', { amount: 3, precision: 'approximate', updatedAt: 7 }),
      inventoryState('unknown-q', 'unknown', { precision: 'unknown', availability: 'unknown', unit: '', unitKey: 'unitless', updatedAt: 6 }),
      inventoryState('removed-q', 'removed', { amount: 99, availability: 'absent', updatedAt: 10 }),
      inventoryState('invalid-q', 'invalid', { amount: 1, updatedAt: 11 }),
    ];

    const model = build(items, states, { category: 'food', query: '净水' });
    expect(model.heldItems.map(entry => entry.id)).toEqual(['exact', 'approx', 'unknown']);
    expect(model.precisionCounts).toEqual({ exact: 1, approximate: 1, unknown: 1 });
    expect(model.maxCoverageDays).toBe(12);
    expect(model.scopeItems.map(entry => entry.id)).toEqual(['exact', 'approx', 'unknown', 'removed']);
    expect(model.categoryCounts).toMatchObject({ food: 1, medicine: 1, special: 1, armor: 1, material: 0, weapon: 0 });
    expect(model.filteredItems.map(entry => entry.id)).toEqual(['exact']);

    const catalog = build(items, states, { scope: 'catalog' });
    expect(catalog.scopeItems.map(entry => entry.id)).toEqual(['exact', 'approx', 'unknown', 'removed', 'catalog']);
    expect(catalog.scopeItems.some(entry => entry.status === 'invalid')).toBe(false);
  });

  it('覆盖四种排序、别名搜索、缺失值末置和筛选后的选择保持', () => {
    const items = [
      item('a', '阿尔法', { aliases: ['饮用水'], confidence: .4, updatedAt: 2 }),
      item('b', '贝塔', { confidence: .9, updatedAt: 3 }),
      item('c', '伽马', { confidence: .6, updatedAt: 4 }),
      item('d', '德尔塔', { confidence: .2, updatedAt: 5 }),
    ];
    const states = [
      inventoryState('a-q', 'a', { amount: 2, updatedAt: 20 }),
      inventoryState('b-q', 'b', { amount: 8, precision: 'approximate', updatedAt: 10 }),
      inventoryState('c-q', 'c', { precision: 'unknown', unit: '', unitKey: 'unitless', updatedAt: 30 }),
      inventoryState('d-q', 'd', { amount: 100, availability: 'absent', updatedAt: 40 }),
    ];
    const idsFor = (sort: InventoryWorkbenchSort) => build(items, states, { sort }).filteredItems.map(entry => entry.id);

    expect(idsFor('recent')).toEqual(['d', 'c', 'a', 'b']);
    expect(idsFor('name')).toEqual([...items].sort((left, right) => left.canonicalName.localeCompare(right.canonicalName, 'zh-CN')).map(entry => entry.id));
    expect(idsFor('amount')).toEqual(['b', 'a', 'd', 'c']);
    expect(idsFor('confidence')).toEqual(['b', 'c', 'a', 'd']);
    expect(build(items, states, { query: '饮用水' }).filteredItems.map(entry => entry.id)).toEqual(['a']);
    expect(build(items, states, { selectedId: 'a' }).selectedId).toBe('a');
    expect(build(items, states, { selectedId: 'a', query: '贝塔' }).selectedId).toBe('b');
    expect(build(items, states, { query: '没有结果' }).selectedId).toBe('');
  });

  it('没有可维持天数时保留缺失语义', () => {
    const model = build([item('a', '物品')], [inventoryState('a-q', 'a', { amount: 1 })]);
    expect(model.maxCoverageDays).toBeUndefined();
  });
});
