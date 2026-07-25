import type { ActorMemoryTrace, ActorRecallResponse, MemoryUsageLog, UsedMemoryEvidence } from '../../domain';

export interface MemoryUsageClassification {
  readonly evidence: readonly UsedMemoryEvidence[];
  readonly logs: readonly MemoryUsageLog[];
  readonly updatedTraces: readonly ActorMemoryTrace[];
}

function partitionOutput(output: string, ownerName: string): string {
  return output.split(/\r?\n/u)
    .filter(line => line.trimStart().startsWith(`${ownerName}:`) || line.trimStart().startsWith(`${ownerName}：`))
    .join('\n');
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }

/** Only literal/high-confidence use can reinforce a trace. */
export class MemoryUsageClassifier {
  classify(input: {
    readonly output: string;
    readonly response: ActorRecallResponse;
    readonly traces: readonly ActorMemoryTrace[];
    readonly includedTraceIds?: readonly string[];
    readonly planId?: string;
    readonly now?: number;
  }): MemoryUsageClassification {
    const now = input.now ?? Date.now();
    const partitions = [input.response.world, input.response.narrator, ...input.response.actors];
    const included = new Set(input.includedTraceIds ?? partitions.flatMap(partition => partition.packets.map(packet => packet.traceId)));
    const traceById = new Map(input.traces.map(trace => [trace.id, trace]));
    const evidence: UsedMemoryEvidence[] = [];
    const logs: MemoryUsageLog[] = [];
    const updatedTraces: ActorMemoryTrace[] = [];
    for (const partition of partitions) {
      const xmlSegment = input.output.match(new RegExp(`<actor_memory\\b[^>]*owner_id="${escapeRegex(partition.ownerId)}"[^>]*>([\\s\\S]*?)<\\/actor_memory>`, 'u'))?.[1] ?? '';
      const ownerText = `${partitionOutput(input.output, partition.ownerName)}\n${xmlSegment}`;
      for (const packet of partition.packets) {
        if (!included.has(packet.traceId)) continue;
        const explicitMarker = [packet.gist, ...packet.details.map(detail => detail.text)].find(value => value.length >= 6 && ownerText.includes(value));
        const implicitMarker = !explicitMarker && packet.details.find(detail => detail.text.length >= 8 && input.output.includes(detail.text));
        const usage: UsedMemoryEvidence['usage'] = explicitMarker ? 'explicit' : implicitMarker ? 'implicit' : 'not_used';
        const confidence = explicitMarker ? 1 : implicitMarker ? 0.8 : 0;
        const item: UsedMemoryEvidence = { traceId: packet.traceId, factId: packet.factId, ownerId: packet.ownerId, usage, confidence };
        evidence.push(item);
        logs.push({ id: `memory-usage:${packet.traceId}:${now}`, workspaceId: input.response.request.workspaceId, chatKey: input.response.request.chatKey, ...(input.planId ? { planId: input.planId } : {}), ...item, createdAt: now });
        const trace = traceById.get(packet.traceId);
        if (trace && (usage === 'explicit' || (usage === 'implicit' && confidence >= 0.75))) {
          updatedTraces.push({ ...trace, rehearsalCount: (trace.rehearsalCount ?? 0) + 1, lastRehearsedAt: now, traceRevision: (trace.traceRevision ?? 0) + 1, updatedAt: now });
        }
      }
    }
    return { evidence, logs, updatedTraces };
  }
}
