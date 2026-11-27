/**
 * 全量恢复仓储：所有恢复相关 SQL 集中在此，Service 不拼表名。
 *
 * 恢复范围（用户拍板）：除 backup_* 三表与 sessions/admin_sessions 外的全部
 * 业务表。会话一律清空（恢复后强制重新登录）。append-only / 单向状态机触发器
 * 在恢复窗口内临时移除，回填后原样重建，保证恢复后约束仍然生效。
 */
import type { Db } from './db';
import type { RecordStatsRepository } from './record-stats.repository';
import type { RestoreTable } from '../lib/backup-format';

/**
 * 可恢复表白名单（顺序即插入顺序：父表在前、子表在后）。
 * `records.order_id` 引用 `purchase_orders(id)`，所以单据表必须排在 records 之前；
 * 清空时按本清单**逆序**执行，正好是先子后父。
 */
export const RESTORE_TABLES = [
  'credentials',
  'settings',
  'purchase_orders',
  'records',
  'operation_logs',
  'meta',
  'admin_accounts',
] as const;

/**
 * 逻辑备份包格式版本（写在 `backups.format_version` 与下载文件首行）。
 *
 * v2 = 包里多一张 `purchase_orders`。恢复端按包里的版本判定「必须覆盖哪些表」：
 * v1 旧包允许缺该表（按空表处理，等价于全部散记），否则升级前导出的包
 * 会在 `missingRestoreTables` 处被判成「缺表包」而永远恢复不了。
 */
export const LOGICAL_BACKUP_FORMAT_VERSION = 2;

/** 只有 v2 起的包才必须包含的表。 */
const FORMAT_V2_REQUIRED_TABLES: readonly string[] = ['purchase_orders'];

/**
 * 最早支持恢复的包格式版本。
 * 升级前导出的包（v1，无 `purchase_orders`）与「没有 formatVersion 字段的老恢复包」
 * 都按此版本判定：能恢复，单据表按空表处理。
 */
export const LEGACY_BACKUP_FORMAT_VERSION = 1;

/** 该格式版本的包必须覆盖的可恢复表。 */
export function requiredRestoreTables(formatVersion: number): readonly string[] {
  if (formatVersion >= LOGICAL_BACKUP_FORMAT_VERSION) {
    return RESTORE_TABLES;
  }
  return RESTORE_TABLES.filter((name) => !FORMAT_V2_REQUIRED_TABLES.includes(name));
}

/**
 * 返回恢复包中缺失的**必需**可恢复表名。
 * 全量替换语义要求包覆盖必需表全集：restoreAll 会先 DELETE 全部表，
 * 缺失的表清空后不会回填，构成半恢复（违反 CONVENTIONS §4）。
 * 正常脚本在 decrypt 阶段用 ensureAllRestoreTables 补齐，服务端再做一道强制校验。
 *
 * @param formatVersion 包格式版本；缺省按当前版本（最严格）处理
 */
export function missingRestoreTables(
  tables: readonly { table: string }[],
  formatVersion: number = LOGICAL_BACKUP_FORMAT_VERSION,
): string[] {
  const present = new Set(tables.map((entry) => entry.table));
  return requiredRestoreTables(formatVersion).filter((name) => !present.has(name));
}

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
  constructor(
    private readonly db: Db,
    private readonly stats: RecordStatsRepository,
  ) {}

  /**
   * 摘掉仪表盘统计触发器（`trg_records_stats_*`），返回可原样重建的 DDL 清单。
   *
   * 为什么必须摘：全量恢复要逐行插入十几万行，逐行维护统计是纯浪费，而且会让
   * 恢复慢到超时。DDL 直接从 `sqlite_master` 取，不在 TS 里复制一份定义 ——
   * 以后新增统计触发器不需要再同步改这里。
   */
  private detachStatsTriggers(): { name: string; ddl: string }[] {
    const rows = this.db
      .prepare(
        `SELECT name, sql FROM sqlite_master
          WHERE type = 'trigger' AND name LIKE 'trg_records_stats_%'`,
      )
      .all() as { name: string; sql: string | null }[];
    const captured: { name: string; ddl: string }[] = [];
    for (const row of rows) {
      if (typeof row.sql !== 'string' || row.sql === '') {
        continue;
      }
      captured.push({ name: row.name, ddl: row.sql });
      this.db.exec(`DROP TRIGGER IF EXISTS ${row.name}`);
    }
    return captured;
  }

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
   *
   * @param formatVersion 包格式版本：v1 旧包没有 `purchase_orders`，
   *   清空后不回填（等价于「全部散记」），不会因此被判成半恢复。
   */
  restoreAll(tables: readonly RestoreTable[], formatVersion: number): void {
    this.db.transaction('immediate', () => {
      // 0) 覆盖校验（服务端强制，防半恢复）：缺表时 DELETE 会清空该表却无法回填。
      //    在任何删除之前校验，抛错由事务契约整体回滚，数据不受影响。
      const missing: string[] = missingRestoreTables(tables, formatVersion);
      if (missing.length > 0) {
        throw new Error(`[restore] 恢复包缺少可恢复表，拒绝半恢复: ${missing.join(', ')}`);
      }

      // 1) 移除 append-only / 单向状态机触发器，否则 DELETE 会被 RAISE 拦截。
      for (const trigger of TRIGGERS) {
        this.db.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
      }
      // 1.1) 再摘掉仪表盘统计触发器：回填是批量插入，逐行维护纯属浪费。
      const statsTriggers = this.detachStatsTriggers();

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
      //    顺序强制走 RESTORE_TABLES（父表在前），不信任包内顺序：构造出
      //    records 先于 purchase_orders 的包会撞外键而整单回滚（06-P2-7）。
      const byTable: Map<string, RestoreTable> = new Map(tables.map((t) => [t.table, t]));
      const ordered: RestoreTable[] = RESTORE_TABLES.flatMap((name) => {
        const entry: RestoreTable | undefined = byTable.get(name);
        return entry === undefined ? [] : [entry];
      });
      for (const entry of ordered) {
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

      // 3.1) 统计表是派生数据：批量回填完再一次性重算，而不是靠触发器逐行累加
      //      （触发器此刻是摘掉的）。必须在重建触发器**之前**算完。
      this.stats.rebuildInTransaction();

      // 4) 重建触发器，恢复约束。
      for (const trigger of statsTriggers) {
        this.db.exec(trigger.ddl);
      }
      for (const trigger of TRIGGERS) {
        this.db.exec(trigger.create);
      }
    });
  }
}
