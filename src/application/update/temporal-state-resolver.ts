import type { SourceBlock, StructuredClaim, StructuredEpisode, StructuredInventoryOperation } from '../ingest/types';
import type { TemporalState } from '../extraction/extraction-types';

export class TemporalStateResolver {
  resolve(
    candidate: StructuredClaim | StructuredEpisode | StructuredInventoryOperation,
    sources: readonly SourceBlock[],
    now = Date.now(),
  ): TemporalState {
    const sourceRef = 'sourceRef' in candidate ? candidate.sourceRef : candidate.sourceRefs[0];
    const source = sources.find(item => item.id === sourceRef);
    const eventTimeText = 'storyTimeText' in candidate ? candidate.storyTimeText : undefined;
    return {
      ...(eventTimeText ? { eventTimeText } : {}),
      ...(source?.createdAt === undefined ? {} : { validFrom: source.createdAt }),
      observedAt: source?.createdAt ?? now,
      ingestedAt: now,
    };
  }

  isPastEvent(state: TemporalState, newestCurrentTime?: number): boolean {
    return state.validFrom !== undefined && newestCurrentTime !== undefined && state.validFrom < newestCurrentTime;
  }
}
