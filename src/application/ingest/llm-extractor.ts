import type { ExtractedFactProposal, MemoryExtractionResult, MemoryExtractor, SourceBlock } from './types';

export const MEMORY_PLUGIN_ID = 'stx_memory';
export const MEMORY_EXTRACT_TASK = 'memory_extract';
export const MEMORY_EMBED_TASK = 'memory_embed';
export const MEMORY_RERANK_TASK = 'memory_rerank';
export const MEMORY_EXTRACT_MAX_TOKENS = 3_072;

export type MemoryLlmTaskKind = 'generation' | 'embedding' | 'rerank';

export interface MemoryLlmMeta {
  requestId?: string;
  resourceId?: string;
  model?: string;
  latencyMs?: number;
  fallbackUsed?: boolean;
}

export interface MemoryLlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type MemoryLlmFailure = {
  ok: false;
  error: string;
  reasonCode?: string;
  retryable?: boolean;
  fallbackUsed?: boolean;
  meta?: MemoryLlmMeta;
};

export type MemoryEmbedResult = {
  ok: true;
  vectors: number[][];
  model?: string;
  meta?: MemoryLlmMeta;
  usage?: MemoryLlmUsage;
} | MemoryLlmFailure;

export interface MemoryRerankItem {
  index: number;
  score: number;
  doc?: string;
}

export type MemoryRerankResult = {
  ok: true;
  results: MemoryRerankItem[];
  resource?: string;
  fallbackUsed?: boolean;
  meta?: MemoryLlmMeta;
  usage?: MemoryLlmUsage;
} | MemoryLlmFailure;

export interface MemoryLlmApi {
  runTask<T>(input: {
    consumer: string;
    taskKey: string;
    taskDescription: string;
    taskKind: 'generation';
    input: { messages: Array<{ role: 'system' | 'user'; content: string }> };
    schema: object;
    budget: { maxTokens: number };
    enqueue: { displayMode: 'compact' | 'silent' };
  }): Promise<{
    ok: true;
    data: T;
    meta?: MemoryLlmMeta;
    usage?: MemoryLlmUsage;
  } | {
    ok: false;
    error: string;
    reasonCode?: string;
    meta?: MemoryLlmMeta;
  }>;
  embed?(input: {
    consumer: string;
    taskKey: string;
    taskDescription?: string;
    texts: string[];
    budget?: { maxLatencyMs?: number };
    enqueue?: { displayMode: 'compact' | 'silent' };
  }): Promise<MemoryEmbedResult>;
  rerank?(input: {
    consumer: string;
    taskKey: string;
    taskDescription?: string;
    query: string;
    docs: string[];
    topK?: number;
    budget?: { maxLatencyMs?: number };
    enqueue?: { displayMode: 'compact' | 'silent' };
  }): Promise<MemoryRerankResult>;
  inspect?: {
    previewRoute(input: {
      consumer: string;
      taskKey: string;
      taskKind: MemoryLlmTaskKind;
      requiredCapabilities?: string[];
    }): Promise<{ resourceId?: string; model?: string; blockedReason?: string }> | { resourceId?: string; model?: string; blockedReason?: string };
  };
}

let configuredLlmApi: MemoryLlmApi | null = null;

export function configureMemoryLlmApi(api: MemoryLlmApi | null): void { configuredLlmApi = api; }

export interface MemoryLlmRouteDiagnostic {
  available: boolean;
  resourceId?: string;
  model?: string;
  blockedReason?: string;
}

export interface MemoryRecallRouteDiagnostics {
  embedding: MemoryLlmRouteDiagnostic;
  rerank: MemoryLlmRouteDiagnostic;
}

export class MemoryLlmTaskError extends Error {
  constructor(
    message: string,
    readonly details: { reasonCode?: string; resourceId?: string; model?: string } = {},
  ) {
    super(message);
    this.name = 'MemoryLlmTaskError';
  }
}

const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['facts'],
  properties: {
    facts: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'kind', 'subjectKey', 'predicateKey', 'objectKey', 'content', 'entityKeys',
          'confidence', 'sourceRef', 'evidenceExcerpt', 'actionHint', 'validFrom', 'validTo', 'stable',
        ],
        properties: {
          kind: { type: 'string', enum: ['identity', 'relationship', 'location', 'world_rule', 'state', 'goal', 'commitment', 'event', 'preference'] },
          subjectKey: { type: 'string' },
          predicateKey: { type: 'string' },
          objectKey: { type: ['string', 'null'] },
          content: { type: 'string', minLength: 20, maxLength: 240 },
          entityKeys: { type: 'array', items: { type: 'string' }, maxItems: 12 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          sourceRef: { type: 'string' },
          evidenceExcerpt: { type: 'string' },
          actionHint: { type: 'string', enum: ['upsert', 'supersede'] },
          validFrom: { type: ['number', 'null'] },
          validTo: { type: ['number', 'null'] },
          stable: { type: 'boolean' },
        },
      },
    },
  },
} as const;

function normalizeProposal(value: unknown): ExtractedFactProposal | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const allowedKinds = new Set(['identity', 'relationship', 'location', 'world_rule', 'state', 'goal', 'commitment', 'event', 'preference']);
  const kind = String(row.kind ?? '');
  const actionHint = row.actionHint === 'supersede' ? 'supersede' : 'upsert';
  if (!allowedKinds.has(kind) || !Array.isArray(row.entityKeys)) return null;
  const proposal: ExtractedFactProposal = {
    kind: kind as ExtractedFactProposal['kind'],
    subjectKey: String(row.subjectKey ?? '').trim(),
    predicateKey: String(row.predicateKey ?? '').trim(),
    content: String(row.content ?? '').trim(),
    entityKeys: row.entityKeys.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 12),
    confidence: Number(row.confidence),
    sourceRef: String(row.sourceRef ?? '').trim(),
    evidenceExcerpt: String(row.evidenceExcerpt ?? '').trim(),
    actionHint,
  };
  const objectKey = String(row.objectKey ?? '').trim();
  if (objectKey) proposal.objectKey = objectKey;
  const validFrom = Number(row.validFrom);
  const validTo = Number(row.validTo);
  if (Number.isFinite(validFrom) && validFrom > 0) proposal.validFrom = validFrom;
  if (Number.isFinite(validTo) && validTo > 0) proposal.validTo = validTo;
  if (row.stable === true) proposal.stable = true;
  return proposal;
}

export function readMemoryLlmApi(): MemoryLlmApi | null {
  return configuredLlmApi;
}

async function readRouteDiagnostic(
  taskKey: string,
  taskKind: MemoryLlmTaskKind,
  requiredCapabilities: string[],
): Promise<MemoryLlmRouteDiagnostic> {
  const llm = readMemoryLlmApi();
  if (!llm) return { available: false, blockedReason: 'LLMHub 未加载或版本过旧' };
  if (!llm.inspect?.previewRoute) return { available: true };
  try {
    const route = await llm.inspect.previewRoute({
      consumer: MEMORY_PLUGIN_ID,
      taskKey,
      taskKind,
      requiredCapabilities,
    });
    return {
      available: true,
      ...(route.resourceId ? { resourceId: route.resourceId } : {}),
      ...(route.model ? { model: route.model } : {}),
      ...(route.blockedReason ? { blockedReason: route.blockedReason } : {}),
    };
  } catch (error) {
    return { available: true, blockedReason: error instanceof Error ? error.message : String(error) };
  }
}

/** 只读当前 memory_extract 路由，供错误定位使用；绝不读取或展示凭据。 */
export async function readMemoryLlmRouteDiagnostic(): Promise<MemoryLlmRouteDiagnostic> {
  return readRouteDiagnostic(MEMORY_EXTRACT_TASK, 'generation', ['chat', 'json']);
}

/** 读取向量与重排路由，只返回安全的资源/模型元数据。 */
export async function readMemoryRecallRouteDiagnostics(): Promise<MemoryRecallRouteDiagnostics> {
  const [embedding, rerank] = await Promise.all([
    readRouteDiagnostic(MEMORY_EMBED_TASK, 'embedding', ['embeddings']),
    readRouteDiagnostic(MEMORY_RERANK_TASK, 'rerank', ['rerank']),
  ]);
  return { embedding, rerank };
}

function serializeSources(sources: readonly SourceBlock[]): string {
  return sources.map((source) => JSON.stringify({
    id: source.id,
    kind: source.kind,
    role: source.role,
    floor: source.floor ?? null,
    content: source.content,
  })).join('\n');
}

export class LlmMemoryExtractor implements MemoryExtractor {
  constructor(private readonly getLlm: () => MemoryLlmApi | null = readMemoryLlmApi) {}

  async extract(input: { chatKey: string; sources: readonly SourceBlock[] }): Promise<MemoryExtractionResult> {
    const llm = this.getLlm();
    if (!llm) throw new Error('LLMHub 不可用，无法执行 memory_extract。');
    const response = await llm.runTask<{ facts?: unknown[] }>({
      consumer: MEMORY_PLUGIN_ID,
      taskKey: MEMORY_EXTRACT_TASK,
      taskDescription: '记忆原子事实提炼',
      taskKind: 'generation',
      input: {
        messages: [
          {
            role: 'system',
            content: [
              '你是严谨的记忆提炼器。只依据给定 source blocks 输出事实，不得推测。',
              '每条事实必须是 20–240 字的单一命题，并逐字复制一段能在对应来源正文中找到的 evidenceExcerpt。',
              '输出前必须逐条计算 content 字符数；少于 20 字时，用“明确表示、已确认、当前”等不增加新事实的完整陈述扩写到 20 字以上。',
              '长度示例：不要写“林舟出生在云港”；应写“林舟明确表示自己出生在云港，云港是其已经确认的出生地点”。',
              '最多输出 12 条；不确定、缺少证据、仅为措辞重复的内容不要输出。',
              '新事实可能替代旧状态时使用 supersede，但不要自行裁决数据库冲突。',
            ].join('\n'),
          },
          { role: 'user', content: `chatKey=${input.chatKey}\n${serializeSources(input.sources)}` },
        ],
      },
      schema: EXTRACTION_SCHEMA,
      budget: { maxTokens: MEMORY_EXTRACT_MAX_TOKENS },
      enqueue: { displayMode: 'compact' },
    });
    if (!response.ok) {
      const reasonCode = response.reasonCode || (/\b401\b/.test(response.error) ? '401' : undefined);
      const details = {
        ...(reasonCode ? { reasonCode } : {}),
        ...(response.meta?.resourceId ? { resourceId: response.meta.resourceId } : {}),
        ...(response.meta?.model ? { model: response.meta.model } : {}),
      };
      const suffix = [
        reasonCode ? `错误码=${reasonCode}` : '',
        response.meta?.resourceId ? `资源=${response.meta.resourceId}` : '',
        response.meta?.model ? `模型=${response.meta.model}` : '',
      ].filter(Boolean).join('；');
      throw new MemoryLlmTaskError(`${response.error || 'memory_extract 执行失败。'}${suffix ? `（${suffix}）` : ''}`, details);
    }
    const facts = Array.isArray(response.data?.facts) ? response.data.facts : [];
    return {
      facts: facts.map(normalizeProposal).filter((item): item is ExtractedFactProposal => item !== null).slice(0, 12),
      audit: {
        ...(response.meta?.requestId ? { requestId: response.meta.requestId } : {}),
        ...(response.meta?.resourceId ? { resourceId: response.meta.resourceId } : {}),
        ...(response.meta?.model ? { model: response.meta.model } : {}),
        ...(Number.isFinite(response.meta?.latencyMs) ? { latencyMs: response.meta?.latencyMs } : {}),
        usage: response.usage ? {
          promptTokens: Number.isFinite(response.usage.promptTokens) ? response.usage.promptTokens : null,
          completionTokens: Number.isFinite(response.usage.completionTokens) ? response.usage.completionTokens : null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          totalTokens: Number.isFinite(response.usage.totalTokens) ? response.usage.totalTokens : null,
        } : null,
      },
    };
  }
}
