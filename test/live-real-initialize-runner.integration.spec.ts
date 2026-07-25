import { describe, expect, it } from 'vitest';

const RUN = process.env.RUN_LIVE_REAL_INITIALIZE === '1';

describe('真实隔离数据库初始化 CLI 驱动', () => {
  it.skipIf(!RUN)('执行指定的 fresh、resume、validate 或 status 命令', async () => {
    const command = process.env.LIVE_INIT_COMMAND?.trim() || 'status';
    if (!['fresh', 'resume', 'validate', 'status'].includes(command)) {
      throw new Error(`不支持的 LIVE_INIT_COMMAND：${command}`);
    }
    process.argv[2] = command;
    const module = await import('../scripts/live-real-initialize');
    await module.liveRealInitializeRun;
    expect(process.exitCode ?? 0).toBe(0);
  }, 10 * 60_000);
});
