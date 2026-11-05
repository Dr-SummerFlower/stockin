/**
 * 单进程内置每日定时备份。
 *
 * 依据：设计文档 v1.1 §3.6 / §7.5「db.backup() 每日 + 导入前 + 迁移前 +
 * 手动 + 凭证重置前」；SIGTERM 停调度器；与导入共用 heavyTaskGate 互斥。
 */
import { logger } from '../lib/logger';
import type { BackupService } from './backup.service';

/** 每日一次的间隔（毫秒）；常量取自运行期计算，不读系统时钟。 */
const ONE_DAY_MS = 24 * 60 * 60 * 1_000;

/** 内置调度器；start/stop 幂等。 */
export class BackupScheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly backup: BackupService) {}

  /** 启动每日定时备份；首次触发在 24h 后，避免与启动期迁移/基线快照抢锁。 */
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

  /** 停止调度器（SIGTERM / SIGINT 时调用）。 */
  stop(): void {
    if (this.timer === null) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
    logger.info('[backup-scheduler] 每日定时备份已停止');
  }

  /** 是否正在运行。 */
  isRunning(): boolean {
    return this.timer !== null;
  }

  /** 一次定时触发；导入占用信号量时直接跳过，不排队、不阻塞。 */
  private async runDaily(): Promise<void> {
    const result = await this.backup.trigger('scheduled-daily');
    if (!result.ok) {
      logger.warn({ code: result.code }, '[backup-scheduler] 本次定时备份跳过');
    }
  }
}
