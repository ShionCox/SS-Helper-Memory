import { describe, expect, it } from 'vitest';
import { StructuredMemoryCaptureExtractor, type MemoryLlmApi } from '../src/application/ingest/llm-extractor';
import type { MemoryExtractionInput, SourceBlock } from '../src/application/ingest/types';

const source: SourceBlock = {
  id: 'message:1',
  chatKey: 'chat',
  kind: 'message',
  role: 'assistant',
  content: '紫罗可以发射紫色尖刺。',
  createdAt: 1,
};

describe('structured capture schema', () => {
  it('advertises and preserves capability facts returned by the model', async () => {
    let schema: Record<string, unknown> | undefined;
    const llm: MemoryLlmApi = {
      async runTask<T>(input: Parameters<MemoryLlmApi['runTask']>[0]) {
        schema = input.schema as Record<string, unknown>;
        return {
          ok: true as const,
          data: {
            actorCandidates: [],
            episodes: [],
            observations: [],
            facts: [{
              localId: 'fact:1',
              kind: 'capability',
              sourceRef: source.id,
              subjectKey: '紫罗',
              predicateKey: '发射',
              objectKey: '紫色尖刺',
              content: '紫罗可以发射紫色尖刺。',
              entityKeys: ['紫罗'],
              ownerRefs: [],
              confidence: 0.95,
              privacy: 'public',
              knowledgeMode: 'asserted',
              evidenceExcerpt: source.content,
            }],
          } as T,
        };
      },
    };
    const input: MemoryExtractionInput = { chatKey: source.chatKey, sources: [source] };
    const result = await new StructuredMemoryCaptureExtractor(() => llm).extract(input);
    const factSchema = (schema?.properties as Record<string, unknown> | undefined)?.facts as Record<string, unknown>;
    expect(factSchema).toMatchObject({ type: 'array', maxItems: 24, items: { type: 'object' } });
    expect(result.facts[0]?.kind).toBe('capability');
  });
});
