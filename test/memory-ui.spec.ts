import { describe, expect, it } from 'vitest';
import {
  EXPECTED_SQLITE_SCHEMA_VERSION,
  filterAndSortFacts,
  estimateInitializationCost,
  formatRollbackConfirmation,
  MEMORY_CAPABILITY_BOUNDARIES,
  readSafeLlmErrorDetails,
  translateChatBinding,
  translateFactKind,
  translateFactStatus,
  translateOverviewStatus,
} from '../src/ui/memory-ui';
import type { MemoryUiFact } from '../src/ui/memory-ui';

describe('Memory UI 展示适配', () => {
  it('仅翻译展示术语，不改变未知底层扩展值', () => {
    expect(translateFactKind('world_rule')).toBe('世界规则');
    expect(translateFactKind('custom_kind')).toBe('custom_kind');
    expect(translateFactStatus('superseded')).toBe('已替代');
    expect(translateFactStatus('custom_status')).toBe('custom_status');
    expect(translateOverviewStatus('working')).toBe('整理中');
    expect(translateChatBinding(true)).toBe('已绑定');
    expect(translateChatBinding(false)).toBe('未绑定');
    expect(translateChatBinding(undefined)).toBe('待确认');
  });

  it('成本预览按历史批次上限与重叠规则估算', () => {
    const estimate = estimateInitializationCost(Array.from({ length: 38 }, (_, index) => `第${index}条消息`));

    expect(estimate.messageCount).toBe(38);
    expect(estimate.batchCount).toBe(2);
    expect(estimate.tokenLow).toBeGreaterThan(0);
    expect(estimate.tokenHigh).toBeGreaterThan(estimate.tokenLow);
  });

  it('空聊天不会虚构 Token 消耗', () => {
    expect(estimateInitializationCost(['', '  '])).toEqual({
      messageCount: 0,
      batchCount: 0,
      tokenLow: 0,
      tokenHigh: 0,
    });
  });

  it('超长消息拆批时仍保持可见消息数量', () => {
    const estimate = estimateInitializationCost(['甲'.repeat(24_001)]);

    expect(estimate.messageCount).toBe(1);
    expect(estimate.batchCount).toBe(3);
  });

  it('按类型与状态筛选，并支持确定性排序', () => {
    const facts: MemoryUiFact[] = [
      { id: 'a', kind: 'state', status: 'active', content: 'a', confidence: 0.8, sourceRefs: [], evidence: [], updatedAt: 10 },
      { id: 'b', kind: 'event', status: 'active', content: 'b', confidence: 0.95, sourceRefs: [], evidence: [], updatedAt: 20 },
      { id: 'c', kind: 'state', status: 'superseded', content: 'c', confidence: 0.9, sourceRefs: [], evidence: [], updatedAt: 30 },
    ];

    expect(filterAndSortFacts(facts, { kind: '', status: 'active', sort: 'confidence_desc' }).map((fact) => fact.id)).toEqual(['b', 'a']);
    expect(filterAndSortFacts(facts, { kind: 'state', status: '', sort: 'updated_desc' }).map((fact) => fact.id)).toEqual(['c', 'a']);
    expect(facts.map((fact) => fact.id)).toEqual(['a', 'b', 'c']);
  });

  it('鉴权错误只提取安全诊断字段且不会要求展示密钥', () => {
    expect(readSafeLlmErrorDetails({
      status: 'error', factCount: 0, lastOrganizedAt: null, pendingJobs: 0, llmAvailable: true,
      error: 'HTTP 401 resource:openai-main model:gpt-test credential=sk-secret',
    })).toEqual({ code: '401', resource: 'openai-main', model: 'gpt-test' });
  });

  it('设置页明确展示当前功能边界与实现状态', () => {
    expect(MEMORY_CAPABILITY_BOUNDARIES.map((item) => item.name)).toEqual([
      '证据优先整理', '向量召回', '混合召回与 rerank', '关系图谱', '类型工坊', '遗忘与失真', '世界风格',
    ]);
    expect(MEMORY_CAPABILITY_BOUNDARIES.every((item) => item.detail.length > 20)).toBe(true);
    expect(MEMORY_CAPABILITY_BOUNDARIES.some((item) => item.status === '停止')).toBe(true);
    expect(MEMORY_CAPABILITY_BOUNDARIES.some((item) => item.status === '替代')).toBe(true);
    expect(MEMORY_CAPABILITY_BOUNDARIES.some((item) => item.status === '可用')).toBe(true);
    expect(MEMORY_CAPABILITY_BOUNDARIES.find((item) => item.name === '关系图谱')?.status).toBe('未实现');
  });

  it('明确 SQLite schema v2 与级联批次回滚语义', () => {
    const confirmation = formatRollbackConfirmation('job:test', 3);

    expect(EXPECTED_SQLITE_SCHEMA_VERSION).toBe(2);
    expect(confirmation).toContain('第 3 批及其后续批次');
    expect(confirmation).toContain('之后批次的整理结果也会一并撤销');
  });
});
