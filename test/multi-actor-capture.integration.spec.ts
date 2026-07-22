import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ActorRegistry, MultiActorCaptureService } from '../src/application/actors';
import type { SourceBlock, StructuredCaptureResult } from '../src/application/ingest/types';

const rows = readFileSync(new URL('./fixtures/multi-actor-story.jsonl', import.meta.url), 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line) as SourceBlock);
const extractor = { extract: async (): Promise<StructuredCaptureResult> => ({
  actorCandidates: [
    { localId: 'a', displayName: 'A', sourceRefs: ['m1'], evidenceExcerpts: ['A说：我找到了铜钥匙。'], confidence: 0.95, status: 'confirmed' },
    { localId: 'b', displayName: 'B', sourceRefs: ['m2'], evidenceExcerpts: ['B站在门外'], confidence: 0.95, status: 'confirmed' },
    { localId: 'p', displayName: '玩家', sourceRefs: ['m4'], evidenceExcerpts: ['玩家在第五层'], confidence: 0.9, status: 'confirmed' },
  ],
  episodes: [{ localId: 'e1', sourceRefs: ['m1', 'm2', 'm3'], participantRefs: ['a', 'b'], presentRefs: ['a', 'b'], mentionedRefs: ['a', 'b'], floorStart: 1, floorEnd: 3 }],
  observations: [
    { localId: 'o1', sourceRef: 'm1', episodeLocalId: 'e1', speakerRef: 'a', viewpointRef: 'a', channel: 'public_speech', privacy: 'public', observerRefs: ['a'], presentRefs: ['a'], factRefs: ['f1'], excerpt: 'A说：我找到了铜钥匙。' },
    { localId: 'o2', sourceRef: 'm3', episodeLocalId: 'e1', speakerRef: 'a', viewpointRef: 'a', channel: 'private_thought', privacy: 'private', observerRefs: ['a'], presentRefs: ['a'], factRefs: ['f2'], excerpt: 'A心想：不能让B知道秘密。' },
    { localId: 'o3', sourceRef: 'm5', episodeLocalId: 'e1', speakerRef: 'b', viewpointRef: 'b', channel: 'rumor', privacy: 'public', observerRefs: ['b'], presentRefs: ['b'], factRefs: ['f3'], excerpt: 'B听说A已经背叛了城主，但这只是传闻。' },
  ],
  facts: [
    { localId: 'f1', sourceRef: 'm1', subjectKey: 'A', predicateKey: '持有', content: 'A持有铜钥匙这一事实', confidence: 0.95, evidenceExcerpt: 'A说：我找到了铜钥匙。' },
    { localId: 'f2', sourceRef: 'm3', subjectKey: 'A', predicateKey: '知道秘密', content: 'A知道不能让B知道的秘密', confidence: 0.9, evidenceExcerpt: 'A心想：不能让B知道秘密。' },
    { localId: 'f3', sourceRef: 'm5', subjectKey: 'A', predicateKey: '背叛城主', content: 'A可能背叛城主（传闻）', confidence: 0.4, evidenceExcerpt: 'B听说A已经背叛了城主' },
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
        actorCandidates: [{ localId: 'z', displayName: '紫罗', sourceRefs: [source.id], evidenceExcerpts: [source.content], confidence: 1, status: 'confirmed' }],
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
});
