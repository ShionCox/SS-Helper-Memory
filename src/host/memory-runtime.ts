import type { PluginSession, SettingsStatusSnapshot } from '@ss-helper/sdk';
import { MemoryApplication } from '../application/memory-application';
import { MEMORY_WORKSPACE_RECOVERY_POPUP, registerMemoryContributions, type MemoryHostCapability } from '../ss-helper/plugin';
import { renderMemoryWorkbench } from '../ui/memory-ui';
import { buildMemoryPromptContribution } from './prompt-injection';
import { logger, traceMemoryStartup } from './runtime-feedback';
import { captureMainChatUsage } from './main-chat-usage';
import { SdkMemoryHostContext } from './sdk-host-context';
import { configureMemoryLlmApi } from '../application/ingest/llm-extractor';
import { createMemoryLlmApi } from '../ss-helper/llm-adapter';
import { MemoryRepository } from '../infrastructure/memory-repository';
import { MemoryLlmCapabilityMonitor } from '../ss-helper/llm-capability-monitor';

const SEND_WINDOW_MS = 45_000;
const MEMORY_PROMPT_ID = 'ss-helper.memory.recall.v1';
const MAX_REBINDS_PER_TURN = 3;
const REBIND_RETRY_DELAY_MS = 250;

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
  private rebindRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private recoveryPrompted = false;
  private stopped = false;
  private started = false;
  private readonly abortController = new AbortController();

  constructor(
    private readonly session: PluginSession<MemoryHostCapability>,
    application = new MemoryApplication(new MemoryRepository(session.workspace)),
  ) {
    this.application = application;
    this.context = new SdkMemoryHostContext(session);
    this.application.useHostContext(this.context);
  }

  async start(): Promise<boolean> {
    traceMemoryStartup('runtime:start');
    if (this.started) return this.application.isSqliteAvailable();
    this.started = true;
    this.stopped = false;
    this.recoveryPrompted = false;
    try {
      configureMemoryLlmApi(createMemoryLlmApi(this.session, this.abortController.signal));
      await this.context.refresh();
      this.assertActive();
      traceMemoryStartup('runtime:context-ready');
      this.application.bindStorageScope(this.context.getWorkspaceId(), this.context.getChatKey());
      await this.application.start();
      this.assertActive();
      traceMemoryStartup('runtime:application-started');
      const capabilityMonitor = new MemoryLlmCapabilityMonitor(
        this.session,
        // LLM resource status is global.  Current-chat activation is reported by
        // currentChatEffective/workspaceStatus and must not make a healthy LLM
        // look like it is disabled merely because no chat is selected yet.
        () => this.application.getSettings(),
        (listener) => this.application.onSettingsChanged(() => listener()),
        () => memoryWorkspaceStatus(this.application),
      );
      this.disposers.push(() => capabilityMonitor.dispose());
      await capabilityMonitor.start();
      this.assertActive();
      traceMemoryStartup('runtime:capabilities-ready');
      const contributions = registerMemoryContributions(
        this.session,
        this.application,
        (container, actionId, popupUi) => renderMemoryWorkbench(
          container,
          this.application,
          (notification) => this.session.ui.showToast(notification),
          popupUi,
          actionId,
        ),
        capabilityMonitor,
        { repair: () => this.session.workspace.repair({ confirm: true }) },
      );
      this.disposers.push(() => contributions.dispose());
      this.assertActive();
      this.bindHostEvents(capabilityMonitor);
      traceMemoryStartup('runtime:contributions-registered');
      // MemoryApplication.start() already ran the first workspace health/open
      // sequence. A second health request here raced the host APP_READY turn in
      // fresh SillyTavern and could leave the renderer unresponsive.
      const connected = this.application.isSqliteAvailable();
      traceMemoryStartup(`runtime:storage-${connected ? 'connected' : 'degraded'}`);
      if (connected) logger.success('Memory workspace 已启动。');
      else {
        logger.error('Memory workspace 不可用，记忆功能已安全停用。');
        void this.offerWorkspaceRecovery().catch((error) => logger.warn('Memory workspace 恢复状态检查失败。', error));
      }
      return connected;
    } catch (error) {
      if (!this.stopped) this.stop();
      if (this.abortController.signal.aborted) return false;
      throw error;
    }
  }

  private assertActive(): void {
    if (this.stopped || this.abortController.signal.aborted) {
      const error = new Error('Memory runtime was stopped during startup') as Error & { code?: string };
      error.code = 'MEMORY_START_CANCELLED';
      throw error;
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.abortController.abort();
    while (this.disposers.length > 0) this.disposers.pop()?.();
    void this.session.host.prompt.remove(MEMORY_PROMPT_ID).catch(() => undefined);
    this.rebindPending = false;
    this.rebindRequested = false;
    this.rebindRefreshRequested = false;
    if (this.rebindRetryTimer !== undefined) clearTimeout(this.rebindRetryTimer);
    this.rebindRetryTimer = undefined;
    this.rebindPromise = Promise.resolve();
    this.recoveryPrompted = false;
    this.application.stop();
    configureMemoryLlmApi(null);
    logger.info('Memory 已停止。');
  }

  private bindHostEvents(capabilityMonitor: MemoryLlmCapabilityMonitor): void {
    const events = this.session.host.events;
    this.disposers.push(events.subscribe('chat-changed', (event) => {
      this.context.setChatKey(event.chatKey);
      this.lastUserMessageAt = 0;
      void this.session.host.prompt.remove(MEMORY_PROMPT_ID).catch(() => undefined);
      void this.context.refresh()
        .then(async () => {
          await capabilityMonitor.refreshNow();
          this.scheduleRebind(false);
        })
        .catch((error) => logger.warn('Memory workspace refresh failed', error));
    }));
    this.disposers.push(events.subscribe('identity-changed', () => {
      void this.context.refresh()
        .then(async () => {
          await capabilityMonitor.refreshNow();
          this.scheduleRebind(false);
        })
        .catch((error) => logger.warn('Memory identity refresh failed', error));
    }));
    this.disposers.push(events.subscribe('message-sent', () => {
      this.lastUserMessageAt = Date.now();
      this.scheduleRebind(true);
    }));
    this.disposers.push(events.subscribe('generation-ended', (event) => {
      void this.onGenerationEnded(event.generation).catch((error) => logger.warn('Memory generation-end 处理失败。', error));
    }));
    this.disposers.push(events.subscribe('prompt-ready', (event) => {
      void this.onPromptReady(event.prompt.messages).catch((error) => logger.warn('Memory Prompt 处理失败。', error));
    }));
  }

  private async offerWorkspaceRecovery(): Promise<void> {
    if (this.stopped || this.recoveryPrompted) return;
    const health = await this.session.workspace.health();
    if (this.stopped || health.ready || health.recoverable !== true) return;
    this.recoveryPrompted = true;
    this.session.ui.openPopup(MEMORY_WORKSPACE_RECOVERY_POPUP, {
      errorCode: health.errorCode ?? 'WORKSPACE_UNAVAILABLE',
    });
  }

  private async onGenerationEnded(generation: { readonly provider?: string; readonly model?: string; readonly usage?: unknown }): Promise<void> {
    const messages = await this.session.host.chat.readMessages();
    const latestText = messages.slice(-2).map((message) => message.text).filter(Boolean).join('\n');
    const usage = captureMainChatUsage(this.application.getChatKey(), generation, messages);
    if (usage) {
      await this.application.recordMainChatUsage({
        ...usage,
        ...(generation.provider ? { provider: generation.provider } : {}),
        ...(generation.model ? { model: generation.model } : {}),
      }).catch((error) => logger.warn('主聊天 Token usage 记录失败。', error));
    }
    this.application.observeCompletedRound(latestText);
  }

  private async onPromptReady(messages: Parameters<typeof buildMemoryPromptContribution>[0]): Promise<void> {
    await this.rebindPromise;
    const settings = this.application.getEffectiveSettings();
    if (!settings.enabled || Date.now() - this.lastUserMessageAt > SEND_WINDOW_MS) {
      await this.session.host.prompt.remove(MEMORY_PROMPT_ID).catch(() => undefined);
      return;
    }
    try {
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
      logger.warn('Prompt 记忆注入失败，已保留原始 Prompt。', error);
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
        let rounds = 0;
        while (this.rebindRequested && !this.stopped && rounds < MAX_REBINDS_PER_TURN) {
          const shouldRefreshContext = this.rebindRefreshRequested;
          this.rebindRequested = false;
          this.rebindRefreshRequested = false;
          if (shouldRefreshContext) await this.context.refresh();
          if (this.stopped) return;
          await this.application.bindCurrentChat();
          rounds += 1;
        }
      })
      .catch((error) => logger.warn('Memory 当前聊天重绑失败。', error))
      .finally(() => {
        this.rebindPending = false;
        if (this.rebindRequested && !this.stopped) this.deferRebind();
      });
  }

  private deferRebind(): void {
    if (this.rebindRetryTimer !== undefined || this.stopped) return;
    this.rebindRetryTimer = setTimeout(() => {
      this.rebindRetryTimer = undefined;
      this.scheduleRebind(false);
    }, REBIND_RETRY_DELAY_MS);
  }
}
