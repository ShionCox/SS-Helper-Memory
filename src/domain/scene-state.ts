/**
 * A persisted, cross-floor view of the active scene.
 *
 * SceneCast remains the immutable snapshot of what happened on one floor;
 * SceneState carries presence forward until a real transition removes it.
 */
export interface SceneState {
  readonly id: string;
  readonly workspaceId: string;
  readonly chatKey: string;
  readonly sceneId: string;
  readonly sceneEpoch: number;
  readonly locationKeys: readonly string[];
  readonly viewpointOwnerId?: string;
  /** Explicitly present actors are not removed merely because they are quiet. */
  readonly presentOwnerIds: readonly string[];
  /** Near the current scene, but outside the primary frame. */
  readonly nearbyOwnerIds: readonly string[];
  /** Explicitly exited from the current scene. */
  readonly exitedOwnerIds: readonly string[];
  readonly recentSpeakerOwnerIds: readonly string[];
  /** Mentioned entities are deliberately kept separate from presence. */
  readonly mentionedOwnerIds: readonly string[];
  readonly startedAtFloor: number;
  readonly updatedAtFloor: number;
  readonly confidence: number;
  readonly revision: number;
  readonly sourceRefs: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type SceneTransitionReason =
  | 'explicit_entry'
  | 'explicit_exit'
  | 'location_change'
  | 'time_jump'
  | 'scene_reset'
  | 'model_inferred'
  | 'user_corrected';

export interface SceneTransition {
  readonly id: string;
  readonly workspaceId: string;
  readonly chatKey: string;
  readonly sceneId: string;
  readonly floor: number;
  readonly enteredOwnerIds: readonly string[];
  readonly exitedOwnerIds: readonly string[];
  readonly previousLocationKeys: readonly string[];
  readonly currentLocationKeys: readonly string[];
  readonly previousViewpointOwnerId?: string;
  readonly currentViewpointOwnerId?: string;
  readonly reason: SceneTransitionReason;
  readonly confidence: number;
  readonly sourceRefs: readonly string[];
  readonly createdAt: number;
}

export function sceneStateRecordId(workspaceId: string, chatKey: string): string {
  return `scene-state:${encodeURIComponent(workspaceId)}:${encodeURIComponent(chatKey)}`;
}
