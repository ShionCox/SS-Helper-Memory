import {
  ACTIVE_CONFIDENCE_THRESHOLD,
  MAX_FACT_CONTENT_LENGTH,
  MIN_FACT_CONTENT_LENGTH,
  type AutomaticFactProposal,
  type AutomaticProposalValidation,
  type MemorySourceBlock,
} from './memory-types';

function normalizeKeyPart(value: string | undefined): string {
  return (value ?? '').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

export function createCanonicalKey(subjectKey: string, predicateKey: string, objectKey?: string): string {
  return [subjectKey, predicateKey, objectKey].map(normalizeKeyPart).join('::');
}

export function createFactSlotKey(subjectKey: string, predicateKey: string): string {
  return [subjectKey, predicateKey].map(normalizeKeyPart).join('::');
}

export function normalizeFactContent(content: string): string {
  return content.trim().replace(/\s+/gu, ' ');
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function validateAutomaticProposal(
  proposal: AutomaticFactProposal,
  sources: readonly MemorySourceBlock[],
): AutomaticProposalValidation {
  if (!proposal || typeof proposal !== 'object') {
    return { ok: false, code: 'invalid_shape', message: '事实提案不是对象。' };
  }

  const content = normalizeFactContent(proposal.content ?? '');
  const length = codePointLength(content);
  if (length < MIN_FACT_CONTENT_LENGTH || length > MAX_FACT_CONTENT_LENGTH) {
    return {
      ok: false,
      code: 'content_length',
      message: `事实正文必须为 ${MIN_FACT_CONTENT_LENGTH}–${MAX_FACT_CONTENT_LENGTH} 字，当前为 ${length} 字。`,
    };
  }
  if (!Number.isFinite(proposal.confidence) || proposal.confidence < 0 || proposal.confidence > 1) {
    return { ok: false, code: 'invalid_confidence', message: '事实置信度必须位于 0 到 1 之间。' };
  }
  if (!Array.isArray(proposal.evidence) || proposal.evidence.length === 0) {
    return { ok: false, code: 'missing_evidence', message: '自动事实必须至少包含一条来源证据。' };
  }

  const sourceById = new Map(sources.map(source => [source.id, source]));
  let chatKey: string | undefined;
  let freshestEvidenceAt = 0;
  const sourceRefs: string[] = [];
  for (const evidence of proposal.evidence) {
    const source = sourceById.get(evidence.sourceRef);
    if (!source) {
      return { ok: false, code: 'missing_source', message: `来源 ${evidence.sourceRef} 不存在。` };
    }
    if (chatKey !== undefined && source.chatKey !== chatKey) {
      return { ok: false, code: 'cross_chat_source', message: '同一事实不能引用不同聊天的来源。' };
    }
    chatKey = source.chatKey;
    const excerpt = evidence.excerpt?.trim();
    if (!excerpt) {
      return { ok: false, code: 'empty_excerpt', message: `来源 ${evidence.sourceRef} 的证据摘录为空。` };
    }
    if (!source.content.includes(excerpt)) {
      return {
        ok: false,
        code: 'excerpt_mismatch',
        message: `证据摘录无法在来源 ${evidence.sourceRef} 中精确匹配。`,
      };
    }
    freshestEvidenceAt = Math.max(freshestEvidenceAt, source.occurredAt);
    if (!sourceRefs.includes(source.id)) sourceRefs.push(source.id);
  }

  const subjectKey = normalizeKeyPart(proposal.subjectKey);
  const predicateKey = normalizeKeyPart(proposal.predicateKey);
  if (!subjectKey || !predicateKey) {
    return { ok: false, code: 'invalid_shape', message: 'subjectKey 和 predicateKey 不能为空。' };
  }

  return {
    ok: true,
    value: {
      ...proposal,
      subjectKey,
      predicateKey,
      ...(proposal.objectKey ? { objectKey: normalizeKeyPart(proposal.objectKey) } : {}),
      content,
      entityKeys: [...new Set((proposal.entityKeys ?? []).map(normalizeKeyPart).filter(Boolean))],
      evidence: proposal.evidence.map(item => ({ sourceRef: item.sourceRef, excerpt: item.excerpt.trim() })),
      canonicalKey: createCanonicalKey(subjectKey, predicateKey, proposal.objectKey),
      slotKey: createFactSlotKey(subjectKey, predicateKey),
      status: proposal.confidence >= ACTIVE_CONFIDENCE_THRESHOLD ? 'active' : 'pending',
      sourceRefs,
      freshestEvidenceAt,
    },
  };
}
