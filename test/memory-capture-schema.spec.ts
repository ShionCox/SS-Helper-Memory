import { describe, expect, it } from 'vitest';
import {
  buildStructuredCaptureSchema,
  StructuredMemoryCaptureExtractor,
  type MemoryLlmApi,
} from '../src/application/ingest/llm-extractor';
import type { MemoryExtractionInput, SourceBlock } from '../src/application/ingest/types';

const source: SourceBlock = {
  id: 'message:1',
  chatKey: 'chat',
  kind: 'message',
  role: 'assistant',
  content: '白夕琴乃在加油站报告：地下储油库燃油约占总容量的百分之四十五。',
  createdAt: 123,
  floor: 1,
};

describe('Claim capture schema', () => {
  it('uses a small fixed shape and never asks the model for machine time or derived records', () => {
    const schema = buildStructuredCaptureSchema([source.id]) as Record<string, any>;
    expect(schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['actorCandidates', 'locationCandidates', 'episodes', 'claims'],
    });
    expect(Object.keys(schema.properties)).toEqual(['actorCandidates', 'locationCandidates', 'episodes', 'claims']);
    const episodeProperties = schema.properties.episodes.items.properties;
    const claimProperties = schema.properties.claims.items.properties;
    expect(episodeProperties).not.toHaveProperty('occurredAt');
    expect(episodeProperties).not.toHaveProperty('floorStart');
    expect(episodeProperties).not.toHaveProperty('floorEnd');
    expect(claimProperties).not.toHaveProperty('validFrom');
    expect(claimProperties).not.toHaveProperty('validUntil');
    expect(schema.properties).not.toHaveProperty('observations');
    expect(schema.properties).not.toHaveProperty('facts');
    expect(claimProperties.sourceRef.enum).toEqual([source.id]);
  });

  it('serializes stable actor/location directories and preserves a valid Claim', async () => {
    let userPayload: Record<string, any> | undefined;
    const llm: MemoryLlmApi = {
      async runTask<T>(input: Parameters<MemoryLlmApi['runTask']>[0]) {
        userPayload = JSON.parse(input.input.messages.find((message: { role: string }) => message.role === 'user')?.content ?? '{}');
        return {
          ok: true as const,
          data: {
            actorCandidates: [],
            locationCandidates: [],
            episodes: [{
              localId: 'episode-1',
              sourceRefs: [source.id],
              participantRefs: ['actor:kotono'],
              presentRefs: ['actor:kotono'],
              mentionedRefs: [],
              locationRef: 'location:station',
              storyTimeText: '灾变第三十八日清晨',
              summary: '琴乃侦察加油站地下储油库。',
            }],
            claims: [{
              localId: 'claim-1',
              sourceRef: source.id,
              episodeLocalId: 'episode-1',
              kind: 'state',
              subjectRef: 'location:station',
              subjectText: '',
              predicateKey: '燃油储量',
              objectText: '总容量的百分之四十五',
              content: '加油站地下储油库燃油约占总容量的百分之四十五。',
              evidenceExcerpt: '地下储油库燃油约占总容量的百分之四十五',
              knowledge: {
                mode: 'experienced', privacy: 'limited', ownerRefs: ['actor:kotono'],
                speakerRef: 'actor:kotono', viewpointRef: 'actor:kotono', observerRefs: ['actor:kotono'],
                presentRefs: ['actor:kotono'], mentionedRefs: [],
              },
              confidence: 0.98,
              stableAnchor: false,
            }],
          } as T,
          meta: { resourceId: 'test', model: 'model' },
        };
      },
    };
    const input: MemoryExtractionInput = {
      chatKey: source.chatKey,
      sources: [source],
      knownActorContext: [{ referenceId: 'actor:kotono', ownerId: 'owner:internal', canonicalName: '白夕琴乃（重构体）', aliases: ['琴乃'], status: 'confirmed' }],
      knownLocationContext: [{ referenceId: 'location:station', locationId: 'location:internal', canonicalName: '加油站', aliases: ['目标加油站'], status: 'confirmed' }],
    };
    const result = await new StructuredMemoryCaptureExtractor(() => llm).extract(input);

    expect(userPayload?.knownActors).toEqual([{ ref: 'actor:kotono', canonicalName: '白夕琴乃（重构体）', aliases: ['琴乃'], status: 'confirmed' }]);
    expect(userPayload?.knownLocations).toEqual([{ ref: 'location:station', canonicalName: '加油站', aliases: ['目标加油站'], status: 'confirmed' }]);
    expect(JSON.stringify(userPayload)).not.toContain('owner:internal');
    expect(JSON.stringify(userPayload)).not.toContain('location:internal');
    expect(result.claims[0]).toMatchObject({ kind: 'state', confidence: 0.98, subjectRef: 'location:station' });
    expect(result.episodes[0]).toMatchObject({ storyTimeText: '灾变第三十八日清晨' });
  });

  it('keeps overlap visible while restricting writable source enums', async () => {
    const overlap: SourceBlock = { ...source, id: 'message:old', content: '上一批只读上下文。' };
    let schema: Record<string, any> | undefined;
    let payload: Record<string, any> | undefined;
    const llm: MemoryLlmApi = {
      async runTask<T>(input: Parameters<MemoryLlmApi['runTask']>[0]) {
        schema = input.schema as Record<string, any>;
        payload = JSON.parse(input.input.messages[1]?.content ?? '{}');
        return { ok: true as const, data: { actorCandidates: [], locationCandidates: [], episodes: [], claims: [] } as T };
      },
    };
    await new StructuredMemoryCaptureExtractor(() => llm).extract({
      chatKey: source.chatKey,
      sources: [overlap, source],
      writableSourceRefs: [source.id],
    });
    expect(payload).toMatchObject({ allowedSourceRefs: [source.id], contextOnlySourceRefs: [overlap.id] });
    expect(schema?.properties.episodes.items.properties.sourceRefs.items.enum).toEqual([source.id]);
    expect(schema?.properties.claims.items.properties.sourceRef.enum).toEqual([source.id]);
  });

  it('normalizes deterministic provider mistakes without inventing evidence', async () => {
    const llm: MemoryLlmApi = {
      async runTask<T>() {
        return {
          ok: true as const,
          data: {
            actorCandidates: [],
            locationCandidates: [],
            episodes: [],
            claims: [{
              localId: 'claim-1', sourceRef: source.id, episodeLocalId: '', kind: 'action',
              subjectRef: '', subjectKey: '白夕琴乃', predicateKey: '报告', objectKey: '燃油储量',
              content: '白夕琴乃报告地下储油库燃油约占百分之四十五。',
              evidenceExcerpt: '燃油约占总容量百分之四十五',
              knowledge: {
                mode: 'experienced', privacy: 'limited', ownerRefs: [], speakerRef: '',
                viewportRef: '', observerRefs: [], presentRefs: [], mentionedRefs: [],
              },
              confidence: '90%', stable: false,
            }],
          } as T,
        };
      },
    };
    const result = await new StructuredMemoryCaptureExtractor(() => llm).extract({ chatKey: source.chatKey, sources: [source] });
    expect(result.claims[0]).toMatchObject({ kind: 'event', subjectText: '白夕琴乃', objectText: '燃油储量', confidence: 0.9 });
    // The extractor may normalize shape/enums, but it must not silently bind a
    // semantically different quote. The Capture validator will reject/repair
    // this non-contiguous evidence explicitly.
    expect(result.claims[0]!.evidenceExcerpt).toBe('燃油约占总容量百分之四十五');
    expect(source.content).not.toContain(result.claims[0]!.evidenceExcerpt);
    expect(result.diagnostics?.deterministicRepairs).toBeGreaterThan(0);
  });
});
