/**
 * 管理员维护服务：系统概览、逻辑导出、审计导出、重置店主凭据。
 *
 * 边界：管理员**只做系统维护，不读写业务记录**（不提供记录增删改查端点）。
 * 逻辑导出只读，且**绝不包含**密码哈希、盐、密保答案、会话 token。
 *
 * 所有动作都写 operation_logs（append-only，6 个月留存），
 * actor 形如 `admin:<github_login>`，与店主操作可区分。
 */
import {
  Action,
  APP_VERSION,
  ErrorCode,
  TARGET_TYPE,
  type AdminExportPayload,
  type AdminSystemResponse,
} from '@stockin/shared';
import type { Db } from '../repositories/db';
import { immediateTransaction } from '../repositories/db';
import type { CredentialRepository } from '../repositories/credential.repository';
import type { SessionRepository } from '../repositories/session.repository';
import type { AdminSessionRepository } from '../repositories/admin-session.repository';
import type { AdminAccountRepository } from '../repositories/admin-account.repository';
import type { MetaRepository } from '../repositories/meta.repository';
import type { OperationLogRepository } from '../repositories/operation-log.repository';
import type { BackupService } from './backup.service';
import type { Env } from '../env';
import type { RuntimeTarget } from '../runtime/platform';
import { SCHEMA_EXPECTED } from '../repositories/schema';
import { derivePasswordHash, generateSaltHex, serializeScryptParams } from '../lib/crypto';
import { utcNowIso } from '../lib/today';
import type { ServiceResult } from '../app';

export interface AdminServiceDeps {
  readonly db: Db;
  readonly env: Env;
  /** 运行时目标（由 platform 画像注入，Worker 上不能读 process.env）。 */
  readonly runtimeTarget: RuntimeTarget;
  readonly credentials: CredentialRepository;
  readonly sessions: SessionRepository;
  readonly adminSessions: AdminSessionRepository;
  readonly adminAccounts: AdminAccountRepository;
  readonly meta: MetaRepository;
  readonly logs: OperationLogRepository;
  readonly backup: BackupService;
}

export interface AdminActionContext {
  readonly requestId: string;
  readonly actor: string;
  readonly adminSessionId: string;
}

export class AdminService {
  constructor(private readonly deps: AdminServiceDeps) {}

  /** 系统概览：只给计数与版本，不含业务明细。 */
  system(): AdminSystemResponse {
    const counts = this.deps.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM records WHERE deleted_at IS NULL) AS active,
           (SELECT COUNT(*) FROM records WHERE deleted_at IS NOT NULL) AS trashed,
           (SELECT COUNT(*) FROM operation_logs) AS logs`,
      )
      .get() as { active: number; trashed: number; logs: number } | undefined;
    return {
      version: APP_VERSION,
      runtime: this.deps.runtimeTarget,
      // 恢复票据的 schema 由服务端按 SCHEMA_EXPECTED 校验；这里必须下发同一值。
      // meta.schema_version 只在 001 初始化，升级库上仍为初始值，用它指导签名会让
      // 升级库签出的票据被拒绝恢复。
      schemaVersion: SCHEMA_EXPECTED,
      recordCount: counts?.active ?? 0,
      trashCount: counts?.trashed ?? 0,
      logCount: counts?.logs ?? 0,
      backupMode: this.deps.backup.mode,
      adminLogins: [...this.deps.env.admin.allowedLogins],
    };
  }

  /**
   * 逻辑导出（JSON）。包含业务数据与审计日志，**不含任何凭据材料**。
   * 凭据表只导出用户名与时间戳，哈希/盐/密保答案凭列白名单显式排除。
   */
  exportAll(ctx: AdminActionContext): AdminExportPayload {
    const records = this.deps.db
      .prepare('SELECT * FROM records ORDER BY id ASC')
      .all() as unknown[];
    const settings = this.deps.db.prepare('SELECT * FROM settings').all() as unknown[];
    const operationLogs = this.deps.db
      .prepare('SELECT * FROM operation_logs ORDER BY id ASC')
      .all() as unknown[];
    const adminAccounts = this.deps.db
      .prepare(
        `SELECT id, github_login, github_user_id, display_name, created_at, last_login_at
           FROM admin_accounts ORDER BY id ASC`,
      )
      .all() as unknown[];
    const meta = this.deps.db
      .prepare('SELECT key, value FROM meta ORDER BY key ASC')
      .all() as unknown[];

    const payload: AdminExportPayload = {
      exportedAt: utcNowIso(),
      schemaVersion: this.deps.meta.schemaVersion(),
      appVersion: APP_VERSION,
      tables: {
        records,
        settings,
        operationLogs,
        adminAccounts,
        meta,
      },
    };
    this.deps.logs.append({
      action: Action.ADMIN_DATA_EXPORT,
      targetType: TARGET_TYPE.ADMIN,
      targetId: null,
      detail: {
        records: records.length,
        logs: operationLogs.length,
        adminAccounts: adminAccounts.length,
      },
      requestId: ctx.requestId,
      actor: ctx.actor,
      occurredAt: utcNowIso(),
    });
    return payload;
  }

  /** 审计日志导出（CSV，带 BOM，Excel 直接打开不乱码）。 */
  exportAuditCsv(ctx: AdminActionContext): string {
    const rows = this.deps.db
      .prepare(
        `SELECT id, occurred_at, action, target_type, target_id, actor, request_id, detail
           FROM operation_logs ORDER BY id ASC`,
      )
      .all() as {
      id: number;
      occurred_at: string;
      action: string;
      target_type: string;
      target_id: number | null;
      actor: string;
      request_id: string;
      detail: string | null;
    }[];
    const header = 'id,occurred_at,action,target_type,target_id,actor,request_id,detail';
    const body: string = rows
      .map((row) =>
        [
          row.id,
          row.occurred_at,
          row.action,
          row.target_type,
          row.target_id ?? '',
          row.actor,
          row.request_id,
          row.detail ?? '',
        ]
          .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
          .join(','),
      )
      .join('\n');
    this.deps.logs.append({
      action: Action.ADMIN_AUDIT_EXPORT,
      targetType: TARGET_TYPE.ADMIN,
      targetId: null,
      detail: { rows: rows.length },
      requestId: ctx.requestId,
      actor: ctx.actor,
      occurredAt: utcNowIso(),
    });
    return `\uFEFF${header}\n${body}\n`;
  }

  /** 记录一次备份下载，供审计追溯「谁取走了哪份快照」。 */
  logBackupDownload(file: string, ctx: AdminActionContext): void {
    this.deps.logs.append({
      action: Action.ADMIN_BACKUP_DOWNLOAD,
      targetType: TARGET_TYPE.BACKUP,
      targetId: null,
      detail: { file },
      requestId: ctx.requestId,
      actor: ctx.actor,
      occurredAt: utcNowIso(),
    });
  }

  /**
   * 重置店主密码（用户名保持不变）。
   *
   * 同事务内：换 salt/hash → `auth_epoch` 递增吊销店主全部会话 →
   * 吊销其它管理员会话 → 写审计。当前管理员会话保留，避免操作者被自己踢出。
   */
  resetOwnerPassword(newPassword: string, ctx: AdminActionContext): ServiceResult<{ ok: true }> {
    const owner = this.deps.credentials.find();
    if (owner === null) {
      // 尚未完成初始化时没有账号可重置。
      return { ok: false, code: ErrorCode.AUTH_INIT_REQUIRED };
    }
    const salt: string = generateSaltHex();
    const hash: string = derivePasswordHash(newPassword, salt);
    const nowUtc: string = utcNowIso();
    immediateTransaction(this.deps.db, () => {
      this.deps.credentials.updatePassword(hash, salt, serializeScryptParams(), nowUtc);
      const epoch: number = this.deps.meta.increment('auth_epoch');
      this.deps.sessions.revokeAll('admin-reset', nowUtc, epoch);
      this.deps.adminSessions.revokeAllExcept(ctx.adminSessionId);
      this.deps.logs.append({
        action: Action.ADMIN_OWNER_RESET,
        targetType: TARGET_TYPE.CREDENTIAL,
        targetId: null,
        detail: { username: owner.username },
        requestId: ctx.requestId,
        actor: ctx.actor,
        occurredAt: nowUtc,
      });
    });
    return { ok: true, data: { ok: true } };
  }
}
