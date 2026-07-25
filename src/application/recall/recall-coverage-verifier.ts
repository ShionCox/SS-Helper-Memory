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
}

function allPartitions(response: ActorRecallResponse) { return [response.world, response.narrator, ...response.actors]; }

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
    const requiredOwners = [...input.castPlan.requiredOwnerIds];
    if (input.castPlan.viewpointOwnerId
      && ![FIXED_OWNER_IDS.world, FIXED_OWNER_IDS.narrator, FIXED_OWNER_IDS.player, FIXED_OWNER_IDS.unknown].includes(input.castPlan.viewpointOwnerId as never)
      && !requiredOwners.includes(input.castPlan.viewpointOwnerId)) requiredOwners.push(input.castPlan.viewpointOwnerId);
    const missingOwnerIds = requiredOwners.filter(ownerId => (byOwner.get(ownerId)?.packets.length ?? 0) === 0);
    const missingSubQueryIds = input.intent.subQueries.filter(subQuery => {
      const owners = subQuery.targetOwnerIds.length > 0 ? subQuery.targetOwnerIds : requiredOwners;
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
    if (!first.requiresExpansion || !expand) return { results: { ...input.response, diagnostics: { ...input.response.diagnostics, coverage: first } }, coverage: first, expanded: false };
    const expandedResponse = await expand(first);
    const second = this.verify({ ...input, response: expandedResponse });
    return { results: { ...expandedResponse, diagnostics: { ...expandedResponse.diagnostics, coverage: second } }, coverage: second, expanded: true };
  }
}
