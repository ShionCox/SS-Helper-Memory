import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LlmMemoryExtractor, type MemoryLlmApi } from '../src/application/ingest/llm-extractor';
import { MemoryIngestService } from '../src/application/ingest/memory-ingest-service';
import { buildHistoryBatches, filterSourceBlocks } from '../src/application/ingest/source-blocks';
import type { IngestCommit, SourceBlock, ValidatedFactProposal } from '../src/application/ingest/types';
import { MemoryRecallIndex, type RecallFact, type RecallFactStatus } from '../src/application/recall/memory-recall-index';
import { buildMemoryPrompt } from '../src/application/prompt/build-memory-prompt';

const RUN_REAL_TEST = process.env.RUN_REAL_HISTORY_RECALL === '1';
const CHAT_KEY = 'real-history-recall';
const DATASET = fileURLToPath(new URL('./real-history-recall.imported.jsonl', import.meta.url));

interface TavernMessage {
  is_user?: boolean;
  is_system?: boolean;
  send_date?: string | number;
  mes?: string;
}

interface LlmRequestMetric {
  call: number;
  promptTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
  finishReason: string | null;
}

interface LlmUsageMetrics {
  calls: number;
  promptTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  completionTokens: number;
  requests: LlmRequestMetric[];
}

type StoredFact = Omit<RecallFact, 'status'> & {
  status: RecallFactStatus;
  canonicalKey: string;
  slotKey: string;
  sourceFloor: number;
  evidenceExcerpt: string;
};

function parseJsonObject(content: string): unknown {
  const text = content.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  const candidates = [text, fenced, firstBrace >= 0 && lastBrace > firstBrace ? text.slice(firstBrace, lastBrace + 1) : undefined];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { return JSON.parse(candidate); } catch { /* try next representation */ }
  }
  throw new Error('DeepSeek 返回内容不是合法 JSON。');
}

function buildLlmApi(apiKey: string, metrics: LlmUsageMetrics): MemoryLlmApi {
  return {
    async runTask<T>(input: Parameters<MemoryLlmApi['runTask']>[0]) {
      metrics.calls += 1;
      const requestStartedAt = performance.now();
      try {
        const messages = input.input.messages.map((message, index) => index === 0 && message.role === 'system'
          ? { ...message, content: `${message.content}\n\n必须只输出满足以下 JSON Schema 的合法 JSON 对象，不要附加解释：\n${JSON.stringify(input.schema)}` }
          : message);
        const response = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: 'deepseek-v4-flash',
            messages,
            temperature: 0.1,
            max_tokens: input.budget.maxTokens,
            thinking: { type: 'disabled' },
            response_format: { type: 'json_object' },
          }),
        });
        if (!response.ok) throw new Error(`DeepSeek API 请求失败: ${response.status}`);
        const payload = await response.json() as {
          choices?: Array<{ finish_reason?: string; message?: { content?: string; reasoning_content?: string } }>;
          usage?: {
            prompt_tokens?: number;
            prompt_cache_hit_tokens?: number;
            prompt_cache_miss_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
          };
        };
        const promptTokens = payload.usage?.prompt_tokens ?? 0;
        const promptCacheHitTokens = payload.usage?.prompt_cache_hit_tokens ?? 0;
        const promptCacheMissTokens = payload.usage?.prompt_cache_miss_tokens ?? Math.max(0, promptTokens - promptCacheHitTokens);
        const completionTokens = payload.usage?.completion_tokens ?? 0;
        metrics.promptTokens += promptTokens;
        metrics.promptCacheHitTokens += promptCacheHitTokens;
        metrics.promptCacheMissTokens += promptCacheMissTokens;
        metrics.completionTokens += completionTokens;
        metrics.requests.push({
          call: metrics.calls,
          promptTokens,
          promptCacheHitTokens,
          promptCacheMissTokens,
          completionTokens,
          totalTokens: payload.usage?.total_tokens ?? promptTokens + completionTokens,
          durationMs: Number((performance.now() - requestStartedAt).toFixed(1)),
          finishReason: payload.choices?.[0]?.finish_reason ?? null,
        });
        const content = payload.choices?.[0]?.message?.content ?? '';
        try {
          return { ok: true as const, data: parseJsonObject(content) as T };
        } catch {
          const choice = payload.choices?.[0];
          throw new Error(JSON.stringify({
            reason: 'invalid_json',
            finishReason: choice?.finish_reason ?? null,
            contentLength: content.length,
            reasoningLength: choice?.message?.reasoning_content?.length ?? 0,
            promptTokens: payload.usage?.prompt_tokens ?? 0,
            completionTokens: payload.usage?.completion_tokens ?? 0,
          }));
        }
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

function sourceBlocks(messages: TavernMessage[]): SourceBlock[] {
  return messages.map((message, floor) => ({
    id: `message:floor-${floor}`,
    chatKey: CHAT_KEY,
    kind: 'message' as const,
    role: message.is_system ? 'system' as const : message.is_user ? 'user' as const : 'assistant' as const,
    content: String(message.mes ?? ''),
    createdAt: Number.isFinite(Number(message.send_date)) ? Number(message.send_date) : Date.parse(String(message.send_date ?? '')) || floor,
    floor,
  }));
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/gu, ' ');
}

function toStoredFact(proposal: ValidatedFactProposal, index: number, sources: ReadonlyMap<string, SourceBlock>): StoredFact {
  const source = sources.get(proposal.sourceRef)!;
  const canonicalKey = [proposal.kind, proposal.subjectKey, proposal.predicateKey, proposal.objectKey ?? ''].map(normalized).join('|');
  const slotKey = [proposal.subjectKey, proposal.predicateKey].map(normalized).join('|');
  const updatedAt = source.createdAt;
  return {
    id: `fact-${index}`,
    chatKey: CHAT_KEY,
    kind: proposal.kind,
    subjectKey: proposal.subjectKey,
    predicateKey: proposal.predicateKey,
    ...(proposal.objectKey ? { objectKey: proposal.objectKey } : {}),
    content: proposal.content,
    entityKeys: proposal.entityKeys,
    confidence: proposal.confidence,
    status: proposal.confidence >= 0.75 ? 'active' : 'pending',
    sourceRefs: [proposal.sourceRef],
    updatedAt,
    ...(proposal.validFrom ? { validFrom: proposal.validFrom } : {}),
    ...(proposal.validTo ? { validUntil: proposal.validTo } : {}),
    canonicalKey,
    slotKey,
    sourceFloor: source.floor ?? -1,
    evidenceExcerpt: proposal.evidenceExcerpt,
  };
}

describe('真实 SillyTavern 长历史召回', () => {
  it.skipIf(!RUN_REAL_TEST)('完整整理后能从最早阶段召回事实，且不召回失效事实', async () => {
    const testStartedAt = performance.now();
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
    expect(apiKey, '需要通过环境变量 DEEPSEEK_API_KEY 提供测试密钥').toBeTruthy();

    const rows = (await readFile(DATASET, 'utf8')).split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as TavernMessage);
    const messages = rows.filter(row => typeof row.mes === 'string');
    const sources = filterSourceBlocks(sourceBlocks(messages));
    const batches = buildHistoryBatches(sources);
    const sourceById = new Map(sources.map(source => [source.id, source]));
    const metrics: LlmUsageMetrics = {
      calls: 0,
      promptTokens: 0,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 0,
      completionTokens: 0,
      requests: [],
    };
    const commits: IngestCommit[] = [];
    const batchTrace: Array<Record<string, unknown>> = [];
    const ingest = new MemoryIngestService({
      extractor: new LlmMemoryExtractor(() => buildLlmApi(apiKey!, metrics)),
      commit: async commit => { commits.push(commit); },
    });

    let accepted = 0;
    let rejected = 0;
    for (const [batchIndex, batch] of batches.entries()) {
      const batchStartedAt = performance.now();
      const result = await ingest.ingest({
        chatKey: CHAT_KEY,
        jobId: 'real-history',
        sources: batch,
        jobType: 'history',
        jobStatus: batchIndex === batches.length - 1 ? 'completed' : 'running',
        batchIndex,
        processedCount: Math.max(...batch.map(source => source.floor ?? 0)) + 1,
      });
      accepted += result.accepted;
      rejected += result.rejected;
      batchTrace.push({
        batch: batchIndex + 1,
        floorStart: Math.min(...batch.map(source => source.floor ?? 0)),
        floorEnd: Math.max(...batch.map(source => source.floor ?? 0)),
        sourceCount: batch.length,
        inputChars: batch.reduce((sum, source) => sum + source.content.length, 0),
        accepted: result.accepted,
        rejected: result.rejected,
        durationMs: Number((performance.now() - batchStartedAt).toFixed(1)),
        llmUsage: metrics.requests.at(-1),
      });
    }

    const stored: StoredFact[] = [];
    const activeByCanonical = new Map<string, StoredFact>();
    const activeBySlot = new Map<string, StoredFact>();
    for (const proposal of commits.flatMap(commit => commit.facts)) {
      const incoming = toStoredFact(proposal, stored.length, sourceById);
      const duplicate = activeByCanonical.get(incoming.canonicalKey);
      if (duplicate) continue;
      const conflict = activeBySlot.get(incoming.slotKey);
      if (conflict && conflict.updatedAt < incoming.updatedAt && incoming.confidence >= 0.75) {
        conflict.status = 'superseded';
        activeBySlot.set(incoming.slotKey, incoming);
      } else if (conflict) {
        incoming.status = 'pending';
      } else if (incoming.status === 'active') {
        activeBySlot.set(incoming.slotKey, incoming);
      }
      stored.push(incoming);
      activeByCanonical.set(incoming.canonicalKey, incoming);
    }

    const activeFacts = stored.filter(fact => fact.status === 'active');
    const earliestCutoff = Math.floor((messages.length - 1) * 0.2);
    const earliestFact = activeFacts
      .filter(fact => fact.sourceFloor <= earliestCutoff)
      .sort((left, right) => left.sourceFloor - right.sourceFloor || right.confidence - left.confidence)[0];
    expect(earliestFact, '最早 20% 历史中应提炼出仍有效的事实').toBeTruthy();

    const index = new MemoryRecallIndex(stored);
    const query = '灾变最开始发生时，白夕小时是如何指挥大家应对的？';
    const startedAt = performance.now();
    const result = index.recall({
      chatKey: CHAT_KEY,
      query,
      entityKeys: earliestFact!.entityKeys,
      maxItems: 12,
      now: Math.max(...sources.map(source => source.createdAt), Date.now()),
    });
    const recallMs = performance.now() - startedAt;
    const rank = result.items.findIndex(item => item.fact.id === earliestFact!.id) + 1;
    const inactiveLeakage = result.items.filter(item => item.fact.status !== 'active').length;
    const prompt = buildMemoryPrompt(result);
    const inputCostCny = (metrics.promptCacheHitTokens * 0.02 + metrics.promptCacheMissTokens * 1) / 1_000_000;
    const outputCostCny = metrics.completionTokens * 2 / 1_000_000;

    const countBy = (values: readonly StoredFact[], key: 'kind' | 'status'): Record<string, number> => values.reduce<Record<string, number>>((counts, fact) => {
      const value = String(fact[key]);
      counts[value] = (counts[value] ?? 0) + 1;
      return counts;
    }, {});
    const memoryCatalog = {
      total: stored.length,
      byKind: countBy(stored, 'kind'),
      byStatus: countBy(stored, 'status'),
      facts: [...stored]
        .sort((left, right) => left.sourceFloor - right.sourceFloor || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id))
        .map(fact => ({
          id: fact.id,
          status: fact.status,
          kind: fact.kind,
          subjectKey: fact.subjectKey,
          predicateKey: fact.predicateKey,
          objectKey: fact.objectKey ?? null,
          content: fact.content,
          entityKeys: fact.entityKeys,
          confidence: fact.confidence,
          canonicalKey: fact.canonicalKey,
          sourceFloor: fact.sourceFloor,
          sourceRef: fact.sourceRefs?.[0] ?? null,
          evidenceExcerpt: fact.evidenceExcerpt,
          updatedAt: fact.updatedAt,
        })),
    };

    const factById = new Map(stored.map(fact => [fact.id, fact]));
    const record = {
      format: 'ss-helper-memory-real-recall-record',
      version: 1,
      executedAt: new Date().toISOString(),
      model: 'deepseek-v4-flash',
      dataset: {
        file: DATASET,
        records: rows.length,
        messages: messages.length,
        visibleSources: sources.length,
        batches: batches.length,
      },
      batchTrace,
      memoryCatalog,
      extraction: {
        llmCalls: metrics.calls,
        accepted,
        rejected,
        uniqueFacts: stored.length,
        activeFacts: activeFacts.length,
        pendingFacts: stored.filter(fact => fact.status === 'pending').length,
        supersededFacts: stored.filter(fact => fact.status === 'superseded').length,
        promptTokens: metrics.promptTokens,
        promptCacheHitTokens: metrics.promptCacheHitTokens,
        promptCacheMissTokens: metrics.promptCacheMissTokens,
        completionTokens: metrics.completionTokens,
        totalTokens: metrics.promptTokens + metrics.completionTokens,
        totalDurationMs: Number((performance.now() - testStartedAt).toFixed(1)),
        pricingSnapshot: {
          currency: 'CNY',
          perMillionTokens: { inputCacheHit: 0.02, inputCacheMiss: 1, output: 2 },
          inputCost: Number(inputCostCny.toFixed(6)),
          outputCost: Number(outputCostCny.toFixed(6)),
          totalCost: Number((inputCostCny + outputCostCny).toFixed(6)),
          source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
        },
      },
      conversation: {
        userMessage: query,
        target: {
          id: earliestFact!.id,
          kind: earliestFact!.kind,
          subjectKey: earliestFact!.subjectKey,
          predicateKey: earliestFact!.predicateKey,
          content: earliestFact!.content,
          evidenceExcerpt: earliestFact!.evidenceExcerpt,
          sourceRef: earliestFact!.sourceRefs?.[0],
          sourceFloor: earliestFact!.sourceFloor,
          distanceFromEnd: messages.length - 1 - earliestFact!.sourceFloor,
        },
        recall: {
          durationMs: Number(recallMs.toFixed(3)),
          targetRank: rank,
          selectedCount: result.items.length,
          inactiveLeakage,
          llmCalls: result.diagnostics.llmCalls,
          promptItems: result.items.length,
          injectedPromptChars: prompt.length,
          items: result.items.map((item, itemIndex) => {
            const storedFact = factById.get(item.fact.id);
            return {
              rank: itemIndex + 1,
              score: Number(item.score.toFixed(6)),
              id: item.fact.id,
              kind: item.fact.kind,
              subjectKey: item.fact.subjectKey,
              predicateKey: item.fact.predicateKey,
              content: item.fact.content,
              sourceFloor: storedFact?.sourceFloor,
              sourceRef: storedFact?.sourceRefs?.[0],
              evidenceExcerpt: storedFact?.evidenceExcerpt,
              status: item.fact.status,
              reason: item.reason,
            };
          }),
        },
        injectedPrompt: prompt,
      },
    };
    const outputFile = fileURLToPath(new URL('../test-results/real-history-recall-record.json', import.meta.url));
    await mkdir(fileURLToPath(new URL('../test-results/', import.meta.url)), { recursive: true });
    await writeFile(outputFile, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

    const report = {
      dataset: { records: rows.length, messages: messages.length, visibleSources: sources.length, batches: batches.length },
      extraction: { llmCalls: metrics.calls, accepted, rejected, uniqueFacts: stored.length, activeFacts: activeFacts.length, pendingFacts: stored.filter(fact => fact.status === 'pending').length, supersededFacts: stored.filter(fact => fact.status === 'superseded').length, promptTokens: metrics.promptTokens, completionTokens: metrics.completionTokens },
      earliestRecall: { sourceFloor: earliestFact!.sourceFloor, distanceFromEnd: messages.length - 1 - earliestFact!.sourceFloor, query, found: rank > 0, rank, selected: result.items.length, inactiveLeakage, recallLlmCalls: result.diagnostics.llmCalls, recallMs: Number(recallMs.toFixed(3)), recordFile: outputFile },
    };
    console.log(`REAL_HISTORY_RECALL_REPORT=${JSON.stringify(report)}`);

    expect(commits).toHaveLength(batches.length);
    expect(metrics.calls).toBe(batches.length);
    expect(rank).toBeGreaterThan(0);
    expect(rank).toBeLessThanOrEqual(12);
    expect(inactiveLeakage).toBe(0);
    expect(result.diagnostics.llmCalls).toBe(0);
  }, 20 * 60_000);
});
