/**
 * requestId 中间件：服务端自生成，**忽略入站 X-Request-Id**。
 *
 * 依据：设计文档 v1.1 §3.5「requestId 由 Hono 自生成（忽略入站同名头），
 * 贯穿 pino 日志与操作日志表」。
 * `headerName: ''` 使 hono/request-id 既不读取也不自动下发该头；
 * 因此本模块额外下发小写 `x-request-id` 响应头，保证响应头 / 错误体 /
 * pino / operation_logs 四处拿到同一个值。
 */
import { randomUUID } from 'node:crypto';
import { requestId } from 'hono/request-id';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types/hono';

/** 供 hono/request-id 使用的自生成函数（忽略入站头，每次调用生成新 ID）。 */
function generateRequestId(): string {
  return randomUUID();
}

/** 自生成 requestId 的中间件（含响应头下发）。 */
export function createRequestIdMiddleware(): MiddlewareHandler<AppEnv> {
  const official = requestId({
    headerName: '',
    generator: generateRequestId,
  }) as MiddlewareHandler<AppEnv>;

  return async (c, next): Promise<void> => {
    await official(c, next);
    const value: string = c.get('requestId') ?? '';
    if (value !== '') {
      c.res.headers.set('x-request-id', value);
    }
  };
}

/** 供非 Hono 路径（如启动期日志）生成同形态 ID。 */
export function newRequestId(): string {
  return randomUUID();
}
