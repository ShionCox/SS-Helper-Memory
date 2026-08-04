import type { SceneState } from '../../domain';
import type { SourceBlock } from '../ingest/types';
import type { TemporalState } from '../extraction/extraction-types';

export type SceneUpdateDecision = 'reuse' | 'scene_transition' | 'update_presence' | 'pending_review' | 'reject';

export class SceneUpdatePlanner {
  plan(current: SceneState | undefined, sources: readonly SourceBlock[], temporal: TemporalState, readSetValid = true, candidateLocationRefs: readonly string[] = []): { readonly decision: SceneUpdateDecision; readonly reasonCode: string } {
    if (!readSetValid) return { decision: 'pending_review', reasonCode: 'MEMORY_AGENT_TOOL_STALE_REVISION' };
    const transitions = sources.map(source => source.transition).filter(Boolean);
    if (!current) return { decision: 'scene_transition', reasonCode: 'MEMORY_SCENE_INITIAL' };
    if (candidateLocationRefs.length > 0 && !candidateLocationRefs.some(ref => current.locationKeys.includes(ref))) return { decision: 'scene_transition', reasonCode: 'MEMORY_SCENE_EXPLICIT_TRANSITION' };
    if (transitions.some(item => item?.sceneReset || item?.timeJump || (item?.locationKeys?.length ?? 0) > 0)) return { decision: 'scene_transition', reasonCode: 'MEMORY_SCENE_EXPLICIT_TRANSITION' };
    if (transitions.some(item => (item?.enteredOwnerRefs?.length ?? 0) > 0 || (item?.exitedOwnerRefs?.length ?? 0) > 0)) return { decision: 'update_presence', reasonCode: 'MEMORY_SCENE_PRESENCE' };
    if (temporal.validFrom !== undefined && temporal.validFrom < current.createdAt) return { decision: 'reuse', reasonCode: 'MEMORY_UPDATE_APPEND_HISTORY' };
    return { decision: 'reuse', reasonCode: 'MEMORY_SCENE_REUSE' };
  }
}
