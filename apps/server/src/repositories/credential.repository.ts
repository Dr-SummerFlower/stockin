/**
 * `credentials` 单行表 SQL。
 *
 * 依据：设计文档 v1.1 §4.2 —— id 固定 1、username、password_hash + salt +
 * scrypt_params、is_initial；密码与密保答案都只存哈希，绝不落明文。
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
  /** 密保问题文本；未设置时为空串。 */
  readonly securityQuestion: string;
  readonly securityAnswerSalt: string;
  readonly securityAnswerHash: string;
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
          id, username, password_hash, salt, scrypt_params, is_initial,
          security_question, security_answer_salt, security_answer_hash,
          created_at, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.username,
        row.passwordHash,
        row.salt,
        row.scryptParams,
        row.isInitial,
        row.securityQuestion,
        row.securityAnswerSalt,
        row.securityAnswerHash,
        row.createdAt,
        row.updatedAt,
      );
  }

  /**
   * 写入完整凭据（存在则整行覆盖）。
   *
   * setup 使用：1.0.0 之前的老库可能已有一行 `is_initial=1` 的占位凭据，
   * 也可能完全没有（自助引导后不再首启生成）。upsert 同时覆盖两种情况，
   * 避免“升级后 setup 因主键冲突失败”。
   */
  saveCredentials(row: NewCredentialRow): void {
    this.db
      .prepare(
        `INSERT INTO credentials (
          id, username, password_hash, salt, scrypt_params, is_initial,
          security_question, security_answer_salt, security_answer_hash,
          created_at, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          username = excluded.username,
          password_hash = excluded.password_hash,
          salt = excluded.salt,
          scrypt_params = excluded.scrypt_params,
          is_initial = excluded.is_initial,
          security_question = excluded.security_question,
          security_answer_salt = excluded.security_answer_salt,
          security_answer_hash = excluded.security_answer_hash,
          updated_at = excluded.updated_at`,
      )
      .run(
        row.username,
        row.passwordHash,
        row.salt,
        row.scryptParams,
        row.isInitial,
        row.securityQuestion,
        row.securityAnswerSalt,
        row.securityAnswerHash,
        row.createdAt,
        row.updatedAt,
      );
  }

  /** 修改密码：只更新密码哈希相关列，保留用户名与密保。 */
  updatePassword(
    passwordHash: string,
    salt: string,
    scryptParams: string,
    nowUtc: string,
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE credentials SET
             password_hash = ?, salt = ?, scrypt_params = ?, updated_at = ?
           WHERE id = 1`,
        )
        .run(passwordHash, salt, scryptParams, nowUtc).changes > 0
    );
  }

  /** 设置 / 修改密保问题（答案已归一化并加盐哈希）。 */
  updateSecurity(
    question: string,
    answerSalt: string,
    answerHash: string,
    nowUtc: string,
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE credentials SET
             security_question = ?, security_answer_salt = ?, security_answer_hash = ?,
             updated_at = ?
           WHERE id = 1`,
        )
        .run(question, answerSalt, answerHash, nowUtc).changes > 0
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

  /** 清空密保（CLI 凭据重置时一并清掉，避免旧答案仍能重置新密码）。 */
  clearSecurity(nowUtc: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE credentials SET
             security_question = '', security_answer_salt = '', security_answer_hash = '',
             updated_at = ?
           WHERE id = 1`,
        )
        .run(nowUtc).changes > 0
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
