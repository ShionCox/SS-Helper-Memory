import { describe, expect, it, vi } from 'vitest';
import { AdaptiveIngestTrigger } from '../src/application/ingest/adaptive-trigger';
import {
  HISTORY_BATCH_MAX_CHARS,
  buildHistoryBatches,
  buildIncrementalBatch,
  filterSourceBlocks,
} from '../src/application/ingest/source-blocks';
import { MemoryIngestService } from '../src/application/ingest/memory-ingest-service';
import type { ExtractedFactProposal, IngestCommit, MemoryExtractor, SourceBlock } from '../src/application/ingest/types';

function block(id: string, content: string, role: SourceBlock['role'] = 'user'): SourceBlock {
  return { id, chatKey: 'chat-a', kind: 'message', role, content, createdAt: 1 };
}

describe('Memory 写入主链', () => {
  it('普通窗口第 6 轮触发且一个窗口只触发一次', () => {
    const trigger = new AdaptiveIngestTrigger();
    for (let round = 1; round <= 5; round += 1) {
      expect(trigger.observeRound('chat-a', `普通闲聊 ${round}`).shouldFlush).toBe(false);
    }
    expect(trigger.observeRound('chat-a', '普通闲聊 6').shouldFlush).toBe(true);
    expect(trigger.observeRound('chat-a', '普通闲聊 7').shouldFlush).toBe(false);
    trigger.markFlushed('chat-a');
    expect(trigger.observeRound('chat-a', '普通闲聊 8').shouldFlush).toBe(false);
  });

  it('高信号最早在第 3 轮提前触发', () => {
    const trigger = new AdaptiveIngestTrigger();
    expect(trigger.observeRound('chat-a', '我答应以后去北境').shouldFlush).toBe(false);
    expect(trigger.observeRound('chat-a', '我们关系发生改变').shouldFlush).toBe(false);
    expect(trigger.observeRound('chat-a', '新的目标是找到王冠').shouldFlush).toBe(true);
  });

  it('过滤隐藏与控制文本，并按 20 条/12000 字切批且重叠 2 条', () => {
    const blocks = [
      block('system', '系统消息', 'system'),
      block('tool', '工具消息', 'tool'),
      block('hidden', '隐藏推理', 'assistant'),
      ...Array.from({ length: 25 }, (_, index) => block(`m${index}`, `可见消息 ${index}`)),
    ];
    blocks[2] = { ...blocks[2]!, hidden: true };
    const visible = filterSourceBlocks(blocks);
    expect(visible).toHaveLength(25);
    const batches = buildHistoryBatches(visible);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(20);
    expect(batches[1]?.slice(0, 2).map((item) => item.id)).toEqual(['m18', 'm19']);
  });

  it('完整分片单条超长历史来源，并把增量窗口限制为一次 12000 字调用', () => {
    const oversized = block('oversized', '长'.repeat(HISTORY_BATCH_MAX_CHARS + 500));
    const oversizedParts = buildHistoryBatches([oversized]).flat();
    expect(oversizedParts).toHaveLength(2);
    expect(oversizedParts.map(part => part.content).join('')).toBe(oversized.content);
    expect(oversizedParts.map(part => part.id)).toEqual(['oversized:part:1', 'oversized:part:2']);

    const metadata: SourceBlock = {
      ...block('character', '角色设定'.repeat(1_000)), kind: 'character', role: 'metadata',
    };
    const recent = Array.from({ length: 12 }, (_, index) => block(`m${index}`, `第${index}轮`.repeat(800)));
    const batch = buildIncrementalBatch([metadata, ...recent]);
    expect(batch.reduce((sum, source) => sum + source.content.length, 0)).toBeLessThanOrEqual(HISTORY_BATCH_MAX_CHARS);
    expect(batch.filter((source) => source.kind === 'message').length).toBeGreaterThan(0);

    const deferred = block('deferred', '尾'.repeat(9_000));
    expect(buildIncrementalBatch([{ ...metadata, content: '设'.repeat(4_000) }, deferred]).map(item => item.id)).toEqual(['character']);
    expect(buildIncrementalBatch([deferred])[0]?.content).toBe(deferred.content);
  });

  it('每批只调用一次 memory_extract，并只提交有精确证据的原子事实', async () => {
    const sources = [block('m1', '艾琳出生在雾港，并承诺寻找失落王冠。')];
    const proposals: ExtractedFactProposal[] = [
      {
        kind: 'identity', subjectKey: '艾琳', predicateKey: '出生地', objectKey: '雾港',
        content: '艾琳出生在雾港，是当地登记在册并长期居住的普通居民。', entityKeys: ['艾琳', '雾港'],
        confidence: 0.92, sourceRef: 'm1', evidenceExcerpt: '艾琳出生在雾港', actionHint: 'upsert',
      },
      {
        kind: 'goal', subjectKey: '艾琳', predicateKey: '目标', objectKey: '王冠',
        content: '艾琳必须寻找失落王冠，这是她目前正在推进的重要目标。', entityKeys: ['艾琳', '王冠'],
        confidence: 0.91, sourceRef: 'm1', evidenceExcerpt: '原文中不存在的证据', actionHint: 'upsert',
      },
    ];
    const extractor: MemoryExtractor = { extract: vi.fn(async () => proposals) };
    const commits: IngestCommit[] = [];
    const service = new MemoryIngestService({ extractor, commit: async (input) => void commits.push(input) });

    const result = await service.ingest({ chatKey: 'chat-a', jobId: 'job-1', sources });

    expect(extractor.extract).toHaveBeenCalledTimes(1);
    expect(result.accepted).toBe(1);
    expect(result.rejected).toBe(1);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.facts).toHaveLength(1);
    expect(commits[0]?.facts[0]?.stable).toBe(false);
    expect(commits[0]?.checkpoint.sourceIds).toEqual(['m1']);
    expect(commits[0]?.rejections).toEqual([
      expect.objectContaining({ code: 'excerpt_mismatch', message: expect.stringContaining('逐字匹配') }),
    ]);
  });

  it('把 LLM 路由与真实 Token usage 原样提交给批次审计', async () => {
    const sources = [block('m1', '艾琳明确确认自己出生在雾港。')];
    const extractor: MemoryExtractor = {
      extract: vi.fn(async () => ({
        facts: [],
        audit: {
          requestId: 'req-1', resourceId: 'deepseek-main', model: 'deepseek-chat', latencyMs: 932,
          usage: { promptTokens: 100, completionTokens: 20, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: 120 },
        },
      })),
    };
    const commits: IngestCommit[] = [];
    const service = new MemoryIngestService({ extractor, commit: async (input) => void commits.push(input) });

    await service.ingest({ chatKey: 'chat-a', jobId: 'job-audit', sources });

    expect(commits[0]?.audit).toEqual({
      requestId: 'req-1', resourceId: 'deepseek-main', model: 'deepseek-chat', latencyMs: 932,
      usage: { promptTokens: 100, completionTokens: 20, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: 120 },
    });
  });

  it('变量状态来源不调用 LLM，并生成可覆盖旧状态的确定性事实', async () => {
    const stateSource: SourceBlock = {
      id: 'state:last:hash', chatKey: 'chat-a', kind: 'state', role: 'metadata', createdAt: 100, floor: 100,
      content: '状态快照\t白夕小队 / 小队武器 / 紫能高压手枪\t白夕小时持有（已重新压入核心，剩余击发次数：10）',
    };
    const extractor: MemoryExtractor = { extract: vi.fn(async () => []) };
    const commits: IngestCommit[] = [];
    const service = new MemoryIngestService({ extractor, commit: async input => void commits.push(input) });

    const result = await service.ingest({ chatKey: 'chat-a', jobId: 'job-state', sources: [stateSource] });

    expect(extractor.extract).not.toHaveBeenCalled();
    expect(result.accepted).toBe(1);
    expect(commits[0]?.facts[0]).toMatchObject({
      kind: 'state', subjectKey: '紫能高压手枪', predicateKey: '当前状态', confidence: 1,
      sourceRef: 'state:last:hash', evidenceExcerpt: stateSource.content,
    });
  });
});
