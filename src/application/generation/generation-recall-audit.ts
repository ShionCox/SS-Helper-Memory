import type { ChatMessageSnapshot } from '@ss-helper/sdk';
import {
  stableMemoryRecordKey,
  type ActorMemoryPartition,
  type ActorRecallCandidatePartition,
  type GenerationRecallDetail,
  type GenerationRecallOwnerDetail,
} from '../../domain';
import type { PreparedGenerationMemory } from './generation-memory-coordinator';

function packetPartitions(prepared: PreparedGenerationMemory, attemptIndex: number): readonly ActorMemoryPartition[] {
  const response = prepared.attempts[attemptIndex]?.response;
  return response === undefined ? [] : [response.world, response.narrator, ...response.actors];
}

function candidatePartitions(prepared: PreparedGenerationMemory, attemptIndex: number): readonly ActorRecallCandidatePartition[] {
  return prepared.attempts[attemptIndex]?.response.candidatePartitions ?? [];
}

function ownerDetails(prepared: PreparedGenerationMemory, attemptIndex: number): GenerationRecallOwnerDetail[] {
  const candidates = candidatePartitions(prepared, attemptIndex);
  const packets = packetPartitions(prepared, attemptIndex);
  const candidateByOwner = new Map(candidates.map(partition => [partition.ownerId, partition]));
  const packetByOwner = new Map(packets.map(partition => [partition.ownerId, partition]));
  const ownerIds = [...new Set([...candidateByOwner.keys(), ...packetByOwner.keys()])];
  const final = attemptIndex === prepared.attempts.length - 1;
  const included = new Set(prepared.prompt.includedTraceIds);
  return ownerIds.map((ownerId) => {
    const candidatePartition = candidateByOwner.get(ownerId);
    const packetPartition = packetByOwner.get(ownerId);
    const diagnostics = prepared.attempts[attemptIndex]?.response.diagnostics;
    return {
      ownerId,
      ownerName: candidatePartition?.ownerName ?? packetPartition?.ownerName ?? ownerId,
      role: candidatePartition?.role ?? packetPartition?.role ?? 'unknown',
      packets: packetPartition?.packets ?? [],
      ...(diagnostics?.permissionByOwner?.[ownerId] === undefined ? {} : { permission: diagnostics.permissionByOwner[ownerId] }),
      ...(diagnostics?.retrievalLevelByOwner?.[ownerId] === undefined ? {} : { retrievalLevel: diagnostics.retrievalLevelByOwner[ownerId] }),
      ...(diagnostics?.retrievalStagesByOwner?.[ownerId] === undefined ? {} : { retrievalStages: [...diagnostics.retrievalStagesByOwner[ownerId]!] }),
      candidates: (candidatePartition?.candidates ?? []).map((candidate) => {
        const injected = final && candidate.traceIds.some(traceId => included.has(traceId));
        return {
          factId: candidate.factId,
          ...(candidate.applicableOwnerIds?.length ? { applicableOwnerIds: [...candidate.applicableOwnerIds] } : {}),
          ...(candidate.factKind ? { factKind: candidate.factKind } : {}),
          traceIds: [...candidate.traceIds],
          sourceFloors: [...candidate.sourceFloors],
          summary: candidate.summary,
          score: candidate.score,
          selected: candidate.selected,
          state: injected
            ? 'injected' as const
            : candidate.selected
              ? 'selected_not_injected' as const
              : 'not_selected' as const,
          reasonCodes: [...candidate.reasonCodes],
          ...(candidate.omittedReason === undefined ? {} : { omittedReason: candidate.omittedReason }),
          ...(candidate.lexicalScore === undefined ? {} : { lexicalScore: candidate.lexicalScore }),
          ...(candidate.vectorScore === undefined ? {} : { vectorScore: candidate.vectorScore }),
          ...(candidate.graphScore === undefined ? {} : { graphScore: candidate.graphScore }),
          ...(candidate.fusionScore === undefined ? {} : { fusionScore: candidate.fusionScore }),
          ...(candidate.rerankScore === undefined ? {} : { rerankScore: candidate.rerankScore }),
        };
      }),
    };
  });
}

export function createGenerationRecallDetail(
  prepared: PreparedGenerationMemory,
  message: ChatMessageSnapshot,
  createdAt = Date.now(),
): GenerationRecallDetail {
  const messageId = message.stableId ?? message.id;
  const identity = `${prepared.castPlan.id}\0${messageId}\0${message.variantId ?? ''}`;
  const candidateOccurrenceCount = prepared.attempts.reduce((sum, attempt) => sum + attempt.response.diagnostics.candidateCount, 0);
  const uniqueCandidateCount = new Set(prepared.attempts.flatMap(attempt => (attempt.response.candidatePartitions ?? []).flatMap(partition => partition.candidates.map(candidate => candidate.factId)))).size;
  const injectedUniqueCount = new Set([prepared.recalled.world, prepared.recalled.narrator, ...prepared.recalled.actors]
    .flatMap(partition => partition.packets)
    .filter(packet => prepared.prompt.includedTraceIds.includes(packet.traceId))
    .map(packet => packet.factId)).size;
  return {
    id: `generation-recall:${stableMemoryRecordKey(identity)}`,
    workspaceId: prepared.castPlan.workspaceId,
    chatKey: prepared.castPlan.chatKey,
    planId: prepared.castPlan.id,
    messageId,
    ...(message.stableId === undefined ? { messageIdIsSynthetic: true as const } : {}),
    messageIndex: message.index,
    ...(message.createdAt === undefined ? {} : { messageCreatedAt: message.createdAt }),
    ...(message.variantId === undefined ? {} : { variantId: message.variantId }),
    outputFingerprint: stableMemoryRecordKey(message.text),
    triggerFloor: prepared.castPlan.basedOnFloor,
    createdAt,
    viewpointOwnerId: prepared.castPlan.viewpointOwnerId ?? 'owner:narrator',
    coverage: prepared.coverage,
    expanded: prepared.expanded,
    ...(prepared.intent.intentKind ? { intentKind: prepared.intent.intentKind } : {}),
    ...(prepared.intent.topicTerms?.length ? { topicTermsHash: stableMemoryRecordKey(JSON.stringify(prepared.intent.topicTerms)) } : {}),
    candidateOccurrenceCount,
    uniqueCandidateCount,
    duplicateCandidateCount: Math.max(0, candidateOccurrenceCount - uniqueCandidateCount),
    injectedUniqueCount,
    ...(prepared.recallSkippedReason ? { recallSkippedReason: prepared.recallSkippedReason } : {}),
    ...(prepared.expansionSkippedReason ? { expansionSkippedReason: prepared.expansionSkippedReason } : {}),
    ...(prepared.query?.trim() ? { querySummary: prepared.query.trim().slice(0, 240) } : {}),
    prompt: {
      maxChars: prepared.prompt.diagnostics.maxChars,
      usedChars: prepared.prompt.diagnostics.usedChars,
      includedCount: prepared.prompt.diagnostics.includedCount,
      omittedCount: prepared.prompt.diagnostics.omittedCount,
      includedTraceIds: [...prepared.prompt.includedTraceIds],
      omittedTraceIds: [...prepared.prompt.omittedTraceIds],
    },
    attempts: prepared.attempts.map((attempt, index) => ({
      kind: attempt.kind,
      final: index === prepared.attempts.length - 1,
      candidateCount: attempt.response.diagnostics.candidateCount,
      ...(attempt.response.diagnostics.uniqueCandidateCount === undefined ? {} : { uniqueCandidateCount: attempt.response.diagnostics.uniqueCandidateCount }),
      ...(attempt.response.diagnostics.duplicateCandidateCount === undefined ? {} : { duplicateCandidateCount: attempt.response.diagnostics.duplicateCandidateCount }),
      selectedCount: attempt.response.diagnostics.selectedCount,
      elapsedMs: attempt.response.diagnostics.elapsedMs,
      owners: ownerDetails(prepared, index),
    })),
  };
}
