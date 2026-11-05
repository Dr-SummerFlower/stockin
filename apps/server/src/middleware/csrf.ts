/**
 * CSRF：按 `PUBLIC_ORIGIN`（含端口的 `http://<IP>:<PORT>` 字面量）精确比对。
 *
 * 依据：设计文档 v1.1 §3.6 / §5.2 —— 不信任任何 `X-Forwarded-*`，
 * 限流与来源判定都只取真实 socket / 原始 Host。
 * 校验范围：`/api/*` 的写方法（POST / PUT / DELETE / PATCH）。
 */
import type { MiddlewareHandler } from 'hono';
import { ErrorCode } from '@stockin/shared';
import { errorResponse } from '../lib/response';
import type { AppEnv } from '../types/hono';

const WRITE_METHODS: readonly string[] = ['POST', 'PUT', 'DELETE', 'PATCH'];

/** 从 `http://host:port` 字面量取 host 部分。 */
export function hostOfPublicOrigin(publicOrigin: string): string {
  return publicOrigin.slice('http://'.length);
}

/** 取 Referer 的 origin；解析失败返回 null（视为伪造）。 */
function refererOrigin(raw: string): string | null {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * 构造 CSRF 中间件。
 *
 * @param publicOrigin 可信 Origin 字面量，如 `http://127.0.0.1:8080`
 */
export function createCsrfMiddleware(publicOrigin: string): MiddlewareHandler<AppEnv> {
  const expectedHost: string = hostOfPublicOrigin(publicOrigin);

  return async (c, next): Promise<Response | void> => {
    const path: string = c.req.path;
    const method: string = c.req.method.toUpperCase();
    if (!path.startsWith('/api/') || !WRITE_METHODS.includes(method)) {
      await next();
      return;
    }

    const requestId: string = c.get('requestId') ?? '';
    // 刻意不读 x-forwarded-host / x-forwarded-proto / x-forwarded-for。
    const origin: string | undefined = c.req.header('origin');
    const referer: string | undefined = c.req.header('referer');
    const host: string | undefined = c.req.header('host');

    if (host !== expectedHost) {
      return errorResponse(ErrorCode.AUTH_CSRF_FAILED, requestId);
    }
    if (origin !== undefined && origin !== publicOrigin) {
      return errorResponse(ErrorCode.AUTH_CSRF_FAILED, requestId);
    }
    if (referer !== undefined && refererOrigin(referer) !== publicOrigin) {
      return errorResponse(ErrorCode.AUTH_CSRF_FAILED, requestId);
    }
    await next();
  };
}
