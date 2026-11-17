/**
 * `admin_sessions` SQL 与有效期判定。
 *
 * 与店主 `sessions` 完全隔离：独立表、独立 Cookie 名、独立守卫。
 * DB 只存 token 的 sha256；明文 token 仅存在于浏览器侧。
 *
 * 语义要点：Cookie 是**窗口级**（不设 Max-Age），浏览器关闭即丢弃；
 * 服务端仍以 idle（30 分钟）+ absolute（12 小时）双过期兜底，
 * 防止「标签页一直开着」导致会话无限延长。
 */
import type { Db } from './db';
import type { AdminSessionRow } from './types';

/** 注入 Hono Variables 的最小管理员身份。 */
export interface AdminIdentity {
  readonly id: string;
  readonly adminId: number;
  readonly login: string;
}

export interface NewAdminSessionRow {
  readonly id: string;
  readonly tokenHash: string;
  readonly adminId: number;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly createdAt: string;
}

/** 纯函数：不读时钟、不查库，便于单测。 */
export function isAdminSessionValid(row: AdminSessionRow, nowUtc: string, login: string): boolean {
  return (
    row.revoked === 0 &&
    row.idle_expires_at > nowUtc &&
    row.absolute_expires_at > nowUtc &&
    login !== ''
  );
}

export class AdminSessionRepository {
  constructor(private readonly db: Db) {}

  create(row: NewAdminSessionRow): void {
    this.db
      .prepare(
        `INSERT INTO admin_sessions (
           id, token_hash, admin_id, idle_expires_at, absolute_expires_at,
           revoked, created_at, last_seen_at
         ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        row.id,
        row.tokenHash,
        row.adminId,
        row.idleExpiresAt,
        row.absoluteExpiresAt,
        row.createdAt,
        row.createdAt,
      );
  }

  findByTokenHash(tokenHash: string): AdminSessionRow | null {
    return (
      (this.db.prepare('SELECT * FROM admin_sessions WHERE token_hash = ?').get(tokenHash) as
        | AdminSessionRow
        | undefined) ?? null
    );
  }

  touch(id: string, nowUtc: string, newIdleExpiresAt: string): boolean {
    return (
      this.db
        .prepare(
          'UPDATE admin_sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id = ? AND revoked = 0',
        )
        .run(nowUtc, newIdleExpiresAt, id).changes > 0
    );
  }

  revoke(id: string): boolean {
    return (
      this.db.prepare('UPDATE admin_sessions SET revoked = 1 WHERE id = ? AND revoked = 0').run(id)
        .changes > 0
    );
  }

  /** 重置店主凭据等高风险动作后，吊销全部管理员会话（强制重新走 OAuth）。 */
  revokeAll(): number {
    return this.db.prepare('UPDATE admin_sessions SET revoked = 1 WHERE revoked = 0').run().changes;
  }

  /** 吊销除当前会话外的全部管理员会话（高风险操作后强制其它窗口重新验证）。 */
  revokeAllExcept(id: string): number {
    return this.db
      .prepare('UPDATE admin_sessions SET revoked = 1 WHERE revoked = 0 AND id <> ?')
      .run(id).changes;
  }

  /** 清理已过期会话，避免表无限增长（只删过期行，不触碰审计表）。 */
  purgeExpired(nowUtc: string): number {
    return this.db
      .prepare('DELETE FROM admin_sessions WHERE absolute_expires_at < ? OR idle_expires_at < ?')
      .run(nowUtc, nowUtc).changes;
  }
}
