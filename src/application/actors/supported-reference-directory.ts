import { normalizeActorName, normalizeLocationName } from '../../domain';
import type {
  KnownActorContextItem,
  KnownLocationContextItem,
  SourceBlock,
  SupportedReferenceDirectory,
  SupportedReferenceItem,
} from '../ingest/types';

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function hash(value: string): string {
  const normalized = value.normalize('NFKC');
  const parts: string[] = [];
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

function textMentionsAny(content: string, names: readonly string[]): boolean {
  const normalizedContent = content.normalize('NFKC');
  return names.some(name =>
    Array.from(name.trim()).length >= 2
    && normalizedContent.includes(name.normalize('NFKC')));
}

function actorMetadata(source: SourceBlock): string[] {
  return unique([
    ...(source.actorRefs ?? []),
    source.author?.displayName ?? '',
    source.perspective?.speakerOwnerRef ?? '',
    source.perspective?.viewpointOwnerRef ?? '',
    ...(source.perspective?.observerOwnerRefs ?? []),
    ...(source.perspective?.presentOwnerRefs ?? []),
    ...(source.perspective?.mentionedOwnerRefs ?? []),
    ...(source.transition?.enteredOwnerRefs ?? []),
    ...(source.transition?.exitedOwnerRefs ?? []),
    ...(source.transition?.nearbyOwnerRefs ?? []),
  ]);
}

function locationMetadata(source: SourceBlock): string[] {
  return unique([...(source.locationRefs ?? []), ...(source.transition?.locationKeys ?? [])]);
}

function supportedActor(
  actor: KnownActorContextItem,
  sources: readonly SourceBlock[],
): SupportedReferenceItem | undefined {
  const aliases = unique([actor.canonicalName, ...actor.aliases]);
  const normalizedAliases = aliases.map(normalizeActorName).filter(Boolean);
  const sourceRefs = sources.filter(source =>
    textMentionsAny(source.content, aliases)
    || actorMetadata(source).some(value =>
      value === actor.referenceId
      || value === actor.ownerId
      || normalizedAliases.includes(normalizeActorName(value))),
  ).map(source => source.id);
  if (sourceRefs.length === 0) return undefined;
  return {
    referenceId: actor.referenceId,
    canonicalName: actor.canonicalName,
    aliases: unique(actor.aliases.filter(alias => normalizeActorName(alias) !== normalizeActorName(actor.canonicalName))),
    sourceRefs: unique(sourceRefs),
  };
}

function supportedLocation(
  location: KnownLocationContextItem,
  sources: readonly SourceBlock[],
): SupportedReferenceItem | undefined {
  const aliases = unique([location.canonicalName, ...location.aliases]);
  const normalizedAliases = aliases.map(normalizeLocationName).filter(Boolean);
  const sourceRefs = sources.filter(source =>
    textMentionsAny(source.content, aliases)
    || locationMetadata(source).some(value =>
      value === location.referenceId
      || value === location.locationId
      || normalizedAliases.includes(normalizeLocationName(value))),
  ).map(source => source.id);
  if (sourceRefs.length === 0) return undefined;
  return {
    referenceId: location.referenceId,
    canonicalName: location.canonicalName,
    aliases: unique(location.aliases.filter(alias =>
      normalizeLocationName(alias) !== normalizeLocationName(location.canonicalName))),
    sourceRefs: unique(sourceRefs),
  };
}

export function buildSupportedReferenceDirectory(
  sources: readonly SourceBlock[],
  knownActors: readonly KnownActorContextItem[],
  knownLocations: readonly KnownLocationContextItem[],
): SupportedReferenceDirectory {
  const allowedActorRefs = knownActors
    .map(actor => supportedActor(actor, sources))
    .filter((item): item is SupportedReferenceItem => Boolean(item))
    .sort((left, right) => left.referenceId.localeCompare(right.referenceId));
  const allowedLocationRefs = knownLocations
    .map(location => supportedLocation(location, sources))
    .filter((item): item is SupportedReferenceItem => Boolean(item))
    .sort((left, right) => left.referenceId.localeCompare(right.referenceId));
  // Existing episode ids are batch-local and cannot be reconstructed safely
  // from a repair window alone. An empty set intentionally forces omission.
  const allowedEpisodeRefs: SupportedReferenceDirectory['allowedEpisodeRefs'] = [];
  const digestInput = {
    actors: allowedActorRefs.map(item => [item.referenceId, item.sourceRefs]),
    locations: allowedLocationRefs.map(item => [item.referenceId, item.sourceRefs]),
    episodes: allowedEpisodeRefs.map(item => [item.referenceId, item.sourceRefs]),
  };
  return {
    allowedActorRefs,
    allowedLocationRefs,
    allowedEpisodeRefs,
    candidateSetHash: hash(JSON.stringify(digestInput)),
  };
}

export function referenceDirectoryAllows(
  directory: SupportedReferenceDirectory,
  kind: 'actor' | 'location' | 'entity' | 'episode',
  referenceId: string,
): boolean {
  if (!referenceId) return true;
  if (kind !== 'location' && kind !== 'episode' && ['world', 'narrator', 'player'].includes(referenceId)) return true;
  if (kind === 'actor') return directory.allowedActorRefs.some(item => item.referenceId === referenceId);
  if (kind === 'location') return directory.allowedLocationRefs.some(item => item.referenceId === referenceId);
  if (kind === 'episode') return directory.allowedEpisodeRefs.some(item => item.referenceId === referenceId);
  return directory.allowedActorRefs.some(item => item.referenceId === referenceId)
    || directory.allowedLocationRefs.some(item => item.referenceId === referenceId);
}
