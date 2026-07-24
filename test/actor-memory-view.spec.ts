// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ActorMemoryTrace, MemoryObservation, MemoryOwner } from '../src/domain';
import {
  actorMemoryLevel,
  buildActorMemoryGaugePreview,
  renderActorMemoryPage,
  selectActorMemoryView,
  updateActorMemoryGaugeZone,
  type ActorMemoryFact,
  type ActorMemoryViewState,
} from '../src/ui/actor-memory-view';

const now = Date.UTC(2026, 6, 24, 6, 30, 0);

const owners: MemoryOwner[] = [{
  id: 'owner:su', workspaceId: 'workspace:1', kind: 'actor', displayName: '苏九媚', canonicalName: '苏九媚', aliases: ['九媚'],
  status: 'confirmed', discoverySources: ['message'], confidence: .98, createdAt: now - 10_000, updatedAt: now,
}, {
  id: 'owner:world', workspaceId: 'workspace:1', kind: 'world', displayName: '世界', aliases: [],
  status: 'confirmed', discoverySources: ['system'], confidence: 1, createdAt: now - 10_000, updatedAt: now,
}];

const facts: ActorMemoryFact[] = [{
  id: 'fact:station',
  content: '加油站有三台加油机，其中一台被汽车残骸压垮，另外两台覆盖紫色苔藓。',
  sourceRefs: ['message:88'],
  evidence: [{ sourceRef: 'message:88', excerpt: '三台加油机里有一台已经被翻倒的汽车压垮。' }],
  updatedAt: now,
}];

const trace: ActorMemoryTrace = {
  id: 'trace:su:station', workspaceId: 'workspace:1', chatKey: 'chat:1', ownerId: 'owner:su', factId: 'fact:station',
  sourceObservationIds: ['observation:88'], knowledgeMode: 'experienced', privacy: 'public',
  strength: 90, clarity: 100, beliefConfidence: .94, emotionalSalience: .4, rehearsalCount: 0, traceRevision: 2,
  floor: 88, createdAt: now - 5_000, updatedAt: now,
};

const observation: MemoryObservation = {
  id: 'observation:88', workspaceId: 'workspace:1', episodeId: 'episode:station', sourceRef: 'message:88',
  speakerOwnerId: 'owner:su', viewpointOwnerId: 'owner:su', observerOwnerIds: ['owner:su'], channel: 'public_speech',
  privacy: 'public', knowledgeMode: 'experienced', excerpt: '三台加油机里有一台已经被翻倒的汽车压垮。',
  mentionedOwnerIds: [], presentOwnerIds: ['owner:su'], factLocalIds: ['fact:station'], occurredAt: now - 2_000, createdAt: now - 2_000,
};

function state(overrides: Partial<ActorMemoryViewState> = {}): ActorMemoryViewState {
  return {
    actors: owners,
    traces: [trace],
    facts,
    observations: [observation],
    query: '', knowledgeMode: '', privacy: '', level: '', sort: 'updated_desc',
    selectedOwnerId: 'owner:su', selectedTraceId: 'trace:su:station', tab: 'overview', collapsedGroups: [], now,
    ...overrides,
  };
}

describe('角色记忆视图', () => {
  it('按真实人物、事实和观察记录构建选择结果', () => {
    const selection = selectActorMemoryView(state());
    expect(selection.selectedOwner?.displayName).toBe('苏九媚');
    expect(selection.selectedFact?.content).toContain('三台加油机');
    expect(selection.selectedObservations.map(item => item.id)).toEqual(['observation:88']);
    expect(selection.metrics).toMatchObject({ traces: 1, owners: 1, privateCount: 0 });
    expect(selection.effectiveStrengths.get(trace.id)).toBeCloseTo(95.4, 4);
    expect(actorMemoryLevel(selection.effectiveStrengths.get(trace.id) ?? 0)).toBe('exact');
  });

  it('使用生产召回包规则生成各强度阶段预览', () => {
    expect(buildActorMemoryGaugePreview(trace, facts[0]!, 0)).toBeNull();
    const fragment = buildActorMemoryGaugePreview(trace, facts[0]!, 35)!;
    expect(fragment.gist).toMatch(/模糊记忆|不清晰/u);
    expect(fragment.details).toHaveLength(1);
    expect(fragment.details[0]?.sensitivity).toBe('gist');
    expect(fragment.omittedDetailCount).toBe(1);

    const gist = buildActorMemoryGaugePreview(trace, facts[0]!, 55)!;
    expect(gist.gist).toContain('加油站有三台加油机');
    expect(gist.details.map(item => item.sensitivity)).toEqual(['gist']);

    const exact = buildActorMemoryGaugePreview(trace, facts[0]!, 92)!;
    expect(exact.details.map(item => item.sensitivity)).toEqual(['gist', 'exact']);
    expect(exact.details[1]?.text).toBe(facts[0]?.content);
    expect(exact.omittedDetailCount).toBe(0);
  });

  it('渲染 V6 三栏页面、折叠分组和统一关联入口，并允许进度条提示实时更新', () => {
    const html = renderActorMemoryPage(state(), {
      formatTime: value => String(value),
      renderSourceReference: value => `<button data-source-ref="${value}">聊天消息 #88</button>`,
    });
    const host = document.createElement('div');
    host.innerHTML = html;
    expect(host.querySelector('.stx-memory-actor-memory-owner-panel')?.textContent).toContain('苏九媚');
    expect(host.querySelector('[data-action="actor-memory-toggle-group"][data-group="people"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('.stx-memory-actor-memory-trace-panel')?.textContent).toContain('三台加油机');
    expect(host.querySelectorAll('[data-actor-memory-zone]')).toHaveLength(5);
    expect(host.querySelector('[data-action="actor-memory-open-fact"]')).not.toBeNull();
    expect(host.querySelector('[data-action="actor-memory-open-owner"]')).not.toBeNull();
    expect(host.querySelector('.stx-memory-actor-memory-detail-actions')?.textContent).toContain('记忆块');
    expect(host.querySelector('.stx-memory-actor-memory-detail-actions')?.textContent).toContain('人物主档');

    const collapsedHost = document.createElement('div');
    collapsedHost.innerHTML = renderActorMemoryPage(state({ collapsedGroups: ['people'] }), {
      formatTime: value => String(value),
      renderSourceReference: value => `<button data-source-ref="${value}">聊天消息 #88</button>`,
    });
    expect(collapsedHost.querySelector('[data-group="people"]')?.getAttribute('aria-expanded')).toBe('false');
    expect(collapsedHost.querySelector('#stx-memory-owner-group-people')?.hasAttribute('hidden')).toBe(true);

    const zone = host.querySelector<HTMLElement>('[data-actor-memory-zone="exact"]')!;
    updateActorMemoryGaugeZone(zone, trace, facts[0]!, 92);
    expect(zone.querySelector('[data-actor-memory-preview-strength]')?.textContent).toBe('92');
    expect(zone.querySelector('[data-actor-memory-preview-details]')?.textContent).toContain('完整细节');
    expect(zone.querySelector('[data-actor-memory-preview-omitted]')?.textContent).toBe('0 项');
  });

  it('按隐私、知情方式和记忆层级筛选认知痕迹', () => {
    expect(selectActorMemoryView(state({ privacy: 'private' })).visibleTraces).toHaveLength(0);
    expect(selectActorMemoryView(state({ knowledgeMode: 'heard' })).visibleTraces).toHaveLength(0);
    expect(selectActorMemoryView(state({ level: 'exact' })).visibleTraces).toHaveLength(1);
    expect(selectActorMemoryView(state({ level: 'clear' })).visibleTraces).toHaveLength(0);
  });
});
