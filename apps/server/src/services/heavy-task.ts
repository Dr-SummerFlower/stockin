/**
 * 重任务信号量(1)：导入与备份互斥；第 2 个导入返回 503 而非排队。
 *
 * 依据：设计文档 v1.1 §3.6 / §5.2「重任务信号量(1) + 15s deadline +
 * 每 500 行 setImmediate 让出事件循环」。
 * 进程内单例 `heavyTaskGate` 由 excel.service / backup.service 共享。
 */
import { IMPORT_YIELD_EVERY_ROWS } from '@stockin/shared';

/** 非排队信号量：acquire 失败立即返回 false。 */
export class HeavyTaskGate {
  private busy = false;

  /** 尝试占用；已被占用返回 false（调用方映射 503）。 */
  acquire(): boolean {
    if (this.busy) {
      return false;
    }
    this.busy = true;
    return true;
  }

  /** 释放占用，幂等。 */
  release(): void {
    this.busy = false;
  }

  /** 当前是否被占用（备份调度器据此跳过与导入并发的快照）。 */
  isBusy(): boolean {
    return this.busy;
  }

  /**
   * 每 `IMPORT_YIELD_EVERY_ROWS` 行让出一次事件循环。
   *
   * @param processedRows 已处理行数（1-based）
   */
  async yieldIfNeeded(processedRows: number): Promise<void> {
    if (processedRows > 0 && processedRows % IMPORT_YIELD_EVERY_ROWS === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}

/** 全局唯一信号量：导入与备份共享。 */
export const heavyTaskGate: HeavyTaskGate = new HeavyTaskGate();
