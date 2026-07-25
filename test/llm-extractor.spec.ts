import { describe, expect, it, vi } from 'vitest';
import {
  configureMemoryLlmApi,
  MEMORY_CAPTURE_MAX_TOKENS,
  MEMORY_LLM_ROUTE_DIAGNOSTIC_TIMEOUT_MS,
  MemoryLlmTaskError,
  normalizeStructuredCapture,
  readMemoryLlmRouteDiagnostic,
  StructuredMemoryCaptureExtractor,
  type MemoryLlmApi,
} from '../src/application/ingest/llm-extractor';
import type { SourceBlock } from '../src/application/ingest/types';

const source: SourceBlock = {
  id: 'message:1', chatKey: 'chat', kind: 'message', role: 'assistant',
  content: '紫罗能够净化空气。', createdAt: 1,
};

const emptyCapture = { actorCandidates: [], locationCandidates: [], episodes: [], claims: [] };

describe('StructuredMemoryCaptureExtractor', () => {
  it('uses the Claim task budget and returns safe audit metadata', async () => {
    const runTask = vi.fn(async (_input: Parameters<MemoryLlmApi['runTask']>[0]) => ({
      ok: true as const,
      data: emptyCapture,
      meta: { requestId: 'req', resourceId: 'resource', model: 'model', latencyMs: 42 },
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    }));
    const result = await new StructuredMemoryCaptureExtractor(() => ({ runTask } as MemoryLlmApi)).extract({
      chatKey: source.chatKey,
      sources: [source],
    });
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(runTask.mock.calls[0]?.[0]).toMatchObject({
      taskKey: 'memory_capture',
      budget: { maxTokens: MEMORY_CAPTURE_MAX_TOKENS, maxLatencyMs: 180_000 },
    });
    expect(result.audit).toMatchObject({ requestId: 'req', resourceId: 'resource', model: 'model', latencyMs: 42 });
    expect(result.audit?.usage).toMatchObject({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });

  it('automatically retries one structural failure without a browser prompt', async () => {
    const runTask = vi.fn(async (_input: Parameters<MemoryLlmApi['runTask']>[0]): Promise<any> => ({ ok: true as const, data: emptyCapture }))
      .mockResolvedValueOnce({ ok: false as const, error: 'Schema 校验失败', reasonCode: 'schema_validation_failed', retryable: true })
      .mockResolvedValueOnce({ ok: true as const, data: emptyCapture });
    const result = await new StructuredMemoryCaptureExtractor(() => ({ runTask } as MemoryLlmApi)).extract({
      chatKey: source.chatKey,
      sources: [source],
    });
    expect(runTask).toHaveBeenCalledTimes(2);
    expect(runTask.mock.calls[1]?.[0].input.messages[0]?.content).toContain('上一轮输出未通过结构校验');
    expect(result.diagnostics?.automaticRepairCalls).toBe(1);
  });

  it('does not retry non-structural authentication failures and preserves the reason', async () => {
    const runTask = vi.fn(async () => ({
      ok: false as const,
      error: 'authentication failed',
      reasonCode: 'credential_missing',
      meta: { resourceId: 'resource', model: 'model' },
    }));
    await expect(new StructuredMemoryCaptureExtractor(() => ({ runTask } as MemoryLlmApi)).extract({
      chatKey: source.chatKey,
      sources: [source],
    })).rejects.toMatchObject({
      name: 'MemoryLlmTaskError',
      details: { reasonCode: 'credential_missing', resourceId: 'resource', model: 'model' },
    } satisfies Partial<MemoryLlmTaskError>);
    expect(runTask).toHaveBeenCalledTimes(1);
  });

  it('reports route diagnostics with a bounded timeout', async () => {
    configureMemoryLlmApi({
      runTask: async <T>() => ({ ok: true as const, data: emptyCapture as T }),
      inspect: { previewRoute: async () => new Promise(() => undefined) },
    });
    const started = Date.now();
    const result = await readMemoryLlmRouteDiagnostic();
    expect(Date.now() - started).toBeLessThan(MEMORY_LLM_ROUTE_DIAGNOSTIC_TIMEOUT_MS + 1_000);
    expect(result).toMatchObject({ available: false });
    configureMemoryLlmApi(null);
  }, MEMORY_LLM_ROUTE_DIAGNOSTIC_TIMEOUT_MS + 2_000);

  it('does not replace hallucinated evidence with a merely similar source paragraph', () => {
    const row: SourceBlock = {
      ...source,
      content: '白夕小时与白夕叶在门口交谈，但没有发生冲突。',
    };
    const result = normalizeStructuredCapture({
      actorCandidates: [], locationCandidates: [], episodes: [], claims: [{
        localId: 'hallucinated', sourceRef: row.id, episodeLocalId: '', kind: 'event',
        subjectRef: '', subjectText: '白夕小时', predicateKey: '杀死', objectText: '白夕叶',
        content: '白夕小时杀死白夕叶。', evidenceExcerpt: '白夕小时杀死白夕叶',
        knowledge: { mode: 'asserted', privacy: 'public', ownerRefs: [], speakerRef: '', viewpointRef: '', observerRefs: [], presentRefs: [], mentionedRefs: [] },
        confidence: 0.9, stableAnchor: false,
      }],
    }, [row]);

    expect(result.claims[0]?.evidenceExcerpt).toBe('白夕小时杀死白夕叶');
    expect(row.content).not.toContain(result.claims[0]!.evidenceExcerpt);
  });
});
