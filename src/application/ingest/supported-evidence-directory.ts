import type { SourceBlock } from './types';
import { createSSHelperError } from '@ss-helper/sdk';

export interface SupportedEvidenceSpan {
  readonly evidenceSpanId: string;
  readonly sourceRef: string;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface SupportedEvidenceDirectory {
  readonly spans: readonly SupportedEvidenceSpan[];
  readonly spansById: ReadonlyMap<string, SupportedEvidenceSpan>;
  readonly evidenceSetHash: string;
}

const MAX_EVIDENCE_SPAN_LENGTH = 800;
const BOUNDARY = /(?:\r?\n{2,}|(?<=[。！？!?；;])\s*|(?<=[.!?])\s+(?=[A-Z0-9“"'（(]))/gu;

function stableHash(value: string): string {
  const words: string[] = [];
  for (let variant = 0; variant < 4; variant += 1) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index) ^ variant;
      hash = Math.imul(hash, 0x01000193);
    }
    words.push((hash >>> 0).toString(16).padStart(8, '0'));
  }
  return words.join('');
}

function continuousSlices(content: string): Array<{ start: number; end: number }> {
  const boundaries = [0];
  for (const match of content.matchAll(BOUNDARY)) {
    const end = (match.index ?? 0) + match[0].length;
    if (end > boundaries[boundaries.length - 1]!) boundaries.push(end);
  }
  if (boundaries[boundaries.length - 1] !== content.length) boundaries.push(content.length);
  const slices: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let index = 1; index < boundaries.length; index += 1) {
    const end = boundaries[index]!;
    if (end - start <= MAX_EVIDENCE_SPAN_LENGTH) continue;
    const previous = boundaries[index - 1]!;
    if (previous > start) {
      slices.push({ start, end: previous });
      start = previous;
    }
    while (end - start > MAX_EVIDENCE_SPAN_LENGTH) {
      slices.push({ start, end: start + MAX_EVIDENCE_SPAN_LENGTH });
      start += MAX_EVIDENCE_SPAN_LENGTH;
    }
  }
  if (start < content.length) slices.push({ start, end: content.length });
  return slices.filter(slice => content.slice(slice.start, slice.end).trim().length > 0);
}

export function buildSupportedEvidenceDirectory(
  sources: readonly SourceBlock[],
  writableSourceRefs: readonly string[] = sources.map(source => source.id),
): SupportedEvidenceDirectory {
  const writable = new Set(writableSourceRefs);
  const spans = sources
    .filter(source => writable.has(source.id))
    .flatMap(source => continuousSlices(source.content).map(({ start, end }) => ({
      evidenceSpanId: `ev:${stableHash(`${source.id}\0${start}\0${end}\0${source.content.slice(start, end)}`)}`,
      sourceRef: source.id,
      start,
      end,
      text: source.content.slice(start, end),
    })));
  const spansById = new Map<string, SupportedEvidenceSpan>();
  for (const span of spans) {
    if (spansById.has(span.evidenceSpanId)) {
      throw createSSHelperError('PLAIN_DATA_BOUNDARY_INVALID', {
        stage: 'memory.capture.evidence-directory',
        path: '$.evidenceSpanId',
        keyword: 'unique',
        expected: 'a unique evidence span identifier',
      });
    }
    spansById.set(span.evidenceSpanId, span);
  }
  return {
    spans,
    spansById,
    evidenceSetHash: stableHash(spans.map(span => `${span.evidenceSpanId}:${span.sourceRef}:${span.start}:${span.end}`).join('|')),
  };
}

export function evidenceSpanById(
  directory: SupportedEvidenceDirectory,
  evidenceSpanId: string,
): SupportedEvidenceSpan | undefined {
  return directory.spansById.get(evidenceSpanId);
}

export function evidenceSpanFor(
  directory: SupportedEvidenceDirectory,
  evidenceSpanId: string,
  sourceRef: string,
): SupportedEvidenceSpan | undefined {
  const span = evidenceSpanById(directory, evidenceSpanId);
  return span?.sourceRef === sourceRef ? span : undefined;
}
