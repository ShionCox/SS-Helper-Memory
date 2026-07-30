import {
  bootstrapSSHelper,
  describeSSHelperFailure,
  ensureHostedCore,
  type SessionBootstrap,
} from '@ss-helper/sdk';
import { MemoryRuntime } from './host/memory-runtime';
import { logger, traceMemoryStartup } from './host/runtime-feedback';
import { MEMORY_PLUGIN_DESCRIPTOR, type MemoryHostCapability } from './ss-helper/plugin';

let runtime: MemoryRuntime | null = null;
let bootstrap: SessionBootstrap<MemoryHostCapability> | null = null;
let startPromise: Promise<MemoryRuntime | null> | null = null;
let lifecycleVersion = 0;
let activeStartAttempt: { readonly version: number; cancel(): void } | null = null;
let startingRuntime: MemoryRuntime | null = null;
const stoppedRuntimes = new WeakSet<MemoryRuntime>();

function stopRuntime(candidate: MemoryRuntime | null): void {
  if (!candidate || stoppedRuntimes.has(candidate)) return;
  stoppedRuntimes.add(candidate);
  candidate.stop();
}

function showActivationFailure(session: SessionBootstrap<MemoryHostCapability>['current'], error: unknown): void {
  const diagnostic = describeSSHelperFailure(error, { reasonCode: 'INTERNAL_ERROR', stage: 'memory.startup' });
  try {
    session.ui.showToast({
      level: 'error',
      title: diagnostic.title,
      message: `${diagnostic.reason} ${diagnostic.action}`,
      code: diagnostic.reasonCode,
    });
  } catch {
    // Core may be reconnecting; the structured console diagnostic below remains available.
  }
}

async function activate(session: SessionBootstrap<MemoryHostCapability>['current'], version: number, signal: AbortSignal): Promise<MemoryRuntime | null> {
  traceMemoryStartup('activate:begin');
  stopRuntime(runtime);
  const next = new MemoryRuntime(session);
  next.registerEarlyMessageRecallAction();
  startingRuntime = next;
  let connected: boolean;
  try {
    if (signal.aborted || version !== lifecycleVersion) { stopRuntime(next); return null; }
    connected = await next.start();
  } finally {
    if (startingRuntime === next) startingRuntime = null;
  }
  traceMemoryStartup(`activate:runtime-${connected ? 'connected' : 'degraded'}`);
  if (version !== lifecycleVersion) {
    stopRuntime(next);
    return null;
  }
  runtime = next;
  if (!connected) logger.warn('Memory 已连接 Core，但 SQLite 当前不可用。');
  return next;
}

/**
 * Idempotent, cancellable bootstrap. APP_READY is awaited outside the extension
 * loader path, so an early extension import can never block SillyTavern itself.
 */
export function start(): Promise<MemoryRuntime | null> {
  traceMemoryStartup('start:requested');
  if (runtime) return Promise.resolve(runtime);
  if (startPromise) return startPromise;
  const version = lifecycleVersion;
  const controller = new AbortController();
  let resolveFirst!: (value: MemoryRuntime | null) => void;
  let rejectFirst!: (reason?: unknown) => void;
  let firstSettled = false;
  const first = new Promise<MemoryRuntime | null>((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
  // The first session is normally awaited below. Attach a side handler as well
  // so an unusually slow bridge cannot surface an early timeout as unhandled.
  void first.catch(() => undefined);
  const resolveFirstOnce = (value: MemoryRuntime | null): void => {
    if (firstSettled) return;
    firstSettled = true;
    resolveFirst(value);
  };
  const rejectFirstOnce = (error: unknown): void => {
    if (firstSettled) return;
    firstSettled = true;
    rejectFirst(error);
  };
  const attempt = {
    version,
    cancel: () => {
      controller.abort();
      resolveFirstOnce(null);
    },
  };

  let pending!: Promise<MemoryRuntime | null>;
  pending = (async () => {
    let nextBootstrap: SessionBootstrap<MemoryHostCapability> | null = null;
    try {
      await ensureHostedCore();
      traceMemoryStartup('start:core-ready');
      if (controller.signal.aborted || version !== lifecycleVersion) return null;
      nextBootstrap = await bootstrapSSHelper(MEMORY_PLUGIN_DESCRIPTOR, (session) => {
        traceMemoryStartup('start:first-session');
        void activate(session, version, controller.signal)
          .then(resolveFirstOnce)
          .catch((error) => {
            showActivationFailure(session, error);
            logger.error('Memory 会话激活失败。', { reasonCode: describeSSHelperFailure(error, { reasonCode: 'INTERNAL_ERROR', stage: 'memory.startup' }).reasonCode });
            rejectFirstOnce(error);
          });
      }, { signal: controller.signal });
      if (controller.signal.aborted || version !== lifecycleVersion) {
        nextBootstrap.dispose();
        return null;
      }
      bootstrap = nextBootstrap;
      void nextBootstrap.closed.catch((error) => {
        logger.warn('Memory Core 重连已关闭。', {
          reasonCode: describeSSHelperFailure(error, { reasonCode: 'INTERNAL_ERROR', stage: 'memory.session.closed' }).reasonCode,
        });
      });
      return await first;
    } catch (error) {
      if (nextBootstrap && bootstrap !== nextBootstrap) nextBootstrap.dispose();
      if (controller.signal.aborted || version !== lifecycleVersion) return null;
      logger.error('Memory 启动失败。', { reasonCode: describeSSHelperFailure(error, { reasonCode: 'INTERNAL_ERROR', stage: 'memory.startup' }).reasonCode });
      throw error;
    } finally {
      if (activeStartAttempt === attempt) activeStartAttempt = null;
      if (startPromise === pending) startPromise = null;
    }
  })();
  // start() is also invoked from a fire-and-forget extension entrypoint. Keep
  // a side handler attached so a timeout cannot become an unhandled renderer
  // rejection before that entrypoint (or a caller) observes the same promise.
  void pending.catch(() => undefined);
  activeStartAttempt = attempt;
  startPromise = pending;
  return pending;
}

export function stop(): void {
  lifecycleVersion += 1;
  activeStartAttempt?.cancel();
  activeStartAttempt = null;
  stopRuntime(startingRuntime);
  startingRuntime = null;
  stopRuntime(runtime);
  runtime = null;
  bootstrap?.dispose();
  bootstrap = null;
  startPromise = null;
}

function autoStart(): void {
  traceMemoryStartup('entry:auto-start');
  void start().catch((error) => {
    logger.error('Memory 自动启动失败。', { reasonCode: describeSSHelperFailure(error, { reasonCode: 'INTERNAL_ERROR', stage: 'memory.startup' }).reasonCode });
  });
}

if (typeof window !== 'undefined') {
  traceMemoryStartup('entry:evaluated');
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoStart, { once: true });
  else autoStart();
}
