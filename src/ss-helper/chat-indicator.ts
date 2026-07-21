import {
  LLM_PLUGIN_ID,
  type ChatIndicatorResolution,
  type ChatIndicatorTarget,
  type PluginSession,
} from '@ss-helper/sdk';

const QUERY_CONCURRENCY = 4;

export interface MemoryChatIndicatorController {
  isChatEnabled(workspaceId: string, chatKey: string): boolean;
  onSettingsChanged(listener: () => void): () => void;
}

async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const run = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return results;
}

export function registerMemoryChatIndicator(
  session: Pick<PluginSession, 'workspace' | 'registerChatIndicator'>,
  controller: MemoryChatIndicatorController,
): () => void {
  if (session.registerChatIndicator === undefined) return () => undefined;
  return session.registerChatIndicator({
    label: '记忆',
    icon: 'brain',
    kind: 'direct',
    order: 10,
    resolve: (targets: readonly ChatIndicatorTarget[]) => mapConcurrent(targets, QUERY_CONCURRENCY, async (target): Promise<ChatIndicatorResolution> => {
      try {
        const page = await session.workspace.query({
          workspaceId: target.workspaceId,
          collection: 'facts',
          filter: { chatKey: target.chatKey },
          limit: 1,
        });
        if (page.records.length === 0) return { targetKey: target.key, state: 'hidden' };
        if (!controller.isChatEnabled(target.workspaceId, target.chatKey)) return { targetKey: target.key, state: 'retained' };
        return { targetKey: target.key, state: 'enabled', activeDependencies: [LLM_PLUGIN_ID] };
      } catch {
        return { targetKey: target.key, state: 'hidden' };
      }
    }),
    subscribe: (listener) => controller.onSettingsChanged(() => listener()),
  });
}
