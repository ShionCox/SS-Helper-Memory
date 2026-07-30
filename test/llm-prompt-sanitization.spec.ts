import { describe, expect, it, vi } from 'vitest';
import { StructuredMemoryCaptureExtractor, type MemoryLlmClient } from '../src/application/ingest/llm-extractor';
import type { SourceBlock } from '../src/application/ingest/types';

describe('memory Capture prompt sanitization', () => {
  it('never exposes persistence owner/location IDs to the model', async () => {
    const runTask = vi.fn(async (_input: Parameters<MemoryLlmClient['runTask']>[0]) => ({
      ok: true as const,
      data: { actorCandidates: [], locationCandidates: [], episodes: [], claims: [] },
      meta: { resourceId: 'generation', model: 'test', latencyMs: 1 },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }));
    const extractor = new StructuredMemoryCaptureExtractor(() => ({ runTask } as never));
    const source: SourceBlock = {
      id: 'message:1', chatKey: 'chat', kind: 'message', role: 'assistant',
      content: '测试正文。', createdAt: 1,
      author: {
        kind: 'assistant', displayName: '测试人物',
        avatar: 'C:\\private\\avatar.png', originalAvatar: 'C:\\private\\original.png',
      },
      actorRefs: ['owner:actor:private-database-id'],
      locationRefs: ['location:private-database-id'],
      perspective: { speakerOwnerRef: 'owner:actor:private-database-id' },
      transition: { locationKeys: ['location:private-database-id'] },
    };

    await extractor.extract({
      chatKey: 'chat',
      sources: [source],
      knownActorContext: [{
        referenceId: 'actor:prompt-ref', ownerId: 'owner:actor:private-database-id',
        canonicalName: '测试人物', aliases: ['人物'], status: 'confirmed',
      }],
      knownLocationContext: [{
        referenceId: 'location:prompt-ref', locationId: 'location:private-database-id',
        canonicalName: '测试地点', aliases: ['地点'], status: 'confirmed',
      }],
    });

    const request = runTask.mock.calls[0]?.[0];
    const prompt = request.input.messages.map((message: any) => String(message.content ?? '')).join('\n');
    expect(prompt).toContain('actor:prompt-ref');
    expect(prompt).toContain('location:prompt-ref');
    expect(prompt).not.toContain('owner:actor:private-database-id');
    expect(prompt).not.toContain('location:private-database-id');
    expect(prompt).not.toContain('C:\\private\\avatar.png');
    expect(prompt).not.toContain('C:\\private\\original.png');
    expect(prompt).not.toContain('"chatKey":"chat"');
  });
});
