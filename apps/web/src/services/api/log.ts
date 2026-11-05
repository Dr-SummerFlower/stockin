/**
 * 操作日志 API（路径以 T03b `log.routes.ts` 实际注册为准）。
 * 日志 append-only 只读；返回 DB 行 snake_case 形态，前端定义只读视图类型。
 */
import { request } from '../request';

/** `operation_logs` 行的只读视图（与 T03a `OperationLogRow` 同形）。 */
export interface OperationLogEntry {
  readonly id: number;
  readonly action: string;
  readonly target_type: string;
  readonly target_id: number | null;
  readonly detail: string | null;
  readonly request_id: string;
  readonly actor: string;
  readonly occurred_at: string;
}

export interface OperationLogPage {
  readonly items: readonly OperationLogEntry[];
  readonly total: number;
}

export interface OperationLogQuery {
  readonly action?: string;
  readonly targetType?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export function listOperationLogs(query: OperationLogQuery = {}): Promise<OperationLogPage> {
  return request<OperationLogPage>('/api/operation-logs', {
    query: {
      action: query.action,
      targetType: query.targetType,
      from: query.from,
      to: query.to,
      limit: query.limit,
      offset: query.offset,
    },
  });
}
