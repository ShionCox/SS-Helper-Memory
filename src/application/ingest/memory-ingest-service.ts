import { filterSourceBlocks } from './source-blocks';
import type { AutomaticIngestRejection, AutomaticProposalErrorCode } from '../../domain';
import type { IngestCommit, IngestCommitter, MemoryExtractor, SourceBlock, ValidatedFactProposal } from './types';

export interface MemoryIngestInput {
  chatKey: string;
  jobId: string;
  sources: readonly SourceBlock[];
  jobType?: IngestCommit['jobType'];
  jobStatus?: IngestCommit['jobStatus'];
  batchIndex?: number;
  totalBatches?: number;
  processedCount?: number;
  metadataSourceRefs?: string[];
  selectedSourceGroupIds?: string[];
}

export interface MemoryIngestResult {
  accepted: number;
  rejected: number;
  rejections: AutomaticIngestRejection[];
  skipped: boolean;
}

function normalizeKey(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function stateSnapshotProposals(sources: readonly SourceBlock[]): ValidatedFactProposal[] {
  return sources.filter(source => source.kind === 'state').flatMap((source) => source.content.split('\n').flatMap((line) => {
    const [marker, rawPath, ...valueParts] = line.split('\t');
    const value = valueParts.join('\t').trim();
    const path = rawPath?.split(' / ').map(item => item.trim()).filter(Boolean) ?? [];
    const subjectKey = path.at(-1) ?? '';
    if (marker !== '状态快照' || !subjectKey || !value) return [];
    const readablePath = path.join(' / ');
    const content = `最新变量状态确认：${readablePath} = ${value}`;
    const canonicalKey = ['state', subjectKey, '当前状态', value].map(normalizeKey).join('|');
    return [{
      kind: 'state' as const,
      subjectKey,
      predicateKey: '当前状态',
      objectKey: value,
      content: Array.from(content).length > 240 ? `${Array.from(content).slice(0, 239).join('')}…` : content,
      entityKeys: [...new Set([...path, subjectKey])],
      confidence: 1,
      sourceRef: source.id,
      evidenceExcerpt: line,
      actionHint: 'supersede' as const,
      validFrom: source.createdAt,
      canonicalKey,
      stable: false,
    }];
  }));
}

function validateProposal(
  proposal: ValidatedFactProposal,
  sources: ReadonlyMap<string, SourceBlock>,
): { ok: true } | { ok: false; code: AutomaticProposalErrorCode; message: string } {
  const source = sources.get(proposal.sourceRef);
  const contentLength = Array.from(proposal.content.trim()).length;
  if (!source) return { ok: false, code: 'missing_source', message: `来源 ${proposal.sourceRef || '(空)'} 不存在。` };
  if (!proposal.subjectKey.trim() || !proposal.predicateKey.trim()) return { ok: false, code: 'invalid_shape', message: '事实缺少主语或谓词。' };
  if (contentLength < 20 || contentLength > 240) return { ok: false, code: 'content_length', message: '事实正文必须为 20–240 字。' };
  if (!Number.isFinite(proposal.confidence) || proposal.confidence < 0 || proposal.confidence > 1) return { ok: false, code: 'invalid_confidence', message: '置信度必须位于 0–1。' };
  if (!proposal.evidenceExcerpt.trim()) return { ok: false, code: 'empty_excerpt', message: '证据摘录不能为空。' };
  if (!source.content.includes(proposal.evidenceExcerpt)) return { ok: false, code: 'excerpt_mismatch', message: '证据摘录无法在来源正文中逐字匹配。' };
  return { ok: true };
}

/** 冷启动、历史整理与增量总结共用的唯一写入服务。 */
export class MemoryIngestService {
  constructor(private readonly dependencies: { extractor: MemoryExtractor; commit: IngestCommitter['commit'] }) {}

  async ingest(input: MemoryIngestInput): Promise<MemoryIngestResult> {
    const sources = filterSourceBlocks(input.sources);
    if (sources.length === 0) return { accepted: 0, rejected: 0, rejections: [], skipped: true };

    const modelSources = sources.filter(source => source.kind !== 'state');
    const extraction = modelSources.length > 0
      ? await this.dependencies.extractor.extract({ chatKey: input.chatKey, sources: modelSources })
      : [];
    const raw = [
      ...(Array.isArray(extraction) ? extraction : extraction.facts).slice(0, 12),
      ...stateSnapshotProposals(sources),
    ];
    const audit = Array.isArray(extraction) ? undefined : extraction.audit;
    const sourceMap = new Map(sources.map((source) => [source.id, source]));
    const canonicalKeys = new Set<string>();
    const facts: ValidatedFactProposal[] = [];
    const rejections: AutomaticIngestRejection[] = [];

    for (const [proposalIndex, proposal] of raw.entries()) {
      const canonicalKey = [proposal.kind, proposal.subjectKey, proposal.predicateKey, proposal.objectKey ?? '']
        .map(normalizeKey)
        .join('|');
      const source = sourceMap.get(proposal.sourceRef);
      const scope = proposal.stable === true && source?.kind === 'character'
        ? { characterKeys: source.entityKeys?.length ? [...source.entityKeys] : [proposal.subjectKey] }
        : proposal.stable === true && source?.kind === 'worldbook' && source.entityKeys?.[0]
          ? { worldKeys: [source.entityKeys[0]] }
          : undefined;
      const candidate: ValidatedFactProposal = {
        ...proposal,
        canonicalKey,
        stable: scope !== undefined,
        ...(scope ? { scope } : {}),
      };
      const validation = validateProposal(candidate, sourceMap);
      if (!validation.ok) {
        rejections.push({ index: proposalIndex, code: validation.code, message: validation.message });
        continue;
      }
      if (canonicalKeys.has(canonicalKey)) {
        rejections.push({ index: proposalIndex, code: 'duplicate_proposal', message: '同一批次存在重复 canonical fact。' });
        continue;
      }
      canonicalKeys.add(canonicalKey);
      facts.push(candidate);
    }

    await this.dependencies.commit({
      chatKey: input.chatKey,
      jobId: input.jobId,
      facts,
      sources,
      checkpoint: {
        sourceIds: sources.map((source) => source.id),
        completedAt: Date.now(),
        ...(input.batchIndex === undefined ? {} : { batchIndex: input.batchIndex }),
        ...(input.totalBatches === undefined ? {} : { totalBatches: input.totalBatches }),
        ...(input.processedCount === undefined ? {} : { processedCount: input.processedCount }),
        overlapSourceRefs: sources.slice(-2).map((source) => source.id),
        ...(input.metadataSourceRefs === undefined ? {} : { metadataSourceRefs: input.metadataSourceRefs }),
        ...(input.selectedSourceGroupIds === undefined ? {} : { selectedSourceGroupIds: input.selectedSourceGroupIds }),
      },
      ...(input.jobType === undefined ? {} : { jobType: input.jobType }),
      ...(input.jobStatus === undefined ? {} : { jobStatus: input.jobStatus }),
      rejections,
      ...(audit ? { audit } : {}),
    });
    return { accepted: facts.length, rejected: rejections.length, rejections, skipped: false };
  }
}
