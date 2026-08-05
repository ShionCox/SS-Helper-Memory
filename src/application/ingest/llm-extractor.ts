import type { AutomaticIngestRejection, MemoryTokenUsage } from '../../domain';
import {
  createSSHelperError,
  type LlmTaskRouteSetRequest,
  type LlmTaskStatusSnapshot,
  type LlmResourceCapabilityVerifyResponse,
  type LlmToolTurnRequest,
  type LlmToolTurnResponse,
  type LlmWorkflowTrace,
  type SSHelperFailureContext,
} from '@ss-helper/sdk';
import type {
  MemoryExtractionInput,
  SourceBlock,
  StructuredActorCandidate,
  StructuredCaptureResult,
  StructuredClaim,
  StructuredClaimKnowledge,
  StructuredEpisode,
  StructuredInventoryOperation,
  StructuredItemCandidate,
  StructuredLocationCandidate,
} from './types';
import {
  buildSupportedEvidenceDirectory,
  evidenceSpanById,
  type SupportedEvidenceDirectory,
} from './supported-evidence-directory';
import { EXTRACTION_STAGE_SPECS, MEMORY_EXTRACTION_TASK_KEYS } from '../extraction/extraction-stage-specs';
import { stageSystemPrompt } from '../extraction/extraction-stage-prompts';
import type { ExtractionStageKey } from '../extraction/extraction-types';

export const MEMORY_PLUGIN_ID = 'stx_memory';
export const MEMORY_EMBED_TASK = 'memory_embed';
export const MEMORY_RERANK_TASK = 'memory_rerank';

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
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

function reportedToken(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function memoryLlmUsageFromProvider(
  value: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined,
): MemoryLlmUsage | undefined {
  if (!value) return undefined;
  return {
    promptTokens: reportedToken(value.inputTokens),
    completionTokens: reportedToken(value.outputTokens),
    totalTokens: reportedToken(value.totalTokens),
  };
}

export function memoryLlmUsageFromError(error: unknown): MemoryLlmUsage | undefined {
  const source = error && typeof error === 'object' && !Array.isArray(error) ? error as Record<string, unknown> : {};
  const details = source.details && typeof source.details === 'object' && !Array.isArray(source.details)
    ? source.details as Record<string, unknown>
    : {};
  const inputTokens = reportedToken(details.inputTokens);
  const outputTokens = reportedToken(details.outputTokens);
  const totalTokens = reportedToken(details.totalTokens);
  return inputTokens === null && outputTokens === null && totalTokens === null
    ? undefined
    : { promptTokens: inputTokens, completionTokens: outputTokens, totalTokens };
}

export function mergeMemoryLlmUsage(
  current: MemoryLlmUsage | undefined,
  incoming: MemoryLlmUsage | undefined,
): MemoryLlmUsage | undefined {
  if (!incoming) return current;
  const add = (left: number | null | undefined, right: number | null): number | null =>
    right === null ? left ?? null : left === null || left === undefined ? right : left + right;
  return {
    promptTokens: add(current?.promptTokens, incoming.promptTokens),
    completionTokens: add(current?.completionTokens, incoming.completionTokens),
    totalTokens: add(current?.totalTokens, incoming.totalTokens),
  };
}

export type MemoryLlmFailure = {
  ok: false;
  failure: SSHelperFailureContext;
  retryable?: boolean;
  fallbackUsed?: boolean;
  meta?: MemoryLlmMeta;
  usage?: MemoryLlmUsage;
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
    budget: { maxTokens?: number; maxLatencyMs?: number };
    enqueue: { displayMode: 'compact' | 'silent' };
    route?: { resourceId?: string };
    parentRequestId?: string;
    trace?: LlmWorkflowTrace;
    signal?: AbortSignal;
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
    usage?: MemoryLlmUsage;
  }>;
  embed?(input: {
    consumer: string;
    taskKey: string;
    taskDescription?: string;
    texts: string[];
    budget?: { maxLatencyMs?: number };
    enqueue?: { displayMode: 'compact' | 'silent' };
    trace?: LlmWorkflowTrace;
    workflowStage?: 'memory_embed_query' | 'memory_embed_index';
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
    trace?: LlmWorkflowTrace;
  }): Promise<MemoryRerankResult>;
  toolTurn?(input: LlmToolTurnRequest, signal?: AbortSignal): Promise<LlmToolTurnResponse>;
  cancelToolSession?(toolSessionId: string, reason?: 'cancelled' | 'chat_changed' | 'pipeline_disposed'): Promise<void>;
  inspect?: {
    previewRoute(input: {
      consumer: string;
      taskKey: string;
      taskKind: MemoryLlmTaskKind;
      requiredCapabilities?: string[];
    }): Promise<{ available?: boolean; resourceId?: string; model?: string; verifiedMaxBatchInputs?: 8 | 16 | 32; failure?: SSHelperFailureContext }> | { available?: boolean; resourceId?: string; model?: string; verifiedMaxBatchInputs?: 8 | 16 | 32; failure?: SSHelperFailureContext };
    getTaskStatus?(taskKeys?: readonly string[]): Promise<LlmTaskStatusSnapshot>;
    setTaskRoute?(input: LlmTaskRouteSetRequest): Promise<LlmTaskStatusSnapshot>;
    verifyResourceCapability?(input: { readonly resourceId: string; readonly taskKeys?: readonly string[]; readonly force?: boolean }): Promise<LlmResourceCapabilityVerifyResponse>;
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
  /** Monotonic LLM task-state revision used to invalidate query caches. */
  routeRevision?: number;
  verifiedMaxBatchInputs?: 8 | 16 | 32;
  failure?: SSHelperFailureContext;
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
  if (!llm) return {
    available: false,
    failure: { reasonCode: 'MEMORY_LLM_CLIENT_UNAVAILABLE', stage: 'memory.routing.inspect' },
  };
  if (!llm.inspect?.previewRoute) return {
    available: false,
    failure: { reasonCode: 'LLM_TASK_UNSUPPORTED', stage: 'memory.routing.inspect' },
  };
  const route = await readRouteWithDeadline(() => llm.inspect!.previewRoute({
    consumer: MEMORY_PLUGIN_ID,
    taskKey,
    taskKind,
    requiredCapabilities,
  }));
  if (!route || typeof route !== 'object') return {
    available: false,
    failure: { reasonCode: 'BUS_REQUEST_TIMEOUT', stage: 'memory.routing.inspect' },
  };
  const available = route.available === true
    || (route.available === undefined && !route.failure && Boolean(route.resourceId || route.model));
  return {
    available,
    ...(route.resourceId ? { resourceId: route.resourceId } : {}),
    ...(route.model ? { model: route.model } : {}),
    ...(route.verifiedMaxBatchInputs === 8 || route.verifiedMaxBatchInputs === 16 || route.verifiedMaxBatchInputs === 32
      ? { verifiedMaxBatchInputs: route.verifiedMaxBatchInputs } : {}),
    ...(route.failure ? { failure: route.failure } : {}),
  };
}

export async function readMemoryLlmRouteDiagnostic(): Promise<MemoryLlmRouteDiagnostic> {
  return readRouteDiagnostic(MEMORY_EXTRACTION_TASK_KEYS.single, 'generation', ['chat', 'json']);
}

export async function readMemoryRecallRouteDiagnostics(): Promise<MemoryRecallRouteDiagnostics> {
  const [embedding, rerank] = await Promise.all([
    (async (): Promise<MemoryLlmRouteDiagnostic> => {
      const base = await readRouteDiagnostic(MEMORY_EMBED_TASK, 'embedding', ['embeddings']);
      const llm = readMemoryLlmClient();
      if (!llm?.inspect?.getTaskStatus || !base.available) return base;
      try {
        const snapshot = await readRouteWithDeadline(() => llm.inspect!.getTaskStatus!([MEMORY_EMBED_TASK]));
        const entry = snapshot?.tasks.find(item => item.taskKey === MEMORY_EMBED_TASK);
        const resource = entry?.resourceId ? snapshot?.resources.find(item => item.resourceId === entry.resourceId) : undefined;
        return {
          ...base,
          ...(typeof snapshot?.revision === 'number' ? { routeRevision: snapshot.revision } : {}),
          ...(resource?.embeddingCapabilities?.verifiedMaxBatchInputs
            ? { verifiedMaxBatchInputs: resource.embeddingCapabilities.verifiedMaxBatchInputs } : {}),
        };
      } catch { return base; }
    })(),
    readRouteDiagnostic(MEMORY_RERANK_TASK, 'rerank', ['rerank']),
  ]);
  return { embedding, rerank };
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&]/g, character => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' })[character]!);
}

export function serializeExtractionInput(input: MemoryExtractionInput, evidenceDirectory: SupportedEvidenceDirectory): string {
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
    knownInventory: (input.knownInventoryContext ?? []).map(item => ({
      ref: item.referenceId,
      canonicalName: item.canonicalName,
      aliases: item.aliases,
      category: item.category,
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
  const itemCandidate = {
    type: 'object', additionalProperties: false,
    required: ['localId', 'displayName', 'aliases', 'category', 'evidenceSpanId', 'confidence'],
    properties: {
      localId,
      displayName: requiredString(120),
      aliases: stringArray(12, 120),
      category: { type: 'string', enum: ['weapon', 'medicine', 'food', 'armor', 'special', 'core', 'material', 'other'] },
      evidenceSpanId,
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
  };
  const episode = {
    type: 'object', additionalProperties: false,
    required: ['localId', 'evidenceSpanIds', 'participantRefs', 'presentRefs', 'mentionedRefs', 'locationRef', 'storyTimeText', 'summary'],
    properties: {
      localId,
      evidenceSpanIds: { type: 'array', minItems: 1, maxItems: 12, uniqueItems: true, items: evidenceSpanId },
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
  const inventoryOperation = {
    type: 'object', additionalProperties: false,
    required: ['localId', 'itemRef', 'operation', 'measureKind', 'amount', 'rawAmount', 'unit', 'precision', 'reason', 'evidenceSpanId', 'confidence'],
    properties: {
      localId,
      itemRef: requiredString(120),
      operation: { type: 'string', enum: ['set', 'increase', 'decrease', 'remove'] },
      measureKind: { type: 'string', enum: ['quantity', 'coverage_days'] },
      amount: { type: 'number', minimum: 0 },
      rawAmount: fixedString(40),
      unit: fixedString(20),
      precision: { type: 'string', enum: ['exact', 'approximate', 'unknown'] },
      reason: { type: 'string', enum: ['acquire', 'consume', 'discard', 'lose', 'recount', 'manual_correction', 'other'] },
      evidenceSpanId,
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['actorCandidates', 'locationCandidates', 'itemCandidates', 'episodes', 'claims', 'inventoryOperations'],
    properties: {
      actorCandidates: { type: 'array', maxItems: 24, items: actorCandidate },
      locationCandidates: { type: 'array', maxItems: 24, items: locationCandidate },
      itemCandidates: { type: 'array', maxItems: 40, items: itemCandidate },
      episodes: { type: 'array', maxItems: 16, items: episode },
      claims: { type: 'array', maxItems: 32, items: claim },
      inventoryOperations: { type: 'array', maxItems: 48, items: inventoryOperation },
    },
  };
}

export function buildExtractionStageSchema(
  stage: Exclude<ExtractionStageKey, 'repair'>,
  sourceRefs: readonly string[],
  evidenceDirectory?: SupportedEvidenceDirectory,
): object {
  const full = buildStructuredCaptureSchema(sourceRefs, evidenceDirectory) as {
    readonly type: 'object';
    readonly additionalProperties: false;
    readonly properties: Readonly<Record<string, object>>;
  };
  if (stage === 'single') return full;
  const owned = EXTRACTION_STAGE_SPECS[stage].ownedCollections;
  return {
    type: 'object',
    additionalProperties: false,
    required: [...owned],
    properties: Object.fromEntries(owned.map(collection => [collection, full.properties[collection]])),
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
  collection: 'actorCandidates' | 'locationCandidates' | 'itemCandidates' | 'episodes' | 'claims' | 'inventoryOperations',
  maxItems: number,
  referenceDirectory?: import('./types').SupportedReferenceDirectory,
  evidenceDirectory?: SupportedEvidenceDirectory,
  repairIds: readonly string[] = ['repair-item-1'],
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
  const allowedRepairIds = uniqueSchemaValues(repairIds.map(value => value.trim()).filter(Boolean));
  if (allowedRepairIds.length === 0) allowedRepairIds.push('repair-item-1');
  return {
    type: 'object',
    additionalProperties: false,
    required: ['decisions'],
    properties: {
      decisions: {
        type: 'array',
        minItems: 1,
        maxItems: Math.min(10, Math.max(1, Math.min(Math.trunc(maxItems), allowedRepairIds.length))),
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['repairId', 'action', 'items'],
          properties: {
            repairId: { type: 'string', enum: allowedRepairIds },
            action: { type: 'string', enum: ['emit', 'drop'] },
            items: {
              type: 'array',
              minItems: 0,
              maxItems: 1,
              items: itemSchema,
            },
          },
        },
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
    itemCandidates: Array<Omit<StructuredItemCandidate, 'evidenceExcerpt' | 'sourceRef'> & { evidenceSpanId: string }>;
    episodes: Array<Omit<StructuredEpisode, 'sourceRefs'> & { locationRef: string; storyTimeText: string }>;
    claims: Array<Omit<StructuredClaim, 'evidenceExcerpt' | 'sourceRef'> & {
      evidenceSpanId: string;
      episodeLocalId: string;
      subjectRef: string;
      subjectText: string;
      objectRef: string;
      objectText: string;
      knowledge: StructuredClaimKnowledge & { speakerRef: string; viewpointRef: string };
    }>;
    inventoryOperations: Array<Omit<StructuredInventoryOperation, 'evidenceExcerpt' | 'sourceRef' | 'amount' | 'rawAmount'> & {
      evidenceSpanId: string;
      amount: number;
      rawAmount: string;
    }>;
  };
  if (![row.actorCandidates, row.locationCandidates, row.itemCandidates, row.episodes, row.claims, row.inventoryOperations].every(Array.isArray)) {
    throw createSSHelperError('SCHEMA_VALIDATION_FAILED', {
      stage: 'memory.capture.map',
      path: '$',
      keyword: 'required',
      expected: 'actorCandidates, locationCandidates, itemCandidates, episodes, claims, inventoryOperations',
      ...responseContext,
    });
  }
  const evidenceRejections: AutomaticIngestRejection[] = [];
  const rejectEvidence = (
    collection: 'actorCandidates' | 'locationCandidates' | 'itemCandidates' | 'episodes' | 'claims' | 'inventoryOperations',
    recordType: 'actor' | 'location' | 'item' | 'episode' | 'claim' | 'inventory',
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
  const itemCandidates: StructuredItemCandidate[] = [];
  for (const [index, item] of row.itemCandidates.entries()) {
    const span = evidenceDirectory && evidenceSpanById(evidenceDirectory, item.evidenceSpanId);
    if (!span) {
      rejectEvidence('itemCandidates', 'item', index);
      continue;
    }
    itemCandidates.push({
      localId: item.localId,
      displayName: item.displayName,
      aliases: [...item.aliases],
      category: item.category,
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
  const inventoryOperations: StructuredInventoryOperation[] = [];
  for (const [index, item] of row.inventoryOperations.entries()) {
    const span = evidenceDirectory && evidenceSpanById(evidenceDirectory, item.evidenceSpanId);
    if (!span) {
      rejectEvidence('inventoryOperations', 'inventory', index);
      continue;
    }
    inventoryOperations.push({
      localId: item.localId,
      itemRef: item.itemRef,
      operation: item.operation,
      measureKind: item.measureKind,
      ...(item.operation === 'remove' || item.precision === 'unknown' ? {} : { amount: item.amount }),
      ...(item.rawAmount === '' ? {} : { rawAmount: item.rawAmount }),
      unit: item.unit,
      precision: item.precision,
      reason: item.reason,
      sourceRef: span.sourceRef,
      evidenceExcerpt: span.text,
      confidence: item.confidence,
    });
  }
  const episodes: StructuredEpisode[] = [];
  for (const [index, item] of row.episodes.entries()) {
    const evidenceSpanIds = item.evidenceSpanIds ?? [];
    const spans = evidenceSpanIds.map(id => evidenceDirectory && evidenceSpanById(evidenceDirectory, id));
    if (spans.some(span => !span)) {
      rejectEvidence('episodes', 'episode', index);
      continue;
    }
    episodes.push({
      localId: item.localId,
      sourceRefs: [...new Set(spans.map(span => span!.sourceRef))],
      evidenceSpanIds: [...evidenceSpanIds],
      evidenceExcerpts: spans.map(span => span!.text),
      participantRefs: [...item.participantRefs],
      presentRefs: [...item.presentRefs],
      mentionedRefs: [...item.mentionedRefs],
      locationRef: optionalString(item.locationRef),
      storyTimeText: optionalString(item.storyTimeText),
      summary: item.summary,
    });
  }
  return {
    actorCandidates,
    locationCandidates,
    itemCandidates,
    episodes,
    claims,
    inventoryOperations,
    ...(evidenceRejections.length > 0 ? { rejections: evidenceRejections } : {}),
    diagnostics: {
      parser: 'claim-json',
      deterministicRepairs: 0,
      schemaRepairCalls: 0,
      transportMode: 'json_object_validated',
    },
  };
}

export function auditFromResponse(response: { meta?: MemoryLlmMeta; usage?: MemoryLlmUsage }): StructuredCaptureResult['audit'] {
  const tokenUsage: MemoryTokenUsage | null = response.usage ? {
    promptTokens: reportedToken(response.usage.promptTokens),
    completionTokens: reportedToken(response.usage.completionTokens),
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: reportedToken(response.usage.totalTokens),
  } : null;
  return {
    ...(response.meta?.requestId ? { requestId: response.meta.requestId } : {}),
    ...(response.meta?.resourceId ? { resourceId: response.meta.resourceId } : {}),
    ...(response.meta?.model ? { model: response.meta.model } : {}),
    ...(Number.isFinite(response.meta?.latencyMs) ? { latencyMs: response.meta?.latencyMs } : {}),
    ...(response.meta?.fallbackUsed === undefined ? {} : { fallbackUsed: response.meta.fallbackUsed }),
    usage: tokenUsage,
  };
}

export function systemPrompt(input: MemoryExtractionInput): string {
  return [
    '你是 SS-Helper 的多角色长期记忆 Claim 捕获器。只提取已经发生或已经明确成立、且对未来剧情有检索价值的内容。',
    '最终只返回一个符合当前固定阶段 Schema 的 JSON 对象；顶层字段以后续“固定阶段”规则为准。不要 Markdown，不要解释。',
    '只有 allowedSourceRefs 可以成为新记录证据；contextOnlySourceRefs 与 existingMemoryContext 只用于理解和去重。',
    'knownActors 与 knownLocations 是系统目录。所有人物和地点引用必须优先使用其中的 ref；简称、昵称、繁简写法不得创建重复候选。',
    '新人物必须具有持续身份、能独立行动、说话、思考或知情；“重构体”“表情的话”、物品、材料、食物、地点、状态和抽象概念都不是人物。',
    '新地点必须是可持续定位的场所，普通方位词“这里、外面、前方”不是地点。',
    'knownInventory 是只读的当前物品目录，只用于识别与去重，绝不能作为新数量证据。只有来源明确命名的物品才能输出操作。',
    '物品获得、消耗、盘点和移除写入 inventoryOperations，不要再输出重复的库存数量 Claim。新物品先输出 itemCandidates，并由 inventoryOperations.itemRef 引用其 localId。',
    'inventoryOperations.rawAmount 必须逐字出现在 evidenceSpanId 对应片段中；set 是绝对快照，increase/decrease 只用于明确增减，remove 只用于明确丢弃、耗尽或不再持有。',
    'coverage_days 只用于“可维持/天份”等资源覆盖期；剧情日期、经过天数和未来收获预测仍是普通事件或 Claim。约数和未知数只允许 set，不得做加减。',
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
    const stage: ExtractionStageKey = input.repair ? 'repair' : input.stage ?? 'single';
    const spec = EXTRACTION_STAGE_SPECS[stage];
    const schema = input.repair
      ? buildStructuredRepairSchema(
        sourceRefs,
        input.repair.collection,
        input.repair.maxItems,
        input.repair.referenceDirectory,
        evidenceDirectory,
        (input.repair.targets?.length ? input.repair.targets : [{ repairId: 'repair-item-1', issues: input.repair.issues }])
          .map(target => target.repairId),
      )
      : buildExtractionStageSchema(stage as Exclude<ExtractionStageKey, 'repair'>, sourceRefs, evidenceDirectory);
    const repairTargets = input.repair
      ? (input.repair.targets?.length ? input.repair.targets : [{ repairId: 'repair-item-1', issues: input.repair.issues }])
      : [];
    const repairInstruction = input.repair ? [
      input.repair.mode === 'conservative'
        ? '这是证据变化后的最后一次保守复核。可选字段没有直接证据时必须留空，引用数组只能保留 supportedReferences 中的成员。'
        : '这是第一次定向复核。只依据本次 sourceBlocks 重新提取；不要复用、猜测或补写上一轮失败 JSON。',
      `目标集合：${input.repair.collection}`,
      `修复次数：${input.repair.attempt ?? 1}/${input.repair.maxAttempts ?? 2}`,
      `复核目标：${safeJson(repairTargets.map(target => ({ repairId: target.repairId, issues: target.issues.slice(0, 16) })))}`,
      'supportedReferences 是当前字段唯一允许使用的闭集。必须逐字复制 ref；目录外实体不得引用或猜测，无法确认时字符串用空字符串、数组用空数组。',
      '每个 repairId 必须且只能返回一次 decision。原文足以支持一条合法记录时返回 action="emit" 且 items 恰好一项；证据不足或不应形成记忆时返回 action="drop" 且 items 为空。',
      '只返回 {"decisions":[{"repairId":"...","action":"emit|drop","items":[...]}]}，不要解释。',
    ].join('\n') : '';
    const response = await llm.runTask<unknown>({
      consumer: MEMORY_PLUGIN_ID,
      taskKey: spec.taskKey,
      taskDescription: spec.description,
      taskKind: 'generation',
      input: { messages: [
        { role: 'system', content: input.repair ? `${stageSystemPrompt(systemPrompt(input), 'repair', false)}\n${repairInstruction}` : stageSystemPrompt(systemPrompt(input), stage, false) },
        { role: 'user', content: serializeExtractionInput(input, evidenceDirectory) },
      ] },
      schema,
      budget: { maxLatencyMs: 600_000 },
      enqueue: { displayMode: 'compact' },
      ...(input.llmTrace ? { trace: input.llmTrace } : {}),
      ...(input.repair?.parentRequestId ? { parentRequestId: input.repair.parentRequestId } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    await input.onUsage?.(response.usage);
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
    const allowedRepairIds = new Set(repairTargets.map(target => target.repairId));
    const seenRepairIds = new Set<string>();
    const emittedLocalIds = new Set<string>();
    const repairDecisions: NonNullable<StructuredCaptureResult['repairDecisions']> = [];
    const emittedItems: unknown[] = [];
    if (input.repair) {
      const rows = Array.isArray((response.data as { decisions?: unknown[] })?.decisions)
        ? (response.data as { decisions: unknown[] }).decisions
        : [];
      for (const value of rows) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const decision = value as { repairId?: unknown; action?: unknown; items?: unknown };
        const repairId = typeof decision.repairId === 'string' ? decision.repairId : '';
        const items = Array.isArray(decision.items) ? decision.items : [];
        if (!allowedRepairIds.has(repairId) || seenRepairIds.has(repairId)) continue;
        if (decision.action === 'drop' && items.length === 0) {
          seenRepairIds.add(repairId);
          repairDecisions.push({ repairId, action: 'drop' });
          continue;
        }
        if (decision.action !== 'emit' || items.length !== 1) continue;
        const localId = items[0] && typeof items[0] === 'object' && !Array.isArray(items[0])
          ? String((items[0] as { localId?: unknown }).localId ?? '').trim()
          : '';
        if (!localId) continue;
        seenRepairIds.add(repairId);
        if (emittedLocalIds.has(localId)) {
          repairDecisions.push({ repairId, action: 'drop' });
          continue;
        }
        emittedLocalIds.add(localId);
        emittedItems.push(items[0]);
        repairDecisions.push({ repairId, action: 'emit', localId });
      }
    }
    const normalizedData = input.repair ? {
      actorCandidates: input.repair.collection === 'actorCandidates' ? emittedItems : [],
      locationCandidates: input.repair.collection === 'locationCandidates' ? emittedItems : [],
      itemCandidates: input.repair.collection === 'itemCandidates' ? emittedItems : [],
      episodes: input.repair.collection === 'episodes' ? emittedItems : [],
      claims: input.repair.collection === 'claims' ? emittedItems : [],
      inventoryOperations: input.repair.collection === 'inventoryOperations' ? emittedItems : [],
    } : stage === 'single' ? response.data : {
      actorCandidates: stage === 'entities' ? (response.data as { actorCandidates?: unknown }).actorCandidates ?? [] : [],
      locationCandidates: stage === 'entities' ? (response.data as { locationCandidates?: unknown }).locationCandidates ?? [] : [],
      itemCandidates: stage === 'content' ? (response.data as { itemCandidates?: unknown }).itemCandidates ?? [] : [],
      episodes: stage === 'content' ? (response.data as { episodes?: unknown }).episodes ?? [] : [],
      claims: stage === 'content' ? (response.data as { claims?: unknown }).claims ?? [] : [],
      inventoryOperations: stage === 'content' ? (response.data as { inventoryOperations?: unknown }).inventoryOperations ?? [] : [],
    };
    const capture = normalizeStructuredCapture(
      normalizedData,
      input.sources.filter(source => writable.has(source.id)),
      evidenceDirectory,
      response.meta,
    );
    const emittedMetadata = new Map<string, { itemIndex: number; sourceRefs: readonly string[] }>([
      ...capture.actorCandidates.map((item, itemIndex) => [item.localId, { itemIndex, sourceRefs: [item.sourceRef] }] as const),
      ...capture.locationCandidates.map((item, itemIndex) => [item.localId, { itemIndex, sourceRefs: [item.sourceRef] }] as const),
      ...(capture.itemCandidates ?? []).map((item, itemIndex) => [item.localId, { itemIndex, sourceRefs: [item.sourceRef] }] as const),
      ...capture.episodes.map((item, itemIndex) => [item.localId, { itemIndex, sourceRefs: [...item.sourceRefs] }] as const),
      ...capture.claims.map((item, itemIndex) => [item.localId, { itemIndex, sourceRefs: [item.sourceRef] }] as const),
      ...(capture.inventoryOperations ?? []).map((item, itemIndex) => [item.localId, { itemIndex, sourceRefs: [item.sourceRef] }] as const),
    ]);
    const verifiedRepairDecisions = repairDecisions.map((decision) => {
      if (decision.action !== 'emit') return decision;
      const metadata = emittedMetadata.get(decision.localId ?? '');
      return {
        ...decision,
        ...(metadata ? { itemIndex: metadata.itemIndex } : {}),
        sourceRefs: [...(metadata?.sourceRefs ?? [])],
      };
    });
    const schemaRejections = (response.meta?.itemRejections ?? []).map((item, index) => ({
      id: `schema:${response.meta?.requestId ?? 'unknown'}:${item.collection}:${item.itemIndex}:${index}`,
      index: item.itemIndex,
      code: 'schema_validation_failed' as const,
      message: `结构化项目未通过 Schema：${item.issues.map(issue => `${issue.path} ${issue.keyword} expected ${issue.expected}`).join('; ')}`,
      recordType: item.collection === 'actorCandidates' ? 'actor' as const
        : item.collection === 'locationCandidates' ? 'location' as const
          : item.collection === 'itemCandidates' ? 'item' as const
            : item.collection === 'episodes' ? 'episode' as const
              : item.collection === 'claims' ? 'claim' as const
                : item.collection === 'inventoryOperations' ? 'inventory' as const
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
      ...(input.repair ? { repairDecisions: verifiedRepairDecisions } : {}),
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
