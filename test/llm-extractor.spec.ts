import { describe, expect, it, vi } from 'vitest';
import {
  configureMemoryLlmClient,
  MEMORY_CAPTURE_REPAIR_TASK,
  MEMORY_CAPTURE_MAX_TOKENS,
  MEMORY_LLM_ROUTE_DIAGNOSTIC_TIMEOUT_MS,
  normalizeStructuredCapture,
  readMemoryLlmRouteDiagnostic,
  StructuredMemoryCaptureExtractor,
  type MemoryLlmClient,
} from '../src/application/ingest/llm-extractor';
import type { SourceBlock } from '../src/application/ingest/types';
import { buildSupportedEvidenceDirectory } from '../src/application/ingest/supported-evidence-directory';

const source: SourceBlock = {
  id: 'message:1', chatKey: 'chat', kind: 'message', role: 'assistant',
  content: '紫罗能够净化空气。', createdAt: 1,
};

const emptyCapture = { actorCandidates: [], locationCandidates: [], itemCandidates: [], episodes: [], claims: [], inventoryOperations: [] };

describe('StructuredMemoryCaptureExtractor', () => {
  it('uses the Claim task budget and returns safe audit metadata', async () => {
    const runTask = vi.fn(async (_input: Parameters<MemoryLlmClient['runTask']>[0]) => ({
      ok: true as const,
      data: emptyCapture,
      meta: { requestId: 'req', resourceId: 'resource', model: 'model', latencyMs: 42, fallbackUsed: true },
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    }));
    const result = await new StructuredMemoryCaptureExtractor(() => ({ runTask } as MemoryLlmClient)).extract({
      chatKey: source.chatKey,
      sources: [source],
    });
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(runTask.mock.calls[0]?.[0]).toMatchObject({
      taskKey: 'memory_capture',
      budget: { maxTokens: MEMORY_CAPTURE_MAX_TOKENS, maxLatencyMs: 180_000 },
    });
    expect(result.audit).toMatchObject({ requestId: 'req', resourceId: 'resource', model: 'model', latencyMs: 42, fallbackUsed: true });
    expect(result.audit?.usage).toMatchObject({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });

  it('delegates bounded Schema repair to one LLM bus call and records its diagnostics', async () => {
    const runTask = vi.fn(async (_input: Parameters<MemoryLlmClient['runTask']>[0]): Promise<any> => ({
      ok: true as const,
      data: emptyCapture,
      meta: { requestId: 'root-request', attemptCount: 2, repairCount: 1, transport: 'json_schema' },
    }));
    const result = await new StructuredMemoryCaptureExtractor(() => ({ runTask } as MemoryLlmClient)).extract({
      chatKey: source.chatKey,
      sources: [source],
    });
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(result.diagnostics?.schemaRepairCalls).toBe(1);
    expect(result.audit?.requestId).toBe('root-request');
  });

  it('turns itemized LLM rejections into safe repair descriptors without a second extractor call', async () => {
    const runTask = vi.fn(async (_input: Parameters<MemoryLlmClient['runTask']>[0]): Promise<any> => ({
      ok: true as const,
      data: emptyCapture,
      meta: {
        requestId: 'capture-partial',
        resourceId: 'resource-1',
        model: 'model-1',
        validationOutcome: 'partial',
        attemptCount: 1,
        repairCount: 0,
        itemRejections: [{
          collection: 'claims',
          itemIndex: 2,
          issues: [{ path: '$.claims[2].objectRef', keyword: 'required', expected: 'property to be present' }],
          sourceRefs: ['message:1'],
        }],
      },
    }));
    const result = await new StructuredMemoryCaptureExtractor(() => ({ runTask } as MemoryLlmClient)).extract({
      chatKey: source.chatKey,
      sources: [source],
      writableSourceRefs: [source.id],
    });

    expect(runTask).toHaveBeenCalledTimes(1);
    expect(result.rejections).toEqual([expect.objectContaining({
      code: 'schema_validation_failed',
      recordType: 'claim',
      index: 2,
      fieldPath: '$.claims[2].objectRef',
      issues: [{ path: '$.claims[2].objectRef', keyword: 'required', expected: 'property to be present' }],
      sourceRefs: ['message:1'],
      requestId: 'capture-partial',
      resourceId: 'resource-1',
      model: 'model-1',
      status: 'unresolved',
      repairAttempts: 0,
    })]);
    expect(JSON.stringify(result.rejections)).not.toContain('rawValue');
  });

  it('uses an independently routed repair task with explicit emit decisions and safe source evidence', async () => {
    const runTask = vi.fn(async (input: Parameters<MemoryLlmClient['runTask']>[0]): Promise<any> => {
      const decisionSchema = (input.schema as any).properties.decisions.items;
      const evidenceSpanId = decisionSchema.properties.items.items.properties.evidenceSpanId.enum[0];
      return {
        ok: true as const,
        data: {
          decisions: [{
            repairId: 'repair:actor:1',
            action: 'emit',
            items: [{
              localId: 'actor-violet',
              displayName: '紫罗',
              aliases: [],
              evidenceSpanId,
              confidence: 0.98,
            }],
          }],
        },
        meta: {
        requestId: 'repair-request',
        parentRequestId: 'capture-request',
        resourceId: 'resource-1',
        model: 'model-1',
        validationOutcome: 'complete',
        itemRejections: [],
        attemptCount: 1,
        repairCount: 0,
        },
      };
    });
    const result = await new StructuredMemoryCaptureExtractor(() => ({ runTask } as MemoryLlmClient)).extract({
      chatKey: source.chatKey,
      sources: [source],
      writableSourceRefs: [source.id],
      repair: {
        collection: 'actorCandidates',
        issues: [{ path: '$.actorCandidates[0].displayName', keyword: 'required', expected: 'property to be present' }],
        targets: [{ repairId: 'repair:actor:1', issues: [{ path: '$.actorCandidates[0].displayName', keyword: 'required', expected: 'property to be present' }] }],
        parentRequestId: 'capture-request',
        resourceId: 'resource-1',
        model: 'model-1',
        maxItems: 1,
      },
    });

    expect(runTask).toHaveBeenCalledTimes(1);
    const request = runTask.mock.calls[0]![0];
    const messages = (request.input as { messages: Array<{ role: string; content: string }> }).messages;
    expect(request).toMatchObject({
      taskKey: MEMORY_CAPTURE_REPAIR_TASK,
      parentRequestId: 'capture-request',
      budget: { maxTokens: 2_048, maxLatencyMs: 180_000 },
      schema: {
        required: ['decisions'],
        properties: { decisions: { minItems: 1, maxItems: 1 } },
      },
    });
    expect(request).not.toHaveProperty('route');
    expect((request.schema as any).properties.decisions.items.properties.items.items.properties).not.toHaveProperty('sourceRef');
    expect(messages[0]?.content).toContain('$.actorCandidates[0].displayName');
    expect(messages[1]?.content).toContain('紫罗能够净化空气');
    expect(messages.map(message => message.content).join('\n')).not.toContain('"rawFailure":');
    expect(result.actorCandidates).toEqual([expect.objectContaining({ localId: 'actor-violet', displayName: '紫罗' })]);
    expect(result.repairDecisions).toEqual([{
      repairId: 'repair:actor:1', action: 'emit', localId: 'actor-violet', itemIndex: 0, sourceRefs: ['message:1'],
    }]);
    expect(result.audit?.requestId).toBe('repair-request');
  });

  it('drops a later repair decision that reuses an emitted localId', async () => {
    const runTask = vi.fn(async (input: Parameters<MemoryLlmClient['runTask']>[0]): Promise<any> => {
      const decisionSchema = (input.schema as any).properties.decisions.items;
      const evidenceSpanId = decisionSchema.properties.items.items.properties.evidenceSpanId.enum[0];
      const item = { localId: 'actor-violet', displayName: '紫罗', aliases: [], evidenceSpanId, confidence: 0.98 };
      return {
        ok: true as const,
        data: { decisions: [
          { repairId: 'repair:actor:1', action: 'emit', items: [item] },
          { repairId: 'repair:actor:2', action: 'emit', items: [item] },
        ] },
      };
    });
    const issues = [{ path: '$.actorCandidates[0]', keyword: 'required', expected: 'valid actor' }];
    const result = await new StructuredMemoryCaptureExtractor(() => ({ runTask } as MemoryLlmClient)).extract({
      chatKey: source.chatKey,
      sources: [source],
      writableSourceRefs: [source.id],
      repair: {
        collection: 'actorCandidates',
        issues,
        targets: [
          { repairId: 'repair:actor:1', issues },
          { repairId: 'repair:actor:2', issues },
        ],
        maxItems: 2,
      },
    });

    expect(result.actorCandidates).toHaveLength(1);
    expect(result.repairDecisions).toEqual([
      { repairId: 'repair:actor:1', action: 'emit', localId: 'actor-violet', itemIndex: 0, sourceRefs: ['message:1'] },
      { repairId: 'repair:actor:2', action: 'drop' },
    ]);
  });

  it('does not retry non-structural authentication failures and preserves the reason', async () => {
    const runTask = vi.fn(async () => ({
      ok: false as const,
      failure: {
        reasonCode: 'AUTH_FAILED' as const,
        stage: 'llm.provider.authenticate',
        requestId: 'auth-request',
      },
      meta: { resourceId: 'resource', model: 'model' },
    }));
    await expect(new StructuredMemoryCaptureExtractor(() => ({ runTask } as MemoryLlmClient)).extract({
      chatKey: source.chatKey,
      sources: [source],
    })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: {
        reasonCode: 'AUTH_FAILED',
        requestId: 'auth-request',
      },
    });
    expect(runTask).toHaveBeenCalledTimes(1);
  });

  it('reports route diagnostics with a bounded timeout', async () => {
    configureMemoryLlmClient({
      runTask: async <T>() => ({ ok: true as const, data: emptyCapture as T }),
      inspect: { previewRoute: async () => new Promise(() => undefined) },
    });
    const started = Date.now();
    const result = await readMemoryLlmRouteDiagnostic();
    expect(Date.now() - started).toBeLessThan(MEMORY_LLM_ROUTE_DIAGNOSTIC_TIMEOUT_MS + 1_000);
    expect(result).toMatchObject({ available: false });
    configureMemoryLlmClient(null);
  }, MEMORY_LLM_ROUTE_DIAGNOSTIC_TIMEOUT_MS + 2_000);

  it('turns an evidence span outside the closed set into an item rejection', () => {
    const row: SourceBlock = {
      ...source,
      content: '白夕小时与白夕叶在门口交谈，但没有发生冲突。',
    };
    const directory = buildSupportedEvidenceDirectory([row]);
    const result = normalizeStructuredCapture({
      actorCandidates: [], locationCandidates: [], itemCandidates: [], episodes: [], claims: [{
        localId: 'hallucinated', episodeLocalId: '', kind: 'event',
        subjectRef: '', subjectText: '白夕小时', predicateKey: '杀死', objectText: '白夕叶',
        content: '白夕小时杀死白夕叶。', evidenceSpanId: 'outside-closed-set',
        knowledge: { mode: 'asserted', privacy: 'public', ownerRefs: [], speakerRef: '', viewpointRef: '', observerRefs: [], presentRefs: [], mentionedRefs: [] },
        confidence: 0.9, stableAnchor: false,
      }], inventoryOperations: [],
    }, [row], directory, { requestId: 'capture-evidence', resourceId: 'resource', model: 'model' });
    expect(result.claims).toEqual([]);
    expect(result.rejections).toEqual([expect.objectContaining({
      code: 'schema_validation_failed',
      recordType: 'claim',
      index: 0,
      fieldPath: '$.claims[0].evidenceSpanId',
      issues: [{ path: '$.claims[0].evidenceSpanId', keyword: 'enum', expected: 'supported evidence span' }],
      sourceRefs: [row.id],
      requestId: 'capture-evidence',
      resourceId: 'resource',
      model: 'model',
      status: 'unresolved',
      repairAttempts: 0,
    })]);
  });

  it('derives the source deterministically from the selected evidence span', () => {
    const second: SourceBlock = {
      ...source,
      id: 'message:2',
      content: '白夕叶留在门口。',
    };
    const directory = buildSupportedEvidenceDirectory([source, second]);
    const secondSpanId = directory.spans.find(span => span.sourceRef === second.id)!.evidenceSpanId;
    const result = normalizeStructuredCapture({
      actorCandidates: [{
        localId: 'actor-leaf',
        displayName: '白夕叶',
        aliases: [],
        evidenceSpanId: secondSpanId,
        confidence: 0.95,
      }],
      locationCandidates: [],
      itemCandidates: [],
      episodes: [],
      claims: [],
      inventoryOperations: [],
    }, [source, second], directory, { requestId: 'capture-cross-source' });
    expect(result.actorCandidates).toEqual([expect.objectContaining({
      sourceRef: second.id,
      evidenceExcerpt: second.content,
    })]);
    expect(result.rejections).toBeUndefined();
  });

  it('preserves the request id when a root envelope cannot be mapped', async () => {
    const runTask = vi.fn(async (): Promise<any> => ({
      ok: true as const,
      data: null,
      meta: { requestId: 'capture-root-invalid', resourceId: 'resource-1', model: 'model-1' },
    }));
    await expect(new StructuredMemoryCaptureExtractor(() => ({ runTask } as MemoryLlmClient)).extract({
      chatKey: source.chatKey,
      sources: [source],
    })).rejects.toMatchObject({
      details: expect.objectContaining({
        reasonCode: 'SCHEMA_VALIDATION_FAILED',
        stage: 'memory.capture.map',
        requestId: 'capture-root-invalid',
        resourceId: 'resource-1',
        model: 'model-1',
      }),
    });
  });
});
