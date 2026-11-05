/**
 * `credentials` 单行表 SQL。
 *
 * 依据：设计文档 v1.1 §4.2 —— id 固定 1、username、password_hash + salt +
 * scrypt_params、is_initial；初始密码明文绝不入库，只经 [BOOTSTRAP] 打印。
 */
import type { Db } from './db';
import type { CredentialRow } from './types';

export interface NewCredentialRow {
  readonly username: string;
  readonly passwordHash: string;
  readonly salt: string;
  /** lib/crypto.ts 的 serializeScryptParams() 产物。 */
  readonly scryptParams: string;
  readonly isInitial: 0 | 1;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class CredentialRepository {
  constructor(private readonly db: Db) {}

  find(): CredentialRow | null {
    return (
      (this.db.prepare('SELECT * FROM credentials WHERE id = 1').get() as
        | CredentialRow
        | undefined) ?? null
    );
  }

  /** 首启生成凭据；卷保留时由 bootstrap 判定跳过，绝不重复生成。 */
  create(row: NewCredentialRow): void {
    this.db
      .prepare(
        `INSERT INTO credentials (
          id, username, password_hash, salt, scrypt_params, is_initial, created_at, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.username,
        row.passwordHash,
        row.salt,
        row.scryptParams,
        row.isInitial,
        row.createdAt,
        row.updatedAt,
      );
  }

  /** setup / reset-credentials：更新正式账密与哈希参数。 */
  updateCredentials(
    username: string,
    passwordHash: string,
    salt: string,
    scryptParams: string,
    isInitial: 0 | 1,
    nowUtc: string,
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE credentials SET
             username = ?, password_hash = ?, salt = ?, scrypt_params = ?,
             is_initial = ?, updated_at = ?
           WHERE id = 1`,
        )
        .run(username, passwordHash, salt, scryptParams, isInitial, nowUtc).changes > 0
    );
  }

  /** 完成引导后清掉初始标记（初始密码明文不再有意义）。 */
  clearInitialFlag(nowUtc: string): boolean {
    return (
      this.db
        .prepare('UPDATE credentials SET is_initial = 0, updated_at = ? WHERE id = 1')
        .run(nowUtc).changes > 0
    );
  }
}
