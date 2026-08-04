import { describe, expect, it, vi } from 'vitest';
import type { PluginSession } from '@ss-helper/sdk';
import { registerMemoryContributions, type MemoryHostCapability } from '../src/ss-helper/plugin';
import { MEMORY_TASK_ROUTING_POPUP, MEMORY_WORKBENCH_POPUP } from '../src/ss-helper/settings';

function createSession() {
  const popupRegistrations: any[] = [];
  const menuRegistrations: any[] = [];
  const messageActionRegistrations: any[] = [];
  const cleanups: Array<ReturnType<typeof vi.fn>> = [];
  const cleanup = () => {
    const fn = vi.fn();
    cleanups.push(fn);
    return fn;
  };
  const openPopup = vi.fn();
  const session = {
    bus: { handle: vi.fn(() => cleanup()), publish: vi.fn() },
    ui: { openPopup, showToast: vi.fn() },
    host: { chat: { navigate: vi.fn() } },
    registerChatIndicator: vi.fn(() => cleanup()),
    registerChatMessageAction: vi.fn((registration) => {
      messageActionRegistrations.push(registration);
      return cleanup();
    }),
    registerSettings: vi.fn(() => cleanup()),
    registerPopup: vi.fn((registration) => {
      popupRegistrations.push(registration);
      return cleanup();
    }),
    registerExtensionMenuItem: vi.fn((registration) => {
      menuRegistrations.push(registration);
      return cleanup();
    }),
  } as unknown as PluginSession<MemoryHostCapability>;
  return { session, popupRegistrations, menuRegistrations, messageActionRegistrations, cleanups, openPopup };
}

const controller = {
  isChatEnabled: () => true,
  onSettingsChanged: () => () => undefined,
  onOverviewChanged: () => () => undefined,
  findGenerationRecallDetails: async () => [],
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
    expect(fixture.popupRegistrations.some((registration) => registration.token === MEMORY_TASK_ROUTING_POPUP)).toBe(true);
    expect(fixture.menuRegistrations).toHaveLength(1);
    expect(fixture.messageActionRegistrations).toEqual([
      expect.objectContaining({ id: 'generation-recall-detail', icon: 'brain' }),
    ]);
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
});
