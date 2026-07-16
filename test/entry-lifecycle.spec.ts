import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  let release: (() => void) | null = null;
  return {
    instances: [] as Array<{ stop: ReturnType<typeof vi.fn> }>,
    waitForStart: () => new Promise<void>((resolve) => { release = resolve; }),
    releaseStart: () => release?.(),
    reset: () => { release = null; },
  };
});

vi.mock('../src/host/runtime-feedback', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('@ss-helper/sdk', () => ({
  bootstrapSSHelper: async (_descriptor: unknown, onSession: (session: unknown) => void) => {
    const session = {};
    onSession(session);
    return { current: session, closed: new Promise(() => undefined), dispose: vi.fn() };
  },
  API_MAJOR: 1,
  API_MINOR: 0,
  MEMORY_PLUGIN_ID: 'ss-helper.memory',
  SDK_PACKAGE_VERSION: '1.0.0',
  ensureHostedCore: async () => undefined,
}));
vi.mock('../src/host/memory-runtime', () => ({
  MemoryRuntime: class {
    readonly stop = vi.fn();
    constructor() { state.instances.push(this); }
    start(): Promise<void> { return state.waitForStart(); }
  },
}));

describe('entry lifecycle', () => {
  beforeEach(() => state.reset());

  it('cancels an unfinished start and keeps later start-stop-start idempotent', async () => {
    const entry = await import('../src/entry');
    const first = entry.start();
    await Promise.resolve();
    entry.stop();
    state.releaseStart();

    expect(await first).toBeNull();
    expect(state.instances[0]?.stop).toHaveBeenCalledTimes(1);

    const secondPromise = entry.start();
    await Promise.resolve();
    state.releaseStart();
    const second = await secondPromise;
    expect(second).not.toBeNull();
    entry.stop();

    const thirdPromise = entry.start();
    await Promise.resolve();
    state.releaseStart();
    expect(await thirdPromise).not.toBeNull();
    entry.stop();
    expect(state.instances).toHaveLength(3);
  });
});
