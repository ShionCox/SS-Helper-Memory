import { describe, expect, it } from 'vitest';
import {
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

  it('60 -> 66 selects 58–65 and moves the target only to 65', () => {
    const messages = Array.from({ length: 66 }, (_, index) => message(index + 1));
    const window = selectAutomaticSummaryWindow(messages, {
      completedFloor: 60,
      completedMessageId: 'message:60',
      updatedAt: 1,
    }, { triggerIntervalFloors: 5, overlapFloors: 2 });
    expect(window).toMatchObject({ startFloor: 58, endFloor: 65, endMessageId: 'message:65' });
    expect(window?.sources.map((source) => source.floor)).toEqual([58, 59, 60, 61, 62, 63, 64, 65]);
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
