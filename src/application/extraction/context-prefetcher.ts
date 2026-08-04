import type { MultiActorMemoryRepository } from '../../infrastructure';
import type {
  ExistingMemoryContextItem,
  KnownActorContextItem,
  KnownInventoryContextItem,
  KnownLocationContextItem,
  MemoryExtractionInput,
} from '../ingest/types';

export interface PrefetchedExtractionContext {
  readonly input: MemoryExtractionInput;
  readonly dataRevision: number;
  readonly counts: Readonly<Record<'actors' | 'locations' | 'inventory' | 'facts' | 'scenes', number>>;
}

function textContains(haystack: string, values: readonly string[]): boolean {
  const normalized = haystack.toLocaleLowerCase('zh-CN');
  return values.some(value => value.trim() && normalized.includes(value.trim().toLocaleLowerCase('zh-CN')));
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...new Map(values.map(value => [key(value), value])).values()];
}

function revision(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const record = value as Record<string, unknown>;
  return Math.max(0, ...['revision', 'updatedAt', 'updatedAtFloor', 'createdAt'].map(key => Number(record[key]) || 0));
}

export class DeterministicContextPrefetcher {
  constructor(private readonly repository?: MultiActorMemoryRepository) {}

  async prefetch(input: MemoryExtractionInput): Promise<PrefetchedExtractionContext> {
    if (!this.repository) return {
      input,
      dataRevision: 0,
      counts: { actors: input.knownActorContext?.length ?? 0, locations: input.knownLocationContext?.length ?? 0, inventory: input.knownInventoryContext?.length ?? 0, facts: input.existingMemoryContext?.length ?? 0, scenes: 0 },
    };
    const corpus = input.sources.map(source => source.content).join('\n');
    const [owners, locations, items, states, facts, scenes] = await Promise.all([
      this.repository.listOwners(),
      this.repository.listLocations(),
      this.repository.listInventoryItems(),
      this.repository.listInventoryStates(),
      this.repository.listFacts(),
      this.repository.listSceneStates(),
    ]);
    const actors: KnownActorContextItem[] = owners
      .filter(owner => textContains(corpus, [owner.canonicalName ?? owner.displayName, owner.displayName, ...(owner.aliases ?? [])]))
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, 50)
      .map((owner, index) => ({ referenceId: `A${String(index + 1).padStart(2, '0')}`, ownerId: owner.id, recordRevision: revision(owner), canonicalName: owner.canonicalName ?? owner.displayName, aliases: [...(owner.aliases ?? [])], status: owner.status === 'pending' ? 'pending' : 'confirmed' }));
    const knownLocations: KnownLocationContextItem[] = locations
      .filter(location => textContains(corpus, [location.canonicalName, ...(location.aliases ?? [])]))
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, 50)
      .map((location, index) => ({ referenceId: `L${String(index + 1).padStart(2, '0')}`, locationId: location.id, recordRevision: revision(location), canonicalName: location.canonicalName, aliases: [...(location.aliases ?? [])], status: location.status === 'pending' ? 'pending' : 'confirmed' }));
    const inventory: KnownInventoryContextItem[] = items
      .filter(item => textContains(corpus, [item.canonicalName, ...(item.aliases ?? [])]))
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, 50)
      .map((item, index) => ({ referenceId: `O${String(index + 1).padStart(2, '0')}`, itemId: item.id, recordRevision: Math.max(revision(item), ...states.filter(state => state.itemId === item.id).map(revision)), canonicalName: item.canonicalName, aliases: [...(item.aliases ?? [])], category: item.category, states: states.filter(state => state.itemId === item.id).map(state => ({ measureKind: state.measureKind, amount: state.amount, unit: state.unit, precision: state.precision, availability: state.availability, updatedAtFloor: state.updatedAtFloor })) }));
    const existing: ExistingMemoryContextItem[] = facts
      .filter(fact => textContains(corpus, [fact.subjectKey, fact.objectKey ?? '', fact.content]))
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
      .slice(0, 50)
      .map((fact, index) => ({ referenceId: `F${String(index + 1).padStart(2, '0')}`, factId: fact.id, recordRevision: revision(fact), kind: fact.kind, subjectKey: fact.subjectKey, predicateKey: fact.predicateKey, ...(fact.objectKey ? { objectKey: fact.objectKey } : {}), content: fact.content, ...(fact.validFrom === undefined ? {} : { validFrom: fact.validFrom }), ...(fact.validUntil === undefined ? {} : { validUntil: fact.validUntil }), stable: fact.stableAnchor }));
    const knownActors = uniqueBy([...(input.knownActorContext ?? []), ...actors], item => item.ownerId ?? item.referenceId);
    const mergedLocations = uniqueBy([...(input.knownLocationContext ?? []), ...knownLocations], item => item.locationId ?? item.referenceId);
    const mergedInventory = uniqueBy([...(input.knownInventoryContext ?? []), ...inventory], item => item.itemId ?? item.referenceId);
    const mergedFacts = uniqueBy([...(input.existingMemoryContext ?? []), ...existing], item => `${item.kind}\0${item.subjectKey}\0${item.predicateKey}\0${item.objectKey ?? ''}\0${item.content}`);
    return {
      input: { ...input, knownActorContext: knownActors, knownLocationContext: mergedLocations, knownInventoryContext: mergedInventory, existingMemoryContext: mergedFacts },
      dataRevision: Math.trunc(Math.max(0, ...owners.map(revision), ...locations.map(revision), ...items.map(revision), ...states.map(revision), ...facts.map(revision), ...scenes.map(revision))),
      counts: { actors: knownActors.length, locations: mergedLocations.length, inventory: mergedInventory.length, facts: mergedFacts.length, scenes: scenes.length },
    };
  }
}
