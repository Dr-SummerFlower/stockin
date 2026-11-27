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

/**
 * 是否已有查询规划器统计（`sqlite_stat1` 存在且有行）。
 *
 * 全新库在首次 `ANALYZE` 前没有这张表，因此必须先判表再判行数。
 */
export function hasQueryPlannerStats(db: Db): boolean {
  if (!tableExists(db, 'sqlite_stat1')) {
    return false;
  }
  const row = db.prepare('SELECT COUNT(*) AS c FROM sqlite_stat1').get() as
    | { c: number }
    | undefined;
  return (row?.c ?? 0) > 0;
}

/**
 * 从 `sqlite_stat1` 读 `records` 的（估算）行数。
 *
 * `stat` 形如 `"120000 1936 1"`：第一列是该索引对应的行数，后面是该索引的
 * 平均每键行数。注意 `records` 上既有全量索引也有部分索引（`deleted_at IS NULL`
 * 的活跃行），两种统计行的首列并不相同，因此不能像以前那样用 `LIMIT 1` 任取
 * 一行 —— 取到部分索引时估算值会变成活跃行数，与 `approxRecordRows()` 的
 * 「总行数代理」口径不一致，每次启动都会误判为需要重算 ANALYZE。
 * 取所有统计行首列的最大值，等价于当前索引集合下能拿到的总行数上界。
 */
function statRowEstimate(db: Db): number {
  const rows = db.prepare("SELECT stat FROM sqlite_stat1 WHERE tbl = 'records'").all() as
    | { stat: string }[]
    | undefined;
  let estimate = 0;
  for (const row of rows ?? []) {
    const first: number = Number.parseInt(row.stat.split(' ')[0] ?? '0', 10);
    if (Number.isFinite(first) && first > estimate) {
      estimate = first;
    }
  }
  return estimate;
}

/**
 * `records` 的行数近似值，用 `MAX(id)` 取（主键右端下降，O(1)）。
 *
 * 刻意不用 `COUNT(*)`：那本身就是一次 12 万行的索引扫描，而 Workers 免费版
 * 按「行读取」计费 —— 为了判断「要不要 ANALYZE」而吃掉 12 万额度不划算。
 * `MAX(id)` 单调递增、删除不回收，作为「表长大了多少」的代理足够用。
 */
function approxRecordRows(db: Db): number {
  const row = db.prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM records').get() as
    | { max_id: number }
    | undefined;
  return row?.max_id ?? 0;
}

/**
 * `records` 当前是否真的有行（含软删行）。
 *
 * `LIMIT 1` 命中首行即返回，空表也不做全表扫描，ON Workers 按行计费仍只算 1 行。
 * 这里**不能**用 `MAX(id) > 0` 代替：id 是 AUTOINCREMENT，硬删除清空后不回收，
 * 会把空库误判成有数据，导致每次启动都重跑一次无意义的 `ANALYZE`。
 */
function hasAnyRecord(db: Db): boolean {
  return db.prepare('SELECT 1 AS x FROM records LIMIT 1').get() !== undefined;
}

/**
 * 是否需要（重新）生成统计。
 *
 * 三个条件任一成立就重算：
 *  ① 完全没有 `sqlite_stat1`；
 *  ② 有统计但估算行数为 0，且当前表里确实有行（首次 `ANALYZE` 时表还是空的，之后没再跑过）；
 *  ③ 实际行数已涨到估算值的 2 倍以上（分布变化足以影响选择）。
 *
 * ③ 保证 ANALYZE 在整个生命周期里只跑 O(log n) 次：1 → 2 → 4 → … → 12 万
 * 也就 17 次左右，每次百毫秒级。
 */
export function needsQueryPlannerStats(db: Db): boolean {
  if (!hasQueryPlannerStats(db)) {
    return true;
  }
  const estimate: number = statRowEstimate(db);
  if (estimate === 0) {
    // 估算 0 分两种：真空表（统计正确，无需重算）与空库跑过 ANALYZE 后又进了数据。
    // 用 O(1) 的「是否有行」探测区分，不能用 MAX(id)（硬删除后仍 > 0）。
    return hasAnyRecord(db);
  }
  return approxRecordRows(db) > estimate * 2;
}

/**
 * 确保 `records` 等表有查询规划器统计（必要时执行 `ANALYZE`）。
 *
 * 为什么必须有这一步（2026-11-24 实测，12 万行库）：
 * 列表页 `WHERE deleted_at IS NULL ORDER BY purchase_date DESC, id DESC` 本该走
 * 部分索引 `idx_records_active_purchase_date`（反向扫描即满足排序），但没有
 * `sqlite_stat1` 时 SQLite 会把 `deleted_at = NULL` 当成高选择性等值条件，
 * 改走 `idx_records_trash_deleted_at` 再对**全表**建临时 B 树排序：
 *
 * | 查询 | 无统计 | 有统计 |
 * | --- | --- | --- |
 * | 列表页第 1 页 | 63ms，扫 12 万行 + 临时 B 树 | 0.12ms，扫 50 行 |
 * | 列表页第 200 页 | 125ms，扫 12 万行 + 临时 B 树 | 0.25ms，扫 50 行 |
 * | 导出 keyset 页 | 60ms，扫 12 万行 + 临时 B 树 | 4.6ms，走索引区间 |
 *
 * 两个后果都不是「慢一点」：临时 B 树把 12 万行搬进内存（Workers 128MB
 * isolate），且 Workers 免费版按「行读取」计费（每日 500 万），一次列表页
 * 就吃掉 12 万额度。`ANALYZE` 全库 128ms、只写 7 行 `sqlite_stat1` 是 Node 侧
 * 实测口径；Workers（DO SQLite）的行读计费与计划质量未在本项目实测，启动期
 * 保留 ANALYZE 是契约要求（缺统计的代价远大于一次 ANALYZE），但其 Workers
 * 成本仍需实测确认，不能把 Node 的「代价可忽略」外推过去。
 *
 * 注意「空库跑过一次 ANALYZE」不等于统计可用：那会把估算行数固化成 0，
 * 所以这里用 `needsQueryPlannerStats` 判新旧，而不是只看统计表存不存在。
 *
 * @param force 强制重算（数据分布整体变化后使用，例如全量恢复之后）。
 * @returns 是否真的执行了 `ANALYZE`。
 */
export function ensureQueryPlannerStats(db: Db, force = false): boolean {
  if (!force && !needsQueryPlannerStats(db)) {
    return false;
  }
  db.exec('ANALYZE');
  return true;
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
