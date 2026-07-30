export type GenerationRecallTimeMode = 'current' | 'historical' | 'timeline' | 'unknown';
export type GenerationRecallActorMode = 'single_pov' | 'planned_cast' | 'named_actors' | 'world' | 'narrator';
export type GenerationRecallComplexity = 'direct' | 'multi_topic' | 'multi_hop';
export type GenerationRecallIntentKind = 'recent_context' | 'world_knowledge' | 'actor_entity' | 'actor_knowledge' | 'scene_action' | 'relationship' | 'timeline' | 'general';

export interface RecallOwnerScope {
  readonly ownerIds: readonly string[];
  readonly requiredOwnerIds: readonly string[];
  readonly fallback: 'none' | 'public_relevance';
}

export interface GenerationRecallSubQuery {
  readonly id: string;
  readonly query: string;
  readonly targetOwnerIds: readonly string[];
  readonly targetKinds: readonly string[];
}

export interface GenerationRecallIntentPlan {
  readonly query: string;
  readonly timeMode: GenerationRecallTimeMode;
  readonly actorMode: GenerationRecallActorMode;
  readonly namedOwnerIds: readonly string[];
  readonly entityKeys: readonly string[];
  readonly requestedKinds: readonly string[];
  readonly subQueries: readonly GenerationRecallSubQuery[];
  readonly complexity: GenerationRecallComplexity;
  readonly graphHops: 0 | 1 | 2;
  readonly requireVerification: boolean;
  /** Deterministic lexical tokens consumed by the local lexical index. */
  readonly terms: readonly string[];
  readonly source: 'rules' | 'llm' | 'rules-fallback';
  /** Optional only for records created before intent-scoped recall. */
  readonly intentKind?: GenerationRecallIntentKind;
  readonly topicTerms?: readonly string[];
  readonly ownerScope?: RecallOwnerScope;
  readonly recentContextSatisfied?: boolean;
}

export interface RecallCoverageResult {
  readonly covered: boolean;
  readonly missingSubQueryIds: readonly string[];
  readonly missingOwnerIds: readonly string[];
  readonly missingTimeDimensions: readonly string[];
  readonly privacyViolations: readonly {
    readonly ownerId: string;
    readonly traceId: string;
    readonly reason: string;
  }[];
  readonly temporalConflicts: readonly string[];
  readonly requiresExpansion: boolean;
}

export interface RecallCoverageLog extends RecallCoverageResult {
  readonly id: string;
  readonly workspaceId: string;
  readonly chatKey: string;
  readonly planId: string;
  readonly expanded: boolean;
  readonly createdAt: number;
}
