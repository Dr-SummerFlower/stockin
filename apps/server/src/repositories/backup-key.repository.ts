/**
 * 备份公钥仓储（`backup_keys`，schema 6 引入）。
 *
 * `backup_keys` 是公钥的唯一真源：加密用「启用中」的那把，验签用「库里全部」，
 * 轮换不需要重新部署。`BACKUP_PUBLIC_KEY` 只在首次启动、库内为空时由 bootstrap
 * 播种一条默认公钥；之后环境变量不再参与，增删启用全部在管理台完成。
 *
 * 公钥不是秘密：解密只需要本地私钥 + 备份 meta 的 `key_id`，服务端公钥只用于
 * 「加密新备份」和「验恢复票据」。因此旧公钥可以直接删除，唯一影响是用旧私钥
 * 签出的票据不再被接受 —— 而票据窗口只有 30 分钟。
 */
import type { Db } from './db';

export interface BackupKeyRow {
  readonly key_id: string;
  readonly public_key: string;
  readonly label: string;
  readonly is_active: number;
  readonly created_at: string;
  readonly activated_at: string | null;
}

export class BackupKeyRepository {
  constructor(private readonly db: Db) {}

  /** 全部公钥，按「启用中优先、其次按创建时间倒序」排，管理台直接照此渲染。 */
  list(): BackupKeyRow[] {
    return this.db
      .prepare(
        `SELECT key_id, public_key, label, is_active, created_at, activated_at
           FROM backup_keys
          ORDER BY is_active DESC, created_at DESC`,
      )
      .all() as BackupKeyRow[];
  }

  findActive(): BackupKeyRow | null {
    const row = this.db
      .prepare(
        `SELECT key_id, public_key, label, is_active, created_at, activated_at
           FROM backup_keys WHERE is_active = 1`,
      )
      .get() as BackupKeyRow | undefined;
    return row ?? null;
  }

  findById(keyId: string): BackupKeyRow | null {
    const row = this.db
      .prepare(
        `SELECT key_id, public_key, label, is_active, created_at, activated_at
           FROM backup_keys WHERE key_id = ?`,
      )
      .get(keyId) as BackupKeyRow | undefined;
    return row ?? null;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM backup_keys').get() as
      | { c: number }
      | undefined;
    return row?.c ?? 0;
  }

  /**
   * 插入一条公钥。
   *
   * **不开事务**：`DbPort` 契约禁止嵌套事务，而调用方（`BackupKeyService`）
   * 已经把「写公钥 + 写审计」放在同一个 `immediateTransaction` 里。
   * `is_active = 1` 时先清零其它行：表上有 `idx_backup_keys_active` 部分唯一索引
   * 兜底，这里显式清零是为了给出确定的顺序，而不是撞索引报错。
   */
  insert(row: {
    keyId: string;
    publicKey: string;
    label: string;
    active: boolean;
    now: string;
  }): void {
    if (row.active) {
      this.db.prepare('UPDATE backup_keys SET is_active = 0 WHERE is_active = 1').run();
    }
    this.db
      .prepare(
        `INSERT INTO backup_keys (key_id, public_key, label, is_active, created_at, activated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.keyId,
        row.publicKey,
        row.label,
        row.active ? 1 : 0,
        row.now,
        row.active ? row.now : null,
      );
  }

  /** 把指定公钥设为唯一加密公钥（同样不开事务，调用方负责）。返回是否命中。 */
  setActive(keyId: string, now: string): boolean {
    this.db.prepare('UPDATE backup_keys SET is_active = 0 WHERE is_active = 1').run();
    const result = this.db
      .prepare('UPDATE backup_keys SET is_active = 1, activated_at = ? WHERE key_id = ?')
      .run(now, keyId);
    return result.changes > 0;
  }

  remove(keyId: string): boolean {
    const result = this.db.prepare('DELETE FROM backup_keys WHERE key_id = ?').run(keyId);
    return result.changes > 0;
  }
}
