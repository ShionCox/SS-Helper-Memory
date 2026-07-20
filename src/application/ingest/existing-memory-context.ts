import type { MemoryFact } from '../../domain';
import {
  MemoryRecallIndex,
  SemanticRecallService,
  type MemoryRecallMode,
  type MemoryVectorIndexService,
} from '../recall';
import type { GraphRecallCandidateProvider } from '../graph';
import type { ExistingMemoryContextItem, SourceBlock } from './types';

const MAX_REFERENCE_QUERY_CHARS = 16_000;

export interface ExistingMemoryContextOptions {
  chatKey: string;
  sources: readonly SourceBlock[];
  maxItems: number;
  maxChars: number;
  mode: MemoryRecallMode;
  characterKeys?: readonly string[];
  worldKeys?: readonly string[];
  sceneKeys?: readonly string[];
  graphMaxHops?: 1 | 2;
  graphMaxEdges?: number;
}

function buildReferenceQuery(sources: readonly SourceBlock[]): string {
  const chunks = sources
    .map((source) => `[${source.role}]\n${source.content.trim()}`)
    .filter(Boolean);
  const selected: string[] = [];
  let remaining = MAX_REFERENCE_QUERY_CHARS;
  for (let index = chunks.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const chunk = chunks[index]!;
    if (chunk.length <= remaining) {
      selected.push(chunk);
      remaining -= chunk.length;
    } else {
      selected.push(chunk.slice(-remaining));
      remaining = 0;
    }
  }
  return selected.reverse().join('\n\n').trim();
}

function toContextItem(fact: MemoryFact, index: number): ExistingMemoryContextItem {
  return {
    referenceId: `M${index + 1}`,
    kind: fact.kind,
    subjectKey: fact.subjectKey,
    predicateKey: fact.predicateKey,
    ...(fact.objectKey === undefined ? {} : { objectKey: fact.objectKey }),
    content: fact.content,
    ...(fact.validFrom === undefined ? {} : { validFrom: fact.validFrom }),
    ...(fact.validUntil === undefined ? {} : { validUntil: fact.validUntil }),
    ...(fact.stableAnchor === undefined ? {} : { stable: fact.stableAnchor }),
  };
}

function contentLength(item: ExistingMemoryContextItem): number {
  return Array.from(item.content).length;
}

function clampItemCount(value: number): number {
  return Number.isFinite(value) ? Math.min(10, Math.max(1, Math.trunc(value))) : 1;
}

function clampCharacterBudget(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/**
 * A capture-scoped, immutable view of the facts that existed before the job
 * started. It deliberately uses a separate recall index so later batches and
 * writes from the same job cannot feed back into extraction.
 */
export class ExistingMemoryContextRetriever {
  private readonly recall: SemanticRecallService;

  constructor(
    baselineFacts: readonly MemoryFact[],
    vectors: MemoryVectorIndexService,
    graph?: GraphRecallCandidateProvider,
  ) {
    this.recall = new SemanticRecallService(new MemoryRecallIndex(baselineFacts), vectors, graph);
  }

  async load(options: ExistingMemoryContextOptions): Promise<readonly ExistingMemoryContextItem[]> {
    const query = buildReferenceQuery(options.sources);
    if (!query) return [];
    try {
      const maxItems = clampItemCount(options.maxItems);
      const maxChars = clampCharacterBudget(options.maxChars);
      const requestedItems = Math.max(4, maxItems);
      const result = await this.recall.recall({
        chatKey: options.chatKey,
        query,
        maxItems: requestedItems,
        characterKeys: options.characterKeys ?? [],
        worldKeys: options.worldKeys ?? [],
        sceneKeys: options.sceneKeys ?? [],
      }, options.mode, 'off', options.graphMaxHops === undefined
        ? undefined
        : { maxHops: options.graphMaxHops, maxEdges: options.graphMaxEdges ?? 12 });
      const context: ExistingMemoryContextItem[] = [];
      let usedChars = 0;
      for (const item of result.items) {
        if (context.length >= maxItems) break;
        const contextItem = toContextItem(item.fact as MemoryFact, context.length);
        const nextChars = contentLength(contextItem);
        // Never cut a fact in half.  A later, smaller candidate can still be
        // useful, so skip an oversized item instead of abandoning the batch.
        if (usedChars + nextChars > maxChars) continue;
        context.push(contextItem);
        usedChars += nextChars;
      }
      return Object.freeze(context);
    } catch {
      // This context is an optional extraction aid. The caller must still be
      // able to capture source-grounded facts when vector/keyword recall fails.
      return [];
    }
  }
}

export const existingMemoryContextLimits = Object.freeze({
  maxQueryChars: MAX_REFERENCE_QUERY_CHARS,
});
