import {
  actorOwnerId,
  canonicalActorDisplayName,
  classifyActorName,
  DEFAULT_MEMORY_TRAITS,
  FIXED_OWNER_IDS,
  normalizeActorName,
  stableMemoryRecordKey,
  type ActorAlias,
  type ActorCandidate,
  type ActorCandidateResolution,
  type ActorDiscoverySource,
  type MemoryTraits,
  type MemoryOwner,
} from '../../domain';

export interface ActorDiscoveryInput {
  readonly displayName: string;
  readonly aliases?: readonly string[];
  readonly sourceRef: string;
  readonly sourceType: ActorDiscoverySource;
  readonly excerpt?: string;
  readonly confidence?: number;
  readonly confirmed?: boolean;
  /** Reserved for scene-local provisional actors; normal discovery derives a stable id. */
  readonly preferredOwnerId?: string;
}

export interface ActorResolution {
  readonly owner: MemoryOwner;
  readonly alias?: ActorAlias;
  readonly method: 'fixed' | 'exact' | 'normalized' | 'created' | 'pending' | 'unknown';
  readonly confidence: number;
  readonly ambiguous: boolean;
}

export interface ActorRegistryChangeAudit {
  readonly id: string;
  readonly operation: 'confirm' | 'merge' | 'split' | 'rename' | 'correct-alias' | 'update-traits';
  readonly beforeOwners: readonly MemoryOwner[];
  readonly beforeAliases: readonly ActorAlias[];
  readonly beforePending?: readonly ActorCandidate[];
  readonly createdAt: number;
  readonly undoneAt?: number;
}

function now(): number { return Date.now(); }
function clamp(value: number | undefined, fallback = 0.5): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? Number(value) : fallback));
}

function ownerName(owner: MemoryOwner): string { return owner.canonicalName ?? owner.displayName; }

function safeActorAliases(values: readonly string[]): string[] {
  const aliases: string[] = [];
  for (const value of values) {
    const decision = classifyActorName(value, { trust: 'trusted' });
    if (decision.accepted && !aliases.includes(decision.canonicalName)) aliases.push(decision.canonicalName);
  }
  return aliases;
}

export function isPlausibleActorName(
  value: string,
  options: { readonly trusted?: boolean; readonly evidence?: string; readonly aliases?: readonly string[] } = {},
): boolean {
  return classifyActorName(value, {
    trust: options.trusted ? 'trusted' : 'candidate',
    evidence: options.evidence,
    aliases: options.aliases,
  }).accepted;
}

export function deriveActorAliases(value: string): string[] {
  const displayName = canonicalActorDisplayName(value);
  if (!displayName) return [];
  // Alias inference is intentionally conservative. Family-name removal and
  // arbitrary parenthetical stripping are story-specific and can merge two
  // genuinely different identities. Explicit aliases come from the host,
  // user confirmation, or the model candidate evidence instead.
  return [displayName];
}

/**
 * Workspace-local in-world identity registry. It intentionally never creates
 * an owner from the host card id; host ids are source provenance only.
 */
export class ActorRegistry {
  private readonly ownersById = new Map<string, MemoryOwner>();
  private readonly aliasesById = new Map<string, ActorAlias>();
  private readonly aliasIdsByNormalized = new Map<string, string[]>();
  private readonly pending = new Map<string, ActorCandidate>();
  private readonly audits = new Map<string, ActorRegistryChangeAudit>();

  constructor(readonly workspaceId: string) {
    const timestamp = now();
    for (const [kind, id] of Object.entries(FIXED_OWNER_IDS) as Array<[keyof typeof FIXED_OWNER_IDS, string]>) {
      const displayName = kind === 'world' ? '世界' : kind === 'narrator' ? '旁白' : kind === 'player' ? '玩家' : '未知主体';
      this.ownersById.set(id, {
        id,
        workspaceId,
        kind,
        displayName,
        canonicalName: displayName,
        aliases: [displayName],
        ...(kind === 'narrator' ? { narratorMode: 'limited' as const } : {}),
        status: 'confirmed',
        discoverySources: ['system'],
        confidence: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
  }

  listOwners(): MemoryOwner[] { return [...this.ownersById.values()].filter(owner => !owner.mergedIntoId).map(owner => structuredClone(owner)); }
  listAliases(): ActorAlias[] { return [...this.aliasesById.values()].map(alias => structuredClone(alias)); }
  listPending(): ActorCandidate[] { return [...this.pending.values()].map(candidate => structuredClone(candidate)); }
  listAudits(): ActorRegistryChangeAudit[] { return [...this.audits.values()].map(audit => structuredClone(audit)); }

  /** Rehydrates persisted v0 identities without treating the workspace/card id as an actor. */
  hydrate(owners: readonly MemoryOwner[], aliases: readonly ActorAlias[] = []): void {
    const fixedOwnerIds = new Set<string>(Object.values(FIXED_OWNER_IDS));
    for (const ownerId of [...this.ownersById.keys()]) {
      if (!fixedOwnerIds.has(ownerId)) this.ownersById.delete(ownerId);
    }
    this.aliasesById.clear();
    this.aliasIdsByNormalized.clear();
    for (const owner of owners) {
      if (owner.workspaceId !== this.workspaceId) continue;
      this.ownersById.set(owner.id, structuredClone(owner));
    }
    for (const alias of aliases) {
      if (alias.workspaceId !== this.workspaceId) continue;
      this.aliasesById.set(alias.id, structuredClone(alias));
      const ids = this.aliasIdsByNormalized.get(alias.normalizedValue) ?? [];
      if (!ids.includes(alias.id)) ids.push(alias.id);
      this.aliasIdsByNormalized.set(alias.normalizedValue, ids);
    }
  }

  getOwner(ownerId: string): MemoryOwner | undefined {
    const owner = this.ownersById.get(ownerId);
    return owner ? structuredClone(owner) : undefined;
  }

  private updateOwner(owner: MemoryOwner, patch: Partial<MemoryOwner>): MemoryOwner {
    const updated = { ...owner, ...patch, updatedAt: now() };
    this.ownersById.set(updated.id, updated);
    return updated;
  }

  private snapshot(): { owners: MemoryOwner[]; aliases: ActorAlias[]; pending: ActorCandidate[] } {
    return { owners: this.listOwners(), aliases: this.listAliases(), pending: this.listPending() };
  }

  private recordAudit(operation: ActorRegistryChangeAudit['operation'], before: { owners: readonly MemoryOwner[]; aliases: readonly ActorAlias[]; pending?: readonly ActorCandidate[] }): ActorRegistryChangeAudit {
    const audit: ActorRegistryChangeAudit = { id: `actor-change:${crypto.randomUUID()}`, operation, beforeOwners: structuredClone(before.owners), beforeAliases: structuredClone(before.aliases), ...(before.pending ? { beforePending: structuredClone(before.pending) } : {}), createdAt: now() };
    this.audits.set(audit.id, audit);
    return structuredClone(audit);
  }

  private rebuildAliasIndex(): void {
    this.aliasIdsByNormalized.clear();
    for (const alias of this.aliasesById.values()) {
      const ids = this.aliasIdsByNormalized.get(alias.normalizedValue) ?? [];
      ids.push(alias.id);
      this.aliasIdsByNormalized.set(alias.normalizedValue, ids);
    }
  }

  undo(auditId: string): boolean {
    const audit = this.audits.get(auditId);
    if (!audit || audit.undoneAt) return false;
    for (const id of [...this.ownersById.keys()]) this.ownersById.delete(id);
    for (const owner of audit.beforeOwners) this.ownersById.set(owner.id, structuredClone(owner));
    this.aliasesById.clear();
    for (const alias of audit.beforeAliases) this.aliasesById.set(alias.id, structuredClone(alias));
    this.rebuildAliasIndex();
    this.pending.clear();
    for (const candidate of audit.beforePending ?? []) this.pending.set(candidate.localId, structuredClone(candidate));
    this.audits.set(auditId, { ...audit, undoneAt: now() });
    return true;
  }

  /** Restores pending candidates and correction history persisted by the v0 repository. */
  hydratePending(candidates: readonly ActorCandidate[]): void {
    this.pending.clear();
    for (const candidate of candidates) this.pending.set(candidate.localId, structuredClone(candidate));
  }

  hydrateAudits(audits: readonly ActorRegistryChangeAudit[]): void {
    this.audits.clear();
    for (const audit of audits) this.audits.set(audit.id, structuredClone(audit));
  }

  clearAudits(): void { this.audits.clear(); }

  private upsertPendingCandidate(input: {
    readonly displayName: string;
    readonly aliases?: readonly string[];
    readonly sourceRef: string;
    readonly excerpt?: string;
    readonly confidence?: number;
    readonly ownerRef?: string;
  }): ActorCandidate {
    const normalized = normalizeActorName(input.displayName);
    const existing = [...this.pending.values()].find(candidate =>
      input.ownerRef
        ? candidate.ownerRef === input.ownerRef
        : normalizeActorName(candidate.displayName) === normalized
          && (candidate.ownerRef ?? '') === '');
    const candidate: ActorCandidate = {
      localId: existing?.localId ?? (input.ownerRef ? `candidate:${input.ownerRef}` : `candidate:${crypto.randomUUID()}`),
      displayName: existing?.displayName ?? input.displayName.trim(),
      aliases: [...new Set([...(existing?.aliases ?? []), ...(input.aliases ?? [])].map(value => value.trim()).filter(Boolean))],
      sourceRefs: [...new Set([...(existing?.sourceRefs ?? []), input.sourceRef].filter(Boolean))],
      evidenceExcerpts: [...new Set([...(existing?.evidenceExcerpts ?? []), input.excerpt ?? ''].filter(Boolean))],
      confidence: Math.max(existing?.confidence ?? 0, clamp(input.confidence, 0.45)),
      status: 'pending',
      ...(input.ownerRef ? { ownerRef: input.ownerRef } : {}),
    };
    this.pending.set(candidate.localId, candidate);
    return structuredClone(candidate);
  }

  private addAlias(owner: MemoryOwner, value: string, sourceRef: string, confidence: number, status: ActorAlias['status'] = 'confirmed', sourceType: ActorDiscoverySource = 'message'): ActorAlias {
    const currentOwner = this.ownersById.get(owner.id) ?? owner;
    const normalizedValue = normalizeActorName(value);
    // Workspace record IDs only accept the SDK v0 safe alphabet. Normalized
    // aliases intentionally retain CJK and other Unicode characters for
    // matching, so encode only the persistence key and keep the searchable
    // normalized value unchanged in the record body.
    const id = `actor-alias:${owner.id}:${stableMemoryRecordKey(normalizedValue)}`;
    const timestamp = now();
    const alias: ActorAlias = {
      id,
      workspaceId: this.workspaceId,
      ownerId: owner.id,
      value: value.trim(),
      normalizedValue,
      sourceRef,
      confidence: clamp(confidence),
      status,
      createdAt: this.aliasesById.get(id)?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.aliasesById.set(id, alias);
    const ids = this.aliasIdsByNormalized.get(normalizedValue) ?? [];
    if (!ids.includes(id)) ids.push(id);
    this.aliasIdsByNormalized.set(normalizedValue, ids);
    const aliases = [...new Set([...currentOwner.aliases, value.trim()])].filter(Boolean);
    this.updateOwner(currentOwner, { aliases, discoverySources: [...new Set<ActorDiscoverySource>([...currentOwner.discoverySources, sourceType])] });
    return alias;
  }

  resolveMention(name: string): ActorResolution | undefined {
    const value = name.trim();
    if (!value) return undefined;
    const fixed = [...this.ownersById.values()].find(owner => owner.kind !== 'actor' && normalizeActorName(ownerName(owner)) === normalizeActorName(value));
    if (fixed) return { owner: structuredClone(fixed), method: 'fixed', confidence: 1, ambiguous: false };
    const normalized = normalizeActorName(value);
    const exactAliasIds = this.aliasIdsByNormalized.get(normalized) ?? [];
    const confirmedAliases = exactAliasIds
      .map(id => this.aliasesById.get(id))
      .filter((alias): alias is ActorAlias => Boolean(alias && alias.status === 'confirmed'));
    const exactOwners = [...new Set(confirmedAliases
      .map(alias => alias.ownerId))]
      .map(id => this.ownersById.get(id))
      .filter((owner): owner is MemoryOwner => Boolean(owner && owner.status === 'confirmed' && !owner.mergedIntoId));
    if (exactOwners.length === 1) return { owner: structuredClone(exactOwners[0]!), alias: confirmedAliases.find(alias => alias.ownerId === exactOwners[0]!.id), method: 'exact', confidence: 1, ambiguous: false };
    if (exactOwners.length > 1) return { owner: structuredClone(this.ownersById.get(FIXED_OWNER_IDS.unknown)!), method: 'pending', confidence: 0.4, ambiguous: true };

    // Never auto-link identities by spelling similarity. Near-identical names
    // are common in roleplay casts and an incorrect merge leaks private memory
    // across characters. Typos in model-local refs are repaired separately
    // with source evidence and a unique directory candidate.
    return undefined;
  }

  discover(input: ActorDiscoveryInput): ActorResolution {
    const preliminaryName = canonicalActorDisplayName(input.displayName);
    const preliminaryNormalized = normalizeActorName(preliminaryName);
    const preferredOwnerId = input.preferredOwnerId?.trim();
    // Validate caller-controlled persistence ids before any semantic early
    // return. An invalid id must never be silently ignored merely because the
    // accompanying display name also failed the entity boundary.
    if (preferredOwnerId) {
      if (!/^provisional:[A-Za-z0-9_.!~*'()%:-]+$/u.test(preferredOwnerId)) {
        throw Object.assign(new Error('临时人物 preferredOwnerId 格式非法。'), { code: 'ACTOR_PREFERRED_ID_INVALID' });
      }
      const occupied = this.ownersById.get(preferredOwnerId);
      if (occupied && preliminaryNormalized && normalizeActorName(ownerName(occupied)) !== preliminaryNormalized) {
        throw Object.assign(new Error('临时人物 preferredOwnerId 已被其他人物占用。'), { code: 'ACTOR_PREFERRED_ID_CONFLICT' });
      }
    }

    // Once an identity is already in the registry, a later plain mention does
    // not need to prove agency again. Resolve exact canonical/alias matches
    // before applying the stricter boundary that governs *new* identities.
    const exactKnown = preliminaryNormalized
      ? this.listOwners().filter(owner => owner.kind === 'actor'
        && !owner.mergedIntoId
        && [ownerName(owner), ...owner.aliases]
          .some(alias => normalizeActorName(alias) === preliminaryNormalized))
      : [];
    if (exactKnown.length === 1) {
      const owner = exactKnown[0]!;
      const promote = owner.status === 'pending' && input.confirmed === true;
      const updated = this.updateOwner(owner, {
        confidence: Math.max(owner.confidence, clamp(input.confidence, owner.confidence)),
        discoverySources: [...new Set([...owner.discoverySources, input.sourceType])],
        ...(promote ? { status: 'confirmed' as const } : {}),
      });
      const aliasStatus = updated.status === 'confirmed' ? 'confirmed' as const : 'pending' as const;
      this.addAlias(updated, preliminaryName, input.sourceRef, input.confidence ?? updated.confidence, aliasStatus, input.sourceType);
      for (const alias of safeActorAliases(input.aliases ?? [])) {
        this.addAlias(updated, alias, input.sourceRef, input.confidence ?? updated.confidence, aliasStatus, input.sourceType);
      }
      if (promote) {
        for (const [candidateId, candidate] of this.pending.entries()) {
          if (candidate.ownerRef === updated.id
            || normalizeActorName(candidate.displayName) === preliminaryNormalized) this.pending.delete(candidateId);
        }
      } else if (updated.status === 'pending') {
        this.upsertPendingCandidate({ ...input, displayName: preliminaryName, ownerRef: updated.id });
      }
      return {
        owner: structuredClone(updated),
        method: updated.status === 'confirmed' ? 'exact' : 'pending',
        confidence: updated.confidence,
        ambiguous: updated.status !== 'confirmed',
      };
    }

    const boundary = classifyActorName(input.displayName, {
      trust: input.sourceType === 'manual' ? 'manual' : input.confirmed === true ? 'trusted' : 'candidate',
      evidence: input.excerpt,
      aliases: input.aliases,
    });
    // A structurally valid name without agency evidence is not discarded: it
    // may be a legitimate first mention, but it can only enter the quarantine
    // as pending. Structural/protocol/generic/quantified values still fail
    // closed and never allocate an owner.
    const pendingOnly = !boundary.accepted && boundary.reason === 'non_agent_without_evidence';
    const structuralBoundary = pendingOnly
      ? classifyActorName(input.displayName, { trust: 'trusted', aliases: input.aliases })
      : boundary;
    const displayName = structuralBoundary.canonicalName;
    if (!structuralBoundary.accepted) return { owner: this.ownersById.get(FIXED_OWNER_IDS.unknown)!, method: 'unknown', confidence: 0, ambiguous: true };
    const inputAliases = safeActorAliases((input.aliases ?? []).flatMap(alias => deriveActorAliases(alias)));
    const normalizedInput = { ...input, displayName, aliases: inputAliases };
    const normalized = normalizeActorName(displayName);
    const existing = this.resolveMention(displayName);
    if (existing && existing.owner.kind !== 'actor') return existing;
    const forcePending = pendingOnly
      || input.confirmed === false
      || (input.sourceType === 'prompt' && input.confidence !== undefined && input.confidence < 0.65);
    if (existing && existing.owner.kind === 'actor' && !existing.ambiguous) {
      const owner = this.updateOwner(existing.owner, {
        confidence: Math.max(existing.owner.confidence, clamp(input.confidence, existing.confidence)),
        discoverySources: [...new Set([...existing.owner.discoverySources, input.sourceType])],
      });
      this.addAlias(owner, displayName, input.sourceRef, input.confidence ?? existing.confidence, 'confirmed', input.sourceType);
      for (const alias of inputAliases) this.addAlias(owner, alias, input.sourceRef, input.confidence ?? existing.confidence, 'confirmed', input.sourceType);
      if (input.confirmed === true) {
        for (const [candidateId, candidate] of this.pending.entries()) {
          if (candidate.ownerRef === owner.id
            || normalizeActorName(candidate.displayName) === normalizeActorName(ownerName(owner))) {
            this.pending.delete(candidateId);
          }
        }
      }
      return { ...existing, owner: structuredClone(this.ownersById.get(owner.id)!), method: existing.method };
    }

    // A later model candidate may use a shorter alias for an actor already
    // created as pending earlier in the same Capture batch. Resolve against
    // pending canonical names and aliases before allocating another owner.
    const pendingMatches = this.listOwners().filter(owner =>
      owner.kind === 'actor'
      && owner.status === 'pending'
      && !owner.mergedIntoId
      && [ownerName(owner), ...owner.aliases].some(alias => normalizeActorName(alias) === normalized));
    if (pendingMatches.length === 1) {
      const owner = pendingMatches[0]!;
      const promote = input.confirmed === true;
      const updated = this.updateOwner(owner, {
        aliases: [...new Set([...owner.aliases, displayName, ...inputAliases].map(value => value.trim()).filter(Boolean))],
        confidence: Math.max(owner.confidence, clamp(input.confidence, owner.confidence)),
        discoverySources: [...new Set([...owner.discoverySources, input.sourceType])],
        ...(promote ? { status: 'confirmed' as const } : {}),
      });
      const aliasStatus = promote ? 'confirmed' as const : 'pending' as const;
      this.addAlias(updated, displayName, input.sourceRef, input.confidence ?? updated.confidence, aliasStatus, input.sourceType);
      for (const alias of inputAliases) this.addAlias(updated, alias, input.sourceRef, input.confidence ?? updated.confidence, aliasStatus, input.sourceType);
      if (promote) {
        for (const [candidateId, candidate] of this.pending.entries()) {
          if (candidate.ownerRef === updated.id) this.pending.delete(candidateId);
        }
        return { owner: structuredClone(updated), method: 'exact', confidence: updated.confidence, ambiguous: false };
      }
      const candidate = this.upsertPendingCandidate({ ...normalizedInput, ownerRef: updated.id });
      return { owner: structuredClone(updated), method: 'pending', confidence: candidate.confidence, ambiguous: true };
    }

    const sameNormalized = this.listOwners().filter(owner => owner.kind === 'actor' && normalizeActorName(ownerName(owner)) === normalized);
    if (existing?.ambiguous || sameNormalized.length > 1) {
      const candidate = this.upsertPendingCandidate(normalizedInput);
      return { owner: structuredClone(this.ownersById.get(FIXED_OWNER_IDS.unknown)!), method: 'pending', confidence: candidate.confidence, ambiguous: true };
    }
    if (sameNormalized.length === 1) {
      const owner = sameNormalized[0]!;
      if (owner.status === 'pending' || forcePending) {
        const promote = owner.status === 'pending' && input.confirmed === true;
        const updated = this.updateOwner(owner, {
          confidence: Math.max(owner.confidence, clamp(input.confidence, owner.confidence)),
          discoverySources: [...new Set([...owner.discoverySources, input.sourceType])],
          ...(promote ? { status: 'confirmed' as const } : {}),
        });
        this.addAlias(updated, displayName, input.sourceRef, input.confidence ?? updated.confidence, updated.status === 'confirmed' ? 'confirmed' : 'pending', input.sourceType);
        for (const alias of inputAliases) this.addAlias(updated, alias, input.sourceRef, input.confidence ?? updated.confidence, updated.status === 'confirmed' ? 'confirmed' : 'pending', input.sourceType);
        if (promote) {
          for (const [candidateId, candidate] of this.pending.entries()) {
            if (candidate.ownerRef === updated.id) this.pending.delete(candidateId);
          }
          return { owner: structuredClone(updated), method: 'exact', confidence: updated.confidence, ambiguous: false };
        }
        const candidate = this.upsertPendingCandidate({ ...normalizedInput, ownerRef: updated.id });
        return { owner: structuredClone(updated), method: 'pending', confidence: candidate.confidence, ambiguous: true };
      }
    }

    const timestamp = now();
    const owner: MemoryOwner = {
      id: preferredOwnerId || actorOwnerId(this.workspaceId, normalized),
      workspaceId: this.workspaceId,
      kind: 'actor',
      displayName,
      canonicalName: displayName,
      aliases: deriveActorAliases(displayName),
      memoryTraits: structuredClone(DEFAULT_MEMORY_TRAITS),
      status: forcePending || (input.confidence !== undefined && input.confidence < 0.65) ? 'pending' : 'confirmed',
      discoverySources: [input.sourceType],
      confidence: clamp(input.confidence, forcePending ? 0.5 : 0.8),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.ownersById.set(owner.id, owner);
    this.addAlias(owner, displayName, input.sourceRef, owner.confidence, owner.status, input.sourceType);
    for (const alias of inputAliases) this.addAlias(owner, alias, input.sourceRef, owner.confidence, owner.status, input.sourceType);
    if (owner.status === 'pending') {
      this.upsertPendingCandidate({ ...normalizedInput, confidence: owner.confidence, ownerRef: owner.id });
    }
    return { owner: structuredClone(owner), method: 'created', confidence: owner.confidence, ambiguous: owner.status !== 'confirmed' };
  }

  discoverCandidate(candidate: ActorCandidate, sourceType: ActorDiscoverySource = 'prompt'): ActorResolution {
    return this.discover({
      displayName: candidate.displayName,
      aliases: [...new Set([...deriveActorAliases(candidate.displayName), ...(candidate.aliases ?? [])])],
      sourceRef: candidate.sourceRefs[0] ?? `capture:${candidate.localId}`,
      sourceType,
      excerpt: candidate.evidenceExcerpts[0],
      confidence: candidate.confidence,
      confirmed: false,
    });
  }

  confirm(candidateId: string, resolution?: ActorCandidateResolution): MemoryOwner | undefined {
    const pending = this.pending.get(candidateId);
    if (!pending) return undefined;
    const before = this.snapshot();
    const provisionalOwner = pending.ownerRef ? this.ownersById.get(pending.ownerRef) : undefined;
    let owner: MemoryOwner | undefined;
    if (resolution?.mode === 'existing') {
      owner = this.ownersById.get(resolution.ownerId);
      if (!owner || owner.kind !== 'actor' || owner.mergedIntoId) throw new Error('待确认人物的归属目标不存在。');
    } else if (resolution?.mode === 'new') {
      const canonicalName = resolution.canonicalName.trim();
      if (!canonicalName) throw new Error('新人物名称不能为空。');
      const normalizedCanonical = normalizeActorName(canonicalName);
      const duplicate = this.listOwners().some(candidate =>
        candidate.kind === 'actor'
        && !candidate.mergedIntoId
        && candidate.id !== provisionalOwner?.id
        && normalizeActorName(ownerName(candidate)) === normalizedCanonical);
      if (duplicate) throw new Error('该人物名称已存在，请改为归入已有人物。');
      if (provisionalOwner?.kind === 'actor' && provisionalOwner.status === 'pending' && normalizeActorName(ownerName(provisionalOwner)) === normalizedCanonical) {
        owner = this.updateOwner(provisionalOwner, { displayName: canonicalName, canonicalName, status: 'confirmed', confidence: Math.max(provisionalOwner.confidence, pending.confidence) });
      } else {
        const created = this.discover({
          displayName: canonicalName,
          aliases: [pending.displayName, ...(pending.aliases ?? [])],
          sourceRef: pending.sourceRefs[0] ?? `manual:${candidateId}`,
          sourceType: 'manual',
          excerpt: pending.evidenceExcerpts[0],
          confidence: Math.max(pending.confidence, 0.8),
          confirmed: true,
        });
        owner = created.owner;
      }
    } else {
      owner = pending.ownerRef ? this.ownersById.get(pending.ownerRef) : this.resolveMention(pending.displayName)?.owner;
    }
    // A low-confidence prompt candidate intentionally has no ownerRef. An
    // explicit user confirmation must be able to create its actor rather than
    // failing because there was no safe automatic owner to attach to.
    if (!owner) {
      const created = this.discover({
        displayName: pending.displayName,
        aliases: [pending.displayName, ...(pending.aliases ?? [])],
        sourceRef: pending.sourceRefs[0] ?? `manual:${candidateId}`,
        sourceType: 'manual',
        excerpt: pending.evidenceExcerpts[0],
        confidence: Math.max(pending.confidence, 0.8),
        confirmed: true,
      });
      owner = created.owner;
    }
    if (owner.kind !== 'actor') return undefined;
    const updated = this.updateOwner(owner, { status: 'confirmed', confidence: Math.max(owner.confidence, pending.confidence) });
    if (provisionalOwner?.kind === 'actor' && provisionalOwner.status === 'pending' && provisionalOwner.id !== updated.id) {
      this.updateOwner(provisionalOwner, { status: 'merged', mergedIntoId: updated.id });
    }
    const aliasValues = [...new Set([pending.displayName, ...(pending.aliases ?? []), ...(provisionalOwner?.aliases ?? [])].map(value => value.trim()).filter(Boolean))];
    for (const aliasValue of aliasValues) {
      const normalizedValue = normalizeActorName(aliasValue);
      for (const [aliasId, alias] of this.aliasesById.entries()) {
        if (alias.ownerId === updated.id || alias.normalizedValue !== normalizedValue) continue;
        const previousOwner = this.ownersById.get(alias.ownerId);
        if (previousOwner) {
          this.updateOwner(previousOwner, {
            aliases: previousOwner.aliases.filter(value => normalizeActorName(value) !== normalizedValue),
          });
        }
        this.aliasesById.delete(aliasId);
      }
      this.addAlias(
        this.ownersById.get(updated.id)!,
        aliasValue,
        pending.sourceRefs[0] ?? `manual:${candidateId}`,
        pending.confidence,
        'confirmed',
        'manual',
      );
    }
    this.rebuildAliasIndex();
    // A pending candidate's aliases are intentionally excluded from automatic
    // matching. Once the user confirms it, promote those same evidence-backed
    // aliases in the same in-memory operation so the next Capture can resolve
    // them exactly instead of falling back to fuzzy/pending state.
    for (const [aliasId, alias] of this.aliasesById.entries()) {
      if (alias.ownerId === updated.id && alias.status !== 'confirmed') {
        this.aliasesById.set(aliasId, { ...alias, status: 'confirmed', updatedAt: now() });
      }
    }
    this.rebuildAliasIndex();
    for (const [id, candidate] of this.pending.entries()) {
      if (id === candidateId
        || candidate.ownerRef === provisionalOwner?.id
        || normalizeActorName(candidate.displayName) === normalizeActorName(pending.displayName)) this.pending.delete(id);
    }
    this.recordAudit('confirm', before);
    return structuredClone(updated);
  }

  merge(fromOwnerId: string, intoOwnerId: string, sourceRef = 'manual:merge'): MemoryOwner {
    if (fromOwnerId === intoOwnerId) throw new Error('不能将主体合并到自身。');
    const from = this.ownersById.get(fromOwnerId);
    const into = this.ownersById.get(intoOwnerId);
    if (!from || !into || from.kind !== 'actor' || into.kind !== 'actor') throw new Error('只能合并卡内人物主体。');
    const before = this.snapshot();
    const merged = this.updateOwner(into, { aliases: [...new Set([...into.aliases, ...from.aliases])], discoverySources: [...new Set([...into.discoverySources, ...from.discoverySources])], confidence: Math.max(into.confidence, from.confidence) });
    this.updateOwner(from, { status: 'merged', mergedIntoId: into.id });
    const fromAliases = this.listAliases().filter(alias => alias.ownerId === from.id);
    for (const alias of fromAliases) this.aliasesById.delete(alias.id);
    this.rebuildAliasIndex();
    for (const alias of fromAliases) this.addAlias(merged, alias.value, sourceRef, from.confidence, 'confirmed', 'manual');
    for (const [candidateId, candidate] of this.pending.entries()) {
      if (candidate.ownerRef === fromOwnerId) this.pending.set(candidateId, { ...candidate, ownerRef: intoOwnerId });
    }
    this.recordAudit('merge', before);
    return structuredClone(merged);
  }

  split(ownerId: string, aliasValue: string, displayName = aliasValue, sourceRef = 'manual:split'): MemoryOwner {
    const owner = this.ownersById.get(ownerId);
    const normalizedAlias = normalizeActorName(aliasValue);
    if (!owner || owner.kind !== 'actor' || !normalizedAlias) throw new Error('只能拆分卡内人物主体的有效别名。');
    const before = this.snapshot();
    const newId = actorOwnerId(this.workspaceId, `${displayName}:${sourceRef}:${crypto.randomUUID()}`);
    const timestamp = now();
    const created: MemoryOwner = { id: newId, workspaceId: this.workspaceId, kind: 'actor', displayName: displayName.trim(), canonicalName: displayName.trim(), aliases: [displayName.trim()], memoryTraits: structuredClone(owner.memoryTraits ?? DEFAULT_MEMORY_TRAITS), status: 'confirmed', discoverySources: ['manual'], confidence: owner.confidence, createdAt: timestamp, updatedAt: timestamp };
    this.ownersById.set(newId, created);
    const updatedOriginal = this.updateOwner(owner, { aliases: owner.aliases.filter(alias => normalizeActorName(alias) !== normalizedAlias) });
    for (const [id, alias] of this.aliasesById.entries()) {
      if (alias.ownerId === ownerId && alias.normalizedValue === normalizedAlias) this.aliasesById.delete(id);
    }
    this.rebuildAliasIndex();
    this.addAlias(created, aliasValue, sourceRef, owner.confidence, 'confirmed', 'manual');
    this.ownersById.set(owner.id, updatedOriginal);
    this.recordAudit('split', before);
    return structuredClone(created);
  }

  correctAlias(aliasId: string, ownerId: string, sourceRef = 'manual:alias-correction'): ActorAlias {
    const alias = this.aliasesById.get(aliasId);
    const owner = this.ownersById.get(ownerId);
    if (!alias || !owner || owner.kind !== 'actor') throw new Error('别名纠正目标不存在。');
    const before = this.snapshot();
    const previousOwner = this.ownersById.get(alias.ownerId);
    if (previousOwner) this.updateOwner(previousOwner, { aliases: previousOwner.aliases.filter(value => normalizeActorName(value) !== alias.normalizedValue) });
    const corrected: ActorAlias = { ...alias, ownerId, sourceRef, status: 'confirmed', updatedAt: now() };
    this.aliasesById.set(aliasId, corrected);
    this.updateOwner(owner, { aliases: [...new Set([...owner.aliases, alias.value])] });
    this.rebuildAliasIndex();
    this.recordAudit('correct-alias', before);
    return structuredClone(corrected);
  }

  rename(ownerId: string, displayName: string, sourceRef = 'manual:rename'): MemoryOwner {
    const owner = this.ownersById.get(ownerId);
    if (!owner || owner.kind !== 'actor') throw new Error('只能重命名卡内人物主体。');
    const before = this.snapshot();
    const updated = this.updateOwner(owner, { displayName: displayName.trim(), canonicalName: displayName.trim(), aliases: [...new Set([...owner.aliases, displayName.trim()])] });
    this.addAlias(updated, displayName, sourceRef, updated.confidence, 'confirmed', 'manual');
    this.recordAudit('rename', before);
    return structuredClone(this.ownersById.get(ownerId)!);
  }

  updateMemoryTraits(ownerId: string, traits: MemoryTraits, sourceRef = 'manual:memory-traits'): MemoryOwner {
    const owner = this.ownersById.get(ownerId);
    if (!owner || owner.kind !== 'actor') throw new Error('只能修改卡内人物的记忆特质。');
    const before = this.snapshot();
    const normalized = Object.fromEntries(Object.entries(traits).filter(([, value]) => typeof value === 'number' && Number.isFinite(value))) as MemoryTraits;
    const current = { ...DEFAULT_MEMORY_TRAITS, ...(owner.memoryTraits ?? {}) };
    const merged: Required<MemoryTraits> = {
      halfLifeMs: Math.max(1, Number(normalized.halfLifeMs ?? current.halfLifeMs)),
      rehearsalGain: Math.max(0, Number(normalized.rehearsalGain ?? current.rehearsalGain)),
      emotionalGain: Math.max(0, Number(normalized.emotionalGain ?? current.emotionalGain)),
      interference: Math.max(0, Number(normalized.interference ?? current.interference)),
    };
    const updated = this.updateOwner(owner, { memoryTraits: merged, discoverySources: [...new Set([...owner.discoverySources, 'manual' as ActorDiscoverySource])] });
    this.recordAudit('update-traits', before);
    void sourceRef;
    return structuredClone(updated);
  }
}
