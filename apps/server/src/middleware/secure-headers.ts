/**
 * 安全响应头（Hono 唯一发起点）。
 *
 * 依据：设计文档 v1.1 §3.6 / §10.2 裁决 29 ——
 * CSP `default-src 'self'` + `style-src 'self' 'unsafe-inline'`；
 * 纯 HTTP 必须关闭 HSTS（`strictTransportSecurity` 默认 true，必须显式 false）；
 * `X-Frame-Options: DENY`（默认 SAMEORIGIN）、`Referrer-Policy: no-referrer`、
 * `X-Content-Type-Options: nosniff`；不含 worker-src / upgrade-insecure-requests。
 * 常量字面量全部取自 @stockin/shared，不在本模块另写一份。
 */
import { secureHeaders } from 'hono/secure-headers';
import type { MiddlewareHandler } from 'hono';
import {
  CSP_DEFAULT_SRC,
  CSP_HEADER_VALUE,
  CSP_STYLE_SRC,
  SECURITY_HEADERS,
} from '@stockin/shared';
import type { AppEnv } from '../types/hono';

/**
 * 构造安全头中间件。先让 hono/secure-headers 下发基线头（含显式关闭 HSTS），
 * 再用 shared 的 CSP_HEADER_VALUE 覆写 CSP，保证字面量与设计文档逐字一致。
 * next() 之后再补一次，确保 404 / 错误响应同样带全基线头。
 */
export function createSecureHeadersMiddleware(): MiddlewareHandler<AppEnv> {
  const baseline = secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: [CSP_DEFAULT_SRC],
      styleSrc: CSP_STYLE_SRC.split(' '),
    },
    strictTransportSecurity: false,
    xFrameOptions: SECURITY_HEADERS.X_FRAME_OPTIONS,
    referrerPolicy: SECURITY_HEADERS.REFERRER_POLICY,
    xContentTypeOptions: SECURITY_HEADERS.X_CONTENT_TYPE_OPTIONS,
  }) as MiddlewareHandler<AppEnv>;

  return async (c, next): Promise<void> => {
    await baseline(c, next);
    const headers: Headers = c.res.headers;
    headers.set('x-content-type-options', SECURITY_HEADERS.X_CONTENT_TYPE_OPTIONS);
    headers.set('x-frame-options', SECURITY_HEADERS.X_FRAME_OPTIONS);
    headers.set('referrer-policy', SECURITY_HEADERS.REFERRER_POLICY);
    headers.set('content-security-policy', CSP_HEADER_VALUE);
    // 纯 HTTP 下显式移除任何可能被上游/框架补上的 HSTS。
    headers.delete('strict-transport-security');
  };
}
