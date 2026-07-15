import { describe, expect, it } from 'vitest';

import {
  ACTIVE_CONFIDENCE_THRESHOLD,
  createCanonicalKey,
  validateAutomaticProposal,
  type MemorySourceBlock,
} from '../src/domain/index';

const source: MemorySourceBlock = {
  id: 'message:42',
  chatKey: 'chat-a',
  type: 'message',
  content: '艾琳明确表示，她会在冬至前把星图送到北塔，并请旅伴不要忘记这项约定。',
  occurredAt: 200,
};

describe('automatic fact evidence validation', () => {
  it('accepts an atomic fact only when its evidence is an exact source excerpt', () => {
    const result = validateAutomaticProposal(
      {
        kind: 'commitment',
        subjectKey: '艾琳',
        predicateKey: '送达',
        objectKey: '星图@北塔',
        content: '艾琳承诺会在冬至前把星图送到北塔，这是一项仍待完成的约定。',
        entityKeys: ['艾琳', '北塔', '星图'],
        confidence: 0.91,
        evidence: [{ sourceRef: source.id, excerpt: '她会在冬至前把星图送到北塔' }],
      },
      [source],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('active');
    expect(result.value.sourceRefs).toEqual(['message:42']);
  });

  it('rejects missing sources, invented excerpts, and non-atomic fact length', () => {
    const base = {
      kind: 'commitment' as const,
      subjectKey: '艾琳',
      predicateKey: '送达',
      content: '艾琳承诺会在冬至前把星图送到北塔，这是一项仍待完成的约定。',
      entityKeys: ['艾琳'],
      confidence: 0.9,
    };

    expect(
      validateAutomaticProposal(
        { ...base, evidence: [{ sourceRef: 'message:404', excerpt: '冬至前送达' }] },
        [source],
      ),
    ).toMatchObject({ ok: false, code: 'missing_source' });

    expect(
      validateAutomaticProposal(
        { ...base, evidence: [{ sourceRef: source.id, excerpt: '她将在春分后送达星图' }] },
        [source],
      ),
    ).toMatchObject({ ok: false, code: 'excerpt_mismatch' });

    expect(
      validateAutomaticProposal(
        {
          ...base,
          content: '太短',
          evidence: [{ sourceRef: source.id, excerpt: '她会在冬至前把星图送到北塔' }],
        },
        [source],
      ),
    ).toMatchObject({ ok: false, code: 'content_length' });
  });

  it('keeps a supported low-confidence proposal pending instead of active', () => {
    const result = validateAutomaticProposal(
      {
        kind: 'state',
        subjectKey: '北塔',
        predicateKey: '状态',
        content: '北塔目前可能处于封闭状态，但对话中的表述仍然不够确定。',
        entityKeys: ['北塔'],
        confidence: ACTIVE_CONFIDENCE_THRESHOLD - 0.01,
        evidence: [{ sourceRef: source.id, excerpt: '北塔' }],
      },
      [source],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('pending');
  });
});

describe('canonical keys', () => {
  it('normalizes case, whitespace, and optional object keys deterministically', () => {
    expect(createCanonicalKey(' 艾琳 ', ' 会 送达 ', ' STAR MAP ')).toBe('艾琳::会 送达::star map');
    expect(createCanonicalKey('艾琳', '会 送达')).toBe('艾琳::会 送达::');
  });
});
