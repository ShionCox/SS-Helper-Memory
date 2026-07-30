import type { SourceBlock } from './types';

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
const SENSITIVE_STATE_SEGMENT_PATTERN = /^(?:api(?:key)?|apikey|access(?:token)?|refreshtoken|authtoken|authorization|bearer|password|passwd|pwd|secretkey|clientsecret|privatekey|cookie|session(?:id|token)?|credential|credentials|密钥|令牌|密码|口令|凭据|认证信息|授权信息|会话令牌)$/iu;
const SENSITIVE_STATE_SEGMENT_SUFFIX_PATTERN = /(?:apikey|accesstoken|refreshtoken|authtoken|authorization|password|passwd|secretkey|clientsecret|privatekey|sessiontoken|credential|credentials|密钥|令牌|密码|口令|凭据|认证信息|授权信息|会话令牌)$/iu;
const SENSITIVE_STATE_VALUE_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]{12,}={0,2}\b/iu,
  /\b(?:sk|rk|pk|ghp|github_pat|glpat|xox[baprs])-?[A-Za-z0-9_-]{16,}\b/u,
  /\bAIza[0-9A-Za-z_-]{20,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
] as const;
const OOC_INSTRUCTION_PATTERN = /(?:^|[\n(（\[])[ \t]*(?:ooc|out[- ]of[- ]character|幕后指令|系统指令)[ \t]*[:：]/imu;
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

function normalizeStateSegment(value: string): string {
  return value.trim().replace(/[\s_.\-:/\\]+/gu, '').toLocaleLowerCase();
}

/** Security boundary shared by variable snapshots and UpdateVariable patches. */
export function isSensitiveStatePath(value: string | readonly string[]): boolean {
  const segments: readonly string[] = typeof value === 'string'
    ? value.split('/').filter(Boolean).map((segment: string) => segment.replace(/~1/gu, '/').replace(/~0/gu, '~'))
    : value;
  return segments.some((segment) => {
    const normalized = normalizeStateSegment(segment);
    return SENSITIVE_STATE_SEGMENT_PATTERN.test(normalized) || SENSITIVE_STATE_SEGMENT_SUFFIX_PATTERN.test(normalized);
  });
}

/** Reject recognizable credential material even when stored under an innocent key. */
export function containsSensitiveCredential(value: unknown): boolean {
  let serialized: string;
  try {
    serialized = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return true;
  }
  return Boolean(serialized) && SENSITIVE_STATE_VALUE_PATTERNS.some(pattern => pattern.test(serialized));
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
  let serialized: string;
  try {
    serialized = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (!serialized || SENSITIVE_CONTROL_TAG_PATTERN.test(serialized) || containsSensitiveCredential(serialized)) return undefined;
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
      if (CONTROL_PATCH_PATH_PATTERN.test(path) || UNSAFE_PATCH_PATH_PATTERN.test(path) || isSensitiveStatePath(path)) continue;
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

export interface SourceBlockFilterOptions {
  /**
   * 初始化可显式读取酒馆中被隐藏的普通用户/助手楼层。
   * 工具、推理、系统与控制块无论如何都不会因此放行。
   */
  includeHiddenMessageFloors?: boolean;
}

function isConversationFloor(block: SourceBlock): boolean {
  return block.kind === 'message'
    && (block.role === 'user' || block.role === 'assistant')
    && block.messageType !== 'tool'
    && block.messageType !== 'reasoning'
    && block.messageType !== 'system';
}

/** 只保留用户授权的正文来源块，并始终阻断工具、推理、系统和控制内容。 */
export function filterSourceBlocks(
  blocks: readonly SourceBlock[],
  options: SourceBlockFilterOptions = {},
): SourceBlock[] {
  return blocks.flatMap((block): SourceBlock[] => {
    const hidden = block.hidden === true || block.visibility === 'hidden';
    const allowHiddenFloor = options.includeHiddenMessageFloors === true && isConversationFloor(block);
    if (
      block.visibility === 'control'
      || (hidden && !allowHiddenFloor)
      || block.messageType === 'tool'
      || block.messageType === 'reasoning'
      || block.role === 'tool'
      || block.role === 'system'
      || block.messageType === 'system'
    ) return [];
    const content = sanitizeSourceContent(block.content);
    if (!content) return [];
    if (block.kind === 'message' && OOC_INSTRUCTION_PATTERN.test(content)) return [];
    return [{ ...block, content }];
  });
}
