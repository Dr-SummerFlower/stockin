/**
 * 首次引导守卫：`init_state=0` 时白名单外业务接口一律 403 `AUTH_INIT_REQUIRED`。
 *
 * 依据：设计文档 v1.1 §3.5「init guard 白名单：仅 health / init-status /
 * login / logout / me / setup；init_state=0 时其余业务接口一律 403」。
 * 白名单取自 @stockin/shared 的 INIT_GUARD_WHITELIST（单一真源）。
 *
 * QA 修复 A2：把纯内存的路径判断（`/api/` 前缀、`isKnownApiPath`、白名单）
 * 全部前置，**只有「已知业务端点 且 非白名单」才读 `meta.initState()`**。
 * 这样 `/api/health` 与未知 `/api/*` 不再执行 meta 表 SELECT —— health 保持
 * 「纯内存、不跑 SQL」（§5.2 第 336 行），未知 `/api/*` 仍放行到顶层
 * `app.notFound` 返回统一 JSON 404（T03b 既有行为不变）。
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
    const lastSegment: string = path.slice(path.lastIndexOf('/') + 1);
    // A2：纯内存路径判断先行，DB 查询推迟到最后一刻。
    if (!path.startsWith('/api/') || !isKnownApiPath(path) || WHITELIST.has(lastSegment)) {
      await next();
      return;
    }
    // 只有「已知业务端点 且 非白名单」才读 meta 表。
    if (meta.initState() === 1) {
      await next();
      return;
    }
    return errorResponse(ErrorCode.AUTH_INIT_REQUIRED, c.get('requestId') ?? '');
  };
}
