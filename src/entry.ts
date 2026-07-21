import {
  bootstrapSSHelper,
  ensureHostedCore,
  SSHelperError,
  waitForTavernReady,
  type SessionBootstrap,
} from '@ss-helper/sdk';
import { MemoryRuntime } from './host/memory-runtime';
import { logger, traceMemoryStartup } from './host/runtime-feedback';
import { MEMORY_PLUGIN_DESCRIPTOR, type MemoryHostCapability } from './ss-helper/plugin';

const FIRST_SESSION_TIMEOUT_MS = 10_000;
const POST_READY_START_DELAY_MS = 250;

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

function safeCode(error: unknown, fallback = 'MEMORY_START_FAILED'): string {
  const value = error && typeof error === 'object' && 'code' in error ? (error as { readonly code?: unknown }).code : undefined;
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/u.test(value) ? value : fallback;
}

function showActivationFailure(session: SessionBootstrap<MemoryHostCapability>['current'], error: unknown): void {
  try {
    session.ui.showToast({
      level: 'error',
      title: 'Memory 启动失败',
      message: 'Memory 未能完成启动；酒馆其余功能不受影响。',
      code: safeCode(error),
    });
  } catch {
    // Core may be reconnecting; the structured console diagnostic below remains available.
  }
}

/**
 * APP_READY is emitted while SillyTavern is still completing its own final
 * render pass. Yield one bounded browser turn before Memory touches Core DOM
 * contributions, so an extension never competes with the initialization
 * overlay for the same lifecycle turn. Node-side callers remain immediate.
 */
function deferBrowserStartupAfterReady(signal: AbortSignal): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, POST_READY_START_DELAY_MS);
    signal.addEventListener('abort', finish, { once: true });
  });
}

async function activate(session: SessionBootstrap<MemoryHostCapability>['current'], version: number): Promise<MemoryRuntime | null> {
  traceMemoryStartup('activate:begin');
  stopRuntime(runtime);
  const next = new MemoryRuntime(session);
  startingRuntime = next;
  let connected: boolean;
  try {
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
  let firstTimer: ReturnType<typeof setTimeout> | undefined;
  const first = new Promise<MemoryRuntime | null>((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
  // The first session is normally awaited below. Attach a side handler as well
  // so an unusually slow bridge cannot surface an early timeout as unhandled.
  void first.catch(() => undefined);
  const resolveFirstOnce = (value: MemoryRuntime | null): void => {
    if (firstSettled) return;
    firstSettled = true;
    if (firstTimer !== undefined) clearTimeout(firstTimer);
    resolveFirst(value);
  };
  const rejectFirstOnce = (error: unknown): void => {
    if (firstSettled) return;
    firstSettled = true;
    if (firstTimer !== undefined) clearTimeout(firstTimer);
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
      traceMemoryStartup('start:wait-app-ready');
      await waitForTavernReady({ signal: controller.signal });
      traceMemoryStartup('start:app-ready');
      if (controller.signal.aborted || version !== lifecycleVersion) return null;
      traceMemoryStartup('start:defer-browser-turn');
      await deferBrowserStartupAfterReady(controller.signal);
      traceMemoryStartup('start:deferred-browser-turn');
      if (controller.signal.aborted || version !== lifecycleVersion) return null;
      await ensureHostedCore();
      traceMemoryStartup('start:core-ready');
      if (controller.signal.aborted || version !== lifecycleVersion) return null;
      firstTimer = setTimeout(() => rejectFirstOnce(new SSHelperError(
        'BOOTSTRAP_CALLBACK_TIMEOUT',
        'Memory did not receive its first Core session before the deadline',
        { timeoutMs: FIRST_SESSION_TIMEOUT_MS },
      )), FIRST_SESSION_TIMEOUT_MS);
      nextBootstrap = await bootstrapSSHelper(MEMORY_PLUGIN_DESCRIPTOR, (session) => {
        traceMemoryStartup('start:first-session');
        void activate(session, version)
          .then(resolveFirstOnce)
          .catch((error) => {
            showActivationFailure(session, error);
            logger.error('Memory 会话激活失败。', error);
            rejectFirstOnce(error);
          });
      }, { signal: controller.signal });
      if (controller.signal.aborted || version !== lifecycleVersion) {
        nextBootstrap.dispose();
        return null;
      }
      bootstrap = nextBootstrap;
      void nextBootstrap.closed.catch((error) => {
        logger.warn('Memory Core 重连已关闭。', { code: safeCode(error, 'MEMORY_CORE_RECONNECT_CLOSED') });
      });
      return await first;
    } catch (error) {
      if (nextBootstrap && bootstrap !== nextBootstrap) nextBootstrap.dispose();
      if (controller.signal.aborted || version !== lifecycleVersion) return null;
      logger.error('Memory 启动失败。', error);
      throw error;
    } finally {
      if (firstTimer !== undefined) clearTimeout(firstTimer);
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
  void start().catch((error) => logger.error('Memory 自动启动失败。', error));
}

if (typeof window !== 'undefined') {
  traceMemoryStartup('entry:evaluated');
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoStart, { once: true });
  else autoStart();
}
