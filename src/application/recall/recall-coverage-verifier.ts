import { FIXED_OWNER_IDS, type ActorMemoryTrace, type ActorRecallResponse, type GenerationCastPlan, type GenerationRecallIntentPlan, type RecallCoverageResult } from '../../domain';

export interface RecallCoverageVerificationInput {
  readonly castPlan: GenerationCastPlan;
  readonly intent: GenerationRecallIntentPlan;
  readonly response: ActorRecallResponse;
  readonly traces?: readonly ActorMemoryTrace[];
}

export interface VerifiedActorRecall {
  readonly results: ActorRecallResponse;
  readonly coverage: RecallCoverageResult;
  readonly expanded: boolean;
  readonly expansionSkippedReason?: 'no_new_candidates';
  readonly attempts: readonly [
    { readonly kind: 'primary'; readonly response: ActorRecallResponse },
    ...Array<{ readonly kind: 'coverage_expansion'; readonly response: ActorRecallResponse }>,
  ];
}

function allPartitions(response: ActorRecallResponse) { return [response.world, response.narrator, ...response.actors]; }

function responseFactIds(response: ActorRecallResponse): Set<string> {
  const candidateIds = (response.candidatePartitions ?? []).flatMap(partition => partition.candidates.map(candidate => candidate.factId));
  return new Set(candidateIds.length > 0 ? candidateIds : allPartitions(response).flatMap(partition => partition.packets.map(packet => packet.factId)));
}

function mergeResponses(primary: ActorRecallResponse, expansion: ActorRecallResponse): ActorRecallResponse {
  const partitionByOwner = new Map<string, (typeof primary.actors)[number]>();
  for (const partition of [...allPartitions(primary), ...allPartitions(expansion)]) {
    const existing = partitionByOwner.get(partition.ownerId);
    const packets = [...new Map([...(existing?.packets ?? []), ...partition.packets].map(packet => [packet.traceId, packet])).values()];
    partitionByOwner.set(partition.ownerId, { ...partition, packets });
  }
  const intentKind = expansion.request.intentPlan?.intentKind;
  const packetLimit = ['world_knowledge', 'actor_entity', 'actor_knowledge'].includes(intentKind ?? '')
    ? Math.min(expansion.request.maxItems ?? 12, 4)
    : ['relationship', 'timeline'].includes(intentKind ?? '')
      ? Math.min(expansion.request.maxItems ?? 12, 6)
      : expansion.request.maxItems ?? 12;
  const accepted = new Set<string>();
  for (const partition of partitionByOwner.values()) {
    partitionByOwner.set(partition.ownerId, {
      ...partition,
      packets: partition.packets.filter(packet => {
        if (accepted.size >= packetLimit || accepted.has(packet.factId)) return false;
        accepted.add(packet.factId);
        return true;
      }),
    });
  }
  const candidateByOwner = new Map<string, NonNullable<ActorRecallResponse['candidatePartitions']>[number]>();
  for (const partition of [...(primary.candidatePartitions ?? []), ...(expansion.candidatePartitions ?? [])]) {
    const existing = candidateByOwner.get(partition.ownerId);
    candidateByOwner.set(partition.ownerId, {
      ...partition,
      candidates: [...new Map([...(existing?.candidates ?? []), ...partition.candidates].map(candidate => [candidate.factId, candidate])).values()],
    });
  }
  const world = partitionByOwner.get(FIXED_OWNER_IDS.world) ?? expansion.world;
  const narrator = partitionByOwner.get(FIXED_OWNER_IDS.narrator) ?? expansion.narrator;
  const actors = [...partitionByOwner.values()].filter(partition => partition.ownerId !== world.ownerId && partition.ownerId !== narrator.ownerId);
  const candidateCount = (primary.diagnostics.candidateCount ?? 0) + (expansion.diagnostics.candidateCount ?? 0);
  const uniqueCandidateCount = new Set([...candidateByOwner.values()].flatMap(partition => partition.candidates.map(candidate => candidate.factId))).size;
  return {
    ...expansion,
    world,
    narrator,
    actors,
    candidatePartitions: [...candidateByOwner.values()],
    diagnostics: {
      ...expansion.diagnostics,
      candidateCount,
      uniqueCandidateCount,
      duplicateCandidateCount: Math.max(0, candidateCount - uniqueCandidateCount),
      selectedCount: [...partitionByOwner.values()].reduce((sum, partition) => sum + partition.packets.length, 0),
    },
  };
}

function containsQuerySignal(text: string, query: string): boolean {
  const tokens: string[] = [];
  for (const match of query.matchAll(/[\p{Script=Han}]{2,}|[a-z0-9_:-]{2,}/giu)) {
    const value = match[0]!.toLocaleLowerCase();
    if (/^\p{Script=Han}+$/u.test(value) && value.length > 3) {
      for (let index = 0; index < value.length - 1; index += 1) tokens.push(value.slice(index, index + 2));
    } else tokens.push(value);
  }
  const normalized = text.toLocaleLowerCase();
  return tokens.length === 0 || tokens.some(token => normalized.includes(token));
}

/** Verifies owner, sub-query, time and privacy coverage and permits one expansion. */
export class RecallCoverageVerifier {
  verify(input: RecallCoverageVerificationInput): RecallCoverageResult {
    const partitions = allPartitions(input.response);
    const byOwner = new Map(partitions.map(partition => [partition.ownerId, partition]));
    const requiredOwners = input.intent.ownerScope
      ? [...input.intent.ownerScope.requiredOwnerIds]
      : [...input.castPlan.requiredOwnerIds];
    if (!input.intent.ownerScope && input.castPlan.viewpointOwnerId
      && ![FIXED_OWNER_IDS.world, FIXED_OWNER_IDS.narrator, FIXED_OWNER_IDS.player, FIXED_OWNER_IDS.unknown].includes(input.castPlan.viewpointOwnerId as never)
      && !requiredOwners.includes(input.castPlan.viewpointOwnerId)) requiredOwners.push(input.castPlan.viewpointOwnerId);
    const missingOwnerIds = requiredOwners.filter(ownerId => (byOwner.get(ownerId)?.packets.length ?? 0) === 0);
    const missingSubQueryIds = input.intent.subQueries.filter(subQuery => {
      const owners = input.intent.intentKind === 'world_knowledge' && input.intent.ownerScope?.fallback === 'public_relevance'
        ? [...new Set([...subQuery.targetOwnerIds, ...input.response.actors.map(partition => partition.ownerId)])]
        : subQuery.targetOwnerIds.length > 0 ? subQuery.targetOwnerIds : requiredOwners;
      const packets = owners.flatMap(ownerId => byOwner.get(ownerId)?.packets ?? []);
      return packets.length === 0 || !packets.some(packet => containsQuerySignal([packet.gist, ...packet.details.map(detail => detail.text)].join(' '), subQuery.query));
    }).map(subQuery => subQuery.id);
    const traceById = new Map((input.traces ?? []).map(trace => [trace.id, trace]));
    const privacyViolations: RecallCoverageResult['privacyViolations'][number][] = [];
    for (const partition of partitions) {
      const permission = input.castPlan.permissionByOwner[partition.ownerId];
      if (permission !== 'public_only' && permission !== 'identity_only' && permission !== 'none') continue;
      for (const packet of partition.packets) {
        const trace = traceById.get(packet.traceId);
        if (!trace) continue;
        if (permission === 'none' || trace.privacy !== 'public') privacyViolations.push({ ownerId: partition.ownerId, traceId: trace.id, reason: `${permission} 权限不允许 ${trace.privacy} 痕迹` });
      }
    }
    const missingTimeDimensions = input.intent.timeMode === 'timeline'
      && partitions.flatMap(partition => partition.packets).length < 2
      ? ['timeline']
      : [];
    const temporalConflicts: string[] = [];
    const covered = missingOwnerIds.length === 0 && missingSubQueryIds.length === 0 && missingTimeDimensions.length === 0 && privacyViolations.length === 0;
    return {
      covered,
      missingSubQueryIds,
      missingOwnerIds,
      missingTimeDimensions,
      privacyViolations,
      temporalConflicts,
      requiresExpansion: !covered && privacyViolations.length === 0 && (missingOwnerIds.length > 0 || missingSubQueryIds.length > 0 || missingTimeDimensions.length > 0),
    };
  }

  async verifyWithExpansion(input: RecallCoverageVerificationInput, expand?: (coverage: RecallCoverageResult) => Promise<ActorRecallResponse>): Promise<VerifiedActorRecall> {
    const first = this.verify(input);
    if (!first.requiresExpansion || !expand) {
      const results = { ...input.response, diagnostics: { ...input.response.diagnostics, coverage: first } };
      return {
        results,
        coverage: first,
        expanded: false,
        attempts: [{ kind: 'primary', response: results }],
      };
    }
    const expandedResponse = await expand(first);
    const primaryFacts = responseFactIds(input.response);
    const expansionFacts = responseFactIds(expandedResponse);
    if (![...expansionFacts].some(factId => !primaryFacts.has(factId))) {
      const results = { ...input.response, diagnostics: { ...input.response.diagnostics, coverage: first } };
      return { results, coverage: first, expanded: false, expansionSkippedReason: 'no_new_candidates', attempts: [{ kind: 'primary', response: results }] };
    }
    const merged = mergeResponses(input.response, expandedResponse);
    const second = this.verify({ ...input, response: merged });
    const results = { ...merged, diagnostics: { ...merged.diagnostics, coverage: second } };
    return {
      results,
      coverage: second,
      expanded: true,
      attempts: [
        { kind: 'primary', response: { ...input.response, diagnostics: { ...input.response.diagnostics, coverage: first } } },
        { kind: 'coverage_expansion', response: results },
      ],
    };
  }
}
