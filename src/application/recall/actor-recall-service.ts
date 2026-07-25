import { OwnerAwareRecallCoordinator, type OwnerAwareRecallDependencies } from './owner-aware-recall-coordinator';

/** Backward-compatible public name for the production owner-aware coordinator. */
export type ActorRecallDependencies = OwnerAwareRecallDependencies;
export class ActorRecallService extends OwnerAwareRecallCoordinator {}
