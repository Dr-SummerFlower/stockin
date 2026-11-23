/**
 * 单进程内置每日定时调度（Node）。
 *
 * 依据：设计文档 v1.1 §3.6 / §7.5「每日备份 + 导入前 + 迁移前 + 手动」。
 * 调度器不认识具体备份类型，只调用注入的 `runner`——物理备份与加密逻辑备份
 * 各自按间隔由 runner 内部判断，保证 Node interval 与 Workers cron 走同一路径。
 */
import { logger } from '../lib/logger';

const ONE_DAY_MS = 24 * 60 * 60 * 1_000;

/** 内置调度器；start/stop 幂等。 */
export class BackupScheduler {
  private timer: NodeJS.Timeout | null = null;

  /**
   * @param runner 一次"每日"动作的回调（物理 + 逻辑备份），由 assembly 注入
   */
  constructor(private readonly runner: () => Promise<void>) {}

  start(): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => {
      void this.runDaily();
    }, ONE_DAY_MS);
    this.timer.unref();
    logger.info('[backup-scheduler] 每日定时备份已启动');
  }

  stop(): void {
    if (this.timer === null) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
    logger.info('[backup-scheduler] 每日定时备份已停止');
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  private async runDaily(): Promise<void> {
    await this.runner();
  }
}
