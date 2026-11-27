/**
 * 认证守卫：白名单外 `/api/*` 一律要求有效会话，401 统一文案。
 *
 * 依据：设计文档 v1.1 §3.5「401 跳登录、统一 401 文案」；
 * 白名单与 init-guard 一致（health / init-status / login / logout / me / setup），
 * 保证首次部署时引导链路可达。`me` 允许匿名以返回 `authenticated:false`。
 */
import type { MiddlewareHandler } from 'hono';
import { ErrorCode } from '@stockin/shared';
import { errorResponse } from '../lib/response';
import type { AppEnv } from '../types/hono';

/** 无需会话即可访问的 API 路径（与 init-guard 白名单保持同源）。 */
export const AUTH_GUARD_WHITELIST: readonly string[] = [
  '/api/health',
  '/api/auth/init-status',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/me',
  '/api/auth/setup',
];

const WHITELIST = new Set<string>(AUTH_GUARD_WHITELIST);

/**
 * 已注册业务端点前缀。未知 `/api/*` 路径直接放行到顶层 `app.notFound`，
 * 由 notFound 返回统一 JSON 404（绝不 fallback 到 index.html）；
 * 对已知业务端点未登录仍保持 401 统一文案。
 */
const PROTECTED_PREFIXES: readonly string[] = [
  '/api/records',
  '/api/orders',
  '/api/trash',
  '/api/operation-logs',
  '/api/dashboard',
  '/api/stats',
  '/api/excel',
  '/api/settings',
  '/api/backup',
  '/api/backups',
  // 账号安全：改密与改密保必须登录；`security-question` / `forgot-password`
  // 是未登录可达的找回流程，刻意不列入。
  '/api/auth/change-password',
  '/api/auth/security',
];

export function isKnownApiPath(path: string): boolean {
  return PROTECTED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** 构造认证守卫；非 `/api/*`（静态资源）与未知 API 路径直接放行。 */
export function createAuthGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next): Promise<Response | void> => {
    const path: string = c.req.path;
    if (!path.startsWith('/api/') || WHITELIST.has(path) || !isKnownApiPath(path)) {
      await next();
      return;
    }
    const session = c.get('session');
    if (session === null || session === undefined) {
      return errorResponse(ErrorCode.AUTH_REQUIRED, c.get('requestId') ?? '');
    }
    await next();
  };
}
