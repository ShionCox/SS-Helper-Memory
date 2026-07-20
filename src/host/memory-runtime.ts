import type { PluginSession, SettingsStatusSnapshot } from '@ss-helper/sdk';
import { MemoryApplication } from '../application/memory-application';
import { registerMemoryContributions, type MemoryHostCapability } from '../ss-helper/plugin';
import { renderMemoryWorkbench } from '../ui/memory-ui';
import { buildMemoryPromptContribution } from './prompt-injection';
import { logger } from './runtime-feedback';
import { captureMainChatUsage } from './main-chat-usage';
import { SdkMemoryHostContext } from './sdk-host-context';
import { configureMemoryLlmApi } from '../application/ingest/llm-extractor';
import { createMemoryLlmApi } from '../ss-helper/llm-adapter';
import { MemoryRepository } from '../infrastructure/memory-repository';
import { MemoryLlmCapabilityMonitor } from '../ss-helper/llm-capability-monitor';

const SEND_WINDOW_MS = 45_000;
const MEMORY_PROMPT_ID = 'ss-helper.memory.recall.v1';

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
  private stopped = false;
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
    this.stopped = false;
    configureMemoryLlmApi(createMemoryLlmApi(this.session, this.abortController.signal));
    await this.context.refresh();
    this.application.bindStorageScope(this.context.getWorkspaceId(), this.context.getChatKey());
    await this.application.start();
    const capabilityMonitor = new MemoryLlmCapabilityMonitor(
      this.session,
      // LLM resource status is global.  Current-chat activation is reported by
      // currentChatEffective/workspaceStatus and must not make a healthy LLM
      // look like it is disabled merely because no chat is selected yet.
      () => this.application.getSettings(),
      (listener) => this.application.onSettingsChanged(() => listener()),
      () => memoryWorkspaceStatus(this.application),
    );
    await capabilityMonitor.start();
    this.disposers.push(() => capabilityMonitor.dispose());
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
    );
    this.disposers.push(() => contributions.dispose());
    this.bindHostEvents(capabilityMonitor);
    const storage = await this.application.getSqliteStatus();
    if (storage.connected) logger.success('Memory workspace 已启动。');
    else logger.error('Memory workspace 不可用，记忆功能已安全停用。', storage.lastError);
    return storage.connected;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.abortController.abort();
    while (this.disposers.length > 0) this.disposers.pop()?.();
    void this.session.host.prompt.remove(MEMORY_PROMPT_ID).catch(() => undefined);
    this.rebindPending = false;
    this.rebindRequested = false;
    this.rebindPromise = Promise.resolve();
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
      void this.onGenerationEnded(event.generation);
    }));
    this.disposers.push(events.subscribe('prompt-ready', (event) => {
      void this.onPromptReady(event.prompt.messages);
    }));
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
    if (this.rebindPending) return;
    this.rebindPending = true;
    this.rebindPromise = this.rebindPromise
      .catch(() => undefined)
      .then(async () => {
        while (this.rebindRequested && !this.stopped) {
          this.rebindRequested = false;
          if (refreshContext) await this.context.refresh();
          await this.application.bindCurrentChat();
        }
      })
      .catch((error) => logger.warn('Memory 当前聊天重绑失败。', error))
      .finally(() => { this.rebindPending = false; });
  }
}
