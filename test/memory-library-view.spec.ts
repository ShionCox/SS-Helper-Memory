import { describe, expect, it } from 'vitest';
import {
  renderMemoryLibraryView,
  selectMemoryLibraryView,
  type MemoryLibraryFact,
  type MemoryLibraryViewState,
} from '../src/ui/memory-library-view';

const facts: MemoryLibraryFact[] = [
  {
    id: 'fact:state:v2',
    kind: 'state',
    status: 'active',
    content: '当前状态稳定',
    confidence: 0.91,
    sourceRefs: ['message:18'],
    evidence: [{ sourceRef: 'message:18', excerpt: '状态已经稳定。' }],
    supersedesId: 'fact:state:v1',
    auditBatches: [{ jobId: 'job:1', batchIndex: 2, status: 'completed' }],
    updatedAt: 20,
  },
  {
    id: 'fact:event',
    kind: 'event',
    status: 'pending',
    content: '等待确认的事件',
    confidence: 0.62,
    sourceRefs: ['worldbook:rules:entry-1'],
    evidence: [],
    updatedAt: 30,
  },
  {
    id: 'fact:state:v1',
    kind: 'state',
    status: 'superseded',
    content: '旧状态',
    confidence: 0.7,
    sourceRefs: ['message:12'],
    evidence: [{ sourceRef: 'message:12', excerpt: '旧状态证据。' }],
    supersededById: 'fact:state:v2',
    updatedAt: 10,
  },
];

function viewState(overrides: Partial<MemoryLibraryViewState> = {}): MemoryLibraryViewState {
  return {
    allFacts: facts,
    queryFacts: facts,
    query: '',
    selectedKinds: ['state', 'event'],
    selectedStatuses: ['active', 'pending', 'superseded'],
    openFilter: '',
    sort: 'updated_desc',
    selectedFactId: 'fact:state:v2',
    editingFactId: '',
    confirmFactId: '',
    busyAction: '',
    chatLabel: '测试聊天',
    ...overrides,
  };
}

const renderOptions = {
  kindLabels: { state: '状态', event: '事件' },
  statusLabels: { active: '有效', pending: '待确认', superseded: '已替代' },
  formatTime: (value: number) => `time:${value}`,
  formatSource: (value: string) => `<button data-source="${value}">${value}</button>`,
  translateRecordStatus: (value: string) => value === 'completed' ? '已完成' : value,
};

describe('记忆块 V3 视图', () => {
  it('统计始终基于完整事实集，搜索结果只影响列表', () => {
    const selection = selectMemoryLibraryView(viewState({
      query: '状态',
      queryFacts: [facts[0]!],
    }));

    expect(selection.metrics).toEqual({
      total: 3,
      active: 1,
      pending: 1,
      evidenceCoverage: 67,
    });
    expect(selection.visibleFacts.map(fact => fact.id)).toEqual(['fact:state:v2']);
    expect(selection.kindCounts).toEqual({ state: 2, event: 1 });
  });

  it('筛选后稳定选择首条可见事实并提供上下条导航', () => {
    const selection = selectMemoryLibraryView(viewState({
      selectedFactId: 'missing',
      sort: 'confidence_desc',
    }));

    expect(selection.selected?.id).toBe('fact:state:v2');
    expect(selection.previous).toBeUndefined();
    expect(selection.next?.id).toBe('fact:state:v1');
  });

  it('渲染指标、快速范围、版本链、来源与 SDK 控件契约', () => {
    const markup = renderMemoryLibraryView(viewState(), renderOptions);

    expect(markup).toContain('stx-memory-library-metrics');
    expect(markup).toContain('stx-memory-library-scope-panel');
    expect(markup).toContain('上一版本');
    expect(markup).toContain('当前版本');
    expect(markup).toContain('来源与证据');
    expect(markup).toContain('捕获记录');
    expect(markup).toContain('data-action="refresh-library"');
    expect(markup).toContain('data-ss-helper-control="select"');
    expect(markup).toContain('data-ss-helper-control="progress"');
    expect(markup).toContain('data-source="message:18"');
    expect(markup).not.toContain('雾港旧站');
  });
});
