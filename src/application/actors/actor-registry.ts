import {
  actorOwnerId,
  DEFAULT_MEMORY_TRAITS,
  FIXED_OWNER_IDS,
  normalizeActorName,
  type ActorAlias,
  type ActorCandidate,
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
}

export interface ActorResolution {
  readonly owner: MemoryOwner;
  readonly alias?: ActorAlias;
  readonly method: 'fixed' | 'exact' | 'normalized' | 'fuzzy' | 'created' | 'pending' | 'unknown';
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

function editDistance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const previous = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = previous;
    }
  }
  return row[right.length]!;
}

function similarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const distance = editDistance(left, right);
  return 1 - distance / Math.max(left.length, right.length);
}

function ownerName(owner: MemoryOwner): string { return owner.canonicalName ?? owner.displayName; }

const GENERIC_ACTOR_NAMES = new Set([
  '某人', '有人', '这个人', '那个人', '一名男子', '一名女子', '男子', '女子',
  '他', '她', '他们', '她们', '它', '它们', '角色', '人物', '路人', '陌生人',
  'assistant', 'user', 'system', 'narrator', 'ai', 'character', 'character card', '角色卡',
].map(normalizeActorName));

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
    for (const audit of audits) this.audits.set(audit.id, structuredClone(audit));
  }

  clearAudits(): void { this.audits.clear(); }

  private addAlias(owner: MemoryOwner, value: string, sourceRef: string, confidence: number, status: ActorAlias['status'] = 'confirmed', sourceType: ActorDiscoverySource = 'message'): ActorAlias {
    const normalizedValue = normalizeActorName(value);
    const id = `actor-alias:${owner.id}:${normalizedValue}`;
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
    const aliases = [...new Set([...owner.aliases, value.trim()])].filter(Boolean);
    this.updateOwner(owner, { aliases, discoverySources: [...new Set<ActorDiscoverySource>([...owner.discoverySources, sourceType])] });
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

    const candidates = this.listOwners().filter(owner => owner.kind === 'actor' && owner.status === 'confirmed').map(owner => ({ owner, score: similarity(normalized, normalizeActorName(ownerName(owner))) })).filter(item => item.score >= 0.82).sort((left, right) => right.score - left.score || left.owner.id.localeCompare(right.owner.id));
    if (candidates.length === 1) return { owner: candidates[0]!.owner, method: 'fuzzy', confidence: candidates[0]!.score, ambiguous: false };
    if (candidates.length > 1 && candidates[0]!.score - candidates[1]!.score >= 0.08) return { owner: candidates[0]!.owner, method: 'fuzzy', confidence: candidates[0]!.score, ambiguous: false };
    if (candidates.length > 1) return { owner: structuredClone(this.ownersById.get(FIXED_OWNER_IDS.unknown)!), method: 'pending', confidence: candidates[0]!.score, ambiguous: true };
    return undefined;
  }

  discover(input: ActorDiscoveryInput): ActorResolution {
    const displayName = input.displayName.trim();
    if (!displayName) return { owner: this.ownersById.get(FIXED_OWNER_IDS.unknown)!, method: 'unknown', confidence: 0, ambiguous: true };
    const existing = this.resolveMention(displayName);
    if (existing && existing.owner.kind !== 'actor') return existing;
    const normalized = normalizeActorName(displayName);
    if (GENERIC_ACTOR_NAMES.has(normalized) && input.sourceType !== 'manual') {
      const candidate: ActorCandidate = {
        localId: `candidate:${crypto.randomUUID()}`,
        displayName,
        aliases: [...(input.aliases ?? [])],
        sourceRefs: [input.sourceRef],
        evidenceExcerpts: input.excerpt ? [input.excerpt] : [],
        confidence: clamp(input.confidence, 0.35),
        status: 'pending',
      };
      this.pending.set(candidate.localId, candidate);
      return { owner: structuredClone(this.ownersById.get(FIXED_OWNER_IDS.unknown)!), method: 'pending', confidence: candidate.confidence, ambiguous: true };
    }
    const forcePending = input.confirmed === false || (input.sourceType === 'prompt' && input.confidence !== undefined && input.confidence < 0.65);
    if (existing && !existing.ambiguous && !forcePending) {
      const owner = this.updateOwner(existing.owner, {
        confidence: Math.max(existing.owner.confidence, clamp(input.confidence, existing.confidence)),
        discoverySources: [...new Set([...existing.owner.discoverySources, input.sourceType])],
      });
      this.addAlias(owner, displayName, input.sourceRef, input.confidence ?? existing.confidence, 'confirmed', input.sourceType);
      for (const alias of input.aliases ?? []) this.addAlias(owner, alias, input.sourceRef, input.confidence ?? existing.confidence, 'confirmed', input.sourceType);
      return { ...existing, owner: structuredClone(this.ownersById.get(owner.id)!), method: existing.method };
    }

    const sameNormalized = this.listOwners().filter(owner => owner.kind === 'actor' && normalizeActorName(ownerName(owner)) === normalized);
    if (sameNormalized.length > 0 || existing?.ambiguous || forcePending) {
      const owner = forcePending || Boolean(existing?.ambiguous) || sameNormalized.length > 1
        ? this.ownersById.get(FIXED_OWNER_IDS.unknown)!
        : sameNormalized[0] ?? this.ownersById.get(FIXED_OWNER_IDS.unknown)!;
      const candidate: ActorCandidate = {
        // Pending rows can survive a chat switch and multiple captures. A
        // counter based on the current map size would reuse an id after a
        // confirmation; use an immutable local id instead.
        localId: `candidate:${crypto.randomUUID()}`,
        displayName,
        aliases: [...(input.aliases ?? [])],
        sourceRefs: [input.sourceRef],
        evidenceExcerpts: input.excerpt ? [input.excerpt] : [],
        confidence: clamp(input.confidence, 0.45),
        status: 'pending',
        ...(!forcePending && owner.kind === 'actor' ? { ownerRef: owner.id } : {}),
      };
      this.pending.set(candidate.localId, candidate);
      return { owner: structuredClone(owner), method: 'pending', confidence: candidate.confidence, ambiguous: true };
    }

    const timestamp = now();
    const owner: MemoryOwner = {
      id: actorOwnerId(this.workspaceId, normalized),
      workspaceId: this.workspaceId,
      kind: 'actor',
      displayName,
      canonicalName: displayName,
      aliases: [displayName],
      memoryTraits: structuredClone(DEFAULT_MEMORY_TRAITS),
      status: forcePending || (input.confidence !== undefined && input.confidence < 0.65) ? 'pending' : 'confirmed',
      discoverySources: [input.sourceType],
      confidence: clamp(input.confidence, forcePending ? 0.5 : 0.8),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.ownersById.set(owner.id, owner);
    this.addAlias(owner, displayName, input.sourceRef, owner.confidence, owner.status, input.sourceType);
    for (const alias of input.aliases ?? []) this.addAlias(owner, alias, input.sourceRef, owner.confidence, owner.status, input.sourceType);
    if (owner.status === 'pending') {
      this.pending.set(`candidate:${owner.id}`, {
        localId: `candidate:${owner.id}`,
        displayName,
        aliases: [...(input.aliases ?? [])],
        sourceRefs: [input.sourceRef],
        evidenceExcerpts: input.excerpt ? [input.excerpt] : [],
        confidence: owner.confidence,
        status: 'pending',
        ownerRef: owner.id,
      });
    }
    return { owner: structuredClone(owner), method: 'created', confidence: owner.confidence, ambiguous: owner.status !== 'confirmed' };
  }

  discoverCandidate(candidate: ActorCandidate, sourceType: ActorDiscoverySource = 'prompt'): ActorResolution {
    return this.discover({
      displayName: candidate.displayName,
      aliases: candidate.aliases,
      sourceRef: candidate.sourceRefs[0] ?? `capture:${candidate.localId}`,
      sourceType,
      excerpt: candidate.evidenceExcerpts[0],
      confidence: candidate.confidence,
      confirmed: candidate.status === 'confirmed',
    });
  }

  confirm(candidateId: string, canonicalName?: string): MemoryOwner | undefined {
    const pending = this.pending.get(candidateId);
    if (!pending) return undefined;
    const before = this.snapshot();
    let owner = pending.ownerRef ? this.ownersById.get(pending.ownerRef) : this.resolveMention(pending.displayName)?.owner;
    // A low-confidence prompt candidate intentionally has no ownerRef. An
    // explicit user confirmation must be able to create its actor rather than
    // failing because there was no safe automatic owner to attach to.
    if (!owner) {
      const displayName = canonicalName?.trim() || pending.displayName;
      const created = this.discover({
        displayName,
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
    const updated = this.updateOwner(owner, { status: 'confirmed', ...(canonicalName ? { displayName: canonicalName, canonicalName } : {}), confidence: Math.max(owner.confidence, pending.confidence) });
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
    this.pending.delete(candidateId);
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
