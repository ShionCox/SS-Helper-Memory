import { describe, expect, it } from 'vitest';

import { decideFactReconciliation, type MemoryFact } from '../src/domain/index';

const existing: MemoryFact = {
  id: 'fact-old',
  chatKey: 'chat-a',
  kind: 'state',
  subjectKey: '艾琳',
  predicateKey: '所在地',
  objectKey: '南港',
  canonicalKey: '艾琳::所在地::',
  content: '艾琳当前停留在南港，正在等待前往北塔的船只恢复通行。',
  entityKeys: ['艾琳', '南港'],
  confidence: 0.88,
  status: 'active',
  sourceRefs: ['message:10'],
  evidenceIds: ['evidence:10'],
  freshestEvidenceAt: 100,
  origin: 'automatic',
  revision: 1,
  createdAt: 100,
  updatedAt: 100,
};

describe('canonical reconciliation', () => {
  it('deduplicates equivalent content under the same canonical key', () => {
    expect(
      decideFactReconciliation(existing, {
        canonicalKey: existing.canonicalKey,
        content: ' 艾琳当前停留在南港，正在等待前往北塔的船只恢复通行。 ',
        confidence: 0.92,
        freshestEvidenceAt: 120,
      }),
    ).toBe('duplicate');
  });

  it('supersedes only when conflicting evidence is newer and confident', () => {
    expect(
      decideFactReconciliation(existing, {
        canonicalKey: existing.canonicalKey,
        content: '艾琳已经离开南港并抵达北塔，当前正在塔内查阅旧星图。',
        confidence: 0.9,
        freshestEvidenceAt: 200,
      }),
    ).toBe('supersede');

    expect(
      decideFactReconciliation(existing, {
        canonicalKey: existing.canonicalKey,
        content: '艾琳已经离开南港并抵达北塔，当前正在塔内查阅旧星图。',
        confidence: 0.7,
        freshestEvidenceAt: 200,
      }),
    ).toBe('pending');

    expect(
      decideFactReconciliation(existing, {
        canonicalKey: existing.canonicalKey,
        content: '艾琳已经离开南港并抵达北塔，当前正在塔内查阅旧星图。',
        confidence: 0.96,
        freshestEvidenceAt: 90,
      }),
    ).toBe('pending');
  });
});
