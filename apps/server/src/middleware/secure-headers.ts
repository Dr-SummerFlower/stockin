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
  CSP_STYLE_SRC,
  HSTS_HEADER_VALUE,
  SECURITY_HEADERS,
  cspHeaderValue,
} from '@stockin/shared';
import type { AppEnv } from '../types/hono';

/** 安全头选项：只有 HTTPS 部署才下发 HSTS。 */
export interface SecurityHeaderOptions {
  /** `originScheme === 'https'` 时为 true；纯 HTTP 必须为 false。 */
  readonly hsts: boolean;
}

/**
 * 把项目口径的安全头写到给定 Headers 上。
 *
 * 抽成纯函数是为了让「中间件正常响应」与「onError 兜底」共用同一段代码：
 * 错误响应也要带 CSP，否则 500 页面在浏览器里会失去既有保护。
 *
 * HSTS 按来源 scheme 分支：纯 HTTP 下**必须移除**（否则 IP:PORT 会被锁进
 * 强制 https），HTTPS 下必须下发 —— 此前无条件删除，导致 Workers 部署
 * 完全没有 HSTS（AUDIT-04）。
 *
 * 注意这里**不写** `x-request-id`：它由 request-id 中间件统一签发，
 * 错误信封（`lib/response.ts`）另行带上同一个值，再在这里写一遍就是第三个真源。
 */
export function applySecurityHeaders(
  headers: Headers,
  options: SecurityHeaderOptions,
  nonce: string | null = null,
): void {
  headers.set('content-security-policy', cspHeaderValue(nonce));
  headers.set('x-frame-options', SECURITY_HEADERS.X_FRAME_OPTIONS);
  headers.set('x-content-type-options', SECURITY_HEADERS.X_CONTENT_TYPE_OPTIONS);
  headers.set('referrer-policy', SECURITY_HEADERS.REFERRER_POLICY);
  if (options.hsts) {
    headers.set('strict-transport-security', HSTS_HEADER_VALUE);
  } else {
    // 纯 HTTP 下显式移除任何可能被上游/框架补上的 HSTS。
    headers.delete('strict-transport-security');
  }
}

/**
 * 生成 CSP nonce：16 字节随机数的 hex（128 bit，足以抵抗猜测）。
 * 每个请求调用一次，存进 `c.set('cspNonce', ...)` 供 onError 复用，
 * 保证「200 正常响应」与「500 兜底响应」的 CSP 字面量一致。
 */
export function newCspNonce(): string {
  const bytes: Uint8Array = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b: number): string => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 构造安全头中间件。先让 hono/secure-headers 下发基线头（HSTS 按 scheme 开关），
 * 再用 shared 的 cspHeaderValue(nonce) 覆写 CSP：nonce 逐请求随机，CF 的 JSD 会解析
 * 响应头里的 nonce 并给注入脚本打上同一个值，从而在不放开 unsafe-inline 的前提下
 * 让 CF 防护脚本正常执行（AUDIT-09）。
 * 注册位置在 requestId 之后、CSRF 之前：洋葱模型下它的 after 代码在内层
 * 全部执行完之后运行，因此被 CSRF / bodyLimit / 限流直接拒绝的响应同样带全套头。
 */
export function createSecureHeadersMiddleware(
  options: SecurityHeaderOptions,
): MiddlewareHandler<AppEnv> {
  const baseline = secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: [CSP_DEFAULT_SRC],
      styleSrc: CSP_STYLE_SRC.split(' '),
    },
    strictTransportSecurity: options.hsts ? HSTS_HEADER_VALUE : false,
    xFrameOptions: SECURITY_HEADERS.X_FRAME_OPTIONS,
    referrerPolicy: SECURITY_HEADERS.REFERRER_POLICY,
    xContentTypeOptions: SECURITY_HEADERS.X_CONTENT_TYPE_OPTIONS,
  }) as MiddlewareHandler<AppEnv>;

  return async (c, next): Promise<void> => {
    const nonce: string = newCspNonce();
    c.set('cspNonce', nonce);
    await baseline(c, next);
    applySecurityHeaders(c.res.headers, options, nonce);
  };
}
