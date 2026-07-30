import type { AutomaticIngestRejection, MemoryTokenUsage } from '../../domain';
import { createSSHelperError, type SSHelperFailureContext } from '@ss-helper/sdk';
import type {
  MemoryExtractionInput,
  SourceBlock,
  StructuredActorCandidate,
  StructuredCaptureResult,
  StructuredClaim,
  StructuredClaimKnowledge,
  StructuredEpisode,
  StructuredLocationCandidate,
} from './types';
import {
  buildSupportedEvidenceDirectory,
  evidenceSpanById,
  type SupportedEvidenceDirectory,
} from './supported-evidence-directory';

export const MEMORY_PLUGIN_ID = 'stx_memory';
export const MEMORY_CAPTURE_TASK = 'memory_capture';
export const MEMORY_CAPTURE_REPAIR_TASK = 'memory_capture_repair';
export const MEMORY_EMBED_TASK = 'memory_embed';
export const MEMORY_RERANK_TASK = 'memory_rerank';
export const MEMORY_CAPTURE_MAX_TOKENS = 4_096;

export type MemoryLlmTaskKind = 'generation' | 'embedding' | 'rerank';

export interface MemoryLlmMeta {
  requestId?: string;
  resourceId?: string;
  model?: string;
  latencyMs?: number;
  fallbackUsed?: boolean;
  attemptCount?: number;
  repairCount?: number;
  transport?: 'json_schema' | 'json_object' | 'tavern_json_schema' | 'prompt_only';
  validationOutcome?: 'complete' | 'partial';
  itemRejections?: Array<{
    collection: string;
    itemIndex: number;
    issues: Array<{ path: string; keyword: string; expected: string }>;
    sourceRefs: string[];
  }>;
  parentRequestId?: string;
}

export interface MemoryLlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type MemoryLlmFailure = {
  ok: false;
  failure: SSHelperFailureContext;
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

export interface MemoryLlmClient {
  runTask<T>(input: {
    consumer: string;
    taskKey: string;
    taskDescription: string;
    taskKind: 'generation';
    input: { messages: Array<{ role: 'system' | 'user'; content: string }> };
    schema: object;
    budget: { maxTokens: number; maxLatencyMs?: number };
    enqueue: { displayMode: 'compact' | 'silent' };
    route?: { resourceId?: string; model?: string };
    parentRequestId?: string;
  }): Promise<{
    ok: true;
    data: T;
    meta?: MemoryLlmMeta;
    usage?: MemoryLlmUsage;
  } | {
    ok: false;
    failure: SSHelperFailureContext;
    retryable?: boolean;
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
    }): Promise<{ available?: boolean; resourceId?: string; model?: string; blockedReason?: string }> | { available?: boolean; resourceId?: string; model?: string; blockedReason?: string };
  };
}

let configuredLlmApi: MemoryLlmClient | null = null;
export const MEMORY_LLM_ROUTE_DIAGNOSTIC_TIMEOUT_MS = 3_000;

export function configureMemoryLlmClient(api: MemoryLlmClient | null): void { configuredLlmApi = api; }
export function readMemoryLlmClient(): MemoryLlmClient | null { return configuredLlmApi; }

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

async function readRouteWithDeadline<T>(operation: () => Promise<T> | T): Promise<T | undefined> {
  return await new Promise<T | undefined>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: T | undefined): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => finish(undefined), MEMORY_LLM_ROUTE_DIAGNOSTIC_TIMEOUT_MS);
    void Promise.resolve().then(operation).then(value => finish(value), () => finish(undefined));
  });
}

async function readRouteDiagnostic(
  taskKey: string,
  taskKind: MemoryLlmTaskKind,
  requiredCapabilities: string[],
): Promise<MemoryLlmRouteDiagnostic> {
  const llm = readMemoryLlmClient();
  if (!llm) return { available: false, blockedReason: 'LLMHub 未加载或版本过旧' };
  if (!llm.inspect?.previewRoute) return { available: false, blockedReason: '当前 LLM 不支持资源状态检查，请更新 LLM 插件' };
  const route = await readRouteWithDeadline(() => llm.inspect!.previewRoute({
    consumer: MEMORY_PLUGIN_ID,
    taskKey,
    taskKind,
    requiredCapabilities,
  }));
  if (!route || typeof route !== 'object') return { available: false, blockedReason: '暂时无法读取 LLM 资源状态' };
  const available = route.available === true
    || (route.available === undefined && !route.blockedReason && Boolean(route.resourceId || route.model));
  return {
    available,
    ...(route.resourceId ? { resourceId: route.resourceId } : {}),
    ...(route.model ? { model: route.model } : {}),
    ...(route.blockedReason ? { blockedReason: route.blockedReason } : {}),
  };
}

export async function readMemoryLlmRouteDiagnostic(): Promise<MemoryLlmRouteDiagnostic> {
  return readRouteDiagnostic(MEMORY_CAPTURE_TASK, 'generation', ['chat', 'json']);
}

export async function readMemoryRecallRouteDiagnostics(): Promise<MemoryRecallRouteDiagnostics> {
  const [embedding, rerank] = await Promise.all([
    readRouteDiagnostic(MEMORY_EMBED_TASK, 'embedding', ['embeddings']),
    readRouteDiagnostic(MEMORY_RERANK_TASK, 'rerank', ['rerank']),
  ]);
  return { embedding, rerank };
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&]/g, character => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' })[character]!);
}

function serializeExtractionInput(input: MemoryExtractionInput, evidenceDirectory: SupportedEvidenceDirectory): string {
  const writableSourceRefs = [...new Set(input.writableSourceRefs ?? input.sources.map(source => source.id))];
  const writableSourceRefSet = new Set(writableSourceRefs);
  const repairActorRefs = input.repair?.referenceDirectory
    ? new Set(input.repair.referenceDirectory.allowedActorRefs.map(item => item.referenceId))
    : undefined;
  const repairLocationRefs = input.repair?.referenceDirectory
    ? new Set(input.repair.referenceDirectory.allowedLocationRefs.map(item => item.referenceId))
    : undefined;
  const visibleActors = (input.knownActorContext ?? [])
    .filter(actor => !repairActorRefs || repairActorRefs.has(actor.referenceId));
  const visibleLocations = (input.knownLocationContext ?? [])
    .filter(location => !repairLocationRefs || repairLocationRefs.has(location.referenceId));
  const actorRefMap = new Map<string, string>();
  for (const actor of visibleActors) {
    for (const value of [actor.referenceId, actor.ownerId, actor.canonicalName, ...actor.aliases]) {
      if (value?.trim()) actorRefMap.set(value.trim(), actor.referenceId);
    }
  }
  const locationRefMap = new Map<string, string>();
  for (const location of visibleLocations) {
    for (const value of [location.referenceId, location.locationId, location.canonicalName, ...location.aliases]) {
      if (value?.trim()) locationRefMap.set(value.trim(), location.referenceId);
    }
  }
  const mapActorRef = (value: string | undefined): string | undefined => value ? actorRefMap.get(value.trim()) : undefined;
  const mapLocationRef = (value: string | undefined): string | undefined => value ? locationRefMap.get(value.trim()) : undefined;
  return safeJson({
    allowedSourceRefs: writableSourceRefs,
    contextOnlySourceRefs: input.sources.map(source => source.id).filter(sourceRef => !writableSourceRefSet.has(sourceRef)),
    knownActors: visibleActors.map(actor => ({
      ref: actor.referenceId,
      canonicalName: actor.canonicalName,
      aliases: actor.aliases,
      status: actor.status,
    })),
    knownLocations: visibleLocations.map(location => ({
      ref: location.referenceId,
      canonicalName: location.canonicalName,
      aliases: location.aliases,
      status: location.status,
    })),
    ...(input.repair?.referenceDirectory ? {
      repairAttempt: {
        attempt: input.repair.attempt ?? 1,
        maxAttempts: input.repair.maxAttempts ?? 2,
        mode: input.repair.mode ?? 'targeted',
      },
      supportedReferences: {
        actors: input.repair.referenceDirectory.allowedActorRefs.map(item => ({
          ref: item.referenceId,
          name: item.canonicalName,
          aliases: item.aliases,
          sourceRefs: item.sourceRefs,
        })),
        locations: input.repair.referenceDirectory.allowedLocationRefs.map(item => ({
          ref: item.referenceId,
          name: item.canonicalName,
          aliases: item.aliases,
          sourceRefs: item.sourceRefs,
        })),
        episodes: input.repair.referenceDirectory.allowedEpisodeRefs.map(item => ({
          ref: item.referenceId,
          summary: item.summary,
          sourceRefs: item.sourceRefs,
        })),
      },
    } : {}),
    existingMemoryContext: (input.existingMemoryContext ?? []).map(item => ({
      referenceId: item.referenceId,
      kind: item.kind,
      subjectKey: item.subjectKey,
      predicateKey: item.predicateKey,
      ...(item.objectKey === undefined ? {} : { objectKey: item.objectKey }),
      content: item.content,
    })),
    sourceBlocks: input.sources.map(source => ({
      id: source.id,
      kind: source.kind,
      role: source.role,
      floor: source.floor ?? null,
      createdAt: source.createdAt,
      semanticSection: source.semanticSection ?? 'narrative',
      ...(source.author ? { author: {
        kind: source.author.kind,
        ...(source.author.displayName ? { displayName: source.author.displayName } : {}),
      } } : {}),
      ...(source.perspective ? { perspective: {
        ...(mapActorRef(source.perspective.speakerOwnerRef) ? { speakerOwnerRef: mapActorRef(source.perspective.speakerOwnerRef) } : {}),
        ...(mapActorRef(source.perspective.viewpointOwnerRef) ? { viewpointOwnerRef: mapActorRef(source.perspective.viewpointOwnerRef) } : {}),
        observerOwnerRefs: (source.perspective.observerOwnerRefs ?? []).map(mapActorRef).filter(Boolean),
        mentionedOwnerRefs: (source.perspective.mentionedOwnerRefs ?? []).map(mapActorRef).filter(Boolean),
        presentOwnerRefs: (source.perspective.presentOwnerRefs ?? []).map(mapActorRef).filter(Boolean),
        ...(source.perspective.confidence === undefined ? {} : { confidence: source.perspective.confidence }),
      } } : {}),
      ...(source.actorRefs?.length ? { actorRefs: source.actorRefs.map(mapActorRef).filter(Boolean) } : {}),
      ...(source.locationRefs?.length ? { locationRefs: source.locationRefs.map(mapLocationRef).filter(Boolean) } : {}),
      ...(source.visibility ? { visibility: source.visibility } : {}),
      ...(writableSourceRefSet.has(source.id)
        ? {
          evidenceSpans: evidenceDirectory.spans
            .filter(span => span.sourceRef === source.id)
            .map(span => ({ evidenceSpanId: span.evidenceSpanId, text: span.text })),
        }
        : { contextText: source.content }),
    })),
  });
}

const FACT_KINDS = [
  'identity', 'relationship', 'location', 'world_rule', 'state', 'goal',
  'commitment', 'preference', 'capability', 'event', 'other',
] as const;
const KNOWLEDGE_MODES = [
  'asserted', 'self_reported', 'heard', 'experienced', 'inferred', 'believed', 'suspected', 'unknown',
] as const;
const PRIVACY_LEVELS = ['public', 'limited', 'private', 'secret'] as const;

function fixedString(maxLength = 120): Record<string, unknown> {
  return { type: 'string', minLength: 0, maxLength };
}

function requiredString(maxLength = 120, minLength = 1): Record<string, unknown> {
  return { type: 'string', minLength, maxLength };
}

function stringArray(maxItems = 24, maxLength = 80): Record<string, unknown> {
  return { type: 'array', maxItems, uniqueItems: true, items: requiredString(maxLength) };
}

function sourceRefSchema(sourceRefs: readonly string[]): Record<string, unknown> {
  return {
    type: 'string',
    minLength: 1,
    maxLength: 180,
    description: '必须逐字复制 allowedSourceRefs 中的一个值。',
    ...(sourceRefs.length > 0 ? { enum: [...sourceRefs] } : {}),
  };
}

/**
 * Small fixed-shape schema. Optional business values are represented by an
 * empty string instead of nullable unions so weak OpenAI-compatible providers
 * have fewer ways to violate the contract. Machine timestamps are not model
 * fields at all.
 */
export function buildStructuredCaptureSchema(
  sourceRefs: readonly string[],
  evidenceDirectory?: SupportedEvidenceDirectory,
): object {
  const sourceRef = sourceRefSchema(sourceRefs);
  const evidenceSpanId = {
    type: 'string',
    minLength: 1,
    maxLength: 80,
    ...(evidenceDirectory?.spans.length
      ? { enum: evidenceDirectory.spans.map(span => span.evidenceSpanId) }
      : {}),
  };
  const localId = { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9_.:-]+$' };
  const actorCandidate = {
    type: 'object', additionalProperties: false,
    required: ['localId', 'displayName', 'aliases', 'evidenceSpanId', 'confidence'],
    properties: {
      localId,
      displayName: requiredString(80),
      aliases: stringArray(12, 80),
      evidenceSpanId,
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
  };
  const locationCandidate = {
    type: 'object', additionalProperties: false,
    required: ['localId', 'displayName', 'aliases', 'evidenceSpanId', 'confidence'],
    properties: {
      localId,
      displayName: requiredString(120),
      aliases: stringArray(12, 120),
      evidenceSpanId,
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
  };
  const episode = {
    type: 'object', additionalProperties: false,
    required: ['localId', 'sourceRefs', 'participantRefs', 'presentRefs', 'mentionedRefs', 'locationRef', 'storyTimeText', 'summary'],
    properties: {
      localId,
      sourceRefs: { type: 'array', minItems: 1, maxItems: 12, uniqueItems: true, items: sourceRef },
      participantRefs: stringArray(24, 80),
      presentRefs: stringArray(24, 80),
      mentionedRefs: stringArray(24, 80),
      locationRef: fixedString(120),
      storyTimeText: fixedString(120),
      summary: requiredString(800, 6),
    },
  };
  const knowledge = {
    type: 'object', additionalProperties: false,
    required: ['mode', 'privacy', 'ownerRefs', 'speakerRef', 'viewpointRef', 'observerRefs', 'presentRefs', 'mentionedRefs'],
    properties: {
      mode: { type: 'string', enum: [...KNOWLEDGE_MODES] },
      privacy: { type: 'string', enum: [...PRIVACY_LEVELS] },
      ownerRefs: stringArray(24, 80),
      speakerRef: fixedString(80),
      viewpointRef: fixedString(80),
      observerRefs: stringArray(24, 80),
      presentRefs: stringArray(24, 80),
      mentionedRefs: stringArray(24, 80),
    },
  };
  const claim = {
    type: 'object', additionalProperties: false,
    required: [
      'localId', 'episodeLocalId', 'kind', 'subjectRef', 'subjectText',
      'predicateKey', 'objectRef', 'objectText', 'content', 'evidenceSpanId', 'knowledge', 'confidence', 'stableAnchor',
    ],
    properties: {
      localId,
      episodeLocalId: fixedString(80),
      kind: { type: 'string', enum: [...FACT_KINDS] },
      subjectRef: fixedString(120),
      subjectText: fixedString(120),
      predicateKey: requiredString(120),
      objectRef: fixedString(120),
      objectText: fixedString(160),
      content: requiredString(280, 6),
      evidenceSpanId,
      knowledge,
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      stableAnchor: { type: 'boolean' },
    },
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['actorCandidates', 'locationCandidates', 'episodes', 'claims'],
    properties: {
      actorCandidates: { type: 'array', maxItems: 24, items: actorCandidate },
      locationCandidates: { type: 'array', maxItems: 24, items: locationCandidate },
      episodes: { type: 'array', maxItems: 16, items: episode },
      claims: { type: 'array', maxItems: 32, items: claim },
    },
  };
}

const optionalString = (value: string): string | undefined => value === '' ? undefined : value;

function copyKnowledge(value: StructuredClaimKnowledge & {
  speakerRef: string;
  viewpointRef: string;
}): StructuredClaimKnowledge {
  return {
    mode: value.mode,
    privacy: value.privacy,
    ownerRefs: [...value.ownerRefs],
    speakerRef: optionalString(value.speakerRef),
    viewpointRef: optionalString(value.viewpointRef),
    observerRefs: [...value.observerRefs],
    presentRefs: [...value.presentRefs],
    mentionedRefs: [...value.mentionedRefs],
  };
}

export function buildStructuredRepairSchema(
  sourceRefs: readonly string[],
  collection: 'actorCandidates' | 'locationCandidates' | 'episodes' | 'claims',
  maxItems: number,
  referenceDirectory?: import('./types').SupportedReferenceDirectory,
  evidenceDirectory?: SupportedEvidenceDirectory,
): object {
  const captureSchema = buildStructuredCaptureSchema(sourceRefs, evidenceDirectory) as {
    properties: Record<string, { items: object }>;
  };
  const itemSchema = structuredClone(captureSchema.properties[collection]?.items);
  if (!itemSchema) throw new Error(`未知的结构化修复集合：${collection}`);
  if (referenceDirectory && collection === 'episodes') {
    const properties = (itemSchema as { properties: Record<string, Record<string, unknown>> }).properties;
    const actorRefs = uniqueSchemaValues([
      ...referenceDirectory.allowedActorRefs.map(item => item.referenceId),
      'player', 'world', 'narrator',
    ]);
    for (const field of ['participantRefs', 'presentRefs', 'mentionedRefs']) {
      properties[field] = {
        ...properties[field],
        items: { type: 'string', enum: actorRefs },
      };
    }
    properties.locationRef = {
      type: 'string',
      enum: uniqueSchemaValues(['', ...referenceDirectory.allowedLocationRefs.map(item => item.referenceId)]),
    };
  }
  if (referenceDirectory && collection === 'claims') {
    const properties = (itemSchema as { properties: Record<string, Record<string, unknown>> }).properties;
    const actorRefs = uniqueSchemaValues([
      ...referenceDirectory.allowedActorRefs.map(item => item.referenceId),
      'player', 'world', 'narrator',
    ]);
    const entityRefs = uniqueSchemaValues([
      '', ...actorRefs, ...referenceDirectory.allowedLocationRefs.map(item => item.referenceId),
    ]);
    properties.subjectRef = { type: 'string', enum: entityRefs };
    properties.objectRef = { type: 'string', enum: entityRefs };
    properties.episodeLocalId = {
      type: 'string',
      enum: uniqueSchemaValues(['', ...referenceDirectory.allowedEpisodeRefs.map(item => item.referenceId)]),
    };
    const knowledge = properties.knowledge as {
      properties: Record<string, Record<string, unknown>>;
    };
    for (const field of ['ownerRefs', 'observerRefs', 'presentRefs', 'mentionedRefs']) {
      knowledge.properties[field] = {
        ...knowledge.properties[field],
        items: { type: 'string', enum: actorRefs },
      };
    }
    knowledge.properties.speakerRef = { type: 'string', enum: uniqueSchemaValues(['', ...actorRefs]) };
    knowledge.properties.viewpointRef = { type: 'string', enum: uniqueSchemaValues(['', ...actorRefs]) };
  }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        minItems: 1,
        maxItems: Math.min(10, Math.max(1, Math.trunc(maxItems))),
        items: itemSchema,
      },
    },
  };
}

function uniqueSchemaValues(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Decodes an already Schema-validated capture without repairing model output.
 * Empty strings are the only declared wire sentinel and map to optional domain
 * fields; every other value is copied exactly.
 */
export function normalizeStructuredCapture(
  value: unknown,
  sources: readonly SourceBlock[],
  evidenceDirectory?: SupportedEvidenceDirectory,
  responseMeta?: MemoryLlmMeta,
): StructuredCaptureResult {
  const responseContext = {
    ...(responseMeta?.requestId ? { requestId: responseMeta.requestId } : {}),
    ...(responseMeta?.parentRequestId ? { parentRequestId: responseMeta.parentRequestId } : {}),
    ...(responseMeta?.resourceId ? { resourceId: responseMeta.resourceId } : {}),
    ...(responseMeta?.model ? { model: responseMeta.model } : {}),
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw createSSHelperError('SCHEMA_VALIDATION_FAILED', {
      stage: 'memory.capture.map',
      path: '$',
      keyword: 'type',
      expected: 'object',
      ...responseContext,
    });
  }
  const row = value as {
    actorCandidates: Array<Omit<StructuredActorCandidate, 'evidenceExcerpt' | 'sourceRef'> & { evidenceSpanId: string }>;
    locationCandidates: Array<Omit<StructuredLocationCandidate, 'evidenceExcerpt' | 'sourceRef'> & { evidenceSpanId: string }>;
    episodes: Array<StructuredEpisode & { locationRef: string; storyTimeText: string }>;
    claims: Array<Omit<StructuredClaim, 'evidenceExcerpt' | 'sourceRef'> & {
      evidenceSpanId: string;
      episodeLocalId: string;
      subjectRef: string;
      subjectText: string;
      objectRef: string;
      objectText: string;
      knowledge: StructuredClaimKnowledge & { speakerRef: string; viewpointRef: string };
    }>;
  };
  if (![row.actorCandidates, row.locationCandidates, row.episodes, row.claims].every(Array.isArray)) {
    throw createSSHelperError('SCHEMA_VALIDATION_FAILED', {
      stage: 'memory.capture.map',
      path: '$',
      keyword: 'required',
      expected: 'actorCandidates, locationCandidates, episodes, claims',
      ...responseContext,
    });
  }
  const evidenceRejections: AutomaticIngestRejection[] = [];
  const rejectEvidence = (
    collection: 'actorCandidates' | 'locationCandidates' | 'claims',
    recordType: 'actor' | 'location' | 'claim',
    index: number,
  ): void => {
    const path = `$.${collection}[${index}].evidenceSpanId`;
    const requestScope = responseMeta?.requestId
      ?? `${sources[0]?.chatKey ?? 'unknown'}:${evidenceDirectory?.evidenceSetHash ?? 'no-evidence'}`;
    evidenceRejections.push({
      id: `evidence:${requestScope}:${collection}:${index}`,
      index,
      code: 'schema_validation_failed',
      message: '证据片段不属于当前允许的闭集。',
      recordType,
      fieldPath: path,
      issues: [{ path, keyword: 'enum', expected: 'supported evidence span' }],
      sourceRefs: sources.map(source => source.id),
      ...responseContext,
      status: 'unresolved',
      repairAttempts: 0,
    });
  };
  const actorCandidates: StructuredActorCandidate[] = [];
  for (const [index, item] of row.actorCandidates.entries()) {
    const span = evidenceDirectory && evidenceSpanById(evidenceDirectory, item.evidenceSpanId);
    if (!span) {
      rejectEvidence('actorCandidates', 'actor', index);
      continue;
    }
    actorCandidates.push({
      localId: item.localId,
      displayName: item.displayName,
      aliases: [...item.aliases],
      sourceRef: span.sourceRef,
      evidenceExcerpt: span.text,
      confidence: item.confidence,
    });
  }
  const locationCandidates: StructuredLocationCandidate[] = [];
  for (const [index, item] of row.locationCandidates.entries()) {
    const span = evidenceDirectory && evidenceSpanById(evidenceDirectory, item.evidenceSpanId);
    if (!span) {
      rejectEvidence('locationCandidates', 'location', index);
      continue;
    }
    locationCandidates.push({
      localId: item.localId,
      displayName: item.displayName,
      aliases: [...item.aliases],
      sourceRef: span.sourceRef,
      evidenceExcerpt: span.text,
      confidence: item.confidence,
    });
  }
  const claims: StructuredClaim[] = [];
  for (const [index, item] of row.claims.entries()) {
    const span = evidenceDirectory && evidenceSpanById(evidenceDirectory, item.evidenceSpanId);
    if (!span) {
      rejectEvidence('claims', 'claim', index);
      continue;
    }
    claims.push({
      localId: item.localId,
      sourceRef: span.sourceRef,
      episodeLocalId: optionalString(item.episodeLocalId),
      kind: item.kind,
      subjectRef: optionalString(item.subjectRef),
      subjectText: optionalString(item.subjectText),
      predicateKey: item.predicateKey,
      objectRef: optionalString(item.objectRef),
      objectText: optionalString(item.objectText),
      content: item.content,
      evidenceExcerpt: span.text,
      knowledge: copyKnowledge(item.knowledge),
      confidence: item.confidence,
      stableAnchor: item.stableAnchor,
    });
  }
  return {
    actorCandidates,
    locationCandidates,
    episodes: row.episodes.map(item => ({
      localId: item.localId,
      sourceRefs: [...item.sourceRefs],
      participantRefs: [...item.participantRefs],
      presentRefs: [...item.presentRefs],
      mentionedRefs: [...item.mentionedRefs],
      locationRef: optionalString(item.locationRef),
      storyTimeText: optionalString(item.storyTimeText),
      summary: item.summary,
    })),
    claims,
    ...(evidenceRejections.length > 0 ? { rejections: evidenceRejections } : {}),
    diagnostics: {
      parser: 'claim-json',
      deterministicRepairs: 0,
      schemaRepairCalls: 0,
      transportMode: 'json_object_validated',
    },
  };
}

function auditFromResponse(response: { meta?: MemoryLlmMeta; usage?: MemoryLlmUsage }): StructuredCaptureResult['audit'] {
  const tokenUsage: MemoryTokenUsage | null = response.usage ? {
    promptTokens: Number.isFinite(response.usage.promptTokens) ? response.usage.promptTokens : null,
    completionTokens: Number.isFinite(response.usage.completionTokens) ? response.usage.completionTokens : null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: Number.isFinite(response.usage.totalTokens) ? response.usage.totalTokens : null,
  } : null;
  return {
    ...(response.meta?.requestId ? { requestId: response.meta.requestId } : {}),
    ...(response.meta?.resourceId ? { resourceId: response.meta.resourceId } : {}),
    ...(response.meta?.model ? { model: response.meta.model } : {}),
    ...(Number.isFinite(response.meta?.latencyMs) ? { latencyMs: response.meta?.latencyMs } : {}),
    usage: tokenUsage,
  };
}

function systemPrompt(input: MemoryExtractionInput): string {
  return [
    '你是 SS-Helper 的多角色长期记忆 Claim 捕获器。只提取已经发生或已经明确成立、且对未来剧情有检索价值的内容。',
    '最终只返回一个 JSON 对象，固定包含 actorCandidates、locationCandidates、episodes、claims 四个数组。不要 Markdown，不要解释。',
    '只有 allowedSourceRefs 可以成为新记录证据；contextOnlySourceRefs 与 existingMemoryContext 只用于理解和去重。',
    'knownActors 与 knownLocations 是系统目录。所有人物和地点引用必须优先使用其中的 ref；简称、昵称、繁简写法不得创建重复候选。',
    '新人物必须具有持续身份、能独立行动、说话、思考或知情；“重构体”“表情的话”、物品、材料、食物、地点、状态和抽象概念都不是人物。',
    '新地点必须是可持续定位的场所，普通方位词“这里、外面、前方”不是地点。',
    '剧情选项、控制文本、状态栏标题、未来可能性和 OOC 指令不得作为已发生事件。cast_manifest 只用于人物目录；state_snapshot 只可产生当前状态 Claim。',
    '模型不得输出 Unix 时间、occurredAt、validFrom、validUntil、数据库 ID、Observation、Evidence、Trace，actorCandidate/locationCandidate/claim 也不得输出 sourceRef；这些全部由服务器根据 evidenceSpanId 确定性生成。',
    'episode 只描述事件容器；机器时间和楼层由服务器计算。storyTimeText 只保存“灾变第十八日黄昏”等剧情内时间。',
    'claim 是一个可独立检索的单一主张。数量、百分比、库存、位置、能力、弱点、目标、承诺、关系、状态变化必须分开输出。',
    '重大事件中的已下达命令、明确分工和已采用安全措施具有长期检索价值，必须提取。多名角色各自承担监控、保护、分析等任务时，应分别形成 event、goal 或 commitment Claim，不得因其发生在当前应对阶段而省略。',
    'predicateKey、subjectText、objectText 必须使用简洁的简体中文自然词，不要输出英文或 snake_case。',
    '数字必须忠实保留证据精度，不得把“百分之四十五”改写成“四十到五十”。同一批同一状态先出现估计值、后出现精确值时，必须输出后续精确 Claim。',
    'claim.subjectRef 与 objectRef 用于 knownActors、knownLocations 或本次候选 localId；普通物品、群体和规则使用 subjectText/objectText。subjectRef 和 subjectText 至少一个非空。明确人物关系必须填写 objectRef，不得只把人物姓名写进 objectText。',
    'actorCandidate、locationCandidate 和 claim 只选择 sourceBlocks 中已有的 evidenceSpanId，不得输出 sourceRef，不得复制、概括、翻译或自行补写证据。服务器会由 evidenceSpanId 确定性回填来源和原始证据正文。',
    '公开发言用 self_reported；明确在场的听者使用 observerRefs；内心独白仅归属 speakerRef 且 privacy 为 private/secret；传闻使用 believed/suspected。',
    '重复旧记忆不要输出；状态变化输出新的 Claim，服务器负责 supersede，不要删除或修改旧事实。',
    '无法确定的可选字符串必须输出空字符串，数组输出空数组；不得输出 null，不得新增字段。',
    ...(input.graphLlmRelationEnabled === true ? [
      '明确的主体—关系—客体应输出 relationship/location/world_rule/goal/commitment/capability/event Claim；不得只凭共现推断关系。',
    ] : []),
  ].join('\n');
}

export class StructuredMemoryCaptureExtractor {
  constructor(private readonly getLlm: () => MemoryLlmClient | null = readMemoryLlmClient) {}

  async extract(input: MemoryExtractionInput): Promise<StructuredCaptureResult> {
    const llm = this.getLlm();
    if (!llm) throw createSSHelperError('MEMORY_LLM_CLIENT_UNAVAILABLE', { stage: 'memory.capture.llm' });
    const sourceRefs = input.writableSourceRefs ?? input.sources.map(source => source.id);
    const evidenceDirectory = buildSupportedEvidenceDirectory(input.sources, sourceRefs);
    const schema = input.repair
      ? buildStructuredRepairSchema(
        sourceRefs,
        input.repair.collection,
        input.repair.maxItems,
        input.repair.referenceDirectory,
        evidenceDirectory,
      )
      : buildStructuredCaptureSchema(sourceRefs, evidenceDirectory);
    const repairInstruction = input.repair ? [
      input.repair.mode === 'conservative'
        ? '这是第二次且最后一次保守修复。只重新提取一个目标项目；可选字段没有直接证据时必须留空，引用数组只能保留 supportedReferences 中的成员。'
        : '这是第一次定向重新提取。只依据本次 sourceBlocks 重新生成一个目标项目；不要复用、猜测或补写上一轮失败 JSON。',
      `目标集合：${input.repair.collection}`,
      `修复次数：${input.repair.attempt ?? 1}/${input.repair.maxAttempts ?? 2}`,
      `安全校验问题：${safeJson(input.repair.issues.slice(0, 16))}`,
      'supportedReferences 是当前字段唯一允许使用的闭集。必须逐字复制 ref；目录外实体不得引用或猜测，无法确认时字符串用空字符串、数组用空数组。',
      '只返回 {"items":[...]}，items 中只允许出现目标集合对应的项目。',
    ].join('\n') : '';
    const response = await llm.runTask<unknown>({
      consumer: MEMORY_PLUGIN_ID,
      taskKey: input.repair ? MEMORY_CAPTURE_REPAIR_TASK : MEMORY_CAPTURE_TASK,
      taskDescription: input.repair ? '局部结构化捕获修复' : '多角色事件与 Claim 捕获',
      taskKind: 'generation',
      input: { messages: [
        { role: 'system', content: input.repair ? `${systemPrompt(input)}\n${repairInstruction}` : systemPrompt(input) },
        { role: 'user', content: serializeExtractionInput(input, evidenceDirectory) },
      ] },
      schema,
      budget: { maxTokens: input.repair ? 2_048 : MEMORY_CAPTURE_MAX_TOKENS, maxLatencyMs: 180_000 },
      enqueue: { displayMode: 'compact' },
      ...(input.repair?.parentRequestId ? { parentRequestId: input.repair.parentRequestId } : {}),
      ...(input.repair && (input.repair.resourceId || input.repair.model) ? {
        route: {
          ...(input.repair.resourceId ? { resourceId: input.repair.resourceId } : {}),
          ...(input.repair.model ? { model: input.repair.model } : {}),
        },
      } : {}),
    });
    if (!response.ok) {
      throw createSSHelperError(
        response.failure.reasonCode,
        {
          ...response.failure,
          stage: response.failure.stage || (input.repair ? 'memory.repair.llm' : 'memory.capture.llm'),
        },
      );
    }
    const writable = new Set(sourceRefs);
    const normalizedData = input.repair
      ? {
        actorCandidates: input.repair.collection === 'actorCandidates' ? (response.data as { items?: unknown[] })?.items ?? [] : [],
        locationCandidates: input.repair.collection === 'locationCandidates' ? (response.data as { items?: unknown[] })?.items ?? [] : [],
        episodes: input.repair.collection === 'episodes' ? (response.data as { items?: unknown[] })?.items ?? [] : [],
        claims: input.repair.collection === 'claims' ? (response.data as { items?: unknown[] })?.items ?? [] : [],
      }
      : response.data;
    const capture = normalizeStructuredCapture(
      normalizedData,
      input.sources.filter(source => writable.has(source.id)),
      evidenceDirectory,
      response.meta,
    );
    const schemaRejections = (response.meta?.itemRejections ?? []).map((item, index) => ({
      id: `schema:${response.meta?.requestId ?? 'unknown'}:${item.collection}:${item.itemIndex}:${index}`,
      index: item.itemIndex,
      code: 'schema_validation_failed' as const,
      message: `结构化项目未通过 Schema：${item.issues.map(issue => `${issue.path} ${issue.keyword} expected ${issue.expected}`).join('; ')}`,
      recordType: item.collection === 'actorCandidates' ? 'actor' as const
        : item.collection === 'locationCandidates' ? 'location' as const
          : item.collection === 'episodes' ? 'episode' as const
            : item.collection === 'claims' ? 'claim' as const
              : 'batch' as const,
      ...(item.issues[0]?.path ? { fieldPath: item.issues[0].path } : {}),
      issues: item.issues.map(issue => ({
        path: issue.path,
        keyword: issue.keyword,
        expected: issue.expected,
      })),
      sourceRefs: [...item.sourceRefs],
      ...(response.meta?.requestId ? { requestId: response.meta.requestId } : {}),
      ...(response.meta?.parentRequestId ? { parentRequestId: response.meta.parentRequestId } : {}),
      ...(response.meta?.resourceId ? { resourceId: response.meta.resourceId } : {}),
      ...(response.meta?.model ? { model: response.meta.model } : {}),
      status: 'unresolved' as const,
      repairAttempts: 0,
    }));
    return {
      ...capture,
      rejections: [...(capture.rejections ?? []), ...schemaRejections],
      diagnostics: {
        ...capture.diagnostics,
        schemaRepairCalls: response.meta?.repairCount ?? 0,
        transportMode: 'json_object_validated',
      },
      audit: auditFromResponse(response),
    };
  }
}
