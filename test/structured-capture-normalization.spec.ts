import { describe, expect, it } from 'vitest';
import { normalizeStructuredCapture } from '../src/application/ingest/llm-extractor';
import type { SourceBlock } from '../src/application/ingest/types';

const source: SourceBlock = {
  id: 'message:overflow',
  chatKey: 'chat',
  kind: 'message',
  role: 'assistant',
  content: '测试主体确认测试事实。',
  createdAt: 1,
};

function claim(index: number): Record<string, unknown> {
  return {
    localId: `claim-${index}`,
    sourceRef: source.id,
    episodeLocalId: '',
    kind: 'state',
    subjectRef: '',
    subjectText: `测试主体${index}`,
    predicateKey: '确认',
    objectRef: '',
    objectText: '测试事实',
    content: `测试主体${index}确认测试事实。`,
    evidenceExcerpt: source.content,
    knowledge: {
      mode: 'asserted', privacy: 'public', ownerRefs: [], speakerRef: '', viewpointRef: '',
      observerRefs: [], presentRefs: [], mentionedRefs: [],
    },
    confidence: 0.9,
    stableAnchor: false,
  };
}

describe('structured Capture normalization boundaries', () => {
  it('keeps the resource bound but audits array overflow instead of silently dropping records', () => {
    const result = normalizeStructuredCapture({
      actorCandidates: [], locationCandidates: [], episodes: [],
      claims: Array.from({ length: 33 }, (_, index) => claim(index)),
    }, [source]);

    expect(result.claims).toHaveLength(32);
    expect(result.rejections).toEqual([
      expect.objectContaining({
        recordType: 'batch', code: 'invalid_shape', fieldPath: 'claims',
        sourceRefs: [source.id], status: 'unresolved',
      }),
    ]);
  });

  it('preserves missing critical fields as invalid so the server can repair them fail-closed', () => {
    const result = normalizeStructuredCapture({
      actorCandidates: [], locationCandidates: [], episodes: [],
      claims: [{
        ...claim(1),
        confidence: undefined,
        knowledge: { ownerRefs: [], observerRefs: [], presentRefs: [], mentionedRefs: [] },
      }],
    }, [source]);

    expect(result.claims[0]?.confidence).toBe(0.6);
    expect(result.claims[0]?.knowledge.mode).toBe('unknown');
    expect(result.claims[0]?.knowledge.privacy).toBe('limited');
  });

  it('truncates by Unicode code point without producing a lone surrogate', () => {
    const longName = `${'甲'.repeat(79)}𠮷乙`;
    const result = normalizeStructuredCapture({
      actorCandidates: [{
        localId: 'actor-long', displayName: longName, aliases: [], sourceRef: source.id,
        evidenceExcerpt: source.content, confidence: 0.9,
      }],
      locationCandidates: [], episodes: [], claims: [],
    }, [source]);

    const normalized = result.actorCandidates[0]?.displayName ?? '';
    expect(Array.from(normalized)).toHaveLength(80);
    expect(normalized.endsWith('𠮷')).toBe(true);
    expect(normalized.includes('\uFFFD')).toBe(false);
  });
});
