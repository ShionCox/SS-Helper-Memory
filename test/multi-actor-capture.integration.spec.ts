import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ActorRegistry, MultiActorCaptureService } from '../src/application/actors';
import type { SourceBlock, StructuredCaptureResult } from '../src/application/ingest/types';

const rows = readFileSync(new URL('./fixtures/multi-actor-story.jsonl', import.meta.url), 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line) as SourceBlock);
const extractor = { extract: async (): Promise<StructuredCaptureResult> => ({
  actorCandidates: [
    { localId: 'a', displayName: 'A', sourceRefs: ['m1'], evidenceExcerpts: ['A说：我找到了铜钥匙。'], confidence: 0.95 },
    { localId: 'b', displayName: 'B', sourceRefs: ['m2'], evidenceExcerpts: ['B站在门外'], confidence: 0.95 },
    { localId: 'p', displayName: '玩家', sourceRefs: ['m4'], evidenceExcerpts: ['玩家在第五层'], confidence: 0.9 },
  ],
  episodes: [{ localId: 'e1', sourceRefs: ['m1', 'm2', 'm3'], participantRefs: ['a', 'b'], presentRefs: ['a', 'b'], mentionedRefs: ['a', 'b'], floorStart: 1, floorEnd: 3 }],
  observations: [
    { localId: 'o1', sourceRef: 'm1', episodeLocalId: 'e1', speakerRef: 'a', viewpointRef: 'a', channel: 'public_speech', privacy: 'public', observerRefs: ['a'], presentRefs: ['a'], factRefs: ['f1'], excerpt: 'A说：我找到了铜钥匙。' },
    { localId: 'o2', sourceRef: 'm3', episodeLocalId: 'e1', speakerRef: 'a', viewpointRef: 'a', channel: 'private_thought', privacy: 'private', observerRefs: ['a'], presentRefs: ['a'], factRefs: ['f2'], excerpt: 'A心想：不能让B知道秘密。' },
    { localId: 'o3', sourceRef: 'm5', episodeLocalId: 'e1', speakerRef: 'b', viewpointRef: 'b', channel: 'rumor', privacy: 'public', observerRefs: ['b'], presentRefs: ['b'], factRefs: ['f3'], excerpt: 'B听说A已经背叛了城主，但这只是传闻。' },
  ],
  facts: [
    { localId: 'f1', kind: 'state', sourceRef: 'm1', subjectKey: 'A', predicateKey: '持有', content: 'A持有铜钥匙这一事实', confidence: 0.95, evidenceExcerpt: 'A说：我找到了铜钥匙。' },
    { localId: 'f2', kind: 'state', sourceRef: 'm3', subjectKey: 'A', predicateKey: '知道秘密', content: 'A知道不能让B知道的秘密', confidence: 0.9, evidenceExcerpt: 'A心想：不能让B知道秘密。' },
    { localId: 'f3', kind: 'state', sourceRef: 'm5', subjectKey: 'A', predicateKey: '背叛城主', content: 'A可能背叛城主（传闻）', confidence: 0.4, evidenceExcerpt: 'B听说A已经背叛了城主' },
  ],
}) };

describe('multi-actor capture fixture', () => {
  it('projects private thought and rumor to the correct owner only', async () => {
    const registry = new ActorRegistry('w');
    const result = await new MultiActorCaptureService(registry, extractor).capture({ workspaceId: 'w', chatKey: 'chat', sources: rows });
    const a = registry.resolveMention('A')!.owner.id;
    const b = registry.resolveMention('B')!.owner.id;
    expect(result.traces.find(t => t.factId.includes('f2'))?.ownerId ?? result.traces.find(t => t.knowledgeMode === 'experienced')?.ownerId).toBe(a);
    expect(result.traces.filter(t => t.privacy === 'private').every(t => t.ownerId === a)).toBe(true);
    expect(result.traces.filter(t => t.knowledgeMode === 'believed').every(t => t.ownerId === b)).toBe(true);
  });

  it('keeps capability facts as a first-class v0 kind', async () => {
    const source: SourceBlock = {
      id: 'capability:1', chatKey: 'capability-chat', kind: 'message', role: 'assistant',
      content: '紫罗可以发射紫色尖刺。', createdAt: 1,
    };
    const capabilityExtractor = {
      extract: async (): Promise<StructuredCaptureResult> => ({
        actorCandidates: [{ localId: 'z', displayName: '紫罗', sourceRefs: [source.id], evidenceExcerpts: [source.content], confidence: 1 }],
        episodes: [], observations: [],
        facts: [{ localId: 'f-capability', kind: 'capability', sourceRef: source.id, subjectKey: '紫罗', predicateKey: '发射', objectKey: '紫色尖刺', content: '紫罗可以发射紫色尖刺。', entityKeys: ['紫罗'], ownerRefs: [], confidence: 0.95, privacy: 'public', knowledgeMode: 'asserted', evidenceExcerpt: source.content }],
      }),
    };
    const result = await new MultiActorCaptureService(new ActorRegistry('capability-workspace'), capabilityExtractor).capture({ workspaceId: 'capability-workspace', chatKey: source.chatKey, sources: [source] });
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]?.kind).toBe('capability');
  });

  it('encodes host chat keys before using them in workspace record ids', async () => {
    const chatKey = '小時 - 2026-04-23@10h30m03s277ms imported.jsonl';
    const sources = rows.map(source => ({ ...source, chatKey }));
    const result = await new MultiActorCaptureService(new ActorRegistry('encoded-key-workspace'), extractor).capture({
      workspaceId: 'encoded-key-workspace', chatKey, sources,
    });
    const safeRecordId = /^[A-Za-z0-9_.!~*'()%:-]+$/u;
    expect([...result.episodes, ...result.observations, ...result.facts].every(item => safeRecordId.test(item.id))).toBe(true);
    expect(result.facts[0]?.id).toContain(encodeURIComponent(chatKey));
  });

  it('uses overlap as read-only context and forwards extraction settings', async () => {
    const oldSource: SourceBlock = { id: 'old', chatKey: 'chat', kind: 'message', role: 'user', content: '旧楼层只提供上下文。', createdAt: 1, floor: 1 };
    const newSource: SourceBlock = { id: 'new', chatKey: 'chat', kind: 'message', role: 'assistant', content: '新楼层确认紫罗拥有一把银钥匙。', createdAt: 2, floor: 2 };
    const extract = vi.fn(async (): Promise<StructuredCaptureResult> => ({
      actorCandidates: [
        { localId: 'old-actor', displayName: '旧人物', sourceRefs: ['old'], evidenceExcerpts: ['旧楼层只提供上下文。'], confidence: 1 },
        { localId: 'new-actor', displayName: '紫罗', sourceRefs: ['new'], evidenceExcerpts: ['紫罗拥有一把银钥匙'], confidence: 1 },
      ],
      episodes: [
        { localId: 'old-episode', sourceRefs: ['old'], floorStart: 1, floorEnd: 1 },
        { localId: 'new-episode', sourceRefs: ['old', 'new'], floorStart: 1, floorEnd: 2 },
      ],
      observations: [
        { localId: 'old-observation', episodeLocalId: 'old-episode', sourceRef: 'old', channel: 'narration', excerpt: '旧楼层只提供上下文。', factRefs: ['old-fact'] },
        { localId: 'new-observation', episodeLocalId: 'new-episode', sourceRef: 'new', channel: 'narration', excerpt: '紫罗拥有一把银钥匙', factRefs: ['new-fact'] },
      ],
      facts: [
        { localId: 'old-fact', kind: 'state', sourceRef: 'old', subjectKey: '旧人物', predicateKey: '存在', content: '旧人物存在于旧楼层。', confidence: 0.9, evidenceExcerpt: '旧楼层只提供上下文。' },
        { localId: 'new-fact', kind: 'state', sourceRef: 'new', sourceRefs: ['old', 'new'], subjectKey: '紫罗', predicateKey: '拥有', objectKey: '银钥匙', content: '紫罗拥有一把银钥匙。', confidence: 0.95, evidenceExcerpt: '紫罗拥有一把银钥匙' },
      ],
    }));
    const existingMemoryContext = [{ referenceId: 'M1', kind: 'identity', subjectKey: '紫罗', predicateKey: '身份', content: '紫罗是一名守卫。' }];
    const result = await new MultiActorCaptureService(new ActorRegistry('writable-workspace'), { extract }).capture({
      workspaceId: 'writable-workspace',
      chatKey: 'chat',
      sources: [oldSource, newSource],
      writableSourceRefs: ['new'],
      existingMemoryContext,
      graphLlmRelationEnabled: true,
    });

    expect(extract).toHaveBeenCalledWith(expect.objectContaining({
      existingMemoryContext,
      graphLlmRelationEnabled: true,
      sources: [oldSource, newSource],
    }));
    expect(result.pendingCandidates.map((candidate) => candidate.displayName)).not.toContain('旧人物');
    expect(result.episodes.map((episode) => episode.id)).toHaveLength(1);
    expect(result.observations.map((observation) => observation.sourceRef)).toEqual(['new']);
    expect(result.facts.map((item) => item.content)).toEqual(['紫罗拥有一把银钥匙。']);
    expect(result.envelope.actorCandidates.map((candidate) => candidate.displayName)).toEqual(['紫罗']);
  });

  it('does not revise or audit an identical fact evidence retry', async () => {
    const source: SourceBlock = { id: 'same', chatKey: 'chat', kind: 'message', role: 'assistant', content: '紫罗拥有一把银钥匙。', createdAt: 1 };
    const retryExtractor = { extract: async (): Promise<StructuredCaptureResult> => ({
      actorCandidates: [],
      episodes: [],
      observations: [],
      facts: [{ localId: 'same-fact', kind: 'state', sourceRef: 'same', subjectKey: '紫罗', predicateKey: '拥有', objectKey: '银钥匙', content: '紫罗拥有一把银钥匙。', confidence: 0.95, evidenceExcerpt: source.content }],
    }) };
    let baseline: Awaited<ReturnType<MultiActorCaptureService['capture']>>['facts'] = [];
    const commitCapture = vi.fn(async (input: { facts: typeof baseline }) => {
      if (input.facts.length > 0) baseline = structuredClone(input.facts);
      return undefined;
    });
    const repository = {
      listFacts: async () => structuredClone(baseline),
      commitCapture,
    };
    const service = new MultiActorCaptureService(new ActorRegistry('retry-workspace'), retryExtractor, repository as never);

    const first = await service.capture({ workspaceId: 'retry-workspace', chatKey: 'chat', sources: [source] });
    const second = await service.capture({ workspaceId: 'retry-workspace', chatKey: 'chat', sources: [source] });

    expect(first.facts).toHaveLength(1);
    expect(second.facts).toEqual([]);
    expect(commitCapture).toHaveBeenNthCalledWith(2, expect.objectContaining({ facts: [], evidence: [] }));
    expect(baseline[0]?.revision).toBe(1);
  });

  it('commits valid records while auditing an unknown enum as a partial outcome', async () => {
    const source: SourceBlock = { id: 'mixed', chatKey: 'chat', kind: 'message', role: 'assistant', content: '紫罗守卫城门，并在黄昏关闭大门。', createdAt: 1 };
    const mixedExtractor = { extract: async (): Promise<StructuredCaptureResult> => ({
      actorCandidates: [],
      episodes: [],
      observations: [],
      facts: [
        { localId: 'valid', kind: 'state', sourceRef: source.id, subjectKey: '紫罗', predicateKey: '守卫', content: '紫罗正在守卫城门。', confidence: 0.9, evidenceExcerpt: '紫罗守卫城门' },
        { localId: 'invalid', kind: 'action', sourceRef: source.id, subjectKey: '紫罗', predicateKey: '关闭', content: '紫罗在黄昏关闭大门。', confidence: 0.9, evidenceExcerpt: '在黄昏关闭大门' },
      ],
    }) };

    const result = await new MultiActorCaptureService(new ActorRegistry('partial-workspace'), mixedExtractor).capture({
      workspaceId: 'partial-workspace',
      chatKey: source.chatKey,
      sources: [source],
    });

    expect(result.outcome).toBe('partial');
    expect(result.facts.map(item => item.kind)).toEqual(['state']);
    expect(result.rejections).toEqual([
      expect.objectContaining({
        recordType: 'fact',
        code: 'invalid_enum',
        fieldPath: 'kind',
        status: 'unresolved',
        candidateSnapshot: expect.objectContaining({ localId: 'invalid', kind: 'action' }),
      }),
    ]);
  });

  it('quarantines unknown fields and model-confirmed actors while committing valid rows', async () => {
    const source: SourceBlock = {
      id: 'strict', chatKey: 'chat', kind: 'message', role: 'assistant',
      content: '紫罗正在守卫城门，白岚站在她身旁。', createdAt: 1,
    };
    const strictExtractor = { extract: async (): Promise<StructuredCaptureResult> => ({
      actorCandidates: [
        { localId: 'valid-actor', displayName: '紫罗', sourceRefs: [source.id], evidenceExcerpts: ['紫罗正在守卫城门'], confidence: 0.96 },
        { localId: 'forged-confirmed', displayName: '白岚', sourceRefs: [source.id], evidenceExcerpts: ['白岚站在她身旁'], confidence: 0.96, status: 'confirmed' },
      ],
      episodes: [], observations: [],
      facts: [
        { localId: 'valid-fact', kind: 'state', sourceRef: source.id, subjectKey: '紫罗', predicateKey: '守卫', objectKey: '城门', content: '紫罗正在守卫城门。', confidence: 0.9, evidenceExcerpt: '紫罗正在守卫城门' },
        { localId: 'forged-scope', kind: 'state', sourceRef: source.id, subjectKey: '白岚', predicateKey: '在场', content: '白岚站在紫罗身旁。', confidence: 0.9, evidenceExcerpt: '白岚站在她身旁', scope: { worldKeys: ['forged'] } },
        { localId: 'bad-confidence', kind: 'state', sourceRef: source.id, subjectKey: '白岚', predicateKey: '在场', content: '白岚站在紫罗身旁。', confidence: 2, evidenceExcerpt: '白岚站在她身旁' },
      ],
    }) };

    const result = await new MultiActorCaptureService(new ActorRegistry('strict-workspace'), strictExtractor).capture({
      workspaceId: 'strict-workspace', chatKey: source.chatKey, sources: [source],
    });

    expect(result.outcome).toBe('partial');
    expect(result.pendingCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ displayName: '紫罗', status: 'pending' }),
    ]));
    expect(result.pendingCandidates.map(item => item.displayName)).not.toContain('白岚');
    expect(result.facts.map(item => item.content)).toEqual(['紫罗正在守卫城门。']);
    expect(result.rejections).toEqual(expect.arrayContaining([
      expect.objectContaining({ recordType: 'actor', code: 'unknown_field', fieldPath: 'status' }),
      expect.objectContaining({ recordType: 'fact', code: 'unknown_field', fieldPath: 'scope' }),
      expect.objectContaining({ recordType: 'fact', code: 'invalid_confidence', fieldPath: 'confidence' }),
    ]));
  });

  it('enforces repair type and localId in code instead of trusting the repair prompt', async () => {
    const source: SourceBlock = {
      id: 'repair', chatKey: 'chat', kind: 'message', role: 'assistant',
      content: '紫罗正在守卫城门。', createdAt: 1,
    };
    const repairExtractor = { extract: async (): Promise<StructuredCaptureResult> => ({
      actorCandidates: [{ localId: 'unexpected-actor', displayName: '紫罗', sourceRefs: [source.id], evidenceExcerpts: [source.content], confidence: 0.9 }],
      episodes: [], observations: [],
      facts: [{ localId: 'new-local-id', kind: 'state', sourceRef: source.id, subjectKey: '紫罗', predicateKey: '守卫', content: '紫罗正在守卫城门。', confidence: 0.9, evidenceExcerpt: source.content }],
    }) };

    const result = await new MultiActorCaptureService(new ActorRegistry('repair-workspace'), repairExtractor).capture({
      workspaceId: 'repair-workspace', chatKey: source.chatKey, sources: [source],
      repairRequest: {
        recordType: 'fact',
        items: [{ rejectionId: 'rejection:1', localId: 'expected-fact', code: 'invalid_shape', message: '修复事实' }],
      },
    });

    expect(result.facts).toEqual([]);
    expect(result.envelope.actorCandidates).toEqual([]);
    expect(result.outcome).toBe('partial');
    expect(result.rejections).toEqual(expect.arrayContaining([
      expect.objectContaining({ recordType: 'actor', code: 'invalid_shape' }),
      expect.objectContaining({ recordType: 'fact', code: 'invalid_reference', fieldPath: 'localId' }),
    ]));
  });

  it('keeps a new AI actor on a stable pending owner through observations and traces', async () => {
    const source: SourceBlock = {
      id: 'pending-owner-source', chatKey: 'chat', kind: 'message', role: 'assistant', floor: 8,
      content: '洛青说：“我会守住北门。”', createdAt: 8,
    };
    const extractor = { extract: async (): Promise<StructuredCaptureResult> => ({
      actorCandidates: [{
        localId: 'actor-luo', displayName: '洛青', sourceRefs: [source.id],
        evidenceExcerpts: ['洛青说'], confidence: 0.97,
      }],
      episodes: [{
        localId: 'episode-luo', sourceRefs: [source.id], floorStart: 8, floorEnd: 8,
        participantRefs: ['actor-luo'], presentRefs: ['actor-luo'], occurredAt: 8,
      }],
      observations: [{
        localId: 'observation-luo', sourceRef: source.id, episodeLocalId: 'episode-luo',
        speakerRef: 'actor-luo', viewpointRef: 'actor-luo', observerRefs: ['actor-luo'],
        channel: 'public_speech', privacy: 'public', knowledgeMode: 'self_reported',
        excerpt: '我会守住北门', presentRefs: ['actor-luo'], factLocalIds: ['fact-luo'], occurredAt: 8,
      }],
      facts: [{
        localId: 'fact-luo', kind: 'commitment', sourceRef: source.id,
        subjectKey: '洛青', predicateKey: '承诺', objectKey: '守住北门',
        content: '洛青承诺守住北门。', confidence: 0.95, evidenceExcerpt: '我会守住北门',
        observationLocalIds: ['observation-luo'],
      }],
    }) };

    const result = await new MultiActorCaptureService(new ActorRegistry('pending-owner-workspace'), extractor).capture({
      workspaceId: 'pending-owner-workspace', chatKey: source.chatKey, sources: [source],
    });

    const pending = result.pendingCandidates.find(candidate => candidate.displayName === '洛青');
    const owner = result.owners.find(candidate => candidate.id === pending?.ownerRef);
    expect(owner).toMatchObject({ kind: 'actor', status: 'pending' });
    expect(owner?.id).not.toBe('owner:unknown');
    expect(result.observations[0]).toMatchObject({ speakerOwnerId: owner?.id, viewpointOwnerId: owner?.id });
    expect(result.traces).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerId: owner?.id, factId: result.facts[0]?.id }),
    ]));
    expect(result.traces.map(trace => trace.ownerId)).not.toContain('owner:unknown');
  });
});
