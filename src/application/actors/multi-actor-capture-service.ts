import { createCanonicalKey, createFactSlotKey, decideFactReconciliation, normalizeFactContent, type AutomaticIngestRejection, type AutomaticProposalErrorCode, type MemoryFact, type MemoryEpisode, type MemoryObservation } from '../../domain';
import { FIXED_OWNER_IDS, type ActorCandidate, type CaptureEnvelope, type MemoryKnowledgeMode, type MemoryOwner, type MemoryPrivacy } from '../../domain';
import type { ExistingMemoryContextItem, SourceBlock, StructuredCaptureResult } from '../ingest/types';
import { filterSourceBlocks } from '../ingest/source-blocks';
import type { StructuredMemoryCaptureExtractor } from '../ingest/llm-extractor';
import { ActiveCastResolver } from './active-cast-resolver';
import { ActorRegistry } from './actor-registry';
import { KnowledgeProjector } from './knowledge-projector';
import type { MultiActorMemoryRepository } from '../../infrastructure';

function hash(value: string): string {
  let result = 2166136261;
  for (const char of value) { result ^= char.codePointAt(0) ?? 0; result = Math.imul(result, 16777619); }
  return (result >>> 0).toString(36);
}
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.map(String).map(item => item.trim()).filter(Boolean) : []; }
function numberValue(value: unknown, fallback: number): number { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
const ALLOWED_PRIVACY = ['public', 'limited', 'private', 'secret'] as const satisfies readonly MemoryPrivacy[];
const ALLOWED_KNOWLEDGE_MODES = ['asserted', 'self_reported', 'heard', 'experienced', 'inferred', 'believed', 'suspected', 'unknown'] as const satisfies readonly MemoryKnowledgeMode[];
function privacy(value: unknown, fallback: MemoryPrivacy = 'public'): MemoryPrivacy { return ALLOWED_PRIVACY.includes(value as MemoryPrivacy) ? value as MemoryPrivacy : fallback; }
function knowledgeMode(value: unknown, fallback: MemoryKnowledgeMode = 'asserted'): MemoryKnowledgeMode { return ALLOWED_KNOWLEDGE_MODES.includes(value as MemoryKnowledgeMode) ? value as MemoryKnowledgeMode : fallback; }
function validConfidence(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1; }

export interface MultiActorCaptureResult {
  readonly envelope: CaptureEnvelope;
  readonly owners: readonly MemoryOwner[];
  readonly pendingCandidates: readonly ActorCandidate[];
  readonly episodes: readonly MemoryEpisode[];
  readonly observations: readonly MemoryObservation[];
  readonly facts: readonly MemoryFact[];
  readonly traces: readonly import('../../domain').ActorMemoryTrace[];
  readonly sceneCast: import('../../domain').SceneCast;
  readonly audit?: import('../ingest/types').MemoryExtractionAudit;
  readonly outcome: 'complete' | 'partial';
  readonly rejections: readonly AutomaticIngestRejection[];
  readonly acceptedLocalIds: Readonly<Record<'actor' | 'episode' | 'observation' | 'fact', readonly string[]>>;
  readonly changeAudit?: import('../../infrastructure').ChangeAudit;
}

export interface MultiActorCaptureInput {
  readonly workspaceId: string;
  readonly chatKey: string;
  readonly sources: readonly SourceBlock[];
  /** Sources omitted from this set remain prompt context, but cannot create records. */
  readonly writableSourceRefs?: readonly string[];
  readonly existingMemoryContext?: readonly ExistingMemoryContextItem[];
  readonly graphLlmRelationEnabled?: boolean;
  readonly currentFloor?: number;
  readonly sceneEpoch?: string;
  readonly includeInvisibleHistory?: boolean;
  readonly captureJobId?: string;
  readonly idempotencyKey?: string;
  readonly repairRequest?: import('../ingest/types').CaptureRepairRequest;
}

/** Coordinates the single Capture call and the atomic knowledge projection. */
export class MultiActorCaptureService {
  constructor(
    readonly registry: ActorRegistry,
    private readonly extractor: Pick<StructuredMemoryCaptureExtractor, 'extract'>,
    private readonly repository?: MultiActorMemoryRepository,
    private readonly projector = new KnowledgeProjector(),
  ) {}

  private discoverFromSources(sources: readonly SourceBlock[]): void {
    for (const source of sources) {
      for (const ref of source.actorRefs ?? []) {
        if (!ref.trim() || this.registry.getOwner(ref)) continue;
        // A persisted owner reference is an identity key, not a display name.
        // Never create an actor literally named `owner:actor:...` when a
        // prompt/source arrives before that registry row has been hydrated.
        if (ref.trim().startsWith('owner:')) continue;
        this.registry.discover({
          displayName: ref,
          sourceRef: source.id,
          sourceType: source.kind === 'worldbook' ? 'worldbook' : source.kind === 'host_card' ? 'host_card' : 'message',
          excerpt: source.content.slice(0, 240),
          confidence: source.perspective?.confidence ?? 0.8,
        });
      }
      // The host author is provenance, not a host-card owner. For an assistant
      // conversation message its display name is nevertheless the strongest
      // available speaker hint, including first-person text that never repeats
      // the character name. Generic labels are quarantined by ActorRegistry.
      if (source.author?.displayName && source.kind === 'message' && source.author.kind === 'assistant'
        && source.author.displayName.trim()) {
        this.registry.discover({ displayName: source.author.displayName, sourceRef: source.id, sourceType: 'message', excerpt: source.content, confidence: 0.8 });
      }
      // Worldbook `keys` are activation/trigger terms (often locations,
      // topics or ordinary nouns), not actor declarations.  Only explicit
      // person syntax below or a validated Capture candidate may seed an actor.
      if (source.kind === 'host_card') {
        // The card is a world/container source, but its explicit named
        // characters are valid actor seeds. The host card id itself is never
        // inserted into ActorRegistry.
        for (const key of source.entityKeys?.slice(1) ?? []) {
          if (key.trim()) this.registry.discover({ displayName: key, sourceRef: source.id, sourceType: 'host_card', excerpt: source.content, confidence: 0.95, confirmed: true });
        }
      }
      // Explicit naming constructions are high precision enough for automatic
      // discovery; generic nouns and the host card display name are excluded.
      // Do not treat arbitrary quoted objects in worldbook/card prose as
      // people. Explicit role/person declarations are source-safe; dialogue
      // speaker labels are resolved separately by ActiveCastResolver.
      const patterns = [/(?:名为|名叫|叫做|称为|角色[：:]|人物[：:])\s*([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9·_-]{0,15})/gu];
      for (const pattern of patterns) {
        for (const match of source.content.matchAll(pattern)) {
          const name = match[1]?.trim();
          if (name && name.length >= 1) this.registry.discover({ displayName: name, sourceRef: source.id, sourceType: source.kind === 'worldbook' ? 'worldbook' : source.kind === 'host_card' ? 'host_card' : 'message', excerpt: source.content, confidence: source.kind === 'host_card' || source.kind === 'worldbook' ? 0.86 : 0.7 });
        }
      }
    }
  }

  async capture(input: MultiActorCaptureInput): Promise<MultiActorCaptureResult> {
    // Workspace record IDs use the SDK v0 safe alphabet. Chat keys are host
    // provenance and commonly contain spaces, CJK text, `@`, `/`, or other
    // filename characters, so never interpolate the raw key into a record ID.
    const encodedChatKey = encodeURIComponent(input.chatKey);
    const sources = filterSourceBlocks(
      input.sources.filter(source => source.chatKey === input.chatKey && source.content.trim()),
      { includeInvisibleHistory: input.includeInvisibleHistory === true },
    );
    const sourceIds = new Set(sources.map((source) => source.id));
    const writableSourceRefs = new Set(
      input.writableSourceRefs === undefined
        ? sourceIds
        : input.writableSourceRefs.filter((sourceRef) => sourceIds.has(sourceRef)),
    );
    const isWritableSource = (sourceRef: string): boolean => writableSourceRefs.has(sourceRef);
    this.discoverFromSources(sources.filter((source) => isWritableSource(source.id)));
    let structured: StructuredCaptureResult;
    try {
      structured = await this.extractor.extract({
        chatKey: input.chatKey,
        sources,
        ...(input.existingMemoryContext === undefined ? {} : { existingMemoryContext: input.existingMemoryContext }),
        ...(input.graphLlmRelationEnabled === undefined ? {} : { graphLlmRelationEnabled: input.graphLlmRelationEnabled }),
        ...(input.repairRequest === undefined ? {} : { repairRequest: input.repairRequest }),
      });
    } catch {
      // A structured Capture is the write authority for episodes,
      // observations and facts. Do not turn an unavailable/failed LLM request
      // into a misleading successful empty transaction; callers can persist a
      // safe failed job and retry without losing deterministic source scans.
      throw Object.assign(new Error('memory_capture 结构化请求不可用。'), { code: 'MEMORY_CAPTURE_LLM_UNAVAILABLE' });
    }
    const rejections: AutomaticIngestRejection[] = [...(structured.rejections ?? [])];
    const acceptedLocalIds: Record<'actor' | 'episode' | 'observation' | 'fact', string[]> = {
      actor: [],
      episode: [],
      observation: [],
      fact: [],
    };
    const actorFields = new Set(['localId', 'displayName', 'aliases', 'sourceRefs', 'evidenceExcerpts', 'confidence']);
    const episodeFields = new Set([
      'localId', 'sourceRef', 'sourceRefs', 'floorStart', 'floorEnd',
      'participantRefs', 'participantIds', 'presentRefs', 'presentOwnerIds',
      'mentionedRefs', 'mentionedOwnerIds', 'location', 'occurredAt', 'summary',
    ]);
    const observationFields = new Set([
      'localId', 'sourceRef', 'sourceRefs', 'episodeLocalId', 'episodeId',
      'speakerRef', 'speakerOwnerId', 'speaker', 'viewpointRef', 'viewpointOwnerId', 'viewpoint',
      'observerRefs', 'observerOwnerIds', 'observers', 'channel', 'privacy', 'knowledgeMode',
      'excerpt', 'mentionedRefs', 'mentionedOwnerIds', 'presentRefs', 'presentOwnerIds',
      'factLocalIds', 'factRefs', 'occurredAt',
    ]);
    const factFields = new Set([
      'localId', 'sourceRef', 'sourceRefs', 'kind', 'subjectKey', 'predicateKey', 'objectKey',
      'content', 'entityKeys', 'ownerRefs', 'confidence', 'evidenceExcerpt',
      'observationLocalIds', 'observationRefs', 'observationIds', 'privacy', 'knowledgeMode',
      'validFrom', 'validUntil', 'stableAnchor',
    ]);
    const snapshotKeys = new Set([
      ...actorFields,
      ...episodeFields,
      ...observationFields,
      ...factFields,
      'localId', 'displayName', 'aliases', 'sourceRefs', 'evidenceExcerpts',
      'sourceRef', 'episodeLocalId', 'speakerRef', 'viewpointRef', 'observerRefs',
      'channel', 'privacy', 'knowledgeMode', 'excerpt', 'mentionedRefs', 'presentRefs',
      'factRefs', 'kind', 'subjectKey', 'predicateKey', 'objectKey', 'content',
      'entityKeys', 'ownerRefs', 'confidence', 'evidenceExcerpt', 'status',
      'validFrom', 'validUntil', 'stableAnchor',
    ]);
    const candidateSnapshot = (value: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => snapshotKeys.has(key))
        .map(([key, item]) => [key, typeof item === 'string' ? item.slice(0, 2_000) : structuredClone(item)]),
    );
    const reject = (
      recordType: 'actor' | 'episode' | 'observation' | 'fact',
      index: number,
      code: AutomaticProposalErrorCode,
      message: string,
      fieldPath: string,
      value: Record<string, unknown>,
      allowedValues?: readonly string[],
    ): void => {
      const snapshot = candidateSnapshot(value);
      const sourceRefs = [...new Set([
        ...stringArray(value.sourceRefs),
        ...(String(value.sourceRef ?? '').trim() ? [String(value.sourceRef).trim()] : []),
      ])];
      const rejectionId = `capture-rejection:${hash(`${input.captureJobId ?? input.chatKey}:${recordType}:${index}:${fieldPath}:${JSON.stringify(snapshot)}`)}`;
      rejections.push({
        id: rejectionId,
        index,
        code,
        message,
        recordType,
        fieldPath,
        sourceRefs,
        ...(allowedValues ? { allowedValues: [...allowedValues] } : {}),
        candidateSnapshot: snapshot,
        status: 'unresolved',
        repairAttempts: 0,
      });
    };
    const rejectUnknownFields = (
      recordType: 'actor' | 'episode' | 'observation' | 'fact',
      index: number,
      value: Record<string, unknown>,
      allowed: ReadonlySet<string>,
    ): boolean => {
      const unknownFields = Object.keys(value).filter(key => !allowed.has(key)).sort();
      if (unknownFields.length === 0) return false;
      reject(
        recordType,
        index,
        'unknown_field',
        `${recordType} 包含未声明字段：${unknownFields.join('、')}。`,
        unknownFields[0]!,
        value,
        [...allowed].sort(),
      );
      return true;
    };
    const repairLocalIds = new Set(input.repairRequest?.items.map(item => item.localId) ?? []);
    const repairAllows = (
      recordType: 'actor' | 'episode' | 'observation' | 'fact',
      index: number,
      value: Record<string, unknown>,
    ): boolean => {
      const repair = input.repairRequest;
      if (!repair) return true;
      if (repair.recordType !== recordType) {
        reject(recordType, index, 'invalid_shape', `定向修复只允许输出 ${repair.recordType}，不得写入 ${recordType}。`, 'recordType', value, [repair.recordType]);
        return false;
      }
      const localId = String(value.localId ?? '').trim();
      if (!localId || !repairLocalIds.has(localId)) {
        reject(recordType, index, 'invalid_reference', '定向修复必须保留 repairRequest 中已有的 localId。', 'localId', value, [...repairLocalIds].sort());
        return false;
      }
      return true;
    };
    const ownerByLocalId = new Map<string, string>();
    const acceptedActorCandidates: ActorCandidate[] = [];
    for (const [index, value] of structured.actorCandidates.entries()) {
      if (!repairAllows('actor', index, value)) continue;
      if (rejectUnknownFields('actor', index, value, actorFields)) continue;
      if (value.confidence !== undefined && !validConfidence(value.confidence)) {
        reject('actor', index, 'invalid_confidence', '人物 confidence 必须是 0 到 1 之间的数字。', 'confidence', value);
        continue;
      }
      const candidate = {
        localId: String(value.localId ?? `actor:${index}`).trim(),
        displayName: String(value.displayName ?? '').trim(),
        aliases: stringArray(value.aliases).slice(0, 12),
        sourceRefs: stringArray(value.sourceRefs).slice(0, 16),
        evidenceExcerpts: stringArray(value.evidenceExcerpts).slice(0, 8),
        confidence: value.confidence === undefined ? 0.5 : value.confidence,
        status: 'pending' as const,
      } satisfies ActorCandidate;
      if (!candidate.displayName || !candidate.localId) {
        reject('actor', index, 'invalid_shape', '人物缺少 localId 或 displayName。', !candidate.localId ? 'localId' : 'displayName', value);
        continue;
      }
      const candidateSources = candidate.sourceRefs.map(ref => sources.find(source => source.id === ref)).filter((source): source is SourceBlock => Boolean(source));
      const writableCandidateSources = candidateSources.filter(source => isWritableSource(source.id));
      const sourceRefsValid = candidate.sourceRefs.length > 0 && candidate.sourceRefs.every(ref => sources.some(source => source.id === ref));
      const excerptsValid = candidate.evidenceExcerpts.length > 0
        && candidate.evidenceExcerpts.every(excerpt => writableCandidateSources.some(source => source.content.includes(excerpt)));
      if (!sourceRefsValid || !excerptsValid || writableCandidateSources.length === 0) {
        // A model-provided identity without source evidence remains isolated as
        // unknown; it must never silently become a confirmed actor.
        ownerByLocalId.set(candidate.localId, FIXED_OWNER_IDS.unknown);
        reject(
          'actor',
          index,
          !sourceRefsValid ? 'invalid_reference' : 'excerpt_mismatch',
          !sourceRefsValid ? '人物引用了不存在或不可写的来源。' : '人物证据未逐字出现在对应来源中。',
          !sourceRefsValid ? 'sourceRefs' : 'evidenceExcerpts',
          value,
          !sourceRefsValid ? [...writableSourceRefs] : undefined,
        );
        continue;
      }
      acceptedActorCandidates.push(candidate);
      acceptedLocalIds.actor.push(candidate.localId);
      const sourceType = candidateSources.some(source => source.kind === 'host_card')
        ? 'host_card'
        : candidateSources.some(source => source.kind === 'worldbook') ? 'worldbook' : 'message';
      const deterministicExisting = this.registry.resolveMention(candidate.displayName);
      const resolution = deterministicExisting?.owner.kind === 'actor'
        && deterministicExisting.owner.status === 'confirmed'
        && !deterministicExisting.ambiguous
        ? this.registry.discover({
          displayName: candidate.displayName,
          aliases: candidate.aliases,
          sourceRef: candidate.sourceRefs[0]!,
          sourceType,
          excerpt: candidate.evidenceExcerpts[0],
          confidence: candidate.confidence,
        })
        : this.registry.discoverCandidate(candidate as ActorCandidate, sourceType);
      ownerByLocalId.set(candidate.localId, resolution.owner.id);
    }
    const resolveOwner = (value: unknown, source?: SourceBlock): string => {
      const ref = String(value ?? '').trim();
      if (!ref) return FIXED_OWNER_IDS.unknown;
      const local = ownerByLocalId.get(ref);
      if (local) return local;
      if (ref.startsWith('owner:')) return this.registry.getOwner(ref)?.id ?? FIXED_OWNER_IDS.unknown;
      if (ref === 'world' || ref === FIXED_OWNER_IDS.world) return FIXED_OWNER_IDS.world;
      if (ref === 'narrator' || ref === FIXED_OWNER_IDS.narrator) return FIXED_OWNER_IDS.narrator;
      if (ref === 'player' || ref === FIXED_OWNER_IDS.player) return FIXED_OWNER_IDS.player;
      const resolution = this.registry.resolveMention(ref) ?? (source ? this.registry.discover({ displayName: ref, sourceRef: source.id, sourceType: 'message', confidence: 0.55 }) : undefined);
      return resolution?.owner.id ?? FIXED_OWNER_IDS.unknown;
    };
    const episodeEntries: Array<{ localId: string; episode: MemoryEpisode }> = [];
    for (const [index, value] of structured.episodes.entries()) {
      const row = value as Record<string, unknown>;
      if (!repairAllows('episode', index, row)) continue;
      if (rejectUnknownFields('episode', index, row, episodeFields)) continue;
      let invalidNumericField = false;
      for (const field of ['floorStart', 'floorEnd', 'occurredAt'] as const) {
        const raw = row[field];
        const integerRequired = field === 'floorStart' || field === 'floorEnd';
        if (raw !== undefined && (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || (integerRequired && !Number.isInteger(raw)))) {
          reject('episode', index, 'invalid_shape', `事件 ${field} 必须是${integerRequired ? '非负整数' : '非负有限数字'}。`, field, row);
          invalidNumericField = true;
          break;
        }
      }
      if (invalidNumericField) continue;
      const sourceRefScalar = String(row.sourceRef ?? '').trim();
      const declaredSourceRefs = stringArray(row.sourceRefs);
      if (declaredSourceRefs.length === 0 && sourceRefScalar) declaredSourceRefs.push(sourceRefScalar);
      const sourceRefs = [...new Set(declaredSourceRefs.filter(ref => sources.some(source => source.id === ref)))];
      // Local references are part of the structured Capture contract. Do not
      // silently drop an invalid ref and attach the episode to an unrelated
      // source; quarantine the whole malformed episode instead.
      if (sourceRefs.length === 0 || sourceRefs.length !== declaredSourceRefs.length || !sourceRefs.some(isWritableSource)) {
        reject('episode', index, 'invalid_reference', '事件引用了不存在或不可写的来源。', 'sourceRefs', row, [...writableSourceRefs]);
        continue;
      }
      const localId = String(row.localId ?? '').trim();
      if (!localId) {
        reject('episode', index, 'invalid_shape', '事件缺少 localId。', 'localId', row);
        continue;
      }
      const id = `episode:${encodedChatKey}:${localId}:${hash(sourceRefs.join('|'))}`;
      const floorStart = numberValue(row.floorStart, Math.min(...sourceRefs.map(ref => sources.find(source => source.id === ref)?.floor ?? 0)));
      const floorEnd = numberValue(row.floorEnd, Math.max(...sourceRefs.map(ref => sources.find(source => source.id === ref)?.floor ?? floorStart)));
      if (floorEnd < floorStart) {
        reject('episode', index, 'invalid_shape', '事件 floorEnd 不能小于 floorStart。', 'floorEnd', row);
        continue;
      }
      const episode: MemoryEpisode = { id, workspaceId: input.workspaceId, chatKey: input.chatKey, floorStart, floorEnd, sourceRefs, participantIds: stringArray(row.participantRefs ?? row.participantIds).map(ref => resolveOwner(ref)), presentOwnerIds: stringArray(row.presentRefs ?? row.presentOwnerIds).map(ref => resolveOwner(ref)), mentionedOwnerIds: stringArray(row.mentionedRefs ?? row.mentionedOwnerIds).map(ref => resolveOwner(ref)), ...(String(row.location ?? '').trim() ? { location: String(row.location).trim() } : {}), occurredAt: numberValue(row.occurredAt, Date.now()), ...(String(row.summary ?? '').trim() ? { summary: String(row.summary).trim() } : {}), createdAt: Date.now() };
      episodeEntries.push({ localId, episode });
      acceptedLocalIds.episode.push(localId);
    }
    const episodes = episodeEntries.map(entry => entry.episode);
    const episodeByLocalId = new Map(episodeEntries.map(entry => [entry.localId, entry.episode.id]));
    const existingEpisodes = input.repairRequest?.recordType === 'observation' && this.repository
      ? await this.repository.listEpisodes()
      : [];
    const observationLocalIdById = new Map<string, string>();
    const observations: MemoryObservation[] = structured.observations.flatMap((value, index) => {
      const row = value as Record<string, unknown>;
      if (!repairAllows('observation', index, row)) return [];
      if (rejectUnknownFields('observation', index, row, observationFields)) return [];
      if (row.occurredAt !== undefined && (typeof row.occurredAt !== 'number' || !Number.isFinite(row.occurredAt) || row.occurredAt < 0)) {
        reject('observation', index, 'invalid_shape', '观察 occurredAt 必须是非负有限数字。', 'occurredAt', row);
        return [];
      }
      const sourceRef = String(row.sourceRef ?? stringArray(row.sourceRefs)[0] ?? '').trim();
      const source = sources.find(item => item.id === sourceRef);
      if (!source || !isWritableSource(sourceRef)) {
        reject('observation', index, 'invalid_reference', '观察引用了不存在或不可写的来源。', 'sourceRef', row, [...writableSourceRefs]);
        return [];
      }
      const declaredEpisodeRef = String(row.episodeLocalId ?? row.episodeId ?? '').trim();
      const episodeId = (declaredEpisodeRef ? episodeByLocalId.get(declaredEpisodeRef) : undefined)
        ?? (declaredEpisodeRef ? existingEpisodes.find(episode => episode.id === declaredEpisodeRef)?.id : undefined)
        ?? ((!declaredEpisodeRef || input.repairRequest?.recordType === 'observation')
          ? [...episodes, ...existingEpisodes].find(episode => episode.sourceRefs.includes(sourceRef))?.id
          : undefined);
      if (!episodeId) {
        reject('observation', index, 'dependency_invalid', '观察引用的事件不存在或未通过校验。', 'episodeLocalId', row);
        return [];
      }
      const rawExcerpt = String(row.excerpt ?? '').trim();
      if (!rawExcerpt || !source.content.includes(rawExcerpt)) {
        reject('observation', index, 'excerpt_mismatch', '观察证据必须逐字出现在对应来源中。', 'excerpt', row);
        return [];
      }
      const allowedChannels: MemoryObservation['channel'][] = ['public_speech', 'private_thought', 'narration', 'worldbook', 'state', 'rumor', 'inference'];
      const channelValue = String(row.channel ?? '').trim();
      if (!allowedChannels.includes(channelValue as MemoryObservation['channel'])) {
        reject('observation', index, 'invalid_enum', '观察 channel 不在允许范围内。', 'channel', row, allowedChannels);
        return [];
      }
      const channel = channelValue as MemoryObservation['channel'];
      const privacyValue = String(row.privacy ?? '').trim();
      if (privacyValue && !ALLOWED_PRIVACY.includes(privacyValue as MemoryPrivacy)) {
        reject('observation', index, 'invalid_enum', '观察 privacy 不在允许范围内。', 'privacy', row, ALLOWED_PRIVACY);
        return [];
      }
      const knowledgeModeValue = String(row.knowledgeMode ?? '').trim();
      if (knowledgeModeValue && !ALLOWED_KNOWLEDGE_MODES.includes(knowledgeModeValue as MemoryKnowledgeMode)) {
        reject('observation', index, 'invalid_enum', '观察 knowledgeMode 不在允许范围内。', 'knowledgeMode', row, ALLOWED_KNOWLEDGE_MODES);
        return [];
      }
      const hostSpeakerRef = source.author?.kind === 'user'
        ? 'player'
        : source.author?.kind === 'narrator'
          ? 'narrator'
          : source.author?.displayName ?? '';
      const speakerRef = String(row.speakerRef ?? row.speakerOwnerId ?? row.speaker ?? source.perspective?.speakerOwnerRef ?? hostSpeakerRef).trim();
      const speakerOwnerId = channel === 'narration' && !speakerRef ? FIXED_OWNER_IDS.narrator : resolveOwner(speakerRef, source);
      const viewpointOwnerId = resolveOwner(row.viewpointRef ?? row.viewpointOwnerId ?? row.viewpoint ?? speakerOwnerId, source);
      const presentOwnerIds = stringArray(row.presentRefs ?? row.presentOwnerIds).map(ref => resolveOwner(ref, source));
      const rawObserverOwnerIds = stringArray(row.observerRefs ?? row.observerOwnerIds ?? row.observers).map(ref => resolveOwner(ref, source));
      const observerOwnerIds = channel === 'public_speech'
        ? rawObserverOwnerIds.filter(ownerId => presentOwnerIds.includes(ownerId))
        : rawObserverOwnerIds;
      const localId = String(row.localId ?? index);
      const observationId = `observation:${encodedChatKey}:${localId}:${hash(sourceRef)}`;
      observationLocalIdById.set(observationId, localId);
      acceptedLocalIds.observation.push(localId);
      return [{ id: observationId, workspaceId: input.workspaceId, episodeId, sourceRef, speakerOwnerId, viewpointOwnerId, observerOwnerIds: [...new Set(observerOwnerIds)], channel, privacy: privacy(row.privacy, channel === 'private_thought' ? 'private' : 'public'), knowledgeMode: knowledgeMode(row.knowledgeMode, channel === 'rumor' ? 'believed' : channel === 'public_speech' ? 'self_reported' : 'experienced'), excerpt: (rawExcerpt || source.content).slice(0, 2_000), mentionedOwnerIds: stringArray(row.mentionedRefs ?? row.mentionedOwnerIds).map(ref => resolveOwner(ref, source)), presentOwnerIds: [...new Set(presentOwnerIds)], factLocalIds: stringArray(row.factLocalIds ?? row.factRefs), occurredAt: numberValue(row.occurredAt, source.createdAt), createdAt: Date.now() }];
    });
    const factEntries: Array<{
      localId: string;
      fact: MemoryFact;
      evidenceExcerpt: string;
      metadata: {
        readonly localId: string;
        readonly ownerRefs: readonly string[];
        readonly observationLocalIds: readonly string[];
        readonly privacy?: MemoryPrivacy;
        readonly knowledgeMode?: MemoryKnowledgeMode;
        readonly scope?: MemoryFact['scope'];
        readonly validFrom?: number;
        readonly validUntil?: number;
        readonly stableAnchor?: boolean;
      };
    }> = [];
    const factKinds = new Set<MemoryFact['kind']>(['identity', 'relationship', 'location', 'world_rule', 'state', 'goal', 'commitment', 'preference', 'capability', 'event', 'other']);
    for (const [index, value] of structured.facts.entries()) {
      const row = value as Record<string, unknown>;
      if (!repairAllows('fact', index, row)) continue;
      if (rejectUnknownFields('fact', index, row, factFields)) continue;
      const content = normalizeFactContent(String(row.content ?? ''));
      const declaredFactSourceRefs = [...new Set(stringArray(row.sourceRefs))];
      const sourceRef = String(row.sourceRef ?? declaredFactSourceRefs[0] ?? '').trim();
      const factSourceRefs = declaredFactSourceRefs.length > 0 ? declaredFactSourceRefs : sourceRef ? [sourceRef] : [];
      const factSources = factSourceRefs
        .map(ref => sources.find(item => item.id === ref))
        .filter((item): item is SourceBlock => Boolean(item));
      const source = sources.find(item => item.id === sourceRef);
      const evidenceExcerpt = String(row.evidenceExcerpt ?? '').trim();
      if (Array.from(content).length < 6 || Array.from(content).length > 240) {
        reject('fact', index, 'invalid_shape', '事实 content 长度必须为 6 到 240 个字符。', 'content', row);
        continue;
      }
      if (!validConfidence(row.confidence)) {
        reject('fact', index, 'invalid_confidence', '事实 confidence 必须是 0 到 1 之间的数字。', 'confidence', row);
        continue;
      }
      const factPrivacyValue = row.privacy === undefined ? 'public' : String(row.privacy).trim();
      if (!ALLOWED_PRIVACY.includes(factPrivacyValue as MemoryPrivacy)) {
        reject('fact', index, 'invalid_enum', '事实 privacy 不在允许范围内。', 'privacy', row, ALLOWED_PRIVACY);
        continue;
      }
      const factKnowledgeValue = row.knowledgeMode === undefined ? undefined : String(row.knowledgeMode).trim();
      if (factKnowledgeValue !== undefined && !ALLOWED_KNOWLEDGE_MODES.includes(factKnowledgeValue as MemoryKnowledgeMode)) {
        reject('fact', index, 'invalid_enum', '事实 knowledgeMode 不在允许范围内。', 'knowledgeMode', row, ALLOWED_KNOWLEDGE_MODES);
        continue;
      }
      if (row.validFrom !== undefined && (typeof row.validFrom !== 'number' || !Number.isFinite(row.validFrom))) {
        reject('fact', index, 'invalid_shape', '事实 validFrom 必须是有限数字。', 'validFrom', row);
        continue;
      }
      if (row.validUntil !== undefined && (typeof row.validUntil !== 'number' || !Number.isFinite(row.validUntil))) {
        reject('fact', index, 'invalid_shape', '事实 validUntil 必须是有限数字。', 'validUntil', row);
        continue;
      }
      if (row.stableAnchor !== undefined && typeof row.stableAnchor !== 'boolean') {
        reject('fact', index, 'invalid_shape', '事实 stableAnchor 必须是布尔值。', 'stableAnchor', row);
        continue;
      }
      if (!source || !isWritableSource(sourceRef) || factSourceRefs.length === 0 || !factSourceRefs.includes(sourceRef) || factSourceRefs.some(ref => !sources.some(item => item.id === ref))) {
        reject('fact', index, 'invalid_reference', '事实引用了不存在或不可写的来源。', 'sourceRefs', row, [...writableSourceRefs]);
        continue;
      }
      if (!evidenceExcerpt || !source.content.includes(evidenceExcerpt)) {
        reject('fact', index, 'excerpt_mismatch', '事实证据必须逐字出现在对应来源中。', 'evidenceExcerpt', row);
        continue;
      }
      const subjectKey = String(row.subjectKey ?? '').trim();
      const predicateKey = String(row.predicateKey ?? '').trim();
      if (!subjectKey || !predicateKey) {
        reject('fact', index, 'invalid_shape', '事实缺少 subjectKey 或 predicateKey。', !subjectKey ? 'subjectKey' : 'predicateKey', row);
        continue;
      }
      const objectKey = String(row.objectKey ?? '').trim() || undefined;
      const canonicalKey = createCanonicalKey(subjectKey, predicateKey, objectKey);
      // Keep repeated captures of the same evidence idempotent, while giving a
      // conflicting proposition a distinct identity so the predecessor can be
      // retained as a real superseded fact instead of being overwritten by the
      // same canonical id.
      const id = `fact:${encodedChatKey}:${hash(`${canonicalKey}\0${content}\0${factSourceRefs.join('|')}\0${evidenceExcerpt}`)}`;
      const subjectEntityId = subjectKey.startsWith('owner:') ? resolveOwner(subjectKey, source) : this.registry.resolveMention(subjectKey)?.owner.id;
      const objectEntityId = objectKey ? (objectKey.startsWith('owner:') ? resolveOwner(objectKey, source) : this.registry.resolveMention(objectKey)?.owner.id) : undefined;
      const entityKeys = [...new Set([
        ...stringArray(row.entityKeys),
        ...stringArray(row.ownerRefs).map(ref => resolveOwner(ref, source)),
        ...(subjectEntityId ? [subjectEntityId] : []),
        ...(objectEntityId ? [objectEntityId] : []),
      ])];
      const status = row.confidence >= 0.75 ? 'active' : 'pending';
      const kindValue = String(row.kind ?? '').trim() as MemoryFact['kind'];
      if (!factKinds.has(kindValue)) {
        reject('fact', index, 'invalid_enum', '事实 kind 不在允许范围内；只有模型明确输出 other 时才接受 other。', 'kind', row, [...factKinds]);
        continue;
      }
      const hostCardKeys = factSources.filter(item => item.kind === 'host_card').map(item => item.id);
      const worldKeys = factSources
        .filter(item => item.kind === 'worldbook' || item.kind === 'state')
        .flatMap(item => item.entityKeys?.length ? item.entityKeys : [item.id]);
      const factScope: MemoryFact['scope'] | undefined = hostCardKeys.length > 0 || worldKeys.length > 0
        ? {
          ...(hostCardKeys.length > 0 ? { hostCardKeys: [...new Set(hostCardKeys)] } : {}),
          ...(worldKeys.length > 0 ? { worldKeys: [...new Set(worldKeys)] } : {}),
        }
        : undefined;
      const fact: MemoryFact = { id, chatKey: input.chatKey, kind: kindValue, subjectKey, ...(subjectEntityId ? { subjectEntityId } : {}), predicateKey, ...(objectKey ? { objectKey } : {}), ...(objectEntityId ? { objectEntityId } : {}), canonicalKey, slotKey: createFactSlotKey(subjectKey, predicateKey), content, entityKeys, confidence: row.confidence, status, sourceRefs: [...factSourceRefs], evidenceIds: [`evidence:${id}:${hash(evidenceExcerpt)}`], freshestEvidenceAt: Math.max(...factSources.map(item => item.createdAt)), ...(factScope ? { scope: factScope } : {}), ...(row.validFrom === undefined ? {} : { validFrom: row.validFrom }), ...(row.validUntil === undefined ? {} : { validUntil: row.validUntil }), ...(row.stableAnchor === undefined ? {} : { stableAnchor: row.stableAnchor }), origin: 'automatic', revision: 1, createdAt: Date.now(), updatedAt: Date.now() };
      const localId = String(row.localId ?? index);
      factEntries.push({
        localId,
        fact,
        evidenceExcerpt,
        metadata: {
          localId,
          ownerRefs: stringArray(row.ownerRefs).length > 0 ? stringArray(row.ownerRefs) : entityKeys.filter(key => key.startsWith('owner:')),
          observationLocalIds: stringArray(row.observationLocalIds ?? row.observationRefs ?? row.observationIds),
          privacy: factPrivacyValue as MemoryPrivacy,
          ...(factKnowledgeValue !== undefined ? { knowledgeMode: factKnowledgeValue as MemoryKnowledgeMode } : {}),
          ...(fact.scope ? { scope: fact.scope } : {}),
          ...(fact.validFrom === undefined ? {} : { validFrom: fact.validFrom }),
          ...(fact.validUntil === undefined ? {} : { validUntil: fact.validUntil }),
          ...(typeof row.stableAnchor === 'boolean' ? { stableAnchor: row.stableAnchor } : {}),
        },
      });
      acceptedLocalIds.fact.push(localId);
    }
    // Reconcile against the v0 fact set before projection. Duplicate source
    // evidence is appended to the existing canonical fact; a newer confident
    // proposition supersedes the active slot, while unresolved changes remain
    // pending. No repository code is involved in this domain decision.
    const existingFacts = this.repository ? await this.repository.listFacts() : [];
    const factsBySlot = new Map<string, MemoryFact>(existingFacts.filter(fact => fact.status === 'active' || fact.status === 'pending').map(fact => [fact.slotKey ?? createFactSlotKey(fact.subjectKey, fact.predicateKey), fact]));
    const reconciledFacts: MemoryFact[] = [];
    const localFactIds = new Map<string, string>();
    const evidenceExcerptByFactId = new Map<string, string>();
    const envelopeMetadataByFactId = new Map<string, (typeof factEntries)[number]['metadata']>();
    for (const entry of factEntries) {
      const slotKey = entry.fact.slotKey ?? createFactSlotKey(entry.fact.subjectKey, entry.fact.predicateKey);
      const existing = factsBySlot.get(slotKey);
      const decision = decideFactReconciliation(existing, entry.fact);
      if (decision === 'duplicate' && existing) {
        const evidenceId = `evidence:${existing.id}:${hash(entry.evidenceExcerpt)}`;
        const evidenceAlreadyStored = existing.evidenceIds.includes(evidenceId)
          && entry.fact.sourceRefs.every((sourceRef) => existing.sourceRefs.includes(sourceRef));
        if (evidenceAlreadyStored) {
          // Retry and overlap context are idempotent: keep local links valid,
          // but do not create a revision, evidence row, or ChangeSet entry.
          localFactIds.set(entry.localId, existing.id);
          continue;
        }
        const merged: MemoryFact = {
          ...existing,
          sourceRefs: [...new Set([...existing.sourceRefs, ...entry.fact.sourceRefs])],
          evidenceIds: [...new Set([...existing.evidenceIds, evidenceId])],
          freshestEvidenceAt: Math.max(existing.freshestEvidenceAt, entry.fact.freshestEvidenceAt),
          revision: existing.revision + 1,
          updatedAt: Date.now(),
        };
        factsBySlot.set(slotKey, merged);
        reconciledFacts.push(merged);
        localFactIds.set(entry.localId, merged.id);
        evidenceExcerptByFactId.set(merged.id, entry.evidenceExcerpt);
        envelopeMetadataByFactId.set(merged.id, entry.metadata);
        continue;
      }
      if (decision === 'supersede' && existing) {
        const superseded: MemoryFact = { ...existing, status: 'superseded', supersededById: entry.fact.id, revision: existing.revision + 1, updatedAt: Date.now() };
        const incoming: MemoryFact = { ...entry.fact, supersedesId: existing.id };
        reconciledFacts.push(superseded, incoming);
        factsBySlot.set(slotKey, incoming);
        localFactIds.set(entry.localId, incoming.id);
        evidenceExcerptByFactId.set(incoming.id, entry.evidenceExcerpt);
        envelopeMetadataByFactId.set(incoming.id, entry.metadata);
        continue;
      }
      const incoming = decision === 'pending' ? { ...entry.fact, status: 'pending' as const } : entry.fact;
      reconciledFacts.push(incoming);
      factsBySlot.set(slotKey, incoming);
      localFactIds.set(entry.localId, incoming.id);
      evidenceExcerptByFactId.set(incoming.id, entry.evidenceExcerpt);
      envelopeMetadataByFactId.set(incoming.id, entry.metadata);
    }
    const facts = [...new Map(reconciledFacts.map(fact => [fact.id, fact])).values()];
    const factByLocalId = localFactIds;
    const existingFactIds = new Set(existingFacts.map((fact) => fact.id));
    const linkedObservations = observations.map(observation => ({
      ...observation,
      factLocalIds: observation.factLocalIds
        .map(ref => factByLocalId.get(ref) ?? ref)
        .filter(ref => facts.some(fact => fact.id === ref) || existingFactIds.has(ref)),
    }));
    const projection = this.projector.project({ workspaceId: input.workspaceId, facts, episodes, observations: linkedObservations, owners: this.registry.listOwners() });
    const cast = new ActiveCastResolver(this.registry).resolve(sources, { currentFloor: input.currentFloor, sceneEpoch: input.sceneEpoch }).scene;
    const evidenceByFactId = evidenceExcerptByFactId;
    const envelope: CaptureEnvelope = {
      workspaceId: input.workspaceId,
      chatKey: input.chatKey,
      sourceRefs: sources.map(source => source.id),
      actorCandidates: acceptedActorCandidates.map(candidate => ({ ...candidate, sourceRefs: candidate.sourceRefs, evidenceExcerpts: candidate.evidenceExcerpts })),
      episodes: episodeEntries.map(entry => ({ ...entry.episode, localId: entry.localId })),
      observations: linkedObservations.map(observation => ({ ...observation, ...(observationLocalIdById.get(observation.id) ? { localId: observationLocalIdById.get(observation.id) } : {}) })),
      facts: facts.map(fact => {
        const metadata = envelopeMetadataByFactId.get(fact.id);
        return {
          ...(metadata?.localId ? { localId: metadata.localId } : {}),
          kind: fact.kind,
          subjectKey: fact.subjectKey,
          predicateKey: fact.predicateKey,
          ...(fact.objectKey ? { objectKey: fact.objectKey } : {}),
          content: fact.content,
          entityKeys: fact.entityKeys,
          confidence: fact.confidence,
          ...(metadata?.ownerRefs?.length ? { ownerRefs: metadata.ownerRefs } : {}),
          ...(metadata?.observationLocalIds?.length ? { observationLocalIds: metadata.observationLocalIds } : {}),
          ...(metadata?.privacy ? { privacy: metadata.privacy } : {}),
          ...(metadata?.knowledgeMode ? { knowledgeMode: metadata.knowledgeMode } : {}),
          ...(metadata?.scope ? { scope: metadata.scope } : {}),
          ...(metadata?.validFrom === undefined ? {} : { validFrom: metadata.validFrom }),
          ...(metadata?.validUntil === undefined ? {} : { validUntil: metadata.validUntil }),
          ...(metadata?.stableAnchor === undefined ? {} : { stableAnchor: metadata.stableAnchor }),
          evidence: [{ sourceRef: fact.sourceRefs[0]!, excerpt: evidenceByFactId.get(fact.id) ?? '' }],
        };
      }),
      capturedAt: Date.now(),
    };
    const outcome = rejections.some(item => (item.status ?? 'unresolved') === 'unresolved') ? 'partial' as const : 'complete' as const;
    let changeAudit: import('../../infrastructure').ChangeAudit | undefined;
    if (this.repository) changeAudit = await this.repository.commitCapture({
      envelope,
      ...(input.captureJobId ? { captureJobId: input.captureJobId } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      outcome,
      rejections,
      owners: this.registry.listOwners(),
      aliases: this.registry.listAliases(),
      pendingCandidates: this.registry.listPending(),
      episodes,
      observations: linkedObservations,
      facts,
      evidence: facts.flatMap(fact => {
        const excerpt = evidenceByFactId.get(fact.id);
        if (!excerpt) return [];
        const evidenceId = `evidence:${fact.id}:${hash(excerpt)}`;
        return [{ id: evidenceId, factId: fact.id, workspaceId: input.workspaceId, chatKey: input.chatKey, sourceRef: fact.sourceRefs[0], excerpt, occurredAt: fact.freshestEvidenceAt, createdAt: Date.now() }];
      }),
      traces: projection.traces,
      sceneCasts: [cast],
    });
    return { envelope, owners: this.registry.listOwners(), pendingCandidates: this.registry.listPending(), episodes, observations: linkedObservations, facts, traces: projection.traces, sceneCast: cast, audit: structured.audit, outcome, rejections, acceptedLocalIds, ...(changeAudit ? { changeAudit } : {}) };
  }
}
