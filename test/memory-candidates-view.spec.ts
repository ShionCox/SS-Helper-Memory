// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { MemoryCandidateRecord } from '../src/domain';
import { renderMemoryCandidatesView, type MemoryCandidatesViewState } from '../src/ui/memory-candidates-view';

const candidate: MemoryCandidateRecord = {
  id: 'candidate:claim:1',
  workspaceId: 'workspace:1',
  chatKey: 'chat:1',
  jobId: 'capture:1',
  batchIndex: 2,
  pipelineRunId: 'pipeline:1',
  stageAttemptId: 'stage:1',
  attemptIndex: 0,
  stage: 'content',
  collection: 'claims',
  status: 'rejected',
  candidateLocalId: 'claim:1',
  summary: '她把铜钥匙放在实验室门旁。',
  normalizedCandidate: { subject: '她', predicate: '放置', object: '铜钥匙' },
  reasonCode: 'SCHEMA_VALIDATION_FAILED',
  rejectionId: 'rejection:1',
  committedRecordRefs: [],
  evidence: [{
    evidenceSpanId: 'span:1', sourceRef: 'message:12', sourceKind: 'message', floor: 12, start: 0, end: 8,
    text: '她把铜钥匙放在门旁。', sourceDigest: 'digest:1',
  }],
  sourceRefs: ['message:12'],
  createdAt: 1,
};

function state(overrides: Partial<MemoryCandidatesViewState> = {}): MemoryCandidatesViewState {
  return {
    candidates: [], selectedId: '', selectedSourceRef: '', query: '', batch: '', collection: '', status: '', floor: '',
    loading: false, missingSnapshot: true, ...overrides,
  };
}

describe('候选检查重设计', () => {
  it('把旧任务空状态、任务上下文和状态筛选分开表达', () => {
    const html = renderMemoryCandidatesView(state({
      stats: { total: 0, accepted: 0, notWritten: 0, rejectedOrIgnored: 0, byStatus: {}, jobId: 'capture:old', batchCount: 0 },
    }));
    expect(html).toContain('聊天原文');
    expect(html).not.toContain('MEMORY TRACE / CANDIDATE QUEUE');
    expect(html).toContain('没有可追溯快照');
    expect(html).toContain('data-action="navigate" data-page="initialize"');
    expect(html).toContain('data-action="filter-memory-candidates"');
    expect(html).toContain('aria-label="候选队列"');
    expect(html).not.toContain('candidateSnapshot');
  });

  it('详情按裁决、元数据、证据和折叠 JSON 分组，并保留来源高亮语义', () => {
    const html = renderMemoryCandidatesView(state({
      candidates: [candidate],
      selectedId: candidate.id,
      selectedSourceRef: 'message:12',
      missingSnapshot: false,
      stats: { total: 1, accepted: 0, notWritten: 1, rejectedOrIgnored: 1, byStatus: { rejected: 1 }, jobId: 'capture:1', batchCount: 3 },
      sourcePreview: {
        candidateId: candidate.id, sourceRef: 'message:12', sourceKind: 'message', floor: 12, messageIndex: 12,
        text: '她把铜钥匙放在门旁。', digest: 'digest:1', sourceChanged: false,
        highlights: [{ start: 0, end: 8, text: '她把铜钥匙放在' }],
      },
    }));
    expect(html).toContain('候选内容');
    expect(html).toContain('已拒绝');
    expect(html).toContain('拒绝记录');
    expect(html).toContain('role="tab" aria-selected="true"');
    expect(html).toContain('stx-memory-candidate-evidence-mark');
    expect(html).toContain('<details class="stx-memory-candidate-collapsible">');
    expect(html).toContain('跳转到聊天消息 #12');
    expect(html).not.toContain('data-candidate-filter="status"');
    expect(html).not.toContain('role="progressbar"');
  });

  it('切换候选时不显示旧原文，导航只指向当前加载的相邻记录', () => {
    const second = { ...candidate, id: 'candidate:2', summary: '<script>新候选</script>' };
    const container = document.createElement('div');
    container.innerHTML = renderMemoryCandidatesView(state({
      candidates: [candidate, second], selectedId: second.id, selectedSourceRef: 'message:12', missingSnapshot: false,
      sourcePreview: { candidateId: candidate.id, sourceRef: 'message:12', sourceKind: 'message', floor: 12, text: '旧候选原文', digest: 'digest:1', sourceChanged: false, highlights: [] },
    }));
    expect(container.querySelector('.stx-memory-candidate-source')?.textContent).not.toContain('旧候选原文');
    expect(container.querySelector('script')).toBeNull();
    const navigation = container.querySelectorAll<HTMLButtonElement>('.stx-memory-candidate-footer [data-action="select-memory-candidate"]');
    expect(navigation[0]?.dataset.candidateId).toBe(candidate.id);
    expect(navigation[0]?.disabled).toBe(false);
    expect(navigation[1]?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-action="jump-to-message"]')?.dataset.messageIndex).toBe('12');
  });
});
