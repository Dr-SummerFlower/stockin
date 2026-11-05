/**
 * 认证与初始化路由（设计文档 §3.5 端点表，路径不增不减）。
 *
 * GET  /api/health          GET  /api/auth/init-status
 * GET  /api/auth/me         POST /api/auth/login
 * POST /api/auth/logout     POST /api/auth/setup
 */
import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { ErrorCode, loginSchema, setupSchema } from '@stockin/shared';
import { errorResponse } from '../lib/response';
import { getSessionCookie, setSessionCookie, clearSessionCookie } from '../lib/cookie';
import type { AppEnv } from '../types/hono';
import type { AppDeps } from '../app';

/** 注册认证与初始化端点。 */
export function registerAuthRoutes(api: Hono<AppEnv>, deps: AppDeps): void {
  api.get('/api/health', (c) => {
    if (!deps.health.isReady()) {
      return errorResponse(ErrorCode.COMMON_NOT_READY, c.get('requestId') ?? '');
    }
    return c.json({ ...deps.health.check(), requestId: c.get('requestId') ?? '' }, 200);
  });

  api.get('/api/auth/init-status', (c) => {
    const result = deps.auth.initStatus();
    return result.ok
      ? c.json(result.data, 200)
      : errorResponse(result.code, c.get('requestId') ?? '', result.details);
  });

  api.get('/api/auth/me', (c) => {
    const result = deps.auth.me(c.get('session') ?? null);
    return result.ok
      ? c.json(result.data, 200)
      : errorResponse(result.code, c.get('requestId') ?? '', result.details);
  });

  api.post(
    '/api/auth/login',
    zValidator('json', loginSchema, (result, c) => {
      if (!result.success) {
        return errorResponse(ErrorCode.VALID_FAILED, String(c.get('requestId') ?? ''), {
          issues: result.error.issues,
        });
      }
      return;
    }),
    (c) => {
      const input = c.req.valid('json');
      const result = deps.auth.login(input, getSessionCookie(c), {
        requestId: c.get('requestId') ?? '',
        clientIp: c.get('clientIp') ?? '',
      });
      if (!result.ok) {
        return errorResponse(result.code, c.get('requestId') ?? '', result.details);
      }
      setSessionCookie(c, result.data.token);
      return c.json({ ok: true, initState: result.data.initState }, 200);
    },
  );

  api.post('/api/auth/logout', (c) => {
    const result = deps.auth.logout(getSessionCookie(c), {
      requestId: c.get('requestId') ?? '',
      clientIp: c.get('clientIp') ?? '',
    });
    clearSessionCookie(c);
    return result.ok
      ? c.json(result.data, 200)
      : errorResponse(result.code, c.get('requestId') ?? '', result.details);
  });

  api.post(
    '/api/auth/setup',
    zValidator('json', setupSchema, (result, c) => {
      if (!result.success) {
        return errorResponse(ErrorCode.VALID_FAILED, String(c.get('requestId') ?? ''), {
          issues: result.error.issues,
        });
      }
      return;
    }),
    async (c) => {
      const input = c.req.valid('json');
      const result = await deps.auth.setup(input, {
        requestId: c.get('requestId') ?? '',
        clientIp: c.get('clientIp') ?? '',
      });
      if (!result.ok) {
        return errorResponse(result.code, c.get('requestId') ?? '', result.details);
      }
      // 完成引导不签新会话；auth_epoch 已吊销首启会话，清掉残留 Cookie。
      clearSessionCookie(c);
      return c.json(result.data, 200);
    },
  );
}
