import { describe, expect, it, vi } from 'vitest';
import type { PluginSession } from '@ss-helper/sdk';
import { registerMemoryContributions, type MemoryHostCapability } from '../src/ss-helper/plugin';
import { MEMORY_WORKBENCH_POPUP } from '../src/ss-helper/settings';

function createSession(includeMenu = true) {
  const popupRegistrations: any[] = [];
  const menuRegistrations: any[] = [];
  const cleanups: Array<ReturnType<typeof vi.fn>> = [];
  const cleanup = () => {
    const fn = vi.fn();
    cleanups.push(fn);
    return fn;
  };
  const openPopup = vi.fn();
  const session = {
    services: { expose: vi.fn(() => cleanup()) },
    events: { publish: vi.fn() },
    ui: { openPopup, showToast: vi.fn() },
    registerChatIndicator: vi.fn(() => cleanup()),
    registerSettings: vi.fn(() => cleanup()),
    registerPopup: vi.fn((registration) => {
      popupRegistrations.push(registration);
      return cleanup();
    }),
    ...(includeMenu ? {
      registerExtensionMenuItem: vi.fn((registration) => {
        menuRegistrations.push(registration);
        return cleanup();
      }),
    } : {}),
  } as unknown as PluginSession<MemoryHostCapability>;
  return { session, popupRegistrations, menuRegistrations, cleanups, openPopup };
}

const controller = {
  isChatEnabled: () => true,
  onSettingsChanged: () => () => undefined,
} as any;

const statusSource = {
  loadStatus: () => ({}),
  subscribeStatus: () => () => undefined,
  assess: () => ({ warnings: [] }),
} as any;

const recovery = { repair: vi.fn() } as any;

describe('Memory extension menu contribution', () => {
  it('registers the workbench item after its popup and opens the canonical token', () => {
    const fixture = createSession();
    const contribution = registerMemoryContributions(
      fixture.session,
      controller,
      () => undefined,
      statusSource,
      recovery,
    );
    expect(fixture.popupRegistrations.some((registration) => registration.token === MEMORY_WORKBENCH_POPUP)).toBe(true);
    expect(fixture.menuRegistrations).toHaveLength(1);
    expect(fixture.menuRegistrations[0]).toMatchObject({
      id: 'memory-workbench',
      label: '记忆工作台',
      icon: 'brain',
      order: 100,
    });
    fixture.menuRegistrations[0].onActivate();
    expect(fixture.openPopup).toHaveBeenCalledWith(MEMORY_WORKBENCH_POPUP, {});

    contribution.dispose();
    expect(fixture.cleanups.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
  });

  it('keeps older Core sessions usable when menu registration is unavailable', () => {
    const fixture = createSession(false);
    expect(() => registerMemoryContributions(
      fixture.session,
      controller,
      () => undefined,
      statusSource,
      recovery,
    ).dispose()).not.toThrow();
    expect(fixture.menuRegistrations).toHaveLength(0);
  });
});
