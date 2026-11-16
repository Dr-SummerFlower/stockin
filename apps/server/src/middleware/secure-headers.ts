/**
 * 安全响应头（**唯一发起点**）。
 *
 * 依据：设计文档 v1.1 §3.6 / §10.2 裁决 29 ——
 * CSP `default-src 'self'` + `style-src 'self' 'unsafe-inline'`；
 * 纯 HTTP 必须关闭 HSTS（`strictTransportSecurity` 默认 true，必须显式 false）；
 * `X-Frame-Options: DENY`（默认 SAMEORIGIN）、`Referrer-Policy: no-referrer`、
 * `X-Content-Type-Options: nosniff`；不含 worker-src / upgrade-insecure-requests。
 * 常量字面量全部取自 @stockin/shared，不在本模块另写一份。
 *
 * 2026-11-16（发布审查 P2-2）：此前 `app.ts` 里另有一个
 * `createFinalizeHeadersMiddleware()` 也在写同一批头，两个真源并存 —— 改一处
 * 漏一处的典型温床。现在合并为本模块：hono 的 `secureHeaders` 负责基线
 * （多出来的 COEP/COOP/CORP 等头由它给），`applySecurityHeaders()` 负责把
 * CSP 覆写成 shared 里的逐字字面量并剔除 HSTS。**新增安全头只改这里。**
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
 * 把项目口径的安全头写到给定 Headers 上。
 *
 * 抽成纯函数是为了让「中间件正常响应」与「onError 兜底」共用同一段代码：
 * 错误响应也要带 CSP，否则 500 页面在浏览器里会失去既有保护。
 *
 * 注意这里**不写** `x-request-id`：它由 request-id 中间件统一签发，
 * 错误信封（`lib/response.ts`）另行带上同一个值，再在这里写一遍就是第三个真源。
 */
export function applySecurityHeaders(headers: Headers): void {
  headers.set('content-security-policy', CSP_HEADER_VALUE);
  headers.set('x-frame-options', SECURITY_HEADERS.X_FRAME_OPTIONS);
  headers.set('x-content-type-options', SECURITY_HEADERS.X_CONTENT_TYPE_OPTIONS);
  headers.set('referrer-policy', SECURITY_HEADERS.REFERRER_POLICY);
  // 纯 HTTP 下显式移除任何可能被上游/框架补上的 HSTS。
  headers.delete('strict-transport-security');
}

/**
 * 构造安全头中间件。先让 hono/secure-headers 下发基线头（含显式关闭 HSTS），
 * 再用 shared 的 CSP_HEADER_VALUE 覆写 CSP，保证字面量与设计文档逐字一致。
 * 注册位置在 requestId 之后、CSRF 之前：洋葱模型下它的 after 代码在内层
 * 全部执行完之后运行，因此被 CSRF / bodyLimit / 限流直接拒绝的响应同样带全套头。
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
    applySecurityHeaders(c.res.headers);
  };
}
