import { describe, expect, it } from 'vitest';
import { normalizeStructuredCapture } from '../src/application/ingest/llm-extractor';
import type { SourceBlock } from '../src/application/ingest/types';
import { buildSupportedEvidenceDirectory } from '../src/application/ingest/supported-evidence-directory';

const source: SourceBlock = {
  id: 'message:overflow',
  chatKey: 'chat',
  kind: 'message',
  role: 'assistant',
  content: '测试主体确认测试事实。',
  createdAt: 1,
};
const evidenceDirectory = buildSupportedEvidenceDirectory([source]);
const evidenceSpanId = evidenceDirectory.spans[0]!.evidenceSpanId;

function claim(index: number): Record<string, unknown> {
  return {
    localId: `claim-${index}`,
    episodeLocalId: '',
    kind: 'state',
    subjectRef: '',
    subjectText: `测试主体${index}`,
    predicateKey: '确认',
    objectRef: '',
    objectText: '测试事实',
    content: `测试主体${index}确认测试事实。`,
    evidenceSpanId,
    knowledge: {
      mode: 'asserted', privacy: 'public', ownerRefs: [], speakerRef: '', viewpointRef: '',
      observerRefs: [], presentRefs: [], mentionedRefs: [],
    },
    confidence: 0.9,
    stableAnchor: false,
  };
}

describe('structured Capture strict decode boundaries', () => {
  it('does not silently truncate an oversized array', () => {
    const result = normalizeStructuredCapture({
      actorCandidates: [], locationCandidates: [], itemCandidates: [], episodes: [], inventoryOperations: [],
      claims: Array.from({ length: 33 }, (_, index) => claim(index)),
    }, [source], evidenceDirectory);

    expect(result.claims).toHaveLength(33);
    expect(result.rejections).toBeUndefined();
  });

  it('does not invent defaults for missing critical fields', () => {
    const result = normalizeStructuredCapture({
      actorCandidates: [], locationCandidates: [], itemCandidates: [], episodes: [], inventoryOperations: [],
      claims: [{
        ...claim(1),
        confidence: undefined,
        knowledge: { ownerRefs: [], observerRefs: [], presentRefs: [], mentionedRefs: [] },
      }],
    }, [source], evidenceDirectory);

    expect(result.claims[0]?.confidence).toBeUndefined();
    expect(result.claims[0]?.knowledge.mode).toBeUndefined();
    expect(result.claims[0]?.knowledge.privacy).toBeUndefined();
  });

  it('does not truncate or normalize strings', () => {
    const longName = `${'甲'.repeat(79)}𠮷乙`;
    const result = normalizeStructuredCapture({
      actorCandidates: [{
        localId: 'actor-long', displayName: longName, aliases: [],
        evidenceSpanId, confidence: 0.9,
      }],
      locationCandidates: [], itemCandidates: [], episodes: [], claims: [], inventoryOperations: [],
    }, [source], evidenceDirectory);

    const decoded = result.actorCandidates[0]?.displayName ?? '';
    expect(decoded).toBe(longName);
    expect(Array.from(decoded)).toHaveLength(81);
    expect(result.actorCandidates[0]?.sourceRef).toBe(source.id);
  });
});
