import { describe, expect, it } from 'vitest';
import {
  buildEvidenceWindowHash,
  buildSupportedEvidenceDirectory,
  evidenceSpanById,
  evidenceSpanFor,
} from '../src/application/ingest/supported-evidence-directory';
import type { SourceBlock } from '../src/application/ingest/types';

function source(id: string, content: string): SourceBlock {
  return { id, chatKey: 'chat', kind: 'message', role: 'assistant', content, createdAt: 1 };
}

describe('SupportedEvidenceDirectory', () => {
  it('creates stable, continuous spans no longer than 800 characters', () => {
    const content = `${'甲'.repeat(450)}。${'乙'.repeat(450)}！第三段。`;
    const first = buildSupportedEvidenceDirectory([source('message:1', content)]);
    const second = buildSupportedEvidenceDirectory([source('message:1', content)]);
    expect(first).toEqual(second);
    expect(first.spans.length).toBeGreaterThan(1);
    expect(first.spans.every(span => span.text.length <= 800)).toBe(true);
    expect(first.spans.map(span => span.text).join('')).toBe(content);
    expect(first.evidenceSetHash).toMatch(/^[a-f0-9]{32}$/u);
  });

  it('only exposes writable sources and rejects a cross-source span lookup', () => {
    const directory = buildSupportedEvidenceDirectory([
      source('message:writable', '可写证据。'),
      source('message:context', '只读上下文。'),
    ], ['message:writable']);
    expect(directory.spans.map(span => span.sourceRef)).toEqual(['message:writable']);
    expect(evidenceSpanById(directory, directory.spans[0]!.evidenceSpanId)?.sourceRef).toBe('message:writable');
    expect(evidenceSpanFor(directory, directory.spans[0]!.evidenceSpanId, 'message:context')).toBeUndefined();
  });

  it('changes the review hash when read-only neighbouring context changes', () => {
    const writable = source('message:writable', '可写证据。');
    const first = buildEvidenceWindowHash([writable, source('message:context', '旧上下文。')], [writable.id]);
    const second = buildEvidenceWindowHash([writable, source('message:context', '新上下文。')], [writable.id]);
    expect(first).not.toBe(second);
    expect(buildSupportedEvidenceDirectory([writable], [writable.id]).spans).toHaveLength(1);
  });

  it('rejects duplicate evidence span identifiers before model execution', () => {
    const duplicate = source('message:duplicate', '同一来源。');
    expect(() => buildSupportedEvidenceDirectory([duplicate, { ...duplicate }])).toThrowError(expect.objectContaining({
      details: expect.objectContaining({
        reasonCode: 'PLAIN_DATA_BOUNDARY_INVALID',
        stage: 'memory.capture.evidence-directory',
        path: '$.evidenceSpanId',
      }),
    }));
  });
});
