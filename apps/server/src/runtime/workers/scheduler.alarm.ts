/**
 * Workers 后台任务调度器：用 Durable Object alarm 驱动逻辑备份 / 恢复 tick。
 *
 * 免费 Workers 单次请求 CPU 10ms，无法在一次请求里序列化整库；DO alarm 把
 * 异步状态机拆成多次独立请求，每次只推进有限 chunk，规避 CPU / 内存上限。
 *
 * 语义与 Node scheduler 对齐：
 *  - `setTick` 注册回调（由 DO 的 `alarm()` 处理器调用）。
 *  - `schedule(delay)` 设置一个 alarm；重复调用覆盖为更早的时间（合并）。
 *  - 回调返回 true 时 Service 内部会再次 `schedule()`，形成链。
 *  - `stop()` 删除 alarm。
 */
import type { DoStorageLike } from '../../repositories/adapters/do-sqlite.adapter';
import type { BackgroundTaskScheduler } from '../ports';

export interface AlarmSchedulerOptions {
  readonly storage: DoStorageLike;
  /** 默认延迟（毫秒）。 */
  readonly defaultDelayMs?: number;
}

export function createAlarmScheduler(options: AlarmSchedulerOptions): BackgroundTaskScheduler {
  const defaultDelay: number = options.defaultDelayMs ?? 10;
  let tickFn: (() => Promise<boolean>) | null = null;
  let nextAlarmMs: number = Number.POSITIVE_INFINITY;
  let stopped = false;

  return {
    setTick(fn: () => Promise<boolean>): void {
      tickFn = fn;
    },
    schedule(delayMs = defaultDelay): void {
      if (stopped) {
        return;
      }
      const target: number = Date.now() + Math.max(0, delayMs);
      // 合并：只保留更早的 alarm，避免重复设置。
      if (target >= nextAlarmMs) {
        return;
      }
      nextAlarmMs = target;
      void options.storage.setAlarm(target).catch(() => {
        // 设置失败时清空标记，下次 schedule 可重试。
        nextAlarmMs = Number.POSITIVE_INFINITY;
      });
    },
    stop(): void {
      stopped = true;
      void options.storage.deleteAlarm();
    },
    /**
     * alarm 触发时由 DO 调用的辅助方法（用类型断言暴露，不在接口里）。
     * 放在返回对象上、通过 `as` 转换访问，避免污染共享端口契约。
     */
    ...({
      async onAlarm(): Promise<void> {
        nextAlarmMs = Number.POSITIVE_INFINITY;
        if (tickFn === null || stopped) {
          return;
        }
        await tickFn();
      },
    } as Record<string, unknown>),
  };
}

/** DO alarm 处理器要调用的扩展方法（仅 Workers scheduler 实现）。 */
export interface AlarmSchedulerHandle extends BackgroundTaskScheduler {
  onAlarm(): Promise<void>;
}

/** 从端口取回 alarm 扩展方法（调用方确认是 Workers 实现后使用）。 */
export function asAlarmScheduler(scheduler: BackgroundTaskScheduler): AlarmSchedulerHandle {
  const candidate = scheduler as Partial<AlarmSchedulerHandle>;
  if (typeof candidate.onAlarm !== 'function') {
    throw new Error('[alarm-scheduler] 当前调度器不支持 alarm');
  }
  return candidate as AlarmSchedulerHandle;
}
