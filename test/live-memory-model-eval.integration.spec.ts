import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ActorRegistry } from '../src/application/actors/actor-registry';
import { MultiActorCaptureService } from '../src/application/actors/multi-actor-capture-service';
import { LocationRegistry } from '../src/application/locations';
import {
  StructuredMemoryCaptureExtractor,
  type MemoryLlmClient,
} from '../src/application/ingest/llm-extractor';
import type { SourceBlock } from '../src/application/ingest/types';
import { MemoryRecallIndex, type RecallFact } from '../src/application/recall/memory-recall-index';

const RUN_LIVE = process.env.RUN_LIVE_MEMORY_MODEL === '1';
const CHAT_KEY = 'live-memory-model-eval';
const DATASET = fileURLToPath(new URL('./酒馆聊天数据.jsonl', import.meta.url));
const ENV_FILE = fileURLToPath(new URL('./.env', import.meta.url));
const OUTPUT_FILE = fileURLToPath(new URL('../test-results/live-memory-model-eval.json', import.meta.url));

interface TavernRow {
  name?: string;
  is_user?: boolean;
  is_system?: boolean;
  send_date?: string | number;
  mes?: string;
}

interface LiveConfiguration {
  apiKey: string;
  baseUrl: string;
  model: string;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}

async function loadLiveConfiguration(): Promise<LiveConfiguration> {
  const values: Record<string, string> = {};
  for (const rawLine of (await readFile(ENV_FILE, 'utf8')).split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    values[line.slice(0, separator).trim()] = unquote(line.slice(separator + 1));
  }
  const apiKey = values.test_api_key?.trim();
  const baseUrl = values.test_api_url?.trim().replace(/\/+$/u, '');
  const model = values.test_models_name?.trim();
  if (!apiKey || !baseUrl || !model) throw new Error('test/.env 缺少 test_api_key、test_api_url 或 test_models_name。');
  return { apiKey, baseUrl, model };
}

function parseJsonObject(content: string): unknown {
  const text = content.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1]?.trim();
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  for (const candidate of [text, fenced, firstBrace >= 0 && lastBrace > firstBrace ? text.slice(firstBrace, lastBrace + 1) : undefined]) {
    if (!candidate) continue;
    try { return JSON.parse(candidate); } catch { /* try next */ }
  }
  throw new Error('模型返回内容无法解析为 JSON 对象。');
}

function liveLlmApi(config: LiveConfiguration, metrics: Array<Record<string, unknown>>): MemoryLlmClient {
  return {
    async runTask<T>(input: Parameters<MemoryLlmClient['runTask']>[0]) {
      const startedAt = performance.now();
      try {
        const messages = input.input.messages.map((message, index) => index === 0 && message.role === 'system'
          ? {
              ...message,
              content: [
                message.content,
                '你必须严格遵守下面的 JSON Schema。所有 required 字段都必须输出，additionalProperties=false 的对象禁止新增字段。',
                JSON.stringify(input.schema),
              ].join('\n\n'),
            }
          : message);
        const response = await fetch(`${config.baseUrl}/chat/completions`, {
          method: 'POST',
          signal: AbortSignal.timeout(Math.max(240_000, input.budget.maxLatencyMs ?? 0)),
          headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify({
            model: config.model,
            messages,
            temperature: 0,
            max_tokens: input.budget.maxTokens,
            stream: false,
            thinking: { type: 'disabled' },
            response_format: { type: 'json_object' },
          }),
        });
        const raw = await response.text();
        if (!response.ok) throw new Error(`模型接口返回 HTTP ${response.status}`);
        const payload = JSON.parse(raw) as {
          model?: string;
          choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        };
        const content = payload.choices?.[0]?.message?.content ?? '';
        metrics.push({
          model: payload.model ?? config.model,
          latencyMs: Number((performance.now() - startedAt).toFixed(1)),
          finishReason: payload.choices?.[0]?.finish_reason ?? null,
          promptTokens: payload.usage?.prompt_tokens ?? null,
          completionTokens: payload.usage?.completion_tokens ?? null,
          totalTokens: payload.usage?.total_tokens ?? null,
        });
        return {
          ok: true as const,
          data: parseJsonObject(content) as T,
          meta: { model: payload.model ?? config.model, resourceId: 'test-env-openai-compatible' },
        };
      } catch (error) {
        return {
          ok: false as const,
          failure: { reasonCode: 'INTERNAL_ERROR', stage: 'memory.test.live-model' } as const,
        };
      }
    },
  };
}

function toSource(row: TavernRow, floor: number): SourceBlock {
  const role = row.is_system ? 'system' : row.is_user ? 'user' : 'assistant';
  return {
    id: `message:${floor}`,
    chatKey: CHAT_KEY,
    kind: 'message',
    role,
    content: String(row.mes ?? ''),
    createdAt: Number.isFinite(Number(row.send_date)) ? Number(row.send_date) : Date.parse(String(row.send_date ?? '')) || floor,
    floor,
    author: {
      kind: role === 'assistant' ? 'assistant' : role === 'user' ? 'user' : 'system',
      displayName: String(row.name ?? '').trim() || undefined,
    },
  };
}

function seedKnownActors(registry: ActorRegistry): void {
  const actors = [
    ['白夕小时', ['小时', '小時', '小时姐姐']],
    ['白夕音乃', ['音乃']],
    ['白夕莲', ['莲']],
    ['白夕叶', ['叶']],
    ['白夕琴乃·重构体', ['白夕琴乃', '琴乃', '琴乃·重构体']],
    ['紫罗', []],
  ] as const;
  for (const [displayName, aliases] of actors) {
    registry.discover({
      displayName,
      aliases: [...aliases],
      sourceRef: `host-card:${displayName}`,
      sourceType: 'host_card',
      excerpt: `角色：${displayName}`,
      confidence: 1,
      confirmed: true,
    });
  }
}

function recallFacts(results: readonly Awaited<ReturnType<MultiActorCaptureService['capture']>>[]): RecallFact[] {
  const byId = new Map<string, RecallFact>();
  for (const result of results) {
    for (const fact of result.facts) {
      byId.set(fact.id, {
        id: fact.id,
        chatKey: fact.chatKey,
        kind: fact.kind,
        subjectKey: fact.subjectKey,
        predicateKey: fact.predicateKey,
        ...(fact.objectKey ? { objectKey: fact.objectKey } : {}),
        ...(fact.slotKey ? { slotKey: fact.slotKey } : {}),
        content: fact.content,
        entityKeys: fact.entityKeys,
        confidence: fact.confidence,
        status: fact.status,
        sourceRefs: fact.sourceRefs,
        evidenceIds: fact.evidenceIds,
        stableAnchor: fact.stableAnchor,
        validFrom: fact.validFrom,
        validUntil: fact.validUntil,
        updatedAt: fact.updatedAt,
      });
    }
  }
  return [...byId.values()];
}

describe('test/.env 真实模型的多角色提取与召回', () => {
  it.skipIf(!RUN_LIVE)('从真实酒馆聊天样本生成可召回事实', async () => {
    const config = await loadLiveConfiguration();
    const rows = (await readFile(DATASET, 'utf8'))
      .split(/\r?\n/u)
      .filter(Boolean)
      .map(line => JSON.parse(line) as TavernRow)
      .filter(row => typeof row.mes === 'string');
    const sources = rows.map(toSource);
    const ranges = [
      { label: '紫色晶雨初始应对', start: 0, end: 4 },
      { label: '紫罗与能源阶段', start: 19, end: 22 },
      { label: '加油站侦察阶段', start: 113, end: 116 },
    ];
    const registry = new ActorRegistry('live-memory-model-eval-workspace');
    seedKnownActors(registry);
    const metrics: Array<Record<string, unknown>> = [];
    const extractor = new StructuredMemoryCaptureExtractor(() => liveLlmApi(config, metrics));
    const service = new MultiActorCaptureService(registry, new LocationRegistry(registry.workspaceId), extractor);
    const captures = [];
    const batchReports: Array<Record<string, unknown>> = [];

    for (const range of ranges) {
      const batchSources = sources.slice(range.start, range.end + 1);
      const result = await service.capture({
        workspaceId: registry.workspaceId,
        chatKey: CHAT_KEY,
        sources: batchSources,
        writableSourceRefs: batchSources.map(source => source.id),
        currentFloor: range.end,
      });
      captures.push(result);
      batchReports.push({
        label: range.label,
        floors: [range.start, range.end],
        sourceCount: batchSources.length,
        inputChars: batchSources.reduce((sum, source) => sum + source.content.length, 0),
        outcome: result.outcome,
        accepted: {
          actors: result.acceptedLocalIds.actor.length,
          episodes: result.episodes.length,
          observations: result.observations.length,
          facts: result.facts.length,
          traces: result.traces.length,
        },
        rejectionCount: result.rejections.length,
        rejectionCodes: result.rejections.reduce<Record<string, number>>((counts, rejection) => {
          counts[rejection.code] = (counts[rejection.code] ?? 0) + 1;
          return counts;
        }, {}),
        rejectionSamples: result.rejections.slice(0, 10).map(rejection => ({
          code: rejection.code,
          recordType: rejection.recordType,
          fieldPath: rejection.fieldPath,
          issues: rejection.issues,
          message: rejection.message,
          sourceRefs: rejection.sourceRefs,
          requestId: rejection.requestId,
          batchIndex: rejection.batchIndex,
        })),
        pendingActors: result.pendingCandidates.map(candidate => candidate.displayName),
        diagnostics: result.diagnostics,
      });
    }

    const facts = recallFacts(captures);
    const index = new MemoryRecallIndex(facts);
    const queries = [
      { query: '紫色晶雨最初发生时，白夕小时如何指挥大家应对？', entityKeys: ['紫色晶雨', '白夕小时'] },
      { query: '紫罗拥有什么能力，可以怎样帮助团队？', entityKeys: ['紫罗', '能力', '团队'] },
      { query: '加油站地下储油库目前还有多少燃油？', entityKeys: ['加油站', '地下储油库', '燃油'] },
    ];
    const recallReports = queries.map(input => {
      const result = index.recall({ chatKey: CHAT_KEY, ...input, maxItems: 8, now: Date.now() });
      return {
        query: input.query,
        selectedCount: result.items.length,
        diagnostics: result.diagnostics,
        items: result.items.map((item, rank) => ({
          rank: rank + 1,
          score: Number(item.score.toFixed(6)),
          kind: item.fact.kind,
          subjectKey: item.fact.subjectKey,
          predicateKey: item.fact.predicateKey,
          content: item.fact.content,
          confidence: item.fact.confidence,
          sourceRefs: item.fact.sourceRefs,
        })),
      };
    });

    const activeFacts = facts.filter(fact => fact.status === 'active' && fact.confidence >= 0.75);
    const falseActorNames = new Set(['生菜', '紫晶素', '雏鸟', '雏鸟粪便', '灰羽蛋壳', '灰羽遗卵', '抗体']);
    const pendingFalseActors = captures.flatMap(result => result.pendingCandidates)
      .map(candidate => candidate.displayName)
      .filter(name => falseActorNames.has(name));
    const report = {
      format: 'ss-helper-memory-live-model-eval',
      executedAt: new Date().toISOString(),
      configuredModel: config.model,
      dataset: { file: DATASET, messages: rows.length },
      metrics,
      batches: batchReports,
      facts: {
        total: facts.length,
        active: activeFacts.length,
        pending: facts.filter(fact => fact.status === 'pending').length,
        samples: facts.slice(0, 20).map(fact => ({
          id: fact.id,
          kind: fact.kind,
          subjectKey: fact.subjectKey,
          predicateKey: fact.predicateKey,
          content: fact.content,
          confidence: fact.confidence,
          status: fact.status,
          sourceRefs: fact.sourceRefs,
          validFrom: fact.validFrom,
          validUntil: fact.validUntil,
          updatedAt: fact.updatedAt,
        })),
      },
      actors: {
        registered: registry.listOwners().filter(owner => owner.kind === 'actor').map(owner => ({
          canonicalName: owner.canonicalName ?? owner.displayName,
          aliases: owner.aliases,
          status: owner.status,
        })),
        pendingFalseActors,
      },
      recall: recallReports,
    };
    await mkdir(fileURLToPath(new URL('../test-results/', import.meta.url)), { recursive: true });
    await writeFile(OUTPUT_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`LIVE_MEMORY_MODEL_REPORT=${JSON.stringify({
      model: config.model,
      batches: batchReports,
      factCount: facts.length,
      activeFactCount: activeFacts.length,
      pendingFalseActors,
      recall: recallReports,
      outputFile: OUTPUT_FILE,
    })}`);

    expect(metrics.length).toBeGreaterThanOrEqual(ranges.length);
    expect(facts.length).toBeGreaterThan(0);
    expect(activeFacts.length).toBeGreaterThan(0);
    expect(pendingFalseActors).toEqual([]);
    expect(recallReports[0]?.items.some(item => (item.sourceRefs ?? []).includes('message:0')
      && /所有人.*室内/u.test(item.content)
      && /叶.*监控/u.test(item.content)
      && /莲.*保护/u.test(item.content)
      && /琴乃.*分析/u.test(item.content))).toBe(true);
    expect(recallReports[1]?.items.some(item => /紫罗/u.test(item.content))).toBe(true);
    expect(recallReports[2]?.items.some(item => /加油站|储油|燃油/u.test(item.content))).toBe(true);
  }, 10 * 60_000);
});
