/**
 * 管理员端点（系统维护侧）。
 *
 * | 方法 | 路径 | 说明 |
 * |---|---|---|
 * | GET  | /api/admin/auth/github/start    | 发起 GitHub OAuth（302） |
 * | GET  | /api/admin/auth/github/callback | 回调：换 token → 白名单 → 建会话 |
 * | POST | /api/admin/auth/logout          | 吊销当前管理员会话 |
 * | GET  | /api/admin/me                   | 身份探测（未登录返回 authenticated:false） |
 * | GET  | /api/admin/system               | 版本、计数、备份模式 |
 * | GET  | /api/admin/backups              | 备份元数据列表 |
 * | POST | /api/admin/backups              | 立即生成一份快照 |
 * | GET  | /api/admin/backups/:file/download | 下载 .db.gz（仅 filesystem 运行时） |
 * | GET  | /api/admin/export               | 逻辑导出 JSON（脱敏） |
 * | GET  | /api/admin/audit-logs/export    | 审计日志 CSV |
 * | POST | /api/admin/owner-credentials    | 重置店主密码 |
 *
 * 权限边界：管理员**不碰业务记录**，这里没有任何 records 的读写端点。
 */
import type { Context, Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  ErrorCode,
  adminOwnerResetSchema,
  type AdminBackupListResponse,
  type AdminMeResponse,
} from '@stockin/shared';
import { errorResponse } from '../lib/response';
import {
  clearAdminOauthStateCookie,
  clearAdminSessionCookie,
  getAdminOauthStateCookie,
  getAdminSessionCookie,
  setAdminOauthStateCookie,
  setAdminSessionCookie,
} from '../lib/cookie';
import { hashSessionToken } from '../lib/crypto';
import { generateOauthState, type AdminAuthService } from '../services/admin-auth.service';
import type { AdminService } from '../services/admin.service';
import type { AdminSessionRepository } from '../repositories/admin-session.repository';
import type { AppEnv } from '../types/hono';
import type { BackupService } from '../services/backup.service';

export interface AdminRouteDeps {
  readonly adminAuth: AdminAuthService;
  readonly admin: AdminService;
  readonly adminSessions: AdminSessionRepository;
  readonly backup: BackupService;
}

/** 管理员的审计署名；未登录时回落匿名标记。 */
function adminActorOf(c: Context<AppEnv>): string {
  return c.get('adminActor') ?? 'admin:anonymous';
}

export function registerAdminRoutes(api: Hono<AppEnv>, deps: AdminRouteDeps): void {
  api.get('/api/admin/me', (c) => {
    const admin = c.get('adminSession');
    const body: AdminMeResponse = {
      authenticated: admin !== null && admin !== undefined,
      login: admin?.login ?? null,
      displayName: admin?.login ?? null,
      configured: deps.adminAuth.enabled,
    };
    return c.json(body, 200);
  });

  api.get('/api/admin/auth/github/start', (c) => {
    if (!deps.adminAuth.enabled) {
      return errorResponse(ErrorCode.ADMIN_NOT_CONFIGURED, c.get('requestId') ?? '');
    }
    const state: string = generateOauthState();
    setAdminOauthStateCookie(c, state);
    return c.redirect(deps.adminAuth.buildAuthorizeUrl(state), 302);
  });

  api.get('/api/admin/auth/github/callback', async (c) => {
    if (!deps.adminAuth.enabled) {
      return errorResponse(ErrorCode.ADMIN_NOT_CONFIGURED, c.get('requestId') ?? '');
    }
    const expectedState: string | null = getAdminOauthStateCookie(c);
    const returnedState: string = c.req.query('state') ?? '';
    const code: string = c.req.query('code') ?? '';
    // state 一次性：无论成败都清掉，避免重放。
    clearAdminOauthStateCookie(c);

    if (expectedState === null || returnedState === '' || expectedState !== returnedState) {
      return c.redirect('/admin/login?error=state', 302);
    }
    if (code === '') {
      return c.redirect('/admin/login?error=failed', 302);
    }

    const result = await deps.adminAuth.handleCallback(
      code,
      c.get('requestId') ?? '',
      c.get('clientIp') ?? '',
    );
    if (!result.ok) {
      return c.redirect(
        `/admin/login?error=${result.code === ErrorCode.ADMIN_FORBIDDEN ? 'forbidden' : 'failed'}`,
        302,
      );
    }
    setAdminSessionCookie(c, result.token);
    return c.redirect('/admin', 302);
  });

  api.post('/api/admin/auth/logout', (c) => {
    const token: string | null = getAdminSessionCookie(c);
    if (token !== null) {
      const row = deps.adminSessions.findByTokenHash(hashSessionToken(token));
      if (row !== null) {
        deps.adminSessions.revoke(row.id);
      }
    }
    clearAdminSessionCookie(c);
    return c.json({ ok: true }, 200);
  });

  api.get('/api/admin/system', (c) => {
    return c.json(deps.admin.system(), 200);
  });

  api.get('/api/admin/backups', (c) => {
    const result = deps.backup.list();
    if (!result.ok) {
      return errorResponse(result.code, c.get('requestId') ?? '', result.details);
    }
    const body: AdminBackupListResponse = {
      items: result.data.items.map((item) => ({
        file: item.file,
        gzipFile: item.gzipFile,
        createdAt: item.createdAt,
        sizeBytes: item.sizeBytes,
        userVersion: item.userVersion,
        integrity: item.integrity,
        reason: item.reason,
        baseline: item.baseline,
        sha256: item.sha256,
      })),
      keepCount: result.data.keepCount,
      mode: deps.backup.mode,
      lastBackupAt: result.data.lastBackupAt,
    };
    return c.json(body, 200);
  });

  api.post('/api/admin/backups', async (c) => {
    const result = await deps.backup.trigger('manual-admin', c.get('requestId') ?? '');
    return result.ok
      ? c.json(result.data, 200)
      : errorResponse(result.code, c.get('requestId') ?? '', result.details);
  });

  api.get('/api/admin/backups/:file/download', (c) => {
    const file: string = c.req.param('file') ?? '';
    const found = deps.backup.download(file);
    if (found === null) {
      // 平台托管（PITR）或文件名不在备份池内，两者都无文件可下发。
      return errorResponse(ErrorCode.COMMON_NOT_FOUND, c.get('requestId') ?? '');
    }
    const admin = c.get('adminSession');
    deps.admin.logBackupDownload(file, {
      requestId: c.get('requestId') ?? '',
      actor: adminActorOf(c),
      adminSessionId: admin?.id ?? '',
    });
    return c.body(
      found.data.buffer.slice(
        found.data.byteOffset,
        found.data.byteOffset + found.data.byteLength,
      ) as ArrayBuffer,
      200,
      {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${found.filename}"`,
        'Cache-Control': 'no-store',
      },
    );
  });

  api.get('/api/admin/export', (c) => {
    const admin = c.get('adminSession');
    const payload = deps.admin.exportAll({
      requestId: c.get('requestId') ?? '',
      actor: adminActorOf(c),
      adminSessionId: admin?.id ?? '',
    });
    const stamp: string = payload.exportedAt.replace(/[:.]/g, '-');
    return c.body(JSON.stringify(payload, null, 2), 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="stockin-export-${stamp}.json"`,
      'Cache-Control': 'no-store',
    });
  });

  api.get('/api/admin/audit-logs/export', (c) => {
    const admin = c.get('adminSession');
    const csv: string = deps.admin.exportAuditCsv({
      requestId: c.get('requestId') ?? '',
      actor: adminActorOf(c),
      adminSessionId: admin?.id ?? '',
    });
    const stamp: string = new Date().toISOString().replace(/[:.]/g, '-');
    return c.body(csv, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="stockin-audit-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    });
  });

  api.post(
    '/api/admin/owner-credentials',
    zValidator('json', adminOwnerResetSchema, (result, c) => {
      if (!result.success) {
        return errorResponse(ErrorCode.VALID_FAILED, String(c.get('requestId') ?? ''), {
          issues: result.error.issues,
        });
      }
      return;
    }),
    (c) => {
      const admin = c.get('adminSession');
      const input = c.req.valid('json');
      const result = deps.admin.resetOwnerPassword(input.newPassword, {
        requestId: c.get('requestId') ?? '',
        actor: adminActorOf(c),
        adminSessionId: admin?.id ?? '',
      });
      return result.ok
        ? c.json(result.data, 200)
        : errorResponse(result.code, c.get('requestId') ?? '', result.details);
    },
  );
}
