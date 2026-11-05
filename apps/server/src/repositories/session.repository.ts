/**
 * `sessions` 表 SQL 与会话有效性判定。
 *
 * 依据：设计文档 v1.1 §4.2 / §5.2 —— DB 只存 `token_hash`，绝不存明文 token；
 * 7d 空闲 / 30d 绝对 / revoked / auth_epoch 四类判定**全部在应用层**，
 * SQL 内不做任何日期函数运算（ISO 8601 文本字典序直接比较）。
 */
import type { Db } from './db';
import type { SessionRow } from './types';

/** 注入 Hono Variables 的最小会话身份。 */
export interface SessionIdentity {
  readonly id: string;
  readonly accountId: number;
  readonly authEpoch: number;
}

export interface NewSessionRow {
  readonly id: string;
  /** token 的 sha256 hex，明文 token 绝不入库。 */
  readonly tokenHash: string;
  readonly accountId: number;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly authEpoch: number;
  readonly createdAt: string;
}

/** 会话有效性纯函数（应用层判定，不读时钟、不查库）。 */
export function isSessionValid(
  row: SessionRow,
  nowUtc: string,
  currentAuthEpoch: number,
): boolean {
  return (
    row.revoked === 0 &&
    row.idle_expires_at > nowUtc &&
    row.absolute_expires_at > nowUtc &&
    row.auth_epoch === currentAuthEpoch
  );
}

/** SessionRow → Hono Variables 身份。 */
export function toSessionIdentity(row: SessionRow): SessionIdentity {
  return { id: row.id, accountId: row.account_id, authEpoch: row.auth_epoch };
}

export class SessionRepository {
  constructor(private readonly db: Db) {}

  /** 新建会话；token_hash 唯一由表级约束保证。 */
  create(row: NewSessionRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions (
          id, token_hash, account_id, idle_expires_at, absolute_expires_at,
          revoked, revoked_reason, auth_epoch, created_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.tokenHash,
        row.accountId,
        row.idleExpiresAt,
        row.absoluteExpiresAt,
        row.authEpoch,
        row.createdAt,
        row.createdAt,
      );
  }

  findByTokenHash(tokenHash: string): SessionRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM sessions WHERE token_hash = ?')
        .get(tokenHash) as SessionRow | undefined) ?? null
    );
  }

  findById(id: string): SessionRow | null {
    return (
      (this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined) ??
      null
    );
  }

  /** 滑动空闲过期；绝对过期不变。两个时间戳都由应用层注入。 */
  touch(id: string, nowUtc: string, newIdleExpiresAt: string): boolean {
    return (
      this.db
        .prepare(
          'UPDATE sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id = ? AND revoked = 0',
        )
        .run(nowUtc, newIdleExpiresAt, id).changes > 0
    );
  }

  revoke(id: string, reason: string, nowUtc: string): boolean {
    return (
      this.db
        .prepare(
          'UPDATE sessions SET revoked = 1, revoked_reason = ?, last_seen_at = ? WHERE id = ?',
        )
        .run(reason, nowUtc, id).changes > 0
    );
  }

  /**
   * 吊销全部有效会话并写入新 auth_epoch。
   * 供 setup 四者同事务、reset-credentials CLI 使用。
   */
  revokeAll(reason: string, nowUtc: string, newAuthEpoch: number): number {
    return this.db
      .prepare(
        `UPDATE sessions
         SET revoked = 1, revoked_reason = ?, last_seen_at = ?, auth_epoch = ?
         WHERE revoked = 0`,
      )
      .run(reason, nowUtc, newAuthEpoch).changes;
  }

  /** 清理已过期会话（裸列与常量比较，无 SQL 日期函数）。 */
  purgeExpired(nowUtc: string): number {
    return this.db
      .prepare('DELETE FROM sessions WHERE idle_expires_at <= ? OR absolute_expires_at <= ?')
      .run(nowUtc, nowUtc).changes;
  }

  /** 列出当前未吊销且未过期的会话（供管理态查询）。 */
  listActive(nowUtc: string): readonly SessionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE revoked = 0 AND idle_expires_at > ? AND absolute_expires_at > ?
         ORDER BY created_at ASC`,
      )
      .all(nowUtc, nowUtc) as SessionRow[];
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as
      | { c: number }
      | undefined;
    return row?.c ?? 0;
  }
}
