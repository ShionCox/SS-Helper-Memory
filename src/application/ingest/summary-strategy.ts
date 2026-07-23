import type { SourceBlock } from './types';

export type SummaryBatchMode = 'floors' | 'chars';

export interface SummaryStrategy {
  batchMode: SummaryBatchMode;
  batchFloors: number;
  batchChars: number;
  triggerIntervalFloors: number;
  overlapFloors: number;
}

export interface SummaryProgress {
  completedFloor: number;
  completedMessageId: string;
  updatedAt: number;
  lastJobId?: string;
}

export interface AutomaticSummaryWindow {
  sources: SourceBlock[];
  /** 当前窗口中允许产生新记录的来源；其余来源仅作为重叠上下文。 */
  writableSourceRefs: string[];
  startFloor: number;
  endFloor: number;
  endMessageId: string;
  waitingFloors: number;
}

export interface SummaryInitializationEstimate {
  messageCount: number;
  batchCount: number;
  tokenLow: number;
  tokenHigh: number;
}

export interface SummaryBatchOptions {
  includeSystemMessages?: boolean;
  /** 可选的任务级写入白名单；未列入的来源仍可作为只读上下文。 */
  writableSourceRefs?: readonly string[];
}

export interface SummaryBatchPlan {
  sources: SourceBlock[];
  writableSourceRefs: string[];
  messageCount: number;
}

export const DEFAULT_SUMMARY_STRATEGY: Readonly<SummaryStrategy> = Object.freeze({
  batchMode: 'floors',
  batchFloors: 5,
  batchChars: 12_000,
  triggerIntervalFloors: 5,
  overlapFloors: 2,
});

function clamp(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback;
}

export function normalizeSummaryStrategy(value: Partial<SummaryStrategy>): SummaryStrategy {
  return {
    batchMode: value.batchMode === 'chars' ? 'chars' : 'floors',
    batchFloors: clamp(value.batchFloors ?? DEFAULT_SUMMARY_STRATEGY.batchFloors, 1, 20, DEFAULT_SUMMARY_STRATEGY.batchFloors),
    batchChars: clamp(value.batchChars ?? DEFAULT_SUMMARY_STRATEGY.batchChars, 2_000, 16_000, DEFAULT_SUMMARY_STRATEGY.batchChars),
    triggerIntervalFloors: clamp(value.triggerIntervalFloors ?? DEFAULT_SUMMARY_STRATEGY.triggerIntervalFloors, 1, 50, DEFAULT_SUMMARY_STRATEGY.triggerIntervalFloors),
    overlapFloors: clamp(value.overlapFloors ?? DEFAULT_SUMMARY_STRATEGY.overlapFloors, 0, 10, DEFAULT_SUMMARY_STRATEGY.overlapFloors),
  };
}

function floorOf(source: SourceBlock, fallback: number): number {
  return Number.isFinite(source.floor) ? Math.trunc(source.floor!) : fallback;
}

/** 只将模型实际可见的用户/助手文本计为聊天楼层。 */
export function visibleConversationMessages(blocks: readonly SourceBlock[], options: SummaryBatchOptions = {}): SourceBlock[] {
  return conversationFloorGroups(blocks, options).flat();
}

/** 单条超长消息拆分后仍共用同一个 floor；这里把它们重新视作一个聊天楼层。 */
export function conversationFloorGroups(blocks: readonly SourceBlock[], options: SummaryBatchOptions = {}): SourceBlock[][] {
  const includeSystemMessages = options.includeSystemMessages === true;
  const messages = blocks
    .filter((source) => source.kind === 'message' && !source.hidden && (
      ((source.role === 'user' || source.role === 'assistant') && source.messageType !== 'system' && source.messageType !== 'tool' && source.messageType !== 'reasoning')
      || (includeSystemMessages && (source.role === 'system' || source.messageType === 'system') && source.messageType !== 'tool' && source.messageType !== 'reasoning')
    ))
    .sort((left, right) => floorOf(left, Number.MAX_SAFE_INTEGER) - floorOf(right, Number.MAX_SAFE_INTEGER) || left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  const groups: SourceBlock[][] = [];
  for (const source of messages) {
    const last = groups.at(-1);
    const canJoin = last && Number.isFinite(source.floor) && Number.isFinite(last[0]?.floor) && source.floor === last[0]?.floor;
    if (canJoin) last.push(source);
    else groups.push([source]);
  }
  return groups;
}

function messageSourceId(source: SourceBlock): string {
  return source.id.replace(/:(?:summary-)?part:\d+$/u, '');
}

function groupFloor(group: readonly SourceBlock[], fallback: number): number {
  return floorOf(group[0]!, fallback);
}

function groupMessageId(group: readonly SourceBlock[]): string {
  return messageSourceId(group.at(-1)!);
}

function flattenedGroups(groups: readonly (readonly SourceBlock[])[]): SourceBlock[] {
  return groups.flatMap((group) => group);
}

function splitForCharLimit(source: SourceBlock, limit: number): SourceBlock[] {
  if (source.content.length <= limit) return [source];
  const parts: SourceBlock[] = [];
  for (let offset = 0, part = 1; offset < source.content.length; offset += limit, part += 1) {
    parts.push({ ...source, id: `${source.id}:summary-part:${part}`, content: source.content.slice(offset, offset + limit) });
  }
  return parts;
}

function appendUnique(target: SourceBlock[], blocks: readonly SourceBlock[]): void {
  const ids = new Set(target.map((source) => source.id));
  for (const block of blocks) if (!ids.has(block.id)) { target.push(block); ids.add(block.id); }
}

/**
 * 将初始化和自动窗口统一拆成稳定 LLM 批次。楼层模式按可见聊天楼层分组；
 * 字数模式只改变单次请求的拆分边界，仍保留指定数量的前置聊天上下文。
 */
export function buildSummaryBatches(blocks: readonly SourceBlock[], strategyInput: Partial<SummaryStrategy>, options: SummaryBatchOptions = {}): SourceBlock[][] {
  return buildSummaryBatchPlans(blocks, strategyInput, options).map((plan) => plan.sources);
}

/**
 * 在稳定批次之外同时标明本批写入边界。重叠楼层会继续进入 sources，
 * 但不会进入 writableSourceRefs，避免重复 Capture 抬高修订和审计计数。
 */
export function buildSummaryBatchPlans(blocks: readonly SourceBlock[], strategyInput: Partial<SummaryStrategy>, options: SummaryBatchOptions = {}): SummaryBatchPlan[] {
  const strategy = normalizeSummaryStrategy(strategyInput);
  const floorGroups = conversationFloorGroups(blocks, options);
  const messages = flattenedGroups(floorGroups);
  const messageIds = new Set(messages.map((source) => source.id));
  const taskWritableRefs = options.writableSourceRefs ? new Set(options.writableSourceRefs) : undefined;
  const isTaskWritable = (source: SourceBlock): boolean => !taskWritableRefs
    || taskWritableRefs.has(source.id)
    || (source.kind === 'message' && taskWritableRefs.has(messageSourceId(source)));
  // Message blocks that are not part of an eligible conversation floor
  // (system in safe mode, tool output, hidden reasoning, or empty-control
  // remnants) must never fall through as metadata into an LLM batch.
  const metadata = blocks.filter((source) => source.kind !== 'message' && !messageIds.has(source.id));
  if (messages.length === 0) {
    if (metadata.length === 0) return [];
    const plan = {
      sources: metadata,
      writableSourceRefs: metadata.filter(isTaskWritable).map((source) => source.id),
      messageCount: 0,
    };
    return taskWritableRefs && plan.writableSourceRefs.length === 0 ? [] : [plan];
  }

  const groups: Array<{ start: number; end: number; blocks: SourceBlock[] }> = [];
  if (strategy.batchMode === 'floors') {
    for (let index = 0; index < floorGroups.length; index += strategy.batchFloors) {
      groups.push({
        start: index,
        end: Math.min(floorGroups.length, index + strategy.batchFloors),
        blocks: flattenedGroups(floorGroups.slice(index, index + strategy.batchFloors)).flatMap((message) => splitForCharLimit(message, strategy.batchChars)),
      });
    }
  } else {
    let current: SourceBlock[] = [];
    let currentChars = 0;
    let start = 0;
    for (const [index, floorGroup] of floorGroups.entries()) {
      const parts = flattenedGroups([floorGroup]).flatMap((message) => splitForCharLimit(message, strategy.batchChars));
      const length = parts.reduce((total, part) => total + part.content.length, 0);
      if (current.length > 0 && currentChars + length > strategy.batchChars) {
        groups.push({ start, end: index, blocks: current });
        current = [];
        currentChars = 0;
        start = index;
      }
      current.push(...parts);
      currentChars += length;
      if (currentChars >= strategy.batchChars) {
        groups.push({ start, end: index + 1, blocks: current });
        current = [];
        currentChars = 0;
        start = index + 1;
      }
    }
    if (current.length > 0) groups.push({ start, end: floorGroups.length, blocks: current });
  }

  const plans = groups.map((group, index): SummaryBatchPlan => {
    const contextStart = Math.max(0, group.start - strategy.overlapFloors);
    const batch: SourceBlock[] = [];
    if (index === 0) appendUnique(batch, metadata);
    appendUnique(batch, flattenedGroups(floorGroups.slice(contextStart, group.start)).flatMap((message) => splitForCharLimit(message, strategy.batchChars)));
    appendUnique(batch, group.blocks);
    const writableSources = [
      ...(index === 0 ? metadata : []),
      ...group.blocks,
    ].filter(isTaskWritable);
    return {
      sources: batch,
      writableSourceRefs: [...new Set(writableSources.map((source) => source.id))],
      messageCount: new Set(writableSources.filter((source) => source.kind === 'message').map(messageSourceId)).size,
    };
  });
  if (!taskWritableRefs) return plans;
  const writablePlans: SummaryBatchPlan[] = [];
  let leadingContext: SourceBlock[] = [];
  for (const plan of plans) {
    if (plan.writableSourceRefs.length === 0) {
      appendUnique(leadingContext, plan.sources);
      continue;
    }
    if (leadingContext.length > 0) {
      const sourcesWithContext: SourceBlock[] = [];
      appendUnique(sourcesWithContext, leadingContext);
      appendUnique(sourcesWithContext, plan.sources);
      writablePlans.push({ ...plan, sources: sourcesWithContext });
      leadingContext = [];
    } else {
      writablePlans.push(plan);
    }
  }
  return writablePlans;
}

/** 根据当前总结策略的实际批次估算 LLM 输入成本。 */
export function estimateSummaryInitialization(
  messageCount: number,
  batches: readonly (readonly SourceBlock[])[],
): SummaryInitializationEstimate {
  const estimatedInputTokens = batches.reduce((total, batch) => (
    total + Math.ceil(batch.reduce((chars, source) => chars + source.content.length, 0) * 0.9) + 1_200
  ), 0);
  const roundToHundred = (value: number): number => Math.ceil(value / 100) * 100;
  return {
    messageCount,
    batchCount: batches.length,
    tokenLow: roundToHundred(estimatedInputTokens * 0.75),
    tokenHigh: roundToHundred(estimatedInputTokens * 1.25),
  };
}

/**
 * 自动总结只在“已总结边界之后又完整新增了一个间隔窗口，且多出下一层”时触发。
 * 这样在 cursor=60、间隔=5、当前到 66 时，目标正好是 61–65，66 留待下一窗口。
 */
export function selectAutomaticSummaryWindow(
  blocks: readonly SourceBlock[],
  progress: SummaryProgress | undefined,
  strategyInput: Partial<SummaryStrategy>,
): AutomaticSummaryWindow | undefined {
  if (!progress) return undefined;
  const strategy = normalizeSummaryStrategy(strategyInput);
  const floorGroups = conversationFloorGroups(blocks);
  const firstNewIndex = floorGroups.findIndex((group, index) => groupFloor(group, index + 1) > progress.completedFloor);
  if (firstNewIndex < 0) return undefined;
  const afterCursor = floorGroups.slice(firstNewIndex);
  if (afterCursor.length <= strategy.triggerIntervalFloors) return undefined;
  const target = afterCursor[strategy.triggerIntervalFloors - 1]!;
  const targetIndex = firstNewIndex + strategy.triggerIntervalFloors - 1;
  const contextStart = Math.max(0, firstNewIndex - strategy.overlapFloors - 1);
  const selected = flattenedGroups(floorGroups.slice(contextStart, targetIndex + 1));
  const writableSourceRefs = flattenedGroups(floorGroups.slice(firstNewIndex, targetIndex + 1)).map((source) => source.id);
  return {
    sources: selected,
    writableSourceRefs,
    startFloor: groupFloor(floorGroups[contextStart]!, contextStart + 1),
    endFloor: groupFloor(target, targetIndex + 1),
    endMessageId: groupMessageId(target),
    waitingFloors: 0,
  };
}

export function getSummaryWaitingFloors(
  blocks: readonly SourceBlock[],
  progress: SummaryProgress | undefined,
  strategyInput: Partial<SummaryStrategy>,
): number | undefined {
  if (!progress) return undefined;
  const strategy = normalizeSummaryStrategy(strategyInput);
  const groups = conversationFloorGroups(blocks);
  const count = groups.filter((group, index) => groupFloor(group, index + 1) > progress.completedFloor).length;
  return Math.max(0, strategy.triggerIntervalFloors + 1 - count);
}
