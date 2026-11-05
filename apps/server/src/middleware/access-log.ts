/**
 * 访问日志：pino JSON → stdout，requestId 贯穿，脱敏由 T03a logger 负责。
 *
 * 依据：设计文档 v1.1 §7.6 / §3.5。注册在链尾语义位置（最外层包裹），
 * 保证无论 handler / 404 / onError 都能在响应生成后写一条日志。
 * 计时使用单调时钟 `process.hrtime.bigint()`，不读取系统时间
 * （系统时钟唯一入口仍是 `lib/today.ts`）。
 */
import type { MiddlewareHandler } from 'hono';
import { logger } from '../lib/logger';
import type { AppEnv } from '../types/hono';

/** 构造访问日志中间件。 */
export function createAccessLogMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next): Promise<void> => {
    const started: bigint = process.hrtime.bigint();
    try {
      await next();
    } finally {
      const durationMs: number = Number(process.hrtime.bigint() - started) / 1_000_000;
      logger.info(
        {
          requestId: c.get('requestId') ?? '',
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          clientIp: c.get('clientIp') ?? '',
          actor: c.get('actor') ?? 'anonymous',
          durationMs: Math.round(durationMs * 100) / 100,
        },
        'access',
      );
    }
  };
}
