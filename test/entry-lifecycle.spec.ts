import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  let release: (() => void) | null = null;
  return {
    instances: [] as Array<{ stop: ReturnType<typeof vi.fn> }>,
    invokeSession: true,
    waitForStart: () => new Promise<void>((resolve) => { release = resolve; }),
    releaseStart: () => release?.(),
    reset: () => { release = null; state.invokeSession = true; },
  };
});

vi.mock('../src/host/runtime-feedback', () => ({ logger: { error: vi.fn(), warn: vi.fn() }, traceMemoryStartup: vi.fn() }));
vi.mock('@ss-helper/sdk', () => ({
  bootstrapSSHelper: async (_descriptor: unknown, onSession: (session: unknown) => void) => {
    const session = {};
    if (state.invokeSession) onSession(session);
    return { current: session, closed: new Promise(() => undefined), dispose: vi.fn() };
  },
  API_VERSION: '0.0.1',
  MEMORY_PLUGIN_ID: 'ss-helper.memory',
  SDK_PACKAGE_VERSION: '0.0.1',
  ensureHostedCore: async () => undefined,
  waitForTavernReady: async () => undefined,
  SSHelperError: class extends Error {
    readonly code: string;
    constructor(code: string, message: string) { super(message); this.code = code; }
  },
}));
vi.mock('../src/host/memory-runtime', () => ({
  MemoryRuntime: class {
    readonly stop = vi.fn();
    constructor() { state.instances.push(this); }
    start(): Promise<void> { return state.waitForStart(); }
  },
}));

async function flushMicrotasks(count = 12): Promise<void> {
  for (let step = 0; step < count; step += 1) await Promise.resolve();
}

describe('entry lifecycle', () => {
  beforeEach(() => { state.reset(); vi.useRealTimers(); });

  it('cancels an unfinished start and keeps later start-stop-start idempotent', async () => {
    const entry = await import('../src/entry');
    const first = entry.start();
    await flushMicrotasks();
    expect(state.instances).toHaveLength(1);
    entry.stop();
    state.releaseStart();

    expect(await first).toBeNull();
    expect(state.instances[0]?.stop).toHaveBeenCalledTimes(1);

    const secondPromise = entry.start();
    await flushMicrotasks();
    state.releaseStart();
    const second = await secondPromise;
    expect(second).not.toBeNull();
    entry.stop();

    const thirdPromise = entry.start();
    await flushMicrotasks();
    state.releaseStart();
    expect(await thirdPromise).not.toBeNull();
    entry.stop();
    expect(state.instances).toHaveLength(3);
  });

  it('rejects a missing first Core callback instead of retaining a permanent start promise', async () => {
    vi.useFakeTimers();
    state.invokeSession = false;
    const entry = await import('../src/entry');
    entry.stop();
    const pending = entry.start();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).rejects.toMatchObject({ code: 'BOOTSTRAP_CALLBACK_TIMEOUT' });
    state.invokeSession = true;
    const retry = entry.start();
    await flushMicrotasks();
    state.releaseStart();
    expect(await retry).not.toBeNull();
    entry.stop();
  });
});
