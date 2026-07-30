import {
  DEFAULT_CAST_SETTINGS,
  FIXED_OWNER_IDS,
  type CastPlanEvidence,
  type CastPlanReasonCode,
  type CastPlanningSettings,
  type GenerationCastCandidate,
  type GenerationCastMode,
  type GenerationCastPlan,
  type ProvisionalActorProposal,
  type SceneState,
} from '../../domain';
import { createSSHelperError } from '@ss-helper/sdk';
import { MEMORY_PLUGIN_ID, readMemoryLlmClient, type MemoryLlmClient } from '../ingest/llm-extractor';
import type { CastCandidateResolution } from './cast-candidate-resolver';

export const MEMORY_CAST_PLAN_TASK = 'memory_cast_plan';

export interface GenerationCastPlannerInput {
  readonly workspaceId: string;
  readonly chatKey: string;
  readonly currentFloor: number;
  readonly userMessage: string;
  readonly sceneState: SceneState;
  readonly candidateResolution: CastCandidateResolution;
  readonly publicConversation?: readonly string[];
  readonly publicEpisodeSummary?: string;
  readonly transitionOccurred?: boolean;
  readonly newActorRequested?: boolean;
  readonly settings?: Partial<CastPlanningSettings>;
  readonly now?: number;
}

export interface CastDirector {
  plan(input: GenerationCastPlannerInput, candidates: readonly GenerationCastCandidate[]): Promise<Partial<GenerationCastPlan>>;
}

function unique(values: Iterable<string>): string[] { return [...new Set([...values].filter(Boolean))]; }

function settings(input?: Partial<CastPlanningSettings>): CastPlanningSettings {
  return { ...DEFAULT_CAST_SETTINGS, ...input };
}

function modeOf(required: readonly string[], likely: readonly string[], viewpointOwnerId?: string): GenerationCastMode {
  const active = unique([...required, ...likely]);
  if (active.length === 0) return viewpointOwnerId === FIXED_OWNER_IDS.narrator ? 'narrator' : 'mixed';
  return active.length === 1 ? 'single_actor' : 'multi_actor';
}

function evidence(candidates: readonly GenerationCastCandidate[]): CastPlanEvidence[] {
  return candidates.flatMap(candidate => candidate.reasonCodes.map(reasonCode => ({
    ownerId: candidate.ownerId,
    sourceRef: candidate.sourceRefs[0],
    reasonCode,
    score: candidate.score,
  }))).map(item => item.sourceRef ? item : { ownerId: item.ownerId, reasonCode: item.reasonCode, score: item.score });
}

function deterministicPlan(input: GenerationCastPlannerInput, plannerMode: GenerationCastPlan['plannerMode'] = 'deterministic'): GenerationCastPlan {
  const cfg = settings(input.settings);
  const candidates = input.candidateResolution.candidates;
  const candidateOwnerIds = new Set(candidates.map(candidate => candidate.ownerId));
  const viable = candidates.filter(candidate => !candidate.exited && !candidate.mentionedOnly);
  const explicit = candidates.filter(candidate => candidate.explicitlyAddressed && !candidate.exited);
  const host = candidates.filter(candidate => candidate.hostSelected && !candidate.exited);
  let required = unique([...host.map(candidate => candidate.ownerId), ...explicit.map(candidate => candidate.ownerId)]);
  if (required.length === 0 && input.candidateResolution.directFollowUp) {
    const recent = candidates.find(candidate => candidate.reasonCodes.includes('recent_speaker') && !candidate.exited && !candidate.mentionedOnly);
    if (recent) required = [recent.ownerId];
  }
  if (required.length === 0 && viable[0]) required = [viable[0].ownerId];
  const exclusiveTarget = required.length === 1 && (explicit.length === 1 || host.length === 1);
  const likely = exclusiveTarget
    ? []
    : viable
      .filter(candidate => !required.includes(candidate.ownerId) && candidate.score >= cfg.plannerConfidenceThreshold)
      .slice(0, Math.max(0, cfg.plannerCandidateThreshold))
      .map(candidate => candidate.ownerId);
  const background = exclusiveTarget
    ? []
    : input.sceneState.presentOwnerIds.filter(ownerId => candidateOwnerIds.has(ownerId) && !required.includes(ownerId) && !likely.includes(ownerId));
  const mentionedOnly = unique([
    ...input.sceneState.mentionedOwnerIds.filter(ownerId => candidateOwnerIds.has(ownerId)),
    ...candidates.filter(candidate => candidate.mentionedOnly).map(candidate => candidate.ownerId),
  ]).filter(ownerId => !required.includes(ownerId) && !likely.includes(ownerId) && !background.includes(ownerId));
  const excluded = unique([
    ...input.sceneState.exitedOwnerIds.filter(ownerId => candidateOwnerIds.has(ownerId)),
    ...candidates.filter(candidate => candidate.exited).map(candidate => candidate.ownerId),
  ]);
  const permissionByOwner: Record<string, 'full' | 'focused' | 'public_only' | 'identity_only' | 'none'> = {};
  for (const ownerId of required) permissionByOwner[ownerId] = 'full';
  for (const ownerId of likely) permissionByOwner[ownerId] = cfg.likelyActorRecall;
  for (const ownerId of background) permissionByOwner[ownerId] = cfg.backgroundActorRecall;
  for (const ownerId of mentionedOnly) permissionByOwner[ownerId] = 'none';
  for (const ownerId of excluded) permissionByOwner[ownerId] = 'none';
  if (input.sceneState.viewpointOwnerId && candidateOwnerIds.has(input.sceneState.viewpointOwnerId)) permissionByOwner[input.sceneState.viewpointOwnerId] = 'full';
  const topScore = candidates.find(candidate => required.includes(candidate.ownerId))?.score ?? input.candidateResolution.confidence;
  return {
    id: `cast-plan:${encodeURIComponent(input.chatKey)}:${input.currentFloor}:${crypto.randomUUID()}`,
    workspaceId: input.workspaceId,
    chatKey: input.chatKey,
    sceneId: input.sceneState.sceneId,
    basedOnFloor: input.currentFloor,
    mode: modeOf(required, likely, input.sceneState.viewpointOwnerId),
    ...(input.sceneState.viewpointOwnerId ? { viewpointOwnerId: input.sceneState.viewpointOwnerId } : {}),
    requiredOwnerIds: required,
    likelyOwnerIds: likely,
    backgroundOwnerIds: background,
    mentionedOnlyOwnerIds: mentionedOnly,
    excludedOwnerIds: excluded,
    permissionByOwner,
    plannerMode: host.length > 0 ? 'host_selected' : plannerMode,
    confidence: Math.max(0, Math.min(1, explicit.length === 1 || host.length > 0 ? 1 : Math.max(input.candidateResolution.confidence, topScore))),
    evidence: evidence(candidates),
    newActorProposals: [],
    createdAt: input.now ?? Date.now(),
  };
}

function needsDirector(input: GenerationCastPlannerInput, plan: GenerationCastPlan, cfg: CastPlanningSettings): { run: boolean; reasons: CastPlanReasonCode[] } {
  if (cfg.castPlanningMode === 'fast' || cfg.maxPlannerCallsPerTurn === 0) return { run: false, reasons: [] };
  if (cfg.castPlanningMode === 'director') return { run: true, reasons: ['director_selected'] };
  const candidates = input.candidateResolution.candidates.filter(candidate => !candidate.exited && !candidate.mentionedOnly);
  const reasons: CastPlanReasonCode[] = [];
  const explicitSingle = input.candidateResolution.explicitAddressOwnerIds.length === 1;
  const hostSelected = candidates.some(candidate => candidate.hostSelected);
  const onePrimary = candidates.filter(candidate => candidate.score >= 0.5).length === 1;
  if (explicitSingle || hostSelected || onePrimary || input.candidateResolution.directFollowUp) return { run: false, reasons };
  if (input.sceneState.presentOwnerIds.length > 2 && /^(?:继续|接着|然后|往下)[。！!…]*$/u.test(input.userMessage.trim())) reasons.push('group_question');
  if (input.candidateResolution.explicitAddressOwnerIds.length > 1) reasons.push('group_question');
  if (input.transitionOccurred) reasons.push('scene_transition');
  if (plan.requiredOwnerIds.length === 0) reasons.push('low_confidence');
  if (input.newActorRequested) reasons.push('new_actor_requested');
  if (plan.confidence < cfg.plannerConfidenceThreshold) reasons.push('low_confidence');
  if (candidates.length > 2 && Math.abs((candidates[0]?.score ?? 0) - (candidates[1]?.score ?? 0)) <= 0.08) reasons.push('close_scores');
  return { run: reasons.length > 0, reasons: unique(reasons) as CastPlanReasonCode[] };
}

function validateOwnerLists(proposal: Partial<GenerationCastPlan>, allowed: ReadonlySet<string>): {
  required: string[];
  likely: string[];
  background: string[];
  mentioned: string[];
  excluded: string[];
} {
  const valid = (value: readonly string[] | undefined): string[] => unique(value ?? []).filter(ownerId => allowed.has(ownerId));
  const required = valid(proposal.requiredOwnerIds);
  const likely = valid(proposal.likelyOwnerIds).filter(id => !required.includes(id));
  const background = valid(proposal.backgroundOwnerIds).filter(id => !required.includes(id) && !likely.includes(id));
  const mentioned = valid(proposal.mentionedOnlyOwnerIds).filter(id => !required.includes(id) && !likely.includes(id) && !background.includes(id));
  const excluded = valid(proposal.excludedOwnerIds).filter(id => !required.includes(id) && !likely.includes(id) && !background.includes(id));
  return { required, likely, background, mentioned, excluded };
}

export class LlmCastDirector implements CastDirector {
  constructor(private readonly getLlm: () => MemoryLlmClient | null = readMemoryLlmClient) {}

  async plan(input: GenerationCastPlannerInput, candidates: readonly GenerationCastCandidate[]): Promise<Partial<GenerationCastPlan>> {
    const llm = this.getLlm();
    if (!llm) throw new Error('LLMHub 不可用。');
    const schema = {
      type: 'object', additionalProperties: false,
      required: ['mode', 'viewpointOwnerId', 'requiredOwnerIds', 'likelyOwnerIds', 'backgroundOwnerIds', 'mentionedOnlyOwnerIds', 'excludedOwnerIds', 'newActorProposals', 'confidence', 'reasonCodes'],
      properties: {
        mode: { type: 'string', enum: ['single_actor', 'multi_actor', 'narrator', 'mixed'] },
        viewpointOwnerId: { type: ['string', 'null'] },
        requiredOwnerIds: { type: 'array', items: { type: 'string' }, maxItems: 8 },
        likelyOwnerIds: { type: 'array', items: { type: 'string' }, maxItems: 8 },
        backgroundOwnerIds: { type: 'array', items: { type: 'string' }, maxItems: 16 },
        mentionedOnlyOwnerIds: { type: 'array', items: { type: 'string' }, maxItems: 16 },
        excludedOwnerIds: { type: 'array', items: { type: 'string' }, maxItems: 16 },
        newActorProposals: { type: 'array', maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['displayName', 'aliases', 'description', 'confidence'], properties: { displayName: { type: 'string' }, aliases: { type: 'array', items: { type: 'string' } }, description: { type: ['string', 'null'] }, confidence: { type: 'number', minimum: 0, maximum: 1 } } } },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        reasonCodes: { type: 'array', items: { type: 'string' }, maxItems: 12 },
      },
    } as const;
    const publicPayload = {
      scene: {
        sceneId: input.sceneState.sceneId,
        locationKeys: input.sceneState.locationKeys,
        viewpointOwnerId: input.sceneState.viewpointOwnerId,
        presentOwnerIds: input.sceneState.presentOwnerIds,
        nearbyOwnerIds: input.sceneState.nearbyOwnerIds,
        mentionedOwnerIds: input.sceneState.mentionedOwnerIds,
      },
      candidates: candidates.map(candidate => ({ ownerId: candidate.ownerId, displayName: candidate.displayName, score: candidate.score, reasonCodes: candidate.reasonCodes })),
      userMessage: input.userMessage,
      recentPublicConversation: (input.publicConversation ?? []).slice(-4),
      publicEpisodeSummary: input.publicEpisodeSummary ?? '',
    };
    const response = await llm.runTask<Record<string, unknown>>({
      consumer: MEMORY_PLUGIN_ID,
      taskKey: MEMORY_CAST_PLAN_TASK,
      taskDescription: '仅规划下一轮可能发言或行动的角色，不撰写剧情',
      taskKind: 'generation',
      input: { messages: [
        { role: 'system', content: '你是轻量选角导演。只能从候选 ownerId 中选择稳定人物；只能依据公开场景信息；不得推测秘密、私密思想或个人记忆。新人物只能作为 proposal。' },
        { role: 'user', content: JSON.stringify(publicPayload) },
      ] },
      schema,
      budget: { maxTokens: 700, maxLatencyMs: 4_000 },
      enqueue: { displayMode: 'silent' },
    });
    if (!response.ok) throw createSSHelperError(response.failure.reasonCode, response.failure);
    const row = response.data;
    const proposals = Array.isArray(row.newActorProposals) ? row.newActorProposals : [];
    return {
      mode: ['single_actor', 'multi_actor', 'narrator', 'mixed'].includes(String(row.mode)) ? row.mode as GenerationCastMode : undefined,
      viewpointOwnerId: typeof row.viewpointOwnerId === 'string' ? row.viewpointOwnerId : undefined,
      requiredOwnerIds: Array.isArray(row.requiredOwnerIds) ? row.requiredOwnerIds.map(String) : [],
      likelyOwnerIds: Array.isArray(row.likelyOwnerIds) ? row.likelyOwnerIds.map(String) : [],
      backgroundOwnerIds: Array.isArray(row.backgroundOwnerIds) ? row.backgroundOwnerIds.map(String) : [],
      mentionedOnlyOwnerIds: Array.isArray(row.mentionedOnlyOwnerIds) ? row.mentionedOnlyOwnerIds.map(String) : [],
      excludedOwnerIds: Array.isArray(row.excludedOwnerIds) ? row.excludedOwnerIds.map(String) : [],
      newActorProposals: proposals.filter(value => value && typeof value === 'object').map((value, index): ProvisionalActorProposal => {
        const proposal = value as Record<string, unknown>;
        const description = String(proposal.description ?? '').trim();
        return {
          localId: `proposal:${input.sceneState.sceneId}:${input.currentFloor}:${index}`,
          displayName: String(proposal.displayName ?? '').trim().slice(0, 64),
          aliases: Array.isArray(proposal.aliases) ? proposal.aliases.map(String).map(item => item.trim()).filter(Boolean).slice(0, 8) : [],
          ...(description ? { description: description.slice(0, 240) } : {}),
          sourceRefs: [],
          confidence: Math.max(0, Math.min(1, Number(proposal.confidence ?? 0.5))),
        };
      }).filter(proposal => proposal.displayName),
      confidence: Math.max(0, Math.min(1, Number(row.confidence ?? 0))),
    };
  }
}

/** Applies deterministic gates and calls the public-only director at most once. */
export class GenerationCastPlanner {
  private readonly turnCache = new Map<string, Promise<GenerationCastPlan>>();

  constructor(private readonly director: CastDirector = new LlmCastDirector()) {}

  async plan(input: GenerationCastPlannerInput): Promise<GenerationCastPlan> {
    const key = JSON.stringify({
      workspaceId: input.workspaceId,
      chatKey: input.chatKey,
      floor: input.currentFloor,
      sceneId: input.sceneState.sceneId,
      sceneRevision: input.sceneState.revision,
      userMessage: input.userMessage,
      transitionOccurred: input.transitionOccurred === true,
      newActorRequested: input.newActorRequested === true,
      settings: settings(input.settings),
      candidates: input.candidateResolution.candidates.map(candidate => [
        candidate.ownerId,
        candidate.score,
        candidate.explicitlyAddressed,
        candidate.hostSelected,
        candidate.present,
        candidate.mentionedOnly,
        candidate.exited,
      ]),
    });
    const cached = this.turnCache.get(key);
    if (cached) return cached;
    const pending = this.planUncached(input);
    this.turnCache.set(key, pending);
    while (this.turnCache.size > 64) this.turnCache.delete(this.turnCache.keys().next().value as string);
    try {
      return await pending;
    } catch (error) {
      this.turnCache.delete(key);
      throw error;
    }
  }

  private async planUncached(input: GenerationCastPlannerInput): Promise<GenerationCastPlan> {
    const cfg = settings(input.settings);
    const base = deterministicPlan(input);
    const gate = needsDirector(input, base, cfg);
    if (!gate.run) return base;
    try {
      const proposal = await this.director.plan(input, input.candidateResolution.candidates);
      const allowed = new Set(input.candidateResolution.candidates.map(candidate => candidate.ownerId));
      const validated = validateOwnerLists(proposal, allowed);
      const required = validated.required.length > 0 ? validated.required : [...base.requiredOwnerIds];
      const candidateScore = new Map(input.candidateResolution.candidates.map(candidate => [candidate.ownerId, candidate.score]));
      const likely = validated.likely.filter(ownerId => (candidateScore.get(ownerId) ?? 0) >= cfg.plannerConfidenceThreshold);
      const rejectedLikely = validated.likely.filter(ownerId => !likely.includes(ownerId));
      const background = unique([
        ...(validated.background.length > 0 ? validated.background : base.backgroundOwnerIds),
        ...rejectedLikely,
      ]).filter(id => !required.includes(id) && !likely.includes(id));
      const permissionByOwner: Record<string, 'full' | 'focused' | 'public_only' | 'identity_only' | 'none'> = {};
      for (const ownerId of required) permissionByOwner[ownerId] = 'full';
      for (const ownerId of likely) permissionByOwner[ownerId] = cfg.likelyActorRecall;
      for (const ownerId of background) permissionByOwner[ownerId] = cfg.backgroundActorRecall;
      for (const ownerId of validated.mentioned) permissionByOwner[ownerId] = 'none';
      for (const ownerId of validated.excluded) permissionByOwner[ownerId] = 'none';
      const viewpointOwnerId = proposal.viewpointOwnerId && allowed.has(proposal.viewpointOwnerId) ? proposal.viewpointOwnerId : base.viewpointOwnerId;
      if (viewpointOwnerId && viewpointOwnerId !== FIXED_OWNER_IDS.narrator) permissionByOwner[viewpointOwnerId] = 'full';
      return {
        ...base,
        mode: proposal.mode ?? modeOf(required, likely, viewpointOwnerId),
        ...(viewpointOwnerId ? { viewpointOwnerId } : {}),
        requiredOwnerIds: required,
        likelyOwnerIds: likely,
        backgroundOwnerIds: background,
        mentionedOnlyOwnerIds: validated.mentioned,
        excludedOwnerIds: unique([...base.excludedOwnerIds, ...validated.excluded]),
        permissionByOwner,
        plannerMode: 'llm_assisted',
        confidence: Math.max(0, Math.min(1, proposal.confidence ?? base.confidence)),
        evidence: [...base.evidence, ...gate.reasons.map(reasonCode => ({ reasonCode, score: base.confidence }))],
        newActorProposals: cfg.plannerCanProposeActors && cfg.provisionalActorEnabled ? [...(proposal.newActorProposals ?? [])] : [],
      };
    } catch {
      return {
        ...base,
        evidence: [...base.evidence, { reasonCode: 'director_fallback', score: base.confidence }],
      };
    }
  }
}
