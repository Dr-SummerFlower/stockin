/**
 * 请求体大小上限：`BODY_LIMIT_BYTES`（2MB，来自 @stockin/shared）。
 *
 * 依据：设计文档 v1.1 §3.6 / §10.2 裁决 30；超限返回 413 统一错误信封。
 */
import { bodyLimit } from 'hono/body-limit';
import type { MiddlewareHandler } from 'hono';
import { BODY_LIMIT_BYTES, ErrorCode } from '@stockin/shared';
import { errorResponse } from '../lib/response';
import type { AppEnv } from '../types/hono';

/** 构造 bodyLimit 中间件；onError 复用 T03a 的统一错误信封。 */
export function createBodyLimitMiddleware(): MiddlewareHandler<AppEnv> {
  return bodyLimit({
    maxSize: BODY_LIMIT_BYTES,
    onError: (c) => errorResponse(ErrorCode.VALID_BODY_TOO_LARGE, String(c.get('requestId') ?? '')),
  }) as MiddlewareHandler<AppEnv>;
}
