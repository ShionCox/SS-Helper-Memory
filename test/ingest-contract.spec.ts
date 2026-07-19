import { describe, expect, it, vi } from 'vitest';
import { filterSourceBlocks } from '../src/application/ingest/source-blocks';
import { buildSummaryBatches } from '../src/application/ingest/summary-strategy';
import { MemoryIngestService } from '../src/application/ingest/memory-ingest-service';
import type { ExtractedFactProposal, IngestCommit, MemoryExtractor, SourceBlock } from '../src/application/ingest/types';

function block(id: string, content: string, role: SourceBlock['role'] = 'user'): SourceBlock {
  return { id, chatKey: 'chat-a', kind: 'message', role, content, createdAt: 1 };
}

describe('Memory 写入主链', () => {
  it('过滤隐藏与控制文本，并按当前总结策略分批', () => {
    const blocks = [
      block('system', '系统消息', 'system'),
      block('tool', '工具消息', 'tool'),
      block('hidden', '隐藏推理', 'assistant'),
      ...Array.from({ length: 25 }, (_, index) => ({ ...block(`m${index}`, `可见消息 ${index}`), floor: index })),
    ];
    blocks[2] = { ...blocks[2]!, hidden: true };
    const visible = filterSourceBlocks(blocks);
    expect(visible).toHaveLength(25);
    const batches = buildSummaryBatches(visible, { batchMode: 'floors', batchFloors: 20, overlapFloors: 2 });
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(20);
    expect(batches[1]?.slice(0, 2).map((item) => item.id)).toEqual(['m18', 'm19']);
  });

  it('按字数模式完整分片超长消息', () => {
    const oversized = block('oversized', '长'.repeat(12_500));
    const batches = buildSummaryBatches([oversized], { batchMode: 'chars', batchChars: 2_000, overlapFloors: 0 });
    const parts = batches.flat();
    expect(parts.map(part => part.content).join('')).toBe(oversized.content);
    expect(parts.every(part => part.content.length <= 2_000)).toBe(true);
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
