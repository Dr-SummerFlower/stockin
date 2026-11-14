/**
 * CSRF：按可信来源集合（`PUBLIC_ORIGINS`，含端口的 `http://<IP>:<PORT>` 字面量）精确比对。
 *
 * 依据：设计文档 v1.1 §3.6 / §5.2 —— 不信任任何 `X-Forwarded-*`，
 * 限流与来源判定都只取真实 socket / 原始 Host。
 * 支持配置多个可信来源（如同一台机器的 `127.0.0.1` 与 `localhost`；
 * 后续要加局域网 IP 等只需在 PUBLIC_ORIGINS 追加）。
 * 写方法请求的 Host / Origin / Referer 命中集合中任一来源即放行。
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
 * @param publicOrigins 可信 Origin 字面量集合，如
 *   `['http://127.0.0.1:8080', 'http://localhost:8080']`
 */
export function createCsrfMiddleware(publicOrigins: readonly string[]): MiddlewareHandler<AppEnv> {
  const expectedOrigins: ReadonlySet<string> = new Set(publicOrigins);
  const expectedHosts: ReadonlySet<string> = new Set(
    publicOrigins.map((origin) => hostOfPublicOrigin(origin)),
  );

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

    // Host 头必须命中任一可信来源的 host（拒绝 DNS rebinding 与跨站伪造）。
    if (host === undefined || !expectedHosts.has(host)) {
      return errorResponse(ErrorCode.AUTH_CSRF_FAILED, requestId);
    }
    // Origin（浏览器写请求必带）必须命中可信来源集合。
    if (origin !== undefined && !expectedOrigins.has(origin)) {
      return errorResponse(ErrorCode.AUTH_CSRF_FAILED, requestId);
    }
    // Referer 若存在，其 origin 同样必须命中可信来源集合。
    if (referer !== undefined) {
      const refOrigin: string | null = refererOrigin(referer);
      if (refOrigin === null || !expectedOrigins.has(refOrigin)) {
        return errorResponse(ErrorCode.AUTH_CSRF_FAILED, requestId);
      }
    }
    await next();
  };
}
