export type GenerationRecallTimeMode = 'current' | 'historical' | 'timeline' | 'unknown';
export type GenerationRecallActorMode = 'single_pov' | 'planned_cast' | 'named_actors' | 'world' | 'narrator';
export type GenerationRecallComplexity = 'direct' | 'multi_topic' | 'multi_hop';

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
  /** Compatibility tokens consumed by the existing lexical index. */
  readonly terms: readonly string[];
  readonly source: 'rules' | 'llm' | 'rules-fallback';
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
