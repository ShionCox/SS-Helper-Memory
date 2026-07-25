import {
  classifyLocationName,
  locationEntityId,
  normalizeLocationName,
  stableMemoryRecordKey,
  type LocationAlias,
  type LocationCandidate,
  type MemoryLocation,
} from '../../domain';

export interface LocationDiscoveryInput {
  readonly displayName: string;
  readonly aliases?: readonly string[];
  readonly sourceRef: string;
  readonly excerpt?: string;
  readonly confidence?: number;
  readonly confirmed?: boolean;
}

export interface LocationResolution {
  readonly location: MemoryLocation;
  readonly method: 'exact' | 'normalized' | 'created' | 'pending' | 'unknown';
  readonly confidence: number;
  readonly ambiguous: boolean;
}

function clamp(value: number | undefined, fallback = 0.6): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? Number(value) : fallback));
}

export function isPlausibleLocationName(
  value: string,
  options: { readonly trusted?: boolean; readonly evidence?: string } = {},
): boolean {
  return classifyLocationName(value, {
    trust: options.trusted ? 'trusted' : 'candidate',
    evidence: options.evidence,
  }).accepted;
}

export function deriveLocationAliases(value: string): string[] {
  const name = value.normalize('NFKC').trim();
  if (!name) return [];
  // Do not infer aliases from story-specific prefixes or arbitrary substrings.
  // Only explicit hierarchy delimiters are safe enough to expose a short form.
  const aliases = new Set<string>([name]);
  const explicitTail = name.split(/(?:\/|＞|>|→)/u).at(-1)?.trim();
  if (explicitTail && explicitTail !== name && classifyLocationName(explicitTail, { trust: 'trusted' }).accepted) aliases.add(explicitTail);
  return [...aliases];
}

export class LocationRegistry {
  private readonly locationsById = new Map<string, MemoryLocation>();
  private readonly aliasesById = new Map<string, LocationAlias>();
  private readonly aliasIdsByNormalized = new Map<string, string[]>();
  private readonly pending = new Map<string, LocationCandidate>();

  constructor(readonly workspaceId: string) {}

  listLocations(): MemoryLocation[] {
    return [...this.locationsById.values()]
      .filter(location => !location.mergedIntoId)
      .map(location => structuredClone(location));
  }

  listAliases(): LocationAlias[] { return [...this.aliasesById.values()].map(alias => structuredClone(alias)); }
  listPending(): LocationCandidate[] { return [...this.pending.values()].map(candidate => structuredClone(candidate)); }

  hydrate(locations: readonly MemoryLocation[], aliases: readonly LocationAlias[] = []): void {
    this.locationsById.clear();
    this.aliasesById.clear();
    this.aliasIdsByNormalized.clear();
    for (const location of locations) {
      if (location.workspaceId === this.workspaceId) this.locationsById.set(location.id, structuredClone(location));
    }
    for (const alias of aliases) {
      if (alias.workspaceId !== this.workspaceId) continue;
      this.aliasesById.set(alias.id, structuredClone(alias));
      const ids = this.aliasIdsByNormalized.get(alias.normalizedValue) ?? [];
      if (!ids.includes(alias.id)) ids.push(alias.id);
      this.aliasIdsByNormalized.set(alias.normalizedValue, ids);
    }
  }

  hydratePending(candidates: readonly LocationCandidate[]): void {
    this.pending.clear();
    for (const candidate of candidates) this.pending.set(candidate.localId, structuredClone(candidate));
  }

  getLocation(locationId: string): MemoryLocation | undefined {
    const location = this.locationsById.get(locationId);
    return location ? structuredClone(location) : undefined;
  }

  resolveMention(value: string): LocationResolution | undefined {
    const raw = value.trim();
    if (!raw) return undefined;
    if (raw.startsWith('location:')) {
      const direct = this.locationsById.get(raw);
      return direct ? { location: structuredClone(direct), method: 'exact', confidence: 1, ambiguous: false } : undefined;
    }
    const normalized = normalizeLocationName(raw);
    const ids = this.aliasIdsByNormalized.get(normalized) ?? [];
    const resolved = [...new Set(ids
      .map(id => this.aliasesById.get(id))
      .filter((alias): alias is LocationAlias => Boolean(alias && alias.status === 'confirmed'))
      .map(alias => alias.locationId))]
      .map(id => this.locationsById.get(id))
      .filter((location): location is MemoryLocation => Boolean(location && location.status === 'confirmed' && !location.mergedIntoId));
    if (resolved.length === 1) return { location: structuredClone(resolved[0]!), method: 'exact', confidence: 1, ambiguous: false };
    if (resolved.length > 1) return { location: structuredClone(resolved[0]!), method: 'pending', confidence: 0.4, ambiguous: true };
    const canonical = this.listLocations().filter(location => normalizeLocationName(location.canonicalName) === normalized);
    if (canonical.length === 1) return { location: canonical[0]!, method: 'normalized', confidence: 0.98, ambiguous: false };
    return undefined;
  }

  private addAlias(location: MemoryLocation, value: string, sourceRef: string, confidence: number): void {
    const aliasValue = value.trim();
    if (!isPlausibleLocationName(aliasValue)) return;
    const normalizedValue = normalizeLocationName(aliasValue);
    const id = `location-alias:${location.id}:${stableMemoryRecordKey(normalizedValue)}`;
    const now = Date.now();
    const alias: LocationAlias = {
      id,
      workspaceId: this.workspaceId,
      locationId: location.id,
      value: aliasValue,
      normalizedValue,
      sourceRef,
      confidence: clamp(confidence),
      status: location.status,
      createdAt: this.aliasesById.get(id)?.createdAt ?? now,
      updatedAt: now,
    };
    this.aliasesById.set(id, alias);
    const ids = this.aliasIdsByNormalized.get(normalizedValue) ?? [];
    if (!ids.includes(id)) ids.push(id);
    this.aliasIdsByNormalized.set(normalizedValue, ids);
  }

  discover(input: LocationDiscoveryInput): LocationResolution {
    const boundary = classifyLocationName(input.displayName, {
      trust: input.confirmed === true ? 'trusted' : 'candidate',
      evidence: input.excerpt,
      aliases: input.aliases,
    });
    const displayName = boundary.canonicalName;
    if (!boundary.accepted) {
      return {
        location: {
          id: 'location:unknown', workspaceId: this.workspaceId, displayName: '未知地点', canonicalName: '未知地点',
          aliases: ['未知地点'], status: 'pending', confidence: 0, sourceRefs: [input.sourceRef], createdAt: Date.now(), updatedAt: Date.now(),
        },
        method: 'unknown', confidence: 0, ambiguous: true,
      };
    }
    const existing = this.resolveMention(displayName);
    if (existing && !existing.ambiguous) {
      const current = existing.location;
      const promote = input.confirmed === true && current.status === 'pending';
      const updated: MemoryLocation = {
        ...current,
        aliases: [...new Set([...current.aliases, ...deriveLocationAliases(displayName), ...(input.aliases ?? [])])],
        confidence: Math.max(current.confidence, clamp(input.confidence, current.confidence)),
        sourceRefs: [...new Set([...current.sourceRefs, input.sourceRef])],
        ...(promote ? { status: 'confirmed' as const } : {}),
        updatedAt: Date.now(),
      };
      this.locationsById.set(updated.id, updated);
      for (const alias of updated.aliases) this.addAlias(updated, alias, input.sourceRef, updated.confidence);
      if (promote) {
        for (const [candidateId, candidate] of this.pending.entries()) {
          if (candidate.locationRef === updated.id) this.pending.delete(candidateId);
        }
      }
      return { ...existing, location: structuredClone(updated), method: promote ? 'exact' : existing.method, ambiguous: false };
    }
    const now = Date.now();
    const status = input.confirmed === true ? 'confirmed' as const : 'pending' as const;
    const aliases = [...new Set([...deriveLocationAliases(displayName), ...(input.aliases ?? [])].map(alias => alias.trim()).filter(Boolean))];
    const location: MemoryLocation = {
      id: locationEntityId(this.workspaceId, displayName),
      workspaceId: this.workspaceId,
      displayName,
      canonicalName: displayName,
      aliases,
      status,
      confidence: clamp(input.confidence, status === 'confirmed' ? 0.9 : 0.7),
      sourceRefs: [input.sourceRef],
      createdAt: now,
      updatedAt: now,
    };
    this.locationsById.set(location.id, location);
    for (const alias of aliases) this.addAlias(location, alias, input.sourceRef, location.confidence);
    if (status === 'pending') {
      const candidate: LocationCandidate = {
        localId: `candidate:${location.id}`,
        displayName,
        aliases,
        sourceRef: input.sourceRef,
        evidenceExcerpt: '',
        confidence: location.confidence,
        status: 'pending',
        locationRef: location.id,
      };
      this.pending.set(candidate.localId, candidate);
    }
    return { location: structuredClone(location), method: status === 'confirmed' ? 'created' : 'pending', confidence: location.confidence, ambiguous: status !== 'confirmed' };
  }

  discoverCandidate(candidate: LocationCandidate): LocationResolution {
    const resolution = this.discover({
      displayName: candidate.displayName,
      aliases: candidate.aliases,
      sourceRef: candidate.sourceRef,
      excerpt: candidate.evidenceExcerpt,
      confidence: candidate.confidence,
      confirmed: false,
    });
    // Reusing an already-confirmed directory entry is not a new unresolved
    // location. Persisting it as pending would make the workbench show a false
    // audit item and could later delete/recreate a perfectly valid location.
    if (resolution.method !== 'unknown' && resolution.location.status === 'pending') {
      this.pending.set(candidate.localId, {
        ...candidate,
        aliases: candidate.aliases ?? [],
        status: 'pending',
        locationRef: resolution.location.id,
      });
    } else if (resolution.location.status === 'confirmed') {
      this.pending.delete(candidate.localId);
    }
    return resolution;
  }
}
