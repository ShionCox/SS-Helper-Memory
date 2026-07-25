import type {
  ActorMemoryTrace,
  ActorRecallResponse,
  CastPlanningSettings,
  GenerationCastPlan,
  GenerationRecallIntentPlan,
  MemoryFact,
  MemoryEpisode,
  RecallCoverageLog,
  RecallCoverageResult,
  SceneCast,
  SceneState,
  SceneTransition,
} from '../../domain';
import type { SourceBlock } from '../ingest/types';
import type { ActorMemoryPromptResult } from '../prompt';
import { CastCandidateResolver, GenerationCastPlanner, SceneStateReducer } from '../actors';
import { planRecallIntentByRules, RecallCoverageVerifier } from '../recall';

export interface PreparedGenerationMemory {
  readonly sceneState: SceneState;
  readonly sceneCast: SceneCast;
  readonly castPlan: GenerationCastPlan;
  readonly intent: GenerationRecallIntentPlan;
  readonly recalled: ActorRecallResponse;
  readonly coverage: RecallCoverageResult;
  readonly expanded: boolean;
  readonly prompt: ActorMemoryPromptResult;
}

function factOwnerIds(fact: MemoryFact): string[] {
  return unique([
    fact.subjectEntityId ?? '',
    fact.objectEntityId ?? '',
    ...fact.entityKeys.filter(key => key.startsWith('owner:') || key.startsWith('provisional:')),
  ].filter(value => value.startsWith('owner:') || value.startsWith('provisional:')));
}

function relatedOwnersFromFacts(facts: readonly MemoryFact[], sceneState: SceneState, now: number): {
  locationOwnerIds: string[];
  goalOwnerIds: string[];
} {
  const active = facts.filter(fact => fact.status === 'active'
    && (fact.validFrom === undefined || fact.validFrom <= now)
    && (fact.validUntil === undefined || fact.validUntil >= now));
  const locationOwnerIds = unique(active
    .filter(fact => fact.kind === 'location'
      && sceneState.locationKeys.some(location => fact.entityKeys.includes(location) || fact.content.includes(location)))
    .flatMap(factOwnerIds));
  const goalOwnerIds = unique(active
    .filter(fact => fact.kind === 'goal')
    .flatMap(factOwnerIds));
  return { locationOwnerIds, goalOwnerIds };
}

export interface GenerationMemoryCoordinatorDependencies {
  readonly collectSources: (chatKey: string) => Promise<readonly SourceBlock[]>;
  readonly listEpisodes: () => Promise<readonly MemoryEpisode[]>;
  readonly listFacts: () => Promise<readonly MemoryFact[]>;
  readonly listTraces: () => Promise<readonly ActorMemoryTrace[]>;
  readonly resolveOwnerName: (name: string) => string | undefined;
  readonly recall: (input: {
    readonly query: string;
    readonly scene: SceneCast;
    readonly castPlan: GenerationCastPlan;
    readonly intentPlan: GenerationRecallIntentPlan;
    readonly maxItems: number;
    readonly now: number;
    readonly minimumRetrievalLevel?: 1 | 2 | 3 | 4;
  }) => Promise<ActorRecallResponse>;
  readonly buildPrompt: (response: ActorRecallResponse, castPlan: GenerationCastPlan, maxChars: number) => ActorMemoryPromptResult;
  readonly isCurrent?: () => boolean;
  readonly commitPrepared: (input: {
    readonly state: SceneState;
    readonly transition?: SceneTransition;
    readonly plan: GenerationCastPlan;
    readonly coverage: RecallCoverageLog;
    readonly isCurrent?: () => boolean;
  }) => Promise<void>;
}

export interface PrepareGenerationMemoryInput {
  readonly workspaceId: string;
  readonly chatKey: string;
  readonly currentFloor: number;
  readonly userMessage: string;
  readonly maxItems: number;
  readonly maxChars: number;
  readonly settings: CastPlanningSettings;
  readonly hostSelectedOwnerId?: string;
  readonly now?: number;
}

function unique(values: Iterable<string>): string[] { return [...new Set([...values].filter(Boolean))]; }

function staleGenerationScopeError(): Error & { code: string } {
  return Object.assign(new Error('生成前记忆准备所属聊天已变化，已丢弃旧结果。'), {
    code: 'MEMORY_STALE_GENERATION_SCOPE',
  });
}

function planningScene(scene: SceneCast, state: SceneState): SceneCast {
  const memberIds = new Set(scene.members.map(member => member.ownerId));
  const members = [...scene.members];
  for (const ownerId of state.presentOwnerIds) {
    if (!memberIds.has(ownerId)) members.push({ ownerId, role: 'present', confidence: state.confidence, sourceRefs: [...state.sourceRefs].slice(-4) });
  }
  return {
    ...scene,
    members,
    viewpointOwnerId: state.viewpointOwnerId ?? scene.viewpointOwnerId,
    speakerOwnerIds: unique([...scene.speakerOwnerIds, ...state.recentSpeakerOwnerIds.slice(0, 2)]),
    presentOwnerIds: [...state.presentOwnerIds],
    mentionedOwnerIds: [...state.mentionedOwnerIds],
  };
}

function newActorRequested(message: string): boolean {
  return /(?:让|叫|安排|创建|生成|来)(?:一个|一位|名)?(?:新|陌生)?(?:角色|人物|NPC|npc|店员|警察|医生|路人)(?:出现|过来|加入)?/u.test(message);
}

/** Complete generation-before pipeline: state → cast → owner recall → verification → prompt. */
export class GenerationMemoryCoordinator {
  constructor(
    private readonly sceneStateReducer: SceneStateReducer,
    private readonly candidateResolver: CastCandidateResolver,
    private readonly castPlanner: GenerationCastPlanner,
    private readonly coverageVerifier: RecallCoverageVerifier,
    private readonly dependencies: GenerationMemoryCoordinatorDependencies,
  ) {}

  async prepareGenerationMemory(input: PrepareGenerationMemoryInput): Promise<PreparedGenerationMemory> {
    const assertCurrent = (): void => {
      if (this.dependencies.isCurrent && !this.dependencies.isCurrent()) throw staleGenerationScopeError();
    };
    assertCurrent();
    const now = input.now ?? Date.now();
    const sources = await this.dependencies.collectSources(input.chatKey);
    assertCurrent();
    const sceneResolution = await this.sceneStateReducer.resolve({
      workspaceId: input.workspaceId,
      chatKey: input.chatKey,
      currentFloor: input.currentFloor,
      sources,
      now,
      actorScanLookbackFloors: input.settings.actorScanLookbackFloors,
      persistPresenceUntilTransition: input.settings.persistPresenceUntilTransition,
      persist: false,
    });
    assertCurrent();
    const [episodes, facts] = await Promise.all([
      this.dependencies.listEpisodes(),
      this.dependencies.listFacts(),
    ]);
    assertCurrent();
    const relatedOwners = relatedOwnersFromFacts(facts, sceneResolution.state, now);
    const candidates = this.candidateResolver.resolve({
      userMessage: input.userMessage,
      currentFloor: input.currentFloor,
      sceneState: sceneResolution.state,
      sources,
      episodes,
      locationOwnerIds: relatedOwners.locationOwnerIds,
      goalOwnerIds: relatedOwners.goalOwnerIds,
      hostSelectedOwnerId: input.hostSelectedOwnerId,
      focusLookbackFloors: input.settings.focusLookbackFloors,
      actorScanLookbackFloors: input.settings.actorScanLookbackFloors,
    });
    const latestEpisode = [...episodes].sort((left, right) => (right.floorEnd ?? right.floorStart ?? 0) - (left.floorEnd ?? left.floorStart ?? 0))[0];
    const castPlan = await this.castPlanner.plan({
      workspaceId: input.workspaceId,
      chatKey: input.chatKey,
      currentFloor: input.currentFloor,
      userMessage: input.userMessage,
      sceneState: sceneResolution.state,
      candidateResolution: candidates,
      publicConversation: sources.filter(source => source.kind === 'message' && source.visibility !== 'hidden').slice(-4).map(source => source.content.slice(0, 800)),
      ...(latestEpisode?.summary ? { publicEpisodeSummary: latestEpisode.summary } : {}),
      transitionOccurred: Boolean(sceneResolution.transition),
      newActorRequested: newActorRequested(input.userMessage),
      settings: input.settings,
      now,
    });
    assertCurrent();
    const intent = planRecallIntentByRules(input.userMessage, { castPlan, resolveOwnerName: this.dependencies.resolveOwnerName, entityKeys: sceneResolution.state.locationKeys });
    const scene = planningScene(sceneResolution.sceneCast, sceneResolution.state);
    const first = await this.dependencies.recall({ query: input.userMessage, scene, castPlan, intentPlan: intent, maxItems: input.maxItems, now });
    assertCurrent();
    const traces = await this.dependencies.listTraces();
    assertCurrent();
    const verified = await this.coverageVerifier.verifyWithExpansion({ castPlan, intent, response: first, traces }, async () => {
      assertCurrent();
      const expanded = await this.dependencies.recall({
        query: input.userMessage,
        scene,
        castPlan,
        intentPlan: intent,
        maxItems: Math.min(30, input.maxItems + 2),
        now,
        minimumRetrievalLevel: intent.graphHops > 0 ? 4 : 2,
      });
      assertCurrent();
      return expanded;
    });
    assertCurrent();
    const coverageLog: RecallCoverageLog = {
      id: `recall-coverage:${castPlan.id}`,
      workspaceId: input.workspaceId,
      chatKey: input.chatKey,
      planId: castPlan.id,
      ...verified.coverage,
      expanded: verified.expanded,
      createdAt: now,
    };
    const prompt = this.dependencies.buildPrompt(verified.results, castPlan, input.maxChars);
    assertCurrent();
    await this.dependencies.commitPrepared({
      state: sceneResolution.state,
      ...(sceneResolution.transition ? { transition: sceneResolution.transition } : {}),
      plan: castPlan,
      coverage: coverageLog,
      ...(this.dependencies.isCurrent ? { isCurrent: this.dependencies.isCurrent } : {}),
    });
    assertCurrent();
    return { sceneState: sceneResolution.state, sceneCast: scene, castPlan, intent, recalled: verified.results, coverage: verified.coverage, expanded: verified.expanded, prompt };
  }
}
