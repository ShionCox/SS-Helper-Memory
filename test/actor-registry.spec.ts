import { describe, expect, it } from 'vitest';
import { ActorRegistry } from '../src/application/actors/actor-registry';

describe('ActorRegistry correction and pending state', () => {
  it('encodes Unicode aliases into SDK-safe workspace record IDs', () => {
    const registry = new ActorRegistry('workspace:test');
    registry.discover({
      displayName: '苏九媚', sourceRef: 'message:unicode', sourceType: 'message',
      excerpt: '苏九媚开口回应了询问。', confidence: 0.95,
    });
    const alias = registry.listAliases().find(item => item.value === '苏九媚');
    expect(alias?.normalizedValue).toBe('苏九媚');
    expect(alias?.id).toMatch(/^[A-Za-z0-9_.!~*'()%:-]+$/u);
    expect(alias?.id).not.toContain('苏九媚');
  });

  it('accepts legitimate alphanumeric character names but rejects quantified inventory text', () => {
    const registry = new ActorRegistry('workspace:test');
    const twoB = registry.discover({ displayName: '2B', sourceRef: 'message:2b', sourceType: 'message', excerpt: '2B进入大厅并开始观察。', confidence: 0.95, confirmed: true });
    const r2d2 = registry.discover({ displayName: 'R2-D2', sourceRef: 'message:r2d2', sourceType: 'message', excerpt: 'R2-D2发出回应并跟随队伍。', confidence: 0.95, confirmed: true });
    const inventory = registry.discover({ displayName: '电池组x60', sourceRef: 'message:inventory', sourceType: 'message', confidence: 0.95 });

    expect(twoB.owner).toMatchObject({ kind: 'actor', canonicalName: '2B', status: 'confirmed' });
    expect(r2d2.owner).toMatchObject({ kind: 'actor', canonicalName: 'R2-D2', status: 'confirmed' });
    expect(inventory.owner.id).toBe('owner:unknown');
    expect(registry.listOwners().some(owner => owner.kind === 'actor' && owner.displayName === '电池组x60')).toBe(false);
  });

  it('allows only safe provisional preferred ids and refuses occupied-id replacement', () => {
    const registry = new ActorRegistry('workspace:test');
    expect(() => registry.discover({
      displayName: '临时人物', sourceRef: 'message:invalid-id', sourceType: 'message', confidence: 0.5,
      excerpt: '临时人物走进房间。', confirmed: false, preferredOwnerId: 'owner:world',
    })).toThrowError(expect.objectContaining({
      code: 'INVALID_PAYLOAD',
      details: expect.objectContaining({ reasonCode: 'INVALID_PAYLOAD', stage: 'memory.actor.discover' }),
    }));

    const first = registry.discover({
      displayName: '临时甲', sourceRef: 'message:first', sourceType: 'message', confidence: 0.5,
      excerpt: '临时甲走进房间。', confirmed: false, preferredOwnerId: 'provisional:scene:test:abc',
    });
    expect(first.owner.id).toBe('provisional:scene:test:abc');
    expect(() => registry.discover({
      displayName: '临时乙', sourceRef: 'message:second', sourceType: 'message', confidence: 0.5,
      excerpt: '临时乙走进房间。', confirmed: false, preferredOwnerId: 'provisional:scene:test:abc',
    })).toThrowError(expect.objectContaining({
      code: 'CONFLICT',
      details: expect.objectContaining({ reasonCode: 'WORKSPACE_CONFLICT', stage: 'memory.actor.discover' }),
    }));
    expect(registry.getOwner('provisional:scene:test:abc')?.canonicalName).toBe('临时甲');
  });

  it('folds transient status suffixes into one actor but preserves stable identity descriptors', () => {
    const registry = new ActorRegistry('workspace:test');
    const base = registry.discover({ displayName: '紫罗', sourceRef: 'message:1', sourceType: 'message', confidence: 0.98, confirmed: true }).owner;
    const sleeping = registry.discover({ displayName: '紫罗（休眠）', sourceRef: 'message:2', sourceType: 'message', confidence: 0.98, confirmed: true }).owner;
    const recovering = registry.discover({ displayName: '紫罗（恢复中）', sourceRef: 'message:3', sourceType: 'message', confidence: 0.98, confirmed: true }).owner;
    const recovered = registry.discover({ displayName: '紫罗（已恢复）', sourceRef: 'message:4', sourceType: 'message', confidence: 0.98, confirmed: true }).owner;

    expect(sleeping.id).toBe(base.id);
    expect(recovering.id).toBe(base.id);
    expect(recovered.id).toBe(base.id);
    expect(registry.listOwners().filter(owner => owner.kind === 'actor').map(owner => owner.canonicalName)).toEqual(['紫罗']);
    expect(registry.listAliases().map(alias => alias.value)).not.toEqual(expect.arrayContaining(['紫罗（休眠）', '紫罗（恢复中）', '紫罗（已恢复）']));

    const reconstructed = registry.discover({
      displayName: '白夕琴乃（重构体）',
      sourceRef: 'message:5',
      sourceType: 'message',
      confidence: 0.98,
      confirmed: true,
    }).owner;
    expect(reconstructed.canonicalName).toBe('白夕琴乃（重构体）');
    expect(reconstructed.id).not.toBe(base.id);
  });

  it('keeps low-confidence discoveries pending until explicit confirmation', () => {
    const registry = new ActorRegistry('workspace:test');
    const resolution = registry.discover({ displayName: '艾琳', sourceRef: 'message:1', sourceType: 'message', excerpt: '艾琳出现在门口。', confidence: 0.5 });
    expect(resolution.ambiguous).toBe(true);
    expect(resolution.owner).toMatchObject({ kind: 'actor', status: 'pending' });
    expect(registry.listPending()).toHaveLength(1);
    const repeated = registry.discover({ displayName: '艾琳', sourceRef: 'message:2', sourceType: 'message', excerpt: '艾琳再次被提及。', confidence: 0.55 });
    expect(repeated.method).toBe('pending');
    expect(repeated.ambiguous).toBe(true);
    expect(repeated.owner.id).toBe(resolution.owner.id);
    expect(registry.listPending()).toHaveLength(1);
    const firstCandidate = registry.listPending()[0]!;
    expect(firstCandidate.ownerRef).toBe(resolution.owner.id);
    const confirmed = registry.confirm(firstCandidate.localId);
    expect(confirmed).toMatchObject({ id: resolution.owner.id, status: 'confirmed' });
    expect(registry.resolveMention('艾琳')?.method).toBe('exact');
    expect(registry.listPending()).toEqual([]);
    expect(registry.listAudits()[0]?.operation).toBe('confirm');
  });

  it('lets a low-confidence prompt candidate create a new owner when confirmed', () => {
    const registry = new ActorRegistry('workspace:test');
    const resolution = registry.discover({ displayName: '未确认人物', sourceRef: 'prompt:1', sourceType: 'prompt', excerpt: '未确认人物敲门并开口询问情况。', confidence: 0.4 });
    const candidate = registry.listPending()[0]!;
    expect(resolution.owner).toMatchObject({ kind: 'actor', status: 'pending' });
    expect(candidate.ownerRef).toBe(resolution.owner.id);
    const confirmed = registry.confirm(candidate.localId, { mode: 'new', canonicalName: '确认人物' });
    expect(confirmed?.kind).toBe('actor');
    expect(confirmed?.displayName).toBe('确认人物');
    expect(confirmed?.id).not.toBe(resolution.owner.id);
    expect(registry.resolveMention('未确认人物')?.owner.id).toBe(confirmed?.id);
    expect(registry.listOwners().some(owner => owner.id === resolution.owner.id)).toBe(false);
    expect(registry.listPending()).toEqual([]);
  });

  it('assigns a pending candidate and its aliases to an existing actor with provenance', () => {
    const registry = new ActorRegistry('workspace:test');
    const target = registry.discover({ displayName: '艾琳', sourceRef: 'message:owner', sourceType: 'message', confidence: 0.95, confirmed: true }).owner;
    registry.discover({ displayName: '店长', aliases: ['老板娘'], sourceRef: 'message:alias', sourceType: 'message', excerpt: '店长把钥匙交给了老板娘。', confidence: 0.5 });
    const candidate = registry.listPending()[0]!;

    const confirmed = registry.confirm(candidate.localId, { mode: 'existing', ownerId: target.id });

    expect(confirmed?.id).toBe(target.id);
    expect(registry.resolveMention('店长')?.owner.id).toBe(target.id);
    expect(registry.resolveMention('老板娘')?.owner.id).toBe(target.id);
    expect(registry.listAliases()).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerId: target.id, value: '店长', sourceRef: 'message:alias', status: 'confirmed' }),
      expect.objectContaining({ ownerId: target.id, value: '老板娘', sourceRef: 'message:alias', status: 'confirmed' }),
    ]));
  });

  it('rejects invalid candidate destinations and empty new-person names', () => {
    const registry = new ActorRegistry('workspace:test');
    registry.discover({
      displayName: '临时访客', sourceRef: 'message:generic', sourceType: 'message',
      excerpt: '临时访客走进大厅并主动报告情况。', confidence: 0.5,
    });
    const candidate = registry.listPending()[0]!;

    expect(() => registry.confirm(candidate.localId, { mode: 'existing', ownerId: 'owner:world' })).toThrow('归属目标不存在');
    expect(() => registry.confirm(candidate.localId, { mode: 'new', canonicalName: '   ' })).toThrow('名称不能为空');
    expect(registry.listPending()).toHaveLength(1);
  });

  it('moves aliases during split and correction instead of leaving duplicate owners', () => {
    const registry = new ActorRegistry('workspace:test');
    const original = registry.discover({ displayName: 'A', sourceRef: 'message:a', sourceType: 'message', confidence: 0.95, confirmed: true }).owner;
    const split = registry.split(original.id, 'A', 'A-分身');
    expect(registry.resolveMention('A')?.owner.id).toBe(split.id);
    const target = registry.discover({ displayName: 'B', sourceRef: 'message:b', sourceType: 'message', confidence: 0.95, confirmed: true }).owner;
    const alias = registry.listAliases().find(item => item.ownerId === split.id && item.value === 'A');
    expect(alias).toBeDefined();
    registry.correctAlias(alias!.id, target.id);
    expect(registry.resolveMention('A')?.owner.id).toBe(target.id);
    expect(registry.getOwner(split.id)?.aliases).not.toContain('A');
  });

  it('isolates same-name conflicts instead of choosing the first confirmed owner', () => {
    const registry = new ActorRegistry('workspace:test');
    const first = registry.discover({ displayName: '甲', sourceRef: 'message:a', sourceType: 'message', confidence: 0.95, confirmed: true }).owner;
    const second = registry.discover({ displayName: '乙', sourceRef: 'message:b', sourceType: 'message', confidence: 0.95, confirmed: true }).owner;
    registry.rename(second.id, '甲');
    const resolution = registry.resolveMention('甲');
    expect(resolution?.ambiguous).toBe(true);
    expect(resolution?.owner.id).toBe('owner:unknown');
    expect(first.id).not.toBe(second.id);
  });

  it('drops generic mentions without creating a confirmed actor or audit candidate', () => {
    const registry = new ActorRegistry('workspace:test');
    const resolution = registry.discover({ displayName: '某人', sourceRef: 'message:generic', sourceType: 'message', excerpt: '某人站在门口。', confidence: 0.95 });
    expect(resolution.owner.id).toBe('owner:unknown');
    expect(resolution.ambiguous).toBe(true);
    expect(registry.listOwners().some(owner => owner.kind === 'actor' && owner.displayName === '某人')).toBe(false);
    expect(registry.listPending()).toEqual([]);
  });

  it('replaces stale dynamic identities and correction audits during persistence hydration', () => {
    const registry = new ActorRegistry('workspace:test');
    const stale = registry.discover({ displayName: '旧人物', sourceRef: 'message:old', sourceType: 'message', confidence: 0.95, confirmed: true }).owner;
    registry.discover({
      displayName: '未确认访客', sourceRef: 'message:pending', sourceType: 'message',
      excerpt: '未确认访客走进房间并开口询问。', confidence: 0.5,
    });
    const pending = registry.listPending()[0]!;
    registry.confirm(pending.localId, { mode: 'new', canonicalName: '临时确认人物' });
    expect(registry.listAudits()).not.toHaveLength(0);

    const persisted = new ActorRegistry('workspace:test');
    const kept = persisted.discover({ displayName: '持久人物', sourceRef: 'message:new', sourceType: 'message', confidence: 0.95, confirmed: true }).owner;
    registry.hydrate(persisted.listOwners(), persisted.listAliases());
    registry.hydratePending([]);
    registry.hydrateAudits([]);

    expect(registry.getOwner(stale.id)).toBeUndefined();
    expect(registry.getOwner(kept.id)?.canonicalName).toBe('持久人物');
    expect(registry.resolveMention('旧人物')).toBeUndefined();
    expect(registry.listPending()).toEqual([]);
    expect(registry.listAudits()).toEqual([]);
  });
});
