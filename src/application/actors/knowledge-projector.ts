import { FIXED_OWNER_IDS, type ActorMemoryTrace, type MemoryEpisode, type MemoryFactKind, type MemoryKnowledgeMode, type MemoryObservation, type MemoryOwner, type MemoryPrivacy } from '../../domain';
import type { MemoryFact } from '../../domain';

export interface ProjectionInput {
  readonly workspaceId: string;
  readonly facts: readonly MemoryFact[];
  readonly episodes: readonly MemoryEpisode[];
  readonly observations: readonly MemoryObservation[];
  readonly owners?: readonly MemoryOwner[];
}

export interface ProjectionDecision {
  readonly factId: string;
  readonly ownerId: string;
  readonly mode: MemoryKnowledgeMode;
  readonly privacy: MemoryPrivacy;
  readonly reason: 'world-canon' | 'self-report' | 'heard' | 'experienced' | 'private-thought' | 'rumor' | 'inference';
  readonly observationIds: readonly string[];
}

export interface ProjectionResult {
  readonly traces: readonly ActorMemoryTrace[];
  readonly decisions: readonly ProjectionDecision[];
}

const clamp = (value: number): number => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
const clamp01 = (value: number): number => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const normalizedSalience = (value: number): number => clamp01(value > 1 ? value / 100 : value);

function traceId(ownerId: string, factId: string): string { return `trace:${ownerId}:${factId}`; }
function addUnique(values: readonly string[], value: string): string[] { return values.includes(value) ? [...values] : [...values, value]; }

function isWorldSource(observation: MemoryObservation): boolean {
  return observation.channel === 'worldbook' || observation.channel === 'state';
}

/** Converts source-grounded observations into one trace per permitted owner. */
export class KnowledgeProjector {
  project(input: ProjectionInput): ProjectionResult {
    const traces: ActorMemoryTrace[] = [];
    const decisions: ProjectionDecision[] = [];
    const observationsByFact = new Map<string, MemoryObservation[]>();
    const episodeById = new Map(input.episodes.map(episode => [episode.id, episode]));
    for (const observation of input.observations) {
      for (const factId of observation.factLocalIds) {
        const list = observationsByFact.get(factId) ?? [];
        list.push(observation);
        observationsByFact.set(factId, list);
      }
    }
    const timestamp = Date.now();
    for (const fact of input.facts) {
      // Historical predecessors remain queryable and keep their prior traces,
      // but a new Capture must not manufacture an `unknown` trace merely
      // because the superseded record is included in the reconciliation set.
      if (fact.status === 'superseded' || fact.status === 'invalid') continue;
      const observations = observationsByFact.get(fact.id) ?? [];
      const ownerModes = new Map<string, { mode: MemoryKnowledgeMode; privacy: MemoryPrivacy; reason: ProjectionDecision['reason']; observations: string[] }>();
      // `world_rule` is a semantic label, not proof of canon.  A character's
      // speech may describe a rule, a rumour or a mistaken belief.  Only an
      // explicitly scoped host-card/world/state observation can seed the World
      // owner; all other propositions remain owner-local.
      const worldScoped = Boolean(fact.scope?.hostCardKeys?.length || fact.scope?.worldKeys?.length)
        || observations.some(isWorldSource);
      // A card/worldbook may explicitly name one in-world owner. That owner can
      // receive a seed trace for profile bootstrapping, but the fact is never
      // broadcast to every actor merely because it came from metadata.
      // Entity references in an ordinary message describe who/what a fact is
      // about; they do not prove that the referenced actor knows it. Only a
      // card/world/state fact may explicitly seed a bounded actor trace.
      const explicitOwners = worldScoped
        ? new Set<string>(fact.entityKeys.filter(key => key.startsWith('owner:') && key !== FIXED_OWNER_IDS.world && key !== FIXED_OWNER_IDS.narrator && key !== FIXED_OWNER_IDS.player && key !== FIXED_OWNER_IDS.unknown))
        : new Set<string>();
      const add = (ownerId: string, mode: MemoryKnowledgeMode, privacy: MemoryPrivacy, reason: ProjectionDecision['reason'], observationIds: readonly string[]): void => {
        if (!ownerId) return;
        const current = ownerModes.get(ownerId);
        const rank: Record<MemoryKnowledgeMode, number> = { unknown: 0, suspected: 1, believed: 2, inferred: 3, heard: 4, experienced: 5, self_reported: 6, asserted: 7 };
        if (!current || rank[mode] > rank[current.mode]) ownerModes.set(ownerId, { mode, privacy, reason, observations: [...observationIds] });
        else current.observations = addUnique(current.observations, observationIds[0] ?? '');
      };
      const observationFloors = observations
        .map(observation => episodeById.get(observation.episodeId)?.floorEnd ?? episodeById.get(observation.episodeId)?.floorStart)
        .filter((floor): floor is number => Number.isFinite(floor));
      const floor = observationFloors.length > 0 ? Math.max(...observationFloors) : undefined;

      if (worldScoped) {
        add(FIXED_OWNER_IDS.world, 'asserted', 'public', 'world-canon', observations.map(observation => observation.id));
        for (const ownerId of explicitOwners) add(ownerId, 'asserted', 'limited', 'experienced', observations.map(observation => observation.id));
      }
      if (worldScoped) {
        // Canonical card/world/state facts are available to World/Narrator as
        // provenance, but are never implicitly broadcast through a character
        // observation in the same Capture.
        for (const [ownerId, value] of ownerModes.entries()) {
          const baseStrength = value.mode === 'asserted' ? 90 : 25;
          const trace: ActorMemoryTrace = {
            id: traceId(ownerId, fact.id), workspaceId: input.workspaceId, ownerId, factId: fact.id,
            sourceObservationIds: [...new Set(value.observations.filter(Boolean))], knowledgeMode: value.mode, privacy: value.privacy,
            strength: clamp(baseStrength * (0.7 + clamp01(fact.confidence) * 0.3)), clarity: clamp(baseStrength),
            beliefConfidence: clamp01(fact.confidence), emotionalSalience: normalizedSalience(Number((fact as MemoryFact & { emotionalSalience?: number }).emotionalSalience ?? 0)),
            rehearsalCount: 0, traceRevision: 1, ...(floor === undefined ? {} : { floor }), createdAt: timestamp, updatedAt: timestamp,
          };
          traces.push(trace);
          decisions.push({ factId: fact.id, ownerId, mode: value.mode, privacy: value.privacy, reason: value.reason, observationIds: trace.sourceObservationIds });
        }
        continue;
      }
      for (const observation of observations) {
        // Worldbook/state observations establish the World trace only. They
        // are source-of-canon evidence, not a hearing event for every owner
        // listed by an upstream parser.
        if (isWorldSource(observation)) continue;
        const observationIds = [observation.id];
        if (observation.channel === 'private_thought' || observation.privacy === 'private' || observation.privacy === 'secret') {
          add(observation.speakerOwnerId, 'experienced', observation.privacy, 'private-thought', observationIds);
          continue;
        }
        if (observation.channel === 'rumor' || observation.knowledgeMode === 'believed' || observation.knowledgeMode === 'suspected') {
          const mode = observation.knowledgeMode === 'suspected' ? 'suspected' : 'believed';
          const recipients = [...new Set([observation.speakerOwnerId, ...observation.observerOwnerIds])];
          for (const ownerId of recipients) add(ownerId, mode, observation.privacy, 'rumor', observationIds);
          continue;
        }
        if (observation.channel === 'inference' || observation.knowledgeMode === 'inferred') {
          const recipients = [...new Set([observation.speakerOwnerId, ...observation.observerOwnerIds])];
          for (const ownerId of recipients) add(ownerId, 'inferred', observation.privacy, 'inference', observationIds);
          continue;
        }
        if (observation.channel === 'public_speech') {
          add(observation.speakerOwnerId, 'self_reported', observation.privacy, 'self-report', observationIds);
          const present = new Set(observation.presentOwnerIds);
          for (const ownerId of observation.observerOwnerIds.filter(id => present.has(id))) {
            if (ownerId !== observation.speakerOwnerId) add(ownerId, 'heard', observation.privacy, 'heard', observationIds);
          }
        } else if (observation.channel === 'narration') {
          // A narrator's account is retained by Narrator only. The mentioned
          // actor is not silently granted first-hand knowledge by the prose.
          add(FIXED_OWNER_IDS.narrator, 'asserted', observation.privacy, 'experienced', observationIds);
        } else {
          for (const ownerId of observation.observerOwnerIds) add(ownerId, 'experienced', observation.privacy, 'experienced', observationIds);
        }
      }
      if (ownerModes.size === 0) add(FIXED_OWNER_IDS.unknown, 'unknown', 'limited', 'inference', []);

      for (const [ownerId, value] of ownerModes.entries()) {
        const baseStrength = value.mode === 'asserted' ? 90 : value.mode === 'experienced' ? 82 : value.mode === 'self_reported' ? 76 : value.mode === 'heard' ? 62 : value.mode === 'believed' ? 48 : value.mode === 'suspected' ? 35 : 25;
        const baseConfidence = clamp01(fact.confidence);
        const trace: ActorMemoryTrace = {
          id: traceId(ownerId, fact.id),
          workspaceId: input.workspaceId,
          ownerId,
          factId: fact.id,
          sourceObservationIds: [...new Set(value.observations.filter(Boolean))],
          knowledgeMode: value.mode,
          privacy: value.privacy,
          strength: clamp(baseStrength * (0.7 + baseConfidence * 0.3)),
          clarity: clamp(baseStrength),
          beliefConfidence: clamp01(baseConfidence * (value.mode === 'heard' ? 0.8 : 1)),
          emotionalSalience: normalizedSalience(Number((fact as MemoryFact & { emotionalSalience?: number }).emotionalSalience ?? 0)),
          rehearsalCount: 0,
          traceRevision: 1,
          ...(floor === undefined ? {} : { floor }),
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        traces.push(trace);
        decisions.push({ factId: fact.id, ownerId, mode: value.mode, privacy: value.privacy, reason: value.reason, observationIds: trace.sourceObservationIds });
      }
    }
    return { traces, decisions };
  }
}
