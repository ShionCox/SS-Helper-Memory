import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  let release: (() => void) | null = null;
  return {
    instances: [] as Array<{
      stop: ReturnType<typeof vi.fn>;
      registerEarlyMessageRecallAction: ReturnType<typeof vi.fn>;
    }>,
    bootstrapFailures: 0,
    waitForStart: () => new Promise<void>((resolve) => { release = resolve; }),
    releaseStart: () => release?.(),
    reset: () => { release = null; state.bootstrapFailures = 0; },
  };
});

vi.mock('../src/host/runtime-feedback', () => ({ logger: { error: vi.fn(), warn: vi.fn() }, traceMemoryStartup: vi.fn() }));
vi.mock('@ss-helper/sdk', () => ({
  bootstrapSSHelper: async (_descriptor: unknown, onSession: (session: unknown) => void) => {
    if (state.bootstrapFailures > 0) { state.bootstrapFailures -= 1; throw new Error('Core unavailable'); }
    const session = {};
    onSession(session);
    return { current: session, closed: new Promise(() => undefined), dispose: vi.fn() };
  },
  API_VERSION: '0.0.1',
  MEMORY_PLUGIN_ID: 'ss-helper.memory',
  SDK_PACKAGE_VERSION: '0.0.1',
  ensureHostedCore: async () => undefined,
  describeSSHelperFailure: () => ({
    reasonCode: 'INTERNAL_ERROR',
    stage: 'memory.startup',
    title: '程序内部错误',
    reason: '当前步骤发生内部异常。',
    action: '请重试。',
    retryable: false,
    transportCode: 'INTERNAL',
  }),
}));
vi.mock('../src/host/memory-runtime', () => ({
  MemoryRuntime: class {
    readonly stop = vi.fn();
    readonly registerEarlyMessageRecallAction = vi.fn();
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
    expect(state.instances[0]?.registerEarlyMessageRecallAction).toHaveBeenCalledTimes(1);
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

  it('clears a failed bootstrap so the next single Core attempt can retry immediately', async () => {
    state.bootstrapFailures = 1;
    const entry = await import('../src/entry');
    entry.stop();
    await expect(entry.start()).rejects.toThrow('Core unavailable');
    const retry = entry.start();
    await flushMicrotasks();
    state.releaseStart();
    expect(await retry).not.toBeNull();
    entry.stop();
  });
});
