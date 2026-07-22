import {
  ACTIVE_CONFIDENCE_THRESHOLD,
  createFactSlotKey,
  normalizeFactContent,
  type AutomaticIngestRejection,
  type FactStatus,
  type MemoryTokenUsage,
} from '../../domain';
import type {
  FactKind,
  MemoryExtractionAudit,
  SourceBlock,
  SourceBlockKind,
  ValidatedFactProposal,
} from './types';

export type InitializationPhase = 'extract' | 'reduce' | 'resolve' | 'apply';
export type InitializationQualityStatus = 'ready' | 'needs_review';
export type InitializationConflictAction = 'merge' | 'keep_both' | 'supersede' | 'pending';

export interface InitializationSourceSnapshot {
  id: string;
  type: SourceBlockKind;
  occurredAt: number;
  floor?: number;
}

/**
 * Kept in job-audits while an initialization is running.  It deliberately
 * stores only provenance needed to create evidence during the final apply,
 * not a duplicate copy of the whole chat transcript.
 */
export interface InitializationStagingBatch {
  id: string;
  kind: 'initialization-staging-v0';
  chatKey: string;
  jobId: string;
  batchIndex: number;
  totalBatches: number;
  processedCount: number;
  sources: InitializationSourceSnapshot[];
  facts: ValidatedFactProposal[];
  rejections: AutomaticIngestRejection[];
  audit?: MemoryExtractionAudit;
  createdAt: number;
  updatedAt: number;
}

/** Persisted after reduction/resolution so an apply retry never asks the LLM again. */
export interface InitializationResolutionStaging {
  id: string;
  kind: 'initialization-resolution-v0';
  chatKey: string;
  jobId: string;
  reduction: InitializationReduction;
  createdAt: number;
  updatedAt: number;
}

export interface InitializationEvidence {
  sourceRef: string;
  excerpt: string;
}

export interface InitializationReducedFact {
  id: string;
  kind: FactKind;
  subjectKey: string;
  predicateKey: string;
  objectKey?: string;
  canonicalKey: string;
  slotKey: string;
  content: string;
  entityKeys: string[];
  confidence: number;
  evidence: InitializationEvidence[];
  sourceRefs: string[];
  freshestEvidenceAt: number;
  validFrom?: number;
  validTo?: number;
  stable?: boolean;
  scope?: ValidatedFactProposal['scope'];
  status: FactStatus;
  supersedesRecordId?: string;
  supersededByRecordId?: string;
  conflictBucketId?: string;
}

export interface InitializationConflictBucket {
  id: string;
  kind: FactKind;
  slotKey: string;
  mode: 'temporal' | 'stable';
  recordIds: string[];
}

export interface InitializationConflictResolution {
  bucketId: string;
  action: InitializationConflictAction;
  primaryId?: string;
  secondaryIds?: string[];
  resolver: 'rule' | 'llm' | 'fallback';
}

export interface InitializationFinalizationStats {
  stagedBatchCount: number;
  extractedFactCount: number;
  acceptedFactCount: number;
  mergedDuplicateCount: number;
  supersededCount: number;
  conflictBucketCount: number;
  ruleResolvedCount: number;
  llmResolvedCount: number;
  pendingReviewCount: number;
  qualityStatus: InitializationQualityStatus;
}

/** Aggregated from staged extraction calls and retained after bulky staging is removed. */
export interface InitializationRouteSummary {
  requestCount: number;
  resourceIds: string[];
  models: string[];
  latencyMs: number | null;
  usage: MemoryTokenUsage | null;
}

export interface InitializationReduction {
  facts: InitializationReducedFact[];
  conflictBuckets: InitializationConflictBucket[];
  stats: InitializationFinalizationStats;
}

const ADDITIVE_KINDS = new Set<FactKind>(['event', 'commitment']);
const TEMPORAL_KINDS = new Set<FactKind>(['state', 'location', 'relationship', 'goal']);

function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))];
}

const TOKEN_USAGE_FIELDS = ['promptTokens', 'completionTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'] as const;

/**
 * The final audit outlives per-batch staging, so preserve a truthful route
 * summary instead of rendering the final write as if it were another extract
 * batch. Missing provider fields intentionally remain null/empty.
 */
export function summarizeInitializationRoutes(batches: readonly InitializationStagingBatch[]): InitializationRouteSummary {
  const audits = batches.flatMap((batch) => batch.audit ? [batch.audit] : []);
  const latencyValues = audits
    .map((audit) => audit.latencyMs)
    .filter((value): value is number => Number.isFinite(value));
  const usageValues = audits
    .map((audit) => audit.usage)
    .filter((value): value is MemoryTokenUsage => value !== null && value !== undefined);
  const usage = usageValues.length === 0 ? null : TOKEN_USAGE_FIELDS.reduce<MemoryTokenUsage>((total, field) => {
    const values = usageValues
      .map((item) => item[field])
      .filter((value): value is number => Number.isFinite(value));
    total[field] = values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
    return total;
  }, {
    promptTokens: null,
    completionTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
  });
  return {
    requestCount: audits.length,
    resourceIds: uniqueStrings(audits.map((audit) => audit.resourceId ?? '')),
    models: uniqueStrings(audits.map((audit) => audit.model ?? '')),
    latencyMs: latencyValues.length === 0 ? null : latencyValues.reduce((sum, value) => sum + value, 0),
    usage,
  };
}

function normalized(value: string | undefined): string {
  return String(value ?? '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function sourceTimes(batches: readonly InitializationStagingBatch[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const batch of batches) {
    for (const source of batch.sources) result.set(source.id, source.occurredAt);
  }
  return result;
}

function cloneProposal(proposal: ValidatedFactProposal): ValidatedFactProposal {
  return structuredClone(proposal);
}

function evidenceKey(evidence: InitializationEvidence): string {
  return `${evidence.sourceRef}\n${evidence.excerpt}`;
}

function effectiveSlotKey(proposal: ValidatedFactProposal): string {
  const base = createFactSlotKey(proposal.subjectKey, proposal.predicateKey);
  return ADDITIVE_KINDS.has(proposal.kind)
    ? `${base}::item::${stableHash(proposal.canonicalKey)}`
    : base;
}

function recordId(jobId: string, canonicalKey: string, content: string): string {
  return `init-fact:${stableHash(`${jobId}\n${canonicalKey}\n${normalized(normalizeFactContent(content))}`)}`;
}

function chooseRepresentative(proposals: readonly ValidatedFactProposal[], times: ReadonlyMap<string, number>): ValidatedFactProposal {
  return [...proposals].sort((left, right) => {
    const leftTime = times.get(left.sourceRef) ?? left.validFrom ?? 0;
    const rightTime = times.get(right.sourceRef) ?? right.validFrom ?? 0;
    return rightTime - leftTime
      || right.confidence - left.confidence
      || Array.from(right.content).length - Array.from(left.content).length;
  })[0]!;
}

function buildReducedFact(jobId: string, proposals: readonly ValidatedFactProposal[], times: ReadonlyMap<string, number>): InitializationReducedFact {
  const representative = chooseRepresentative(proposals, times);
  const evidence = [...new Map(proposals.map((proposal) => {
    const item = { sourceRef: proposal.sourceRef, excerpt: proposal.evidenceExcerpt };
    return [evidenceKey(item), item] as const;
  })).values()];
  const freshestEvidenceAt = Math.max(...proposals.map((proposal) => times.get(proposal.sourceRef) ?? proposal.validFrom ?? 0));
  const earliestValidFrom = proposals
    .map((proposal) => proposal.validFrom)
    .filter((value): value is number => Number.isFinite(value));
  const latestValidTo = proposals
    .map((proposal) => proposal.validTo)
    .filter((value): value is number => Number.isFinite(value));
  const canonicalKey = representative.canonicalKey;
  return {
    id: recordId(jobId, canonicalKey, representative.content),
    kind: representative.kind,
    subjectKey: representative.subjectKey,
    predicateKey: representative.predicateKey,
    ...(representative.objectKey ? { objectKey: representative.objectKey } : {}),
    canonicalKey,
    slotKey: effectiveSlotKey(representative),
    content: representative.content,
    entityKeys: uniqueStrings(proposals.flatMap((proposal) => proposal.entityKeys)),
    confidence: Math.max(...proposals.map((proposal) => proposal.confidence)),
    evidence,
    sourceRefs: uniqueStrings(evidence.map((item) => item.sourceRef)),
    freshestEvidenceAt,
    ...(earliestValidFrom.length ? { validFrom: Math.min(...earliestValidFrom) } : {}),
    ...(latestValidTo.length ? { validTo: Math.max(...latestValidTo) } : {}),
    ...(proposals.some((proposal) => proposal.stable) ? { stable: true } : {}),
    ...(representative.scope ? { scope: structuredClone(representative.scope) } : {}),
    status: 'active',
  };
}

function resolutionForTemporal(bucket: InitializationConflictBucket, facts: InitializationReducedFact[]): InitializationConflictResolution | undefined {
  const candidates = facts.filter((fact) => bucket.recordIds.includes(fact.id)).sort((left, right) => right.freshestEvidenceAt - left.freshestEvidenceAt || right.confidence - left.confidence);
  const latest = candidates[0];
  const previous = candidates[1];
  if (!latest || !previous || latest.freshestEvidenceAt <= previous.freshestEvidenceAt || latest.confidence < ACTIVE_CONFIDENCE_THRESHOLD) return undefined;
  return {
    bucketId: bucket.id,
    action: 'supersede',
    primaryId: latest.id,
    secondaryIds: candidates.slice(1).map((item) => item.id),
    resolver: 'rule',
  };
}

function applyResolution(facts: InitializationReducedFact[], resolution: InitializationConflictResolution): void {
  const members = facts.filter((fact) => resolution.secondaryIds?.includes(fact.id) || fact.id === resolution.primaryId);
  if (resolution.action === 'pending' || !resolution.primaryId) {
    for (const member of members) member.status = 'pending';
    return;
  }
  const primary = facts.find((fact) => fact.id === resolution.primaryId);
  if (!primary) return;
  primary.status = 'active';
  if (resolution.action === 'keep_both') {
    for (const member of members) if (member.id !== primary.id) member.status = 'active';
    return;
  }
  for (const member of members) {
    if (member.id === primary.id) continue;
    member.status = 'superseded';
    member.supersededByRecordId = primary.id;
    primary.supersedesRecordId ??= member.id;
  }
}

/** Reduces all validated initialization batches before any Memory fact is persisted. */
export function reduceInitializationBatches(jobId: string, batches: readonly InitializationStagingBatch[]): InitializationReduction {
  const allProposals = batches.flatMap((batch) => batch.facts.map(cloneProposal));
  const times = sourceTimes(batches);
  const byCanonical = new Map<string, ValidatedFactProposal[]>();
  for (const proposal of allProposals) {
    const key = `${proposal.kind}\n${proposal.canonicalKey}\n${normalized(normalizeFactContent(proposal.content))}`;
    const values = byCanonical.get(key) ?? [];
    values.push(proposal);
    byCanonical.set(key, values);
  }
  const facts = [...byCanonical.values()].map((proposals) => buildReducedFact(jobId, proposals, times));
  const bySlot = new Map<string, InitializationReducedFact[]>();
  for (const fact of facts) {
    if (ADDITIVE_KINDS.has(fact.kind)) continue;
    const group = bySlot.get(fact.slotKey) ?? [];
    group.push(fact);
    bySlot.set(fact.slotKey, group);
  }
  const conflictBuckets: InitializationConflictBucket[] = [];
  const ruleResolutions: InitializationConflictResolution[] = [];
  for (const [slotKey, records] of bySlot) {
    if (records.length <= 1) continue;
    const mode = records.some((record) => TEMPORAL_KINDS.has(record.kind)) ? 'temporal' : 'stable';
    const bucket: InitializationConflictBucket = {
      id: `init-conflict:${stableHash(`${jobId}\n${slotKey}`)}`,
      kind: records[0]!.kind,
      slotKey,
      mode,
      recordIds: records.map((record) => record.id),
    };
    const rule = mode === 'temporal' ? resolutionForTemporal(bucket, facts) : undefined;
    if (rule) {
      applyResolution(facts, rule);
      ruleResolutions.push(rule);
    } else {
      for (const record of records) {
        record.status = 'pending';
        record.conflictBucketId = bucket.id;
      }
      conflictBuckets.push(bucket);
    }
  }
  const stats: InitializationFinalizationStats = {
    stagedBatchCount: batches.length,
    extractedFactCount: allProposals.length,
    acceptedFactCount: facts.length,
    mergedDuplicateCount: Math.max(0, allProposals.length - facts.length),
    supersededCount: facts.filter((fact) => fact.status === 'superseded').length,
    conflictBucketCount: conflictBuckets.length,
    ruleResolvedCount: ruleResolutions.length,
    llmResolvedCount: 0,
    pendingReviewCount: facts.filter((fact) => fact.status === 'pending').length,
    qualityStatus: facts.some((fact) => fact.status === 'pending') ? 'needs_review' : 'ready',
  };
  return { facts, conflictBuckets, stats };
}

export function applyInitializationConflictResolutions(
  reduction: InitializationReduction,
  resolutions: readonly InitializationConflictResolution[],
): InitializationReduction {
  const facts = structuredClone(reduction.facts);
  const buckets = new Map(reduction.conflictBuckets.map((bucket) => [bucket.id, bucket]));
  let llmResolvedCount = 0;
  for (const resolution of resolutions) {
    const bucket = buckets.get(resolution.bucketId);
    if (!bucket || !resolution.primaryId || !bucket.recordIds.includes(resolution.primaryId)) continue;
    const secondaryIds = uniqueStrings(resolution.secondaryIds ?? []).filter((id) => id !== resolution.primaryId && bucket.recordIds.includes(id));
    applyResolution(facts, { ...resolution, secondaryIds });
    if (resolution.resolver === 'llm') llmResolvedCount += 1;
  }
  const pendingReviewCount = facts.filter((fact) => fact.status === 'pending').length;
  return {
    facts,
    conflictBuckets: reduction.conflictBuckets,
    stats: {
      ...reduction.stats,
      supersededCount: facts.filter((fact) => fact.status === 'superseded').length,
      llmResolvedCount,
      pendingReviewCount,
      qualityStatus: pendingReviewCount > 0 ? 'needs_review' : 'ready',
    },
  };
}

export function snapshotsFromSources(sources: readonly SourceBlock[]): InitializationSourceSnapshot[] {
  return sources.map((source) => ({
    id: source.id,
    type: source.kind,
    occurredAt: source.createdAt,
    ...(source.floor === undefined ? {} : { floor: source.floor }),
  }));
}
