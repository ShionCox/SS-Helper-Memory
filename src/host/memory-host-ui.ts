import type { PluginSession } from '@ss-helper/sdk';
import { MEMORY_WORKBENCH_POPUP } from '../ss-helper/settings';

const OWNER_ATTRIBUTE = 'data-ss-helper-memory-owner';
const MENU_CONTAINER_ID = 'ss-helper-memory-wand-container';
const MENU_BUTTON_ID = 'ss-helper-memory-open-workbench';

let ownerSequence = 0;

type MemoryHostUiSession = Pick<PluginSession, 'ui'>;

export interface MemoryHostUiHandle { dispose(): void }

function nodeContainsMenu(node: Node): boolean {
  if (!(node instanceof Element)) return false;
  return node.id === 'extensionsMenu' || node.querySelector('#extensionsMenu') !== null;
}

class MemoryHostUiController implements MemoryHostUiHandle {
  private readonly ownerId = `memory-host-ui-${++ownerSequence}`;
  private observer: MutationObserver | undefined;
  private disposed = false;

  constructor(private readonly session: MemoryHostUiSession) {
    if (typeof document === 'undefined') return;
    this.ensureMenuEntry();
    if (typeof MutationObserver === 'undefined') return;
    const root = document.body ?? document.documentElement;
    this.observer = new MutationObserver((mutations) => {
      if (!mutations.some((mutation) => [...mutation.addedNodes, ...mutation.removedNodes].some(nodeContainsMenu))) return;
      this.ensureMenuEntry();
    });
    this.observer.observe(root, { childList: true, subtree: true });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observer?.disconnect();
    this.observer = undefined;
    if (typeof document !== 'undefined') {
      document.querySelector<HTMLElement>(`#${MENU_CONTAINER_ID}[${OWNER_ATTRIBUTE}="${this.ownerId}"]`)?.remove();
    }
  }

  private ensureMenuEntry(): void {
    if (this.disposed || typeof document === 'undefined') return;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    const current = document.getElementById(MENU_CONTAINER_ID);
    if (current?.parentElement === menu && current.getAttribute(OWNER_ATTRIBUTE) === this.ownerId) return;
    current?.remove();

    const container = document.createElement('div');
    container.id = MENU_CONTAINER_ID;
    container.className = 'extension_container';
    container.setAttribute(OWNER_ATTRIBUTE, this.ownerId);
    const separator = document.createElement('hr');
    separator.setAttribute('aria-hidden', 'true');
    const button = document.createElement('div');
    button.id = MENU_BUTTON_ID;
    button.className = 'list-group-item flex-container flexGap5';
    button.setAttribute('role', 'button');
    button.setAttribute('tabindex', '0');
    button.setAttribute('title', '打开记忆工作台');
    button.innerHTML = '<ss-helper-icon name="brain" class="extensionsMenuExtensionButton" decorative></ss-helper-icon><span>记忆工作台</span>';
    const openWorkbench = (): void => {
      menu.style.display = 'none';
      this.session.ui.openPopup(MEMORY_WORKBENCH_POPUP, { actionId: 'open-workbench' });
    };
    button.addEventListener('click', openWorkbench);
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openWorkbench();
    });
    container.append(separator, button);
    menu.append(container);
  }
}

export function mountMemoryHostUi(session: MemoryHostUiSession): MemoryHostUiHandle {
  return new MemoryHostUiController(session);
}
