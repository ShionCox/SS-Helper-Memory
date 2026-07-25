import type { MemoryTokenUsage } from '../../domain';
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

export const MEMORY_PLUGIN_ID = 'stx_memory';
export const MEMORY_CAPTURE_TASK = 'memory_capture';
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
}

function stableDiagnosticKey(value: string): string {
  let result = 2166136261;
  for (const character of value.normalize('NFKC')) {
    result ^= character.codePointAt(0) ?? 0;
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(36);
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
    budget: { maxTokens: number; maxLatencyMs?: number };
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

let configuredLlmApi: MemoryLlmApi | null = null;
export const MEMORY_LLM_ROUTE_DIAGNOSTIC_TIMEOUT_MS = 3_000;

export function configureMemoryLlmApi(api: MemoryLlmApi | null): void { configuredLlmApi = api; }
export function readMemoryLlmApi(): MemoryLlmApi | null { return configuredLlmApi; }

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
  readonly code: string;

  constructor(
    message: string,
    readonly details: { reasonCode?: string; resourceId?: string; model?: string } = {},
  ) {
    super(message);
    this.name = 'MemoryLlmTaskError';
    this.code = details.reasonCode?.toUpperCase() || 'MEMORY_LLM_TASK_FAILED';
  }
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
  const llm = readMemoryLlmApi();
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

function serializeExtractionInput(input: MemoryExtractionInput): string {
  const writableSourceRefs = [...new Set(input.writableSourceRefs ?? input.sources.map(source => source.id))];
  const writableSourceRefSet = new Set(writableSourceRefs);
  const actorRefMap = new Map<string, string>();
  for (const actor of input.knownActorContext ?? []) {
    for (const value of [actor.referenceId, actor.ownerId, actor.canonicalName, ...actor.aliases]) {
      if (value?.trim()) actorRefMap.set(value.trim(), actor.referenceId);
    }
  }
  const locationRefMap = new Map<string, string>();
  for (const location of input.knownLocationContext ?? []) {
    for (const value of [location.referenceId, location.locationId, location.canonicalName, ...location.aliases]) {
      if (value?.trim()) locationRefMap.set(value.trim(), location.referenceId);
    }
  }
  const mapActorRef = (value: string | undefined): string | undefined => value ? actorRefMap.get(value.trim()) : undefined;
  const mapLocationRef = (value: string | undefined): string | undefined => value ? locationRefMap.get(value.trim()) : undefined;
  return safeJson({
    allowedSourceRefs: writableSourceRefs,
    contextOnlySourceRefs: input.sources.map(source => source.id).filter(sourceRef => !writableSourceRefSet.has(sourceRef)),
    knownActors: (input.knownActorContext ?? []).map(actor => ({
      ref: actor.referenceId,
      canonicalName: actor.canonicalName,
      aliases: actor.aliases,
      status: actor.status,
    })),
    knownLocations: (input.knownLocationContext ?? []).map(location => ({
      ref: location.referenceId,
      canonicalName: location.canonicalName,
      aliases: location.aliases,
      status: location.status,
    })),
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
      content: source.content,
    })),
    ...(input.repairRequest ? { repairRequest: input.repairRequest } : {}),
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
export function buildStructuredCaptureSchema(sourceRefs: readonly string[]): object {
  const sourceRef = sourceRefSchema(sourceRefs);
  const localId = { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9_.:-]+$' };
  const actorCandidate = {
    type: 'object', additionalProperties: false,
    required: ['localId', 'displayName', 'aliases', 'sourceRef', 'evidenceExcerpt', 'confidence'],
    properties: {
      localId,
      displayName: requiredString(80),
      aliases: stringArray(12, 80),
      sourceRef,
      evidenceExcerpt: requiredString(800),
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
  };
  const locationCandidate = {
    type: 'object', additionalProperties: false,
    required: ['localId', 'displayName', 'aliases', 'sourceRef', 'evidenceExcerpt', 'confidence'],
    properties: {
      localId,
      displayName: requiredString(120),
      aliases: stringArray(12, 120),
      sourceRef,
      evidenceExcerpt: requiredString(800),
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
      'localId', 'sourceRef', 'episodeLocalId', 'kind', 'subjectRef', 'subjectText',
      'predicateKey', 'objectRef', 'objectText', 'content', 'evidenceExcerpt', 'knowledge', 'confidence', 'stableAnchor',
    ],
    properties: {
      localId,
      sourceRef,
      episodeLocalId: fixedString(80),
      kind: { type: 'string', enum: [...FACT_KINDS] },
      subjectRef: fixedString(120),
      subjectText: fixedString(120),
      predicateKey: requiredString(120),
      objectRef: fixedString(120),
      objectText: fixedString(160),
      content: requiredString(280, 6),
      evidenceExcerpt: requiredString(2_000),
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

function asRecords(input: unknown): Array<Record<string, unknown>> {
  return Array.isArray(input)
    ? input.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    : [];
}

function cleanString(value: unknown, maxLength: number): string {
  const cleaned = String(value ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f]/gu, '').trim();
  // Truncate by Unicode code points, not UTF-16 code units, so an astral CJK
  // character at the boundary cannot be split into an invalid lone surrogate.
  return Array.from(cleaned).slice(0, maxLength).join('');
}

function cleanArray(value: unknown, maxItems: number, maxLength: number): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map(item => cleanString(item, maxLength)).filter(Boolean))].slice(0, maxItems)
    : [];
}

function normalizeConfidence(value: unknown, fallback = 0.6): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'string' ? Number(value.trim().replace(/%$/u, '')) : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed > 1 && parsed <= 100 ? parsed / 100 : parsed));
}

function repairExactExcerpt(candidate: unknown, sourceRef: string, sources: readonly SourceBlock[], anchors: readonly unknown[]): string {
  const source = sources.find(item => item.id === sourceRef);
  if (!source) return cleanString(candidate, 2_000);
  const requested = cleanString(candidate, 2_000);
  if (requested && source.content.includes(requested)) return requested;
  // Do not replace a missing quote with a merely similar paragraph. That can
  // turn a hallucinated Claim into apparently exact evidence. Presentation-only
  // differences are repaired later by the server's unique punctuation-insensitive
  // locator; semantic/token-overlap guesses must remain rejected.
  void anchors;
  return requested;
}

function normalizeKnowledge(value: unknown): StructuredClaimKnowledge {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  // Missing/invalid epistemic metadata must fail closed. Treating malformed
  // output as asserted/public can broadcast a private or uncertain statement.
  const mode = KNOWLEDGE_MODES.includes(row.mode as never) ? row.mode as StructuredClaimKnowledge['mode'] : 'unknown';
  const privacy = PRIVACY_LEVELS.includes(row.privacy as never) ? row.privacy as StructuredClaimKnowledge['privacy'] : 'limited';
  return {
    mode,
    privacy,
    ownerRefs: cleanArray(row.ownerRefs, 24, 80),
    speakerRef: cleanString(row.speakerRef, 80) || undefined,
    viewpointRef: cleanString(row.viewpointRef ?? row.viewportRef, 80) || undefined,
    observerRefs: cleanArray(row.observerRefs, 24, 80),
    presentRefs: cleanArray(row.presentRefs, 24, 80),
    mentionedRefs: cleanArray(row.mentionedRefs, 24, 80),
  };
}

function normalizedActor(row: Record<string, unknown>, sources: readonly SourceBlock[]): StructuredActorCandidate {
  const sourceRef = cleanString(row.sourceRef ?? (Array.isArray(row.sourceRefs) ? row.sourceRefs[0] : ''), 180);
  const displayName = cleanString(row.displayName, 80);
  return {
    localId: cleanString(row.localId, 80),
    displayName,
    aliases: cleanArray(row.aliases, 12, 80),
    sourceRef,
    evidenceExcerpt: repairExactExcerpt(row.evidenceExcerpt ?? (Array.isArray(row.evidenceExcerpts) ? row.evidenceExcerpts[0] : ''), sourceRef, sources, [displayName]),
    confidence: normalizeConfidence(row.confidence, 0.35),
  };
}

function normalizedLocation(row: Record<string, unknown>, sources: readonly SourceBlock[]): StructuredLocationCandidate {
  const sourceRef = cleanString(row.sourceRef ?? (Array.isArray(row.sourceRefs) ? row.sourceRefs[0] : ''), 180);
  const displayName = cleanString(row.displayName, 120);
  return {
    localId: cleanString(row.localId, 80),
    displayName,
    aliases: cleanArray(row.aliases, 12, 120),
    sourceRef,
    evidenceExcerpt: repairExactExcerpt(row.evidenceExcerpt ?? (Array.isArray(row.evidenceExcerpts) ? row.evidenceExcerpts[0] : ''), sourceRef, sources, [displayName]),
    confidence: normalizeConfidence(row.confidence),
  };
}

function normalizedEpisode(row: Record<string, unknown>): StructuredEpisode {
  return {
    localId: cleanString(row.localId, 80),
    sourceRefs: cleanArray(row.sourceRefs ?? (row.sourceRef ? [row.sourceRef] : []), 12, 180),
    participantRefs: cleanArray(row.participantRefs, 24, 80),
    presentRefs: cleanArray(row.presentRefs, 24, 80),
    mentionedRefs: cleanArray(row.mentionedRefs, 24, 80),
    locationRef: cleanString(row.locationRef ?? row.location, 120) || undefined,
    storyTimeText: cleanString(row.storyTimeText ?? row.storyTime, 120) || undefined,
    summary: cleanString(row.summary ?? row.description ?? row.title, 800),
  };
}

function normalizedClaim(row: Record<string, unknown>, sources: readonly SourceBlock[]): StructuredClaim {
  const sourceRef = cleanString(row.sourceRef ?? (Array.isArray(row.sourceRefs) ? row.sourceRefs[0] : ''), 180);
  const subjectRef = cleanString(row.subjectRef, 120);
  const subjectText = cleanString(row.subjectText ?? row.subjectKey, 120);
  const predicateKey = cleanString(row.predicateKey, 120);
  const objectRef = cleanString(row.objectRef, 120);
  const objectText = cleanString(row.objectText ?? row.objectKey, 160);
  const content = cleanString(row.content, 280);
  const rawKind = cleanString(row.kind, 40);
  const kindAliases: Readonly<Record<string, StructuredClaim['kind']>> = {
    action: 'event', plan: 'goal', emotion: 'state', trait: 'other', ability: 'capability', rule: 'world_rule',
  };
  // Preserve an unknown value so the server validator can audit invalid_enum;
  // silently coercing arbitrary labels to `other` hides provider/schema bugs.
  const kind = FACT_KINDS.includes(rawKind as never)
    ? rawKind as StructuredClaim['kind']
    : kindAliases[rawKind] ?? rawKind as StructuredClaim['kind'];
  return {
    localId: cleanString(row.localId, 80),
    sourceRef,
    episodeLocalId: cleanString(row.episodeLocalId, 80) || undefined,
    kind,
    subjectRef: subjectRef || undefined,
    subjectText: subjectText || undefined,
    predicateKey,
    objectRef: objectRef || undefined,
    objectText: objectText || undefined,
    content,
    evidenceExcerpt: repairExactExcerpt(row.evidenceExcerpt, sourceRef, sources, [subjectText, predicateKey, objectText, content]),
    knowledge: normalizeKnowledge(row.knowledge ?? row),
    confidence: normalizeConfidence(row.confidence),
    stableAnchor: row.stableAnchor === true || row.stable === true,
  };
}

export function normalizeStructuredCapture(value: unknown, sources: readonly SourceBlock[]): StructuredCaptureResult {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const allActorCandidates = asRecords(row.actorCandidates);
  const allLocationCandidates = asRecords(row.locationCandidates);
  const allEpisodes = asRecords(row.episodes);
  const allClaims = asRecords(row.claims);
  const limits = { actorCandidates: 24, locationCandidates: 24, episodes: 16, claims: 32 } as const;
  const overflowRejections: NonNullable<StructuredCaptureResult['rejections']> = [];
  for (const [field, values] of Object.entries({
    actorCandidates: allActorCandidates,
    locationCandidates: allLocationCandidates,
    episodes: allEpisodes,
    claims: allClaims,
  }) as Array<[keyof typeof limits, Array<Record<string, unknown>>]>) {
    const limit = limits[field];
    if (values.length <= limit) continue;
    overflowRejections.push({
      id: `capture-schema-overflow:${field}:${stableDiagnosticKey(sources.map(source => source.id).join('|'))}:${values.length}`,
      index: -1,
      recordType: 'batch',
      code: 'invalid_shape',
      fieldPath: field,
      message: `${field} 输出 ${values.length} 条，超过单批上限 ${limit}；仅处理前 ${limit} 条并将本批标记为部分完成。`,
      sourceRefs: sources.map(source => source.id),
      candidateSnapshot: { field, actual: values.length, maximum: limit },
      status: 'unresolved',
      repairAttempts: 0,
    });
  }
  const rawActorCandidates = allActorCandidates.slice(0, limits.actorCandidates);
  const rawLocationCandidates = allLocationCandidates.slice(0, limits.locationCandidates);
  const rawEpisodes = allEpisodes.slice(0, limits.episodes);
  const rawClaims = allClaims.slice(0, limits.claims);
  const actorCandidates = rawActorCandidates.map(item => normalizedActor(item, sources));
  const locationCandidates = rawLocationCandidates.map(item => normalizedLocation(item, sources));
  const episodes = rawEpisodes.map(normalizedEpisode);
  const claims = rawClaims.map(item => normalizedClaim(item, sources));
  const normalizedShape = { actorCandidates, locationCandidates, episodes, claims };
  let deterministicRepairs = 0;
  try {
    if (JSON.stringify(normalizedShape) !== JSON.stringify({
      actorCandidates: row.actorCandidates ?? [],
      locationCandidates: row.locationCandidates ?? [],
      episodes: row.episodes ?? [],
      claims: row.claims ?? [],
    })) deterministicRepairs = 1;
  } catch { deterministicRepairs = 1; }
  return {
    ...normalizedShape,
    ...(overflowRejections.length > 0 ? { rejections: overflowRejections } : {}),
    diagnostics: {
      parser: 'claim-json',
      deterministicRepairs,
      automaticRepairCalls: 0,
      automaticallyRepaired: 0,
      firstPassRejections: 0,
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

function systemPrompt(input: MemoryExtractionInput, retryInstruction = ''): string {
  return [
    '你是 SS-Helper 的多角色长期记忆 Claim 捕获器。只提取已经发生或已经明确成立、且对未来剧情有检索价值的内容。',
    '最终只返回一个 JSON 对象，固定包含 actorCandidates、locationCandidates、episodes、claims 四个数组。不要 Markdown，不要解释。',
    '只有 allowedSourceRefs 可以成为新记录证据；contextOnlySourceRefs 与 existingMemoryContext 只用于理解和去重。',
    'knownActors 与 knownLocations 是系统目录。所有人物和地点引用必须优先使用其中的 ref；简称、昵称、繁简写法不得创建重复候选。',
    '新人物必须具有持续身份、能独立行动、说话、思考或知情；“重构体”“表情的话”、物品、材料、食物、地点、状态和抽象概念都不是人物。',
    '新地点必须是可持续定位的场所，普通方位词“这里、外面、前方”不是地点。',
    '剧情选项、控制文本、状态栏标题、未来可能性和 OOC 指令不得作为已发生事件。cast_manifest 只用于人物目录；state_snapshot 只可产生当前状态 Claim。',
    '模型不得输出 Unix 时间、occurredAt、validFrom、validUntil、数据库 ID、Observation、Evidence 或 Trace；这些全部由服务器根据 sourceRef 确定性生成。',
    'episode 只描述事件容器；机器时间和楼层由服务器计算。storyTimeText 只保存“灾变第十八日黄昏”等剧情内时间。',
    'claim 是一个可独立检索的单一主张。数量、百分比、库存、位置、能力、弱点、目标、承诺、关系、状态变化必须分开输出。',
    '重大事件中的已下达命令、明确分工和已采用安全措施具有长期检索价值，必须提取。多名角色各自承担监控、保护、分析等任务时，应分别形成 event、goal 或 commitment Claim，不得因其发生在当前应对阶段而省略。',
    'predicateKey、subjectText、objectText 必须使用简洁的简体中文自然词，不要输出英文或 snake_case。',
    '数字必须忠实保留证据精度，不得把“百分之四十五”改写成“四十到五十”。同一批同一状态先出现估计值、后出现精确值时，必须输出后续精确 Claim。',
    'claim.subjectRef 与 objectRef 用于 knownActors、knownLocations 或本次候选 localId；普通物品、群体和规则使用 subjectText/objectText。subjectRef 和 subjectText 至少一个非空。明确人物关系必须填写 objectRef，不得只把人物姓名写进 objectText。',
    'evidenceExcerpt 必须逐字复制 sourceRef 对应正文的一段连续原文；不得概括、翻译或从旧记忆补证据。',
    '公开发言用 self_reported；明确在场的听者使用 observerRefs；内心独白仅归属 speakerRef 且 privacy 为 private/secret；传闻使用 believed/suspected。',
    '重复旧记忆不要输出；状态变化输出新的 Claim，服务器负责 supersede，不要删除或修改旧事实。',
    '无法确定的可选字符串必须输出空字符串，数组输出空数组；不得输出 null，不得新增字段。',
    ...(input.graphLlmRelationEnabled === true ? [
      '明确的主体—关系—客体应输出 relationship/location/world_rule/goal/commitment/capability/event Claim；不得只凭共现推断关系。',
    ] : []),
    ...(input.repairRequest ? [
      '这是一次自动定向修复。只输出 repairRequest.items 中列出的 localId 与 recordType，已通过的记录不得重新输出；其他数组保持空数组。',
      '逐项根据 candidateSnapshot、fieldPath、message 与 sourceBlocks 修复。证据或引用无法确认时不要输出该项。',
    ] : []),
    retryInstruction,
  ].filter(Boolean).join('\n');
}

const STRUCTURED_RETRY_REASONS = new Set([
  'structured_output_empty', 'structured_output_truncated', 'invalid_json', 'schema_validation_failed',
]);

export class StructuredMemoryCaptureExtractor {
  constructor(private readonly getLlm: () => MemoryLlmApi | null = readMemoryLlmApi) {}

  async extract(input: MemoryExtractionInput): Promise<StructuredCaptureResult> {
    const llm = this.getLlm();
    if (!llm) throw new Error('LLMHub 不可用，无法执行 memory_capture。');
    const schema = buildStructuredCaptureSchema(input.writableSourceRefs ?? input.sources.map(source => source.id));
    const run = (retryInstruction = '') => llm.runTask<unknown>({
      consumer: MEMORY_PLUGIN_ID,
      taskKey: MEMORY_CAPTURE_TASK,
      taskDescription: input.repairRequest ? '多角色记忆 Claim 自动定向修复' : '多角色事件与 Claim 捕获',
      taskKind: 'generation',
      input: { messages: [
        { role: 'system', content: systemPrompt(input, retryInstruction) },
        { role: 'user', content: serializeExtractionInput(input) },
      ] },
      schema,
      budget: { maxTokens: MEMORY_CAPTURE_MAX_TOKENS, maxLatencyMs: 180_000 },
      enqueue: { displayMode: 'compact' },
    });

    let response = await run();
    let automaticRepairCalls = 0;
    if (!response.ok && STRUCTURED_RETRY_REASONS.has(String(response.reasonCode ?? '').trim())) {
      automaticRepairCalls = 1;
      response = await run([
        '上一轮输出未通过结构校验。现在重新生成最小完整 JSON。',
        '只能使用 Schema 声明字段；所有必填字段必须存在；可选业务值使用空字符串或空数组，绝对不要输出 null。',
      ].join('\n'));
    }
    if (!response.ok) {
      throw new MemoryLlmTaskError(response.error || 'memory_capture 执行失败。', {
        reasonCode: response.reasonCode,
        resourceId: response.meta?.resourceId,
        model: response.meta?.model,
      });
    }
    const writable = new Set(input.writableSourceRefs ?? input.sources.map(source => source.id));
    const capture = normalizeStructuredCapture(response.data, input.sources.filter(source => writable.has(source.id)));
    return {
      ...capture,
      diagnostics: {
        ...capture.diagnostics,
        automaticRepairCalls,
        transportMode: 'json_object_validated',
      },
      audit: auditFromResponse(response),
    };
  }
}
