import { describe, expect, it, vi } from 'vitest';
import { MemoryRuntime, memoryWorkspaceStatus } from '../src/host/memory-runtime';

describe('Memory runtime status boundaries', () => {
  it('does not report the global LLM or memory setting as disabled when no chat is selected', () => {
    expect(memoryWorkspaceStatus({ getCurrentChatInfo: () => ({ available: false, name: '', key: '', mode: 'inherit', effectiveEnabled: false }) })).toMatchObject({
      value: '未选择', tone: 'warning',
    });
  });

  it('distinguishes a chat-level override from a ready workspace', () => {
    expect(memoryWorkspaceStatus({ getCurrentChatInfo: () => ({ available: true, name: 'Chat', key: 'chat-a', mode: 'disabled', effectiveEnabled: false }) })).toMatchObject({
      value: '已关闭', tone: 'neutral',
    });
    expect(memoryWorkspaceStatus({ getCurrentChatInfo: () => ({ available: true, name: 'Chat', key: 'chat-a', mode: 'inherit', effectiveEnabled: true }) })).toMatchObject({
      value: '已就绪', tone: 'success',
    });
  });
});

describe('Memory runtime generation completion', () => {
  it('prepares memory during message-sent and skips the later duplicate prompt-ready event', async () => {
    const listeners = new Map<string, (event: any) => void | Promise<void>>();
    const prepare = vi.fn(async () => undefined);
    const runtime = Object.create(MemoryRuntime.prototype) as any;
    Object.assign(runtime, {
      application: {},
      context: { setChatKey: vi.fn(), refresh: vi.fn(async () => undefined) },
      session: {
        host: {
          events: { subscribe: (name: string, listener: (event: any) => void | Promise<void>) => { listeners.set(name, listener); return () => undefined; } },
          prompt: { remove: vi.fn(async () => undefined) },
          chat: { readMessages: vi.fn(async () => []) },
        },
      },
      disposers: [],
      lastUserMessageAt: 0,
      promptPreparedForActiveGeneration: false,
      scheduleRebind: vi.fn(),
      onPromptReady: prepare,
    });
    runtime.bindHostEvents({ refreshNow: vi.fn(async () => undefined) });

    await listeners.get('message-sent')?.({
      name: 'message-sent', chatKey: 'chat-a', messageId: '11',
      message: { id: '11', index: 11, role: 'user', text: 'question' },
    });
    await listeners.get('prompt-ready')?.({ name: 'prompt-ready', chatKey: 'chat-a', prompt: { messages: [{ role: 'user', content: 'question' }], dryRun: false } });

    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith([{ role: 'user', content: 'question' }]);
  });

  it('re-reads a numeric message-received floor when generation-ended is missing and does not commit twice when it follows', async () => {
    const listeners = new Map<string, (event: any) => void>();
    const application = {
      getChatKey: () => 'chat-a',
      captureGenerationCompletionScope: vi.fn(() => ({ workspaceId: 'workspace-a', chatKey: 'chat-a', preparedGeneration: null, recallLogId: null })),
      createGenerationCompletionCommit: vi.fn((scope, usage, message) => ({ ...scope, usage, message })),
      isGenerationCompletionScopeCurrent: vi.fn(() => true),
      isCaptureBusy: vi.fn(() => false),
      setGenerationActive: vi.fn(),
      recordCompletedGeneration: vi.fn(async () => undefined),
      auditActorOutput: vi.fn(async () => null),
      reconcileGeneratedMessage: vi.fn(async () => undefined),
      getEffectiveSettings: () => ({ autoOrganize: false }),
      retry: vi.fn(async () => undefined),
    };
    const readMessages = vi.fn(async () => [{ id: '12', index: 12, role: 'assistant' as const, text: 'reply', variantId: '0' }]);
    const runtime = Object.create(MemoryRuntime.prototype) as any;
    Object.assign(runtime, {
      application,
      context: { setChatKey: vi.fn(), refresh: vi.fn(async () => undefined) },
      session: {
        host: {
          events: { subscribe: (name: string, listener: (event: any) => void) => { listeners.set(name, listener); return () => undefined; } },
          prompt: { remove: vi.fn(async () => undefined) },
          chat: { readMessages },
        },
      },
      disposers: [],
      abortController: new AbortController(),
      stopped: false,
      pendingGenerationCompletions: [],
      pendingGenerationCompletionPromise: null,
      activeGenerationCompletionScope: null,
      activeGenerationSnapshot: null,
      generationCompletionClaimedByMessage: false,
      lastFinalPromptSnapshot: null,
    });
    runtime.bindHostEvents({ refreshNow: vi.fn(async () => undefined) });

    listeners.get('generation-started')?.({ name: 'generation-started', chatKey: 'chat-a', generation: { active: true, provider: 'tavern' } });
    listeners.get('message-received')?.({
      name: 'message-received', chatKey: 'chat-a', messageId: '12',
    });
    await vi.waitFor(() => expect(application.recordCompletedGeneration).toHaveBeenCalledOnce());
    listeners.get('generation-ended')?.({ name: 'generation-ended', chatKey: 'chat-a', generation: { active: false, provider: 'tavern' } });

    expect(application.recordCompletedGeneration).toHaveBeenCalledOnce();
    expect(readMessages).toHaveBeenCalledOnce();
    expect(application.setGenerationActive).toHaveBeenLastCalledWith(false);
  });

  it('retries a transient completed-generation persistence failure before reconciling prepared recall state', async () => {
    const persistenceError = new Error('temporary workspace failure');
    const application = {
      getChatKey: () => 'chat-a',
      captureGenerationCompletionScope: vi.fn(() => ({ workspaceId: 'workspace-a', chatKey: 'chat-a', preparedGeneration: null, recallLogId: null })),
      createGenerationCompletionCommit: vi.fn((scope, usage, message) => ({ ...scope, usage, message })),
      isGenerationCompletionScopeCurrent: vi.fn(() => true),
      recordCompletedGeneration: vi.fn()
        .mockRejectedValueOnce(persistenceError)
        .mockResolvedValueOnce(undefined),
      recordMainChatUsage: vi.fn(async () => undefined),
      auditActorOutput: vi.fn(async () => null),
      reconcileGeneratedMessage: vi.fn(async () => undefined),
      getEffectiveSettings: () => ({ autoOrganize: false }),
      retry: vi.fn(async () => undefined),
    };
    const runtime = Object.create(MemoryRuntime.prototype) as unknown as {
      application: typeof application;
      session: {
        host: {
          chat: {
            readMessages(): Promise<Array<{ id: string; role: 'assistant'; text: string; createdAt: number }>>;
          };
        };
      };
      onGenerationEnded(generation: { provider?: string; model?: string; usage?: unknown }, allowAutoCapture: boolean, scope: { workspaceId: string; chatKey: string; preparedGeneration: null; recallLogId: null }): Promise<void>;
    };
    Object.assign(runtime, {
      application,
      abortController: new AbortController(),
      stopped: false,
      session: {
        host: {
          chat: {
            readMessages: async () => [{ id: 'message:assistant', role: 'assistant', text: 'reply', createdAt: 1 }],
          },
        },
      },
    });

    await expect(runtime.onGenerationEnded(
      { provider: 'provider', model: 'model', usage: { totalTokens: 10 } },
      false,
      { workspaceId: 'workspace-a', chatKey: 'chat-a', preparedGeneration: null, recallLogId: null },
    ))
      .resolves.toBeUndefined();
    expect(application.recordCompletedGeneration).toHaveBeenCalledTimes(2);
    expect(application.reconcileGeneratedMessage).toHaveBeenCalledTimes(1);
    expect(application.auditActorOutput).toHaveBeenCalledTimes(1);
  });

  it('retains a failed completion after bounded retries and lets a later event commit it', async () => {
    const persistenceError = new Error('workspace remains temporarily unavailable');
    const application = {
      getChatKey: () => 'chat-a',
      captureGenerationCompletionScope: vi.fn(() => ({ workspaceId: 'workspace-a', chatKey: 'chat-a', preparedGeneration: null, recallLogId: null })),
      createGenerationCompletionCommit: vi.fn((scope, usage, message) => ({ ...scope, usage, message })),
      isGenerationCompletionScopeCurrent: vi.fn(() => true),
      recordCompletedGeneration: vi.fn()
        .mockRejectedValueOnce(persistenceError)
        .mockRejectedValueOnce(persistenceError)
        .mockRejectedValueOnce(persistenceError)
        .mockResolvedValueOnce(undefined),
      recordMainChatUsage: vi.fn(async () => undefined),
      auditActorOutput: vi.fn(async () => null),
      reconcileGeneratedMessage: vi.fn(async () => undefined),
      getEffectiveSettings: () => ({ autoOrganize: false }),
      retry: vi.fn(async () => undefined),
    };
    const runtime = Object.create(MemoryRuntime.prototype) as unknown as {
      application: typeof application;
      session: {
        host: {
          chat: {
            readMessages(): Promise<Array<{ id: string; role: 'assistant'; text: string; createdAt: number }>>;
          };
        };
      };
      onGenerationEnded(generation: { provider?: string; model?: string; usage?: unknown }, allowAutoCapture: boolean, scope: { workspaceId: string; chatKey: string; preparedGeneration: null; recallLogId: null }): Promise<void>;
      flushPendingGenerationCompletion(): Promise<void>;
    };
    Object.assign(runtime, {
      application,
      abortController: new AbortController(),
      stopped: false,
      session: {
        host: {
          chat: {
            readMessages: async () => [{ id: 'message:assistant', role: 'assistant', text: 'reply', createdAt: 1 }],
          },
        },
      },
    });

    await expect(runtime.onGenerationEnded(
      { usage: { totalTokens: 10 } },
      false,
      { workspaceId: 'workspace-a', chatKey: 'chat-a', preparedGeneration: null, recallLogId: null },
    ))
      .rejects.toBe(persistenceError);
    expect(application.recordCompletedGeneration).toHaveBeenCalledTimes(3);
    expect(application.reconcileGeneratedMessage).not.toHaveBeenCalled();
    expect(application.auditActorOutput).not.toHaveBeenCalled();

    await expect(runtime.flushPendingGenerationCompletion()).resolves.toBeUndefined();
    expect(application.recordCompletedGeneration).toHaveBeenCalledTimes(4);
    expect(application.reconcileGeneratedMessage).toHaveBeenCalledTimes(1);
    expect(application.auditActorOutput).toHaveBeenCalledTimes(1);

    await expect(runtime.flushPendingGenerationCompletion()).resolves.toBeUndefined();
    expect(application.recordCompletedGeneration).toHaveBeenCalledTimes(4);
  });

  it('commits a retained completion to its original scope after the active chat changes', async () => {
    const persistenceError = new Error('temporary workspace failure');
    let currentChat = 'chat-a';
    const application = {
      getChatKey: () => currentChat,
      captureGenerationCompletionScope: vi.fn(() => ({ workspaceId: 'workspace-a', chatKey: currentChat, preparedGeneration: null, recallLogId: null })),
      createGenerationCompletionCommit: vi.fn((scope, usage, message) => ({ ...scope, usage, message })),
      isGenerationCompletionScopeCurrent: vi.fn((scope) => scope.chatKey === currentChat),
      recordCompletedGeneration: vi.fn()
        .mockRejectedValueOnce(persistenceError)
        .mockRejectedValueOnce(persistenceError)
        .mockRejectedValueOnce(persistenceError)
        .mockResolvedValueOnce(undefined),
      auditActorOutput: vi.fn(async () => null),
      reconcileGeneratedMessage: vi.fn(async () => undefined),
      getEffectiveSettings: () => ({ autoOrganize: false }),
      retry: vi.fn(async () => undefined),
    };
    const runtime = Object.create(MemoryRuntime.prototype) as unknown as {
      application: typeof application;
      session: { host: { chat: { readMessages(): Promise<Array<{ id: string; role: 'assistant'; text: string; createdAt: number }>> } } };
      onGenerationEnded(generation: { usage?: unknown }, allowAutoCapture: boolean, scope: { workspaceId: string; chatKey: string; preparedGeneration: null; recallLogId: null }): Promise<void>;
      flushPendingGenerationCompletion(): Promise<void>;
    };
    Object.assign(runtime, {
      application,
      abortController: new AbortController(),
      stopped: false,
      session: {
        host: {
          chat: {
            readMessages: async () => [{ id: 'message:assistant', role: 'assistant', text: 'reply-a', createdAt: 1 }],
          },
        },
      },
    });
    const scope = { workspaceId: 'workspace-a', chatKey: 'chat-a', preparedGeneration: null, recallLogId: null };

    await expect(runtime.onGenerationEnded({ usage: { totalTokens: 10 } }, false, scope))
      .rejects.toBe(persistenceError);
    currentChat = 'chat-b';
    await expect(runtime.flushPendingGenerationCompletion()).resolves.toBeUndefined();

    const committed = application.recordCompletedGeneration.mock.calls.at(-1)?.[0];
    expect(committed).toMatchObject({ workspaceId: 'workspace-a', chatKey: 'chat-a' });
    expect(application.auditActorOutput).not.toHaveBeenCalled();
    expect(application.reconcileGeneratedMessage).not.toHaveBeenCalled();
  });

  it('queues a later completion before retrying an older failed commit so neither generation is dropped', async () => {
    const persistenceError = new Error('temporary workspace failure');
    const application = {
      getChatKey: () => 'chat-a',
      captureGenerationCompletionScope: vi.fn(() => ({ workspaceId: 'workspace-a', chatKey: 'chat-a', preparedGeneration: null, recallLogId: null })),
      createGenerationCompletionCommit: vi.fn((scope, usage, message) => ({ ...scope, usage, message })),
      isGenerationCompletionScopeCurrent: vi.fn(() => true),
      recordCompletedGeneration: vi.fn()
        .mockRejectedValueOnce(persistenceError)
        .mockRejectedValueOnce(persistenceError)
        .mockRejectedValueOnce(persistenceError)
        .mockResolvedValue(undefined),
      auditActorOutput: vi.fn(async () => null),
      reconcileGeneratedMessage: vi.fn(async () => undefined),
      getEffectiveSettings: () => ({ autoOrganize: false }),
      retry: vi.fn(async () => undefined),
    };
    let assistantIndex = 0;
    const runtime = Object.create(MemoryRuntime.prototype) as any;
    Object.assign(runtime, {
      application,
      abortController: new AbortController(),
      stopped: false,
      session: {
        host: {
          chat: {
            readMessages: async () => [{
              id: `message:${++assistantIndex}`,
              role: 'assistant',
              text: `reply-${assistantIndex}`,
              createdAt: assistantIndex,
            }],
          },
        },
      },
    });
    const first = { workspaceId: 'workspace-a', chatKey: 'chat-a', preparedGeneration: null, recallLogId: null };
    const second = { workspaceId: 'workspace-a', chatKey: 'chat-a', preparedGeneration: null, recallLogId: null };

    await expect(runtime.onGenerationEnded({ usage: { totalTokens: 10 } }, false, first)).rejects.toBe(persistenceError);
    await expect(runtime.onGenerationEnded({ usage: { totalTokens: 20 } }, false, second)).resolves.toBeUndefined();

    const committedTotals = application.recordCompletedGeneration.mock.calls
      .slice(3)
      .map(([commit]) => commit.usage.totalTokens);
    expect(committedTotals).toEqual([10, 20]);
    expect(application.reconcileGeneratedMessage).toHaveBeenCalledTimes(2);
  });

  it('refreshes the prepared generation at completion and waits for the new assistant floor to settle', async () => {
    const preparedGeneration = { castPlan: { basedOnFloor: 11 } };
    const application = {
      getChatKey: () => 'chat-a',
      captureGenerationCompletionScope: vi.fn(() => ({ workspaceId: 'workspace-a', chatKey: 'chat-a', preparedGeneration, recallLogId: 'recall:new' })),
      createGenerationCompletionCommit: vi.fn((scope, usage, message) => ({ ...scope, usage, message })),
      isGenerationCompletionScopeCurrent: vi.fn(() => true),
      recordCompletedGeneration: vi.fn(async () => undefined),
      auditActorOutput: vi.fn(async () => null),
      reconcileGeneratedMessage: vi.fn(async () => undefined),
      getEffectiveSettings: () => ({ autoOrganize: false }),
      retry: vi.fn(async () => undefined),
    };
    let reads = 0;
    const runtime = Object.create(MemoryRuntime.prototype) as any;
    Object.assign(runtime, {
      application,
      abortController: new AbortController(),
      stopped: false,
      session: { host: { chat: { readMessages: async () => {
        reads += 1;
        return reads === 1
          ? [{ id: 'assistant:old', index: 10, role: 'assistant', text: 'old reply' }]
          : [{ id: 'assistant:old', index: 10, role: 'assistant', text: 'old reply' }, { id: 'assistant:new', index: 12, role: 'assistant', text: 'new reply' }];
      } } } },
    });

    await runtime.onGenerationEnded(
      { usage: { totalTokens: 10 } },
      false,
      { workspaceId: 'workspace-a', chatKey: 'chat-a', preparedGeneration: null, recallLogId: null },
    );

    expect(reads).toBe(2);
    expect(application.createGenerationCompletionCommit).toHaveBeenCalledWith(
      expect.objectContaining({ preparedGeneration, recallLogId: 'recall:new' }),
      expect.any(Object),
      expect.objectContaining({ id: 'assistant:new', index: 12 }),
    );
    expect(application.recordCompletedGeneration).toHaveBeenCalledOnce();
  });

  it('retries the Memory LLM consumer declaration after the LLM service becomes available', async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn()
        .mockRejectedValueOnce(new Error('LLM service not registered'))
        .mockResolvedValueOnce({ ok: true });
      const runtime = Object.create(MemoryRuntime.prototype) as any;
      Object.assign(runtime, {
        stopped: false,
        abortController: new AbortController(),
        consumerDeclared: false,
        consumerDeclarationAttempt: 0,
        consumerDeclarationPromise: null,
        consumerDeclarationRetryTimer: undefined,
        consumerReleaseRegistered: false,
        disposers: [],
        session: { bus: { request } },
      });
      await runtime.declareMemoryConsumer();
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
      expect(request).toHaveBeenCalledTimes(2);
      expect(runtime.consumerDeclared).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
