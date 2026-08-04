import { createSSHelperError, type PlainData } from '@ss-helper/sdk';
import type { MultiActorMemoryRepository } from '../../infrastructure';
import type { MemoryReviewItem } from '../extraction/extraction-types';

export type MemoryReviewAction = 'accept' | 'reject' | 'edit' | 'merge' | 'reextract';

export function validateMemoryReviewResolution(action: MemoryReviewAction, payload?: PlainData): PlainData | undefined {
  if (payload !== undefined) {
    const encoded = JSON.stringify(payload);
    if (encoded.length > 16_384) throw createSSHelperError('MEMORY_UPDATE_PENDING_REVIEW', { stage: 'memory.review.payload', expected: 'a review payload no larger than 16 KiB' });
  }
  if (action === 'edit') {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw createSSHelperError('MEMORY_UPDATE_PENDING_REVIEW', { stage: 'memory.review.edit', expected: 'an edited candidate object' });
    return payload;
  }
  if (action === 'merge') {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof (payload as Record<string, unknown>).targetRef !== 'string' || !(payload as Record<string, unknown>).targetRef) {
      throw createSSHelperError('MEMORY_UPDATE_PENDING_REVIEW', { stage: 'memory.review.merge', expected: 'a non-empty targetRef' });
    }
    return payload;
  }
  return payload;
}

export class MemoryReviewQueue {
  constructor(private readonly repository: MultiActorMemoryRepository) {}

  list(status?: MemoryReviewItem['status']): Promise<MemoryReviewItem[]> {
    return this.repository.listMemoryReviewItems(status);
  }

  async resolve(id: string, action: MemoryReviewAction, payload?: PlainData): Promise<MemoryReviewItem> {
    const validatedPayload = validateMemoryReviewResolution(action, payload);
    const status = action === 'reject' ? 'rejected'
      : action === 'edit' ? 'edited'
        : action === 'accept' || action === 'merge' ? 'accepted'
          : action === 'reextract' ? 'expired'
            : undefined;
    if (!status) throw createSSHelperError('MEMORY_UPDATE_PENDING_REVIEW', { stage: 'memory.review.resolve' });
    // This queue stores only the explicit review decision. Domain writes are
    // performed by the normal Capture validators/commit guard, never here.
    return this.repository.resolveMemoryReviewItem(id, status, {
      action,
      validated: action === 'reject' || action === 'reextract' ? false : true,
      ...(validatedPayload === undefined ? {} : { payload: validatedPayload }),
    });
  }

  async expire(id: string, reason: string): Promise<MemoryReviewItem> {
    return this.repository.resolveMemoryReviewItem(id, 'expired', { reason: reason.slice(0, 160) });
  }

  async exportGold(): Promise<PlainData> {
    const resolved = (await this.list()).filter(item => item.status !== 'pending' && item.status !== 'expired');
    return resolved.map(item => ({
      stage: item.stage,
      reasonCode: item.reasonCode,
      status: item.status,
      candidateSummary: item.candidateSummary,
      ...(item.currentStateSummary === undefined ? {} : { currentStateSummary: item.currentStateSummary }),
      ...(item.resolution === undefined ? {} : { resolution: item.resolution }),
    })) as PlainData;
  }
}
