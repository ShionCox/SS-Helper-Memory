import type { MemoryOwner, ProvisionalActorProposal } from '../../domain';
import type { SourceBlock } from '../ingest/types';
import { ActorRegistry, type ActorResolution } from './actor-registry';

export interface ProvisionalActorMaterialization {
  readonly resolution: ActorResolution;
  readonly proposal: ProvisionalActorProposal;
}

export interface ProvisionalActorPromotion {
  readonly fromOwnerId: string;
  readonly toOwnerId: string;
  readonly canonicalName: string;
}

function hash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(36);
}

function proposalAppears(proposal: ProvisionalActorProposal, content: string): boolean {
  const values = [proposal.displayName, ...proposal.aliases].map(value => value.trim()).filter(Boolean);
  if (values.some(value => content.includes(value))) return true;
  const condensed = proposal.displayName.replace(/[的一名个穿着身]/gu, '');
  return condensed.length >= 2 && content.includes(condensed);
}

function selfIntroducedName(content: string): string | undefined {
  return content.match(/(?:我叫|我的名字是|名叫|自称)[“「『]?([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9·_-]{1,31})[”」』]?/u)?.[1]?.trim();
}

/** Materializes director proposals only after the official text actually uses them. */
export class ProvisionalActorService {
  constructor(private readonly registry: ActorRegistry) {}

  materialize(proposals: readonly ProvisionalActorProposal[], source: SourceBlock, sceneId: string): ProvisionalActorMaterialization[] {
    const results: ProvisionalActorMaterialization[] = [];
    for (const proposal of proposals) {
      if (!proposalAppears(proposal, source.content)) continue;
      const preferredOwnerId = `provisional:${encodeURIComponent(sceneId)}:${hash(proposal.displayName)}`;
      const resolution = this.registry.discover({
        displayName: proposal.displayName,
        aliases: proposal.aliases,
        sourceRef: source.id,
        sourceType: 'message',
        excerpt: source.content.slice(0, 500),
        confidence: Math.min(0.64, proposal.confidence),
        confirmed: false,
        preferredOwnerId,
      });
      results.push({ resolution, proposal });
    }
    return results;
  }

  promoteSelfIntroduction(source: SourceBlock, sceneId: string): ProvisionalActorPromotion[] {
    const canonicalName = selfIntroducedName(source.content);
    if (!canonicalName) return [];
    const prefix = `provisional:${encodeURIComponent(sceneId)}:`;
    const provisional = this.registry.listOwners().filter(owner => owner.kind === 'actor' && owner.status === 'pending' && owner.id.startsWith(prefix));
    if (provisional.length !== 1) return [];
    const stable = this.registry.discover({
      displayName: canonicalName,
      aliases: [provisional[0]!.displayName, ...provisional[0]!.aliases],
      sourceRef: source.id,
      sourceType: 'message',
      excerpt: source.content.slice(0, 500),
      confidence: 0.98,
      confirmed: true,
    }).owner;
    if (stable.id === provisional[0]!.id) return [];
    this.registry.merge(provisional[0]!.id, stable.id, source.id);
    return [{ fromOwnerId: provisional[0]!.id, toOwnerId: stable.id, canonicalName }];
  }

  listSceneProvisionalOwners(sceneId: string): MemoryOwner[] {
    const prefix = `provisional:${encodeURIComponent(sceneId)}:`;
    return this.registry.listOwners().filter(owner => owner.kind === 'actor' && owner.id.startsWith(prefix));
  }
}
