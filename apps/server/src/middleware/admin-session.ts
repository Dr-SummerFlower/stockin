/**
 * 管理员会话中间件与守卫。
 *
 * 只挂在 `/api/admin/*`：店主会话（`sid`）与管理员会话（`admin_sid`）
 * 互不识别，权限天然分离。管理员 Cookie 是窗口级（关浏览器即失效），
 * 服务端仍按 30 分钟空闲 / 12 小时绝对双过期兜底。
 */
import type { MiddlewareHandler } from 'hono';
import { ADMIN_SESSION_IDLE_MINUTES, ErrorCode } from '@stockin/shared';
import { clearAdminSessionCookie, getAdminSessionCookie } from '../lib/cookie';
import { hashSessionToken } from '../lib/crypto';
import { utcAfterMinutesIso, utcNowIso } from '../lib/today';
import { errorResponse } from '../lib/response';
import {
  isAdminSessionValid,
  type AdminIdentity,
  type AdminSessionRepository,
} from '../repositories/admin-session.repository';
import type { AdminAccountRepository } from '../repositories/admin-account.repository';
import type { AppEnv } from '../types/hono';

export interface AdminSessionMiddlewareDeps {
  readonly sessions: AdminSessionRepository;
  readonly accounts: AdminAccountRepository;
}

/** 匿名可达的管理员端点（发起登录、回调、身份探测）。 */
export const ADMIN_PUBLIC_PATHS: ReadonlySet<string> = new Set([
  '/api/admin/auth/github/start',
  '/api/admin/auth/github/callback',
  '/api/admin/me',
]);

/** 解析管理员 Cookie → 服务端会话；无效即清 Cookie，不抛错。 */
export function createAdminSessionMiddleware(
  deps: AdminSessionMiddlewareDeps,
): MiddlewareHandler<AppEnv> {
  return async (c, next): Promise<void> => {
    const token: string | null = getAdminSessionCookie(c);
    let identity: AdminIdentity | null = null;
    let actor = 'admin:anonymous';

    if (token !== null) {
      const row = deps.sessions.findByTokenHash(hashSessionToken(token));
      const nowUtc: string = utcNowIso();
      const account = row === null ? null : deps.accounts.findById(row.admin_id);
      if (
        row !== null &&
        account !== null &&
        isAdminSessionValid(row, nowUtc, account.github_login)
      ) {
        identity = { id: row.id, adminId: account.id, login: account.github_login };
        actor = `admin:${account.github_login}`;
        deps.sessions.touch(row.id, nowUtc, utcAfterMinutesIso(ADMIN_SESSION_IDLE_MINUTES));
      } else {
        clearAdminSessionCookie(c);
      }
    }

    c.set('adminSession', identity);
    c.set('adminActor', actor);
    await next();
  };
}

/** 守卫：除公开端点外，`/api/admin/*` 一律要求有效管理员会话。 */
export function createAdminGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next): Promise<Response | void> => {
    if (ADMIN_PUBLIC_PATHS.has(c.req.path)) {
      await next();
      return;
    }
    if (c.get('adminSession') === null || c.get('adminSession') === undefined) {
      return errorResponse(ErrorCode.AUTH_REQUIRED, c.get('requestId') ?? '');
    }
    await next();
  };
}
