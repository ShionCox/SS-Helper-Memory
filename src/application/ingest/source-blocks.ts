import type { SourceBlock } from './types';

export const HISTORY_BATCH_MAX_MESSAGES = 20;
export const HISTORY_BATCH_MAX_CHARS = 12_000;
export const HISTORY_BATCH_OVERLAP = 2;

export interface InitializationEstimate {
  messageCount: number;
  batchCount: number;
  tokenLow: number;
  tokenHigh: number;
}

const CONTROL_BLOCK_PATTERNS = [
  /<(?:think|analysis|tool|debug|memory)\b[^>]*>[\s\S]*?<\/(?:think|analysis|tool|debug|memory)\s*>/giu,
  /<UpdateVariable\b[^>]*>[\s\S]*?<\/UpdateVariable\s*>/giu,
];

const UPDATE_VARIABLE_BLOCK_PATTERN = /<UpdateVariable\b[^>]*>([\s\S]*?)<\/UpdateVariable\s*>/giu;
const UPDATE_ANALYSIS_BLOCK_PATTERN = /<Analysis\b[^>]*>([\s\S]*?)<\/Analysis\s*>/giu;
const UPDATE_JSON_PATCH_BLOCK_PATTERN = /<JSONPatch\b[^>]*>([\s\S]*?)<\/JSONPatch\s*>/giu;

const STRUCTURED_ANALYSIS_LINE_PATTERN = /^(?:[-*]\s+\S+|[^:：\n]{1,80}[:：]\s*\S)/u;
const STATE_ANALYSIS_CUE_PATTERN = /(?:\b(?:state|status|inventory|(?:(?:low|medium|high|special)\s+)?cores?|member|weapon|food|water|day|location|relationship|goal)\b|状态|储备|库存|成员|武器|食物|饮用水|天数|位置|关系|目标|剩余|数量|更新)/iu;
const CONTROL_ANALYSIS_CUE_PATTERN = /(?:\b(?:fate\s*branches?|option|prompt|instruction|system|tool|debug|reasoning|nsfw)\b|命运分支|选项|提示词|系统|工具|调试|推理)/iu;
const CONTROL_PATCH_PATH_PATTERN = /(?:^|\/)(?:命运分支|选项[^/]*|fate(?:_|\s|-)*branches?|options?|prompt|instruction|system|tool|debug|reasoning|analysis|nsfw)(?:\/|$)/iu;
const UNSAFE_PATCH_PATH_PATTERN = /(?:^|\/)(?:__proto__|prototype|constructor)(?:\/|$)/u;
const SENSITIVE_CONTROL_TAG_PATTERN = /<\/?(?:think|analysis|tool|debug|memory|UpdateVariable|JSONPatch|StatusPlaceHolderImpl)\b/iu;
const MAX_PRESERVED_STATE_VALUE_CHARS = 1_000;

const CONTROL_TAG_PATTERNS = [
  /<\/?(?:think|analysis|tool|debug|memory|UpdateVariable|JSONPatch)\b[^>]*>/giu,
  /<StatusPlaceHolderImpl\s*\/?>/giu,
];

const CONTROL_LINE_PATTERNS = [
  /^\s*stx_memory\s*[:：].*$/gimu,
  /^\s*(?:system|tool|debug)\s*[:：].*$/gimu,
];

interface JsonPatchOperation {
  op?: unknown;
  path?: unknown;
  value?: unknown;
}

function extractStateAnalysis(content: string): string[] {
  const lines: string[] = [];
  for (const match of content.matchAll(UPDATE_ANALYSIS_BLOCK_PATTERN)) {
    for (const rawLine of (match[1] ?? '').split('\n')) {
      const line = rawLine.trim();
      if (
        !line
        || !STRUCTURED_ANALYSIS_LINE_PATTERN.test(line)
        || !STATE_ANALYSIS_CUE_PATTERN.test(line)
        || CONTROL_ANALYSIS_CUE_PATTERN.test(line)
        || SENSITIVE_CONTROL_TAG_PATTERN.test(line)
      ) continue;
      lines.push(line.replace(/^[-*]\s*/, ''));
    }
  }
  return lines;
}

function decodeJsonPointerPath(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map(segment => segment.replace(/~1/gu, '/').replace(/~0/gu, '~'))
    .join(' / ');
}

function formatPatchValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  if (!serialized || SENSITIVE_CONTROL_TAG_PATTERN.test(serialized)) return undefined;
  return serialized.length > MAX_PRESERVED_STATE_VALUE_CHARS
    ? `${serialized.slice(0, MAX_PRESERVED_STATE_VALUE_CHARS)}…`
    : serialized;
}

function extractJsonPatchState(content: string): string[] {
  const lines: string[] = [];
  const candidates = [...content.matchAll(UPDATE_JSON_PATCH_BLOCK_PATTERN)]
    .map(match => match[1] ?? '');
  const unwrappedCandidate = content
    .replace(UPDATE_ANALYSIS_BLOCK_PATTERN, '')
    .replace(UPDATE_JSON_PATCH_BLOCK_PATTERN, '')
    .trim()
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .trim();
  if (unwrappedCandidate.startsWith('[') && unwrappedCandidate.endsWith(']')) {
    candidates.push(unwrappedCandidate);
  }
  for (const candidate of candidates) {
    let operations: unknown;
    try {
      operations = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!Array.isArray(operations)) continue;
    for (const rawOperation of operations) {
      if (!rawOperation || typeof rawOperation !== 'object') continue;
      const operation = rawOperation as JsonPatchOperation;
      const op = typeof operation.op === 'string' ? operation.op.toLowerCase() : '';
      const path = typeof operation.path === 'string' ? operation.path : '';
      if (!['add', 'replace', 'remove'].includes(op) || !path.startsWith('/')) continue;
      if (CONTROL_PATCH_PATH_PATTERN.test(path) || UNSAFE_PATCH_PATH_PATTERN.test(path)) continue;
      const readablePath = decodeJsonPointerPath(path);
      if (!readablePath) continue;
      if (op === 'remove') {
        lines.push(`${readablePath}：已移除`);
        continue;
      }
      const value = formatPatchValue(operation.value);
      if (value !== undefined) lines.push(`${readablePath}：${value}`);
    }
  }
  return lines;
}

function preserveVisibleUpdateState(value: string): string {
  return value.replace(UPDATE_VARIABLE_BLOCK_PATTERN, (_block, inner: string) => {
    const analysis = extractStateAnalysis(inner);
    const patches = extractJsonPatchState(inner);
    if (analysis.length === 0 && patches.length === 0) return '';
    return [
      ...analysis.map(line => `状态说明：${line}`),
      ...patches.map(line => `状态更新：${line}`),
    ].join('\n');
  });
}

/** 剥离隐藏推理与插件控制文本，并将变量更新收敛为可提炼的状态摘要。 */
export function sanitizeSourceContent(value: string): string {
  let content = preserveVisibleUpdateState(value.replace(/\r\n?/g, '\n'));
  for (const pattern of CONTROL_BLOCK_PATTERNS) content = content.replace(pattern, '');
  for (const pattern of CONTROL_TAG_PATTERNS) content = content.replace(pattern, '');
  for (const pattern of CONTROL_LINE_PATTERNS) content = content.replace(pattern, '');
  return content.replace(/\n{3,}/g, '\n\n').trim();
}

/** 只保留用户授权且模型可见的来源块。 */
export function filterSourceBlocks(blocks: readonly SourceBlock[]): SourceBlock[] {
  return splitOversizedSourceBlocks(blocks.flatMap((block): SourceBlock[] => {
    if (block.hidden || block.role === 'system' || block.role === 'tool') return [];
    const content = sanitizeSourceContent(block.content);
    if (!content) return [];
    return [{ ...block, content }];
  }));
}

/** 将超长来源完整切成稳定分片，证据和检查点均使用分片 ID。 */
export function splitOversizedSourceBlocks(blocks: readonly SourceBlock[]): SourceBlock[] {
  return blocks.flatMap((block) => {
    if (block.content.length <= HISTORY_BATCH_MAX_CHARS) return [block];
    const parts: SourceBlock[] = [];
    for (let offset = 0, part = 1; offset < block.content.length; offset += HISTORY_BATCH_MAX_CHARS, part += 1) {
      parts.push({
        ...block,
        id: `${block.id}:part:${part}`,
        content: block.content.slice(offset, offset + HISTORY_BATCH_MAX_CHARS),
      });
    }
    return parts;
  });
}

/** 构造可恢复的历史批次，批次间只保留两条上下文。 */
export function buildHistoryBatches(blocks: readonly SourceBlock[]): SourceBlock[][] {
  const normalizedBlocks = splitOversizedSourceBlocks(blocks);
  const batches: SourceBlock[][] = [];
  let cursor = 0;
  while (cursor < normalizedBlocks.length) {
    const batch: SourceBlock[] = [];
    let charCount = 0;
    let index = cursor;
    while (index < normalizedBlocks.length && batch.length < HISTORY_BATCH_MAX_MESSAGES) {
      const next = normalizedBlocks[index]!;
      const nextLength = next.content.length;
      if (batch.length > 0 && charCount + nextLength > HISTORY_BATCH_MAX_CHARS) break;
      batch.push(next);
      charCount += nextLength;
      index += 1;
    }
    batches.push(batch);
    if (index >= normalizedBlocks.length) break;
    cursor = Math.max(cursor + 1, index - HISTORY_BATCH_OVERLAP);
  }
  return batches;
}

/**
 * 按实际历史批次估算初始化输入成本。
 * 估算包含每批固定提示词余量，但最终消耗仍以 LLMHub 的供应商 usage 为准。
 */
export function estimateHistoryInitialization(
  messageCount: number,
  batches: readonly (readonly SourceBlock[])[],
): InitializationEstimate {
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

/** 增量窗口只提交可完整容纳的连续来源；未进入本批的来源保留到下次检查点。 */
export function buildIncrementalBatch(blocks: readonly SourceBlock[]): SourceBlock[] {
  const selected: SourceBlock[] = [];
  let charCount = 0;
  for (const block of splitOversizedSourceBlocks(blocks)) {
    if (selected.length >= HISTORY_BATCH_MAX_MESSAGES || charCount + block.content.length > HISTORY_BATCH_MAX_CHARS) break;
    selected.push(block);
    charCount += block.content.length;
  }
  return selected;
}
