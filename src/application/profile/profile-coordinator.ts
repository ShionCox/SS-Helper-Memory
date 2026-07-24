import type { ActorMemoryTrace, MemoryFact, ProfileClaim, RelationshipClaim } from '../../domain';

export interface ProfileCoordinatorOptions {
  readonly profileLookbackFloors?: number;
  /** Optional wall-clock lookback used when trace floor metadata is unavailable. */
  readonly profileLookbackMs?: number;
  readonly minProfileEvidenceCount?: number;
  readonly salienceBypass?: number;
}

export interface ProfileIncrement {
  readonly action: 'add' | 'reinforce' | 'weaken' | 'supersede';
  readonly ownerId: string;
  readonly claim: string;
  readonly level: ProfileClaim['level'];
  readonly supportingTraceIds: readonly string[];
  readonly confidence: number;
}

export interface ProfileUpdateResult {
  readonly ownerId: string;
  readonly increments: readonly ProfileIncrement[];
  readonly claims: readonly ProfileClaim[];
  readonly relationships: readonly RelationshipClaim[];
}

function id(value: string): string { let hash = 2166136261; for (const char of value) { hash ^= char.codePointAt(0) ?? 0; hash = Math.imul(hash, 16777619); } return `profile-claim:${(hash >>> 0).toString(36)}`; }
function normalizedSalience(value: number): number {
  const candidate = Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(1, candidate > 1 ? candidate / 100 : candidate));
}

/** Profile is a trace-backed derived layer; it can never invent unsupported claims. */
export class ProfileCoordinator {
  readonly options: Required<ProfileCoordinatorOptions> = { profileLookbackFloors: 30, profileLookbackMs: 0, minProfileEvidenceCount: 3, salienceBypass: 0.85 };
  constructor(options: ProfileCoordinatorOptions = {}) { Object.assign(this.options, options); }

  update(ownerId: string, traces: readonly ActorMemoryTrace[], facts: readonly MemoryFact[], existingClaims: readonly ProfileClaim[] = [], workspaceId = ''): ProfileUpdateResult {
    const factById = new Map(facts.map(fact => [fact.id, fact]));
    const groups = new Map<string, { traceIds: string[]; observationIds: Set<string>; content: string; confidence: number; salience: number; level: ProfileClaim['level']; fact: MemoryFact; seeded: boolean }>();
    const floorValues = traces.map(trace => Number((trace as ActorMemoryTrace & { floor?: unknown }).floor)).filter(Number.isFinite);
    const maxFloor = floorValues.length > 0 ? Math.max(...floorValues) : undefined;
    const cutoff = this.options.profileLookbackMs > 0 ? Date.now() - this.options.profileLookbackMs : 0;
    for (const trace of traces.filter(item => item.ownerId === ownerId
      && (!cutoff || item.updatedAt >= cutoff)
      && (maxFloor === undefined || Number((item as ActorMemoryTrace & { floor?: unknown }).floor) >= maxFloor - this.options.profileLookbackFloors + 1))) {
      const fact = factById.get(trace.factId);
      if (!fact) continue;
      const key = `${fact.kind}:${fact.subjectKey}:${fact.predicateKey}`;
      const current = groups.get(key) ?? { traceIds: [], observationIds: new Set<string>(), content: fact.content, confidence: 0, salience: 0, level: fact.kind === 'identity' ? 5 : fact.kind === 'relationship' ? 4 : fact.kind === 'event' ? 2 : 3, fact, seeded: Boolean(fact.scope?.hostCardKeys?.length || fact.scope?.worldKeys?.length) };
      current.traceIds.push(trace.id);
      for (const observationId of trace.sourceObservationIds) current.observationIds.add(observationId);
      current.confidence = Math.max(current.confidence, trace.beliefConfidence);
      current.salience = Math.max(current.salience, normalizedSalience(trace.emotionalSalience));
      groups.set(key, current);
    }
    const increments: ProfileIncrement[] = [];
    const claims: ProfileClaim[] = [];
    for (const group of groups.values()) {
      if (group.observationIds.size < this.options.minProfileEvidenceCount && group.salience < this.options.salienceBypass && !group.seeded) continue;
      const existing = existingClaims.find(claim => claim.ownerId === ownerId && claim.claim === group.content && claim.status === 'active');
      // ProfileClaim currently has no slot/canonical key that can prove two
      // natural-language claims are mutually exclusive. Treating every other
      // active claim as a conflict incorrectly superseded unrelated identity,
      // relationship and preference statements. Objective fact reconciliation
      // already owns proposition conflicts; the derived profile only adds or
      // reinforces trace-backed claims and weakens claims whose evidence is no
      // longer present.
      const action: ProfileIncrement['action'] = existing ? 'reinforce' : 'add';
      increments.push({ action, ownerId, claim: group.content, level: group.level, supportingTraceIds: [...new Set(group.traceIds)], confidence: group.confidence });
      const timestamp = Date.now();
      claims.push({ id: existing?.id ?? id(`${ownerId}:${group.content}`), ownerId, claim: group.content, level: group.level, supportingTraceIds: [...new Set(group.traceIds)], confidence: group.confidence, status: 'active', createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp });
    }
    // Existing claims with no supporting evidence are explicitly weakened rather than silently dropped.
    const ownerTraceIds = new Set(traces.filter(trace => trace.ownerId === ownerId).map(trace => trace.id));
    for (const prior of existingClaims.filter(claim => claim.ownerId === ownerId && claim.status === 'active')) {
      if (!claims.some(claim => claim.id === prior.id || claim.claim === prior.claim)) {
        const supportingTraceIds = prior.supportingTraceIds.filter(traceId => ownerTraceIds.has(traceId));
        if (supportingTraceIds.length > 0) {
          // The claim may not have reached the promotion threshold again in
          // this update window, but its original trace evidence still exists.
          // Keep it active instead of invalidating a supported profile fact.
          claims.push({ ...prior, supportingTraceIds });
          continue;
        }
        increments.push({ action: 'weaken', ownerId, claim: prior.claim, level: prior.level, supportingTraceIds: [], confidence: Math.max(0, prior.confidence * 0.5) });
        claims.push({ ...prior, supportingTraceIds: [], confidence: Math.max(0, prior.confidence * 0.5), status: 'invalid', updatedAt: Date.now() });
      }
    }
    const relationships: RelationshipClaim[] = [];
    for (const group of groups.values()) {
      if (group.fact.kind !== 'relationship' || group.observationIds.size < this.options.minProfileEvidenceCount && group.salience < this.options.salienceBypass && !group.seeded) continue;
      const fromOwnerId = group.fact.subjectEntityId ?? ownerId;
      const toOwnerId = group.fact.objectEntityId;
      if (!toOwnerId || fromOwnerId === toOwnerId) continue;
      const timestamp = Date.now();
      relationships.push({ id: id(`relationship:${fromOwnerId}:${toOwnerId}:${group.content}`), workspaceId, fromOwnerId, toOwnerId, claim: group.content, supportingTraceIds: [...new Set(group.traceIds)], confidence: group.confidence, status: 'active', createdAt: timestamp, updatedAt: timestamp });
    }
    return { ownerId, increments, claims, relationships };
  }
}
