/**
 * 首次引导守卫：`init_state=0` 时白名单外业务接口一律 403 `AUTH_INIT_REQUIRED`。
 *
 * 依据：设计文档 v1.1 §3.5「init guard 白名单：仅 health / init-status /
 * login / logout / me / setup；init_state=0 时其余业务接口一律 403」。
 * 白名单取自 @stockin/shared 的 INIT_GUARD_WHITELIST（单一真源）。
 */
import type { MiddlewareHandler } from 'hono';
import { ErrorCode, INIT_GUARD_WHITELIST } from '@stockin/shared';
import { errorResponse } from '../lib/response';
import type { MetaRepository } from '../repositories/meta.repository';
import { isKnownApiPath } from './auth-guard';
import type { AppEnv } from '../types/hono';

const WHITELIST = new Set<string>(INIT_GUARD_WHITELIST);

/** 构造引导守卫；只对已注册的 `/api/*` 业务端点生效。 */
export function createInitGuard(meta: MetaRepository): MiddlewareHandler<AppEnv> {
  return async (c, next): Promise<Response | void> => {
    const path: string = c.req.path;
    if (!path.startsWith('/api/') || meta.initState() === 1 || !isKnownApiPath(path)) {
      await next();
      return;
    }
    const lastSegment: string = path.slice(path.lastIndexOf('/') + 1);
    if (WHITELIST.has(lastSegment)) {
      await next();
      return;
    }
    return errorResponse(ErrorCode.AUTH_INIT_REQUIRED, c.get('requestId') ?? '');
  };
}
