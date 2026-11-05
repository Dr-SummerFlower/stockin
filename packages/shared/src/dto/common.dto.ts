/**
 * 通用契约：错误信封、分页、ID 参数。
 * 依据：设计文档 v1.1 §3.5「错误信封 { code, message, details?, requestId }」。
 */
import type { ErrorCode } from '../errors';

/** 统一错误信封。requestId 由 Hono 自生成并贯穿日志与操作日志表。 */
export interface ErrorEnvelope {
  code: ErrorCode;
  message: string;
  details?: unknown;
  requestId: string;
}

export interface Pagination {
  page: number;
  pageSize: number;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** 路径参数 `:id`（正整数）。 */
export interface IdParam {
  id: number;
}

/** 成功响应包装（业务端点可直接使用裸对象，此为可选统一形态）。 */
export interface OkEnvelope<T> {
  data: T;
  requestId?: string;
}

/** 健康检查两态（文档 §5.2：不跑 SQL，重导入期间仍可应答）。 */
export type HealthState = 'ok' | 'not-ready';

export interface HealthResponse {
  status: HealthState;
  requestId?: string;
}

/** 请求级上下文（requestId 由中间件注入）。 */
export interface RequestContext {
  requestId: string;
}
