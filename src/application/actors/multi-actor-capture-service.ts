import { createCanonicalKey, createFactSlotKey, decideFactReconciliation, normalizeFactContent, type MemoryFact, type MemoryEpisode, type MemoryObservation } from '../../domain';
import { FIXED_OWNER_IDS, type ActorCandidate, type CaptureEnvelope, type MemoryKnowledgeMode, type MemoryOwner, type MemoryPrivacy } from '../../domain';
import type { SourceBlock, StructuredCaptureResult } from '../ingest/types';
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
function privacy(value: unknown, fallback: MemoryPrivacy = 'public'): MemoryPrivacy { return value === 'private' || value === 'secret' || value === 'limited' || value === 'public' ? value : fallback; }
function knowledgeMode(value: unknown, fallback: MemoryKnowledgeMode = 'asserted'): MemoryKnowledgeMode { return ['asserted', 'self_reported', 'heard', 'experienced', 'inferred', 'believed', 'suspected', 'unknown'].includes(String(value)) ? value as MemoryKnowledgeMode : fallback; }

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
  readonly changeAudit?: import('../../infrastructure').ChangeAudit;
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

  async capture(input: { readonly workspaceId: string; readonly chatKey: string; readonly sources: readonly SourceBlock[]; readonly currentFloor?: number; readonly sceneEpoch?: string; readonly includeInvisibleHistory?: boolean; readonly captureJobId?: string }): Promise<MultiActorCaptureResult> {
    // Workspace record IDs use the SDK v0 safe alphabet. Chat keys are host
    // provenance and commonly contain spaces, CJK text, `@`, `/`, or other
    // filename characters, so never interpolate the raw key into a record ID.
    const encodedChatKey = encodeURIComponent(input.chatKey);
    const sources = filterSourceBlocks(
      input.sources.filter(source => source.chatKey === input.chatKey && source.content.trim()),
      { includeInvisibleHistory: input.includeInvisibleHistory === true },
    );
    this.discoverFromSources(sources);
    let structured: StructuredCaptureResult;
    try {
      structured = await this.extractor.extract({ chatKey: input.chatKey, sources });
    } catch {
      // A structured Capture is the write authority for episodes,
      // observations and facts. Do not turn an unavailable/failed LLM request
      // into a misleading successful empty transaction; callers can persist a
      // safe failed job and retry without losing deterministic source scans.
      throw Object.assign(new Error('memory_capture 结构化请求不可用。'), { code: 'MEMORY_CAPTURE_LLM_UNAVAILABLE' });
    }
    const ownerByLocalId = new Map<string, string>();
    for (const candidate of structured.actorCandidates) {
      const candidateSources = candidate.sourceRefs.map(ref => sources.find(source => source.id === ref)).filter((source): source is SourceBlock => Boolean(source));
      const sourceRefsValid = candidate.sourceRefs.length > 0 && candidate.sourceRefs.every(ref => sources.some(source => source.id === ref));
      const excerptsValid = candidate.evidenceExcerpts.length > 0
        && candidate.evidenceExcerpts.every(excerpt => candidateSources.some(source => source.content.includes(excerpt)));
      if (!sourceRefsValid || !excerptsValid) {
        // A model-provided identity without source evidence remains isolated as
        // unknown; it must never silently become a confirmed actor.
        ownerByLocalId.set(candidate.localId, FIXED_OWNER_IDS.unknown);
        continue;
      }
      const sourceType = candidateSources.some(source => source.kind === 'host_card')
        ? 'host_card'
        : candidateSources.some(source => source.kind === 'worldbook') ? 'worldbook' : 'message';
      const resolution = this.registry.discoverCandidate(candidate as ActorCandidate, sourceType);
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
      const sourceRefScalar = String(row.sourceRef ?? '').trim();
      const declaredSourceRefs = stringArray(row.sourceRefs);
      if (declaredSourceRefs.length === 0 && sourceRefScalar) declaredSourceRefs.push(sourceRefScalar);
      const sourceRefs = declaredSourceRefs.filter(ref => sources.some(source => source.id === ref));
      // Local references are part of the structured Capture contract. Do not
      // silently drop an invalid ref and attach the episode to an unrelated
      // source; quarantine the whole malformed episode instead.
      if (sourceRefs.length === 0 || sourceRefs.length !== declaredSourceRefs.length) continue;
      const localId = String(row.localId ?? index);
      const id = `episode:${encodedChatKey}:${localId}:${hash(sourceRefs.join('|'))}`;
      const floorStart = numberValue(row.floorStart, Math.min(...sourceRefs.map(ref => sources.find(source => source.id === ref)?.floor ?? 0)));
      const floorEnd = numberValue(row.floorEnd, Math.max(...sourceRefs.map(ref => sources.find(source => source.id === ref)?.floor ?? floorStart)));
      const episode: MemoryEpisode = { id, workspaceId: input.workspaceId, chatKey: input.chatKey, floorStart, floorEnd, sourceRefs, participantIds: stringArray(row.participantRefs ?? row.participantIds).map(ref => resolveOwner(ref)), presentOwnerIds: stringArray(row.presentRefs ?? row.presentOwnerIds).map(ref => resolveOwner(ref)), mentionedOwnerIds: stringArray(row.mentionedRefs ?? row.mentionedOwnerIds).map(ref => resolveOwner(ref)), ...(String(row.location ?? '').trim() ? { location: String(row.location).trim() } : {}), occurredAt: numberValue(row.occurredAt, Date.now()), ...(String(row.summary ?? '').trim() ? { summary: String(row.summary).trim() } : {}), createdAt: Date.now() };
      episodeEntries.push({ localId, episode });
    }
    const episodes = episodeEntries.map(entry => entry.episode);
    const episodeByLocalId = new Map(episodeEntries.map(entry => [entry.localId, entry.episode.id]));
    const observationLocalIdById = new Map<string, string>();
    const observations: MemoryObservation[] = structured.observations.flatMap((value, index) => {
      const row = value as Record<string, unknown>;
      const sourceRef = String(row.sourceRef ?? stringArray(row.sourceRefs)[0] ?? '').trim();
      const source = sources.find(item => item.id === sourceRef);
      if (!source) return [];
      const declaredEpisodeRef = String(row.episodeLocalId ?? row.episodeId ?? '').trim();
      const episodeId = (declaredEpisodeRef ? episodeByLocalId.get(declaredEpisodeRef) : undefined)
        ?? (!declaredEpisodeRef ? episodes.find(episode => episode.sourceRefs.includes(sourceRef))?.id : undefined);
      if (!episodeId) return [];
      const rawExcerpt = String(row.excerpt ?? '').trim();
      if (rawExcerpt && !source.content.includes(rawExcerpt)) return [];
      const channel = ['public_speech', 'private_thought', 'narration', 'worldbook', 'state', 'rumor', 'inference'].includes(String(row.channel)) ? String(row.channel) as MemoryObservation['channel'] : source.kind === 'worldbook' ? 'worldbook' : source.kind === 'state' ? 'state' : source.author?.kind === 'narrator' ? 'narration' : 'public_speech';
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
      const content = normalizeFactContent(String(row.content ?? ''));
      const declaredFactSourceRefs = stringArray(row.sourceRefs);
      const sourceRef = String(row.sourceRef ?? declaredFactSourceRefs[0] ?? '').trim();
      const factSourceRefs = declaredFactSourceRefs.length > 0 ? declaredFactSourceRefs : sourceRef ? [sourceRef] : [];
      const factSources = factSourceRefs
        .map(ref => sources.find(item => item.id === ref))
        .filter((item): item is SourceBlock => Boolean(item));
      const source = factSources[0];
      const evidenceExcerpt = String(row.evidenceExcerpt ?? '').trim();
      if (content.length < 6 || content.length > 240 || !source || factSourceRefs.length === 0 || !factSourceRefs.includes(sourceRef) || factSourceRefs.some(ref => !sources.some(item => item.id === ref)) || !evidenceExcerpt || !source.content.includes(evidenceExcerpt)) continue;
      const subjectKey = String(row.subjectKey ?? '').trim();
      const predicateKey = String(row.predicateKey ?? '').trim();
      if (!subjectKey || !predicateKey) continue;
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
      const status = numberValue(row.confidence, 0) >= 0.75 ? 'active' : 'pending';
      const kindValue = String(row.kind ?? 'other') as MemoryFact['kind'];
      const fact: MemoryFact = { id, chatKey: input.chatKey, kind: factKinds.has(kindValue) ? kindValue : 'other', subjectKey, ...(subjectEntityId ? { subjectEntityId } : {}), predicateKey, ...(objectKey ? { objectKey } : {}), ...(objectEntityId ? { objectEntityId } : {}), canonicalKey, slotKey: createFactSlotKey(subjectKey, predicateKey), content, entityKeys, confidence: Math.max(0, Math.min(1, numberValue(row.confidence, 0.5))), status, sourceRefs: [...factSourceRefs], evidenceIds: [`evidence:${id}:${hash(evidenceExcerpt)}`], freshestEvidenceAt: Math.max(...factSources.map(item => item.createdAt)), ...(source.kind === 'host_card' || source.kind === 'worldbook' || source.kind === 'state' ? { scope: { hostCardKeys: source.kind === 'host_card' ? [source.id] : undefined, worldKeys: source.entityKeys?.length ? [...source.entityKeys] : [source.id] } } : {}), origin: 'automatic', revision: 1, createdAt: Date.now(), updatedAt: Date.now() };
      const localId = String(row.localId ?? index);
      const validFrom = Number(row.validFrom);
      const validUntil = Number(row.validUntil);
      const rawScope = row.scope && typeof row.scope === 'object' ? row.scope as MemoryFact['scope'] : undefined;
      factEntries.push({
        localId,
        fact,
        evidenceExcerpt,
        metadata: {
          localId,
          ownerRefs: stringArray(row.ownerRefs).length > 0 ? stringArray(row.ownerRefs) : entityKeys.filter(key => key.startsWith('owner:')),
          observationLocalIds: stringArray(row.observationLocalIds ?? row.observationRefs ?? row.observationIds),
          ...(privacy(row.privacy, 'public') ? { privacy: privacy(row.privacy, 'public') } : {}),
          ...(row.knowledgeMode !== undefined ? { knowledgeMode: knowledgeMode(row.knowledgeMode) } : {}),
          ...(rawScope ? { scope: rawScope } : fact.scope ? { scope: fact.scope } : {}),
          ...(Number.isFinite(validFrom) ? { validFrom } : {}),
          ...(Number.isFinite(validUntil) ? { validUntil } : {}),
          ...(typeof row.stableAnchor === 'boolean' ? { stableAnchor: row.stableAnchor } : {}),
        },
      });
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
    const linkedObservations = observations.map(observation => ({ ...observation, factLocalIds: observation.factLocalIds.map(ref => factByLocalId.get(ref) ?? ref).filter(ref => facts.some(fact => fact.id === ref)) }));
    const projection = this.projector.project({ workspaceId: input.workspaceId, facts, episodes, observations: linkedObservations, owners: this.registry.listOwners() });
    const cast = new ActiveCastResolver(this.registry).resolve(sources, { currentFloor: input.currentFloor, sceneEpoch: input.sceneEpoch }).scene;
    const evidenceByFactId = evidenceExcerptByFactId;
    const envelope: CaptureEnvelope = {
      workspaceId: input.workspaceId,
      chatKey: input.chatKey,
      sourceRefs: sources.map(source => source.id),
      actorCandidates: structured.actorCandidates.map(candidate => ({ ...candidate, sourceRefs: candidate.sourceRefs, evidenceExcerpts: candidate.evidenceExcerpts })),
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
    let changeAudit: import('../../infrastructure').ChangeAudit | undefined;
    if (this.repository) changeAudit = await this.repository.commitCapture({
      envelope,
      ...(input.captureJobId ? { captureJobId: input.captureJobId } : {}),
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
    return { envelope, owners: this.registry.listOwners(), pendingCandidates: this.registry.listPending(), episodes, observations: linkedObservations, facts, traces: projection.traces, sceneCast: cast, audit: structured.audit, ...(changeAudit ? { changeAudit } : {}) };
  }
}
