import { describe, expect, it } from 'vitest';
import {
  buildSummaryBatchPlans,
  buildSummaryBatches,
  getSummaryWaitingFloors,
  selectAutomaticSummaryWindow,
  visibleConversationMessages,
} from '../src/application/ingest/summary-strategy';
import type { SourceBlock } from '../src/application/ingest/types';

function message(floor: number, role: 'user' | 'assistant' = floor % 2 ? 'user' : 'assistant', content = `第 ${floor} 层`): SourceBlock {
  return { id: `message:${floor}`, chatKey: 'chat-a', kind: 'message', role, content, createdAt: floor, floor };
}

describe('Memory 总结策略', () => {
  it('只计算可见用户和助手楼层', () => {
    const sources: SourceBlock[] = [
      message(1),
      { ...message(2), hidden: true },
      { ...message(3), role: 'system' },
      { ...message(4), role: 'tool' },
      message(5),
    ];
    expect(visibleConversationMessages(sources).map((source) => source.floor)).toEqual([1, 5]);
  });

  it('显式开启时将 system 历史正文按原始 floor 纳入批次，但不纳入 tool/reasoning', () => {
    const sources: SourceBlock[] = [
      message(1),
      { ...message(2), role: 'system', messageType: 'system', hidden: false },
      { ...message(3), role: 'tool', messageType: 'tool', hidden: true },
      { ...message(4), role: 'system', messageType: 'reasoning', hidden: true },
      message(5),
    ];
    expect(visibleConversationMessages(sources, { includeSystemMessages: true }).map((source) => source.floor)).toEqual([1, 2, 5]);
    expect(buildSummaryBatches(sources, { batchMode: 'floors', batchFloors: 10 }, { includeSystemMessages: true })[0]?.map((source) => source.floor)).toEqual([1, 2, 5]);
  });

  it('60 -> 66 selects 58–65 and moves the target only to 65', () => {
    const messages = Array.from({ length: 66 }, (_, index) => message(index + 1));
    const window = selectAutomaticSummaryWindow(messages, {
      completedFloor: 60,
      completedMessageId: 'message:60',
      updatedAt: 1,
    }, { triggerIntervalFloors: 5, overlapFloors: 2 });
    expect(window).toMatchObject({ startFloor: 58, endFloor: 65, endMessageId: 'message:65' });
    expect(window?.sources.map((source) => source.floor)).toEqual([58, 59, 60, 61, 62, 63, 64, 65]);
    expect(window?.writableSourceRefs).toEqual(['message:61', 'message:62', 'message:63', 'message:64', 'message:65']);
    expect(getSummaryWaitingFloors(messages, { completedFloor: 60, completedMessageId: 'message:60', updatedAt: 1 }, { triggerIntervalFloors: 5 })).toBe(0);
  });

  it('does not create an automatic summary window before a chat has been initialized', () => {
    expect(selectAutomaticSummaryWindow(Array.from({ length: 100 }, (_, index) => message(index + 1)), undefined, {})).toBeUndefined();
  });

  it('uses the same strategy for floor and character batches while retaining preceding context', () => {
    const messages = Array.from({ length: 8 }, (_, index) => message(index + 1, index % 2 ? 'assistant' : 'user', '字'.repeat(1_000)));
    const floorBatches = buildSummaryBatches(messages, { batchMode: 'floors', batchFloors: 3, overlapFloors: 2 });
    expect(floorBatches.map((batch) => batch.map((source) => source.floor))).toEqual([
      [1, 2, 3], [2, 3, 4, 5, 6], [5, 6, 7, 8],
    ]);
    const charBatches = buildSummaryBatches(messages, { batchMode: 'chars', batchChars: 2_000, overlapFloors: 1 });
    expect(charBatches).toHaveLength(4);
    expect(charBatches[1]?.map((source) => source.floor)).toEqual([2, 3, 4]);
  });

  it('marks overlap as read-only while keeping current sources writable', () => {
    const messages = Array.from({ length: 8 }, (_, index) => message(index + 1));
    const plans = buildSummaryBatchPlans(messages, { batchMode: 'floors', batchFloors: 3, overlapFloors: 2 });

    expect(plans.map((plan) => plan.sources.map((source) => source.id))).toEqual([
      ['message:1', 'message:2', 'message:3'],
      ['message:2', 'message:3', 'message:4', 'message:5', 'message:6'],
      ['message:5', 'message:6', 'message:7', 'message:8'],
    ]);
    expect(plans.map((plan) => plan.writableSourceRefs)).toEqual([
      ['message:1', 'message:2', 'message:3'],
      ['message:4', 'message:5', 'message:6'],
      ['message:7', 'message:8'],
    ]);
    expect(plans.map((plan) => plan.messageCount)).toEqual([3, 3, 2]);
  });

  it('applies an automatic-window write whitelist after splitting long messages', () => {
    const sources = [
      message(1, 'user', '旧'.repeat(2_500)),
      message(2, 'assistant', '新'.repeat(2_500)),
    ];
    const plans = buildSummaryBatchPlans(
      sources,
      { batchMode: 'floors', batchFloors: 2, batchChars: 2_000 },
      { writableSourceRefs: ['message:2'] },
    );

    expect(plans[0]?.sources.map((source) => source.id)).toEqual([
      'message:1:summary-part:1',
      'message:1:summary-part:2',
      'message:2:summary-part:1',
      'message:2:summary-part:2',
    ]);
    expect(plans[0]?.writableSourceRefs).toEqual([
      'message:2:summary-part:1',
      'message:2:summary-part:2',
    ]);
    expect(plans[0]?.messageCount).toBe(1);
  });

  it('folds leading read-only floors into the first writable automatic batch', () => {
    const sources = Array.from({ length: 5 }, (_, index) => message(index + 1));
    const plans = buildSummaryBatchPlans(
      sources,
      { batchMode: 'floors', batchFloors: 2, overlapFloors: 1 },
      { writableSourceRefs: ['message:4', 'message:5'] },
    );

    expect(plans).toHaveLength(2);
    expect(plans[0]?.sources.map((source) => source.id)).toEqual([
      'message:1', 'message:2', 'message:3', 'message:4',
    ]);
    expect(plans[0]?.writableSourceRefs).toEqual(['message:4']);
    expect(plans[1]?.sources.map((source) => source.id)).toEqual(['message:4', 'message:5']);
    expect(plans[1]?.writableSourceRefs).toEqual(['message:5']);
  });

  it('keeps a split long message in its original chat floor', () => {
    const sources = [
      message(1),
      { ...message(2, 'assistant', '长'.repeat(5_000)), id: 'message:2:part:1', content: '长'.repeat(2_500) },
      { ...message(2, 'assistant', '长'.repeat(5_000)), id: 'message:2:part:2', content: '长'.repeat(2_500) },
      message(3),
      message(4),
    ];
    const window = selectAutomaticSummaryWindow(sources, {
      completedFloor: 1,
      completedMessageId: 'message:1',
      updatedAt: 1,
    }, { triggerIntervalFloors: 2, overlapFloors: 0 });
    expect(window?.endFloor).toBe(3);
    expect(window?.endMessageId).toBe('message:3');
    expect(window?.sources.filter((source) => source.floor === 2)).toHaveLength(2);
  });
});
