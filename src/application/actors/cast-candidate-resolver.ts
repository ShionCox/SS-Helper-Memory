import { FIXED_OWNER_IDS, type GenerationCastCandidate, type MemoryEpisode, type SceneState, type CastPlanReasonCode } from '../../domain';
import type { SourceBlock } from '../ingest/types';
import { ActorRegistry } from './actor-registry';

export interface CastCandidateResolutionInput {
  readonly userMessage: string;
  readonly currentFloor: number;
  readonly sceneState: SceneState;
  readonly sources: readonly SourceBlock[];
  readonly episodes?: readonly MemoryEpisode[];
  readonly hostSelectedOwnerId?: string;
  readonly locationOwnerIds?: readonly string[];
  readonly goalOwnerIds?: readonly string[];
  readonly focusLookbackFloors?: number;
  readonly actorScanLookbackFloors?: number;
}

export interface CastCandidateResolution {
  readonly candidates: readonly GenerationCastCandidate[];
  readonly explicitAddressOwnerIds: readonly string[];
  readonly directFollowUp: boolean;
  readonly confidence: number;
}

function unique(values: Iterable<string>): string[] { return [...new Set([...values].filter(Boolean))]; }
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }

function namesFor(registry: ActorRegistry, ownerId: string): string[] {
  const owner = registry.getOwner(ownerId);
  if (!owner) return [];
  return unique([owner.displayName, owner.canonicalName ?? '', ...owner.aliases, ...registry.listAliases().filter(alias => alias.ownerId === ownerId).map(alias => alias.value)]);
}

function namePresent(text: string, names: readonly string[]): boolean {
  return names.some(name => name && text.includes(name));
}

function explicitlyAddressed(text: string, names: readonly string[]): boolean {
  return names.some(name => {
    if (!name) return false;
    const escaped = escapeRegex(name);
    return new RegExp(`(?:^|[\\s，,。！？!?])${escaped}(?:[\\s，,：:]|你|您|请|能否|可以|告诉|回答|觉得|怎么看)`, 'u').test(text);
  });
}

function activeEpisodeOwners(episodes: readonly MemoryEpisode[], currentFloor: number): Set<string> {
  const latest = [...episodes]
    .filter(episode => (episode.floorStart ?? currentFloor) <= currentFloor && (episode.floorEnd ?? currentFloor) >= currentFloor - 2)
    .sort((left, right) => (right.floorEnd ?? right.floorStart ?? 0) - (left.floorEnd ?? left.floorStart ?? 0))[0];
  return new Set(latest?.participantIds ?? []);
}

/** Builds a deterministic candidate set; it never opens private memory. */
export class CastCandidateResolver {
  constructor(private readonly registry: ActorRegistry) {}

  resolve(input: CastCandidateResolutionInput): CastCandidateResolution {
    const focusLookback = Math.max(1, Math.trunc(input.focusLookbackFloors ?? 4));
    const scanLookback = Math.max(focusLookback, Math.trunc(input.actorScanLookbackFloors ?? 12));
    const recentFocus = input.sources.filter(source => (source.floor ?? 0) >= input.currentFloor - focusLookback);
    const recentScan = input.sources.filter(source => (source.floor ?? 0) >= input.currentFloor - scanLookback);
    const episodeOwners = activeEpisodeOwners(input.episodes ?? [], input.currentFloor);
    const recentText = recentScan.map(source => source.content).join('\n');
    const explicitAddressOwnerIds: string[] = [];
    const rows: GenerationCastCandidate[] = [];
    const knownOwnerIds = unique([
      ...this.registry.listOwners().filter(owner => owner.kind === 'actor').map(owner => owner.id),
      input.hostSelectedOwnerId ?? '',
      input.sceneState.viewpointOwnerId ?? '',
      ...input.sceneState.presentOwnerIds,
      ...input.sceneState.nearbyOwnerIds,
      ...input.sceneState.mentionedOwnerIds,
      ...input.sceneState.exitedOwnerIds,
      ...episodeOwners,
      ...(input.locationOwnerIds ?? []),
      ...(input.goalOwnerIds ?? []),
    ]);
    for (const ownerId of knownOwnerIds) {
      if ([FIXED_OWNER_IDS.world, FIXED_OWNER_IDS.narrator, FIXED_OWNER_IDS.player, FIXED_OWNER_IDS.unknown].includes(ownerId as never)) continue;
      const owner = this.registry.getOwner(ownerId);
      if (!owner || owner.kind !== 'actor' || owner.status === 'merged') continue;
      const names = namesFor(this.registry, ownerId);
      const hostSelected = ownerId === input.hostSelectedOwnerId;
      const explicit = explicitlyAddressed(input.userMessage, names);
      if (explicit) explicitAddressOwnerIds.push(ownerId);
      const viewpoint = ownerId === input.sceneState.viewpointOwnerId;
      const present = input.sceneState.presentOwnerIds.includes(ownerId);
      const recentSpeaker = input.sceneState.recentSpeakerOwnerIds.includes(ownerId)
        || recentFocus.some(source => source.perspective?.speakerOwnerRef && names.includes(source.perspective.speakerOwnerRef));
      const eventParticipant = episodeOwners.has(ownerId);
      const locationRelation = input.locationOwnerIds?.includes(ownerId) ?? false;
      const mentioned = input.sceneState.mentionedOwnerIds.includes(ownerId) || namePresent(recentText, names);
      const exited = input.sceneState.exitedOwnerIds.includes(ownerId);
      const reasons: CastPlanReasonCode[] = [];
      let score = 0;
      const add = (condition: boolean, value: number, reason: CastPlanReasonCode): void => { if (condition) { score += value; reasons.push(reason); } };
      add(hostSelected, 1, 'host_selected');
      add(explicit, 0.95, 'explicit_address');
      add(viewpoint, 0.9, 'current_viewpoint');
      add(present, 0.8, 'scene_presence');
      add(recentSpeaker, 0.65, 'recent_speaker');
      add(eventParticipant, 0.5, 'current_event_participant');
      add(locationRelation, 0.35, 'location_relation');
      add(mentioned && !present && !explicit, 0.1, 'mentioned_only');
      add(exited, -1, 'explicit_exit');
      const mentionedOnly = mentioned && !present && !viewpoint && !recentSpeaker && !explicit && !hostSelected;
      rows.push({
        ownerId,
        displayName: owner.displayName,
        score: Math.max(-1, Math.min(1, score)),
        reasonCodes: unique(reasons) as CastPlanReasonCode[],
        sourceRefs: unique(recentScan.filter(source => names.some(name => source.content.includes(name))).map(source => source.id)),
        explicitlyAddressed: explicit,
        hostSelected,
        viewpoint,
        present,
        mentionedOnly,
        exited,
      });
    }
    const candidates = rows.sort((left, right) => Number(left.exited) - Number(right.exited) || right.score - left.score || left.ownerId.localeCompare(right.ownerId));
    const directFollowUp = explicitAddressOwnerIds.length === 0
      && recentFocus.length > 0
      && /^(?:继续|然后呢|为什么|怎么了|真的吗|是吗|那呢|所以呢|你呢|嗯|好|可以|不行)[？?。！!…]*$/u.test(input.userMessage.trim());
    const top = candidates.filter(candidate => !candidate.exited)[0]?.score ?? 0;
    const second = candidates.filter(candidate => !candidate.exited)[1]?.score ?? 0;
    const confidence = explicitAddressOwnerIds.length === 1 || input.hostSelectedOwnerId ? 1 : Math.max(0, Math.min(1, top - Math.max(0, second) * 0.25));
    return { candidates, explicitAddressOwnerIds: unique(explicitAddressOwnerIds), directFollowUp, confidence };
  }
}
