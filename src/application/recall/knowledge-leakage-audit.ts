import type { ActorMemoryPartition } from '../../domain';

export interface KnowledgeLeakageAudit {
  readonly outputHash: string;
  readonly checkedOwners: readonly string[];
  readonly violationCount: number;
  readonly violations: readonly { ownerId: string; leakedFromOwnerId: string; marker: string }[];
  readonly createdAt: number;
}

function hash(value: string): string { let result = 2166136261; for (const char of value) { result ^= char.codePointAt(0) ?? 0; result = Math.imul(result, 16777619); } return (result >>> 0).toString(36); }

function normalizeLabel(value: string): string {
  return value
    .replace(/^\s*[\[【(（]?/u, '')
    .replace(/[\]】)）]?\s*$/u, '')
    .replace(/^\*+|\*+$/gu, '')
    .trim()
    .toLocaleLowerCase();
}

/**
 * Collect only lines with an explicit speaker label.  Narrative paragraphs are
 * deliberately ignored because assigning them to an actor from heuristics can
 * create false privacy violations in a mixed one-call response.
 */
function collectExplicitActorLines(output: string, partitions: readonly ActorMemoryPartition[]): Map<string, string> {
  const byLabel = new Map(partitions
    .filter(item => item.role === 'actor')
    .map(item => [normalizeLabel(item.ownerName), item.ownerId] as const));
  const segments = new Map<string, string>();
  const labelledLine = /^\s*(?:\*{0,3}\s*)?(?:[\[【(（])?([^\]】)）：:\n]{1,120})(?:[\]】)）])?\s*(?::|：)\s*(.+?)\s*$/u;
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(labelledLine);
    if (!match) continue;
    const ownerId = byLabel.get(normalizeLabel(match[1]!));
    if (!ownerId) continue;
    segments.set(ownerId, `${segments.get(ownerId) ?? ''}\n${match[2]!}`);
  }
  return segments;
}

/** Heuristic post-generation audit. It records IDs/markers only, never prompt or chat text. */
export function auditKnowledgeLeakage(output: string, partitions: readonly ActorMemoryPartition[]): KnowledgeLeakageAudit {
  const violations: KnowledgeLeakageAudit['violations'][number][] = [];
  const segmentByOwner = new Map<string, string>();
  for (const match of output.matchAll(/<actor_memory\b[^>]*owner_id="([^"]+)"[^>]*>([\s\S]*?)<\/actor_memory>/gu)) segmentByOwner.set(match[1]!, match[2]!);
  // For ordinary roleplay output, only inspect explicitly attributed lines.
  // An unlabelled paragraph is intentionally not assigned to any actor: a
  // heuristic must not call legitimate mixed narration a privacy violation.
  for (const [ownerId, labelled] of collectExplicitActorLines(output, partitions).entries()) {
    segmentByOwner.set(ownerId, `${segmentByOwner.get(ownerId) ?? ''}\n${labelled}`);
  }
  const seen = new Set<string>();
  for (const target of partitions.filter(partition => partition.role === 'actor')) {
    const targetText = segmentByOwner.get(target.ownerId);
    if (!targetText) continue;
    for (const source of partitions.filter(partition => partition.role === 'actor' && partition.ownerId !== target.ownerId)) {
      for (const packet of source.packets) {
        const markers = [packet.gist, ...packet.details.map(detail => detail.text)].filter(marker => marker.length >= 6);
        const leaked = markers.find(marker => targetText.includes(marker));
        if (leaked) {
          const key = `${target.ownerId}\u0000${source.ownerId}\u0000${hash(leaked)}`;
          if (!seen.has(key)) {
            seen.add(key);
            violations.push({ ownerId: target.ownerId, leakedFromOwnerId: source.ownerId, marker: hash(leaked) });
          }
        }
      }
    }
  }
  return { outputHash: hash(output), checkedOwners: partitions.map(partition => partition.ownerId), violationCount: violations.length, violations, createdAt: Date.now() };
}
