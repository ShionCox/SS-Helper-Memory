// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type {
  ChatMessageActionRegistration,
  ChatMessageActionTarget,
  ChatMessageActionUiContext,
  PluginSession,
} from '@ss-helper/sdk';
import { stableMemoryRecordKey, type GenerationRecallDetail, type GenerationRecallLookupTarget } from '../src/domain';
import { registerMemoryMessageRecallAction } from '../src/ss-helper/message-recall-action';

function detail(): GenerationRecallDetail {
  return {
    id: 'generation-recall:1',
    workspaceId: 'character:c1',
    chatKey: 'chat-a',
    planId: 'plan:1',
    messageId: 'message:assistant',
    messageIndex: 3,
    messageCreatedAt: '2026-07-28T00:00:00.000Z',
    variantId: 'swipe:1',
    outputFingerprint: stableMemoryRecordKey('reply'),
    triggerFloor: 3,
    createdAt: 1,
    viewpointOwnerId: 'owner:aerin',
    coverage: {
      covered: true,
      missingSubQueryIds: [],
      missingOwnerIds: [],
      missingTimeDimensions: [],
      privacyViolations: [],
      temporalConflicts: [],
      requiresExpansion: false,
    },
    expanded: false,
    candidateOccurrenceCount: 3,
    uniqueCandidateCount: 2,
    duplicateCandidateCount: 1,
    injectedUniqueCount: 1,
    prompt: {
      maxChars: 4_000,
      usedChars: 240,
      includedCount: 1,
      omittedCount: 1,
      includedTraceIds: ['trace:1'],
      omittedTraceIds: ['trace:2'],
    },
    attempts: [{
      kind: 'primary',
      final: true,
      candidateCount: 3,
      uniqueCandidateCount: 2,
      duplicateCandidateCount: 1,
      selectedCount: 1,
      elapsedMs: 12,
      owners: [{
        ownerId: 'owner:aerin',
        ownerName: '艾琳',
        role: 'actor',
        packets: [{
          traceId: 'trace:1',
          factId: 'fact:1',
          ownerId: 'owner:aerin',
          gist: '艾琳记得地下仓库的位置。',
          details: [{
            id: 'detail:1',
            traceId: 'trace:1',
            text: '入口位于旧礼堂后方。',
            sensitivity: 'detail',
            minStrength: 40,
            sourceFactId: 'fact:1',
          }],
          effectiveStrength: 82,
          clarity: .91,
          deterministicSeed: 'seed:1',
          omittedDetailCount: 0,
        }],
        candidates: [
          {
            factId: 'fact:1',
            traceIds: ['trace:1'],
            sourceFloors: [1],
            summary: '艾琳知道地下仓库的位置。',
            score: .03,
            lexicalScore: .61,
            vectorScore: .35,
            fusionScore: .012,
            rerankScore: .032,
            selected: true,
            state: 'injected',
            reasonCodes: ['semantic_match'],
          },
          {
            factId: 'fact:2',
            traceIds: ['trace:2'],
            sourceFloors: [2],
            summary: '琴乃负责外部侦察。',
            score: .73,
            selected: false,
            state: 'not_selected',
            reasonCodes: ['budget_omitted'],
          },
        ],
      }, {
        ownerId: 'owner:observer',
        ownerName: '旁观者',
        role: 'actor',
        packets: [],
        candidates: [{
          factId: 'fact:1',
          traceIds: ['trace:observer'],
          sourceFloors: [2],
          summary: '旁观者只产生了候选。',
          score: .4,
          selected: false,
          state: 'not_selected',
          reasonCodes: ['not_selected'],
        }],
      }],
    }],
  };
}

function target(): ChatMessageActionTarget {
  return {
    key: 'chat-a:message:assistant:swipe:1',
    workspaceId: 'character:c1',
    chatKey: 'chat-a',
    message: {
      id: 'message:assistant',
      stableId: 'message:assistant',
      index: 3,
      role: 'assistant',
      text: 'reply',
      createdAt: '2026-07-28T00:00:00.000Z',
      variantId: 'swipe:1',
    },
  };
}

function uiContext(): ChatMessageActionUiContext {
  const mountList: ChatMessageActionUiContext['mountList'] = (host, definition) => {
    const list = document.createElement('div');
    list.setAttribute('role', definition.selectable === true ? 'listbox' : 'list');
    host.replaceChildren(list);
    let disposed = false;
    const render = async () => {
      const controller = new AbortController();
      const page = await definition.loadPage({ limit: definition.pageSize ?? 20, signal: controller.signal });
      if (disposed) return;
      list.replaceChildren(...page.items.map((item, index) =>
        definition.renderItem(item, { index, selected: false, focused: false, ...(page.total === undefined ? {} : { setSize: page.total }) })));
    };
    void render();
    return {
      element: list,
      refresh: () => { void render(); },
      scrollToKey: async () => false,
      selectedKey: () => undefined,
      dispose: () => { disposed = true; list.remove(); },
    };
  };
  return {
    createButton: ({ label, ariaLabel }: Parameters<ChatMessageActionUiContext['createButton']>[0]) => {
      const button = document.createElement('button');
      button.textContent = label;
      button.setAttribute('aria-label', ariaLabel ?? label);
      return button;
    },
    createIcon: () => document.createElement('span'),
    createInput: ({ label, value, placeholder, type }: Parameters<ChatMessageActionUiContext['createInput']>[0]) => {
      const input = document.createElement('input');
      input.type = type ?? 'text';
      input.value = value ?? '';
      input.placeholder = placeholder ?? '';
      input.setAttribute('aria-label', label);
      return input;
    },
    createTextarea: () => document.createElement('textarea'),
    createSelect: ({ label, value, options, onChange }: Parameters<ChatMessageActionUiContext['createSelect']>[0]) => {
      const select = document.createElement('select');
      select.setAttribute('aria-label', label);
      for (const option of options) {
        const node = document.createElement('option');
        node.value = option.value;
        node.textContent = option.label;
        select.append(node);
      }
      select.value = value ?? '';
      select.addEventListener('change', () => onChange(select.value));
      return select;
    },
    confirm: async () => true,
    createToggle: () => document.createElement('button'),
    createMenu: () => ({ element: document.createElement('div'), update: () => undefined, dispose: () => undefined }),
    mountList,
    close: vi.fn(),
  } as unknown as ChatMessageActionUiContext;
}

describe('Memory message recall action', () => {
  it('prioritizes the four newest assistant floors and advances later unresolved floors', async () => {
    let registration: ChatMessageActionRegistration | undefined;
    const findGenerationRecallDetails = vi.fn(async (
      _workspaceId: string,
      _chatKey: string,
      _targets: readonly GenerationRecallLookupTarget[],
      _signal?: AbortSignal,
    ) => [] as GenerationRecallDetail[]);
    const session = {
      registerChatMessageAction: (next: ChatMessageActionRegistration) => { registration = next; return () => undefined; },
    } as unknown as PluginSession;
    registerMemoryMessageRecallAction(session, {
      findGenerationRecallDetails,
      onOverviewChanged: () => () => undefined,
    }, async () => undefined);
    const targets = Array.from({ length: 10 }, (_, offset) => {
      const index = offset + 3;
      return {
        ...target(),
        key: `target:${index}`,
        message: { ...target().message, id: `message:${index}`, stableId: `message:${index}`, index },
      } satisfies ChatMessageActionTarget;
    });

    expect(await registration!.resolve(targets)).toEqual([]);
    await vi.waitFor(() => expect(findGenerationRecallDetails).toHaveBeenCalledOnce());
    expect(findGenerationRecallDetails.mock.calls[0]?.[2].map(item => item.messageIndex)).toEqual([12, 11, 10, 9]);
    await registration!.resolve(targets);
    await vi.waitFor(() => expect(findGenerationRecallDetails).toHaveBeenCalledTimes(2));
    expect(findGenerationRecallDetails.mock.calls[1]?.[2].map(item => item.messageIndex)).toEqual([8, 7, 6, 5]);
  });

  it('opens a recall detail window with injected content, diagnostics, and source navigation', async () => {
    let registration: ChatMessageActionRegistration | undefined;
    const session = {
      registerChatMessageAction: (next: ChatMessageActionRegistration) => {
        registration = next;
        return () => undefined;
      },
    } as unknown as PluginSession;
    const navigate = vi.fn(async () => undefined);
    const findGenerationRecallDetails = vi.fn(async () => [detail()]);
    registerMemoryMessageRecallAction(
      session,
      {
        findGenerationRecallDetails,
        onOverviewChanged: () => () => undefined,
      },
      navigate,
    );
    const messageTarget = target();
    const resolveController = new AbortController();
    const resolution = await registration!.resolve([messageTarget], { signal: resolveController.signal });
    expect(resolution).toEqual([]);
    expect(findGenerationRecallDetails).toHaveBeenCalledWith('character:c1', 'chat-a', [{
      messageIds: ['message:assistant'],
      messageIndex: 3,
      messageCreatedAt: '2026-07-28T00:00:00.000Z',
      variantId: 'swipe:1',
    }], resolveController.signal);
    await vi.waitFor(async () => {
      await expect(registration!.resolve([messageTarget], { signal: resolveController.signal })).resolves.toEqual([
        expect.objectContaining({ ariaLabel: '查看本层召回：2 个唯一候选，1 条发送给 AI' }),
      ]);
    });

    const container = document.createElement('section');
    const ui = uiContext();
    await registration!.render(container, messageTarget, ui);
    expect(container.textContent).toContain('本层记忆召回');
    expect(container.textContent).toContain('艾琳记得地下仓库的位置');
    expect(container.textContent).toContain('入口位于旧礼堂后方');
    expect(container.textContent).toContain('角色摘要');
    expect(container.textContent).toContain('模型主导 0.030 · 模型原始 0.032');
    expect(container.textContent).not.toContain('最终 0.032');
    expect(container.textContent).toContain('评估 3 次 · 1 轮');
    expect(container.textContent).toContain('预算 240/4000');
    expect(container.textContent).toContain('涉及角色1 个');
    expect(container.textContent).not.toContain('旁观者');
    expect(container.querySelector('.stx-recall-preview-row > .stx-recall-preview-card')).not.toBeNull();
    const recallCard = container.querySelector<HTMLDetailsElement>('.stx-recall-preview-card.is-injected')!;
    recallCard.querySelector<HTMLElement>('.stx-recall-preview-gist')!.click();
    expect(recallCard.open).toBe(true);
    expect(recallCard.textContent).toContain('模型原始0.032');
    expect(recallCard.textContent).toContain('模型主导0.030');
    recallCard.querySelector<HTMLElement>('.stx-recall-preview-gist')!.click();
    expect(recallCard.open).toBe(false);

    const promptTab = [...container.querySelectorAll('button')]
      .find(button => button.getAttribute('aria-label') === '发送内容') as HTMLButtonElement;
    expect(promptTab.title).toBe('历史记录未保存请求快照');
    promptTab.click();
    await vi.waitFor(() => expect(container.textContent).toContain('这是一条历史记录'));
    const actualTab = [...container.querySelectorAll('button')]
      .find(button => button.getAttribute('aria-label') === '发送给 AI') as HTMLButtonElement;
    actualTab.click();

    let sourceButton: HTMLButtonElement | undefined;
    await vi.waitFor(() => {
      sourceButton = [...container.querySelectorAll('button')]
        .find(button => button.textContent === '第 1 层') as HTMLButtonElement | undefined;
      expect(sourceButton).toBeDefined();
    });
    sourceButton!.click();
    expect(ui.close).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith(1);
  });

  it('keeps the same focused candidate search input while filtering multiple characters', async () => {
    let registration: ChatMessageActionRegistration | undefined;
    const session = {
      registerChatMessageAction: (next: ChatMessageActionRegistration) => {
        registration = next;
        return () => undefined;
      },
    } as unknown as PluginSession;
    const disposeRegistration = registerMemoryMessageRecallAction(
      session,
      {
        findGenerationRecallDetails: async () => [detail()],
        onOverviewChanged: () => () => undefined,
      },
      async () => undefined,
    );
    const messageTarget = target();
    await registration!.resolve([messageTarget]);
    const container = document.createElement('div');
    document.body.append(container);
    const disposePanel = await registration!.render(container, messageTarget, uiContext());
    const candidateTab = [...container.querySelectorAll('button')]
      .find(button => button.getAttribute('aria-label') === '全部候选') as HTMLButtonElement;
    candidateTab.click();
    await vi.waitFor(() => expect(container.textContent).toContain('艾琳知道地下仓库的位置'));
    expect(container.textContent).toContain('角色摘要');

    const input = container.querySelector('input[aria-label="搜索候选"]') as HTMLInputElement;
    input.focus();
    input.value = '地';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 110));
    expect(container.querySelector('input[aria-label="搜索候选"]')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(container.textContent).toContain('艾琳知道地下仓库的位置');

    input.value = '地下';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 110));
    expect(container.querySelector('input[aria-label="搜索候选"]')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('地下');
    expect(container.textContent).not.toContain('琴乃负责外部侦察');

    if (typeof disposePanel === 'function') disposePanel();
    disposeRegistration();
    container.remove();
  });

  it('keeps valid recall availability across unrelated overview changes and clears it only on detail reset', async () => {
    let registration: ChatMessageActionRegistration | undefined;
    let detailsChanged: ((kind: 'updated' | 'cleared') => void) | undefined;
    const onOverviewChanged = vi.fn(() => () => undefined);
    const findGenerationRecallDetails = vi.fn(async () => [detail()]);
    const session = {
      registerChatMessageAction: (next: ChatMessageActionRegistration) => { registration = next; return () => undefined; },
    } as unknown as PluginSession;
    registerMemoryMessageRecallAction(session, {
      findGenerationRecallDetails,
      onOverviewChanged,
      onGenerationRecallDetailsChanged: (listener) => { detailsChanged = listener; return () => { detailsChanged = undefined; }; },
    }, async () => undefined);
    const messageTarget = target();
    const unsubscribe = registration!.subscribe!(vi.fn());
    await registration!.resolve([messageTarget]);
    await vi.waitFor(async () => {
      await expect(registration!.resolve([messageTarget])).resolves.toEqual([
        expect.objectContaining({ state: 'enabled' }),
      ]);
    });
    expect(findGenerationRecallDetails).toHaveBeenCalledOnce();
    expect(onOverviewChanged).not.toHaveBeenCalled();

    detailsChanged?.('updated');
    await expect(registration!.resolve([messageTarget])).resolves.toEqual([
      expect.objectContaining({ state: 'enabled' }),
    ]);
    expect(findGenerationRecallDetails).toHaveBeenCalledOnce();

    detailsChanged?.('cleared');
    await expect(registration!.resolve([messageTarget])).resolves.toEqual([]);
    await vi.waitFor(() => expect(findGenerationRecallDetails).toHaveBeenCalledTimes(2));
    unsubscribe?.();
  });

  it('shows the action when a valid recall record has no candidates or injected memory', async () => {
    let registration: ChatMessageActionRegistration | undefined;
    const session = {
      registerChatMessageAction: (next: ChatMessageActionRegistration) => { registration = next; return () => undefined; },
    } as unknown as PluginSession;
    const emptyDetail: GenerationRecallDetail = {
      ...detail(),
      candidateOccurrenceCount: 0,
      uniqueCandidateCount: 0,
      duplicateCandidateCount: 0,
      injectedUniqueCount: 0,
      prompt: { ...detail().prompt, usedChars: 0, includedCount: 0, omittedCount: 0, includedTraceIds: [], omittedTraceIds: [] },
      attempts: [{ ...detail().attempts[0]!, candidateCount: 0, uniqueCandidateCount: 0, duplicateCandidateCount: 0, selectedCount: 0, owners: [] }],
    };
    registerMemoryMessageRecallAction(session, {
      findGenerationRecallDetails: async () => [emptyDetail],
      onOverviewChanged: () => () => undefined,
    }, async () => undefined);
    const messageTarget = target();
    await registration!.resolve([messageTarget]);
    await vi.waitFor(async () => {
      await expect(registration!.resolve([messageTarget])).resolves.toEqual([
        expect.objectContaining({
          targetKey: messageTarget.key,
          state: 'enabled',
          ariaLabel: '查看本层召回：本轮未发送长期记忆',
          window: expect.objectContaining({
            subtitle: '本轮未发送长期记忆',
            status: { label: '未发送记忆', tone: 'neutral' },
          }),
        }),
      ]);
    });
    const container = document.createElement('section');
    await registration!.render(container, messageTarget, uiContext());
    expect(container.textContent).toContain('本层没有记忆进入最终请求。');
  });

  it.each([
    ['invalidated preview', { previewState: 'invalidated' as const }],
    ['changed message body', { outputFingerprint: stableMemoryRecordKey('old reply') }],
  ])('hides the action for %s', async (_label, override) => {
    let registration: ChatMessageActionRegistration | undefined;
    const session = {
      registerChatMessageAction: (next: ChatMessageActionRegistration) => { registration = next; return () => undefined; },
    } as unknown as PluginSession;
    registerMemoryMessageRecallAction(session, {
      findGenerationRecallDetails: async () => [{ ...detail(), ...override }],
      onOverviewChanged: () => () => undefined,
    }, async () => undefined);
    const messageTarget = target();
    await registration!.resolve([messageTarget]);
    await vi.waitFor(async () => {
      await expect(registration!.resolve([messageTarget])).resolves.toEqual([
        expect.objectContaining({ targetKey: messageTarget.key, state: 'hidden' }),
      ]);
    });
  });
});
