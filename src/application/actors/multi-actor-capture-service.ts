import {
  createCanonicalKey,
  createFactSlotKey,
  decideFactReconciliation,
  normalizeFactContent,
  FIXED_OWNER_IDS,
  normalizeActorName,
  normalizeLocationName,
  type ActorCandidate,
  type ActorMemoryTrace,
  type AutomaticIngestRejection,
  type AutomaticProposalErrorCode,
  type CaptureEnvelope,
  type LocationAlias,
  type LocationCandidate,
  type MemoryEpisode,
  type MemoryFact,
  type MemoryKnowledgeMode,
  type MemoryLocation,
  type MemoryObservation,
  type MemoryOwner,
  type MemoryPrivacy,
} from '../../domain';
import type {
  CaptureRepairRequest,
  ExistingMemoryContextItem,
  KnownActorContextItem,
  KnownLocationContextItem,
  SourceBlock,
  StructuredActorCandidate,
  StructuredCaptureResult,
  StructuredClaim,
  StructuredEpisode,
  StructuredLocationCandidate,
} from '../ingest/types';
import { filterSourceBlocks } from '../ingest/source-blocks';
import type { StructuredMemoryCaptureExtractor } from '../ingest/llm-extractor';
import { ActiveCastResolver } from './active-cast-resolver';
import { ActorRegistry, deriveActorAliases, isPlausibleActorName } from './actor-registry';
import { KnowledgeProjector } from './knowledge-projector';
import { LocationRegistry, deriveLocationAliases, isPlausibleLocationName } from '../locations';
import type { MultiActorMemoryRepository } from '../../infrastructure';

function hash(value: string): string {
  const normalized = value.normalize('NFKC');
  const parts: string[] = [];
  // Persistent Memory ids can grow into the tens of thousands per chat. A
  // single 32-bit FNV value has a meaningful birthday-collision probability at
  // that scale, so derive four independently salted 32-bit words instead.
  for (let variant = 0; variant < 4; variant += 1) {
    let result = 2166136261;
    for (const char of `${variant}\0${normalized}`) {
      result ^= char.codePointAt(0) ?? 0;
      result = Math.imul(result, 16777619);
    }
    parts.push((result >>> 0).toString(16).padStart(8, '0'));
  }
  return parts.join('');
}

function promptRecordSegment(value: string): string {
  return hash(value.normalize('NFKC'));
}

function unique<T>(values: readonly T[]): T[] { return [...new Set(values)]; }
function diagnosticValue(value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(diagnosticValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => [key, diagnosticValue(child)]));
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  const safe = diagnosticValue(value);
  return safe && typeof safe === 'object' && !Array.isArray(safe)
    ? safe as Record<string, unknown>
    : { value: safe };
}
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function validConfidence(value: unknown): value is number { return finite(value) && value >= 0 && value <= 1; }
function localPromptRef(prefix: 'actor' | 'location', persistenceId: string): string { return `${prefix}:${hash(persistenceId)}`; }

const PRIVACY_LEVELS = ['public', 'limited', 'private', 'secret'] as const satisfies readonly MemoryPrivacy[];
const KNOWLEDGE_MODES = ['asserted', 'self_reported', 'heard', 'experienced', 'inferred', 'believed', 'suspected', 'unknown'] as const satisfies readonly MemoryKnowledgeMode[];
const FACT_KINDS = new Set<MemoryFact['kind']>([
  'identity', 'relationship', 'location', 'world_rule', 'state', 'goal',
  'commitment', 'preference', 'capability', 'event', 'other',
]);

interface PreparedCapture {
  actorCandidates: StructuredActorCandidate[];
  locationCandidates: StructuredLocationCandidate[];
  episodes: StructuredEpisode[];
  claims: StructuredClaim[];
  rejections: AutomaticIngestRejection[];
  deterministicRepairs: number;
}

interface MaterializedClaim {
  localId: string;
  fact: MemoryFact;
  observation: MemoryObservation;
  evidenceExcerpt: string;
  ownerRefs: string[];
  privacy: MemoryPrivacy;
  knowledgeMode: MemoryKnowledgeMode;
  qualityScore: number;
}

export interface MultiActorCaptureResult {
  readonly envelope: CaptureEnvelope;
  readonly owners: readonly MemoryOwner[];
  readonly pendingCandidates: readonly ActorCandidate[];
  readonly locations: readonly MemoryLocation[];
  readonly locationAliases: readonly LocationAlias[];
  readonly pendingLocationCandidates: readonly LocationCandidate[];
  readonly episodes: readonly MemoryEpisode[];
  readonly observations: readonly MemoryObservation[];
  readonly facts: readonly MemoryFact[];
  readonly traces: readonly ActorMemoryTrace[];
  readonly sceneCast: import('../../domain').SceneCast;
  readonly diagnostics?: StructuredCaptureResult['diagnostics'];
  readonly audit?: import('../ingest/types').MemoryExtractionAudit;
  readonly outcome: 'complete' | 'partial';
  readonly rejections: readonly AutomaticIngestRejection[];
  readonly acceptedLocalIds: Readonly<Record<'actor' | 'location' | 'episode' | 'claim', readonly string[]>>;
  readonly changeAudit?: import('../../infrastructure').ChangeAudit;
}

export interface MultiActorCaptureInput {
  readonly workspaceId: string;
  readonly chatKey: string;
  readonly sources: readonly SourceBlock[];
  readonly writableSourceRefs?: readonly string[];
  readonly existingMemoryContext?: readonly ExistingMemoryContextItem[];
  readonly graphLlmRelationEnabled?: boolean;
  readonly currentFloor?: number;
  readonly sceneEpoch?: string;
  readonly includeInvisibleHistory?: boolean;
  readonly captureJobId?: string;
  readonly idempotencyKey?: string;
  /** A targeted repair is an atomic child of the original Capture audit. */
  readonly parentChangeSetId?: string;
  readonly repairRequest?: CaptureRepairRequest;
}

function rejection(
  input: MultiActorCaptureInput,
  recordType: 'actor' | 'location' | 'episode' | 'claim',
  index: number,
  code: AutomaticProposalErrorCode,
  message: string,
  fieldPath: string,
  value: unknown,
  allowedValues?: readonly string[],
  status: 'unresolved' | 'ignored' = 'unresolved',
): AutomaticIngestRejection {
  const snapshot = record(value);
  const sourceRefs = unique([
    ...('sourceRefs' in snapshot && Array.isArray(snapshot.sourceRefs) ? snapshot.sourceRefs.map(String) : []),
    ...('sourceRef' in snapshot && String(snapshot.sourceRef ?? '').trim() ? [String(snapshot.sourceRef).trim()] : []),
  ]);
  return {
    id: `capture-rejection:${hash(`${input.captureJobId ?? input.chatKey}:${recordType}:${index}:${fieldPath}:${JSON.stringify(snapshot)}`)}`,
    index,
    code,
    message,
    recordType,
    fieldPath,
    sourceRefs,
    ...(allowedValues ? { allowedValues: [...allowedValues] } : {}),
    candidateSnapshot: snapshot,
    status,
    repairAttempts: 0,
    ...(status === 'ignored' ? { ignoredAt: Date.now() } : {}),
  };
}

function mergeByLocalId<T extends { localId: string }>(left: readonly T[], right: readonly T[]): T[] {
  const rows = new Map<string, T>();
  for (const item of [...left, ...right]) if (item.localId) rows.set(item.localId, item);
  return [...rows.values()];
}

/**
 * Repair prompts are advisory only. The server remains the write authority and
 * accepts exactly the record type/localId pairs requested by the user. This
 * prevents a one-item repair from becoming a second broad Capture.
 */
function restrictCaptureToRepairRequest(
  structured: StructuredCaptureResult,
  repairRequest: CaptureRepairRequest,
): StructuredCaptureResult {
  const allowed = new Set(repairRequest.items.map(item => `${item.recordType}:${item.localId}`));
  const accepts = (recordType: 'actor' | 'location' | 'episode' | 'claim', localId: string): boolean =>
    allowed.has(`${recordType}:${localId}`)
    && (!repairRequest.recordType || repairRequest.recordType === recordType);
  return {
    ...structured,
    actorCandidates: structured.actorCandidates.filter(item => accepts('actor', item.localId)),
    locationCandidates: structured.locationCandidates.filter(item => accepts('location', item.localId)),
    episodes: structured.episodes.filter(item => accepts('episode', item.localId)),
    claims: structured.claims.filter(item => accepts('claim', item.localId)),
  };
}

function firstSourceTime(sourceRefs: readonly string[], sources: readonly SourceBlock[]): number {
  const values = sourceRefs
    .map(ref => sources.find(source => source.id === ref)?.createdAt)
    .filter((value): value is number => finite(value) && value >= 0);
  return values.length > 0 ? Math.min(...values) : Date.now();
}

interface EvidenceProjection {
  readonly text: string;
  readonly starts: readonly number[];
  readonly ends: readonly number[];
}

interface EvidenceUnit {
  readonly raw: string;
  readonly start: number;
  readonly end: number;
}

function evidenceUnits(value: string): EvidenceUnit[] {
  const units: EvidenceUnit[] = [];
  let offset = 0;
  for (const raw of value) {
    const start = offset;
    offset += raw.length;
    units.push({ raw, start, end: offset });
  }
  return units;
}

const IGNORED_EVIDENCE_PUNCTUATION = /[“”"'‘’「」『』【】\[\]()（）<>《》\s]/u;
const ELLIPSIS_CHARACTER = /[….．]/u;

function canonicalEvidencePunctuation(value: string): string | undefined {
  if (/[,，､]/u.test(value)) return ',';
  if (/[。｡]/u.test(value)) return '.';
  if (/[;；]/u.test(value)) return ';';
  if (/[:：]/u.test(value)) return ':';
  if (/[!?！？]/u.test(value)) return /[?？]/u.test(value) ? '?' : '!';
  if (/[—–－-]/u.test(value)) return '-';
  if (/[\/／]/u.test(value)) return '/';
  return undefined;
}

function appendProjectedToken(
  projected: string[],
  starts: number[],
  ends: number[],
  token: string,
  start: number,
  end: number,
): void {
  projected.push(token);
  for (let unit = 0; unit < token.length; unit += 1) {
    starts.push(start);
    ends.push(end);
  }
}

/**
 * Build a presentation-normalized search projection while retaining UTF-16
 * offsets for the exact original excerpt. Semantic separators remain present:
 * “不要，杀他” must never match “不要杀他”. Only width/quote/ellipsis variants
 * and equivalent punctuation glyphs are normalized.
 */
function projectEvidence(value: string): EvidenceProjection {
  const projected: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const units = evidenceUnits(value);
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index]!;
    const normalized = unit.raw.normalize('NFKC').toLocaleLowerCase();
    if (IGNORED_EVIDENCE_PUNCTUATION.test(normalized)) continue;
    if (ELLIPSIS_CHARACTER.test(normalized)) {
      let end = unit.end;
      let cursor = index + 1;
      while (cursor < units.length && ELLIPSIS_CHARACTER.test(units[cursor]!.raw.normalize('NFKC'))) {
        end = units[cursor]!.end;
        cursor += 1;
      }
      // A run of two or more ASCII/full-width dots is an ellipsis; one dot is
      // an ordinary sentence separator. A single Unicode ellipsis is already
      // an ellipsis token.
      const runLength = cursor - index;
      const unicodeEllipsis = /[…]/u.test(normalized);
      appendProjectedToken(projected, starts, ends, unicodeEllipsis || runLength >= 2 ? '…' : '.', unit.start, end);
      index = cursor - 1;
      continue;
    }
    const punctuation = canonicalEvidencePunctuation(normalized);
    if (punctuation) {
      appendProjectedToken(projected, starts, ends, punctuation, unit.start, unit.end);
      continue;
    }
    for (const normalizedCharacter of normalized) {
      if (!/[\p{L}\p{N}]/u.test(normalizedCharacter)) {
        // Unknown symbols are retained instead of erased. This keeps the
        // matcher fail-closed for operators and notation that may change the
        // meaning of a statement.
        appendProjectedToken(projected, starts, ends, normalizedCharacter, unit.start, unit.end);
        continue;
      }
      appendProjectedToken(projected, starts, ends, normalizedCharacter, unit.start, unit.end);
    }
  }
  return { text: projected.join(''), starts, ends };
}

/**
 * Locate a model-proposed evidence excerpt back in the source when the only
 * differences are punctuation/spacing/case/full-width forms. Ambiguous matches
 * remain rejected so the evidence gate stays fail-closed.
 */
function locateExactEvidenceExcerpt(source: string, proposed: string): string | undefined {
  const candidate = proposed.trim();
  if (!candidate) return undefined;
  if (source.includes(candidate)) return candidate;
  const query = projectEvidence(candidate);
  // Short first-person utterances such as “我……想要……名字” are valid
  // evidence. Four normalized characters plus a unique source match remains
  // strict enough to avoid broad fuzzy grounding.
  if (Array.from(query.text).length < 4) return undefined;
  const document = projectEvidence(source);
  const first = document.text.indexOf(query.text);
  if (first < 0 || document.text.indexOf(query.text, first + 1) >= 0) return undefined;
  const last = first + query.text.length - 1;
  const start = document.starts[first];
  const end = document.ends[last];
  if (start === undefined || end === undefined || end <= start) return undefined;
  const exact = source.slice(start, end).trim();
  const maxPresentationExpansion = Math.max(256, candidate.length * 6 + 64);
  if (exact.length > 2_000 || exact.length > maxPresentationExpansion) return undefined;
  return exact || undefined;
}

/**
 * Small prompt-local references are opaque hashes, so models occasionally
 * transpose two characters even while the surrounding evidence names the
 * correct entity. Optimal-string-alignment distance catches that single typo
 * without turning reference repair into broad fuzzy entity matching.
 */
function damerauLevenshteinDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;
  const rows = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0));
  for (let index = 0; index <= left.length; index += 1) rows[index]![0] = index;
  for (let index = 0; index <= right.length; index += 1) rows[0]![index] = index;
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const substitution = left[row - 1] === right[column - 1] ? 0 : 1;
      rows[row]![column] = Math.min(
        rows[row - 1]![column]! + 1,
        rows[row]![column - 1]! + 1,
        rows[row - 1]![column - 1]! + substitution,
      );
      if (
        row > 1 && column > 1
        && left[row - 1] === right[column - 2]
        && left[row - 2] === right[column - 1]
      ) {
        rows[row]![column] = Math.min(rows[row]![column]!, rows[row - 2]![column - 2]! + 1);
      }
    }
  }
  return rows[left.length]![right.length]!;
}

function namesMentionedInText(names: readonly string[], value: string): string[] {
  return unique(names
    .map(name => name.trim())
    .filter(name => name.length >= 2 && value.includes(name)))
    .sort((left, right) => right.length - left.length || left.localeCompare(right, 'zh-CN'));
}

function actorNamedInDirective(names: readonly string[], value: string): boolean {
  for (const rawName of names) {
    const name = rawName.trim();
    if (!name) continue;
    if (Array.from(name).length >= 2 && value.includes(name)) return true;
    if (Array.from(name).length !== 1) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    if (new RegExp(`(?:^|[\\s“”‘’，。！？；：、])${escaped}(?=$|[\\s“”‘’，。！？；：、])`, 'u').test(value)) return true;
  }
  return false;
}

/**
 * Repair only when both signals agree: the malformed id has one uniquely close
 * directory id and that entity is explicitly named in the Claim/evidence. Any
 * non-close reference or tie remains unresolved and follows the audit path.
 */
function repairPromptEntityReference(
  malformedRef: string,
  claimText: string,
  namesByRef: ReadonlyMap<string, readonly string[]>,
): string | undefined {
  const prefix = malformedRef.includes(':') ? `${malformedRef.split(':', 1)[0]}:` : '';
  const candidates = [...namesByRef.entries()]
    .filter(([referenceId]) => !prefix || referenceId.startsWith(prefix))
    .map(([referenceId, names]) => ({
      referenceId,
      names: namesMentionedInText(names, claimText),
      distance: damerauLevenshteinDistance(malformedRef, referenceId),
    }));
  const named = candidates.filter(candidate => candidate.names.length > 0);
  const close = named
    .filter(candidate => candidate.distance <= 1)
    .sort((left, right) => left.distance - right.distance || right.names[0]!.length - left.names[0]!.length);
  if (close.length === 1 || (close[0] && close[1] && close[0].distance < close[1].distance)) return close[0]!.referenceId;
  return undefined;
}

function claimQuality(claim: StructuredClaim, subjectResolved: boolean): number {
  const evidence = claim.evidenceExcerpt.length >= 4 ? 1 : 0;
  const specificity = claim.predicateKey.length >= 2 && claim.content.length >= 8 ? 1 : 0.5;
  const retrievalValue = claim.kind === 'other' ? 0.55 : 1;
  const numericBonus = /\d|百分之|数量|库存|剩余|约/u.test(`${claim.content}${claim.objectText ?? ''}`) ? 1 : 0.7;
  return Math.max(0, Math.min(1,
    claim.confidence * 0.45
      + evidence * 0.2
      + specificity * 0.15
      + (subjectResolved ? 1 : 0.65) * 0.1
      + retrievalValue * 0.05
      + numericBonus * 0.05,
  ));
}

function observationChannel(claim: StructuredClaim, source: SourceBlock): MemoryObservation['channel'] {
  if (source.kind === 'worldbook' || source.kind === 'host_card') return 'worldbook';
  if (source.kind === 'state' || source.semanticSection === 'state_snapshot') return 'state';
  // Privacy is authoritative. A model may describe a private confession as
  // self_reported/heard, but it must never become public-speech provenance.
  if ((claim.knowledge.privacy === 'private' || claim.knowledge.privacy === 'secret') && claim.knowledge.speakerRef) return 'private_thought';
  if (claim.knowledge.mode === 'self_reported' || claim.knowledge.mode === 'heard') return 'public_speech';
  if (claim.knowledge.mode === 'believed' || claim.knowledge.mode === 'suspected') return 'rumor';
  if (claim.knowledge.mode === 'inferred') return 'inference';
  if (claim.knowledge.mode === 'experienced' && claim.knowledge.ownerRefs.length > 0) return 'state';
  return 'narration';
}

const EXPLICIT_DIRECTIVE_MARKER = /([\p{Script=Han}·]{1,20})\s*(?:下达了?(?:指令|命令)|下令(?:道)?|命令道)/gu;
const QUOTED_SPEECH_PATTERN = /“([^”]{2,400})”/gu;

interface QuotedSpeechMatch {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function quotedSpeechMatches(value: string, absoluteOffset = 0): QuotedSpeechMatch[] {
  return [...value.matchAll(QUOTED_SPEECH_PATTERN)].map(match => ({
    text: match[1]?.trim() ?? '',
    start: absoluteOffset + (match.index ?? 0),
    end: absoluteOffset + (match.index ?? 0) + match[0].length,
  })).filter(match => Boolean(match.text));
}

function actorDirectoryForms(actor: KnownActorContextItem): string[] {
  const values = unique([actor.canonicalName, ...actor.aliases].map(value => value.trim()).filter(Boolean));
  return unique(values.flatMap((value) => {
    const withoutDescriptor = value.replace(/\s*[（(][^）)]{1,40}[）)]\s*$/u, '').trim();
    return withoutDescriptor && withoutDescriptor !== value ? [value, withoutDescriptor] : [value];
  }));
}

function resolveKnownActorPromptRef(
  name: string,
  knownActors: readonly KnownActorContextItem[],
  allowSingleCharacterSuffix = false,
  evidence = '',
): KnownActorContextItem | undefined {
  const direct = knownActors.find(actor => actor.referenceId === name || actor.ownerId === name);
  if (direct) return direct;
  const normalized = normalizeActorName(name);
  if (!normalized) return undefined;
  const exact = knownActors.filter(actor => actorDirectoryForms(actor)
    .some(alias => normalizeActorName(alias) === normalized));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;
  // A model or dialogue attribution often uses a short given name. Reuse it
  // only when it is at least two characters and is a unique suffix among the
  // current directory. This is language/name agnostic and never assumes a
  // project-specific family-name prefix.
  if (Array.from(normalized).length < 2 && !allowSingleCharacterSuffix) return undefined;
  const suffix = knownActors.filter(actor => actorDirectoryForms(actor)
    .some(alias => {
      const form = normalizeActorName(alias);
      return form !== normalized
        && form.endsWith(normalized)
        && (!evidence || evidence.includes(alias));
    }));
  return suffix.length === 1 ? suffix[0] : undefined;
}

function locationDirectoryForms(location: KnownLocationContextItem): string[] {
  return unique([location.canonicalName, ...location.aliases].map(value => value.trim()).filter(Boolean));
}

function resolveKnownLocationPromptRef(
  name: string,
  knownLocations: readonly KnownLocationContextItem[],
  evidence = '',
): KnownLocationContextItem | undefined {
  const direct = knownLocations.find(location => location.referenceId === name || location.locationId === name);
  if (direct) return direct;
  const normalized = normalizeLocationName(name);
  if (!normalized) return undefined;
  const exact = knownLocations.filter(location => locationDirectoryForms(location)
    .some(alias => normalizeLocationName(alias) === normalized));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1 || Array.from(normalized).length < 2 || !evidence.includes(name)) return undefined;
  const suffix = knownLocations.filter(location => locationDirectoryForms(location).some((alias) => {
    const form = normalizeLocationName(alias);
    return form !== normalized && form.endsWith(normalized) && evidence.includes(alias);
  }));
  return suffix.length === 1 ? suffix[0] : undefined;
}

function directiveAddressedActors(value: string, knownActors: readonly KnownActorContextItem[]): string[] {
  const refs = new Set<string>();
  for (const actor of knownActors) {
    if (actorNamedInDirective(actorDirectoryForms(actor), value)) refs.add(actor.referenceId);
  }
  // Direct address punctuation is strong enough to resolve a unique one-Han
  // nickname, but only inside this directive span. It is never persisted as a
  // global alias and therefore cannot merge unrelated future characters.
  for (const match of value.matchAll(/(?:^|[“”。！？；\n])\s*([\p{L}\p{N}·]{1,20})\s*[，,:：]/gu)) {
    const actor = resolveKnownActorPromptRef(match[1]?.trim() ?? '', knownActors, true);
    if (actor) refs.add(actor.referenceId);
  }
  return [...refs];
}

/**
 * Long roleplay messages occasionally make the model spend its Claim budget on
 * world rules and omit the concrete command that explains how a major event
 * was handled. Clear quoted directives with an explicit named commander are
 * safe to recover deterministically because both speaker and evidence span are
 * present verbatim in one writable source.
 */
function extractExplicitDirectiveClaims(
  sources: readonly SourceBlock[],
  writableSourceRefs: ReadonlySet<string>,
  knownActors: readonly KnownActorContextItem[],
  existingClaims: readonly StructuredClaim[],
): StructuredClaim[] {
  const claims: StructuredClaim[] = [];
  for (const source of sources) {
    if (!writableSourceRefs.has(source.id) || source.kind !== 'message' || source.semanticSection === 'control') continue;
    for (const marker of source.content.matchAll(EXPLICIT_DIRECTIVE_MARKER)) {
      const commanderName = marker[1]?.trim() ?? '';
      const commander = resolveKnownActorPromptRef(commanderName, knownActors);
      if (!commander || marker.index === undefined) continue;
      const markerStart = marker.index;
      const markerEnd = markerStart + marker[0].length;
      const beforeStart = Math.max(0, markerStart - 500);
      const beforeQuotes = quotedSpeechMatches(source.content.slice(beforeStart, markerStart), beforeStart);
      const previousCandidate = beforeQuotes.at(-1);
      const afterEnd = Math.min(source.content.length, markerEnd + 700);
      const nextCandidate = quotedSpeechMatches(source.content.slice(markerEnd, afterEnd), markerEnd)[0];
      const previousGap = previousCandidate ? source.content.slice(previousCandidate.end, markerStart) : '';
      const nextGap = nextCandidate ? source.content.slice(markerEnd, nextCandidate.start) : '';
      // A directive attribution must be in the same paragraph and close to the
      // quote. Without this boundary a marker could steal an unrelated command
      // from hundreds of characters earlier/later in a long roleplay message.
      const previous = previousCandidate && previousGap.length <= 180 && !/\r?\n\s*\r?\n/u.test(previousGap)
        ? previousCandidate
        : undefined;
      const next = nextCandidate && nextGap.length <= 240 && !/\r?\n\s*\r?\n/u.test(nextGap)
        ? nextCandidate
        : undefined;
      // The explicit attribution marker is the semantic boundary. Keeping a
      // whitelist of action verbs would make future roles and settings fail on
      // unseen commands such as “校准阵列” or “切换航道”.
      const directiveParts = [previous?.text, next?.text]
        .filter((value): value is string => Boolean(value && /[\p{L}\p{N}]/u.test(value)));
      if (directiveParts.length === 0) continue;
      const evidenceStart = previous && directiveParts.includes(previous.text) ? previous.start : markerStart;
      const evidenceEnd = next && directiveParts.includes(next.text) ? next.end : markerEnd;
      const evidenceExcerpt = source.content.slice(evidenceStart, evidenceEnd).trim();
      if (evidenceExcerpt.length < 8 || evidenceExcerpt.length > 1_200) continue;
      const normalizeDirectiveText = (value: string): string => value.normalize('NFKC').replace(/[\s，。！？；：“”‘’、]/gu, '');
      const duplicate = existingClaims.some((claim) => {
        if (claim.sourceRef !== source.id) return false;
        if (claim.evidenceExcerpt.includes(evidenceExcerpt)) return true;
        const existingText = normalizeDirectiveText(`${claim.content}${claim.evidenceExcerpt}`);
        return directiveParts.every(part => existingText.includes(normalizeDirectiveText(part)));
      });
      if (duplicate) continue;
      const explicitlyPresent = source.perspective?.presentOwnerRefs ?? [];
      const evidenceActors = directiveAddressedActors(evidenceExcerpt, knownActors);
      const presentRefs = unique([
        commander.referenceId,
        ...explicitlyPresent
          .map(name => resolveKnownActorPromptRef(name, knownActors)?.referenceId)
          .filter((value): value is string => Boolean(value)),
        ...evidenceActors,
      ]);
      const ownerRefs = unique([commander.referenceId, ...presentRefs]);
      claims.push({
        localId: `server-directive-${hash(`${source.id}:${evidenceExcerpt}`)}`,
        sourceRef: source.id,
        kind: 'event',
        subjectRef: commander.referenceId,
        predicateKey: '下达应对指令',
        objectText: '安全措施与人员分工',
        content: `${commander.canonicalName}下达应对指令：${directiveParts.join('；')}`,
        evidenceExcerpt,
        knowledge: {
          mode: 'self_reported',
          privacy: 'public',
          ownerRefs,
          speakerRef: commander.referenceId,
          viewpointRef: commander.referenceId,
          observerRefs: presentRefs.filter(ref => ref !== commander.referenceId),
          presentRefs,
          mentionedRefs: [],
        },
        confidence: 1,
        stableAnchor: false,
      });
    }
  }
  return claims;
}

/**
 * New v1 Capture coordinator. The model emits small Claims only. Server code
 * owns time, persistence identity, observations, evidence, traces and fact
 * reconciliation.
 */
export class MultiActorCaptureService {
  constructor(
    readonly registry: ActorRegistry,
    readonly locationRegistry: LocationRegistry,
    private readonly extractor: Pick<StructuredMemoryCaptureExtractor, 'extract'>,
    private readonly repository?: MultiActorMemoryRepository,
    private readonly projector = new KnowledgeProjector(),
  ) {}

  private discoverTrustedDirectories(sources: readonly SourceBlock[]): void {
    for (const source of sources) {
      for (const name of source.actorRefs ?? []) {
        if (!isPlausibleActorName(name, { trusted: true, evidence: source.content })) continue;
        this.registry.discover({
          displayName: name,
          aliases: deriveActorAliases(name),
          sourceRef: source.id,
          sourceType: source.kind === 'host_card' ? 'host_card' : source.kind === 'worldbook' ? 'worldbook' : 'message',
          excerpt: source.content,
          confidence: 0.98,
          confirmed: true,
        });
      }
      if (source.kind === 'host_card') {
        for (const name of source.entityKeys?.slice(1) ?? []) {
          if (!isPlausibleActorName(name, { trusted: true, evidence: source.content })) continue;
          this.registry.discover({
            displayName: name,
            aliases: deriveActorAliases(name),
            sourceRef: source.id,
            sourceType: 'host_card',
            excerpt: source.content,
            confidence: 1,
            confirmed: true,
          });
        }
      }
      if (source.author?.displayName && source.author.kind === 'assistant') {
        const known = this.registry.resolveMention(source.author.displayName);
        if (known?.owner.kind === 'actor' && !known.ambiguous) {
          this.registry.discover({
            displayName: known.owner.canonicalName ?? known.owner.displayName,
            aliases: [source.author.displayName],
            sourceRef: source.id,
            sourceType: 'message',
            excerpt: source.content,
            confidence: 0.98,
            confirmed: true,
          });
        }
      }
      for (const location of unique([...(source.locationRefs ?? []), ...(source.transition?.locationKeys ?? [])])) {
        if (!isPlausibleLocationName(location, { trusted: true, evidence: source.content })) continue;
        this.locationRegistry.discover({
          displayName: location,
          aliases: deriveLocationAliases(location),
          sourceRef: source.id,
          excerpt: source.content,
          confidence: 0.98,
          confirmed: true,
        });
      }
    }
  }

  private actorDirectory(sources: readonly SourceBlock[]): KnownActorContextItem[] {
    const owners = this.registry.listOwners()
      .filter(owner => owner.kind === 'actor'
        && (owner.status === 'confirmed' || owner.status === 'pending')
        && !owner.mergedIntoId);
    const ownerById = new Map(owners.map(owner => [owner.id, owner]));
    const priorityIds: string[] = [];
    const remember = (value: string | undefined): void => {
      const raw = value?.trim();
      if (!raw) return;
      const direct = ownerById.get(raw);
      const normalized = normalizeActorName(raw);
      const localMatches = direct ? [direct] : owners.filter(owner =>
        [owner.canonicalName ?? owner.displayName, owner.displayName, ...owner.aliases]
          .some(alias => normalizeActorName(alias) === normalized));
      if (localMatches.length !== 1) return;
      if (!priorityIds.includes(localMatches[0]!.id)) priorityIds.push(localMatches[0]!.id);
    };
    for (const source of sources) {
      for (const value of source.actorRefs ?? []) remember(value);
      remember(source.author?.displayName);
      remember(source.perspective?.speakerOwnerRef);
      remember(source.perspective?.viewpointOwnerRef);
      for (const value of source.perspective?.observerOwnerRefs ?? []) remember(value);
      for (const value of source.perspective?.presentOwnerRefs ?? []) remember(value);
      for (const value of source.perspective?.mentionedOwnerRefs ?? []) remember(value);
    }
    const prioritized = priorityIds
      .map(id => ownerById.get(id))
      .filter((owner): owner is MemoryOwner => Boolean(owner));
    const prioritySet = new Set(priorityIds);
    const remaining = owners
      .filter(owner => !prioritySet.has(owner.id))
      .sort((left, right) => (left.canonicalName ?? left.displayName).localeCompare(right.canonicalName ?? right.displayName, 'zh-CN'));
    return [...prioritized, ...remaining]
      .slice(0, 96)
      .map(owner => ({
        referenceId: localPromptRef('actor', owner.id),
        ownerId: owner.id,
        canonicalName: owner.canonicalName ?? owner.displayName,
        aliases: unique([...owner.aliases, ...deriveActorAliases(owner.canonicalName ?? owner.displayName)]).slice(0, 16),
        status: owner.status === 'confirmed' ? 'confirmed' : 'pending',
      }));
  }

  private locationDirectory(sources: readonly SourceBlock[]): KnownLocationContextItem[] {
    const locations = this.locationRegistry.listLocations()
      .filter(location => (location.status === 'confirmed' || location.status === 'pending') && !location.mergedIntoId);
    const locationById = new Map(locations.map(location => [location.id, location]));
    const priorityIds: string[] = [];
    const remember = (value: string | undefined): void => {
      const raw = value?.trim();
      if (!raw) return;
      const direct = locationById.get(raw);
      const normalized = normalizeLocationName(raw);
      const localMatches = direct ? [direct] : locations.filter(location =>
        [location.canonicalName, location.displayName, ...location.aliases]
          .some(alias => normalizeLocationName(alias) === normalized));
      if (localMatches.length !== 1) return;
      if (!priorityIds.includes(localMatches[0]!.id)) priorityIds.push(localMatches[0]!.id);
    };
    for (const source of sources) {
      for (const value of source.locationRefs ?? []) remember(value);
      for (const value of source.transition?.locationKeys ?? []) remember(value);
    }
    const prioritized = priorityIds
      .map(id => locationById.get(id))
      .filter((location): location is MemoryLocation => Boolean(location));
    const prioritySet = new Set(priorityIds);
    const remaining = locations
      .filter(location => !prioritySet.has(location.id))
      .sort((left, right) => left.canonicalName.localeCompare(right.canonicalName, 'zh-CN'));
    return [...prioritized, ...remaining]
      .slice(0, 96)
      .map(location => ({
        referenceId: localPromptRef('location', location.id),
        locationId: location.id,
        canonicalName: location.canonicalName,
        aliases: unique([...location.aliases, ...deriveLocationAliases(location.canonicalName)]).slice(0, 16),
        status: location.status === 'confirmed' ? 'confirmed' : 'pending',
      }));
  }

  private prepare(
    input: MultiActorCaptureInput,
    structured: StructuredCaptureResult,
    sources: readonly SourceBlock[],
    writableSourceRefs: ReadonlySet<string>,
    knownActors: readonly KnownActorContextItem[],
    knownLocations: readonly KnownLocationContextItem[],
  ): PreparedCapture {
    const rejections: AutomaticIngestRejection[] = structuredClone(structured.rejections ?? []);
    let deterministicRepairs = 0;
    const sourceById = new Map(sources.map(source => [source.id, source]));
    const actorRefs = new Set(knownActors.map(actor => actor.referenceId));
    const locationRefs = new Set(knownLocations.map(location => location.referenceId));
    const entityLocalIds = new Set<string>([...actorRefs, ...locationRefs, 'world', 'narrator', 'player']);
    const episodeLocalIds = new Set<string>();
    const claimLocalIds = new Set<string>();
    const ignoredEntityNamesByRef = new Map<string, string>();
    const actorCandidates: StructuredActorCandidate[] = [];
    const locationCandidates: StructuredLocationCandidate[] = [];

    for (const [index, originalCandidate] of structured.actorCandidates.entries()) {
      let candidate = originalCandidate;
      const source = sourceById.get(candidate.sourceRef);
      if (!candidate.localId || !candidate.displayName.trim()) {
        rejections.push(rejection(input, 'actor', index, 'invalid_shape', '人物缺少有效 localId/displayName，或名称属于描述词、模板词。', 'displayName', candidate));
        continue;
      }
      if (entityLocalIds.has(candidate.localId)) {
        rejections.push(rejection(input, 'actor', index, 'duplicate_proposal', '人物 localId 与已有人物/地点引用重复。', 'localId', candidate));
        continue;
      }
      if (!source || !writableSourceRefs.has(candidate.sourceRef)) {
        rejections.push(rejection(input, 'actor', index, 'invalid_reference', '人物引用了不存在或不可写的来源。', 'sourceRef', candidate, [...writableSourceRefs]));
        continue;
      }
      const exactEvidence = locateExactEvidenceExcerpt(source.content, candidate.evidenceExcerpt);
      if (!exactEvidence) {
        rejections.push(rejection(input, 'actor', index, 'excerpt_mismatch', '人物证据必须逐字出现在来源中。', 'evidenceExcerpt', candidate));
        continue;
      }
      if (exactEvidence !== candidate.evidenceExcerpt) {
        candidate = { ...candidate, evidenceExcerpt: exactEvidence };
        deterministicRepairs += 1;
      }
      const groundedAliases = unique(candidate.aliases.filter(alias =>
        candidate.evidenceExcerpt.includes(alias)
        && isPlausibleActorName(alias, { trusted: true, evidence: candidate.evidenceExcerpt })));
      if (groundedAliases.length !== candidate.aliases.length) {
        candidate = { ...candidate, aliases: groundedAliases };
        deterministicRepairs += 1;
      }
      const knownDirectoryActor = resolveKnownActorPromptRef(
        candidate.displayName,
        knownActors,
        false,
        candidate.evidenceExcerpt,
      );
      const actorEvidenceAccepted = isPlausibleActorName(candidate.displayName, {
        evidence: candidate.evidenceExcerpt,
        aliases: candidate.aliases,
      });
      if (!knownDirectoryActor && !actorEvidenceAccepted) {
        ignoredEntityNamesByRef.set(candidate.localId, candidate.displayName);
        rejections.push(rejection(
          input, 'actor', index, 'invalid_shape',
          '新人物候选缺少明确命名、说话、思考或行动证据，已自动忽略。',
          'displayName', candidate, undefined, 'ignored',
        ));
        continue;
      }
      if (!validConfidence(candidate.confidence)) {
        rejections.push(rejection(input, 'actor', index, 'invalid_confidence', '人物 confidence 必须是 0 到 1。', 'confidence', candidate));
        continue;
      }
      entityLocalIds.add(candidate.localId);
      const known = knownDirectoryActor?.ownerId
        ? this.registry.getOwner(knownDirectoryActor.ownerId)
        : this.registry.resolveMention(candidate.displayName)?.owner;
      if (known?.kind === 'actor' && !known.mergedIntoId) {
        actorRefs.add(candidate.localId);
        deterministicRepairs += 1;
        actorCandidates.push({
          ...candidate,
          displayName: known.canonicalName ?? known.displayName,
          aliases: unique([...candidate.aliases, candidate.displayName, ...known.aliases]),
        });
        continue;
      }
      actorRefs.add(candidate.localId);
      actorCandidates.push(candidate);
    }

    for (const [index, originalCandidate] of structured.locationCandidates.entries()) {
      let candidate = originalCandidate;
      const source = sourceById.get(candidate.sourceRef);
      if (!candidate.localId || !candidate.displayName.trim()) {
        rejections.push(rejection(input, 'location', index, 'invalid_shape', '地点缺少有效 localId/displayName，或只是普通方位词。', 'displayName', candidate));
        continue;
      }
      if (entityLocalIds.has(candidate.localId)) {
        rejections.push(rejection(input, 'location', index, 'duplicate_proposal', '地点 localId 与已有人物/地点引用重复。', 'localId', candidate));
        continue;
      }
      if (!source || !writableSourceRefs.has(candidate.sourceRef)) {
        rejections.push(rejection(input, 'location', index, 'invalid_reference', '地点引用了不存在或不可写的来源。', 'sourceRef', candidate, [...writableSourceRefs]));
        continue;
      }
      const exactEvidence = locateExactEvidenceExcerpt(source.content, candidate.evidenceExcerpt);
      if (!exactEvidence) {
        rejections.push(rejection(input, 'location', index, 'excerpt_mismatch', '地点证据必须逐字出现在来源中。', 'evidenceExcerpt', candidate));
        continue;
      }
      if (exactEvidence !== candidate.evidenceExcerpt) {
        candidate = { ...candidate, evidenceExcerpt: exactEvidence };
        deterministicRepairs += 1;
      }
      const groundedLocationAliases = unique(candidate.aliases.filter(alias =>
        candidate.evidenceExcerpt.includes(alias)
        && isPlausibleLocationName(alias, { trusted: true, evidence: candidate.evidenceExcerpt })));
      if (groundedLocationAliases.length !== candidate.aliases.length) {
        candidate = { ...candidate, aliases: groundedLocationAliases };
        deterministicRepairs += 1;
      }
      const knownDirectoryLocation = resolveKnownLocationPromptRef(
        candidate.displayName,
        knownLocations,
        candidate.evidenceExcerpt,
      );
      const locationEvidenceAccepted = isPlausibleLocationName(candidate.displayName, {
        evidence: candidate.evidenceExcerpt,
      });
      if (!knownDirectoryLocation && !locationEvidenceAccepted) {
        ignoredEntityNamesByRef.set(candidate.localId, candidate.displayName);
        rejections.push(rejection(
          input, 'location', index, 'invalid_shape',
          '新地点候选缺少与名称绑定的位置证据，已自动忽略。',
          'displayName', candidate, undefined, 'ignored',
        ));
        continue;
      }
      if (!validConfidence(candidate.confidence)) {
        rejections.push(rejection(input, 'location', index, 'invalid_confidence', '地点 confidence 必须是 0 到 1。', 'confidence', candidate));
        continue;
      }
      entityLocalIds.add(candidate.localId);
      locationRefs.add(candidate.localId);
      locationCandidates.push(knownDirectoryLocation ? {
        ...candidate,
        displayName: knownDirectoryLocation.canonicalName,
        aliases: unique([...candidate.aliases, candidate.displayName, ...knownDirectoryLocation.aliases]),
      } : candidate);
    }

    const episodes: StructuredEpisode[] = [];
    for (const [index, episode] of structured.episodes.entries()) {
      const validSources = unique(episode.sourceRefs.filter(ref => sourceById.has(ref)));
      if (!episode.localId || validSources.length === 0 || validSources.length !== episode.sourceRefs.length || !validSources.some(ref => writableSourceRefs.has(ref))) {
        rejections.push(rejection(input, 'episode', index, !episode.localId ? 'invalid_shape' : 'invalid_reference', !episode.localId ? '事件缺少 localId。' : '事件引用了不存在或不可写的来源。', !episode.localId ? 'localId' : 'sourceRefs', episode, [...writableSourceRefs]));
        continue;
      }
      if (episode.summary.length < 6) {
        rejections.push(rejection(input, 'episode', index, 'invalid_shape', '事件 summary 至少需要 6 个字符。', 'summary', episode));
        continue;
      }
      if (episodeLocalIds.has(episode.localId)) {
        rejections.push(rejection(input, 'episode', index, 'duplicate_proposal', '事件 localId 在同一 Capture 中重复。', 'localId', episode));
        continue;
      }
      episodeLocalIds.add(episode.localId);
      const cleanActorRefs = (refs: readonly string[]): string[] => {
        const filtered = refs.filter(ref => actorRefs.has(ref) || ['world', 'narrator', 'player'].includes(ref));
        if (filtered.length !== refs.length) deterministicRepairs += refs.length - filtered.length;
        return unique(filtered);
      };
      let locationRef = episode.locationRef ?? '';
      if (locationRef && !locationRefs.has(locationRef)) {
        const known = this.locationRegistry.resolveMention(locationRef);
        if (known && !known.ambiguous) {
          locationRef = localPromptRef('location', known.location.id);
          deterministicRepairs += 1;
        } else {
          locationRef = '';
          deterministicRepairs += 1;
        }
      }
      episodes.push({
        ...episode,
        sourceRefs: validSources,
        participantRefs: cleanActorRefs(episode.participantRefs),
        presentRefs: cleanActorRefs(episode.presentRefs),
        mentionedRefs: cleanActorRefs(episode.mentionedRefs),
        locationRef: locationRef || undefined,
        storyTimeText: episode.storyTimeText?.trim() || undefined,
      });
    }

    const episodeIds = new Set(episodes.map(episode => episode.localId));
    const episodesBySource = new Map<string, StructuredEpisode[]>();
    for (const episode of episodes) {
      for (const sourceRef of episode.sourceRefs) {
        const values = episodesBySource.get(sourceRef) ?? [];
        values.push(episode);
        episodesBySource.set(sourceRef, values);
      }
    }
    const actorNamesByRef = new Map<string, string[]>();
    for (const actor of knownActors) {
      actorNamesByRef.set(actor.referenceId, unique([actor.canonicalName, ...actor.aliases]).filter(Boolean));
    }
    for (const actor of actorCandidates) {
      actorNamesByRef.set(actor.localId, unique([actor.displayName, ...actor.aliases]).filter(Boolean));
    }
    const locationNamesByRef = new Map<string, string[]>();
    for (const location of knownLocations) {
      locationNamesByRef.set(location.referenceId, unique([location.canonicalName, ...location.aliases]).filter(Boolean));
    }
    for (const location of locationCandidates) {
      locationNamesByRef.set(location.localId, unique([location.displayName, ...location.aliases]).filter(Boolean));
    }
    const entityNamesByRef = new Map<string, readonly string[]>([
      ...actorNamesByRef.entries(),
      ...locationNamesByRef.entries(),
    ]);

    const claims: StructuredClaim[] = [];
    for (const [index, originalClaim] of structured.claims.entries()) {
      let claim = originalClaim;
      const source = sourceById.get(claim.sourceRef);
      if (!claim.localId || !source || !writableSourceRefs.has(claim.sourceRef)) {
        rejections.push(rejection(input, 'claim', index, !claim.localId ? 'invalid_shape' : 'invalid_reference', !claim.localId ? 'Claim 缺少 localId。' : 'Claim 引用了不存在或不可写的来源。', !claim.localId ? 'localId' : 'sourceRef', claim, [...writableSourceRefs]));
        continue;
      }
      const exactEvidence = locateExactEvidenceExcerpt(source.content, claim.evidenceExcerpt);
      if (!exactEvidence) {
        rejections.push(rejection(input, 'claim', index, 'excerpt_mismatch', 'Claim 证据必须逐字出现在来源中。', 'evidenceExcerpt', claim));
        continue;
      }
      if (exactEvidence !== claim.evidenceExcerpt) {
        claim = { ...claim, evidenceExcerpt: exactEvidence };
        deterministicRepairs += 1;
      }
      if (!FACT_KINDS.has(claim.kind)) {
        rejections.push(rejection(input, 'claim', index, 'invalid_enum', 'Claim kind 不在允许范围。', 'kind', claim, [...FACT_KINDS]));
        continue;
      }
      if (!validConfidence(claim.confidence)) {
        rejections.push(rejection(input, 'claim', index, 'invalid_confidence', 'Claim confidence 必须是 0 到 1。', 'confidence', claim));
        continue;
      }
      if (claim.content.length < 6 || claim.content.length > 280 || !claim.predicateKey.trim()) {
        rejections.push(rejection(input, 'claim', index, 'invalid_shape', 'Claim content 必须为 6–280 字且 predicateKey 非空。', !claim.predicateKey.trim() ? 'predicateKey' : 'content', claim));
        continue;
      }
      let subjectRef = claim.subjectRef ?? '';
      let subjectText = claim.subjectText ?? '';
      if (subjectRef && !actorRefs.has(subjectRef) && !locationRefs.has(subjectRef) && !['world', 'narrator', 'player'].includes(subjectRef)) {
        const ignoredName = ignoredEntityNamesByRef.get(subjectRef);
        const repairedRef = ignoredName
          ? undefined
          : repairPromptEntityReference(subjectRef, `${claim.content}\n${claim.evidenceExcerpt}`, entityNamesByRef);
        if (ignoredName) {
          if (!subjectText.trim()) subjectText = ignoredName;
          subjectRef = '';
          deterministicRepairs += 1;
        } else if (repairedRef) {
          subjectRef = repairedRef;
          deterministicRepairs += 1;
        } else if (subjectText) {
          subjectRef = '';
          deterministicRepairs += 1;
        } else {
          rejections.push(rejection(input, 'claim', index, 'invalid_reference', 'Claim subjectRef 不在人物/地点目录或本次候选中。', 'subjectRef', claim, [...actorRefs, ...locationRefs]));
          continue;
        }
      }
      if (claim.kind === 'relationship' && (!subjectRef || (!actorRefs.has(subjectRef) && subjectRef !== 'player'))) {
        rejections.push(rejection(input, 'claim', index, 'invalid_reference', 'relationship Claim 的主体必须是可解析的人物或玩家。', 'subjectRef', claim, [...actorRefs, 'player']));
        continue;
      }
      let objectRef = claim.objectRef ?? '';
      let objectText = claim.objectText ?? '';
      if (objectRef && !actorRefs.has(objectRef) && !locationRefs.has(objectRef) && !['world', 'narrator', 'player'].includes(objectRef)) {
        const ignoredName = ignoredEntityNamesByRef.get(objectRef);
        const repairedRef = ignoredName
          ? undefined
          : repairPromptEntityReference(objectRef, `${claim.content}\n${claim.evidenceExcerpt}`, entityNamesByRef);
        if (ignoredName) {
          if (!objectText.trim()) objectText = ignoredName;
          objectRef = '';
          deterministicRepairs += 1;
        } else if (repairedRef) {
          objectRef = repairedRef;
          deterministicRepairs += 1;
        } else if (objectText.trim()) {
          objectRef = '';
          deterministicRepairs += 1;
        } else {
          rejections.push(rejection(input, 'claim', index, 'invalid_reference', 'Claim objectRef 不在人物/地点目录或本次候选中。', 'objectRef', claim, [...actorRefs, ...locationRefs]));
          continue;
        }
      }
      if (!objectRef && claim.kind === 'relationship') {
        const namedObjects = [...actorNamesByRef.entries()]
          .filter(([referenceId]) => referenceId !== subjectRef)
          .map(([referenceId, names]) => ({ referenceId, names: namesMentionedInText(names, `${objectText}\n${claim.evidenceExcerpt}`) }))
          .filter(item => item.names.length > 0)
          .sort((left, right) => right.names[0]!.length - left.names[0]!.length);
        if (namedObjects.length === 1 || (namedObjects[0] && namedObjects[1] && namedObjects[0].names[0]!.length > namedObjects[1].names[0]!.length)) {
          objectRef = namedObjects[0]!.referenceId;
          deterministicRepairs += 1;
        } else {
          rejections.push(rejection(input, 'claim', index, 'invalid_reference', 'relationship Claim 必须具有唯一可解析的 objectRef。', 'objectRef', claim, [...actorRefs, ...locationRefs]));
          continue;
        }
      }
      // A valid prompt-local reference is authoritative. Do not rewrite it to
      // whichever actor happens to be mentioned first in the sentence; that
      // corrupts object/recipient facts such as “指挥者命令守卫守门”.
      if (!subjectRef && !subjectText.trim()) {
        rejections.push(rejection(input, 'claim', index, 'invalid_shape', 'Claim 的 subjectRef 和 subjectText 至少一个非空。', 'subjectRef', claim));
        continue;
      }
      let episodeLocalId = claim.episodeLocalId ?? '';
      if (episodeLocalId && !episodeIds.has(episodeLocalId)) {
        const matched = episodesBySource.get(claim.sourceRef) ?? [];
        episodeLocalId = matched.length === 1 ? matched[0]!.localId : '';
        deterministicRepairs += 1;
      }
      const claimText = `${claim.content}\n${claim.evidenceExcerpt}`;
      const allowedOwnerRef = (ref: string | undefined): string | undefined => {
        const value = ref?.trim();
        if (!value) return undefined;
        if (actorRefs.has(value) || ['world', 'narrator', 'player'].includes(value)) return value;
        const repaired = repairPromptEntityReference(value, claimText, actorNamesByRef);
        if (repaired) deterministicRepairs += 1;
        return repaired;
      };
      const allowedOwnerRefs = (refs: readonly string[]): string[] => {
        const resolved = refs.map(allowedOwnerRef).filter((value): value is string => Boolean(value));
        if (resolved.length !== refs.length) deterministicRepairs += refs.length - resolved.length;
        return unique(resolved);
      };
      const speakerRef = allowedOwnerRef(claim.knowledge.speakerRef);
      const viewpointRef = allowedOwnerRef(claim.knowledge.viewpointRef);
      let ownerRefs = allowedOwnerRefs(claim.knowledge.ownerRefs);
      const requiresSpeaker = claim.knowledge.privacy === 'private'
        || claim.knowledge.privacy === 'secret'
        || claim.knowledge.mode === 'self_reported'
        || claim.knowledge.mode === 'heard';
      if (requiresSpeaker && !speakerRef) {
        rejections.push(rejection(input, 'claim', index, 'invalid_reference', '私密、自述或听闻 Claim 必须具有可解析的 speakerRef。', 'knowledge.speakerRef', claim, [...actorRefs, 'player']));
        continue;
      }
      if ((claim.knowledge.privacy === 'private' || claim.knowledge.privacy === 'secret') && speakerRef) {
        ownerRefs = unique([speakerRef, ...ownerRefs]);
      }
      const knowledge = {
        ...claim.knowledge,
        ownerRefs,
        speakerRef,
        viewpointRef,
        observerRefs: allowedOwnerRefs(claim.knowledge.observerRefs),
        presentRefs: allowedOwnerRefs(claim.knowledge.presentRefs),
        mentionedRefs: allowedOwnerRefs(claim.knowledge.mentionedRefs),
      };
      if (claimLocalIds.has(claim.localId)) {
        rejections.push(rejection(input, 'claim', index, 'duplicate_proposal', 'Claim localId 在同一 Capture 中重复。', 'localId', claim));
        continue;
      }
      claimLocalIds.add(claim.localId);
      claims.push({
        ...claim,
        subjectRef: subjectRef || undefined,
        subjectText: subjectText.trim() || undefined,
        objectRef: objectRef || undefined,
        objectText: objectText.trim() || undefined,
        episodeLocalId: episodeLocalId || undefined,
        knowledge,
      });
    }

    return { actorCandidates, locationCandidates, episodes, claims, rejections, deterministicRepairs };
  }

  private async extractAndRepair(
    input: MultiActorCaptureInput,
    sources: readonly SourceBlock[],
    writableSourceRefs: ReadonlySet<string>,
    knownActors: readonly KnownActorContextItem[],
    knownLocations: readonly KnownLocationContextItem[],
  ): Promise<{ prepared: PreparedCapture; structured: StructuredCaptureResult }> {
    const extractionInput = {
      chatKey: input.chatKey,
      sources,
      writableSourceRefs: [...writableSourceRefs],
      knownActorContext: knownActors,
      knownLocationContext: knownLocations,
      ...(input.existingMemoryContext ? { existingMemoryContext: input.existingMemoryContext } : {}),
      ...(input.graphLlmRelationEnabled === undefined ? {} : { graphLlmRelationEnabled: input.graphLlmRelationEnabled }),
      ...(input.repairRequest ? { repairRequest: input.repairRequest } : {}),
    };
    const rawExtracted = await this.extractor.extract(extractionInput);
    const extracted = input.repairRequest
      ? restrictCaptureToRepairRequest(rawExtracted, input.repairRequest)
      : rawExtracted;
    // Deterministic enrichment belongs to ordinary Capture only. A targeted
    // repair must not discover or write unrelated Claims from the same source.
    const deterministicClaims = input.repairRequest ? [] : extractExplicitDirectiveClaims(
      sources,
      writableSourceRefs,
      knownActors,
      extracted.claims,
    );
    const first: StructuredCaptureResult = deterministicClaims.length === 0 ? extracted : {
      ...extracted,
      claims: [...extracted.claims, ...deterministicClaims],
      diagnostics: {
        ...extracted.diagnostics,
        deterministicRepairs: (extracted.diagnostics?.deterministicRepairs ?? 0) + deterministicClaims.length,
      },
    };
    const firstPrepared = this.prepare(input, first, sources, writableSourceRefs, knownActors, knownLocations);
    const firstPassUnresolved = firstPrepared.rejections
      .filter(item => (item.status ?? 'unresolved') === 'unresolved');
    if (input.repairRequest || firstPassUnresolved.length === 0) return { prepared: firstPrepared, structured: first };

    const repairRequest: CaptureRepairRequest = {
      items: firstPassUnresolved.map(item => ({
        rejectionId: item.id ?? `rejection:${item.index}`,
        recordType: (item.recordType ?? 'claim') as 'actor' | 'location' | 'episode' | 'claim',
        localId: String(item.candidateSnapshot?.localId ?? ''),
        code: item.code,
        ...(item.fieldPath ? { fieldPath: item.fieldPath } : {}),
        message: item.message,
        ...(item.candidateSnapshot ? { candidateSnapshot: item.candidateSnapshot } : {}),
      })).filter(item => item.localId),
    };
    if (repairRequest.items.length === 0) return { prepared: firstPrepared, structured: first };
    let repair: StructuredCaptureResult;
    try {
      repair = await this.extractor.extract({ ...extractionInput, repairRequest });
    } catch {
      return { prepared: firstPrepared, structured: first };
    }
    const allowedRepairIds = new Set(repairRequest.items.map(item => `${item.recordType}:${item.localId}`));
    const repairedActors = repair.actorCandidates.filter(item => allowedRepairIds.has(`actor:${item.localId}`));
    const repairedLocations = repair.locationCandidates.filter(item => allowedRepairIds.has(`location:${item.localId}`));
    const repairedEpisodes = repair.episodes.filter(item => allowedRepairIds.has(`episode:${item.localId}`));
    const repairedClaims = repair.claims.filter(item => allowedRepairIds.has(`claim:${item.localId}`));
    const merged: StructuredCaptureResult = {
      actorCandidates: mergeByLocalId(firstPrepared.actorCandidates, repairedActors),
      locationCandidates: mergeByLocalId(firstPrepared.locationCandidates, repairedLocations),
      episodes: mergeByLocalId(firstPrepared.episodes, repairedEpisodes),
      claims: mergeByLocalId(firstPrepared.claims, repairedClaims),
      diagnostics: {
        ...first.diagnostics,
        automaticRepairCalls: (first.diagnostics?.automaticRepairCalls ?? 0) + 1,
        firstPassRejections: firstPassUnresolved.length,
      },
      audit: repair.audit ?? first.audit,
    };
    const prepared = this.prepare(input, merged, sources, writableSourceRefs, knownActors, knownLocations);
    const remainingUnresolved = prepared.rejections
      .filter(item => (item.status ?? 'unresolved') === 'unresolved').length;
    const repairedCount = Math.max(0, firstPassUnresolved.length - remainingUnresolved);
    merged.diagnostics = { ...merged.diagnostics, automaticallyRepaired: repairedCount };
    return { prepared, structured: merged };
  }

  async capture(input: MultiActorCaptureInput): Promise<MultiActorCaptureResult> {
    const encodedChatKey = encodeURIComponent(input.chatKey);
    const sources = filterSourceBlocks(
      input.sources.filter(source => source.chatKey === input.chatKey && source.content.trim()),
      { includeInvisibleHistory: input.includeInvisibleHistory === true },
    );
    const sourceIds = new Set(sources.map(source => source.id));
    const writableSourceRefs = new Set(
      input.writableSourceRefs === undefined
        ? sourceIds
        : input.writableSourceRefs.filter(sourceRef => sourceIds.has(sourceRef)),
    );
    // 定向修复同样需要可信目录来解析被选中的人物和地点；模型输出仍会
    // 由 repairRequest 按 recordType + localId 严格过滤，不会扩展修复范围。
    this.discoverTrustedDirectories(sources.filter(source => writableSourceRefs.has(source.id)));
    const knownActors = this.actorDirectory(sources);
    const knownLocations = this.locationDirectory(sources);
    const actorIdByPromptRef = new Map(knownActors.filter(item => item.ownerId).map(item => [item.referenceId, item.ownerId!]));
    const locationIdByPromptRef = new Map(knownLocations.filter(item => item.locationId).map(item => [item.referenceId, item.locationId!]));

    let prepared: PreparedCapture;
    let structured: StructuredCaptureResult;
    try {
      ({ prepared, structured } = await this.extractAndRepair(input, sources, writableSourceRefs, knownActors, knownLocations));
    } catch (error) {
      throw Object.assign(new Error('memory_capture Claim 结构化请求不可用。'), {
        code: 'MEMORY_CAPTURE_LLM_UNAVAILABLE',
        cause: error,
      });
    }

    const acceptedLocalIds: Record<'actor' | 'location' | 'episode' | 'claim', string[]> = {
      actor: [], location: [], episode: [], claim: [],
    };
    const ownerIdByRef = new Map(actorIdByPromptRef);
    const locationIdByRef = new Map(locationIdByPromptRef);
    const acceptedActorCandidates: ActorCandidate[] = [];
    const acceptedLocationCandidates: LocationCandidate[] = [];

    for (const candidate of prepared.actorCandidates) {
      const existing = this.registry.resolveMention(candidate.displayName);
      const resolution = existing?.owner.kind === 'actor' && existing.owner.status === 'confirmed' && !existing.ambiguous
        ? this.registry.discover({
          displayName: existing.owner.canonicalName ?? existing.owner.displayName,
          aliases: unique([...candidate.aliases, candidate.displayName]),
          sourceRef: candidate.sourceRef,
          sourceType: 'message',
          excerpt: candidate.evidenceExcerpt,
          confidence: candidate.confidence,
          confirmed: true,
        })
        : this.registry.discoverCandidate({
          localId: candidate.localId,
          displayName: candidate.displayName,
          aliases: candidate.aliases,
          sourceRefs: [candidate.sourceRef],
          evidenceExcerpts: [candidate.evidenceExcerpt],
          confidence: candidate.confidence,
          status: 'pending',
        });
      ownerIdByRef.set(candidate.localId, resolution.owner.id);
      acceptedLocalIds.actor.push(candidate.localId);
      if (resolution.method === 'pending' || resolution.owner.status === 'pending') {
        acceptedActorCandidates.push({
          localId: candidate.localId,
          displayName: candidate.displayName,
          aliases: candidate.aliases,
          sourceRefs: [candidate.sourceRef],
          evidenceExcerpts: [candidate.evidenceExcerpt],
          confidence: candidate.confidence,
          status: 'pending',
          ownerRef: resolution.owner.id,
        });
      }
    }

    for (const candidate of prepared.locationCandidates) {
      const resolution = this.locationRegistry.discoverCandidate({
        localId: candidate.localId,
        displayName: candidate.displayName,
        aliases: candidate.aliases,
        sourceRef: candidate.sourceRef,
        evidenceExcerpt: candidate.evidenceExcerpt,
        confidence: candidate.confidence,
        status: 'pending',
      });
      locationIdByRef.set(candidate.localId, resolution.location.id);
      acceptedLocalIds.location.push(candidate.localId);
      if (resolution.location.status === 'pending') {
        acceptedLocationCandidates.push({
          localId: candidate.localId,
          displayName: candidate.displayName,
          aliases: candidate.aliases,
          sourceRef: candidate.sourceRef,
          evidenceExcerpt: candidate.evidenceExcerpt,
          confidence: candidate.confidence,
          status: 'pending',
          locationRef: resolution.location.id,
        });
      }
    }

    const resolveOwner = (ref: string | undefined): string | undefined => {
      const value = ref?.trim();
      if (!value) return undefined;
      if (value === 'world') return FIXED_OWNER_IDS.world;
      if (value === 'narrator') return FIXED_OWNER_IDS.narrator;
      if (value === 'player') return FIXED_OWNER_IDS.player;
      if (ownerIdByRef.has(value)) return ownerIdByRef.get(value);
      if (value.startsWith('owner:')) return this.registry.getOwner(value)?.id;
      const resolution = this.registry.resolveMention(value);
      return resolution && !resolution.ambiguous ? resolution.owner.id : undefined;
    };
    const resolveLocation = (ref: string | undefined): MemoryLocation | undefined => {
      const value = ref?.trim();
      if (!value) return undefined;
      const id = locationIdByRef.get(value) ?? (value.startsWith('location:') ? value : undefined);
      if (id) return this.locationRegistry.getLocation(id);
      const resolution = this.locationRegistry.resolveMention(value);
      return resolution && !resolution.ambiguous ? resolution.location : undefined;
    };

    const episodeEntries = new Map<string, MemoryEpisode>();
    for (const episode of prepared.episodes) {
      const sourceRows = episode.sourceRefs.map(ref => sources.find(source => source.id === ref)).filter((source): source is SourceBlock => Boolean(source));
      const floors = sourceRows.map(source => source.floor).filter((value): value is number => finite(value));
      const location = resolveLocation(episode.locationRef);
      const row: MemoryEpisode = {
        id: `episode:${encodedChatKey}:${promptRecordSegment(episode.localId)}:${hash(episode.sourceRefs.join('|'))}`,
        workspaceId: input.workspaceId,
        chatKey: input.chatKey,
        ...(floors.length > 0 ? { floorStart: Math.min(...floors), floorEnd: Math.max(...floors) } : {}),
        sourceRefs: episode.sourceRefs,
        participantIds: unique(episode.participantRefs.map(resolveOwner).filter((value): value is string => Boolean(value))),
        presentOwnerIds: unique(episode.presentRefs.map(resolveOwner).filter((value): value is string => Boolean(value))),
        mentionedOwnerIds: unique(episode.mentionedRefs.map(resolveOwner).filter((value): value is string => Boolean(value))),
        ...(location ? { locationId: location.id, location: location.canonicalName } : {}),
        ...(episode.storyTimeText ? { storyTimeText: episode.storyTimeText } : {}),
        occurredAt: firstSourceTime(episode.sourceRefs, sources),
        summary: episode.summary,
        createdAt: Date.now(),
      };
      episodeEntries.set(episode.localId, row);
      acceptedLocalIds.episode.push(episode.localId);
    }

    const sourceEpisode = (source: SourceBlock, claim: StructuredClaim): MemoryEpisode => {
      const localId = `source-${hash(source.id)}`;
      const current = episodeEntries.get(localId);
      if (current) return current;
      const location = resolveLocation(claim.subjectRef);
      const episode: MemoryEpisode = {
        id: `episode:${encodedChatKey}:${localId}:${hash(source.id)}`,
        workspaceId: input.workspaceId,
        chatKey: input.chatKey,
        ...(finite(source.floor) ? { floorStart: source.floor, floorEnd: source.floor } : {}),
        sourceRefs: [source.id],
        participantIds: unique([
          ...claim.knowledge.ownerRefs.map(resolveOwner),
          resolveOwner(claim.knowledge.speakerRef),
        ].filter((value): value is string => Boolean(value))),
        presentOwnerIds: unique(claim.knowledge.presentRefs.map(resolveOwner).filter((value): value is string => Boolean(value))),
        mentionedOwnerIds: unique(claim.knowledge.mentionedRefs.map(resolveOwner).filter((value): value is string => Boolean(value))),
        ...(location ? { locationId: location.id, location: location.canonicalName } : {}),
        occurredAt: source.createdAt,
        summary: `来源消息中的记忆主张：${claim.content}`.slice(0, 800),
        createdAt: Date.now(),
      };
      episodeEntries.set(localId, episode);
      return episode;
    };

    const materialized: MaterializedClaim[] = [];
    for (const [index, claim] of prepared.claims.entries()) {
      const source = sources.find(item => item.id === claim.sourceRef)!;
      const actorSubjectId = resolveOwner(claim.subjectRef);
      const locationSubject = resolveLocation(claim.subjectRef);
      const subjectResolved = Boolean(actorSubjectId || locationSubject || claim.subjectText);
      const qualityScore = claimQuality(claim, subjectResolved);
      if (qualityScore < 0.55) {
        prepared.rejections.push(rejection(
          input,
          'claim',
          index,
          'quality_below_threshold',
          `Claim 质量分 ${qualityScore.toFixed(3)} 低于 0.55，已自动忽略且未写入长期记忆。`,
          'qualityScore',
          claim,
          undefined,
          'ignored',
        ));
        continue;
      }
      const actorSubject = actorSubjectId ? this.registry.getOwner(actorSubjectId) : undefined;
      const subjectKey = actorSubject?.canonicalName ?? actorSubject?.displayName ?? locationSubject?.canonicalName ?? claim.subjectText?.trim() ?? '';
      if (!subjectKey) {
        prepared.rejections.push(rejection(input, 'claim', index, 'invalid_shape', '服务器无法解析 Claim 主体。', 'subjectRef', claim));
        continue;
      }
      const actorObjectId = resolveOwner(claim.objectRef);
      const locationObject = resolveLocation(claim.objectRef);
      const actorObject = actorObjectId ? this.registry.getOwner(actorObjectId) : undefined;
      const objectKey = actorObject?.canonicalName
        ?? actorObject?.displayName
        ?? locationObject?.canonicalName
        ?? claim.objectText?.trim()
        ?? undefined;
      const objectEntityId = actorObjectId ?? locationObject?.id;
      const canonicalKey = createCanonicalKey(subjectKey, claim.predicateKey, objectKey);
      const factId = `fact:${encodedChatKey}:${hash(`${canonicalKey}\0${claim.content}\0${claim.sourceRef}\0${claim.evidenceExcerpt}`)}`;
      const declaredOwnerIds = unique(claim.knowledge.ownerRefs.map(resolveOwner).filter((value): value is string => Boolean(value)));
      const privateKnowledge = claim.knowledge.privacy === 'private' || claim.knowledge.privacy === 'secret';
      const privateSpeakerOwnerId = privateKnowledge ? resolveOwner(claim.knowledge.speakerRef) : undefined;
      // Presence is not knowledge. For private/secret material, even a model
      // that incorrectly lists every present actor as owner/observer must be
      // constrained to the private speaker before projection creates traces.
      const ownerIds = privateKnowledge
        ? (privateSpeakerOwnerId ? [privateSpeakerOwnerId] : [])
        : declaredOwnerIds;
      const entityKeys = unique([
        subjectKey,
        ...(objectKey ? [objectKey] : []),
        ...(actorSubjectId ? [actorSubjectId] : []),
        ...(locationSubject ? [locationSubject.id] : []),
        ...(objectEntityId ? [objectEntityId] : []),
        ...ownerIds,
      ]);
      const stableAnchor = claim.stableAnchor || ['identity', 'world_rule', 'capability'].includes(claim.kind);
      const status: MemoryFact['status'] = qualityScore >= 0.75 ? 'active' : 'pending';
      const fact: MemoryFact = {
        id: factId,
        chatKey: input.chatKey,
        kind: claim.kind,
        subjectKey,
        ...(actorSubjectId ? { subjectEntityId: actorSubjectId } : locationSubject ? { subjectEntityId: locationSubject.id } : {}),
        predicateKey: claim.predicateKey,
        ...(objectKey ? { objectKey } : {}),
        ...(objectEntityId ? { objectEntityId } : {}),
        canonicalKey,
        slotKey: createFactSlotKey(subjectKey, claim.predicateKey, objectKey, claim.kind),
        content: normalizeFactContent(claim.content),
        entityKeys,
        confidence: claim.confidence,
        status,
        sourceRefs: [claim.sourceRef],
        evidenceIds: [`evidence:${factId}:${hash(`${claim.sourceRef}\0${claim.evidenceExcerpt}`)}`],
        freshestEvidenceAt: source.createdAt,
        ...(claim.kind === 'event' ? {} : { validFrom: source.createdAt }),
        ...(stableAnchor ? { stableAnchor: true } : {}),
        origin: 'automatic',
        revision: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const episode = (claim.episodeLocalId ? episodeEntries.get(claim.episodeLocalId) : undefined)
        ?? [...episodeEntries.values()].filter(item => item.sourceRefs.includes(claim.sourceRef)).at(0)
        ?? sourceEpisode(source, claim);
      const channel = observationChannel(claim, source);
      const speakerOwnerId = resolveOwner(claim.knowledge.speakerRef)
        ?? (claim.knowledge.mode === 'self_reported' ? actorSubjectId : undefined)
        ?? (channel === 'narration' ? FIXED_OWNER_IDS.narrator : FIXED_OWNER_IDS.unknown);
      const observerOwnerIds = privateKnowledge
        ? [...ownerIds]
        : unique([
          ...ownerIds,
          ...claim.knowledge.observerRefs.map(resolveOwner),
        ].filter((value): value is string => Boolean(value)));
      const observation: MemoryObservation = {
        id: `observation:${encodedChatKey}:${promptRecordSegment(claim.localId)}:${hash(claim.sourceRef)}`,
        workspaceId: input.workspaceId,
        episodeId: episode.id,
        sourceRef: claim.sourceRef,
        speakerOwnerId,
        viewpointOwnerId: resolveOwner(claim.knowledge.viewpointRef) ?? speakerOwnerId,
        observerOwnerIds,
        channel,
        privacy: claim.knowledge.privacy,
        knowledgeMode: claim.knowledge.mode,
        excerpt: claim.evidenceExcerpt,
        mentionedOwnerIds: unique(claim.knowledge.mentionedRefs.map(resolveOwner).filter((value): value is string => Boolean(value))),
        presentOwnerIds: unique(claim.knowledge.presentRefs.map(resolveOwner).filter((value): value is string => Boolean(value))),
        factLocalIds: [fact.id],
        occurredAt: source.createdAt,
        createdAt: Date.now(),
      };
      materialized.push({
        localId: claim.localId,
        fact,
        observation,
        evidenceExcerpt: claim.evidenceExcerpt,
        ownerRefs: ownerIds,
        privacy: claim.knowledge.privacy,
        knowledgeMode: claim.knowledge.mode,
        qualityScore,
      });
      acceptedLocalIds.claim.push(claim.localId);
    }

    const existingFacts = this.repository ? await this.repository.listFacts() : [];
    const factsBySlot = new Map<string, MemoryFact[]>();
    const upsertSlotFact = (slotKey: string, fact: MemoryFact): void => {
      const rows = factsBySlot.get(slotKey) ?? [];
      const index = rows.findIndex(row => row.id === fact.id);
      if (index >= 0) rows[index] = fact;
      else rows.push(fact);
      factsBySlot.set(slotKey, rows);
    };
    for (const fact of existingFacts.filter(item => item.status === 'active' || item.status === 'pending')) {
      upsertSlotFact(fact.slotKey ?? createFactSlotKey(fact.subjectKey, fact.predicateKey, fact.objectKey, fact.kind), fact);
    }
    const reconciledFacts: MemoryFact[] = [];
    const evidenceRows = new Map<string, Record<string, unknown>>();
    const observationRows = new Map<string, MemoryObservation>();
    const addEvidenceAndObservation = (fact: MemoryFact, item: MaterializedClaim): void => {
      const sourceRef = item.fact.sourceRefs[0]!;
      const evidenceId = `evidence:${fact.id}:${hash(`${sourceRef}\0${item.evidenceExcerpt}`)}`;
      evidenceRows.set(evidenceId, {
        id: evidenceId,
        factId: fact.id,
        workspaceId: input.workspaceId,
        chatKey: input.chatKey,
        sourceRef,
        excerpt: item.evidenceExcerpt,
        occurredAt: item.fact.freshestEvidenceAt,
        createdAt: Date.now(),
      });
      observationRows.set(item.observation.id, { ...item.observation, factLocalIds: [fact.id] });
    };
    for (const item of materialized) {
      const slotKey = item.fact.slotKey
        ?? createFactSlotKey(item.fact.subjectKey, item.fact.predicateKey, item.fact.objectKey, item.fact.kind);
      const candidates = factsBySlot.get(slotKey) ?? [];
      // Append-only slots can contain many historical rows. Search all of them
      // for an exact duplicate before selecting the mutable state head.
      const duplicate = candidates.find(candidate => decideFactReconciliation(candidate, item.fact) === 'duplicate');
      const existing = duplicate ?? [...candidates].sort((left, right) =>
        Number(right.status === 'active') - Number(left.status === 'active')
        || right.freshestEvidenceAt - left.freshestEvidenceAt
        || right.updatedAt - left.updatedAt
        || left.id.localeCompare(right.id))[0];
      const decision = decideFactReconciliation(existing, item.fact);
      if (decision === 'duplicate' && existing) {
        const evidenceId = `evidence:${existing.id}:${hash(`${item.fact.sourceRefs[0]}\0${item.evidenceExcerpt}`)}`;
        const alreadyStored = existing.evidenceIds.includes(evidenceId) && existing.sourceRefs.includes(item.fact.sourceRefs[0]!);
        if (alreadyStored) continue;
        const merged: MemoryFact = {
          ...existing,
          sourceRefs: unique([...existing.sourceRefs, ...item.fact.sourceRefs]),
          evidenceIds: unique([...existing.evidenceIds, evidenceId]),
          freshestEvidenceAt: Math.max(existing.freshestEvidenceAt, item.fact.freshestEvidenceAt),
          revision: existing.revision + 1,
          updatedAt: Date.now(),
        };
        upsertSlotFact(slotKey, merged);
        reconciledFacts.push(merged);
        addEvidenceAndObservation(merged, item);
        continue;
      }
      if (decision === 'supersede' && existing) {
        const superseded: MemoryFact = { ...existing, status: 'superseded', supersededById: item.fact.id, revision: existing.revision + 1, updatedAt: Date.now() };
        const incoming: MemoryFact = { ...item.fact, supersedesId: existing.id };
        reconciledFacts.push(superseded, incoming);
        upsertSlotFact(slotKey, superseded);
        upsertSlotFact(slotKey, incoming);
        addEvidenceAndObservation(incoming, item);
        continue;
      }
      const incoming = decision === 'pending' ? { ...item.fact, status: 'pending' as const } : item.fact;
      reconciledFacts.push(incoming);
      upsertSlotFact(slotKey, incoming);
      addEvidenceAndObservation(incoming, item);
    }

    const facts = [...new Map(reconciledFacts.map(fact => [fact.id, fact])).values()];
    // A predecessor can be created and superseded inside the same Capture
    // window. Keep its observation so the actor receives a historical trace;
    // an older persisted predecessor submitted only for a status update has no
    // new observation and therefore still creates no artificial trace.
    const persistedFactIds = new Set(facts.filter(fact => fact.status !== 'invalid').map(fact => fact.id));
    const observations = [...observationRows.values()]
      .filter(observation => observation.factLocalIds.some(factId => persistedFactIds.has(factId)));
    const explicitEpisodeIds = new Set(prepared.episodes
      .map(item => episodeEntries.get(item.localId)?.id)
      .filter((value): value is string => Boolean(value)));
    const episodes = [...episodeEntries.values()].filter(episode =>
      explicitEpisodeIds.has(episode.id)
      || observations.some(observation => observation.episodeId === episode.id));
    const projection = this.projector.project({
      workspaceId: input.workspaceId,
      facts,
      episodes,
      observations,
      owners: this.registry.listOwners(),
    });
    const cast = new ActiveCastResolver(this.registry).resolve(sources, { currentFloor: input.currentFloor, sceneEpoch: input.sceneEpoch }).scene;
    const envelope: CaptureEnvelope = {
      workspaceId: input.workspaceId,
      chatKey: input.chatKey,
      // Audit/progress coverage must represent sources that were allowed to
      // create records. Overlap/context rows were visible to the model but are
      // not committed by this ChangeSet and must not make coverage look wider
      // than it really is.
      sourceRefs: sources.filter(source => writableSourceRefs.has(source.id)).map(source => source.id),
      actorCandidates: acceptedActorCandidates,
      locationCandidates: acceptedLocationCandidates,
      episodes: prepared.episodes.map(item => ({ ...episodeEntries.get(item.localId)!, localId: item.localId })),
      claimLocalIds: [...acceptedLocalIds.claim],
      capturedAt: Date.now(),
    };
    const unresolved = prepared.rejections.filter(item => (item.status ?? 'unresolved') === 'unresolved');
    const outcome = unresolved.length > 0 ? 'partial' as const : 'complete' as const;
    let changeAudit: import('../../infrastructure').ChangeAudit | undefined;
    if (this.repository) {
      changeAudit = await this.repository.commitCapture({
        envelope,
        ...(input.captureJobId ? { captureJobId: input.captureJobId } : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        ...(input.parentChangeSetId ? { parentChangeSetId: input.parentChangeSetId } : {}),
        outcome,
        rejections: prepared.rejections,
        owners: this.registry.listOwners(),
        aliases: this.registry.listAliases(),
        pendingCandidates: this.registry.listPending(),
        locations: this.locationRegistry.listLocations(),
        locationAliases: this.locationRegistry.listAliases(),
        pendingLocationCandidates: this.locationRegistry.listPending(),
        episodes,
        observations,
        facts,
        evidence: [...evidenceRows.values()],
        traces: projection.traces,
        sceneCasts: [cast],
      });
    }
    return {
      envelope,
      owners: this.registry.listOwners(),
      pendingCandidates: this.registry.listPending(),
      locations: this.locationRegistry.listLocations(),
      locationAliases: this.locationRegistry.listAliases(),
      pendingLocationCandidates: this.locationRegistry.listPending(),
      episodes,
      observations,
      facts,
      traces: projection.traces,
      sceneCast: cast,
      diagnostics: {
        ...structured.diagnostics,
        deterministicRepairs: (structured.diagnostics?.deterministicRepairs ?? 0) + prepared.deterministicRepairs,
      },
      audit: structured.audit,
      outcome,
      rejections: prepared.rejections,
      acceptedLocalIds,
      ...(changeAudit ? { changeAudit } : {}),
    };
  }
}
