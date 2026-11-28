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
  Action,
  ErrorCode,
  TARGET_TYPE,
  adminOwnerResetSchema,
  backupKeyAddSchema,
  backupSettingsSchema,
  restoreCommitSchema,
  type AdminBackupListResponse,
  type AdminMeResponse,
  type LogicalBackupListResponse,
  type BackupSettingsRequest,
  type BackupSettingsResponse,
  type BackupKeyAddRequest,
  type BackupKeyListResponse,
  type RestoreBeginResponse,
  type RestoreCommitRequest,
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
import type { LogicalBackupService } from '../services/logical-backup.service';
import type { RestoreService } from '../services/restore.service';
import type { BackupKeyService } from '../services/backup-key.service';
import type { SettingsRepository } from '../repositories/settings.repository';
import type { OperationLogRepository } from '../repositories/operation-log.repository';
import type { Db } from '../repositories/db';
import { immediateTransaction } from '../repositories/db';
import type { Env } from '../env';
import { utcNowIso } from '../lib/today';
import { BACKUP_FILE_EXTENSION } from '../lib/backup-format';

export interface AdminRouteDeps {
  readonly adminAuth: AdminAuthService;
  readonly admin: AdminService;
  readonly adminSessions: AdminSessionRepository;
  readonly backup: BackupService;
  readonly logicalBackup: LogicalBackupService;
  readonly restore: RestoreService;
  readonly backupKeys: BackupKeyService;
  readonly settings: SettingsRepository;
  readonly logs: OperationLogRepository;
  readonly db: Db;
  readonly env: Env;
  readonly requestIdOf: (c: Context<AppEnv>) => string;
}

/** 管理员的审计署名；未登录时回落匿名标记。 */
function adminActorOf(c: Context<AppEnv>): string {
  return c.get('adminActor') ?? 'admin:anonymous';
}

/**
 * 浏览器侧的跳转目标。
 *
 * 生产由 Hono 同源托管 `web/dist`，相对路径即可；本地开发时前端 dev server
 * 与后端不同端口（8000 / 8080），相对路径会把地址栏留在后端端口 —— 那里
 * 没有静态产物，用户看到的就是白屏。配了 `WEB_ORIGIN` 就显式回前端：
 * 会话 Cookie 按 host 共享（Cookie 不区分端口），跨端口仍然带着登录态。
 *
 * 注意这**不影响 OAuth 的 `redirect_uri`**：那个必须与 GitHub 登记的地址
 * 逐字一致，仍由 `publicOrigin` 推导。
 */
function browserRedirect(c: Context<AppEnv>, path: string, webOrigin: string | null): Response {
  return c.redirect(webOrigin === null ? path : `${webOrigin}${path}`, 302);
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
      return browserRedirect(c, '/admin/login?error=state', deps.env.webOrigin);
    }
    if (code === '') {
      return browserRedirect(c, '/admin/login?error=failed', deps.env.webOrigin);
    }

    const result = await deps.adminAuth.handleCallback(
      code,
      c.get('requestId') ?? '',
      c.get('clientIp') ?? '',
    );
    if (!result.ok) {
      const error: string = result.code === ErrorCode.ADMIN_FORBIDDEN ? 'forbidden' : 'failed';
      return browserRedirect(c, `/admin/login?error=${error}`, deps.env.webOrigin);
    }
    setAdminSessionCookie(c, result.token);
    return browserRedirect(c, '/admin', deps.env.webOrigin);
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

  /* ------------------------- 加密逻辑备份（管理员） ------------------------- */

  api.get('/api/admin/logical-backups', (c) => {
    const result = deps.logicalBackup.list();
    return result.ok
      ? c.json(result.data satisfies LogicalBackupListResponse, 200)
      : errorResponse(result.code, c.get('requestId') ?? '', result.details);
  });

  api.post('/api/admin/logical-backups', async (c) => {
    const result = await deps.logicalBackup.enqueue('manual-admin', c.get('requestId') ?? '');
    return result.ok
      ? c.json(result.data, 200)
      : errorResponse(result.code, c.get('requestId') ?? '', result.details);
  });

  api.get('/api/admin/logical-backups/:id/download', (c) => {
    const id: string = c.req.param('id') ?? '';
    const result = deps.logicalBackup.openDownload(id);
    if (!result.ok) {
      return errorResponse(result.code, c.get('requestId') ?? '', result.details);
    }
    const admin = c.get('adminSession');
    deps.admin.logBackupDownload(id, {
      requestId: c.get('requestId') ?? '',
      actor: adminActorOf(c),
      adminSessionId: admin?.id ?? '',
    });

    const { meta, lines } = result.data;
    const encoder = new TextEncoder();
    const lineIter = lines[Symbol.iterator]();
    let first = true;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (first) {
          first = false;
          controller.enqueue(encoder.encode(`${JSON.stringify(meta)}\n`));
          return;
        }
        // 每次只从迭代器取一行，不整包构造数组/Buffer，保持内存水位低。
        const next = lineIter.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(next.value));
      },
    });
    const stamp: string = meta.createdAt.replace(/[:.]/g, '-');
    return c.body(stream, 200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': `attachment; filename="stockin-${stamp}${BACKUP_FILE_EXTENSION}"`,
      'Cache-Control': 'no-store',
    });
  });

  /* ------------------------- 备份间隔设置（管理员） ------------------------- */

  api.get('/api/admin/backup-settings', (c) => {
    const body: BackupSettingsResponse = {
      logicalBackupIntervalDays: deps.settings.getLogicalBackupIntervalDays(),
      physicalBackupIntervalDays: deps.settings.getPhysicalBackupIntervalDays(),
    };
    return c.json(body, 200);
  });

  api.put(
    '/api/admin/backup-settings',
    zValidator('json', backupSettingsSchema, (result, c) => {
      if (!result.success) {
        return errorResponse(ErrorCode.VALID_FAILED, String(c.get('requestId') ?? ''), {
          issues: result.error.issues,
        });
      }
      return;
    }),
    (c) => {
      const input = c.req.valid('json') as BackupSettingsRequest;
      const nowUtc: string = utcNowIso();
      const requestId: string = c.get('requestId') ?? '';
      immediateTransaction(deps.db, () => {
        if (input.logicalBackupIntervalDays !== undefined) {
          deps.settings.setLogicalBackupIntervalDays(input.logicalBackupIntervalDays);
        }
        if (input.physicalBackupIntervalDays !== undefined) {
          deps.settings.setPhysicalBackupIntervalDays(input.physicalBackupIntervalDays);
        }
        deps.logs.append({
          action: Action.SETTINGS_UPDATE,
          targetType: TARGET_TYPE.SETTINGS,
          targetId: null,
          detail: { ...input },
          requestId,
          actor: adminActorOf(c),
          occurredAt: nowUtc,
        });
      });
      const body: BackupSettingsResponse = {
        logicalBackupIntervalDays: deps.settings.getLogicalBackupIntervalDays(),
        physicalBackupIntervalDays: deps.settings.getPhysicalBackupIntervalDays(),
      };
      return c.json(body, 200);
    },
  );

  /* ------------------------- 备份公钥（管理员） ------------------------- */

  api.get('/api/admin/backup-keys', (c) => {
    const result = deps.backupKeys.list();
    return result.ok
      ? c.json(result.data satisfies BackupKeyListResponse, 200)
      : errorResponse(result.code, c.get('requestId') ?? '', result.details);
  });

  api.post(
    '/api/admin/backup-keys',
    zValidator('json', backupKeyAddSchema, (result, c) => {
      if (!result.success) {
        return errorResponse(ErrorCode.VALID_FAILED, String(c.get('requestId') ?? ''), {
          issues: result.error.issues,
        });
      }
      return;
    }),
    async (c) => {
      const input = c.req.valid('json') as BackupKeyAddRequest;
      const result = await deps.backupKeys.add(input, adminActorOf(c), c.get('requestId') ?? '');
      return result.ok
        ? c.json(result.data satisfies BackupKeyListResponse, 200)
        : errorResponse(result.code, c.get('requestId') ?? '', result.details);
    },
  );

  api.post('/api/admin/backup-keys/:keyId/activate', (c) => {
    const keyId: string = c.req.param('keyId') ?? '';
    const result = deps.backupKeys.activate(keyId, adminActorOf(c), c.get('requestId') ?? '');
    return result.ok
      ? c.json(result.data satisfies BackupKeyListResponse, 200)
      : errorResponse(result.code, c.get('requestId') ?? '', result.details);
  });

  api.delete('/api/admin/backup-keys/:keyId', (c) => {
    const keyId: string = c.req.param('keyId') ?? '';
    const result = deps.backupKeys.remove(keyId, adminActorOf(c), c.get('requestId') ?? '');
    return result.ok
      ? c.json(result.data satisfies BackupKeyListResponse, 200)
      : errorResponse(result.code, c.get('requestId') ?? '', result.details);
  });

  /* ------------------------- 一次性恢复（管理员） ------------------------- */

  api.post('/api/admin/restore/begin', (c) => {
    const result = deps.restore.beginBatch();
    return result.ok
      ? c.json(result.data satisfies RestoreBeginResponse, 200)
      : errorResponse(result.code, c.get('requestId') ?? '', result.details);
  });

  api.put('/api/admin/restore/:batchId/chunk/:seq', async (c) => {
    const batchId: string = c.req.param('batchId') ?? '';
    const seqRaw: string = c.req.param('seq') ?? '';
    const seq: number = Number.parseInt(seqRaw, 10);
    if (!Number.isInteger(seq) || seq < 0) {
      return errorResponse(ErrorCode.VALID_FAILED, c.get('requestId') ?? '');
    }
    const bytes: Uint8Array = new Uint8Array(await c.req.arrayBuffer());
    const result = await deps.restore.putChunk(batchId, seq, bytes);
    return result.ok
      ? c.json({ ok: true }, 200)
      : errorResponse(result.code, c.get('requestId') ?? '', result.details);
  });

  api.post(
    '/api/admin/restore/commit',
    zValidator('json', restoreCommitSchema, (result, c) => {
      if (!result.success) {
        return errorResponse(ErrorCode.VALID_FAILED, String(c.get('requestId') ?? ''), {
          issues: result.error.issues,
        });
      }
      return;
    }),
    async (c) => {
      const input = c.req.valid('json') as RestoreCommitRequest;
      const result = await deps.restore.commit(input.batchId, input.ticket, adminActorOf(c));
      return result.ok
        ? c.json(result.data, 200)
        : errorResponse(result.code, c.get('requestId') ?? '', result.details);
    },
  );
}
