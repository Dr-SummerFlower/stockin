/**
 * 数据层门面：端口类型 + 适配器装配 + PRAGMA 唯一落点。
 *
 * 依据：设计文档 v1.1 §3.3 / §4.5 / §7.6 ——
 * WAL + synchronous=NORMAL + busy_timeout=5000；启动 integrity_check +
 * user_version 自检；优雅停机前 wal_checkpoint(TRUNCATE)。
 *
 * 分层（2026-11-15 起）：
 *   Repository ──依赖──> `Db`(= DbPort，纯接口，见 `db.port.ts`)
 *                              ▲
 *                              └── 适配器：`adapters/node-sqlite.adapter.ts`（默认）
 *                                          `adapters/do-sqlite.adapter.ts`（Workers）
 *
 * **本文件是 server 内唯一「选择哪个驱动」的位置**；Repository 只依赖此处导出的
 * `Db` 类型与 8 个函数，不认识任何驱动。换后端时改这一处装配即可。
 */
import { createNodeSqliteAdapter } from './adapters/node-sqlite.adapter';
import type { DbPort } from './db.port';
import { checkUserVersion, SCHEMA_EXPECTED, type UserVersionVerdict } from './schema';

export type { DbPort, RunResultPort, StatementPort, TransactionMode } from './db.port';
export { UnsupportedCapabilityError } from './db.port';

/**
 * 连接句柄类型。
 *
 * 历史上这里是 `InstanceType<typeof Database>`（better-sqlite3）；现在是端口接口，
 * 16 个只写 `Db` 的 Repository 无需任何改动。
 */
export type Db = DbPort;

export interface OpenDatabaseOptions {
  readonly filename: string;
  readonly readonly?: boolean;
  readonly fileMustExist?: boolean;
}

/** 打开连接并一次性设置三项 PRAGMA（文档要求维持原值，不调优）。 */
export function openDatabase(options: OpenDatabaseOptions): Db {
  const db: Db = createNodeSqliteAdapter(options);
  if (!(options.readonly ?? false)) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 5000');
  }
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/** PRAGMA integrity_check，非 ok 时抛错（启动 fail-fast）。 */
export function assertIntegrity(db: Db): string {
  const result: unknown = db.readPragma('integrity_check');
  const text: string = typeof result === 'string' ? result : String(result);
  if (text !== 'ok') {
    throw new Error(`[db] integrity_check 失败: ${text}`);
  }
  return text;
}

/** 判断表是否已存在（全新库迁移前 meta 尚未创建，供 bootstrap 判断 init_state）。 */
export function tableExists(db: Db, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { hit: number } | undefined;
  return row !== undefined;
}

/** 读取 user_version（唯一权威版本）。 */
export function readUserVersion(db: Db): number {
  const value: unknown = db.readPragma('user_version');
  const parsed: number = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) ? parsed : 0;
}

/** 启动等值自检，返回裁决供 runner 决定是否需要迁移。 */
export function assertUserVersion(db: Db, dataDir: string): UserVersionVerdict {
  return checkUserVersion(readUserVersion(db), dataDir, SCHEMA_EXPECTED);
}

/** 优雅停机：先 checkpoint 再 close。 */
export function closeDatabase(db: Db): void {
  if (!db.isOpen) {
    return;
  }
  try {
    db.checkpointTruncate();
  } finally {
    db.close();
  }
}

/**
 * `BEGIN IMMEDIATE` 事务入口。
 *
 * 供 T03b 的「导入整批单事务、绝不拆分」、setup 四者同事务、
 * 业务写 + 操作日志同事务使用；任何异常自动 ROLLBACK。
 */
export function immediateTransaction<T>(db: Db, fn: () => T): T {
  return db.transaction('immediate', fn);
}

/** 普通 DEFERRED 事务（只读快照 / 常规组合写）。 */
export function deferredTransaction<T>(db: Db, fn: () => T): T {
  return db.transaction('deferred', fn);
}
