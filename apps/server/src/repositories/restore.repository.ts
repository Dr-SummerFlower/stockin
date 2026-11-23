/**
 * 全量恢复仓储：所有恢复相关 SQL 集中在此，Service 不拼表名。
 *
 * 恢复范围（用户拍板）：除 backup_* 三表与 sessions/admin_sessions 外的全部
 * 业务表。会话一律清空（恢复后强制重新登录）。append-only / 单向状态机触发器
 * 在恢复窗口内临时移除，回填后原样重建，保证恢复后约束仍然生效。
 */
import type { Db } from './db';
import type { RestoreTable } from '../lib/backup-format';

/** 可恢复表白名单（顺序即插入顺序；列名以恢复包携带的 columns 为准）。 */
export const RESTORE_TABLES = [
  'credentials',
  'settings',
  'records',
  'operation_logs',
  'meta',
  'admin_accounts',
] as const;

/** 恢复窗口内需临时移除、随后重建的触发器定义（名称 + 完整 CREATE 语句）。 */
const TRIGGERS: readonly { name: string; create: string }[] = [
  {
    name: 'trg_meta_setup_no_reset',
    create: `CREATE TRIGGER IF NOT EXISTS trg_meta_setup_no_reset
BEFORE UPDATE OF value ON meta
WHEN OLD.key = 'setup_completed' AND OLD.value = '1' AND NEW.value <> '1'
BEGIN
  SELECT RAISE(ABORT, 'meta.setup_completed 只能 0->1，不可回退');
END`,
  },
  {
    name: 'trg_meta_setup_no_rename',
    create: `CREATE TRIGGER IF NOT EXISTS trg_meta_setup_no_rename
BEFORE UPDATE OF key ON meta
WHEN OLD.key = 'setup_completed' AND OLD.value = '1'
BEGIN
  SELECT RAISE(ABORT, 'meta.setup_completed 键不可改名');
END`,
  },
  {
    name: 'trg_meta_setup_no_delete',
    create: `CREATE TRIGGER IF NOT EXISTS trg_meta_setup_no_delete
BEFORE DELETE ON meta
WHEN OLD.key = 'setup_completed' AND OLD.value = '1'
BEGIN
  SELECT RAISE(ABORT, 'meta.setup_completed 不可删除');
END`,
  },
  {
    name: 'trg_oplogs_no_update',
    create: `CREATE TRIGGER IF NOT EXISTS trg_oplogs_no_update
BEFORE UPDATE ON operation_logs
BEGIN
  SELECT RAISE(ABORT, 'operation_logs 是 append-only 表');
END`,
  },
  {
    name: 'trg_oplogs_no_delete',
    create: `CREATE TRIGGER IF NOT EXISTS trg_oplogs_no_delete
BEFORE DELETE ON operation_logs
BEGIN
  SELECT RAISE(ABORT, 'operation_logs 是 append-only 表');
END`,
  },
];

export class RestoreRepository {
  constructor(private readonly db: Db) {}

  /** 是否所有可恢复表都存在（schema 兼容校验）。 */
  assertSchemaCompatible(): void {
    for (const table of RESTORE_TABLES) {
      const row = this.db
        .prepare("SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) as { hit: number } | undefined;
      if (row === undefined) {
        throw new Error(`[restore] 缺少可恢复表: ${table}`);
      }
    }
  }

  /**
   * 全量恢复：单事务内移除触发器 → 清空业务表 → 回填 → 重建触发器 → 清会话。
   * 任何一步抛错都会整体回滚（DbPort.transaction 的契约）。
   */
  restoreAll(tables: readonly RestoreTable[]): void {
    this.db.transaction('immediate', () => {
      // 1) 移除 append-only / 单向状态机触发器，否则 DELETE 会被 RAISE 拦截。
      for (const trigger of TRIGGERS) {
        this.db.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
      }

      // 2) 先删会话表（它们的外键指向 credentials / admin_accounts），
      //    否则 DELETE credentials 会被 sessions.account_id 外键拦截。
      this.db.exec('DELETE FROM sessions');
      this.db.exec('DELETE FROM admin_sessions');
      // 再清空业务表（先子后父；本清单内无外键依赖，顺序仅作防御）。
      // 复制后反转，避免修改常量数组（ES 目标不含 toReversed）。
      for (const table of [...RESTORE_TABLES].reverse()) {
        this.db.exec(`DELETE FROM ${table}`);
      }

      // 3) 按恢复包回填。表名必须在白名单内；列名做标识符安全校验。
      for (const entry of tables) {
        if (!(RESTORE_TABLES as readonly string[]).includes(entry.table)) {
          throw new Error(`[restore] 恢复包含非白名单表: ${entry.table}`);
        }
        if (entry.rows.length === 0) {
          continue;
        }
        const columns: string[] = entry.columns.map((column) => {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
            throw new Error(`[restore] 非法列名: ${column}`);
          }
          return column;
        });
        const placeholders: string = columns.map(() => '?').join(', ');
        const sql: string = `INSERT INTO ${entry.table} (${columns.join(', ')}) VALUES (${placeholders})`;
        const statement = this.db.prepare(sql);
        for (const row of entry.rows) {
          statement.run(...row);
        }
      }

      // 4) 重建触发器，恢复约束。
      for (const trigger of TRIGGERS) {
        this.db.exec(trigger.create);
      }
    });
  }
}
