/**
 * `admin_accounts` SQL：管理员身份的唯一真源。
 *
 * 身份只来自 GitHub 登录名（白名单在环境变量里），本表只记录「谁曾经登录过」
 * 与首次 / 最近登录时间，便于审计追溯与界面展示。删除管理员只需从环境变量
 * 白名单移除，历史审计行保持完整。
 */
import type { Db } from './db';
import type { AdminAccountRow } from './types';

export class AdminAccountRepository {
  constructor(private readonly db: Db) {}

  findByLogin(login: string): AdminAccountRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM admin_accounts WHERE github_login = ?')
        .get(login.toLowerCase()) as AdminAccountRow | undefined) ?? null
    );
  }

  findById(id: number): AdminAccountRow | null {
    return (
      (this.db.prepare('SELECT * FROM admin_accounts WHERE id = ?').get(id) as
        | AdminAccountRow
        | undefined) ?? null
    );
  }

  /**
   * 首次登录插入，之后更新展示名与最近登录时间。
   * 返回落库后的行，调用方无需再查一次。
   */
  upsert(
    login: string,
    githubUserId: number | null,
    displayName: string,
    nowUtc: string,
  ): AdminAccountRow {
    const normalized: string = login.toLowerCase();
    this.db
      .prepare(
        `INSERT INTO admin_accounts
           (github_login, github_user_id, display_name, created_at, last_login_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(github_login) DO UPDATE SET
           github_user_id = COALESCE(excluded.github_user_id, admin_accounts.github_user_id),
           display_name = excluded.display_name,
           last_login_at = excluded.last_login_at`,
      )
      .run(normalized, githubUserId, displayName, nowUtc, nowUtc);
    const row: AdminAccountRow | null = this.findByLogin(normalized);
    if (row === null) {
      throw new Error('[admin] 账户写入后读取失败');
    }
    return row;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM admin_accounts').get() as
      | { c: number }
      | undefined;
    return row?.c ?? 0;
  }
}
