import { describe, expect, it } from 'vitest';
import { createGenerationRecallDetail, type PreparedGenerationMemory } from '../src/application/generation';
import type { ActorRecallResponse, MemoryRecallPacket } from '../src/domain';

const packet = (traceId: string, factId: string): MemoryRecallPacket => ({
  traceId,
  factId,
  ownerId: 'owner:actor:a',
  gist: `记忆 ${factId}`,
  details: [],
  effectiveStrength: 82,
  clarity: 0.9,
  deterministicSeed: 'seed',
  omittedDetailCount: 0,
});

function response(kind: 'first' | 'expanded'): ActorRecallResponse {
  const selectedTrace = kind === 'first' ? 'trace:first' : 'trace:final';
  return {
    request: {
      workspaceId: 'character:test',
      chatKey: 'chat',
      query: 'private user text',
      scene: {
        id: 'scene',
        workspaceId: 'character:test',
        chatKey: 'chat',
        floor: 12,
        members: [],
        viewpointOwnerId: 'owner:actor:a',
        speakerOwnerIds: ['owner:actor:a'],
        presentOwnerIds: ['owner:actor:a'],
        mentionedOwnerIds: [],
        createdAt: 1,
      },
      castPlan: {
        id: 'plan:1',
        workspaceId: 'character:test',
        chatKey: 'chat',
        sceneId: 'scene',
        basedOnFloor: 12,
        mode: 'single_actor',
        viewpointOwnerId: 'owner:actor:a',
        requiredOwnerIds: ['owner:actor:a'],
        likelyOwnerIds: [],
        backgroundOwnerIds: [],
        mentionedOnlyOwnerIds: [],
        excludedOwnerIds: [],
        permissionByOwner: { 'owner:actor:a': 'full' },
        plannerMode: 'deterministic',
        confidence: 1,
        evidence: [],
        newActorProposals: [],
        createdAt: 1,
      },
    },
    world: { ownerId: 'owner:world', ownerName: '世界', role: 'world', packets: [] },
    narrator: { ownerId: 'owner:narrator', ownerName: '旁白', role: 'narrator', packets: [] },
    actors: [{
      ownerId: 'owner:actor:a',
      ownerName: '角色 A',
      role: 'actor',
      packets: [packet(selectedTrace, `fact:${kind}`)],
    }],
    candidatePartitions: [{
      ownerId: 'owner:actor:a',
      ownerName: '角色 A',
      role: 'actor',
      candidates: [
        {
          factId: `fact:${kind}`,
          traceIds: [selectedTrace],
          sourceFloors: [4, 6],
          summary: `候选 ${kind}`,
          score: 0.91,
          selected: true,
          reasonCodes: ['hybrid'],
          lexicalScore: 0.5,
          vectorScore: 0.8,
        },
        {
          factId: `fact:${kind}:other`,
          traceIds: [`trace:${kind}:other`],
          sourceFloors: [8],
          summary: `未采用 ${kind}`,
          score: 0.2,
          selected: false,
          reasonCodes: ['below_cutoff'],
        },
      ],
    }],
    diagnostics: {
      candidateCount: 2,
      selectedCount: 1,
      partitions: 3,
      mode: 'multi_actor',
      elapsedMs: kind === 'first' ? 10 : 15,
    },
  };
}

describe('generation recall audit', () => {
  it('retains both attempts and marks only final prompt traces as injected', () => {
    const first = response('first');
    const expanded = response('expanded');
    const prepared = {
      sceneState: {},
      sceneCast: expanded.request.scene,
      castPlan: expanded.request.castPlan,
      intent: {},
      recalled: expanded,
      coverage: {
        covered: true,
        missingSubQueryIds: [],
        missingOwnerIds: [],
        missingTimeDimensions: [],
        privacyViolations: [],
        temporalConflicts: [],
        requiresExpansion: false,
      },
      expanded: true,
      attempts: [
        { kind: 'primary', response: first },
        { kind: 'coverage_expansion', response: expanded },
      ],
      prompt: {
        prompt: '<memory_context>private injected prompt</memory_context>',
        includedTraceIds: ['trace:final'],
        omittedTraceIds: [],
        diagnostics: {
          maxChars: 8000,
          usedChars: 160,
          partitionBudgets: {},
          includedCount: 1,
          omittedCount: 0,
          mode: 'multi_actor',
        },
      },
    } as unknown as PreparedGenerationMemory;
    const detail = createGenerationRecallDetail(prepared, {
      id: 'message:14',
      stableId: 'message:14',
      variantId: '2',
      index: 14,
      role: 'assistant',
      text: 'private assistant reply',
      author: { kind: 'assistant' },
    }, 100);

    expect(detail.attempts).toHaveLength(2);
    expect(detail.attempts[0]?.owners[0]?.candidates[0]?.state).toBe('selected_not_injected');
    expect(detail.attempts[1]?.owners[0]?.candidates[0]?.state).toBe('injected');
    expect(detail.attempts[1]?.owners[0]?.candidates[1]?.state).toBe('not_selected');
    expect(detail.messageId).toBe('message:14');
    expect(detail.variantId).toBe('2');
    expect(detail.prompt.includedTraceIds).toEqual(['trace:final']);
    const stored = JSON.stringify(detail);
    expect(stored).not.toContain('private injected prompt');
    expect(stored).not.toContain('private assistant reply');
    expect(stored).not.toContain('private user text');
  });
});
