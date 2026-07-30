import { describe, expect, it, vi } from 'vitest';
import { ActorRegistry, MultiActorCaptureService } from '../src/application/actors';
import { LocationRegistry } from '../src/application/locations';
import type { SourceBlock, StructuredCaptureResult } from '../src/application/ingest/types';

function service(workspace: string, extractor: { extract(input: any): Promise<StructuredCaptureResult> }, repository?: any) {
  return new MultiActorCaptureService(
    new ActorRegistry(workspace),
    new LocationRegistry(workspace),
    extractor,
    repository,
  );
}

function empty(): StructuredCaptureResult {
  return { actorCandidates: [], locationCandidates: [], episodes: [], claims: [] };
}

function source(overrides: Partial<SourceBlock> = {}): SourceBlock {
  return {
    id: 'message:1', chatKey: 'chat', kind: 'message', role: 'assistant', floor: 1,
    content: '白夕琴乃在加油站报告：地下储油库燃油约占总容量的百分之四十五。',
    createdAt: 1_000,
    actorRefs: ['白夕琴乃（重构体）'],
    locationRefs: ['加油站'],
    ...overrides,
  };
}

describe('Claim-based multi actor capture', () => {
  it('exposes request-local typed refs while keeping persistent IDs out of the model contract', async () => {
    const row = source();
    let seenActorRef = '';
    let seenLocationRef = '';
    const extractor = { extract: vi.fn(async (input: any): Promise<StructuredCaptureResult> => {
      seenActorRef = input.knownActorContext[0].referenceId;
      seenLocationRef = input.knownLocationContext[0].referenceId;
      return empty();
    }) };
    const capture = await service('short-ref-w', extractor).capture({
      workspaceId: 'short-ref-w',
      chatKey: 'chat',
      sources: [row],
    });

    expect(seenActorRef).toBe('A01');
    expect(seenLocationRef).toBe('L01');
    expect(capture.owners[0]?.id).not.toBe(seenActorRef);
    expect(capture.locations[0]?.id).not.toBe(seenLocationRef);
  });

  it('derives machine time, observation, evidence and trace on the server', async () => {
    const row = source();
    const extractor = { extract: vi.fn(async (input: any): Promise<StructuredCaptureResult> => {
      const actorRef = input.knownActorContext[0].referenceId;
      const locationRef = input.knownLocationContext[0].referenceId;
      return {
        actorCandidates: [], locationCandidates: [],
        episodes: [{
          localId: 'episode-1', sourceRefs: [row.id], participantRefs: [actorRef], presentRefs: [actorRef],
          mentionedRefs: [], locationRef, storyTimeText: '灾变第三十八日清晨', summary: '琴乃侦察加油站。',
        }],
        claims: [{
          localId: 'claim-1', sourceRef: row.id, episodeLocalId: 'episode-1', kind: 'state',
          subjectRef: locationRef, predicateKey: '燃油储量', objectText: '总容量的百分之四十五',
          content: '加油站地下储油库燃油约占总容量的百分之四十五。',
          evidenceExcerpt: '地下储油库燃油约占总容量的百分之四十五',
          knowledge: {
            mode: 'experienced', privacy: 'limited', ownerRefs: [actorRef], speakerRef: actorRef,
            viewpointRef: actorRef, observerRefs: [actorRef], presentRefs: [actorRef], mentionedRefs: [],
          },
          confidence: 0.98, stableAnchor: false,
        }],
      };
    }) };
    const capture = await service('w', extractor).capture({ workspaceId: 'w', chatKey: 'chat', sources: [row] });

    expect(capture.outcome).toBe('complete');
    expect(capture.rejections).toEqual([]);
    expect(capture.episodes).toHaveLength(1);
    expect(capture.episodes[0]).toMatchObject({ occurredAt: row.createdAt, storyTimeText: '灾变第三十八日清晨', location: '加油站' });
    expect(capture.facts).toHaveLength(1);
    expect(capture.facts[0]).toMatchObject({
      kind: 'state', subjectKey: '加油站', predicateKey: '燃油储量', validFrom: row.createdAt,
      freshestEvidenceAt: row.createdAt, status: 'active',
    });
    expect(capture.observations).toHaveLength(1);
    expect(capture.observations[0]).toMatchObject({ occurredAt: row.createdAt, knowledgeMode: 'experienced', privacy: 'limited' });
    expect(capture.traces).toEqual(expect.arrayContaining([
      expect.objectContaining({ factId: capture.facts[0]?.id, knowledgeMode: 'experienced', privacy: 'limited' }),
    ]));
    expect(capture.envelope).toMatchObject({ claimLocalIds: ['claim-1'] });
    expect(capture.envelope).not.toHaveProperty('facts');
    expect(capture.envelope).not.toHaveProperty('observations');
  });

  it('hashes non-ASCII model local IDs before they become workspace record IDs', async () => {
    const row = source({ id: 'message:unicode-local-id', content: '灰羽在客厅完成产蛋。', actorRefs: [], locationRefs: ['客厅'] });
    const extractor = { extract: async (input: any): Promise<StructuredCaptureResult> => {
      const location = input.knownLocationContext[0].referenceId;
      return {
        actorCandidates: [], locationCandidates: [],
        episodes: [{
          localId: '事件-灰羽产蛋', sourceRefs: [row.id], participantRefs: [], presentRefs: [], mentionedRefs: [],
          locationRef: location, summary: '灰羽完成一次产蛋事件。',
        }],
        claims: [{
          localId: '主张-产蛋完成', sourceRef: row.id, episodeLocalId: '事件-灰羽产蛋', kind: 'event',
          subjectText: '灰羽', predicateKey: '完成产蛋', objectText: '', content: '灰羽在客厅完成产蛋。', evidenceExcerpt: row.content,
          knowledge: { mode: 'asserted', privacy: 'public', ownerRefs: [], observerRefs: [], presentRefs: [], mentionedRefs: [] },
          confidence: 0.98, stableAnchor: false,
        }],
      };
    } };
    const capture = await service('unicode-local-w', extractor).capture({ workspaceId: 'unicode-local-w', chatKey: 'chat', sources: [row] });

    expect(capture.outcome).toBe('complete');
    expect(capture.episodes[0]?.id).not.toContain('灰羽');
    expect(capture.observations[0]?.id).not.toContain('产蛋完成');
    expect(capture.episodes[0]?.id).toMatch(/^episode:[\x20-\x7E]+$/u);
    expect(capture.observations[0]?.id).toMatch(/^observation:[\x20-\x7E]+$/u);
  });

  it('keeps private thought and rumor knowledge on the correct owners', async () => {
    const row: SourceBlock = {
      id: 'message:private', chatKey: 'chat', kind: 'message', role: 'assistant', floor: 2, createdAt: 2_000,
      content: '白夕小时心想：不能让白夕叶知道密钥。后来白夕叶听说白夕小时已经背叛城主，但这只是传闻。',
      actorRefs: ['白夕小时', '白夕叶'],
    };
    const extractor = { extract: async (input: any): Promise<StructuredCaptureResult> => {
      const hour = input.knownActorContext.find((item: any) => item.canonicalName === '白夕小时').referenceId;
      const leaf = input.knownActorContext.find((item: any) => item.canonicalName === '白夕叶').referenceId;
      return {
        actorCandidates: [], locationCandidates: [], episodes: [], claims: [
          {
            localId: 'private', sourceRef: row.id, kind: 'state', subjectRef: hour, predicateKey: '知道',
            objectText: '密钥', content: '白夕小时知道一项不能让白夕叶得知的密钥。', evidenceExcerpt: '不能让白夕叶知道密钥',
            knowledge: { mode: 'experienced', privacy: 'private', ownerRefs: [hour], speakerRef: hour, viewpointRef: hour, observerRefs: [hour], presentRefs: [hour], mentionedRefs: [leaf] },
            confidence: 0.95, stableAnchor: false,
          },
          {
            localId: 'rumor', sourceRef: row.id, kind: 'state', subjectRef: hour, predicateKey: '背叛城主',
            objectText: '传闻', content: '白夕叶听到白夕小时可能背叛城主的传闻。', evidenceExcerpt: '白夕叶听说白夕小时已经背叛城主，但这只是传闻',
            knowledge: { mode: 'believed', privacy: 'limited', ownerRefs: [leaf], speakerRef: leaf, viewpointRef: leaf, observerRefs: [leaf], presentRefs: [leaf], mentionedRefs: [hour] },
            confidence: 0.55, stableAnchor: false,
          },
        ],
      };
    } };
    const capture = await service('private-w', extractor).capture({ workspaceId: 'private-w', chatKey: 'chat', sources: [row] });
    const hourId = capture.owners.find(owner => owner.canonicalName === '白夕小时')!.id;
    const leafId = capture.owners.find(owner => owner.canonicalName === '白夕叶')!.id;
    const privateFact = capture.facts.find(fact => fact.predicateKey === '知道')!;
    const rumorFact = capture.facts.find(fact => fact.predicateKey === '背叛城主')!;
    expect(capture.traces.filter(trace => trace.factId === privateFact.id).map(trace => trace.ownerId)).toEqual([hourId]);
    expect(capture.traces.filter(trace => trace.factId === rumorFact.id).map(trace => trace.ownerId)).toEqual([leafId]);
    expect(capture.traces.find(trace => trace.factId === rumorFact.id)?.knowledgeMode).toBe('believed');
  });

  it('fail-closes private memory when the model incorrectly marks every present actor as a knower', async () => {
    const row: SourceBlock = {
      id: 'message:private-boundary', chatKey: 'chat', kind: 'message', role: 'assistant', floor: 3, createdAt: 3_000,
      content: '艾达心想：绝不能让贝拉知道密钥。贝拉仍站在房间里。',
      actorRefs: ['艾达', '贝拉'],
    };
    const extractor = { extract: async (input: any): Promise<StructuredCaptureResult> => {
      const ada = input.knownActorContext.find((item: any) => item.canonicalName === '艾达').referenceId;
      const bella = input.knownActorContext.find((item: any) => item.canonicalName === '贝拉').referenceId;
      return {
        ...empty(),
        claims: [{
          localId: 'private-boundary', sourceRef: row.id, kind: 'state', subjectRef: ada,
          predicateKey: '知道', objectText: '密钥', content: '艾达独自知道密钥。',
          evidenceExcerpt: '绝不能让贝拉知道密钥',
          knowledge: {
            mode: 'experienced', privacy: 'private', ownerRefs: [ada, bella], speakerRef: ada,
            viewpointRef: ada, observerRefs: [ada, bella], presentRefs: [ada, bella], mentionedRefs: [bella],
          },
          confidence: 0.98, stableAnchor: false,
        }],
      };
    } };
    const capture = await service('private-boundary-w', extractor).capture({
      workspaceId: 'private-boundary-w', chatKey: 'chat', sources: [row],
    });
    const adaId = capture.owners.find(owner => owner.canonicalName === '艾达')!.id;
    const bellaId = capture.owners.find(owner => owner.canonicalName === '贝拉')!.id;
    expect(capture.rejections).toEqual([]);
    expect(capture.traces.map(trace => trace.ownerId)).toEqual([adaId]);
    expect(capture.traces.map(trace => trace.ownerId)).not.toContain(bellaId);
    expect(capture.observations[0]).toMatchObject({
      speakerOwnerId: adaId,
      viewpointOwnerId: adaId,
      observerOwnerIds: [adaId],
      privacy: 'private',
    });
  });

  it('uses trusted cast names and rejects descriptor/template text as actors', async () => {
    const row = source({
      content: '白夕琴乃（重构体）与白夕小时站在加油站。',
      actorRefs: ['白夕琴乃（重构体）', '白夕小时'],
    });
    const extractor = { extract: async (): Promise<StructuredCaptureResult> => ({
      actorCandidates: [
        { localId: 'known-short', displayName: '琴乃', aliases: [], sourceRef: row.id, evidenceExcerpt: '白夕琴乃（重构体）', confidence: 0.98 },
        { localId: 'bad-descriptor', displayName: '重构体', aliases: [], sourceRef: row.id, evidenceExcerpt: '重构体', confidence: 0.9 },
        { localId: 'bad-template', displayName: '表情的话', aliases: [], sourceRef: row.id, evidenceExcerpt: '白夕小时', confidence: 0.9 },
      ],
      locationCandidates: [], episodes: [], claims: [],
    }) };
    const capture = await service('actors-w', extractor).capture({ workspaceId: 'actors-w', chatKey: 'chat', sources: [row] });
    const actors = capture.owners.filter(owner => owner.kind === 'actor');
    expect(actors.map(actor => actor.canonicalName)).toEqual(expect.arrayContaining(['白夕琴乃（重构体）', '白夕小时']));
    expect(actors.filter(actor => actor.canonicalName?.includes('琴乃'))).toHaveLength(1);
    expect(actors.map(actor => actor.canonicalName)).not.toContain('重构体');
    expect(actors.map(actor => actor.canonicalName)).not.toContain('表情的话');
    expect(capture.rejections).toEqual(expect.arrayContaining([
      expect.objectContaining({ recordType: 'actor', code: 'invalid_shape' }),
    ]));
  });

  it('safely clears an invalid optional episodeLocalId while preserving an otherwise valid claim', async () => {
    const row = source({ id: 'message:fallback', content: '紫罗能够净化空气。', actorRefs: ['紫罗'], locationRefs: [] });
    const extractor = { extract: async (input: any): Promise<StructuredCaptureResult> => {
      const actor = input.knownActorContext[0].referenceId;
      return {
        actorCandidates: [], locationCandidates: [], episodes: [],
        claims: [{
          localId: 'claim-fallback', sourceRef: row.id, episodeLocalId: 'missing-event', kind: 'capability',
          subjectRef: actor, predicateKey: '净化', objectText: '空气', content: '紫罗能够净化空气。', evidenceExcerpt: row.content,
          knowledge: { mode: 'experienced', privacy: 'public', ownerRefs: [actor], speakerRef: actor, viewpointRef: actor, observerRefs: [actor], presentRefs: [actor], mentionedRefs: [] },
          confidence: 0.96, stableAnchor: true,
        }],
      };
    } };
    const capture = await service('fallback-w', extractor).capture({ workspaceId: 'fallback-w', chatKey: 'chat', sources: [row] });
    expect(capture.facts).toHaveLength(1);
    expect(capture.rejections).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'dependency_invalid', fieldPath: 'episodeLocalId' }),
    ]));
    expect(capture.resolutionMode).toBe('degraded');
    expect(capture.fieldActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'claims[0].episodeLocalId', action: 'clear' }),
    ]));
  });

  it('recovers an explicit named command deterministically when the model omits it', async () => {
    const row = source({
      id: 'message:directive',
      content: [
        '“所有人，留在室内。”小时下达了指令，声音里带着不容置疑的权威。',
        '“叶，持续监控外部环境变化。莲，保护好音乃。琴乃，继续分析信号，有任何发现立即报告。”',
      ].join(''),
      actorRefs: ['白夕小时', '白夕叶', '白夕莲', '白夕音乃', '白夕琴乃（重构体）'],
      locationRefs: [],
    });
    const capture = await service('directive-w', { extract: async () => empty() }).capture({
      workspaceId: 'directive-w', chatKey: 'chat', sources: [row],
    });

    expect(capture.outcome).toBe('complete');
    expect(capture.rejections).toEqual([]);
    expect(capture.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'event',
        subjectKey: '白夕小时',
        predicateKey: '下达应对指令',
        content: expect.stringMatching(/所有人，留在室内.*叶，持续监控.*莲，保护好音乃.*琴乃，继续分析信号/u),
        sourceRefs: [row.id],
      }),
    ]));
    expect(capture.observations[0]?.excerpt).toContain('小时下达了指令');
    expect(capture.diagnostics?.deterministicRepairs).toBe(1);
  });

  it('does not attach a distant command quote from another paragraph to a later attribution marker', async () => {
    const row = source({
      id: 'message:distant-directive',
      content: [
        '“叶，继续警戒。”',
        '',
        '几百字后的叙述已经进入另一个场景。'.repeat(12),
        '小时下达了指令，但正文没有记录具体内容。',
      ].join('\n'),
      actorRefs: ['白夕小时', '白夕叶'],
      locationRefs: [],
    });

    const capture = await service('distant-directive-w', { extract: async () => empty() }).capture({
      workspaceId: 'distant-directive-w', chatKey: 'chat', sources: [row],
    });

    expect(capture.facts.some(fact => fact.predicateKey === '下达应对指令')).toBe(false);
    expect(capture.diagnostics?.deterministicRepairs).toBe(0);
  });

  it('does not retry business-invalid Claims and retains already-valid Claims', async () => {
    const row = source({ content: '紫罗能够净化空气，也能感知五十米内的紫骸。', actorRefs: ['紫罗'], locationRefs: [] });
    const extract = vi.fn(async (input: any): Promise<StructuredCaptureResult> => {
      const actor = input.knownActorContext[0].referenceId;
      return {
        actorCandidates: [], locationCandidates: [], episodes: [], claims: [
          {
            localId: 'valid', sourceRef: row.id, kind: 'capability', subjectRef: actor, predicateKey: '净化', objectText: '空气',
            content: '紫罗能够净化空气。', evidenceExcerpt: '紫罗能够净化空气',
            knowledge: { mode: 'experienced', privacy: 'public', ownerRefs: [actor], speakerRef: actor, viewpointRef: actor, observerRefs: [actor], presentRefs: [actor], mentionedRefs: [] },
            confidence: 0.96, stableAnchor: true,
          },
          {
            localId: 'bad', sourceRef: row.id, kind: 'capability', subjectRef: actor, predicateKey: '感知范围', objectText: '五十米',
            content: '紫罗能够感知五十米内的紫骸。', evidenceExcerpt: '模型改写过的不存在证据',
            knowledge: { mode: 'experienced', privacy: 'public', ownerRefs: [actor], speakerRef: actor, viewpointRef: actor, observerRefs: [actor], presentRefs: [actor], mentionedRefs: [] },
            confidence: 0.95, stableAnchor: true,
          },
        ],
      };
    });
    const capture = await service('repair-w', { extract }).capture({ workspaceId: 'repair-w', chatKey: 'chat', sources: [row] });
    expect(extract).toHaveBeenCalledTimes(1);
    expect(capture.facts.map(fact => fact.predicateKey)).toEqual(['净化']);
    expect(capture.rejections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'excerpt_mismatch',
        status: 'unresolved',
      }),
    ]));
    expect(capture.outcome).toBe('partial');
  });

  it('rejects malformed private memory instead of defaulting it to public or retrying', async () => {
    const row = source({
      id: 'message:private-schema-repair',
      content: '艾达心想：绝不能让其他人知道密钥。',
      actorRefs: ['艾达'],
      locationRefs: [],
    });
    const extract = vi.fn(async (input: any): Promise<StructuredCaptureResult> => {
      const actor = input.knownActorContext[0].referenceId;
      const base = {
        localId: 'private-schema', sourceRef: row.id, kind: 'state' as const, subjectRef: actor,
        predicateKey: '知道', objectText: '密钥', content: '艾达独自知道一项密钥。',
        evidenceExcerpt: '绝不能让其他人知道密钥', stableAnchor: false,
      };
      return {
        ...empty(),
        claims: [{
          ...base,
          knowledge: {
            mode: '' as never, privacy: '' as never, ownerRefs: [actor], speakerRef: actor,
            viewpointRef: actor, observerRefs: [actor], presentRefs: [actor], mentionedRefs: [],
          },
          confidence: Number.NaN,
        }],
      };
    });

    const capture = await service('private-schema-w', { extract }).capture({
      workspaceId: 'private-schema-w', chatKey: 'chat', sources: [row],
    });

    expect(extract).toHaveBeenCalledTimes(1);
    expect(capture.facts).toEqual([]);
    expect(capture.traces).toEqual([]);
    expect(capture.outcome).toBe('partial');
    expect(capture.rejections).not.toEqual([]);
  });

  it('rejects a transposed prompt-local location reference instead of guessing its target', async () => {
    const row = source({
      id: 'message:fuel-ref',
      content: '琴乃报告：“加油站地下储油库液面高度约为总高度的百分之四十五。”',
      actorRefs: ['白夕琴乃（重构体）'],
      locationRefs: ['加油站', '地下储油库'],
    });
    const extractor = { extract: async (input: any): Promise<StructuredCaptureResult> => {
      const actor = input.knownActorContext.find((item: any) => item.canonicalName === '白夕琴乃（重构体）').referenceId;
      const location = input.knownLocationContext.find((item: any) => item.canonicalName === '地下储油库').referenceId as string;
      const suffix = location.slice('location:'.length);
      const pairIndex = [...suffix].findIndex((character, index, values) => index + 1 < values.length && character !== values[index + 1]);
      const chars = [...suffix];
      if (pairIndex >= 0) [chars[pairIndex], chars[pairIndex + 1]] = [chars[pairIndex + 1]!, chars[pairIndex]!];
      const typo = pairIndex >= 0 ? `location:${chars.join('')}` : `${location.slice(0, -1)}x`;
      return {
        actorCandidates: [], locationCandidates: [], episodes: [], claims: [{
          localId: 'fuel-45', sourceRef: row.id, kind: 'state', subjectRef: typo,
          predicateKey: '燃油储量', objectText: '百分之四十五',
          content: '加油站地下储油库的燃油储量约为总容量的百分之四十五。',
          evidenceExcerpt: '加油站地下储油库液面高度约为总高度的百分之四十五',
          knowledge: {
            mode: 'self_reported', privacy: 'public', ownerRefs: [actor], speakerRef: actor,
            viewpointRef: actor, observerRefs: [actor], presentRefs: [actor], mentionedRefs: [],
          },
          confidence: 0.98, stableAnchor: false,
        }],
      };
    } };
    const capture = await service('fuel-ref-w', extractor).capture({ workspaceId: 'fuel-ref-w', chatKey: 'chat', sources: [row] });

    expect(capture.facts).toEqual([]);
    expect(capture.rejections).toEqual(expect.arrayContaining([
      expect.objectContaining({ recordType: 'claim', code: 'invalid_reference', fieldPath: 'subjectRef' }),
    ]));
  });

  it('maps the exact violet naming ellipsis rewrite back to source text', async () => {
    const row = source({
      id: 'message:violet-name',
      content: '紫罗的喇叭状叶片轻轻颤动：“我……想要……名字。”',
      actorRefs: ['紫罗'],
      locationRefs: [],
    });
    const extractor = { extract: async (input: any): Promise<StructuredCaptureResult> => {
      const actor = input.knownActorContext.find((item: any) => item.canonicalName === '紫罗').referenceId;
      return {
        actorCandidates: [], locationCandidates: [], episodes: [], claims: [{
          localId: 'violet-name-request', sourceRef: row.id, kind: 'goal', subjectRef: actor,
          predicateKey: '想要', objectText: '名字', content: '紫罗表达了想要一个名字的愿望。',
          evidenceExcerpt: '“我......想要......名字。”',
          knowledge: {
            mode: 'self_reported', privacy: 'public', ownerRefs: [actor], speakerRef: actor,
            viewpointRef: actor, observerRefs: [actor], presentRefs: [actor], mentionedRefs: [],
          },
          confidence: 0.98, stableAnchor: false,
        }],
      };
    } };
    const capture = await service('violet-name-w', extractor).capture({ workspaceId: 'violet-name-w', chatKey: 'chat', sources: [row] });

    expect(capture.rejections).toEqual([]);
    expect(capture.observations[0]?.excerpt).toBe('我……想要……名字。');
    expect(capture.facts[0]?.content).toContain('想要一个名字');
  });

  it('maps punctuation-only evidence rewrites back to the exact source excerpt', async () => {
    const row = source({
      id: 'message:ellipsis',
      content: '琴乃低声报告：“不是紫骸……更小，更微弱。像是……小型动物。距离大约……八十米，东南方向。”',
      actorRefs: ['白夕琴乃（重构体）'],
      locationRefs: [],
    });
    const extractor = { extract: async (input: any): Promise<StructuredCaptureResult> => {
      const actor = input.knownActorContext.find((item: any) => item.canonicalName === '白夕琴乃（重构体）').referenceId;
      return {
        actorCandidates: [], locationCandidates: [], episodes: [], claims: [{
          localId: 'animal-sense', sourceRef: row.id, kind: 'capability', subjectRef: actor,
          predicateKey: '感知到', objectText: '东南方向八十米处的小型动物',
          content: '琴乃感知到东南方向约八十米处有小型动物活动。',
          evidenceExcerpt: '不是紫骸......更小,更微弱。像是......小型动物。距离大约......八十米,东南方向。',
          knowledge: {
            mode: 'asserted', privacy: 'limited', ownerRefs: [actor], speakerRef: actor,
            viewpointRef: actor, observerRefs: [actor], presentRefs: [actor], mentionedRefs: [],
          },
          confidence: 0.9, stableAnchor: true,
        }],
      };
    } };
    const capture = await service('ellipsis-w', extractor).capture({ workspaceId: 'ellipsis-w', chatKey: 'chat', sources: [row] });

    expect(capture.rejections).toEqual([]);
    expect(capture.observations[0]?.excerpt).toContain('不是紫骸……更小，更微弱');
    expect(capture.diagnostics?.deterministicRepairs).toBeGreaterThanOrEqual(1);
  });

  it('quarantines low-quality Claims instead of polluting long-term memory', async () => {
    const row = source({ content: '也许吧。', actorRefs: [], locationRefs: [] });
    const extractor = { extract: async (): Promise<StructuredCaptureResult> => ({
      ...empty(),
      claims: [{
        localId: 'low', sourceRef: row.id, kind: 'other', subjectText: '某件事', predicateKey: '可能', objectText: '',
        content: '某件事也许会发生。', evidenceExcerpt: '也许吧',
        knowledge: { mode: 'suspected', privacy: 'public', ownerRefs: [], speakerRef: '', viewpointRef: '', observerRefs: [], presentRefs: [], mentionedRefs: [] },
        confidence: 0.05, stableAnchor: false,
      }],
    }) };
    const capture = await service('quality-w', extractor).capture({ workspaceId: 'quality-w', chatKey: 'chat', sources: [row] });
    expect(capture.facts).toEqual([]);
    expect(capture.outcome).toBe('complete');
    expect(capture.rejections).toEqual(expect.arrayContaining([
      expect.objectContaining({ recordType: 'claim', code: 'quality_below_threshold', status: 'ignored' }),
    ]));
  });

  it('does not let a weak object candidate self-prove actorhood through its own Claim reference', async () => {
    const row = source({
      id: 'message:device-start',
      content: '电池组启动后保持稳定，输出功率为两千瓦。',
      actorRefs: [],
      locationRefs: [],
    });
    const extractor = { extract: async (): Promise<StructuredCaptureResult> => ({
      actorCandidates: [{
        localId: 'actor-battery',
        displayName: '电池组',
        aliases: [],
        sourceRef: row.id,
        evidenceExcerpt: '电池组启动后保持稳定',
        confidence: 0.94,
      }],
      locationCandidates: [],
      episodes: [],
      claims: [{
        localId: 'battery-output',
        sourceRef: row.id,
        kind: 'state',
        subjectRef: 'actor-battery',
        predicateKey: '输出功率',
        objectText: '两千瓦',
        content: '电池组当前输出功率为两千瓦。',
        evidenceExcerpt: '输出功率为两千瓦',
        knowledge: {
          mode: 'asserted', privacy: 'public', ownerRefs: ['actor-battery'],
          observerRefs: [], presentRefs: [], mentionedRefs: [],
        },
        confidence: 0.98,
        stableAnchor: false,
      }],
    }) };

    const capture = await service('device-boundary-w', extractor).capture({
      workspaceId: 'device-boundary-w', chatKey: 'chat', sources: [row],
    });

    expect(capture.owners.filter(owner => owner.kind === 'actor').map(owner => owner.canonicalName))
      .not.toContain('电池组');
    expect(capture.pendingCandidates).toEqual([]);
    expect(capture.facts).toEqual([]);
    expect(capture.rejections).toEqual(expect.arrayContaining([
      expect.objectContaining({ recordType: 'actor', status: 'ignored' }),
      expect.objectContaining({ recordType: 'claim', code: 'invalid_reference', fieldPath: 'subjectRef' }),
    ]));
    expect(capture.outcome).toBe('partial');
  });

  it('keeps append-only history and supersedes the previous slot head', async () => {
    const firstSource = source({ id: 'message:first', content: '肉类罐头有十五盒。', actorRefs: [], locationRefs: [] });
    const secondSource = source({ id: 'message:second', content: '肉类罐头剩余十一盒。', createdAt: 2_000, actorRefs: [], locationRefs: [] });
    let baseline: any[] = [];
    const repository = {
      listFacts: async () => structuredClone(baseline),
      commitCapture: vi.fn(async (input: any) => { baseline = input.facts.filter((fact: any) => fact.status !== 'superseded' || baseline.some(item => item.id === fact.id)); return undefined; }),
      listTraces: async () => [],
    };
    const makeExtractor = (row: SourceBlock, amount: string): any => ({ extract: async (): Promise<StructuredCaptureResult> => ({
      ...empty(),
      claims: [{
        localId: `claim-${amount}`, sourceRef: row.id, kind: 'state', subjectText: '肉类罐头', predicateKey: '库存数量', objectText: amount,
        content: `肉类罐头${amount === '十五盒' ? '有' : '剩余'}${amount}。`, evidenceExcerpt: row.content,
        knowledge: { mode: 'asserted', privacy: 'public', ownerRefs: [], speakerRef: '', viewpointRef: '', observerRefs: [], presentRefs: [], mentionedRefs: [] },
        confidence: 0.98, stableAnchor: false,
      }],
    }) });
    const registry = new ActorRegistry('history-w');
    const locations = new LocationRegistry('history-w');
    const firstService = new MultiActorCaptureService(registry, locations, makeExtractor(firstSource, '十五盒'), repository as any);
    const first = await firstService.capture({ workspaceId: 'history-w', chatKey: 'chat', sources: [firstSource] });
    baseline = [...first.facts];
    const secondService = new MultiActorCaptureService(registry, locations, makeExtractor(secondSource, '十一盒'), repository as any);
    const second = await secondService.capture({ workspaceId: 'history-w', chatKey: 'chat', sources: [secondSource] });
    expect(second.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'superseded', supersededById: expect.any(String) }),
      expect.objectContaining({ status: 'active', supersedesId: expect.any(String), objectKey: '十一盒' }),
    ]));
  });

  it('deduplicates a repeated append-only event even when another same-slot event appears between them', async () => {
    const row = source({
      id: 'message:append-only-dedupe',
      content: '第一次：小时下令留在室内。随后：小时下令检查门窗。复述：小时再次确认留在室内。',
      actorRefs: ['白夕小时'],
      locationRefs: [],
    });
    const extractor = { extract: async (input: any): Promise<StructuredCaptureResult> => {
      const hour = input.knownActorContext.find((item: any) => item.canonicalName === '白夕小时').referenceId;
      const knowledge = { mode: 'asserted' as const, privacy: 'public' as const, ownerRefs: [hour], observerRefs: [hour], presentRefs: [hour], mentionedRefs: [] };
      return {
        ...empty(),
        claims: [
          { localId: 'event-a1', sourceRef: row.id, kind: 'event', subjectRef: hour, predicateKey: '下令', objectText: '留在室内', content: '白夕小时下令留在室内。', evidenceExcerpt: '第一次：小时下令留在室内', knowledge, confidence: 0.98, stableAnchor: false },
          { localId: 'event-b', sourceRef: row.id, kind: 'event', subjectRef: hour, predicateKey: '下令', objectText: '检查门窗', content: '白夕小时下令检查门窗。', evidenceExcerpt: '随后：小时下令检查门窗', knowledge, confidence: 0.98, stableAnchor: false },
          { localId: 'event-a2', sourceRef: row.id, kind: 'event', subjectRef: hour, predicateKey: '下令', objectText: '留在室内', content: '白夕小时下令留在室内。', evidenceExcerpt: '复述：小时再次确认留在室内', knowledge, confidence: 0.98, stableAnchor: false },
        ],
      };
    } };

    const capture = await service('append-only-dedupe-w', extractor).capture({
      workspaceId: 'append-only-dedupe-w', chatKey: 'chat', sources: [row],
    });
    expect(capture.rejections).toEqual([]);
    expect(capture.facts).toHaveLength(2);
    expect(capture.facts.filter(fact => fact.objectKey === '留在室内')).toHaveLength(1);
    expect(capture.observations).toHaveLength(3);
  });

  it('keeps a valid subjectRef even when another actor is mentioned first', async () => {
    const row = source({
      id: 'message:subject-authority',
      content: '白夕小时命令白夕叶守在门口。',
      actorRefs: ['白夕小时', '白夕叶'],
      locationRefs: [],
    });
    const extractor = { extract: async (input: any): Promise<StructuredCaptureResult> => {
      const leaf = input.knownActorContext.find((item: any) => item.canonicalName === '白夕叶').referenceId;
      return {
        ...empty(),
        claims: [{
          localId: 'leaf-guard', sourceRef: row.id, kind: 'goal', subjectRef: leaf,
          predicateKey: '被命令守门', objectText: '门口', content: row.content, evidenceExcerpt: row.content,
          knowledge: { mode: 'asserted', privacy: 'public', ownerRefs: [leaf], observerRefs: [leaf], presentRefs: [leaf], mentionedRefs: [] },
          confidence: 0.98, stableAnchor: false,
        }],
      };
    } };

    const capture = await service('subject-authority-w', extractor).capture({ workspaceId: 'subject-authority-w', chatKey: 'chat', sources: [row] });
    expect(capture.rejections).toEqual([]);
    expect(capture.facts[0]).toMatchObject({ subjectKey: '白夕叶', predicateKey: '被命令守门' });
  });

  it('rejects a distant malformed subject reference instead of guessing from one mentioned actor', async () => {
    const row = source({
      id: 'message:distant-ref',
      content: '白夕叶守在门口。',
      actorRefs: ['白夕叶'],
      locationRefs: [],
    });
    const extractor = { extract: async (): Promise<StructuredCaptureResult> => ({
      ...empty(),
      claims: [{
        localId: 'distant-ref', sourceRef: row.id, kind: 'state', subjectRef: 'actor:completely-unrelated',
        predicateKey: '守在', objectText: '门口', content: row.content, evidenceExcerpt: row.content,
        knowledge: { mode: 'asserted', privacy: 'public', ownerRefs: [], observerRefs: [], presentRefs: [], mentionedRefs: [] },
        confidence: 0.98, stableAnchor: false,
      }],
    }) };

    const capture = await service('distant-ref-w', extractor).capture({ workspaceId: 'distant-ref-w', chatKey: 'chat', sources: [row] });
    expect(capture.facts).toEqual([]);
    expect(capture.rejections).toEqual(expect.arrayContaining([
      expect.objectContaining({ recordType: 'claim', code: 'invalid_reference', fieldPath: 'subjectRef' }),
    ]));
  });

  it('keeps private self-reported material on the private-thought channel', async () => {
    const row = source({
      id: 'message:private-self-report',
      content: '白夕小时只在心里承认：“我害怕失败。”',
      actorRefs: ['白夕小时'],
      locationRefs: [],
    });
    const extractor = { extract: async (input: any): Promise<StructuredCaptureResult> => {
      const hour = input.knownActorContext.find((item: any) => item.canonicalName === '白夕小时').referenceId;
      return {
        ...empty(),
        claims: [{
          localId: 'private-self-report', sourceRef: row.id, kind: 'state', subjectRef: hour,
          predicateKey: '害怕', objectText: '失败', content: '白夕小时害怕失败。', evidenceExcerpt: '我害怕失败',
          knowledge: { mode: 'self_reported', privacy: 'private', ownerRefs: [hour], speakerRef: hour, viewpointRef: hour, observerRefs: [], presentRefs: [hour], mentionedRefs: [] },
          confidence: 0.98, stableAnchor: false,
        }],
      };
    } };

    const capture = await service('private-self-report-w', extractor).capture({ workspaceId: 'private-self-report-w', chatKey: 'chat', sources: [row] });
    expect(capture.rejections).toEqual([]);
    expect(capture.observations[0]).toMatchObject({ channel: 'private_thought', privacy: 'private' });
  });

  it('maps punctuation-only evidence correctly after a non-BMP character', async () => {
    const row = source({
      id: 'message:astral-evidence',
      content: '前缀𠀀，紫罗说：“我……想要……名字。”尾声。',
      actorRefs: ['紫罗'],
      locationRefs: [],
    });
    const extractor = { extract: async (input: any): Promise<StructuredCaptureResult> => {
      const violet = input.knownActorContext.find((item: any) => item.canonicalName === '紫罗').referenceId;
      return {
        ...empty(),
        claims: [{
          localId: 'astral-evidence', sourceRef: row.id, kind: 'goal', subjectRef: violet,
          predicateKey: '想要', objectText: '名字', content: '紫罗想要一个名字。', evidenceExcerpt: '我......想要......名字',
          knowledge: { mode: 'self_reported', privacy: 'public', ownerRefs: [violet], speakerRef: violet, observerRefs: [], presentRefs: [violet], mentionedRefs: [] },
          confidence: 0.98, stableAnchor: false,
        }],
      };
    } };

    const capture = await service('astral-evidence-w', extractor).capture({ workspaceId: 'astral-evidence-w', chatKey: 'chat', sources: [row] });
    expect(capture.rejections).toEqual([]);
    expect(capture.observations[0]?.excerpt).toBe('我……想要……名字');
  });

  it('rejects punctuation-insensitive evidence when matching would span an excessive gap', async () => {
    const row = source({
      id: 'message:excessive-evidence-gap',
      content: `我${'…'.repeat(600)}想要名字`,
      actorRefs: ['紫罗'],
      locationRefs: [],
    });
    const extractor = { extract: async (input: any): Promise<StructuredCaptureResult> => {
      const violet = input.knownActorContext.find((item: any) => item.canonicalName === '紫罗').referenceId;
      return {
        ...empty(),
        claims: [{
          localId: 'excessive-evidence-gap', sourceRef: row.id, kind: 'goal', subjectRef: violet,
          predicateKey: '想要', objectText: '名字', content: '紫罗想要名字。', evidenceExcerpt: '我想要名字',
          knowledge: { mode: 'self_reported', privacy: 'public', ownerRefs: [violet], speakerRef: violet, observerRefs: [], presentRefs: [violet], mentionedRefs: [] },
          confidence: 0.98, stableAnchor: false,
        }],
      };
    } };

    const capture = await service('excessive-evidence-gap-w', extractor).capture({
      workspaceId: 'excessive-evidence-gap-w', chatKey: 'chat', sources: [row],
    });
    expect(capture.facts).toEqual([]);
    expect(capture.rejections).toEqual(expect.arrayContaining([
      expect.objectContaining({ recordType: 'claim', code: 'excerpt_mismatch' }),
    ]));
  });

  it('prioritizes current-source actors when the confirmed directory exceeds the prompt cap', async () => {
    const registry = new ActorRegistry('large-directory-w');
    const names = Array.from({ length: 140 }, (_, index) => String.fromCodePoint(0x5000 + index));
    for (const [index, displayName] of names.entries()) {
      registry.discover({
        displayName,
        aliases: [], sourceRef: `seed:${index}`, sourceType: 'host_card', excerpt: 'seed', confidence: 1, confirmed: true,
      });
    }
    const currentName = [...names].sort((left, right) => left.localeCompare(right, 'zh-CN')).at(-1)!;
    const row = source({ id: 'message:large-directory', content: `${currentName}进入房间。`, actorRefs: [currentName], locationRefs: [] });
    const extract = vi.fn(async (input: any): Promise<StructuredCaptureResult> => {
      expect(input.knownActorContext).toHaveLength(128);
      expect(input.knownActorContext.some((item: any) => item.canonicalName === currentName)).toBe(true);
      return empty();
    });
    const captureService = new MultiActorCaptureService(registry, new LocationRegistry('large-directory-w'), { extract });

    await captureService.capture({ workspaceId: 'large-directory-w', chatKey: 'chat', sources: [row] });
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('does not project deterministic directives to absent cast-manifest actors', async () => {
    const row = source({
      id: 'message:directive-presence',
      content: '“叶，继续警戒。”小时下达了指令。',
      actorRefs: ['白夕小时', '白夕叶', '白夕琴乃（重构体）'],
      locationRefs: [],
    });
    const capture = await service('directive-presence-w', { extract: async () => empty() }).capture({
      workspaceId: 'directive-presence-w', chatKey: 'chat', sources: [row],
    });
    const ownerById = new Map(capture.owners.map(owner => [owner.id, owner.canonicalName ?? owner.displayName]));
    const traceOwners = capture.traces.map(trace => ownerById.get(trace.ownerId));
    expect(traceOwners).toEqual(expect.arrayContaining(['白夕小时', '白夕叶']));
    expect(traceOwners).not.toContain('白夕琴乃（重构体）');
  });

  it('does not erase semantic punctuation while locating evidence', async () => {
    const row = source({
      id: 'message:semantic-punctuation',
      content: '白夕小时明确说：“不要杀他。”',
      actorRefs: ['白夕小时'],
      locationRefs: [],
    });
    const extractor = { extract: async (input: any): Promise<StructuredCaptureResult> => {
      const hour = input.knownActorContext.find((item: any) => item.canonicalName === '白夕小时').referenceId;
      return {
        ...empty(),
        claims: [{
          localId: 'semantic-punctuation', sourceRef: row.id, kind: 'commitment', subjectRef: hour,
          predicateKey: '下令', objectText: '不要杀他', content: '白夕小时下令不要杀他。',
          // Removing the comma changes the command into the opposite meaning.
          evidenceExcerpt: '不要，杀他',
          knowledge: { mode: 'self_reported', privacy: 'public', ownerRefs: [hour], speakerRef: hour, observerRefs: [], presentRefs: [hour], mentionedRefs: [] },
          confidence: 0.98, stableAnchor: false,
        }],
      };
    } };
    const capture = await service('semantic-punctuation-w', extractor).capture({ workspaceId: 'semantic-punctuation-w', chatKey: 'chat', sources: [row] });

    expect(capture.facts).toEqual([]);
    expect(capture.rejections).toEqual(expect.arrayContaining([
      expect.objectContaining({ recordType: 'claim', code: 'excerpt_mismatch' }),
    ]));
  });

  it('persists stable relationship object references for profiles and graph projection', async () => {
    const row = source({
      id: 'message:relationship-object',
      content: '白夕小时明确表示她信任白夕叶。',
      actorRefs: ['白夕小时', '白夕叶'],
      locationRefs: [],
    });
    const extractor = { extract: async (input: any): Promise<StructuredCaptureResult> => {
      const hour = input.knownActorContext.find((item: any) => item.canonicalName === '白夕小时').referenceId;
      const leaf = input.knownActorContext.find((item: any) => item.canonicalName === '白夕叶').referenceId;
      return {
        ...empty(),
        claims: [{
          localId: 'relationship-object', sourceRef: row.id, kind: 'relationship', subjectRef: hour, objectRef: leaf,
          predicateKey: '信任', objectText: '白夕叶', content: '白夕小时信任白夕叶。', evidenceExcerpt: '白夕小时明确表示她信任白夕叶',
          knowledge: { mode: 'self_reported', privacy: 'public', ownerRefs: [hour], speakerRef: hour, observerRefs: [leaf], presentRefs: [hour, leaf], mentionedRefs: [leaf] },
          confidence: 0.98, stableAnchor: true,
        }],
      };
    } };
    const capture = await service('relationship-object-w', extractor).capture({ workspaceId: 'relationship-object-w', chatKey: 'chat', sources: [row] });
    const hour = capture.owners.find(owner => owner.canonicalName === '白夕小时')!;
    const leaf = capture.owners.find(owner => owner.canonicalName === '白夕叶')!;

    expect(capture.rejections).toEqual([]);
    expect(capture.facts[0]).toMatchObject({
      subjectEntityId: hour.id,
      objectEntityId: leaf.id,
      subjectKey: '白夕小时',
      objectKey: '白夕叶',
      kind: 'relationship',
    });
  });

  it('retains every novel evidence and observation for a duplicate fact in one batch', async () => {
    const first = source({ id: 'message:evidence-1', content: '紫罗能够净化空气。', actorRefs: ['紫罗'], locationRefs: [] });
    const second = source({ id: 'message:evidence-2', content: '紫罗再次证明自己能够净化空气。', createdAt: 2_000, actorRefs: ['紫罗'], locationRefs: [] });
    const committedInputs: any[] = [];
    const commitCapture = vi.fn(async (input: any): Promise<void> => {
      committedInputs.push(input);
    });
    const repository = { listFacts: async () => [], commitCapture };
    const extractor = { extract: async (input: any): Promise<StructuredCaptureResult> => {
      const violet = input.knownActorContext.find((item: any) => item.canonicalName === '紫罗').referenceId;
      const knowledge = { mode: 'experienced' as const, privacy: 'public' as const, ownerRefs: [violet], speakerRef: violet, observerRefs: [violet], presentRefs: [violet], mentionedRefs: [] };
      return {
        ...empty(),
        claims: [
          { localId: 'evidence-1', sourceRef: first.id, kind: 'capability', subjectRef: violet, predicateKey: '净化空气', objectText: '空气', content: '紫罗能够净化空气。', evidenceExcerpt: first.content, knowledge, confidence: 0.98, stableAnchor: true },
          { localId: 'evidence-2', sourceRef: second.id, kind: 'capability', subjectRef: violet, predicateKey: '净化空气', objectText: '空气', content: '紫罗能够净化空气。', evidenceExcerpt: '紫罗再次证明自己能够净化空气', knowledge, confidence: 0.98, stableAnchor: true },
        ],
      };
    } };
    const capture = await service('multi-evidence-w', extractor, repository).capture({ workspaceId: 'multi-evidence-w', chatKey: 'chat', sources: [first, second] });
    const committed = committedInputs[0];

    expect(capture.facts).toHaveLength(1);
    expect(capture.facts[0]?.sourceRefs).toEqual([first.id, second.id]);
    expect(capture.facts[0]?.evidenceIds).toHaveLength(2);
    expect(capture.observations).toHaveLength(2);
    expect(committed).toBeDefined();
    expect(committed.evidence).toHaveLength(2);
    expect(new Set(committed.evidence.map((item: any) => item.id)).size).toBe(2);
    expect(new Set(committed.evidence.map((item: any) => item.sourceRef))).toEqual(new Set([first.id, second.id]));
  });

  it('rejects private knowledge without a resolvable speaker instead of downgrading it', async () => {
    const row = source({ id: 'message:invalid-private-speaker', content: '白夕小时心想：绝不能透露密钥。', actorRefs: ['白夕小时'], locationRefs: [] });
    const extractor = { extract: async (input: any): Promise<StructuredCaptureResult> => {
      const hour = input.knownActorContext.find((item: any) => item.canonicalName === '白夕小时').referenceId;
      return {
        ...empty(),
        claims: [{
          localId: 'invalid-private-speaker', sourceRef: row.id, kind: 'state', subjectRef: hour,
          predicateKey: '保密', objectText: '密钥', content: '白夕小时决定不透露密钥。', evidenceExcerpt: '绝不能透露密钥',
          knowledge: { mode: 'experienced', privacy: 'private', ownerRefs: [hour], speakerRef: 'actor:unrelated-broken-ref', observerRefs: [], presentRefs: [hour], mentionedRefs: [] },
          confidence: 0.98, stableAnchor: false,
        }],
      };
    } };
    const capture = await service('invalid-private-speaker-w', extractor).capture({ workspaceId: 'invalid-private-speaker-w', chatKey: 'chat', sources: [row] });

    expect(capture.facts).toEqual([]);
    expect(capture.rejections).toEqual(expect.arrayContaining([
      expect.objectContaining({ recordType: 'claim', code: 'entity_ref_unsupported', fieldPath: 'knowledge' }),
    ]));
  });

  it('safely omits unsupported optional episode refs on the final conservative repair', async () => {
    const row = source({ id: 'message:repair-episode', content: '琴乃完成了燃油检查。', actorRefs: ['琴乃'], locationRefs: [] });
    const extractor = { extract: async (input: any): Promise<StructuredCaptureResult> => {
      expect(input.repair.referenceDirectory.allowedActorRefs.map((item: any) => item.referenceId)).toEqual(['A01']);
      return {
        ...empty(),
        episodes: [{
          localId: 'repair-episode',
          sourceRefs: [row.id],
          participantRefs: ['A99'],
          presentRefs: ['A99'],
          mentionedRefs: [],
          locationRef: 'L99',
          summary: '琴乃完成了本轮燃油检查。',
        }],
      };
    } };
    const capture = await service('repair-episode-w', extractor).capture({
      workspaceId: 'repair-episode-w',
      chatKey: 'chat',
      sources: [row],
      repair: {
        collection: 'episodes',
        issues: [{ path: 'episodes[0].locationRef', keyword: 'entityRef', expected: 'source-supported ref' }],
        attempt: 2,
        maxAttempts: 2,
        mode: 'conservative',
        maxItems: 1,
      },
    });

    expect(capture.outcome).toBe('complete');
    expect(capture.resolutionMode).toBe('degraded');
    expect(capture.rejections).toEqual([]);
    expect(capture.episodes[0]).toMatchObject({ participantIds: [], presentOwnerIds: [] });
    expect(capture.episodes[0]).not.toHaveProperty('locationId');
    expect(capture.fieldActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'episodes[0].participantRefs', action: 'filter' }),
      expect.objectContaining({ path: 'episodes[0].presentRefs', action: 'filter' }),
      expect.objectContaining({ path: 'episodes[0].locationRef', action: 'clear' }),
    ]));
  });

  it('degrades a non-relationship subject ref only when supported subject text remains', async () => {
    const row = source({ id: 'message:repair-claim', content: '琴乃确认燃油仍然充足。', actorRefs: ['琴乃'], locationRefs: [] });
    const makeExtractor = (kind: 'state' | 'relationship', subjectText: string) => ({
      extract: async (): Promise<StructuredCaptureResult> => ({
        ...empty(),
        claims: [{
          localId: `repair-${kind}`,
          sourceRef: row.id,
          kind,
          subjectRef: 'A99',
          subjectText,
          predicateKey: kind === 'relationship' ? '信任' : '确认燃油',
          objectRef: kind === 'relationship' ? 'A98' : undefined,
          objectText: kind === 'relationship' ? '' : '燃油充足',
          content: kind === 'relationship' ? '琴乃明确表示信任另一人。' : '琴乃确认燃油仍然充足。',
          evidenceExcerpt: row.content,
          knowledge: { mode: 'asserted', privacy: 'public', ownerRefs: [], observerRefs: [], presentRefs: [], mentionedRefs: [] },
          confidence: 0.98,
          stableAnchor: false,
        }],
      }),
    });
    const repair = {
      collection: 'claims' as const,
      issues: [{ path: 'claims[0].subjectRef', keyword: 'entityRef', expected: 'source-supported ref' }],
      attempt: 2,
      maxAttempts: 2,
      mode: 'conservative' as const,
      maxItems: 1,
    };
    const degraded = await service('repair-claim-w', makeExtractor('state', '琴乃')).capture({
      workspaceId: 'repair-claim-w', chatKey: 'chat', sources: [row], repair,
    });
    const blocked = await service('repair-relationship-w', makeExtractor('relationship', '琴乃')).capture({
      workspaceId: 'repair-relationship-w', chatKey: 'chat', sources: [row], repair,
    });

    expect(degraded.outcome).toBe('complete');
    expect(degraded.resolutionMode).toBe('degraded');
    expect(degraded.fieldActions).toContainEqual(expect.objectContaining({ path: 'claims[0].subjectRef', action: 'clear' }));
    expect(blocked.outcome).toBe('partial');
    expect(blocked.facts).toEqual([]);
    expect(blocked.fieldActions).toBeUndefined();
  });
});
