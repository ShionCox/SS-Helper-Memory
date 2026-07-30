import type {
  ChatMessageActionRegistration,
  ChatMessageActionTarget,
  ChatMessageActionUiContext,
  HostCapability,
  PluginSession,
} from '@ss-helper/sdk';
import {
  stableMemoryRecordKey,
  type GenerationPromptSnapshotPayload,
  type GenerationRecallCandidateDetail,
  type GenerationRecallDetail,
  type GenerationRecallLookupTarget,
  type GenerationRecallOwnerDetail,
} from '../domain';
import '../ui/message-recall-detail.css';
import { startMemoryPerformanceSpan } from '../host/runtime-feedback';

const MESSAGE_ACTION_LOOKUP_BATCH_SIZE = 4;

export interface GenerationRecallDetailController {
  findGenerationRecallDetails(workspaceId: string, chatKey: string, targets: readonly GenerationRecallLookupTarget[], signal?: AbortSignal): Promise<GenerationRecallDetail[]>;
  loadGenerationPromptSnapshot?(workspaceId: string, chatKey: string, snapshotId: string, signal?: AbortSignal): Promise<GenerationPromptSnapshotPayload | undefined>;
  onOverviewChanged(listener: () => void): () => void;
  onGenerationRecallDetailsChanged?(listener: (kind: 'updated' | 'cleared') => void): () => void;
}

type RecallTab = 'injected' | 'candidates' | 'prompt';

interface CandidateRow {
  readonly key: string;
  readonly attemptLabels: readonly string[];
  readonly owner: GenerationRecallOwnerDetail;
  readonly owners: readonly GenerationRecallOwnerDetail[];
  readonly candidate: GenerationRecallCandidateDetail;
}

interface InjectedRow {
  readonly key: string;
  readonly owner: GenerationRecallOwnerDetail;
  readonly packet: GenerationRecallOwnerDetail['packets'][number];
  readonly candidate?: GenerationRecallCandidateDetail;
}

function element<K extends keyof HTMLElementTagNameMap>(document: Document, tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function variantMatches(detail: GenerationRecallDetail, target: ChatMessageActionTarget): boolean {
  return (detail.variantId ?? '') === (target.message.variantId ?? '');
}

function matchDetail(details: readonly GenerationRecallDetail[], target: ChatMessageActionTarget): GenerationRecallDetail | undefined {
  if (target.message.role !== 'assistant') return undefined;
  const fingerprint = stableMemoryRecordKey(target.message.text);
  const eligible = (detail: GenerationRecallDetail): boolean => detail.previewState !== 'invalidated'
    && detail.outputFingerprint === fingerprint && variantMatches(detail, target);
  const messageIds = new Set([target.message.stableId, target.message.id].filter((value): value is string => Boolean(value)));
  return details.find(detail => messageIds.has(detail.messageId) && eligible(detail))
    ?? details.find(detail => detail.messageCreatedAt !== undefined && detail.messageCreatedAt === target.message.createdAt && eligible(detail))
    ?? details.find(detail => detail.messageIndex === target.message.index && eligible(detail));
}

function candidateRows(detail: GenerationRecallDetail): CandidateRow[] {
  const rows = new Map<string, CandidateRow>();
  const stateRank = { injected: 3, selected_not_injected: 2, not_selected: 1 } as const;
  const maximum = (left: number | undefined, right: number | undefined): number | undefined => left === undefined ? right : right === undefined ? left : Math.max(left, right);
  for (const attempt of detail.attempts) {
    const label = attempt.kind === 'primary' ? '基础召回' : '覆盖扩展';
    const ownerById = new Map(attempt.owners.map(owner => [owner.ownerId, owner]));
    for (const owner of attempt.owners) {
      for (const candidate of owner.candidates) {
        const applicableOwners = (candidate.applicableOwnerIds ?? [owner.ownerId])
          .map(ownerId => ownerById.get(ownerId))
          .filter((item): item is GenerationRecallOwnerDetail => item !== undefined);
        const existing = rows.get(candidate.factId);
        if (!existing) {
          rows.set(candidate.factId, { key: candidate.factId, attemptLabels: [label], owner, owners: applicableOwners.length > 0 ? applicableOwners : [owner], candidate });
          continue;
        }
        const owners = [...new Map([...existing.owners, ...applicableOwners, owner].map(item => [item.ownerId, item])).values()];
        const preferred = stateRank[candidate.state] > stateRank[existing.candidate.state] ? candidate : existing.candidate;
        rows.set(candidate.factId, {
          ...existing,
          attemptLabels: [...new Set([...existing.attemptLabels, label])],
          owners,
          candidate: {
            ...preferred,
            applicableOwnerIds: [...new Set([...(existing.candidate.applicableOwnerIds ?? []), ...(candidate.applicableOwnerIds ?? [])])],
            traceIds: [...new Set([...existing.candidate.traceIds, ...candidate.traceIds])],
            sourceFloors: [...new Set([...existing.candidate.sourceFloors, ...candidate.sourceFloors])].sort((left, right) => left - right),
            score: Math.max(existing.candidate.score, candidate.score),
            selected: existing.candidate.selected || candidate.selected,
            reasonCodes: [...new Set([...existing.candidate.reasonCodes, ...candidate.reasonCodes])],
            ...(maximum(existing.candidate.lexicalScore, candidate.lexicalScore) === undefined ? {} : { lexicalScore: maximum(existing.candidate.lexicalScore, candidate.lexicalScore) }),
            ...(maximum(existing.candidate.vectorScore, candidate.vectorScore) === undefined ? {} : { vectorScore: maximum(existing.candidate.vectorScore, candidate.vectorScore) }),
            ...(maximum(existing.candidate.graphScore, candidate.graphScore) === undefined ? {} : { graphScore: maximum(existing.candidate.graphScore, candidate.graphScore) }),
            ...(maximum(existing.candidate.fusionScore, candidate.fusionScore) === undefined ? {} : { fusionScore: maximum(existing.candidate.fusionScore, candidate.fusionScore) }),
            ...(maximum(existing.candidate.rerankScore, candidate.rerankScore) === undefined ? {} : { rerankScore: maximum(existing.candidate.rerankScore, candidate.rerankScore) }),
          },
        });
      }
    }
  }
  return [...rows.values()].sort((left, right) => right.candidate.score - left.candidate.score || left.key.localeCompare(right.key));
}

function finalOwners(detail: GenerationRecallDetail): readonly GenerationRecallOwnerDetail[] {
  return (detail.attempts.find(attempt => attempt.final) ?? detail.attempts.at(-1))?.owners ?? [];
}

function injectedRows(detail: GenerationRecallDetail): InjectedRow[] {
  const included = new Set(detail.prompt.includedTraceIds);
  const rows = finalOwners(detail).flatMap(owner => owner.packets
    .filter(packet => included.has(packet.traceId))
    .map(packet => ({
      key: `${owner.ownerId}:${packet.traceId}`, owner, packet,
      candidate: owner.candidates.find(candidate => candidate.traceIds.includes(packet.traceId)),
    })));
  return [...new Map(rows.map(row => [row.packet.factId, row])).values()];
}

function injectedOwners(rows: readonly InjectedRow[]): readonly GenerationRecallOwnerDetail[] {
  return [...new Map(rows.map(row => [row.owner.ownerId, row.owner])).values()];
}

function candidateCount(detail: GenerationRecallDetail): number { return detail.uniqueCandidateCount ?? candidateRows(detail).length; }
function sourceLabel(row: CandidateRow | InjectedRow): string {
  const candidate = 'candidate' in row ? row.candidate : undefined;
  if (candidate?.rerankScore !== undefined) return '重排';
  if ((candidate?.graphScore ?? 0) > 0) return '图谱';
  if ((candidate?.vectorScore ?? 0) > 0) return '向量';
  return '基础';
}
function score(value: number | undefined): string { return value === undefined ? '—' : value.toFixed(3); }
function scoreSummary(candidate: GenerationRecallCandidateDetail | undefined): string {
  if (!candidate) return '排序分 —';
  if (candidate.rerankScore === undefined) return `排序分 ${score(candidate.score)}`;
  return `模型主导 ${score(candidate.score)} · 模型原始 ${score(candidate.rerankScore)}`;
}

function memoryFormLabel(owner: GenerationRecallOwnerDetail, strength: number): string {
  if (owner.role === 'world' || owner.role === 'narrator') return '系统完整记忆';
  if (strength >= 85) return '角色完整记忆';
  if (strength >= 45) return '角色摘要';
  if (strength >= 25) return '角色片段';
  return '模糊印象';
}

function addFloorButtons(document: Document, host: HTMLElement, floors: readonly number[], ui: ChatMessageActionUiContext, navigate: (floor: number) => Promise<void>): void {
  for (const floor of [...new Set(floors)].sort((a, b) => a - b)) {
    const button = ui.createButton({ label: `第 ${floor} 层`, icon: 'arrow-up-right-from-square', size: 'xs' });
    button.addEventListener('click', () => { ui.close(); void navigate(floor); });
    host.append(button);
  }
}

function renderRecallDetail(
  container: HTMLElement,
  target: ChatMessageActionTarget,
  detail: GenerationRecallDetail,
  ui: ChatMessageActionUiContext,
  navigate: (floor: number) => Promise<void>,
  loadSnapshot: (signal: AbortSignal) => Promise<GenerationPromptSnapshotPayload | undefined>,
  notify: (message: string, tone?: 'success' | 'error') => void,
): () => void {
  const document = container.ownerDocument;
  const controller = new AbortController();
  const cleanups: Array<() => void> = [() => controller.abort()];
  container.replaceChildren();
  container.className = 'stx-recall-preview';
  const legacyHeading = element(document, 'span', 'stx-recall-preview-sr-only', '本层记忆召回');
  const actualRows = injectedRows(detail);
  const actualOwners = injectedOwners(actualRows);
  const actorOwners = actualOwners.filter(owner => owner.role === 'actor' || owner.role === 'player');
  const fixedOwners = actualOwners.filter(owner => owner.role === 'world' || owner.role === 'narrator');

  const summary = element(document, 'section', 'stx-recall-preview-summary');
  const query = detail.querySummary?.trim() || '未保存查询摘要';
  const summaryItems = [
    ['当前查询', query],
    ['涉及角色', `${actorOwners.length} 个`],
    ['固定分区', `${fixedOwners.length} 个`],
    ['发送记忆', `${detail.injectedUniqueCount ?? actualRows.length} 条`],
    ['字符预算', `${detail.prompt.usedChars} / ${detail.prompt.maxChars}`],
  ];
  for (const [label, value] of summaryItems) {
    const item = element(document, 'div', 'stx-recall-preview-summary-item');
    item.append(element(document, 'span', '', label), element(document, 'strong', '', value));
    summary.append(item);
  }
  if (detail.outputFingerprint !== stableMemoryRecordKey(target.message.text)) {
    summary.append(element(document, 'p', 'stx-recall-preview-warning', '回复已编辑；这里仍显示生成当时的只读召回快照。'));
  }

  const tabs = element(document, 'nav', 'stx-recall-preview-tabs');
  tabs.setAttribute('aria-label', '召回预览页面');
  const body = element(document, 'div', 'stx-recall-preview-body');
  const footer = element(document, 'footer', 'stx-recall-preview-footer');
  footer.append(
    element(document, 'span', '', '只读快照 · 发送给 AI 不代表模型最终采用'),
    element(document, 'span', '', `评估 ${detail.candidateOccurrenceCount ?? detail.attempts.reduce((sum, attempt) => sum + attempt.candidateCount, 0)} 次 · ${detail.attempts.length} 轮`),
    element(document, 'span', '', `${detail.attempts.reduce((sum, attempt) => sum + attempt.elapsedMs, 0)} ms`),
    element(document, 'span', '', `预算 ${detail.prompt.usedChars}/${detail.prompt.maxChars}`),
    element(document, 'span', '', detail.coverage.covered ? '覆盖完整' : '覆盖不足'),
  );
  container.append(legacyHeading, summary, tabs, body, footer);

  let bodyCleanup = (): void => undefined;
  let current: RecallTab = 'injected';
  const tabButtons = new Map<RecallTab, HTMLButtonElement>();
  const resetBody = (): void => { bodyCleanup(); bodyCleanup = () => undefined; body.replaceChildren(); };

  const renderInjected = (): void => {
    resetBody();
    const allRows = actualRows;
    if (allRows.length === 0) { body.append(element(document, 'div', 'stx-recall-preview-empty', '本层没有记忆进入最终请求。')); return; }
    const toolbar = element(document, 'div', 'stx-recall-preview-toolbar');
    const search = ui.createInput({ label: '搜索实际召回', type: 'search', placeholder: '搜索角色或词条' });
    let source = 'all';
    const select = ui.createSelect({ label: '召回来源', value: source, options: [
      { value: 'all', label: '全部来源' }, { value: '基础', label: '基础召回' }, { value: '向量', label: '向量召回' }, { value: '图谱', label: '图谱召回' }, { value: '重排', label: '重排结果' },
    ], onChange: value => { source = value; update(); } });
    const collapse = ui.createButton({ label: '全部收起', icon: 'angles-up', size: 'sm' });
    const chips = element(document, 'div', 'stx-recall-preview-chips');
    let owner = 'all';
    for (const [id, name] of [['all', '全部分区'], ...actualOwners.map(item => [item.ownerId, `${item.ownerName}${item.role === 'world' || item.role === 'narrator' ? '（固定）' : ''}`])]) {
      const chip = ui.createButton({ label: name, size: 'xs', tone: id === owner ? 'primary' : 'neutral' });
      chip.dataset.ownerId = id; chip.addEventListener('click', () => { owner = id; update(); }); chips.append(chip);
    }
    toolbar.append(search, select, collapse);
    const listHost = element(document, 'div', 'stx-recall-preview-list');
    body.append(toolbar, chips, listHost);
    const expandedKeys = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let handle: ReturnType<typeof ui.mountList> | undefined;
    const update = (): void => {
      const queryText = search.value.trim().toLocaleLowerCase();
      chips.querySelectorAll<HTMLButtonElement>('button').forEach(button => button.dataset.active = String(button.dataset.ownerId === owner));
      const rows = allRows.filter(row => (owner === 'all' || row.owner.ownerId === owner)
        && (source === 'all' || sourceLabel(row) === source)
        && (!queryText || `${row.owner.ownerName}\n${row.packet.gist}\n${row.packet.details.map(item => item.text).join('\n')}`.toLocaleLowerCase().includes(queryText)));
      handle = ui.mountList(listHost, {
        id: 'generation-recall-injected', ariaLabel: '发送给 AI 的记忆列表', queryKey: JSON.stringify([detail.id, owner, source, queryText]),
        loadPage: async ({ cursor, limit, signal }) => { if (signal.aborted) throw signal.reason; const offset = Number(cursor ?? 0); const items = rows.slice(offset, offset + limit); return { items, nextCursor: offset + items.length < rows.length ? String(offset + items.length) : null, total: rows.length }; },
        getKey: row => row.key,
        renderItem: row => {
          const card = element(document, 'details', 'stx-recall-preview-card is-injected');
          card.open = expandedKeys.has(row.key);
          const heading = element(document, 'summary', 'stx-recall-preview-card-heading');
          const title = element(document, 'div');
          title.append(element(document, 'strong', '', row.owner.ownerName), element(document, 'span', '', row.candidate?.factKind ?? '记忆'));
          const badges = element(document, 'div', 'stx-recall-preview-badges');
          badges.append(
            element(document, 'span', 'is-success', '已注入'),
            element(document, 'span', '', memoryFormLabel(row.owner, row.packet.effectiveStrength)),
            element(document, 'span', '', sourceLabel(row)),
          );
          heading.append(title, badges);
          const gist = element(document, 'p', 'stx-recall-preview-gist', row.packet.gist);
          const compact = element(document, 'div', 'stx-recall-preview-compact', `强度 ${row.packet.effectiveStrength.toFixed(1)} · 清晰度 ${row.packet.clarity.toFixed(2)} · ${scoreSummary(row.candidate)}`);
          const expanded = element(document, 'div', 'stx-recall-preview-expanded');
          if (row.packet.details.length > 0) {
            const list = element(document, 'ul'); row.packet.details.forEach(item => list.append(element(document, 'li', '', item.text))); expanded.append(list);
          }
          expanded.append(element(document, 'p', '', `权限 ${row.owner.permission ?? '默认'} · 层级 ${row.owner.retrievalLevel ?? '—'} · 路径 ${(row.owner.retrievalStages ?? [sourceLabel(row)]).join(' → ')}`));
          const scores = element(document, 'div', 'stx-recall-preview-score-grid');
          for (const [label, value] of [['基础', row.candidate?.lexicalScore], ['向量', row.candidate?.vectorScore], ['图谱', row.candidate?.graphScore], ['融合', row.candidate?.fusionScore], ['模型原始', row.candidate?.rerankScore], [row.candidate?.rerankScore === undefined ? '排序分' : '模型主导', row.candidate?.score]] as const) {
            const cell = element(document, 'div'); cell.append(element(document, 'span', '', label), element(document, 'strong', '', score(value))); scores.append(cell);
          }
          expanded.append(scores);
          const actions = element(document, 'div', 'stx-recall-preview-actions');
          addFloorButtons(document, actions, row.candidate?.sourceFloors ?? [], ui, navigate);
          const promptButton = ui.createButton({ label: '查看发送内容', icon: 'paper-plane', size: 'xs' }); promptButton.addEventListener('click', () => switchTo('prompt')); actions.append(promptButton); expanded.append(actions);
          card.append(heading, gist, compact, expanded);
          card.addEventListener('click', (event) => {
            const target = event.target as HTMLElement;
            if (target.closest('button, a, input, select, textarea')) return;
            event.preventDefault();
            const next = !expandedKeys.has(row.key);
            if (next) expandedKeys.add(row.key); else expandedKeys.delete(row.key);
            card.open = next;
          });
          const rowHost = element(document, 'div', 'stx-recall-preview-row');
          rowHost.append(card);
          return rowHost;
        }, pageSize: 20, overscan: 4, maxCachedPages: 4, estimatedItemHeight: 152, emptyLabel: '没有符合条件的实际召回', loadingLabel: '正在加载召回…', errorLabel: '召回加载失败，按 Enter 重试',
      });
    };
    const onInput = (): void => { if (timer) clearTimeout(timer); timer = setTimeout(update, 100); };
    const onCollapse = (): void => { expandedKeys.clear(); listHost.querySelectorAll<HTMLDetailsElement>('details[open]').forEach(item => item.open = false); };
    search.addEventListener('input', onInput); collapse.addEventListener('click', onCollapse); update();
    bodyCleanup = () => { if (timer) clearTimeout(timer); search.removeEventListener('input', onInput); collapse.removeEventListener('click', onCollapse); handle?.dispose(); };
  };

  const renderCandidates = (): void => {
    resetBody();
    const allRows = candidateRows(detail);
    const injectedFormByFact = new Map(injectedRows(detail).map(row => [row.packet.factId, memoryFormLabel(row.owner, row.packet.effectiveStrength)]));
    const toolbar = element(document, 'div', 'stx-recall-preview-toolbar is-candidates');
    const search = ui.createInput({ label: '搜索候选', type: 'search', placeholder: '搜索角色、词条或原因' });
    let owner = 'all'; let state = 'all'; let source = 'all';
    const candidateOwners = [...new Map(allRows.flatMap(row => row.owners).map(item => [item.ownerId, item])).values()];
    const ownerSelect = ui.createSelect({ label: '角色/分区', value: owner, options: [{ value: 'all', label: '全部角色与分区' }, ...candidateOwners.map(item => ({ value: item.ownerId, label: `${item.ownerName}${item.role === 'world' || item.role === 'narrator' ? '（固定）' : ''}` }))], onChange: value => { owner = value; update(); } });
    const stateSelect = ui.createSelect({ label: '状态', value: state, options: [{ value: 'all', label: '全部状态' }, { value: 'injected', label: '已注入' }, { value: 'selected_not_injected', label: '预算省略' }, { value: 'not_selected', label: '未采用' }], onChange: value => { state = value; update(); } });
    const sourceSelect = ui.createSelect({ label: '来源', value: source, options: [{ value: 'all', label: '全部来源' }, { value: '基础', label: '基础' }, { value: '向量', label: '向量' }, { value: '图谱', label: '图谱' }, { value: '重排', label: '重排' }], onChange: value => { source = value; update(); } });
    toolbar.append(search, ownerSelect, stateSelect, sourceSelect);
    const count = element(document, 'div', 'stx-recall-preview-count');
    const listHost = element(document, 'div', 'stx-recall-preview-list');
    body.append(toolbar, count, listHost);
    let timer: ReturnType<typeof setTimeout> | undefined; let handle: ReturnType<typeof ui.mountList> | undefined;
    const update = (): void => {
      const queryText = search.value.trim().toLocaleLowerCase();
      const rows = allRows.filter(row => (owner === 'all' || row.owners.some(item => item.ownerId === owner)) && (state === 'all' || row.candidate.state === state) && (source === 'all' || sourceLabel(row) === source)
        && (!queryText || `${row.owners.map(item => item.ownerName).join(' ')}\n${row.candidate.summary}\n${row.candidate.reasonCodes.join(' ')}`.toLocaleLowerCase().includes(queryText)));
      count.textContent = `已加载 0 / ${rows.length}`;
      handle = ui.mountList(listHost, {
        id: 'generation-recall-candidates', ariaLabel: '全部召回候选列表', queryKey: JSON.stringify([detail.id, owner, state, source, queryText]),
        loadPage: async ({ cursor, limit, signal }) => { if (signal.aborted) throw signal.reason; const offset = Number(cursor ?? 0); const items = rows.slice(offset, offset + limit); queueMicrotask(() => { count.textContent = `候选 ${rows.length} 条 · 滚动到底继续加载`; }); return { items, nextCursor: offset + items.length < rows.length ? String(offset + items.length) : null, total: rows.length }; },
        getKey: row => row.key,
        renderItem: row => {
          const candidate = row.candidate;
          const card = element(document, 'article', `stx-recall-preview-card is-${candidate.state}`);
          const heading = element(document, 'div', 'stx-recall-preview-card-heading');
          const title = element(document, 'div'); title.append(element(document, 'strong', '', row.owners.map(item => item.ownerName).join('、')), element(document, 'span', '', candidate.factKind ?? '记忆'));
          const stateLabel = candidate.state === 'injected' ? '已注入' : candidate.state === 'selected_not_injected' ? '预算省略' : '未采用';
          const badges = element(document, 'div', 'stx-recall-preview-badges');
          badges.append(element(document, 'span', candidate.state === 'injected' ? 'is-success' : '', stateLabel));
          const formLabel = injectedFormByFact.get(candidate.factId);
          if (formLabel) badges.append(element(document, 'span', '', formLabel));
          badges.append(element(document, 'span', '', sourceLabel(row)));
          heading.append(title, badges);
          card.append(heading, element(document, 'p', 'stx-recall-preview-gist', candidate.summary || '没有可显示的摘要。'), element(document, 'div', 'stx-recall-preview-compact', `${row.attemptLabels.join('、')} · ${scoreSummary(candidate)} · ${[...candidate.reasonCodes, candidate.omittedReason].filter(Boolean).join(' · ') || '无附加原因'}`));
          const actions = element(document, 'div', 'stx-recall-preview-actions'); addFloorButtons(document, actions, candidate.sourceFloors, ui, navigate); card.append(actions);
          const rowHost = element(document, 'div', 'stx-recall-preview-row');
          rowHost.append(card);
          return rowHost;
        }, pageSize: 20, overscan: 4, maxCachedPages: 4, estimatedItemHeight: 128, emptyLabel: '没有符合条件的候选', loadingLabel: '正在加载候选…', errorLabel: '候选加载失败，按 Enter 重试',
      });
    };
    const onInput = (): void => { if (timer) clearTimeout(timer); timer = setTimeout(update, 100); }; search.addEventListener('input', onInput); update();
    bodyCleanup = () => { if (timer) clearTimeout(timer); search.removeEventListener('input', onInput); handle?.dispose(); };
  };

  const renderPrompt = (): void => {
    resetBody();
    const loading = element(document, 'div', 'stx-recall-preview-empty', '正在读取并校验发送快照…'); body.append(loading);
    void loadSnapshot(controller.signal).then((snapshot) => {
      if (controller.signal.aborted || current !== 'prompt') return;
      body.replaceChildren();
      if (!snapshot) { body.append(element(document, 'div', 'stx-recall-preview-empty', '这是一条历史记录，生成时尚未启用请求快照，因此没有可展示的发送内容。新生成的回复会保存 Memory 注入和完整请求。')); return; }
      const mode = element(document, 'div', 'stx-recall-preview-prompt-switch');
      const viewport = element(document, 'pre', 'stx-recall-preview-prompt-content');
      let wrap = true;
      const values = new Map<string, string>();
      values.set('memory', snapshot.manifest.memoryInjection || '本轮没有写入 Memory 注入文本。');
      if (snapshot.request?.kind === 'chat') values.set('full', JSON.stringify(snapshot.request.messages, null, 2));
      else if (snapshot.request?.kind === 'text') values.set('full', snapshot.request.prompt);
      const copy = ui.createButton({ label: '复制', icon: 'copy', size: 'sm' });
      const wrapping = ui.createButton({ label: '自动换行', icon: 'text-width', size: 'sm' });
      let selected = 'memory';
      const setSelected = (value: string): void => { selected = value; viewport.textContent = values.get(value) ?? ''; mode.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => button.dataset.active = String(button.dataset.mode === value)); };
      for (const [id, label] of [['memory', 'Memory 注入'], ['full', snapshot.request?.kind === 'text' ? '完整文本 Prompt' : '完整消息结构']]) {
        const button = ui.createButton({ label, size: 'sm' }); button.dataset.mode = id; button.disabled = !values.has(id); button.addEventListener('click', () => setSelected(id)); mode.append(button);
      }
      copy.addEventListener('click', () => { void ui.copyText(values.get(selected) ?? '').then(() => notify('已复制到剪贴板', 'success')).catch(() => notify('复制失败，请检查浏览器权限', 'error')); });
      wrapping.addEventListener('click', () => { wrap = !wrap; viewport.dataset.wrap = String(wrap); wrapping.setAttribute('aria-pressed', String(wrap)); });
      mode.append(wrapping, copy); body.append(mode);
      if (snapshot.manifest.captureStatus !== 'available') body.append(element(document, 'div', 'stx-recall-preview-warning', snapshot.manifest.captureStatus === 'too_large' ? '完整请求超过 8 MiB，未保存；Memory 注入仍准确保留。' : '宿主未提供最终请求快照；Memory 注入仍准确保留。'));
      else if (!snapshot.manifest.verifiedIncludesMemory) body.append(element(document, 'div', 'stx-recall-preview-warning', '最终宿主快照中未验证包含 Memory 注入；不会拼接或伪造完整请求。'));
      body.append(viewport); setSelected('memory');
    }).catch(() => { if (!controller.signal.aborted) { body.replaceChildren(element(document, 'div', 'stx-recall-preview-empty', '发送快照校验失败，内容未展示。')); } });
  };

  const switchTo = (next: RecallTab): void => {
    current = next; tabButtons.forEach((button, id) => { button.setAttribute('aria-selected', String(id === next)); button.dataset.active = String(id === next); });
    if (next === 'injected') renderInjected(); else if (next === 'candidates') renderCandidates(); else renderPrompt();
  };
  for (const [id, label, icon, count] of [
    ['injected', '发送给 AI', 'bolt', detail.injectedUniqueCount ?? actualRows.length],
    ['candidates', '全部候选', 'layer-group', candidateCount(detail)],
    ['prompt', '发送内容', 'paper-plane', detail.promptSnapshot ? (detail.promptSnapshot.captureStatus === 'available' ? 2 : 1) : 0],
  ] as const) {
    const button = ui.createButton({ label, icon, size: 'sm' });
    button.append(element(document, 'span', 'stx-recall-preview-tab-count', String(count)));
    if (id === 'prompt' && !detail.promptSnapshot) button.title = '历史记录未保存请求快照';
    button.setAttribute('role', 'tab'); button.addEventListener('click', () => switchTo(id)); tabButtons.set(id, button); tabs.append(button);
  }
  switchTo('injected');
  return () => { bodyCleanup(); while (cleanups.length > 0) cleanups.pop()?.(); container.classList.remove('stx-recall-preview'); };
}

export function registerMemoryMessageRecallAction<Capabilities extends HostCapability>(session: PluginSession<Capabilities>, controller: GenerationRecallDetailController, navigate: (floor: number) => Promise<void>): () => void {
  const matched = new Map<string, GenerationRecallDetail>();
  const availability = new Map<string, GenerationRecallDetail | null>();
  const pending = new Map<string, Promise<void>>();
  let publishResolution: ((targetKeys?: readonly string[]) => void) | undefined;
  let lookupRevision = 0;
  const invalidateStaleTargets = (targets: readonly ChatMessageActionTarget[]): void => {
    for (const target of targets) {
      const detail = availability.get(target.key);
      if (detail && matchDetail([detail], target) === undefined) {
        availability.delete(target.key);
        matched.delete(target.key);
      }
    }
  };
  const startLookup = (targets: readonly ChatMessageActionTarget[], signal?: AbortSignal): void => {
    const scope = targets.find(target => target.message.role === 'assistant'); if (!scope) return;
    const selected = targets
      .filter(target => target.message.role === 'assistant' && target.workspaceId === scope.workspaceId && target.chatKey === scope.chatKey && !availability.has(target.key) && !pending.has(target.key))
      .sort((left, right) => right.message.index - left.message.index)
      .slice(0, MESSAGE_ACTION_LOOKUP_BATCH_SIZE);
    if (selected.length === 0) return;
    const finishLookup = startMemoryPerformanceSpan('recall-button.lookup');
    const keys = selected.map(target => target.key); const revision = lookupRevision;
    const lookupTargets = selected.map(target => ({ messageIds: [...new Set([target.message.stableId, target.message.id].filter((value): value is string => Boolean(value)))], messageIndex: target.message.index, ...(target.message.createdAt === undefined ? {} : { messageCreatedAt: target.message.createdAt }), ...(target.message.variantId === undefined ? {} : { variantId: target.message.variantId }) }));
    const request = controller.findGenerationRecallDetails(scope.workspaceId, scope.chatKey, lookupTargets, signal).then((details) => {
      finishLookup(signal?.aborted ? 'aborted' : 'success');
      if (signal?.aborted || lookupRevision !== revision) return;
      for (const target of selected) { const detail = matchDetail(details, target); availability.set(target.key, detail ?? null); if (detail) matched.set(target.key, detail); else matched.delete(target.key); }
    }).catch(() => { finishLookup(signal?.aborted ? 'aborted' : 'error'); if (!signal?.aborted && lookupRevision === revision) for (const target of selected) { availability.set(target.key, null); matched.delete(target.key); } }).finally(() => { for (const key of keys) if (pending.get(key) === request) pending.delete(key); if (!signal?.aborted && lookupRevision === revision) publishResolution?.(keys); });
    keys.forEach(key => pending.set(key, request));
  };
  const registration: ChatMessageActionRegistration = {
    id: 'generation-recall-detail', label: '查看本层召回', icon: 'brain', order: 20,
    presentation: { kind: 'window', initialWidth: 680, initialHeight: 610, minWidth: 520, minHeight: 420, draggable: true, resizable: true, minimizable: true, persistKey: 'memory-recall-preview' },
    subscribe: (listener) => {
      publishResolution = listener;
      const subscribe = controller.onGenerationRecallDetailsChanged?.bind(controller)
        ?? ((_listener: (kind: 'updated' | 'cleared') => void) => controller.onOverviewChanged(() => _listener('cleared')));
      const unsubscribe = subscribe((kind) => {
        lookupRevision += 1;
        pending.clear();
        if (kind === 'cleared') { matched.clear(); availability.clear(); }
        else for (const [key, detail] of availability) if (detail === null) availability.delete(key);
        listener();
      });
      return () => { if (publishResolution === listener) publishResolution = undefined; unsubscribe(); };
    },
    resolve: async (targets, context) => { invalidateStaleTargets(targets); startLookup(targets, context?.signal); return targets.flatMap((target) => {
      if (target.message.role !== 'assistant') return { targetKey: target.key, state: 'hidden' as const };
      const detail = availability.get(target.key); if (detail === null) return { targetKey: target.key, state: 'hidden' as const };
      // Do not publish a terminal hidden state before this target has been
      // queried.  Core intentionally leaves omitted targets uncached, and the
      // completion notification below then advances to the next lookup batch.
      if (!detail) return [];
      const candidates = candidateCount(detail);
      const sent = detail.injectedUniqueCount ?? injectedRows(detail).length;
      const empty = candidates === 0 && sent === 0;
      matched.set(target.key, detail); return { targetKey: target.key, state: 'enabled' as const, ariaLabel: empty ? '查看本层召回：本轮未发送长期记忆' : `查看本层召回：${candidates} 个唯一候选，${sent} 条发送给 AI`, window: { title: `召回预览 · 第 ${detail.triggerFloor} 层`, subtitle: empty ? '本轮未发送长期记忆' : `${candidates} 个唯一候选 · ${sent} 条发送给 AI`, status: empty ? { label: '未发送记忆', tone: 'neutral' } : { label: detail.coverage.covered ? '覆盖完整' : '覆盖不足', tone: detail.coverage.covered ? 'success' : 'warning' } } };
    }) },
    render: async (container, target, ui) => { const finishRender = startMemoryPerformanceSpan('recall-preview.render'); const activeLookup = pending.get(target.key); if (activeLookup) await activeLookup; const detail = matched.get(target.key); if (!detail) { container.textContent = '本层召回详情已更新，请关闭后重试。'; finishRender('error'); return; }
      try { const cleanup = await renderRecallDetail(container, target, detail, ui, navigate, signal => detail.promptSnapshot && controller.loadGenerationPromptSnapshot ? controller.loadGenerationPromptSnapshot(detail.workspaceId, detail.chatKey, detail.promptSnapshot.snapshotId, signal) : Promise.resolve(undefined), (message, tone = 'success') => session.ui.showToast({ title: tone === 'success' ? '操作完成' : '操作失败', message, level: tone })); finishRender(); return cleanup; } catch (error) { finishRender('error'); throw error; } },
  };
  return session.registerChatMessageAction(registration);
}
