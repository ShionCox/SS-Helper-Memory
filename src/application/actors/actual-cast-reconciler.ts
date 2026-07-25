import { FIXED_OWNER_IDS, type CastPlanAudit, type GenerationCastPlan, type SceneState, type SceneTransition, type UnplannedActorPolicy } from '../../domain';
import type { SourceBlock } from '../ingest/types';
import { ActiveCastResolver } from './active-cast-resolver';
import { ActorRegistry } from './actor-registry';
import { ProvisionalActorService, type ProvisionalActorPromotion } from './provisional-actor-service';
import { SceneStateReducer } from './scene-state-reducer';

export interface ActualCastReconcileInput {
  readonly plan: GenerationCastPlan;
  readonly sources: readonly SourceBlock[];
  readonly generatedSource: SourceBlock;
  readonly currentFloor: number;
  readonly unplannedActorPolicy?: UnplannedActorPolicy;
  readonly now?: number;
}

export interface ActualCastReconcileResult {
  readonly actualOwnerIds: readonly string[];
  readonly unplannedOwnerIds: readonly string[];
  readonly missingOwnerIds: readonly string[];
  readonly state: SceneState;
  readonly transition?: SceneTransition;
  readonly audit: CastPlanAudit;
  readonly promotions: readonly ProvisionalActorPromotion[];
}

export interface ActualCastReconcilerDependencies {
  readonly saveAudit: (audit: CastPlanAudit) => Promise<void> | void;
}

function unique(values: Iterable<string>): string[] { return [...new Set([...values].filter(Boolean))]; }

/** Reconciles planned cast against official output without retroactive private recall. */
export class ActualCastReconciler {
  private readonly provisional: ProvisionalActorService;

  constructor(
    private readonly registry: ActorRegistry,
    private readonly sceneStateReducer: SceneStateReducer,
    private readonly dependencies: ActualCastReconcilerDependencies,
  ) {
    this.provisional = new ProvisionalActorService(registry);
  }

  async reconcile(input: ActualCastReconcileInput): Promise<ActualCastReconcileResult> {
    const now = input.now ?? Date.now();
    this.provisional.materialize(input.plan.newActorProposals, input.generatedSource, input.plan.sceneId);
    const promotions = this.provisional.promoteSelfIntroduction(input.generatedSource, input.plan.sceneId);
    const actualScene = new ActiveCastResolver(this.registry).resolve([input.generatedSource], { currentFloor: input.currentFloor, lookbackFloors: 1 }).scene;
    const actualOwnerIds = unique([...actualScene.speakerOwnerIds, ...actualScene.presentOwnerIds])
      .filter(ownerId => ownerId !== FIXED_OWNER_IDS.world && ownerId !== FIXED_OWNER_IDS.narrator && ownerId !== FIXED_OWNER_IDS.unknown);
    const plannedOwnerIds = unique([...input.plan.requiredOwnerIds, ...input.plan.likelyOwnerIds, ...input.plan.backgroundOwnerIds]);
    const unplannedOwnerIds = actualOwnerIds.filter(ownerId => !plannedOwnerIds.includes(ownerId));
    const missingOwnerIds = input.plan.requiredOwnerIds.filter(ownerId => !actualOwnerIds.includes(ownerId));
    const sceneResult = await this.sceneStateReducer.resolve({
      workspaceId: input.plan.workspaceId,
      chatKey: input.plan.chatKey,
      currentFloor: input.currentFloor,
      sources: input.sources,
      sceneCast: actualScene,
      now,
      persistPresenceUntilTransition: true,
    });
    const result = unplannedOwnerIds.length === 0 && missingOwnerIds.length === 0 ? 'matched' : actualOwnerIds.some(ownerId => plannedOwnerIds.includes(ownerId)) ? 'partial' : 'diverged';
    const audit: CastPlanAudit = {
      id: `cast-plan-audit:${input.plan.id}:${input.currentFloor}`,
      workspaceId: input.plan.workspaceId,
      chatKey: input.plan.chatKey,
      planId: input.plan.id,
      plannedOwnerIds,
      actualOwnerIds,
      unplannedOwnerIds,
      missingOwnerIds,
      result,
      // Regardless of policy, an unplanned actor had no private partition in
      // this generation. Flag it for inspection rather than claiming it read one.
      leakageRisk: unplannedOwnerIds.length > 0 && input.unplannedActorPolicy === 'regenerate_once',
      createdAt: now,
    };
    await this.dependencies.saveAudit(audit);
    return { actualOwnerIds, unplannedOwnerIds, missingOwnerIds, state: sceneResult.state, ...(sceneResult.transition ? { transition: sceneResult.transition } : {}), audit, promotions };
  }
}
