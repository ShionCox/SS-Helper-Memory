// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginSession } from '@ss-helper/sdk';
import { mountMemoryHostUi } from '../src/host/memory-host-ui';
import { MEMORY_WORKBENCH_POPUP } from '../src/ss-helper/settings';

function hostSession() {
  const openPopup = vi.fn();
  const session = { ui: { openPopup, showToast: vi.fn() } } as unknown as Pick<PluginSession, 'ui'>;
  return { session, openPopup };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Memory host menu enhancement', () => {
  it('mounts one native menu section and opens the registered workbench popup', () => {
    document.body.innerHTML = '<div id="extensionsMenu"></div>';
    const { session, openPopup } = hostSession();
    const handle = mountMemoryHostUi(session);
    const container = document.querySelector('#ss-helper-memory-wand-container');
    const button = document.querySelector<HTMLElement>('#ss-helper-memory-open-workbench');
    expect(container?.querySelector('hr')).not.toBeNull();
    expect(button?.textContent).toContain('记忆工作台');
    button?.click();
    expect(openPopup).toHaveBeenCalledWith(MEMORY_WORKBENCH_POPUP, { actionId: 'open-workbench' });
    button?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(openPopup).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll('#ss-helper-memory-wand-container')).toHaveLength(1);
    handle.dispose();
    expect(document.querySelector('#ss-helper-memory-wand-container')).toBeNull();
  });

  it('restores only the quick entry after SillyTavern replaces its menu DOM', async () => {
    document.body.innerHTML = '<div id="extensionsMenu"></div>';
    const { session } = hostSession();
    const handle = mountMemoryHostUi(session);
    document.querySelector('#extensionsMenu')?.replaceWith(Object.assign(document.createElement('div'), { id: 'extensionsMenu' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelectorAll('#ss-helper-memory-wand-container')).toHaveLength(1);
    expect(document.querySelector('[data-ss-helper-memory-chat-badge]')).toBeNull();
    handle.dispose();
  });
});
