import { describe, expect, it, vi } from 'vitest';
import { planRecallIntent, planRecallIntentByRules } from '../src/application/recall';
import type { GenerationCastPlan } from '../src/domain';

const A = 'owner:actor:a';
const B = 'owner:actor:b';
const C = 'owner:actor:c';

function castPlan(): GenerationCastPlan {
  return {
    id: 'plan', workspaceId: 'workspace', chatKey: 'chat', sceneId: 'scene', basedOnFloor: 10,
    mode: 'multi_actor', viewpointOwnerId: A, requiredOwnerIds: [A], likelyOwnerIds: [B, C],
    backgroundOwnerIds: ['owner:actor:background'], mentionedOnlyOwnerIds: [], excludedOwnerIds: [],
    permissionByOwner: { [A]: 'full', [B]: 'public_only', [C]: 'public_only' }, plannerMode: 'deterministic',
    confidence: 1, evidence: [], newActorProposals: [], createdAt: 1,
  };
}

const knownOwners = [
  { ownerId: A, names: ['小時', '小时'] },
  { ownerId: B, names: ['紫罗'] },
  { ownerId: C, names: ['白夕莲'] },
];

describe('recall intent planner', () => {
  it('routes an explicit memory definition to fixed knowledge partitions and extracts the topic', () => {
    const plan = planRecallIntentByRules('请根据当前记忆，用一句话说明晶尘是什么。', {
      castPlan: castPlan(), knownOwners,
      recentConversation: [{ role: 'assistant', content: '晶尘是一种紫色污染物。' }],
    });
    expect(plan.intentKind).toBe('world_knowledge');
    expect(plan.topicTerms).toContain('晶尘');
    expect(plan.recentContextSatisfied).toBe(false);
    expect(plan.ownerScope.ownerIds).toEqual(['owner:world', 'owner:narrator']);
    expect(plan.ownerScope.fallback).toBe('none');
  });

  it('skips long-term recall for a pure restatement already covered by the latest answer', () => {
    const plan = planRecallIntentByRules('请用一句话概括刚才的回答。', {
      castPlan: castPlan(), knownOwners,
      recentConversation: [{ role: 'assistant', content: '这里是刚才的完整回答。' }],
    });
    expect(plan.intentKind).toBe('recent_context');
    expect(plan.ownerScope.ownerIds).toEqual([]);
    expect(plan.subQueries).toEqual([]);
  });

  it('does not skip continuity questions that explicitly request current memory', () => {
    const plan = planRecallIntentByRules('根据你刚才的结论和当前记忆，如果只保留一个最关键的防护原则，会是什么？不要引入新角色。', {
      castPlan: castPlan(), knownOwners,
      recentConversation: [{ role: 'assistant', content: '物理隔离是最关键的防护原则。' }],
    });
    expect(plan.recentContextSatisfied).toBe(false);
    expect(plan.intentKind).toBe('world_knowledge');
    expect(plan.ownerScope.ownerIds).toEqual(['owner:world', 'owner:narrator']);
    expect(plan.subQueries).not.toEqual([]);
  });

  it('retrieves only explicitly named owners for actor knowledge and relationships', () => {
    const knowledge = planRecallIntentByRules('小時记得晶尘的来源吗？', { castPlan: castPlan(), knownOwners });
    expect(knowledge.intentKind).toBe('actor_knowledge');
    expect(knowledge.ownerScope.ownerIds).toEqual([A]);
    const relationship = planRecallIntentByRules('紫罗和白夕莲是什么关系？', { castPlan: castPlan(), knownOwners });
    expect(relationship.intentKind).toBe('relationship');
    expect(relationship.ownerScope.ownerIds).toEqual([B, C]);
  });

  it('uses cast required and likely owners for scene actions but never background actors', () => {
    const plan = planRecallIntentByRules('下一步应该如何安排行动？', { castPlan: castPlan(), knownOwners });
    expect(plan.intentKind).toBe('scene_action');
    expect(plan.ownerScope.ownerIds).toEqual([A, B, C]);
    expect(plan.ownerScope.ownerIds).not.toContain('owner:actor:background');
  });

  it('keeps the viewpoint in a scene-action scope even when another actor is the only required speaker', () => {
    const plan = planRecallIntentByRules('接下来如何处理眼前的情况？', {
      castPlan: {
        ...castPlan(),
        requiredOwnerIds: [B],
        likelyOwnerIds: [],
        permissionByOwner: { [A]: 'full', [B]: 'full' },
      },
      knownOwners,
    });
    expect(plan.intentKind).toBe('scene_action');
    expect(plan.ownerScope.ownerIds).toEqual([A, B]);
    expect(plan.ownerScope.requiredOwnerIds).toEqual([A, B]);
  });

  it('keeps a narrow multi-actor relationship rule plan without letting the LLM broaden it', async () => {
    const llm = { plan: vi.fn(async () => ({ intentKind: 'relationship' as const, namedOwnerIds: [A, 'owner:invalid'], topicTerms: ['事故'] })) };
    const plan = await planRecallIntent('小時为什么害怕事故，紫罗是否知道原因？', llm, { castPlan: castPlan(), knownOwners });
    expect(llm.plan).not.toHaveBeenCalled();
    expect(plan.namedOwnerIds).toEqual([A, B]);
    expect(plan.ownerScope.ownerIds).toEqual([A, B]);
    expect(plan.source).toBe('rules');
  });

  it('calls the LLM at most once only when a complex rule result remains general', async () => {
    const llm = { plan: vi.fn(async () => ({ intentKind: 'actor_knowledge' as const, namedOwnerIds: [A, 'owner:invalid'], topicTerms: ['事故'] })) };
    const plan = await planRecallIntent('请分析甲乙两个方面？再综合给出结论。', llm, { castPlan: castPlan(), knownOwners });
    expect(llm.plan).toHaveBeenCalledOnce();
    expect(plan.namedOwnerIds).toEqual([A]);
    expect(plan.source).toBe('llm');
  });

  it('classifies real danger and named-actor comparison questions without broad actor recall', async () => {
    const llm = { plan: vi.fn(async () => ({ intentKind: 'general' as const })) };
    const danger = await planRecallIntent('晶尘为什么危险？', llm, { castPlan: castPlan(), knownOwners });
    expect(danger.intentKind).toBe('world_knowledge');
    expect(danger.topicTerms).toContain('晶尘');
    expect(danger.ownerScope.ownerIds).toEqual(['owner:world', 'owner:narrator']);
    const actor = await planRecallIntent('根据当前记忆，紫罗为什么能利用晶尘，而普通人却会被晶化？', llm, { castPlan: castPlan(), knownOwners });
    expect(actor.intentKind).toBe('actor_entity');
    expect(actor.topicTerms).toEqual(expect.arrayContaining(['紫罗', '晶尘']));
    expect(actor.ownerScope.ownerIds).toEqual(['owner:world', 'owner:narrator', B]);
    expect(actor.ownerScope.ownerIds).not.toContain(A);
    expect(llm.plan).not.toHaveBeenCalled();
  });
});
