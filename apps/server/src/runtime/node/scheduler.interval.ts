/**
 * Node 后台任务调度器：进程内 setTimeout 驱动逻辑备份 / 恢复的异步 tick。
 *
 * 语义：
 *  - `setTick` 注册由 assemble 注入的回调（返回 true 表示还有工作，需要续调度）。
 *  - `schedule(delay)` 请求一次 tick；多次请求合并为一个（避免 enqueue + finish
 *    各调一次导致并发推进同一 job）。
 *  - tick 执行期间再次 schedule 会被记录，执行完后合并触发一次。
 *  - `stop()` 清掉定时器（优雅停机），幂等。
 */
import { logger } from '../../lib/logger';
import type { BackgroundTaskScheduler } from '../ports';

export interface NodeSchedulerOptions {
  /** 续调度间隔（tick 返回 true 后）。 */
  readonly continueDelayMs?: number;
  /** 单次 tick 的最小间隔，防止 busy loop。 */
  readonly minDelayMs?: number;
}

export function createNodeScheduler(options: NodeSchedulerOptions = {}): BackgroundTaskScheduler {
  const continueDelay: number = options.continueDelayMs ?? 10;
  const minDelay: number = options.minDelayMs ?? 5;
  let tickFn: (() => Promise<boolean>) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let pending = false;
  let stopped = false;

  const arm = (delay: number): void => {
    if (stopped || timer !== null) {
      return;
    }
    timer = setTimeout(
      () => {
        timer = null;
        void runTick();
      },
      Math.max(0, delay),
    );
  };

  const runTick = async (): Promise<void> => {
    if (tickFn === null || running) {
      if (running) {
        pending = true;
      }
      return;
    }
    running = true;
    try {
      const more: boolean = await tickFn();
      if (more && !stopped) {
        arm(continueDelay);
      }
    } catch (error) {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        '[scheduler-node] 后台 tick 抛错',
      );
    } finally {
      running = false;
      if (pending && !stopped) {
        pending = false;
        arm(minDelay);
      }
    }
  };

  return {
    setTick(fn: () => Promise<boolean>): void {
      tickFn = fn;
    },
    schedule(delayMs = minDelay): void {
      if (stopped) {
        return;
      }
      if (running) {
        pending = true;
        return;
      }
      arm(delayMs);
    },
    stop(): void {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending = false;
    },
  };
}
