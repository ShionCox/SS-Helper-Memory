import type {
  ActorMemoryTrace,
  ActorRecallResponse,
  CastPlanningSettings,
  GenerationCastPlan,
  GenerationRecallIntentKind,
  GenerationRecallIntentPlan,
  MemoryFact,
  MemoryEpisode,
  PreparedRecallAttempt,
  RecallCoverageLog,
  RecallCoverageResult,
  SceneCast,
  SceneState,
  SceneTransition,
} from '../../domain';
import type { SourceBlock } from '../ingest/types';
import type { ActorMemoryPromptResult } from '../prompt';
import { CastCandidateResolver, GenerationCastPlanner, SceneStateReducer } from '../actors';
import { LlmRecallIntentPlanner, planRecallIntent, RecallCoverageVerifier } from '../recall';
import { createSSHelperError, readSSHelperFailure } from '@ss-helper/sdk';

export interface PreparedGenerationMemory {
  readonly query: string;
  readonly sceneState: SceneState;
  readonly sceneCast: SceneCast;
  readonly castPlan: GenerationCastPlan;
  readonly intent: GenerationRecallIntentPlan;
  readonly recalled: ActorRecallResponse;
  readonly coverage: RecallCoverageResult;
  readonly expanded: boolean;
  readonly recallSkippedReason?: 'recent_context_sufficient' | 'no_relevant_memory';
  readonly expansionSkippedReason?: 'no_new_candidates';
  readonly attempts: readonly PreparedRecallAttempt[];
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
  readonly listKnownOwners?: () => readonly { readonly ownerId: string; readonly names: readonly string[] }[];
  readonly buildInventoryPrompt?: (userMessage: string, maxChars: number) => Promise<string>;
  readonly recall: (input: {
    readonly query: string;
    readonly scene: SceneCast;
    readonly castPlan: GenerationCastPlan;
    readonly intentPlan: GenerationRecallIntentPlan;
    readonly maxItems: number;
    readonly now: number;
    readonly minimumRetrievalLevel?: 1 | 2 | 3 | 4;
    readonly coverageExpansion?: boolean;
    readonly excludedFactIds?: readonly string[];
  }) => Promise<ActorRecallResponse>;
  readonly buildPrompt: (response: ActorRecallResponse, castPlan: GenerationCastPlan, maxChars: number, intentKind: GenerationRecallIntentKind) => ActorMemoryPromptResult;
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

function staleGenerationScopeError(): Error {
  return createSSHelperError('MEMORY_STALE_GENERATION_SCOPE', {
    stage: 'memory.generation.scope',
  });
}

async function generationStage<T>(stage: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    const failure = readSSHelperFailure(cause, {
      reasonCode: 'INTERNAL_ERROR',
      stage: `memory.generation.${stage}`,
    })!;
    throw createSSHelperError(failure.reasonCode, failure);
  }
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
    const sources = await generationStage('collect_sources', () => this.dependencies.collectSources(input.chatKey));
    assertCurrent();
    const sceneResolution = await generationStage('resolve_scene', () => this.sceneStateReducer.resolve({
      workspaceId: input.workspaceId,
      chatKey: input.chatKey,
      currentFloor: input.currentFloor,
      sources,
      now,
      actorScanLookbackFloors: input.settings.actorScanLookbackFloors,
      persistPresenceUntilTransition: input.settings.persistPresenceUntilTransition,
      persist: false,
    }));
    assertCurrent();
    const [episodes, facts] = await generationStage('load_memory', () => Promise.all([
      this.dependencies.listEpisodes(),
      this.dependencies.listFacts(),
    ]));
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
    const castPlan = await generationStage('plan_cast', () => this.castPlanner.plan({
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
    }));
    assertCurrent();
    const recentConversation = sources
      .filter(source => source.kind === 'message' && source.visibility !== 'hidden')
      .slice(-4)
      .map(source => ({ role: source.role, content: source.content.slice(0, 1_600) }));
    const entityKeys = unique([
      ...sceneResolution.state.locationKeys,
      ...facts.flatMap(fact => fact.entityKeys).filter(key => input.userMessage.normalize('NFKC').toLocaleLowerCase().includes(key.normalize('NFKC').toLocaleLowerCase())),
    ]);
    const intent = await generationStage('plan_recall_intent', () => planRecallIntent(input.userMessage, new LlmRecallIntentPlanner(), {
      castPlan,
      resolveOwnerName: this.dependencies.resolveOwnerName,
      entityKeys,
      knownOwners: this.dependencies.listKnownOwners?.() ?? [],
      recentConversation,
    }));
    const scene = planningScene(sceneResolution.sceneCast, sceneResolution.state);
    const first = await generationStage('recall_primary', () => this.dependencies.recall({ query: input.userMessage, scene, castPlan, intentPlan: intent, maxItems: input.maxItems, now }));
    assertCurrent();
    const traces = await generationStage('load_traces', () => this.dependencies.listTraces());
    assertCurrent();
    const verified = await generationStage('verify_coverage', () => this.coverageVerifier.verifyWithExpansion({ castPlan, intent, response: first, traces }, async () => {
      assertCurrent();
      const expanded = await this.dependencies.recall({
        query: input.userMessage,
        scene,
        castPlan,
        intentPlan: intent,
        maxItems: Math.min(30, input.maxItems + 2),
        now,
        minimumRetrievalLevel: intent.graphHops > 0 ? 4 : 2,
        coverageExpansion: true,
        excludedFactIds: [...new Set((first.candidatePartitions ?? []).flatMap(partition => partition.candidates.map(candidate => candidate.factId)))],
      });
      assertCurrent();
      return expanded;
    }));
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
    const inventoryPrompt = this.dependencies.buildInventoryPrompt
      ? await generationStage('inventory_prompt', () => this.dependencies.buildInventoryPrompt!(input.userMessage, input.maxChars))
      : '';
    assertCurrent();
    const inventoryBudget = inventoryPrompt ? inventoryPrompt.length + 1 : 0;
    const basePrompt = this.dependencies.buildPrompt(verified.results, castPlan, Math.max(0, input.maxChars - inventoryBudget), intent.intentKind);
    const prompt: ActorMemoryPromptResult = inventoryPrompt ? {
      ...basePrompt,
      prompt: [basePrompt.prompt, inventoryPrompt].filter(Boolean).join('\n'),
      diagnostics: {
        ...basePrompt.diagnostics,
        maxChars: input.maxChars,
        usedChars: [basePrompt.prompt, inventoryPrompt].filter(Boolean).join('\n').length,
      },
    } : basePrompt;
    assertCurrent();
    await generationStage('commit_prepared', () => this.dependencies.commitPrepared({
      state: sceneResolution.state,
      ...(sceneResolution.transition ? { transition: sceneResolution.transition } : {}),
      plan: castPlan,
      coverage: coverageLog,
      ...(this.dependencies.isCurrent ? { isCurrent: this.dependencies.isCurrent } : {}),
    }));
    assertCurrent();
    return {
      query: input.userMessage,
      sceneState: sceneResolution.state,
      sceneCast: scene,
      castPlan,
      intent,
      recalled: verified.results,
      coverage: verified.coverage,
      expanded: verified.expanded,
      ...(intent.recentContextSatisfied ? { recallSkippedReason: 'recent_context_sufficient' as const } : prompt.includedTraceIds.length === 0 ? { recallSkippedReason: 'no_relevant_memory' as const } : {}),
      ...(verified.expansionSkippedReason ? { expansionSkippedReason: verified.expansionSkippedReason } : {}),
      attempts: verified.attempts,
      prompt,
    };
  }
}
