// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderMemoryWorkspaceRecovery } from '../src/ui/workspace-recovery-ui.js';

describe('Memory 工作区恢复界面', () => {
  it('要求二次确认，委托 SDK 的 Popup 关闭，并只显示安全诊断', async () => {
    const container = document.createElement('div');
    const close = vi.fn();
    const refreshControls = vi.fn();
    const repair = vi.fn(async () => ({ backupId: 'ss-helper-recovery-20260720T000000Z-test', requiresReload: true as const }));
    const notify = vi.fn();
    const dispose = renderMemoryWorkspaceRecovery(
      container,
      { errorCode: 'WORKSPACE_DATABASE_UNAVAILABLE' },
      { repair },
      notify,
      { close, refreshControls } as never,
    );

    expect(container.textContent).toContain('WORKSPACE_DATABASE_UNAVAILABLE');
    expect(container.textContent).toContain('加密凭据需要重新录入');
    (container.querySelector('button') as HTMLButtonElement).click();
    expect(close).toHaveBeenCalledTimes(1);
    (container.querySelectorAll('button')[1] as HTMLButtonElement).click();
    expect(container.textContent).toContain('请再次确认恢复');
    expect(repair).not.toHaveBeenCalled();
    (container.querySelectorAll('button')[1] as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    expect(repair).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ code: 'WORKSPACE_RECOVERY_REPAIRED' }));
    expect(container.textContent).toContain('ss-helper-recovery-20260720T000000Z-test');
    expect(refreshControls).toHaveBeenCalled();
    dispose();
  });

  it('从修复失败中仅保留安全错误码', async () => {
    const container = document.createElement('div');
    const notify = vi.fn();
    const dispose = renderMemoryWorkspaceRecovery(
      container,
      { errorCode: 'WORKSPACE_DATABASE_UNAVAILABLE' },
      { repair: async () => { throw { code: 'WORKSPACE_BACKUP_FAILED', message: 'G:\\SillyTavern\\data\\_ss-helper\\secrets.key' }; } },
      notify,
    );

    (container.querySelectorAll('button')[1] as HTMLButtonElement).click();
    (container.querySelectorAll('button')[1] as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    expect(container.textContent).toContain('WORKSPACE_BACKUP_FAILED');
    expect(container.textContent).not.toContain('secrets.key');
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ code: 'WORKSPACE_BACKUP_FAILED' }));
    dispose();
  });
});
