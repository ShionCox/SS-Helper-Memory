import type { PopupUiContext, WorkspaceRecoveryRepairResult } from '@ss-helper/sdk';

export interface MemoryWorkspaceRecoveryInput {
  readonly errorCode?: string;
}

export interface MemoryWorkspaceRecoveryController {
  repair(): Promise<WorkspaceRecoveryRepairResult>;
}

type Notify = (notification: {
  readonly level: 'info' | 'success' | 'warning' | 'error';
  readonly title: string;
  readonly message: string;
  readonly code: string;
}) => void;

function safeCode(error: unknown, fallback = 'WORKSPACE_RECOVERY_FAILED'): string {
  const value = error && typeof error === 'object' && 'code' in error ? (error as { readonly code?: unknown }).code : undefined;
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/u.test(value) ? value : fallback;
}

function button(label: string, tone: 'neutral' | 'danger' | 'primary' = 'neutral'): HTMLButtonElement {
  const value = document.createElement('button');
  value.type = 'button';
  value.textContent = label;
  value.className = 'ss-helper-memory-recovery-button';
  value.dataset.ssHelperControl = 'button';
  value.dataset.ssHelperTone = tone;
  return value;
}

/** Core owns the popup shell; Memory only renders this recovery-specific content. */
export function renderMemoryWorkspaceRecovery(
  container: HTMLElement,
  input: MemoryWorkspaceRecoveryInput,
  controller: MemoryWorkspaceRecoveryController,
  notify: Notify,
  popupUi?: PopupUiContext,
): () => void {
  let disposed = false;
  let armed = false;
  let repairing = false;

  const close = (): void => {
    if (popupUi) popupUi.close();
    else container.replaceChildren();
  };
  const render = (): void => {
    if (disposed) return;
    const root = document.createElement('div');
    root.className = 'ss-helper-memory-workspace-recovery';
    const title = document.createElement('h3');
    title.textContent = armed ? '请再次确认恢复' : 'Memory 工作区需要恢复';
    const detail = document.createElement('p');
    detail.textContent = `检测到可恢复的工作区故障（${input.errorCode ?? 'WORKSPACE_UNAVAILABLE'}）。记忆功能已安全停用，酒馆其余功能可以继续使用。`;
    const warning = document.createElement('p');
    warning.textContent = '重新初始化会先完整备份当前 _ss-helper-v0 目录（包括数据库、WAL/SHM 和密钥），随后创建新的工作区。加密凭据需要重新录入。';
    const controls = document.createElement('div');
    controls.className = 'ss-helper-memory-workspace-recovery__controls';
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    if (!armed) {
      const later = button('稍后处理');
      const prepare = button('备份并重新初始化', 'danger');
      later.addEventListener('click', close);
      prepare.addEventListener('click', () => { armed = true; render(); });
      controls.append(later, prepare);
    } else {
      const back = button('返回');
      const confirm = button('确认备份并重新初始化', 'danger');
      back.addEventListener('click', () => { armed = false; render(); });
      confirm.addEventListener('click', () => {
        if (repairing) return;
        repairing = true;
        confirm.disabled = true;
        back.disabled = true;
        status.textContent = '正在验证备份并重新初始化工作区…';
        void controller.repair()
          .then((result) => {
            if (disposed) return;
            status.textContent = `恢复完成，备份 ID：${result.backupId}。页面即将重新加载。`;
            notify({ level: 'success', title: 'Memory 工作区已恢复', message: `已创建备份 ${result.backupId}，请重新录入加密凭据。`, code: 'WORKSPACE_RECOVERY_REPAIRED' });
            setTimeout(() => { if (!disposed && result.requiresReload) globalThis.location?.reload(); }, 250);
          })
          .catch((error) => {
            if (disposed) return;
            repairing = false;
            confirm.disabled = false;
            back.disabled = false;
            const code = safeCode(error);
            status.textContent = `恢复未完成（${code}）。原始目录未被自动删除。`;
            notify({ level: 'error', title: 'Memory 工作区恢复失败', message: '未完成重新初始化；请稍后重试或检查备份目录。', code });
          });
      });
      controls.append(back, confirm);
    }
    root.append(title, detail, warning, controls, status);
    container.replaceChildren(root);
    popupUi?.refreshControls(root);
  };
  render();
  return () => { disposed = true; };
}
