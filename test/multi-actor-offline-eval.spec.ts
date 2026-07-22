import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluateOfflineMemoryCases } from '../src/application/evaluation/multi-actor-offline-evaluator';

describe('P7 fixed multi-actor offline evaluation', () => {
  it('evaluates the checked-in JSONL story without network or nondeterminism', () => {
    const rows = readFileSync(new URL('./fixtures/multi-actor-story.jsonl', import.meta.url), 'utf8')
      .trim().split(/\r?\n/u).filter(Boolean);
    const report = evaluateOfflineMemoryCases([{
      id: 'multi-actor-story',
      attribution: [
        { expectedOwnerId: 'owner:actor:a', actualOwnerId: 'owner:actor:a' },
        { expectedOwnerId: 'owner:actor:b', actualOwnerId: 'owner:actor:b' },
        { expectedOwnerId: 'owner:player', actualOwnerId: 'owner:player' },
        { expectedOwnerId: 'owner:narrator', actualOwnerId: 'owner:narrator' },
      ],
      leakage: [{ targetOwnerId: 'owner:actor:b', forbiddenMarkers: ['A心想：不能让B知道秘密。', 'A的秘密'], output: 'B：我只听见了门外的风声。' }],
      fuzzy: [{ allowedText: ['关于某件事的模糊记忆'], forbiddenText: ['铜钥匙的具体齿数'], generatedText: '关于某件事的模糊记忆' }],
      grounding: [{ referencedTraceIds: ['trace:owner:actor:a:fact:1'], legalTraceIds: ['trace:owner:actor:a:fact:1'] }],
      dream: [{ rolledBack: true, derivedInvalidated: true }],
      performance: [{ objectiveRecallMs: 58, actorFilterPromptMs: 91, promptChars: 4200 }],
    }]);

    expect(rows).toHaveLength(8);
    expect(report).toMatchObject({
      caseCount: 1,
      attributionAccuracy: 1,
      leakageRate: 0,
      fuzzyFabricationRate: 0,
      groundingViolationRate: 0,
      dreamRollbackPassRate: 1,
      objectiveRecallP95Ms: 58,
      actorFilterPromptP95Ms: 91,
      pass: true,
    });
  });

  it('fails when a forbidden detail is attributed to the wrong owner', () => {
    const report = evaluateOfflineMemoryCases([{
      id: 'leak',
      attribution: [{ expectedOwnerId: 'owner:actor:a', actualOwnerId: 'owner:actor:b' }],
      leakage: [{ targetOwnerId: 'owner:actor:b', forbiddenMarkers: ['秘密'], output: 'B：秘密' }],
    }]);
    expect(report.attributionAccuracy).toBe(0);
    expect(report.leakageRate).toBe(1);
    expect(report.pass).toBe(false);
  });
});

