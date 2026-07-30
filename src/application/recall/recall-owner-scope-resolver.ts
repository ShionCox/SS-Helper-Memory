import {
  FIXED_OWNER_IDS,
  type GenerationCastPlan,
  type GenerationRecallIntentKind,
  type RecallOwnerScope,
} from '../../domain';

function unique(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))];
}

function actor(value: string | undefined): value is string {
  return Boolean(value && !Object.values(FIXED_OWNER_IDS).includes(value as never));
}

export class RecallOwnerScopeResolver {
  resolve(input: {
    readonly intentKind: GenerationRecallIntentKind;
    readonly namedOwnerIds: readonly string[];
    readonly castPlan?: GenerationCastPlan;
  }): RecallOwnerScope {
    const named = unique(input.namedOwnerIds).filter(actor);
    const required = unique(input.castPlan?.requiredOwnerIds ?? []).filter(actor);
    const likely = unique(input.castPlan?.likelyOwnerIds ?? []).filter(actor).slice(0, 2);
    const viewpoint = actor(input.castPlan?.viewpointOwnerId) ? [input.castPlan.viewpointOwnerId] : [];
    const fixed = [FIXED_OWNER_IDS.world, FIXED_OWNER_IDS.narrator];

    switch (input.intentKind) {
      case 'recent_context':
        return { ownerIds: [], requiredOwnerIds: [], fallback: 'none' };
      case 'world_knowledge':
        return { ownerIds: fixed, requiredOwnerIds: [], fallback: 'none' };
      case 'actor_entity':
        return { ownerIds: unique([...fixed, ...named]), requiredOwnerIds: [], fallback: 'none' };
      case 'actor_knowledge':
      case 'relationship':
        return { ownerIds: named, requiredOwnerIds: named, fallback: 'none' };
      case 'scene_action': {
        // The Cast planner grants the viewpoint full recall permission without
        // requiring it to also be selected as a speaker.  Keep that memory in
        // scope for scene actions, otherwise a POV-only turn loses continuity.
        const owners = unique([...viewpoint, ...required, ...likely]);
        return { ownerIds: owners, requiredOwnerIds: unique([...viewpoint, ...required]), fallback: 'none' };
      }
      case 'timeline': {
        const owners = named.length > 0 ? named : unique([...viewpoint, ...required]);
        return { ownerIds: owners, requiredOwnerIds: owners, fallback: 'none' };
      }
      default: {
        const owners = unique([...fixed, ...viewpoint, ...required, ...likely]);
        return { ownerIds: owners, requiredOwnerIds: unique([...viewpoint, ...required]), fallback: 'none' };
      }
    }
  }
}
