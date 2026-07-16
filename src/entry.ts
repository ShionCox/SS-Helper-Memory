import { bootstrapSSHelper, ensureHostedCore, type SessionBootstrap } from '@ss-helper/sdk';
import { MemoryRuntime } from './host/memory-runtime';
import { logger } from './host/runtime-feedback';
import { MEMORY_PLUGIN_DESCRIPTOR, type MemoryHostCapability } from './ss-helper/plugin';

let runtime: MemoryRuntime | null = null;
let bootstrap: SessionBootstrap<MemoryHostCapability> | null = null;
let startPromise: Promise<MemoryRuntime | null> | null = null;
let lifecycleVersion = 0;

async function activate(session: SessionBootstrap<MemoryHostCapability>['current'], version: number): Promise<MemoryRuntime | null> {
  runtime?.stop();
  const next = new MemoryRuntime(session);
  const connected = await next.start();
  if (version !== lifecycleVersion) {
    next.stop();
    return null;
  }
  runtime = next;
  if (!connected) logger.warn('Memory 已连接 Core，但 SQLite 当前不可用。');
  return next;
}

/** Idempotent SDK bootstrap; Core replacement is handled by the SDK reconnect policy. */
export async function start(): Promise<MemoryRuntime | null> {
  if (runtime) return runtime;
  if (startPromise) return startPromise;
  const version = lifecycleVersion;
  let resolveFirst!: (value: MemoryRuntime | null) => void;
  let rejectFirst!: (reason?: unknown) => void;
  const first = new Promise<MemoryRuntime | null>((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
  let pending!: Promise<MemoryRuntime | null>;
  pending = (async () => {
    try {
      await ensureHostedCore();
      const nextBootstrap = await bootstrapSSHelper(MEMORY_PLUGIN_DESCRIPTOR, (session) => {
        void activate(session, version).then(resolveFirst, rejectFirst);
      });
      if (version !== lifecycleVersion) {
        nextBootstrap.dispose();
      } else {
        bootstrap = nextBootstrap;
      }
      return await first;
    } catch (error) {
      logger.error('Memory 启动失败。', error);
      throw error;
    } finally {
      if (startPromise === pending) startPromise = null;
    }
  })();
  startPromise = pending;
  return pending;
}

export function stop(): void {
  lifecycleVersion += 1;
  runtime?.stop();
  runtime = null;
  bootstrap?.dispose();
  bootstrap = null;
  startPromise = null;
}

function autoStart(): void { void start().catch(() => undefined); }

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoStart, { once: true });
  else autoStart();
}
