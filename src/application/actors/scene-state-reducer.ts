import { FIXED_OWNER_IDS, sceneStateRecordId, type SceneCast, type SceneState, type SceneTransition, type SceneTransitionReason } from '../../domain';
import type { SourceBlock } from '../ingest/types';
import { ActorRegistry } from './actor-registry';
import { ActiveCastResolver } from './active-cast-resolver';

export interface SceneStateStore {
  getSceneState(): Promise<SceneState | undefined> | SceneState | undefined;
  listSceneCasts?(): Promise<readonly SceneCast[]> | readonly SceneCast[];
  saveSceneState(state: SceneState, transition?: SceneTransition): Promise<void> | void;
}

export interface SceneStateResolutionInput {
  readonly workspaceId: string;
  readonly chatKey: string;
  readonly currentFloor: number;
  readonly sources: readonly SourceBlock[];
  readonly sceneCast?: SceneCast;
  readonly now?: number;
  readonly actorScanLookbackFloors?: number;
  readonly persistPresenceUntilTransition?: boolean;
  /** Generation preparation computes first and commits atomically after scope validation. */
  readonly persist?: boolean;
  readonly correction?: {
    readonly presentOwnerIds?: readonly string[];
    readonly nearbyOwnerIds?: readonly string[];
    readonly exitedOwnerIds?: readonly string[];
    readonly locationKeys?: readonly string[];
    readonly viewpointOwnerId?: string;
  };
}

export interface SceneStateResolution {
  readonly state: SceneState;
  readonly transition?: SceneTransition;
  readonly sceneCast: SceneCast;
}

const ENTRY_CUE = /(?:进入|走进|来到|抵达|返回|回来|出现|推门而入|加入|跟着|赶到|现身)/u;
const EXIT_CUE = /(?:离开|走出|退出|回车上|告辞|离去|离场|消失|前往另一地点|去了别处)/u;
const TIME_JUMP_CUE = /(?:数小时后|几小时后|第二天|翌日|次日|多年后|几天后|一段时间后|时间跳转|转眼间)/u;
const SCENE_RESET_CUE = /(?:场景切换|切换场景|镜头切换|新的场景|另一边|与此同时)/u;
const GROUP_LOCATION_CUE = /(?:众人|他们|她们|我们|一行人|大家|所有人)\s*(?:一起|一同|共同)?\s*(?:进入|来到|抵达|回到|转移到)\s*([^，。！？!?\n]{1,24})/u;
const JOINT_LOCATION_CUE = /(?:一起|一同|共同)\s*(?:进入|来到|抵达|回到|转移到)\s*([^，。！？!?\n]{1,24})/u;
const SCENE_LOCATION_CUE = /(?:场景|镜头|地点)\s*(?:切换到|转到|来到|位于)\s*([^，。！？!?\n]{1,24})/u;

function unique(values: Iterable<string>): string[] {
  return [...new Set([...values].map(value => value.trim()).filter(Boolean))];
}

function sourceFloor(source: SourceBlock): number { return source.floor ?? 0; }

function actorOwnerIds(registry: ActorRegistry, values: Iterable<string>): string[] {
  return unique([...values].filter(value => registry.getOwner(value)?.kind === 'actor'));
}

function narrativeViewpoint(ownerId: string | undefined): string | undefined {
  if (!ownerId || ownerId === FIXED_OWNER_IDS.player || ownerId === FIXED_OWNER_IDS.unknown || ownerId === FIXED_OWNER_IDS.world) return undefined;
  return ownerId;
}

function sentences(value: string): string[] {
  return value.split(/[。！？!?\n]/u).map(item => item.trim()).filter(Boolean);
}

function ownerNames(registry: ActorRegistry): Array<{ ownerId: string; names: string[] }> {
  const aliases = registry.listAliases();
  return registry.listOwners()
    .filter(owner => owner.kind === 'actor')
    .map(owner => ({
      ownerId: owner.id,
      names: unique([owner.displayName, owner.canonicalName ?? '', ...owner.aliases, ...aliases.filter(alias => alias.ownerId === owner.id).map(alias => alias.value)]),
    }));
}

function resolveRef(registry: ActorRegistry, value: string): string | undefined {
  const direct = registry.getOwner(value);
  if (direct) return direct.id;
  const resolved = registry.resolveMention(value);
  return resolved && !resolved.ambiguous && resolved.owner.id !== FIXED_OWNER_IDS.unknown ? resolved.owner.id : undefined;
}

function textualTransitions(registry: ActorRegistry, sources: readonly SourceBlock[]): {
  entered: string[];
  exited: string[];
  locations: string[];
  timeJump: boolean;
  sceneReset: boolean;
  sourceRefs: string[];
} {
  const entered = new Set<string>();
  const exited = new Set<string>();
  const locations = new Set<string>();
  const sourceRefs = new Set<string>();
  let timeJump = false;
  let sceneReset = false;
  const known = ownerNames(registry);
  for (const source of sources) {
    for (const sentence of sentences(source.content)) {
      const hasEntry = ENTRY_CUE.test(sentence);
      const hasExit = EXIT_CUE.test(sentence);
      if (hasEntry || hasExit) {
        for (const owner of known) {
          if (!owner.names.some(name => name && sentence.includes(name))) continue;
          if (hasExit) exited.add(owner.ownerId);
          else if (hasEntry) entered.add(owner.ownerId);
          sourceRefs.add(source.id);
        }
      }
      const location = (sentence.match(GROUP_LOCATION_CUE)?.[1]
        ?? sentence.match(JOINT_LOCATION_CUE)?.[1]
        ?? sentence.match(SCENE_LOCATION_CUE)?.[1])
        ?.trim()
        .replace(/(?:里|内|中)$/u, '');
      if (location && location.length <= 24) {
        locations.add(location);
        sourceRefs.add(source.id);
      }
      if (TIME_JUMP_CUE.test(sentence)) { timeJump = true; sourceRefs.add(source.id); }
      if (SCENE_RESET_CUE.test(sentence)) { sceneReset = true; sourceRefs.add(source.id); }
    }
  }
  return { entered: [...entered], exited: [...exited], locations: [...locations], timeJump, sceneReset, sourceRefs: [...sourceRefs] };
}

function transitionReason(input: {
  correction: boolean;
  reset: boolean;
  timeJump: boolean;
  locationChanged: boolean;
  exited: boolean;
  entered: boolean;
}): SceneTransitionReason | undefined {
  if (input.correction) return 'user_corrected';
  if (input.reset) return 'scene_reset';
  if (input.timeJump) return 'time_jump';
  if (input.exited) return 'explicit_exit';
  if (input.locationChanged) return 'location_change';
  if (input.entered) return 'explicit_entry';
  return undefined;
}

/** Reduces recent evidence into a persistent scene without aging quiet actors out. */
export class SceneStateReducer {
  constructor(private readonly registry: ActorRegistry, private readonly store: SceneStateStore) {}

  async resolve(input: SceneStateResolutionInput): Promise<SceneStateResolution> {
    const now = input.now ?? Date.now();
    const lookback = Math.max(1, Math.trunc(input.actorScanLookbackFloors ?? 12));
    const recent = input.sources.filter(source => sourceFloor(source) >= input.currentFloor - lookback && sourceFloor(source) <= input.currentFloor);
    const sceneCast = input.sceneCast ?? new ActiveCastResolver(this.registry).resolve(recent, { currentFloor: input.currentFloor, lookbackFloors: lookback }).scene;
    const previous = await this.store.getSceneState();
    const fallbackCast = previous ? undefined : [...(await this.store.listSceneCasts?.() ?? [])]
      .filter(cast => cast.chatKey === input.chatKey)
      .sort((left, right) => right.floor - left.floor || right.createdAt - left.createdAt)[0];
    const seedCasts = previous ? [sceneCast] : [fallbackCast, sceneCast].filter((cast): cast is SceneCast => Boolean(cast));
    const textSignals = textualTransitions(this.registry, recent);
    const metadataEntered = recent.flatMap(source => source.transition?.enteredOwnerRefs ?? []).map(ref => resolveRef(this.registry, ref)).filter((id): id is string => Boolean(id));
    const metadataExited = recent.flatMap(source => source.transition?.exitedOwnerRefs ?? []).map(ref => resolveRef(this.registry, ref)).filter((id): id is string => Boolean(id));
    const metadataNearby = recent.flatMap(source => source.transition?.nearbyOwnerRefs ?? []).map(ref => resolveRef(this.registry, ref)).filter((id): id is string => Boolean(id));
    const metadataLocations = recent.flatMap(source => source.transition?.locationKeys ?? []);
    const entered = new Set(unique([
      ...textSignals.entered,
      ...metadataEntered,
      ...seedCasts.flatMap(cast => cast.presentOwnerIds),
    ]));
    const exited = new Set(unique([...textSignals.exited, ...metadataExited]));
    const correction = input.correction;
    const locationKeys = unique(correction?.locationKeys ?? (metadataLocations.length > 0 ? metadataLocations : textSignals.locations.length > 0 ? textSignals.locations : previous?.locationKeys ?? []));
    const locationChanged = Boolean(previous && locationKeys.length > 0 && JSON.stringify(locationKeys) !== JSON.stringify([...previous.locationKeys]));
    const timeJump = textSignals.timeJump || recent.some(source => source.transition?.timeJump === true);
    const reset = textSignals.sceneReset || recent.some(source => source.transition?.sceneReset === true);
    const epochChanged = locationChanged || timeJump || reset;
    const nextEpoch = (previous?.sceneEpoch ?? 0) + (epochChanged ? 1 : 0);
    const sceneId = previous && !epochChanged ? previous.sceneId : `scene:${encodeURIComponent(input.chatKey)}:${nextEpoch}`;
    const persistedPresence = input.persistPresenceUntilTransition === false ? [] : previous?.presentOwnerIds ?? [];
    const present = new Set(unique(correction?.presentOwnerIds ?? [
      ...persistedPresence,
      ...seedCasts.flatMap(cast => cast.presentOwnerIds),
      ...entered,
    ]));
    for (const ownerId of exited) present.delete(ownerId);
    const nearby = new Set(unique(correction?.nearbyOwnerIds ?? [...(previous?.nearbyOwnerIds ?? []), ...metadataNearby]));
    for (const ownerId of present) nearby.delete(ownerId);
    for (const ownerId of exited) nearby.delete(ownerId);
    const exitedOwners = new Set(unique(correction?.exitedOwnerIds ?? [...(previous?.exitedOwnerIds ?? []), ...exited]));
    for (const ownerId of entered) exitedOwners.delete(ownerId);
    const speakerWindow = recent.filter(source => sourceFloor(source) >= input.currentFloor - 4);
    const recentCast = new ActiveCastResolver(this.registry).resolve(speakerWindow, { currentFloor: input.currentFloor, lookbackFloors: 4 }).scene;
    const recentActorSpeakers = actorOwnerIds(this.registry, sceneCast.speakerOwnerIds);
    const resolvedViewpoint = correction?.viewpointOwnerId
      ?? narrativeViewpoint(sceneCast.viewpointOwnerId)
      ?? recentActorSpeakers.at(-1)
      ?? narrativeViewpoint(previous?.viewpointOwnerId)
      ?? narrativeViewpoint(fallbackCast?.viewpointOwnerId)
      ?? FIXED_OWNER_IDS.narrator;
    const sourceRefs = unique([
      ...(previous?.sourceRefs ?? []),
      ...recent.map(source => source.id),
      ...textSignals.sourceRefs,
      ...seedCasts.flatMap(cast => cast.members.flatMap(member => member.sourceRefs)),
    ]).slice(-96);
    const state: SceneState = {
      id: sceneStateRecordId(input.workspaceId, input.chatKey),
      workspaceId: input.workspaceId,
      chatKey: input.chatKey,
      sceneId,
      sceneEpoch: nextEpoch,
      locationKeys,
      viewpointOwnerId: resolvedViewpoint,
      presentOwnerIds: [...present],
      nearbyOwnerIds: [...nearby],
      exitedOwnerIds: [...exitedOwners],
      recentSpeakerOwnerIds: unique([
        ...actorOwnerIds(this.registry, recentCast.speakerOwnerIds),
        ...(previous?.recentSpeakerOwnerIds ?? []),
      ]).slice(0, 8),
      mentionedOwnerIds: unique(seedCasts.flatMap(cast => cast.mentionedOwnerIds).filter(ownerId => !present.has(ownerId))),
      startedAtFloor: previous && !epochChanged ? previous.startedAtFloor : input.currentFloor,
      updatedAtFloor: input.currentFloor,
      confidence: correction ? 1 : Math.max(previous?.confidence ?? 0, fallbackCast ? 0.72 : 0.82),
      revision: (previous?.revision ?? 0) + 1,
      sourceRefs,
      createdAt: previous && !epochChanged ? previous.createdAt : now,
      updatedAt: now,
    };
    const reason = transitionReason({ correction: Boolean(correction), reset, timeJump, locationChanged, exited: exited.size > 0, entered: entered.size > 0 && [...entered].some(id => !(previous?.presentOwnerIds ?? []).includes(id)) });
    const transition: SceneTransition | undefined = reason ? {
      id: `scene-transition:${encodeURIComponent(input.chatKey)}:${input.currentFloor}:${state.revision}`,
      workspaceId: input.workspaceId,
      chatKey: input.chatKey,
      sceneId,
      floor: input.currentFloor,
      enteredOwnerIds: [...entered].filter(id => !(previous?.presentOwnerIds ?? []).includes(id)),
      exitedOwnerIds: [...exited],
      previousLocationKeys: [...(previous?.locationKeys ?? [])],
      currentLocationKeys: locationKeys,
      ...(previous?.viewpointOwnerId ? { previousViewpointOwnerId: previous.viewpointOwnerId } : {}),
      ...(state.viewpointOwnerId ? { currentViewpointOwnerId: state.viewpointOwnerId } : {}),
      reason,
      confidence: correction ? 1 : 0.9,
      sourceRefs: unique([...textSignals.sourceRefs, ...recent.flatMap(source => source.transition ? [source.id] : [])]),
      createdAt: now,
    } : undefined;
    if (input.persist !== false) await this.store.saveSceneState(state, transition);
    return { state, ...(transition ? { transition } : {}), sceneCast };
  }
}
