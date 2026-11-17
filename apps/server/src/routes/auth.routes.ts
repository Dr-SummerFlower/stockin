/**
 * 认证、初始化与账号安全路由。
 *
 * GET  /api/health              GET  /api/auth/init-status
 * GET  /api/auth/me             POST /api/auth/login
 * POST /api/auth/logout         POST /api/auth/setup
 * POST /api/auth/change-password       （需登录）
 * POST /api/auth/security              （需登录：设置 / 修改密保）
 * POST /api/auth/security-question     （匿名：忘记密码第一步回显问题）
 * POST /api/auth/forgot-password       （匿名：密保答案 + 新密码一步式重置）
 *
 * ⚠️ 抢注风险：`/setup` 在完成初始化前对任何能访问到本实例的人开放。
 * Workers 公网部署必须在 setup 完成前用平台侧访问控制（Cloudflare Access /
 * IP 白名单 / 临时路由）限制入口；Node 自托管应避免把端口直接暴露公网。
 */
import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  ErrorCode,
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  securityQuestionLookupSchema,
  setupSchema,
  updateSecuritySchema,
} from '@stockin/shared';
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

  api.post(
    '/api/auth/change-password',
    zValidator('json', changePasswordSchema, (result, c) => {
      if (!result.success) {
        return errorResponse(ErrorCode.VALID_FAILED, String(c.get('requestId') ?? ''), {
          issues: result.error.issues,
        });
      }
      return;
    }),
    (c) => {
      const input = c.req.valid('json');
      const result = deps.auth.changePassword(input, {
        requestId: c.get('requestId') ?? '',
        clientIp: c.get('clientIp') ?? '',
        actor: c.get('actor') ?? '',
      });
      if (!result.ok) {
        return errorResponse(result.code, c.get('requestId') ?? '', result.details);
      }
      // A1：全部会话（含当前）已被吊销，清 Cookie 让浏览器立刻失去会话。
      clearSessionCookie(c);
      return c.json(result.data, 200);
    },
  );

  api.post(
    '/api/auth/security',
    zValidator('json', updateSecuritySchema, (result, c) => {
      if (!result.success) {
        return errorResponse(ErrorCode.VALID_FAILED, String(c.get('requestId') ?? ''), {
          issues: result.error.issues,
        });
      }
      return;
    }),
    (c) => {
      const input = c.req.valid('json');
      const result = deps.auth.updateSecurity(input, {
        requestId: c.get('requestId') ?? '',
        clientIp: c.get('clientIp') ?? '',
        actor: c.get('actor') ?? '',
      });
      return result.ok
        ? c.json(result.data, 200)
        : errorResponse(result.code, c.get('requestId') ?? '', result.details);
    },
  );

  api.post(
    '/api/auth/security-question',
    zValidator('json', securityQuestionLookupSchema, (result, c) => {
      if (!result.success) {
        return errorResponse(ErrorCode.VALID_FAILED, String(c.get('requestId') ?? ''), {
          issues: result.error.issues,
        });
      }
      return;
    }),
    (c) => {
      const input = c.req.valid('json');
      const result = deps.auth.securityQuestion(input.username);
      return result.ok
        ? c.json(result.data, 200)
        : errorResponse(result.code, c.get('requestId') ?? '', result.details);
    },
  );

  api.post(
    '/api/auth/forgot-password',
    zValidator('json', forgotPasswordSchema, (result, c) => {
      if (!result.success) {
        return errorResponse(ErrorCode.VALID_FAILED, String(c.get('requestId') ?? ''), {
          issues: result.error.issues,
        });
      }
      return;
    }),
    (c) => {
      const input = c.req.valid('json');
      const result = deps.auth.forgotPassword(input, {
        requestId: c.get('requestId') ?? '',
        clientIp: c.get('clientIp') ?? '',
      });
      if (!result.ok) {
        return errorResponse(result.code, c.get('requestId') ?? '', result.details);
      }
      clearSessionCookie(c);
      return c.json(result.data, 200);
    },
  );
}
