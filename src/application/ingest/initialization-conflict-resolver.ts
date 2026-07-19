import { MEMORY_PLUGIN_ID, type MemoryLlmApi } from './llm-extractor';
import type {
  InitializationConflictBucket,
  InitializationConflictResolution,
  InitializationReducedFact,
} from './initialization-finalizer';

export const MEMORY_INITIALIZATION_CONFLICT_RESOLVE_TASK = 'memory_initialize_conflict_resolve';

const CONFLICT_RESOLUTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['resolutions'],
  properties: {
    resolutions: {
      type: 'array',
      maxItems: 24,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['bucketId', 'action', 'primaryId', 'secondaryIds'],
        properties: {
          bucketId: { type: 'string' },
          action: { type: 'string', enum: ['merge', 'keep_both', 'supersede', 'pending'] },
          primaryId: { type: ['string', 'null'] },
          secondaryIds: { type: 'array', maxItems: 12, items: { type: 'string' } },
        },
      },
    },
  },
} as const;

type ResolverOutput = {
  resolutions?: Array<{
    bucketId?: unknown;
    action?: unknown;
    primaryId?: unknown;
    secondaryIds?: unknown;
  }>;
};

export interface InitializationConflictResolutionResult {
  resolutions: InitializationConflictResolution[];
  error?: string;
}

/**
 * Resolves only the reduced conflict buckets. The model can select existing
 * records, but cannot create replacement prose or evidence.
 */
export async function resolveInitializationConflicts(input: {
  llm: MemoryLlmApi | null;
  buckets: readonly InitializationConflictBucket[];
  facts: readonly InitializationReducedFact[];
}): Promise<InitializationConflictResolutionResult> {
  if (!input.buckets.length) return { resolutions: [] };
  if (!input.llm) return { resolutions: [], error: 'LLMHub 不可用，未解决冲突已保留为待审阅。' };
  const factsById = new Map(input.facts.map((fact) => [fact.id, fact]));
  const payload = input.buckets.map((bucket) => ({
    bucketId: bucket.id,
    mode: bucket.mode,
    records: bucket.recordIds.map((id) => {
      const fact = factsById.get(id)!;
      return {
        id: fact.id,
        kind: fact.kind,
        subjectKey: fact.subjectKey,
        predicateKey: fact.predicateKey,
        objectKey: fact.objectKey ?? null,
        content: fact.content,
        confidence: fact.confidence,
        freshestEvidenceAt: fact.freshestEvidenceAt,
        evidence: fact.evidence.slice(0, 3),
      };
    }),
  }));
  const response = await input.llm.runTask<ResolverOutput>({
    consumer: MEMORY_PLUGIN_ID,
    taskKey: MEMORY_INITIALIZATION_CONFLICT_RESOLVE_TASK,
    taskDescription: '初始化记忆冲突裁决',
    taskKind: 'generation',
    input: {
      messages: [
        {
          role: 'system',
          content: '你只裁决已验证的记忆冲突，不能补写事实或证据。每个 bucket 只能选择其中已有记录 ID。时间型冲突优先较新的高置信记录；稳定设定若无法确定应返回 pending。只输出符合 schema 的 JSON。',
        },
        { role: 'user', content: JSON.stringify({ buckets: payload }) },
      ],
    },
    schema: CONFLICT_RESOLUTION_SCHEMA,
    budget: { maxTokens: 1_024 },
    enqueue: { displayMode: 'compact' },
  });
  if (!response.ok) return { resolutions: [], error: response.error || '冲突裁决请求失败。' };
  const bucketMap = new Map(input.buckets.map((bucket) => [bucket.id, bucket]));
  const resolutions: InitializationConflictResolution[] = [];
  for (const raw of response.data.resolutions ?? []) {
    const bucketId = String(raw.bucketId ?? '').trim();
    const bucket = bucketMap.get(bucketId);
    const action = String(raw.action ?? '').trim();
    const primaryId = typeof raw.primaryId === 'string' ? raw.primaryId.trim() : '';
    const secondaryIds = Array.isArray(raw.secondaryIds)
      ? [...new Set(raw.secondaryIds.map((value) => String(value).trim()).filter((value) => value && value !== primaryId && bucket?.recordIds.includes(value)))]
      : [];
    if (!bucket || !['merge', 'keep_both', 'supersede', 'pending'].includes(action)) continue;
    if (action !== 'pending' && (!primaryId || !bucket.recordIds.includes(primaryId))) continue;
    resolutions.push({
      bucketId,
      action: action as InitializationConflictResolution['action'],
      ...(primaryId ? { primaryId } : {}),
      ...(secondaryIds.length ? { secondaryIds } : {}),
      resolver: 'llm',
    });
  }
  return { resolutions };
}
