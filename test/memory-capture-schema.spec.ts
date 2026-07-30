import { describe, expect, it } from 'vitest';
import { LLM_STRUCTURED_TASK_V0 } from '@ss-helper/sdk';
import {
  buildStructuredCaptureSchema,
  buildStructuredRepairSchema,
  StructuredMemoryCaptureExtractor,
  type MemoryLlmClient,
} from '../src/application/ingest/llm-extractor';
import { buildSupportedReferenceDirectory } from '../src/application/actors/supported-reference-directory';
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
  it('builds a source-supported closed set and applies it to every repair reference field', () => {
    const repairSource: SourceBlock = {
      ...source,
      content: '琴乃进入加油站并报告燃油情况。',
      actorRefs: ['owner:kotono'],
      locationRefs: ['location:station:internal'],
    };
    const directory = buildSupportedReferenceDirectory(
      [repairSource],
      [
        { referenceId: 'A01', ownerId: 'owner:kotono', canonicalName: '白夕琴乃', aliases: ['琴乃'], status: 'confirmed' },
        { referenceId: 'A02', ownerId: 'owner:absent', canonicalName: '未登场人物', aliases: [], status: 'confirmed' },
      ],
      [
        { referenceId: 'L01', locationId: 'location:station:internal', canonicalName: '加油站', aliases: [], status: 'confirmed' },
        { referenceId: 'L02', locationId: 'location:absent', canonicalName: '仓库', aliases: [], status: 'confirmed' },
      ],
    );
    expect(directory.allowedActorRefs.map(item => item.referenceId)).toEqual(['A01']);
    expect(directory.allowedLocationRefs.map(item => item.referenceId)).toEqual(['L01']);
    expect(directory.allowedEpisodeRefs).toEqual([]);
    expect(directory.candidateSetHash).toMatch(/^[a-f0-9]{32}$/u);

    const episodeSchema = buildStructuredRepairSchema([source.id], 'episodes', 1, directory) as any;
    const episodeDecision = episodeSchema.properties.decisions.items.properties;
    const episode = episodeDecision.items.items.properties;
    expect(episodeDecision.action.enum).toEqual(['emit', 'drop']);
    expect(episode.participantRefs.items.enum).toEqual(['A01', 'player', 'world', 'narrator']);
    expect(episode.locationRef.enum).toEqual(['', 'L01']);

    const claimSchema = buildStructuredRepairSchema([source.id], 'claims', 1, directory) as any;
    const claim = claimSchema.properties.decisions.items.properties.items.items.properties;
    expect(claim.subjectRef.enum).toEqual(['', 'A01', 'player', 'world', 'narrator', 'L01']);
    expect(claim.episodeLocalId.enum).toEqual(['']);
    expect(claim.knowledge.properties.ownerRefs.items.enum).not.toContain('A02');
  });

  it('uses a small fixed shape and never asks the model for machine time or derived records', () => {
    const schema = buildStructuredCaptureSchema([source.id]) as Record<string, any>;
    expect(schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['actorCandidates', 'locationCandidates', 'itemCandidates', 'episodes', 'claims', 'inventoryOperations'],
    });
    expect(Object.keys(schema.properties)).toEqual(['actorCandidates', 'locationCandidates', 'itemCandidates', 'episodes', 'claims', 'inventoryOperations']);
    const episodeProperties = schema.properties.episodes.items.properties;
    const claimProperties = schema.properties.claims.items.properties;
    expect(episodeProperties).not.toHaveProperty('occurredAt');
    expect(episodeProperties).not.toHaveProperty('floorStart');
    expect(episodeProperties).not.toHaveProperty('floorEnd');
    expect(claimProperties).not.toHaveProperty('validFrom');
    expect(claimProperties).not.toHaveProperty('validUntil');
    expect(schema.properties).not.toHaveProperty('observations');
    expect(schema.properties).not.toHaveProperty('facts');
    expect(schema.properties.actorCandidates.items.properties).not.toHaveProperty('sourceRef');
    expect(schema.properties.locationCandidates.items.properties).not.toHaveProperty('sourceRef');
    expect(claimProperties).not.toHaveProperty('sourceRef');
  });

  it('passes the SDK public-data boundary even when schema nodes are shared', () => {
    expect(LLM_STRUCTURED_TASK_V0.validateRequest!({
      task: 'memory_capture',
      input: { messages: [{ role: 'user', content: source.content }] },
      outputSchema: buildStructuredCaptureSchema([source.id]) as Record<string, never>,
    })).toBe(true);
  });

  it('serializes stable actor/location directories and preserves a valid Claim', async () => {
    let userPayload: Record<string, any> | undefined;
    const llm: MemoryLlmClient = {
      async runTask<T>(input: Parameters<MemoryLlmClient['runTask']>[0]) {
        userPayload = JSON.parse(input.input.messages.find((message: { role: string }) => message.role === 'user')?.content ?? '{}');
        const evidenceSpanId = (input.schema as any).properties.claims.items.properties.evidenceSpanId.enum[0];
        return {
          ok: true as const,
          data: {
            actorCandidates: [],
            locationCandidates: [],
            itemCandidates: [],
            episodes: [{
              localId: 'episode-1',
              evidenceSpanIds: [evidenceSpanId],
              participantRefs: ['actor:kotono'],
              presentRefs: ['actor:kotono'],
              mentionedRefs: [],
              locationRef: 'location:station',
              storyTimeText: '灾变第三十八日清晨',
              summary: '琴乃侦察加油站地下储油库。',
            }],
            claims: [{
              localId: 'claim-1',
              episodeLocalId: 'episode-1',
              kind: 'state',
              subjectRef: 'location:station',
              subjectText: '',
              predicateKey: '燃油储量',
              objectText: '总容量的百分之四十五',
              content: '加油站地下储油库燃油约占总容量的百分之四十五。',
              evidenceSpanId,
              knowledge: {
                mode: 'experienced', privacy: 'limited', ownerRefs: ['actor:kotono'],
                speakerRef: 'actor:kotono', viewpointRef: 'actor:kotono', observerRefs: ['actor:kotono'],
                presentRefs: ['actor:kotono'], mentionedRefs: [],
              },
              confidence: 0.98,
              stableAnchor: false,
            }],
            inventoryOperations: [],
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
    expect(result.claims[0]).toMatchObject({ kind: 'state', confidence: 0.98, subjectRef: 'location:station', sourceRef: source.id });
    expect(result.claims[0]?.evidenceExcerpt).toBe(source.content);
    expect(result.episodes[0]).toMatchObject({ storyTimeText: '灾变第三十八日清晨' });
  });

  it('keeps overlap visible while restricting writable source enums', async () => {
    const overlap: SourceBlock = { ...source, id: 'message:old', content: '上一批只读上下文。' };
    let schema: Record<string, any> | undefined;
    let payload: Record<string, any> | undefined;
    const llm: MemoryLlmClient = {
      async runTask<T>(input: Parameters<MemoryLlmClient['runTask']>[0]) {
        schema = input.schema as Record<string, any>;
        payload = JSON.parse(input.input.messages[1]?.content ?? '{}');
        return { ok: true as const, data: { actorCandidates: [], locationCandidates: [], itemCandidates: [], episodes: [], claims: [], inventoryOperations: [] } as T };
      },
    };
    await new StructuredMemoryCaptureExtractor(() => llm).extract({
      chatKey: source.chatKey,
      sources: [overlap, source],
      writableSourceRefs: [source.id],
    });
    expect(payload).toMatchObject({ allowedSourceRefs: [source.id], contextOnlySourceRefs: [overlap.id] });
    expect(schema?.properties.episodes.items.properties.evidenceSpanIds.items.enum).toEqual(expect.any(Array));
    expect(schema?.properties.episodes.items.properties).not.toHaveProperty('sourceRefs');
    expect(schema?.properties.claims.items.properties).not.toHaveProperty('sourceRef');
  });

  it('does not normalize deterministic provider mistakes or invent evidence', async () => {
    const llm: MemoryLlmClient = {
      async runTask<T>() {
        return {
          ok: true as const,
          data: {
            actorCandidates: [],
            locationCandidates: [],
            itemCandidates: [],
            episodes: [],
            claims: [{
              localId: 'claim-1', episodeLocalId: '', kind: 'action',
              subjectRef: '', subjectKey: '白夕琴乃', predicateKey: '报告', objectKey: '燃油储量',
              content: '白夕琴乃报告地下储油库燃油约占百分之四十五。',
              evidenceSpanId: 'outside-closed-set',
              knowledge: {
                mode: 'experienced', privacy: 'limited', ownerRefs: [], speakerRef: '',
                viewportRef: '', observerRefs: [], presentRefs: [], mentionedRefs: [],
              },
              confidence: '90%', stable: false,
            }],
            inventoryOperations: [],
          } as T,
        };
      },
    };
    const result = await new StructuredMemoryCaptureExtractor(() => llm).extract({
      chatKey: source.chatKey,
      sources: [source],
    });
    expect(result.claims).toEqual([]);
    expect(result.rejections).toEqual([expect.objectContaining({
      code: 'schema_validation_failed',
      fieldPath: '$.claims[0].evidenceSpanId',
      status: 'unresolved',
    })]);
  });
});
