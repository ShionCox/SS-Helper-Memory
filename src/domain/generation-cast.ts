export type CastRecallPermission = 'full' | 'focused' | 'public_only' | 'identity_only' | 'none';
export type CastPlanningMode = 'fast' | 'hybrid' | 'director';
export type GenerationCastPlannerMode = 'deterministic' | 'llm_assisted' | 'host_selected' | 'manual';
export type GenerationCastMode = 'single_actor' | 'multi_actor' | 'narrator' | 'mixed';
export type UnplannedActorPolicy = 'allow_public_only' | 'allow_without_private_memory' | 'regenerate_once';

export type CastPlanReasonCode =
  | 'host_selected'
  | 'explicit_address'
  | 'current_viewpoint'
  | 'scene_presence'
  | 'recent_speaker'
  | 'current_event_participant'
  | 'location_relation'
  | 'mentioned_only'
  | 'explicit_exit'
  | 'direct_follow_up'
  | 'single_actor_scene'
  | 'group_question'
  | 'scene_transition'
  | 'new_actor_requested'
  | 'low_confidence'
  | 'close_scores'
  | 'director_selected'
  | 'director_fallback';

export interface CastPlanEvidence {
  readonly ownerId?: string;
  readonly sourceRef?: string;
  readonly reasonCode: CastPlanReasonCode;
  readonly score: number;
  readonly detail?: string;
}

export interface ProvisionalActorProposal {
  readonly localId: string;
  readonly displayName: string;
  readonly aliases: readonly string[];
  readonly description?: string;
  readonly sourceRefs: readonly string[];
  readonly confidence: number;
}

export interface MemoryUsageLog extends UsedMemoryEvidence {
  readonly id: string;
  readonly workspaceId: string;
  readonly chatKey: string;
  readonly planId?: string;
  readonly createdAt: number;
}

export interface GenerationCastCandidate {
  readonly ownerId: string;
  readonly displayName: string;
  readonly score: number;
  readonly reasonCodes: readonly CastPlanReasonCode[];
  readonly sourceRefs: readonly string[];
  readonly explicitlyAddressed: boolean;
  readonly hostSelected: boolean;
  readonly viewpoint: boolean;
  readonly present: boolean;
  readonly mentionedOnly: boolean;
  readonly exited: boolean;
}

export interface GenerationCastPlan {
  readonly id: string;
  readonly workspaceId: string;
  readonly chatKey: string;
  readonly sceneId: string;
  readonly basedOnFloor: number;
  readonly mode: GenerationCastMode;
  readonly viewpointOwnerId?: string;
  /** Owners that must speak or act in the next native generation. */
  readonly requiredOwnerIds: readonly string[];
  readonly likelyOwnerIds: readonly string[];
  readonly backgroundOwnerIds: readonly string[];
  readonly mentionedOnlyOwnerIds: readonly string[];
  readonly excludedOwnerIds: readonly string[];
  readonly permissionByOwner: Readonly<Record<string, CastRecallPermission>>;
  readonly plannerMode: GenerationCastPlannerMode;
  readonly confidence: number;
  readonly evidence: readonly CastPlanEvidence[];
  readonly newActorProposals: readonly ProvisionalActorProposal[];
  readonly createdAt: number;
}

export interface CastPlanAudit {
  readonly id: string;
  readonly workspaceId: string;
  readonly chatKey: string;
  readonly planId: string;
  readonly plannedOwnerIds: readonly string[];
  readonly actualOwnerIds: readonly string[];
  readonly unplannedOwnerIds: readonly string[];
  readonly missingOwnerIds: readonly string[];
  readonly result: 'matched' | 'partial' | 'diverged';
  readonly leakageRisk: boolean;
  readonly createdAt: number;
}

export interface UsedMemoryEvidence {
  readonly traceId: string;
  readonly factId: string;
  readonly ownerId: string;
  readonly usage: 'explicit' | 'implicit' | 'not_used';
  readonly confidence: number;
}

export interface CastPlanningSettings {
  readonly castPlanningMode: CastPlanningMode;
  readonly focusLookbackFloors: number;
  readonly actorScanLookbackFloors: number;
  readonly persistPresenceUntilTransition: boolean;
  readonly plannerCandidateThreshold: number;
  readonly plannerConfidenceThreshold: number;
  readonly likelyActorRecall: 'public_only' | 'identity_only' | 'none';
  readonly backgroundActorRecall: 'public_only' | 'identity_only' | 'none';
  readonly mentionedActorRecall: 'none';
  readonly provisionalActorEnabled: boolean;
  readonly plannerCanProposeActors: boolean;
  readonly unplannedActorPolicy: UnplannedActorPolicy;
  readonly maxPlannerCallsPerTurn: 0 | 1;
}

export const DEFAULT_CAST_SETTINGS: Readonly<CastPlanningSettings> = Object.freeze({
  castPlanningMode: 'hybrid',
  focusLookbackFloors: 4,
  actorScanLookbackFloors: 12,
  persistPresenceUntilTransition: true,
  plannerCandidateThreshold: 2,
  plannerConfidenceThreshold: 0.72,
  likelyActorRecall: 'public_only',
  backgroundActorRecall: 'identity_only',
  mentionedActorRecall: 'none',
  provisionalActorEnabled: true,
  plannerCanProposeActors: true,
  unplannedActorPolicy: 'allow_public_only',
  maxPlannerCallsPerTurn: 1,
});
