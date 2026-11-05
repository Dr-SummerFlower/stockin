/**
 * 健康检查：**两态纯内存 readiness，不跑 SQL**。
 *
 * 依据：设计文档 v1.1 §3.5 / §3.6「健康检查走内存 readiness，重导入期间仍可应答」。
 * `not-ready` → 503 `COMMON_NOT_READY`；`ok` → 200 `{ status: 'ok' }`。
 */
import type { HealthResponse, HealthState } from '@stockin/shared';

/** 进程内就绪状态。启动完成后由 index.ts 调 markReady()。 */
export class HealthService {
  private state: HealthState = 'not-ready';

  /** 标记服务已就绪（bootstrap 完成、监听建立后调用）。 */
  markReady(): void {
    this.state = 'ok';
  }

  /** 停机前退回未就绪态。 */
  markNotReady(): void {
    this.state = 'not-ready';
  }

  /** 当前状态（无 IO、无时钟读取）。 */
  stateNow(): HealthState {
    return this.state;
  }

  /** 构造健康检查响应体。 */
  check(): HealthResponse {
    return { status: this.state };
  }

  /** 是否应返回 200。 */
  isReady(): boolean {
    return this.state === 'ok';
  }
}
