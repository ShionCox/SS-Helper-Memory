import {
  LLM_CONSUMER_DECLARE_V0,
  LLM_CONSUMER_RELEASE_V0,
  SS_HELPER_DIAGNOSTICS,
  createSSHelperError,
  readSSHelperFailure,
  type ChatMessageSnapshot,
  type FinalPromptSnapshot,
  type GenerationSnapshot,
  type PlainData,
  type PluginSession,
  type SettingsStatusSnapshot,
} from '@ss-helper/sdk';
import {
  MemoryApplication,
  type GenerationCompletionCommit,
  type GenerationCompletionScope,
} from '../application/memory-application';
import { MEMORY_WORKSPACE_RECOVERY_POPUP, registerMemoryContributions, type MemoryHostCapability } from '../ss-helper/plugin';
import { renderMemoryWorkbench } from '../ui/memory-ui';
import { buildMemoryPromptContribution } from './prompt-injection';
import { logger, safeMemoryFailure, traceMemoryStartup } from './runtime-feedback';
import { captureMainChatUsage } from './main-chat-usage';
import { SdkMemoryHostContext } from './sdk-host-context';
import { configureMemoryLlmClient } from '../application/ingest/llm-extractor';
import { createMemoryLlmClient } from '../ss-helper/llm-client';
import { MemoryRepository } from '../infrastructure/memory-repository';
import { MemoryLlmCapabilityMonitor } from '../ss-helper/llm-capability-monitor';
import { registerMemoryMessageRecallAction } from '../ss-helper/message-recall-action';

const SEND_WINDOW_MS = 45_000;
const MEMORY_PROMPT_ID = 'ss-helper.memory.recall.v0';
const GENERATION_PERSIST_RETRY_DELAYS_MS = [0, 120, 400] as const;
const GENERATION_MESSAGE_SETTLE_DELAYS_MS = [0, 30, 80, 160, 320] as const;
const CONSUMER_DECLARE_RETRY_MAX_MS = 5_000;

interface PendingGenerationCompletion {
  readonly commit: GenerationCompletionCommit;
  readonly latestText: string;
  readonly allowAutoCapture: boolean;
}

export function memoryWorkspaceStatus(application: Pick<MemoryApplication, 'getCurrentChatInfo'>): SettingsStatusSnapshot {
  const chat = application.getCurrentChatInfo();
  if (!chat.available) return { value: '未选择', tone: 'warning', description: '请先选择一个角色或加入群组聊天；全局记忆设置和 LLM 连接仍然有效。' };
  if (!chat.effectiveEnabled) return { value: '已关闭', tone: 'neutral', description: '当前聊天按聊天级策略关闭了记忆；可在“当前聊天”中改为强制开启。' };
  return { value: '已就绪', tone: 'success', description: '当前角色或群组可用于记忆整理与召回。' };
}

/** Production runtime backed exclusively by the SDK session public surface. */
export class MemoryRuntime {
  readonly application: MemoryApplication;
  private readonly context: SdkMemoryHostContext;
  private readonly disposers: Array<() => void> = [];
  private lastUserMessageAt = 0;
  private rebindPromise: Promise<void> = Promise.resolve();
  private rebindPending = false;
  private rebindRequested = false;
  private rebindRefreshRequested = false;
  private recoveryPrompted = false;
  private stopped = false;
  private started = false;
  private messageRecallActionRegistered = false;
  private readonly abortController = new AbortController();
  private consumerDeclared = false;
  private consumerDeclarationAttempt = 0;
  private consumerDeclarationPromise: Promise<void> | null = null;
  private consumerDeclarationRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private consumerReleaseRegistered = false;
  private pendingGenerationCompletions: PendingGenerationCompletion[] = [];
  private pendingGenerationCompletionPromise: Promise<void> | null = null;
  private activeGenerationCompletionScope: GenerationCompletionScope | null = null;
  private activeGenerationSnapshot: GenerationSnapshot | null = null;
  private generationCompletionClaimedByMessage = false;
  private promptPreparedForActiveGeneration = false;
  private lastFinalPromptSnapshot: { readonly chatKey: string; readonly prompt: FinalPromptSnapshot; readonly capturedAt: number } | null = null;

  constructor(
    private readonly session: PluginSession<MemoryHostCapability>,
    application = new MemoryApplication(new MemoryRepository(session.workspace)),
  ) {
    this.application = application;
    this.context = new SdkMemoryHostContext(session);
    this.application.useHostContext(this.context);
  }

  registerEarlyMessageRecallAction(): void {
    if (this.messageRecallActionRegistered) return;
    this.messageRecallActionRegistered = true;
    traceMemoryStartup('runtime:message-action-registered');
    this.disposers.push(registerMemoryMessageRecallAction(
      this.session,
      this.application,
      async (floor) => this.session.host.chat.navigate({ index: floor }),
    ));
  }

  private declareMemoryConsumer(): Promise<void> {
    if (this.stopped || this.abortController.signal.aborted || this.consumerDeclared) return Promise.resolve();
    if (this.consumerDeclarationPromise) return this.consumerDeclarationPromise;
    const attempt = this.consumerDeclarationAttempt;
    const request = this.session.bus.request(LLM_CONSUMER_DECLARE_V0, {
      displayName: 'SS-Helper Memory',
      registrationVersion: 1,
      tasks: [
        {
          taskKey: 'memory_extract_single',
          taskKind: 'generation',
          requiredCapabilities: ['chat', 'json'],
          description: '单阶段结构化记忆提取',
          structuredPolicy: {
            maxProviderAttempts: 2,
            repairOn: ['INVALID_JSON', 'SCHEMA_VALIDATION_FAILED'],
            itemFailure: 'return_partial',
            envelopeFailure: 'repair_once',
            itemCollections: ['actorCandidates', 'locationCandidates', 'itemCandidates', 'episodes', 'claims', 'inventoryOperations'],
          },
        },
        {
          taskKey: 'memory_extract_entities',
          taskKind: 'generation',
          requiredCapabilities: ['chat', 'json'],
          description: '人物与地点实体解析',
          structuredPolicy: {
            maxProviderAttempts: 2,
            repairOn: ['INVALID_JSON', 'SCHEMA_VALIDATION_FAILED'],
            itemFailure: 'return_partial',
            envelopeFailure: 'repair_once',
            itemCollections: ['actorCandidates', 'locationCandidates'],
          },
        },
        {
          taskKey: 'memory_extract_narrative',
          taskKind: 'generation',
          requiredCapabilities: ['chat', 'json'],
          description: '事件、事实与知识边界提取',
          structuredPolicy: {
            maxProviderAttempts: 2,
            repairOn: ['INVALID_JSON', 'SCHEMA_VALIDATION_FAILED'],
            itemFailure: 'return_partial',
            envelopeFailure: 'repair_once',
            itemCollections: ['episodes', 'claims'],
          },
        },
        {
          taskKey: 'memory_extract_inventory',
          taskKind: 'generation',
          requiredCapabilities: ['chat', 'json'],
          description: '物品与库存变化提取',
          structuredPolicy: {
            maxProviderAttempts: 2,
            repairOn: ['INVALID_JSON', 'SCHEMA_VALIDATION_FAILED'],
            itemFailure: 'return_partial',
            envelopeFailure: 'repair_once',
            itemCollections: ['itemCandidates', 'inventoryOperations'],
          },
        },
        {
          taskKey: 'memory_extract_repair',
          taskKind: 'generation',
          requiredCapabilities: ['chat', 'json'],
          description: '局部结构化提取修复',
          structuredPolicy: {
            maxProviderAttempts: 1,
            repairOn: [],
            itemFailure: 'fail',
            envelopeFailure: 'fail',
          },
        },
        { taskKey: 'memory_cast_plan', taskKind: 'generation', requiredCapabilities: ['chat', 'json'], description: '下一轮角色规划' },
        { taskKey: 'memory_embed', taskKind: 'embedding', requiredCapabilities: ['embeddings'], description: '记忆向量' },
        { taskKey: 'memory_rerank', taskKind: 'rerank', requiredCapabilities: ['rerank'], description: '记忆候选重排' },
      ],
    }, { timeoutMs: 10_000 });
    const pending = request.then(() => {
      if (this.stopped || this.abortController.signal.aborted) return;
      this.consumerDeclared = true;
      this.consumerDeclarationAttempt = 0;
      if (!this.consumerReleaseRegistered) {
        this.consumerReleaseRegistered = true;
        this.disposers.push(() => {
          void this.session.bus.request(LLM_CONSUMER_RELEASE_V0, { keepPersistent: true }, { timeoutMs: 5_000 }).catch(() => undefined);
        });
      }
      traceMemoryStartup('runtime:llm-consumer-ready');
    }).catch((error) => {
      if (this.stopped || this.abortController.signal.aborted) return;
      this.consumerDeclarationAttempt += 1;
      logger.warn(
        'Memory LLM 路由尚未就绪，将在后台重新声明任务。',
        safeMemoryFailure(error, { reasonCode: 'MEMORY_LLM_CLIENT_UNAVAILABLE', stage: 'memory.consumer.declare' }),
      );
      this.scheduleMemoryConsumerDeclarationRetry(attempt);
    }).finally(() => { this.consumerDeclarationPromise = null; });
    this.consumerDeclarationPromise = pending;
    return pending;
  }

  private scheduleMemoryConsumerDeclarationRetry(attempt: number): void {
    if (this.stopped || this.abortController.signal.aborted || this.consumerDeclared || this.consumerDeclarationRetryTimer !== undefined) return;
    const delayMs = Math.min(CONSUMER_DECLARE_RETRY_MAX_MS, 250 * 2 ** Math.min(4, attempt));
    this.consumerDeclarationRetryTimer = setTimeout(() => {
      this.consumerDeclarationRetryTimer = undefined;
      void this.declareMemoryConsumer();
    }, delayMs);
  }

  async start(): Promise<boolean> {
    traceMemoryStartup('runtime:start');
    if (this.started) return this.application.isSqliteAvailable();
    this.started = true;
    this.stopped = false;
    this.recoveryPrompted = false;
    try {
      this.registerEarlyMessageRecallAction();
      const capabilityMonitor = new MemoryLlmCapabilityMonitor(
      this.session,
      () => this.application.getSettings(),
      (listener) => this.application.onSettingsChanged(() => listener()),
      () => memoryWorkspaceStatus(this.application),
      );
      this.application.setAgentModeAvailabilityResolver(() => capabilityMonitor.isAgentAvailable());
      this.disposers.push(() => {
        this.application.setAgentModeAvailabilityResolver(() => true);
        capabilityMonitor.dispose();
      });
      const contributions = registerMemoryContributions(
      this.session,
      this.application,
      (container, actionId, popupUi) => renderMemoryWorkbench(
        container,
        this.application,
        (notification) => this.session.ui.showToast(notification),
        popupUi,
        actionId,
        (target) => this.context.navigateToMessage(target),
      ),
      capabilityMonitor,
      {
        repair: async () => this.session.workspace.admin.repair(),
      },
      { registerMessageRecallAction: false },
      );
      this.disposers.push(() => contributions.dispose());
      traceMemoryStartup('runtime:contributions-registered');
      void capabilityMonitor.start()
      .then(() => traceMemoryStartup('runtime:capabilities-ready'))
      .catch((error) => logger.warn(
        'Memory LLM 能力状态将在后台重试。',
        safeMemoryFailure(error, { reasonCode: 'MEMORY_LLM_CLIENT_UNAVAILABLE', stage: 'memory.capabilities.start' }),
      ));
      const declareConsumer = this.declareMemoryConsumer();
      configureMemoryLlmClient(createMemoryLlmClient(this.session, this.abortController.signal));
      await this.context.refresh();
      this.assertActive();
      traceMemoryStartup('runtime:context-ready');
      this.application.bindStorageScope(this.context.getWorkspaceId(), this.context.getChatKey());
      await Promise.all([this.application.start(), declareConsumer]);
      const connected = this.application.isSqliteAvailable();
      this.assertActive();
      traceMemoryStartup('runtime:application-started');
      this.bindHostEvents(capabilityMonitor);
      traceMemoryStartup(`runtime:storage-${connected ? 'connected' : 'degraded'}`);
      if (connected) logger.success('Memory workspace 已启动。');
      else {
        logger.error('Memory workspace 不可用，记忆功能已安全停用。');
        void this.offerWorkspaceRecovery().catch((error) => logger.warn(
          'Memory workspace 恢复状态检查失败。',
          safeMemoryFailure(error, { reasonCode: 'WORKSPACE_UNAVAILABLE', stage: 'memory.workspace.recovery.health' }),
        ));
      }
      return connected;
    } catch (error) {
      if (!this.stopped) this.stop();
      if (this.abortController.signal.aborted) return false;
      throw error;
    }
  }

  private async persistCompletedGeneration(
    commit: GenerationCompletionCommit,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < GENERATION_PERSIST_RETRY_DELAYS_MS.length; attempt += 1) {
      const delayMs = GENERATION_PERSIST_RETRY_DELAYS_MS[attempt]!;
      if (delayMs > 0) await this.waitForGenerationPersistenceRetry(delayMs);
      try {
        await this.application.recordCompletedGeneration(commit);
        return;
      } catch (error) {
        lastError = error;
        const failure = readSSHelperFailure(error, {
          reasonCode: 'WORKSPACE_UNAVAILABLE',
          stage: 'memory.generation.persist',
        })!;
        const retryable = SS_HELPER_DIAGNOSTICS[failure.reasonCode].retryable;
        const finalAttempt = attempt === GENERATION_PERSIST_RETRY_DELAYS_MS.length - 1;
        if (!retryable || finalAttempt) throw error;
        logger.warn('召回详情持久化暂时失败，将执行有界重试。', {
          reasonCode: failure.reasonCode,
          stage: failure.stage,
          ...(failure.requestId ? { requestId: failure.requestId } : {}),
          attempt: attempt + 1,
          nextDelayMs: GENERATION_PERSIST_RETRY_DELAYS_MS[attempt + 1],
        });
      }
    }
    throw lastError;
  }

  private async waitForGenerationPersistenceRetry(delayMs: number): Promise<void> {
    if (this.stopped || this.abortController.signal.aborted) {
      throw createSSHelperError('REQUEST_ABORTED', { stage: 'memory.generation.persist.retry' });
    }
    await new Promise<void>((resolve, reject) => {
      const signal = this.abortController.signal;
      const finish = (): void => {
        signal.removeEventListener('abort', abort);
        resolve();
      };
      const abort = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        reject(createSSHelperError('REQUEST_ABORTED', { stage: 'memory.generation.persist.retry' }));
      };
      const timer = setTimeout(finish, delayMs);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  private assertActive(): void {
    if (this.stopped || this.abortController.signal.aborted) {
      throw createSSHelperError('REQUEST_ABORTED', { stage: 'memory.runtime.startup' });
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.abortController.abort();
    if (this.consumerDeclarationRetryTimer !== undefined) clearTimeout(this.consumerDeclarationRetryTimer);
    this.consumerDeclarationRetryTimer = undefined;
    this.consumerDeclarationPromise = null;
    this.consumerDeclared = false;
    this.consumerReleaseRegistered = false;
    while (this.disposers.length > 0) this.disposers.pop()?.();
    void this.session.host.prompt.remove(MEMORY_PROMPT_ID).catch(() => undefined);
    this.rebindPending = false;
    this.rebindRequested = false;
    this.rebindRefreshRequested = false;
    this.rebindPromise = Promise.resolve();
    this.recoveryPrompted = false;
    this.pendingGenerationCompletions = [];
    this.pendingGenerationCompletionPromise = null;
    this.activeGenerationCompletionScope = null;
    this.activeGenerationSnapshot = null;
    this.generationCompletionClaimedByMessage = false;
    this.promptPreparedForActiveGeneration = false;
    this.application.stop();
    configureMemoryLlmClient(null);
    logger.info('Memory 已停止。');
  }

  private bindHostEvents(capabilityMonitor: MemoryLlmCapabilityMonitor): void {
    const events = this.session.host.events;
    this.disposers.push(events.subscribe('chat-changed', (event) => {
      this.context.setChatKey(event.chatKey);
      this.lastUserMessageAt = 0;
      this.lastFinalPromptSnapshot = null;
      this.activeGenerationCompletionScope = null;
      this.activeGenerationSnapshot = null;
      this.generationCompletionClaimedByMessage = false;
      this.promptPreparedForActiveGeneration = false;
      void this.session.host.prompt.remove(MEMORY_PROMPT_ID).catch(() => undefined);
      void this.context.refresh()
        .then(() => {
          this.application.prepareCurrentChatLookupScope();
          this.scheduleRebind(false);
          void capabilityMonitor.refreshNow().catch((error) => logger.warn(
            'Memory LLM capability refresh failed',
            safeMemoryFailure(error, { reasonCode: 'INTERNAL_ERROR', stage: 'memory.capability.refresh.chat' }),
          ));
        })
        .catch((error) => logger.warn(
          'Memory workspace refresh failed',
          safeMemoryFailure(error, { reasonCode: 'WORKSPACE_UNAVAILABLE', stage: 'memory.rebind.chat' }),
        ));
    }));
    this.disposers.push(events.subscribe('identity-changed', () => {
      void this.context.refresh()
        .then(() => {
          this.application.prepareCurrentChatLookupScope();
          this.scheduleRebind(false);
          void capabilityMonitor.refreshNow().catch((error) => logger.warn(
            'Memory LLM capability refresh failed',
            safeMemoryFailure(error, { reasonCode: 'INTERNAL_ERROR', stage: 'memory.capability.refresh.identity' }),
          ));
        })
        .catch((error) => logger.warn(
          'Memory identity refresh failed',
          safeMemoryFailure(error, { reasonCode: 'WORKSPACE_UNAVAILABLE', stage: 'memory.rebind.identity' }),
        ));
    }));
    this.disposers.push(events.subscribe('message-sent', async (event) => {
      this.lastUserMessageAt = Date.now();
      this.promptPreparedForActiveGeneration = false;
      this.scheduleRebind(true);
      try {
        const messages = event.message?.role === 'user'
          ? [event.message]
          : await this.session.host.chat.readMessages();
        const latestUser = [...messages].reverse().find(message => message.role === 'user');
        if (!latestUser?.text.trim()) return;
        await this.onPromptReady([{ role: 'user', content: latestUser.text }]);
        this.promptPreparedForActiveGeneration = true;
      } catch (error) {
        logger.warn('用户消息后的记忆准备失败，本轮将安全跳过记忆注入。', safeMemoryFailure(error, {
          reasonCode: 'INTERNAL_ERROR',
          stage: 'memory.prompt.prepare.message-sent',
        }));
      }
    }));
    this.disposers.push(events.subscribe('message-received', async (event) => {
      const message = event.message;
      const completionScope = this.activeGenerationCompletionScope;
      if (completionScope === null || (message !== undefined && message.role !== 'assistant')) return;
      if (event.chatKey && event.chatKey !== completionScope.chatKey) return;
      const captureWasActive = this.application.isCaptureBusy();
      const generation = this.activeGenerationSnapshot ?? { active: false };
      this.activeGenerationCompletionScope = null;
      this.activeGenerationSnapshot = null;
      this.lastFinalPromptSnapshot = null;
      this.generationCompletionClaimedByMessage = true;
      this.promptPreparedForActiveGeneration = false;
      this.application.setGenerationActive(false);
      try {
        await this.onGenerationEnded(generation, !captureWasActive, completionScope, message);
      } catch (error) {
        logger.warn('Memory message-received 处理失败。', safeMemoryFailure(error, {
          reasonCode: 'INTERNAL_ERROR',
          stage: 'memory.generation-completion.message-received',
        }));
      }
    }));
    this.disposers.push(events.subscribe('generation-started', (event) => {
      this.application.setGenerationActive(true);
      this.activeGenerationSnapshot = event.generation;
      this.generationCompletionClaimedByMessage = false;
      try {
        const scope = this.application.captureGenerationCompletionScope();
        if (event.chatKey && event.chatKey !== scope.chatKey) this.activeGenerationCompletionScope = null;
        else {
          const recent = this.lastFinalPromptSnapshot;
          this.activeGenerationCompletionScope = recent !== null && recent.chatKey === scope.chatKey && Date.now() - recent.capturedAt < SEND_WINDOW_MS
            ? Object.freeze({ ...scope, finalPromptSnapshot: structuredClone(recent.prompt) })
            : scope;
        }
      } catch (error) {
        this.activeGenerationCompletionScope = null;
        logger.warn('生成开始作用域创建失败。', safeMemoryFailure(error, {
          reasonCode: 'MEMORY_CAPTURE_NOT_BOUND',
          stage: 'memory.generation-completion.scope.start',
        }));
      }
    }));
    this.disposers.push(events.subscribe('generation-ended', (event) => {
      if (this.generationCompletionClaimedByMessage) {
        this.generationCompletionClaimedByMessage = false;
        this.activeGenerationSnapshot = null;
        this.promptPreparedForActiveGeneration = false;
        this.application.setGenerationActive(false);
        return;
      }
      const captureWasActive = this.application.isCaptureBusy();
      let completionScope = this.activeGenerationCompletionScope;
      this.activeGenerationCompletionScope = null;
      this.activeGenerationSnapshot = null;
      this.promptPreparedForActiveGeneration = false;
      this.lastFinalPromptSnapshot = null;
      if (completionScope === null) {
        try {
          completionScope = this.application.captureGenerationCompletionScope();
        } catch (error) {
          logger.warn('生成完成作用域创建失败。', safeMemoryFailure(error, {
            reasonCode: 'MEMORY_CAPTURE_NOT_BOUND',
            stage: 'memory.generation-completion.scope',
          }));
          this.application.setGenerationActive(false);
          return;
        }
      }
      if (event.chatKey && event.chatKey !== completionScope.chatKey) {
        logger.warn('生成完成事件与开始作用域不一致，已拒绝跨聊天提交。', {
          reasonCode: 'MEMORY_CAPTURE_NOT_BOUND',
          stage: 'memory.generation-completion.scope.mismatch',
        });
        this.application.setGenerationActive(false);
        return;
      }
      this.application.setGenerationActive(false);
      void this.onGenerationEnded(event.generation, !captureWasActive, completionScope)
        .catch((error) => logger.warn('Memory generation-end 处理失败。', safeMemoryFailure(error, {
          reasonCode: 'INTERNAL_ERROR',
          stage: 'memory.generation-completion.handle',
        })));
    }));
    this.disposers.push(events.subscribe('message-deleted', (event) => {
      if (event.chatKey && event.chatKey !== this.application.getChatKey()) return;
      if (event.fromIndex === undefined || event.deletedCount === undefined) return;
      void this.application.applyGenerationRecallMessageDeletion(event.fromIndex, event.deletedCount)
        .catch((error) => logger.warn(
          '更新已删除楼层的召回预览失败。',
          safeMemoryFailure(error, { reasonCode: 'WORKSPACE_UNAVAILABLE', stage: 'memory.generation-recall.invalidate-deleted' }),
        ));
    }));
    this.disposers.push(events.subscribe('message-edited', (event) => {
      if (event.chatKey && event.chatKey !== this.application.getChatKey()) return;
      if (event.message === undefined) return;
      void this.application.applyGenerationRecallMessageEdit(event.message).catch((error) => logger.warn(
        '更新已编辑楼层的召回预览失败。',
        safeMemoryFailure(error, { reasonCode: 'WORKSPACE_UNAVAILABLE', stage: 'memory.generation-recall.invalidate-edited' }),
      ));
    }));
    this.disposers.push(events.subscribe('message-swipe-deleted', (event) => {
      if (event.chatKey && event.chatKey !== this.application.getChatKey()) return;
      void this.application.applyGenerationRecallSwipeDeletion(event.messageIndex, event.deletedVariantId).catch((error) => logger.warn(
        '更新已删除 Swipe 的召回预览失败。',
        safeMemoryFailure(error, { reasonCode: 'WORKSPACE_UNAVAILABLE', stage: 'memory.generation-recall.invalidate-swipe' }),
      ));
    }));
    this.disposers.push(events.subscribe('prompt-ready', async (event) => {
      if (this.promptPreparedForActiveGeneration) return;
      try {
        await this.onPromptReady(event.prompt.messages);
        this.promptPreparedForActiveGeneration = true;
      } catch (error) {
        logger.warn(
          'Memory Prompt 处理失败。',
          safeMemoryFailure(error, { reasonCode: 'INTERNAL_ERROR', stage: 'memory.prompt.handle' }),
        );
      }
    }));
    this.disposers.push(events.subscribe('prompt-finalized', (event) => {
      this.onPromptFinalized(event.chatKey, event.prompt);
    }));
  }

  private onPromptFinalized(chatKey: string | undefined, prompt: FinalPromptSnapshot): void {
    const resolvedChatKey = chatKey ?? this.application.getChatKey();
    if (!resolvedChatKey) return;
    this.lastFinalPromptSnapshot = { chatKey: resolvedChatKey, prompt: structuredClone(prompt), capturedAt: Date.now() };
    const scope = this.activeGenerationCompletionScope;
    if (scope === null || resolvedChatKey !== scope.chatKey) return;
    this.activeGenerationCompletionScope = Object.freeze({
      ...scope,
      finalPromptSnapshot: structuredClone(prompt),
    });
  }

  private async offerWorkspaceRecovery(): Promise<void> {
    if (this.stopped || this.recoveryPrompted) return;
    const health = await this.session.workspace.admin.health();
    if (this.stopped || health.ready || health.recoverable !== true) return;
    this.recoveryPrompted = true;
    this.session.ui.openPopup(MEMORY_WORKSPACE_RECOVERY_POPUP, {
      failure: health.failure ?? {
        reasonCode: 'WORKSPACE_UNAVAILABLE',
        stage: 'memory.workspace.health',
      },
    } as unknown as PlainData);
  }

  private async flushPendingGenerationCompletion(): Promise<void> {
    this.pendingGenerationCompletions ??= [];
    if (this.pendingGenerationCompletions.length === 0) return;
    if (this.pendingGenerationCompletionPromise) return this.pendingGenerationCompletionPromise;

    const run = async (): Promise<void> => {
      while (this.pendingGenerationCompletions.length > 0) {
        const pending = this.pendingGenerationCompletions[0]!;
        if (this.stopped) throw createSSHelperError('REQUEST_ABORTED', { stage: 'memory.generation-completion.retry' });
        try {
          await this.persistCompletedGeneration(pending.commit);
        } catch (error) {
          logger.warn(
            '主聊天 Token usage 与召回详情记录失败，已保留待提交召回审计供后续事件重试。',
            safeMemoryFailure(error, {
              reasonCode: 'WORKSPACE_UNAVAILABLE',
              stage: 'memory.generation-completion.persist',
            }),
          );
          throw error;
        }
        this.pendingGenerationCompletions.shift();
        if (!this.application.isGenerationCompletionScopeCurrent(pending.commit)) continue;
        const leakage = await this.application.auditActorOutput(pending.latestText);
        if (leakage && leakage.violationCount > 0) {
          logger.warn('多角色记忆泄漏审计发现跨主体标记。', {
            violationCount: leakage.violationCount,
            outputHash: leakage.outputHash,
          });
        }
        await this.application.reconcileGeneratedMessage()
          .catch((error) => logger.warn(
            '生成后角色核对失败，已保留原回复并等待下一轮降级恢复。',
            safeMemoryFailure(error, { reasonCode: 'INTERNAL_ERROR', stage: 'memory.generation.reconcile' }),
          ));
        if (pending.allowAutoCapture && this.application.getEffectiveSettings().autoOrganize) {
          void this.application.retry().catch((error) => logger.warn(
            '增量 Capture 失败，已保留原有聊天。',
            safeMemoryFailure(error, { reasonCode: 'INTERNAL_ERROR', stage: 'memory.generation.capture' }),
          ));
        }
      }
    };

    const promise = run().finally(() => {
      if (this.pendingGenerationCompletionPromise === promise) {
        this.pendingGenerationCompletionPromise = null;
      }
    });
    this.pendingGenerationCompletionPromise = promise;
    return promise;
  }

  private async onGenerationEnded(
    generation: { readonly provider?: string; readonly model?: string; readonly usage?: unknown },
    allowAutoCapture: boolean,
    completionScope: GenerationCompletionScope,
    receivedAssistant?: ChatMessageSnapshot,
  ): Promise<void> {
    if (this.application.isGenerationCompletionScopeCurrent(completionScope)) {
      const latestScope = this.application.captureGenerationCompletionScope();
      if (latestScope.workspaceId === completionScope.workspaceId && latestScope.chatKey === completionScope.chatKey) {
        completionScope = Object.freeze({
          ...completionScope,
          preparedGeneration: latestScope.preparedGeneration ?? completionScope.preparedGeneration,
          recallLogId: latestScope.recallLogId ?? completionScope.recallLogId,
        });
      }
    }
    const { messages, latestAssistant } = receivedAssistant === undefined
      ? await this.readCompletedAssistant(completionScope)
      : { messages: [receivedAssistant], latestAssistant: receivedAssistant };
    const latestText = latestAssistant?.text ?? '';
    const usage = captureMainChatUsage(completionScope.chatKey, generation, messages);
    if (usage) {
      const completedUsage = {
        ...usage,
        ...(generation.provider ? { provider: generation.provider } : {}),
        ...(generation.model ? { model: generation.model } : {}),
      };
      const commit = this.application.createGenerationCompletionCommit(
        completionScope,
        completedUsage,
        latestAssistant,
      );
      this.pendingGenerationCompletions ??= [];
      this.pendingGenerationCompletions.push({
        commit,
        latestText,
        allowAutoCapture,
      });
      await this.flushPendingGenerationCompletion();
      return;
    }
    const leakage = await this.application.auditActorOutput(latestText);
    if (leakage && leakage.violationCount > 0) logger.warn('多角色记忆泄漏审计发现跨主体标记。', { violationCount: leakage.violationCount, outputHash: leakage.outputHash });
    await this.application.reconcileGeneratedMessage().catch((error) => logger.warn(
      '生成后角色核对失败，已保留原回复并等待下一轮降级恢复。',
      safeMemoryFailure(error, { reasonCode: 'INTERNAL_ERROR', stage: 'memory.generation.reconcile' }),
    ));
    if (allowAutoCapture && this.application.getEffectiveSettings().autoOrganize) {
      void this.application.retry().catch((error) => logger.warn(
        '增量 Capture 失败，已保留原有聊天。',
        safeMemoryFailure(error, { reasonCode: 'INTERNAL_ERROR', stage: 'memory.generation.capture' }),
      ));
    }
  }

  private async readCompletedAssistant(completionScope: GenerationCompletionScope): Promise<{
    readonly messages: readonly ChatMessageSnapshot[];
    readonly latestAssistant?: ChatMessageSnapshot;
  }> {
    if (this.application.getChatKey() !== completionScope.chatKey) return { messages: [] };
    const minimumFloor = completionScope.preparedGeneration?.castPlan.basedOnFloor;
    let messages: readonly ChatMessageSnapshot[] = [];
    let latestAssistant: ChatMessageSnapshot | undefined;
    for (const delay of GENERATION_MESSAGE_SETTLE_DELAYS_MS) {
      if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
      if (this.stopped || this.abortController.signal.aborted) break;
      messages = await this.session.host.chat.readMessages();
      latestAssistant = [...messages].reverse().find(message => message.role === 'assistant'
        && (minimumFloor === undefined || message.index >= minimumFloor));
      if (latestAssistant?.text.trim()) break;
    }
    return { messages, ...(latestAssistant === undefined ? {} : { latestAssistant }) };
  }

  private async onPromptReady(messages: Parameters<typeof buildMemoryPromptContribution>[0]): Promise<void> {
    // Retry the previous floor before a new generation plan can replace it.
    await this.flushPendingGenerationCompletion();
    await this.rebindPromise;
    const settings = this.application.getEffectiveSettings();
    if (!settings.enabled || Date.now() - this.lastUserMessageAt > SEND_WINDOW_MS) {
      await this.session.host.prompt.remove(MEMORY_PROMPT_ID).catch(() => undefined);
      return;
    }
    try {
      const latestUser = [...messages].reverse().find((message) => message.role === 'user');
      const actorBuilder = (this.application as unknown as { buildActorMemoryPrompt?: (input: { query: string; maxItems?: number; maxChars?: number }) => Promise<{ prompt: string }> }).buildActorMemoryPrompt?.bind(this.application);
      if (actorBuilder) {
        if (typeof latestUser?.content !== 'string' || !latestUser.content.trim()) {
          await this.session.host.prompt.remove(MEMORY_PROMPT_ID);
          return;
        }
        let actorInjection: { prompt: string };
        try {
          actorInjection = await actorBuilder({ query: latestUser.content.trim(), maxItems: settings.maxRecallItems, maxChars: settings.promptMaxChars });
        } catch (error) {
          await this.session.host.prompt.remove(MEMORY_PROMPT_ID).catch(() => undefined);
          logger.warn(
            'Prompt 记忆准备失败，已跳过本轮注入（stage=generation_memory_prepare）。',
            safeMemoryFailure(error, { reasonCode: 'INTERNAL_ERROR', stage: 'memory.prompt.prepare' }),
          );
          return;
        }
        if (!actorInjection || typeof actorInjection.prompt !== 'string') {
          await this.session.host.prompt.remove(MEMORY_PROMPT_ID).catch(() => undefined);
          logger.warn('Prompt 记忆准备返回了非法结果，已跳过本轮注入（stage=prompt_result_validation）。', { code: 'MEMORY_PROMPT_RESULT_INVALID' });
          return;
        }
        try {
          if (actorInjection.prompt) await this.session.host.prompt.set({ id: MEMORY_PROMPT_ID, content: actorInjection.prompt, position: 0 });
          else await this.session.host.prompt.remove(MEMORY_PROMPT_ID);
        } catch (error) {
          logger.warn(
            'Prompt 记忆写入失败，已保留原始 Prompt（stage=host_prompt_set）。',
            safeMemoryFailure(error, { reasonCode: 'INTERNAL_ERROR', stage: 'memory.prompt.set' }),
          );
        }
        return;
      }
      const injection = await buildMemoryPromptContribution(messages, this.application.recall, settings.maxRecallItems, {
        maxChars: settings.promptMaxChars,
        answerMode: settings.answerMode,
        currentIdentity: (await this.session.host.persona.read()) ?? undefined,
      });
      if (injection.injected) {
        await this.session.host.prompt.set({ id: MEMORY_PROMPT_ID, content: injection.prompt, position: 0 });
      } else {
        await this.session.host.prompt.remove(MEMORY_PROMPT_ID);
      }
      await this.application.recordPromptInjection(injection);
    } catch (error) {
      logger.warn(
        'Prompt 记忆注入失败，已保留原始 Prompt。',
        safeMemoryFailure(error, { reasonCode: 'INTERNAL_ERROR', stage: 'memory.prompt.inject' }),
      );
    }
  }

  /** Coalesce duplicate host events and bind the latest typed chat snapshot before prompt contribution. */
  private scheduleRebind(refreshContext: boolean): void {
    if (this.stopped) return;
    this.rebindRequested = true;
    this.rebindRefreshRequested ||= refreshContext;
    if (this.rebindPending) return;
    this.rebindPending = true;
    this.rebindPromise = this.rebindPromise
      .catch(() => undefined)
      .then(async () => {
        while (this.rebindRequested && !this.stopped) {
          const shouldRefreshContext = this.rebindRefreshRequested;
          this.rebindRequested = false;
          this.rebindRefreshRequested = false;
          if (shouldRefreshContext) await this.context.refresh();
          if (this.stopped) return;
          await this.application.bindCurrentChat();
        }
      })
      .catch((error) => logger.warn(
        'Memory 当前聊天重绑失败。',
        safeMemoryFailure(error, { reasonCode: 'WORKSPACE_UNAVAILABLE', stage: 'memory.rebind.current-chat' }),
      ))
      .finally(() => {
        this.rebindPending = false;
        if (this.rebindRequested && !this.stopped) this.scheduleRebind(false);
      });
  }
}
