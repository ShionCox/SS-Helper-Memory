import type { PluginSession } from '@ss-helper/sdk';
import { MemoryApplication } from '../application/memory-application';
import { registerMemoryContributions, type MemoryHostCapability } from '../ss-helper/plugin';
import { renderMemoryWorkbench } from '../ui/memory-ui';
import { buildMemoryPromptContribution } from './prompt-injection';
import { logger } from './runtime-feedback';
import { captureMainChatUsage } from './main-chat-usage';
import { SdkMemoryHostContext } from './sdk-host-context';
import { configureMemoryLlmApi } from '../application/ingest/llm-extractor';
import { createMemoryLlmApi } from '../ss-helper/llm-adapter';

const SEND_WINDOW_MS = 45_000;
const MEMORY_PROMPT_ID = 'ss-helper.memory.recall.v1';

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
    application = new MemoryApplication(),
  ) {
    this.application = application;
    this.context = new SdkMemoryHostContext(session);
    this.application.useHostContext(this.context);
  }

  async start(): Promise<boolean> {
    this.stopped = false;
    configureMemoryLlmApi(createMemoryLlmApi(this.session, this.abortController.signal));
    await this.context.refresh();
    await this.application.start();
    const contributions = registerMemoryContributions(
      this.session,
      this.application,
      (container) => renderMemoryWorkbench(container, this.application),
    );
    this.disposers.push(() => contributions.dispose());
    this.bindHostEvents();
    const sqlite = await this.application.getSqliteStatus();
    if (sqlite.connected) logger.success('Memory SQLite 已启动。');
    else logger.error('Memory SQLite 服务不可用，记忆功能已安全停用。', sqlite.lastError);
    return sqlite.connected;
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

  private bindHostEvents(): void {
    const events = this.session.host.events;
    this.disposers.push(events.subscribe('chat-changed', (event) => {
      this.context.setChatKey(event.chatKey);
      this.lastUserMessageAt = 0;
      void this.session.host.prompt.remove(MEMORY_PROMPT_ID).catch(() => undefined);
      this.scheduleRebind(false);
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
    const settings = this.application.getSettings();
    if (!settings.enabled || Date.now() - this.lastUserMessageAt > SEND_WINDOW_MS) {
      await this.session.host.prompt.remove(MEMORY_PROMPT_ID).catch(() => undefined);
      return;
    }
    try {
      const injection = await buildMemoryPromptContribution(messages, this.application.recall, settings.maxRecallItems, {
        maxChars: settings.promptMaxChars,
        answerMode: settings.answerMode,
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
