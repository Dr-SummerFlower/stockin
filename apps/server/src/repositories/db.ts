/**
 * 数据层门面：端口类型 + 生命周期与事务助手 + PRAGMA 唯一落点。
 *
 * 依据：设计文档 v1.1 §3.3 / §4.5 / §7.6 ——
 * WAL + synchronous=NORMAL + busy_timeout=5000；启动 integrity_check +
 * user_version 自检；优雅停机前 wal_checkpoint(TRUNCATE)。
 *
 * 分层（2026-11-15 起）：
 *   Repository ──依赖──> `Db`(= DbPort，纯接口，见 `db.port.ts`)
 *                              ▲
 *                              └── 适配器：`adapters/node-sqlite.adapter.ts`（Node，默认）
 *                                          `adapters/do-sqlite.adapter.ts`（Workers）
 *
 * **本文件刻意不认识任何具体驱动**：连接的创建（含 WAL 等 PRAGMA 赋值）
 * 已下移到 `runtime/node/db.factory.ts` 与 Worker 侧的 DO 存储工厂。
 * 原因是 Workers 构建期不能出现 `node:sqlite` 的实例化路径 —— 否则整包
 * 会在 `new DatabaseSync()` 处抛 `Illegal constructor`。
 */
import type { DbPort } from './db.port';

export type { DbPort, RunResultPort, StatementPort, TransactionMode } from './db.port';
export { UnsupportedCapabilityError } from './db.port';

/**
 * 连接句柄类型。
 *
 * 历史上这里是 `InstanceType<typeof Database>`（better-sqlite3）；现在是端口接口，
 * 16 个只写 `Db` 的 Repository 无需任何改动。
 */
export type Db = DbPort;

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

/** 读取 user_version（唯一权威版本）。仅 Node 侧（`pragma` 版本存储）使用。 */
export function readUserVersion(db: Db): number {
  const value: unknown = db.readPragma('user_version');
  const parsed: number = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) ? parsed : 0;
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
