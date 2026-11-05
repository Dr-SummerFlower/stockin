/**
 * better-sqlite3 连接与 PRAGMA 唯一落点。
 *
 * 依据：设计文档 v1.1 §3.3 / §4.5 / §7.6 ——
 * WAL + synchronous=NORMAL + busy_timeout=5000；启动 integrity_check +
 * user_version 自检；优雅停机前 wal_checkpoint(TRUNCATE)。
 *
 * 本文件是 server 内**唯一** `require('better-sqlite3')` 的位置；
 * Repository 只依赖此处导出的 `Db` 类型，不各自建连接。
 */
import Database from 'better-sqlite3';
import {
  checkUserVersion,
  SCHEMA_EXPECTED,
  type UserVersionVerdict,
} from './schema';

/** 连接句柄类型（从构造签名推导，避免依赖 @types 命名空间细节）。 */
export type Db = InstanceType<typeof Database>;

export interface OpenDatabaseOptions {
  readonly filename: string;
  readonly readonly?: boolean;
  readonly fileMustExist?: boolean;
}

/** 打开连接并一次性设置三项 PRAGMA（文档要求维持原值，不调优）。 */
export function openDatabase(options: OpenDatabaseOptions): Db {
  const db: Db = new Database(options.filename, {
    readonly: options.readonly ?? false,
    fileMustExist: options.fileMustExist ?? false,
  });
  if (!options.readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
  }
  db.pragma('foreign_keys = ON');
  return db;
}

/** PRAGMA integrity_check，非 ok 时抛错（启动 fail-fast）。 */
export function assertIntegrity(db: Db): string {
  const result: unknown = db.pragma('integrity_check', { simple: true });
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
  const value: unknown = db.pragma('user_version', { simple: true });
  const parsed: number = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) ? parsed : 0;
}

/** 启动等值自检，返回裁决供 runner 决定是否需要迁移。 */
export function assertUserVersion(db: Db, dataDir: string): UserVersionVerdict {
  return checkUserVersion(readUserVersion(db), dataDir, SCHEMA_EXPECTED);
}

/** 优雅停机：先 checkpoint 再 close。 */
export function closeDatabase(db: Db): void {
  if (!db.open) {
    return;
  }
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

/**
 * `BEGIN IMMEDIATE` 事务入口（better-sqlite3 的 `.immediate()` 变体）。
 *
 * 供 T03b 的「导入整批单事务、绝不拆分」、setup 四者同事务、
 * 业务写 + 操作日志同事务使用；任何异常自动 ROLLBACK。
 */
export function immediateTransaction<T>(db: Db, fn: () => T): T {
  return db.transaction(fn).immediate();
}

/** 普通 DEFERRED 事务（只读快照 / 常规组合写）。 */
export function deferredTransaction<T>(db: Db, fn: () => T): T {
  return db.transaction(fn).deferred();
}
