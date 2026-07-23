import { describe, expect, it } from 'vitest';
import { ActorRegistry } from '../src/application/actors/actor-registry';

describe('ActorRegistry correction and pending state', () => {
  it('encodes Unicode aliases into SDK-safe workspace record IDs', () => {
    const registry = new ActorRegistry('workspace:test');
    registry.discover({ displayName: '苏九媚', sourceRef: 'message:unicode', sourceType: 'message', confidence: 0.95 });
    const alias = registry.listAliases().find(item => item.value === '苏九媚');
    expect(alias?.normalizedValue).toBe('苏九媚');
    expect(alias?.id).toMatch(/^[A-Za-z0-9_.!~*'()%:-]+$/u);
    expect(alias?.id).toContain(encodeURIComponent('苏九媚'));
  });

  it('keeps low-confidence discoveries pending until explicit confirmation', () => {
    const registry = new ActorRegistry('workspace:test');
    const resolution = registry.discover({ displayName: '艾琳', sourceRef: 'message:1', sourceType: 'message', excerpt: '艾琳出现在门口。', confidence: 0.5 });
    expect(resolution.ambiguous).toBe(true);
    expect(registry.listPending()).toHaveLength(1);
    const repeated = registry.discover({ displayName: '艾琳', sourceRef: 'message:2', sourceType: 'message', excerpt: '艾琳再次被提及。', confidence: 0.55 });
    expect(repeated.method).toBe('pending');
    expect(repeated.ambiguous).toBe(true);
    const firstCandidate = registry.listPending()[0]!;
    expect(registry.confirm(firstCandidate.localId)?.status).toBe('confirmed');
    expect(registry.resolveMention('艾琳')?.method).toBe('exact');
    expect(registry.listPending()).toHaveLength(1);
    expect(registry.confirm(registry.listPending()[0]!.localId)?.status).toBe('confirmed');
    expect(registry.listPending()).toEqual([]);
    expect(registry.listAudits()[0]?.operation).toBe('confirm');
  });

  it('lets a low-confidence prompt candidate create a new owner when confirmed', () => {
    const registry = new ActorRegistry('workspace:test');
    const resolution = registry.discover({ displayName: '未确认人物', sourceRef: 'prompt:1', sourceType: 'prompt', excerpt: '未确认人物可能在门外。', confidence: 0.4 });
    const candidate = registry.listPending()[0]!;
    expect(resolution.owner.id).toBe('owner:unknown');
    const confirmed = registry.confirm(candidate.localId, { mode: 'new', canonicalName: '确认人物' });
    expect(confirmed?.kind).toBe('actor');
    expect(confirmed?.displayName).toBe('确认人物');
    expect(registry.resolveMention('未确认人物')?.owner.id).toBe(confirmed?.id);
    expect(registry.listPending()).toEqual([]);
  });

  it('assigns a pending candidate and its aliases to an existing actor with provenance', () => {
    const registry = new ActorRegistry('workspace:test');
    const target = registry.discover({ displayName: '艾琳', sourceRef: 'message:owner', sourceType: 'message', confidence: 0.95 }).owner;
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
    registry.discover({ displayName: '某人', sourceRef: 'message:generic', sourceType: 'message', confidence: 0.8 });
    const candidate = registry.listPending()[0]!;

    expect(() => registry.confirm(candidate.localId, { mode: 'existing', ownerId: 'owner:world' })).toThrow('归属目标不存在');
    expect(() => registry.confirm(candidate.localId, { mode: 'new', canonicalName: '   ' })).toThrow('名称不能为空');
    expect(registry.listPending()).toHaveLength(1);
  });

  it('moves aliases during split and correction instead of leaving duplicate owners', () => {
    const registry = new ActorRegistry('workspace:test');
    const original = registry.discover({ displayName: 'A', sourceRef: 'message:a', sourceType: 'message', confidence: 0.95 }).owner;
    const split = registry.split(original.id, 'A', 'A-分身');
    expect(registry.resolveMention('A')?.owner.id).toBe(split.id);
    const target = registry.discover({ displayName: 'B', sourceRef: 'message:b', sourceType: 'message', confidence: 0.95 }).owner;
    const alias = registry.listAliases().find(item => item.ownerId === split.id && item.value === 'A');
    expect(alias).toBeDefined();
    registry.correctAlias(alias!.id, target.id);
    expect(registry.resolveMention('A')?.owner.id).toBe(target.id);
    expect(registry.getOwner(split.id)?.aliases).not.toContain('A');
  });

  it('isolates same-name conflicts instead of choosing the first confirmed owner', () => {
    const registry = new ActorRegistry('workspace:test');
    const first = registry.discover({ displayName: '甲', sourceRef: 'message:a', sourceType: 'message', confidence: 0.95 }).owner;
    const second = registry.discover({ displayName: '乙', sourceRef: 'message:b', sourceType: 'message', confidence: 0.95 }).owner;
    registry.rename(second.id, '甲');
    const resolution = registry.resolveMention('甲');
    expect(resolution?.ambiguous).toBe(true);
    expect(resolution?.owner.id).toBe('owner:unknown');
    expect(first.id).not.toBe(second.id);
  });

  it('keeps generic mentions in unknown/pending instead of creating a confirmed actor', () => {
    const registry = new ActorRegistry('workspace:test');
    const resolution = registry.discover({ displayName: '某人', sourceRef: 'message:generic', sourceType: 'message', excerpt: '某人站在门口。', confidence: 0.95 });
    expect(resolution.owner.id).toBe('owner:unknown');
    expect(resolution.ambiguous).toBe(true);
    expect(registry.listOwners().some(owner => owner.kind === 'actor' && owner.displayName === '某人')).toBe(false);
    expect(registry.listPending()).toHaveLength(1);
  });
});
