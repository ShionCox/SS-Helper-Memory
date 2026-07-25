import { describe, expect, it } from 'vitest';
import { classifyActorName, classifyLocationName } from '../src/domain';
import { LocationRegistry } from '../src/application/locations';

describe('generic entity boundaries', () => {
  it('accepts arbitrary future character names only when trust or agency evidence supports them', () => {
    expect(classifyActorName('灯塔', { trust: 'trusted' }).accepted).toBe(true);
    expect(classifyActorName('灯塔', { evidence: '灯塔开口回答了守卫的问题。' }).accepted).toBe(true);
    expect(classifyActorName('灯塔', { evidence: '灯塔顶部安装了新的照明设备。' })).toMatchObject({
      accepted: false,
      reason: 'non_agent_without_evidence',
    });

    expect(classifyActorName('K-7', { evidence: 'K-7 entered the chamber and replied to the captain.' }).accepted).toBe(true);
    expect(classifyActorName('2B', { trust: 'trusted' }).accepted).toBe(true);
  });

  it('does not mistake operational objects for actors from one weak verb', () => {
    expect(classifyActorName('电池组', { evidence: '电池组启动后保持稳定。' })).toMatchObject({
      accepted: false,
      reason: 'non_agent_without_evidence',
    });
    expect(classifyActorName('自动门', { evidence: '自动门关闭后锁定。' }).accepted).toBe(false);
    expect(classifyActorName('侦察单元K-7', {
      evidence: '侦察单元K-7主动进入舱室，随后向队长报告情况。',
    }).accepted).toBe(true);
  });

  it('rejects protocol labels, generic references and quantified inventory regardless of story data', () => {
    expect(classifyActorName('assistant', { trust: 'trusted' }).accepted).toBe(false);
    expect(classifyActorName('某人', { trust: 'trusted' }).accepted).toBe(false);
    expect(classifyActorName('补给箱x24', { evidence: '补给箱x24放在仓库里。' })).toMatchObject({
      accepted: false,
      reason: 'quantified_value',
    });
    expect(classifyActorName('心情状态：警觉', { trust: 'trusted' }).accepted).toBe(false);
  });

  it('accepts novel locations through explicit relation or general place morphology', () => {
    expect(classifyLocationName('晨星号主控舱', { evidence: '队员进入晨星号主控舱并关闭舱门。' }).accepted).toBe(true);
    expect(classifyLocationName('North Harbor', { evidence: 'The convoy arrived at North Harbor before dawn.' }).accepted).toBe(true);
    expect(classifyLocationName('第七码头', { evidence: '第七码头的入口已经封锁。' }).accepted).toBe(true);
    expect(classifyLocationName('未知核心', { evidence: '未知核心持续发出蓝光。' })).toMatchObject({
      accepted: false,
      reason: 'generic_location',
    });
  });

  it('replaces rather than accumulates the persisted location directory during hydration', () => {
    const registry = new LocationRegistry('workspace:test');
    const first = registry.discover({
      displayName: '北门', sourceRef: 'state:1', confirmed: true, confidence: 1,
    }).location;
    registry.hydrate([first], registry.listAliases());
    expect(registry.resolveMention('北门')?.location.id).toBe(first.id);

    registry.hydrate([], []);
    expect(registry.resolveMention('北门')).toBeUndefined();
    expect(registry.listLocations()).toEqual([]);
    expect(registry.listAliases()).toEqual([]);
  });
});
