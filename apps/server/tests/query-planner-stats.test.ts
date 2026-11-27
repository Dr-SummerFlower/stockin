/**
 * 查询规划器统计（`ANALYZE`）回归测试。
 *
 * 守的是一个**结构性**缺陷，与数据量无关（实测 10 行就已复现）：`records` 上
 * 「列表页按 purchase_date 排序」这类查询本该走部分索引
 * `idx_records_active_purchase_date`，但在没有 `sqlite_stat1` 时 SQLite 会把
 * `deleted_at = NULL` 当成高选择性等值条件，改走 `idx_records_trash_deleted_at`
 * 并对**全表**建临时 B 树排序。
 *
 * 后果不只是慢：临时 B 树把全表搬进内存（Workers 128MB isolate），且免费版按
 * 「行读取」计费（每日 500 万），一次列表页就吃掉十几万额度。12 万行实测：
 * 63ms / 0.12ms。因此这里直接断言**执行计划**，而不是断言耗时。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/runtime/node/db.factory';
import {
  closeDatabase,
  ensureQueryPlannerStats,
  hasQueryPlannerStats,
  needsQueryPlannerStats,
  type Db,
} from '../src/repositories/db';
import { createPragmaVersionStore } from '../src/runtime/node/version-store.pragma';
import { createFilesystemMigrationSource } from '../src/runtime/node/migration-source.filesystem';
import { runMigrations } from '../src/repositories/migrations/runner';
import type { BackupPort } from '../src/runtime/ports';

const noopBackupPort: BackupPort = {
  mode: 'filesystem',
  keepCount: 5,
  create: async () => ({ status: 'skipped', reason: 'test' }),
  list: () => [],
};

/** 列表页真实 SQL（`RecordRepository.list` 的形态，取首页）。 */
const LIST_SQL = `SELECT * FROM records WHERE deleted_at IS NULL
  ORDER BY purchase_date DESC, id DESC LIMIT 50`;

/** 导出 keyset 分页首屏（`RecordRepository.iteratePages` 的形态）。 */
const KEYSET_SQL = `SELECT * FROM records
  WHERE deleted_at IS NULL AND (purchase_date > '' OR (purchase_date = '' AND id > 0))
  ORDER BY purchase_date ASC, id ASC LIMIT 500`;

let dir: string;
let db: Db;

function planOf(sql: string): string {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all()
    .map((row) => (row as { detail: string }).detail)
    .join(' | ');
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'stockin-plan-'));
  db = openDatabase({ filename: path.join(dir, 'test.db') });
  await runMigrations({
    db,
    migrations: createFilesystemMigrationSource(),
    versionStore: createPragmaVersionStore({ dataDir: path.join(dir, 'data') }),
    backup: noopBackupPort,
    initState: 1,
  });
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

const TS = '2026-01-01T00:00:00.000Z';

function insert(count: number): void {
  const stmt = db.prepare(
    `INSERT INTO records
       (name, name_norm, purchase_date, spec_norm, unit_price, quantity, amount_cents,
        deleted_at, created_at, updated_at)
     VALUES (?, ?, ?, '', 100, 1, 100, NULL, ?, ?)`,
  );
  for (let i = 0; i < count; i += 1) {
    stmt.run(`商品${i}`, `商品${i}`, `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, TS, TS);
  }
}

describe('ensureQueryPlannerStats', () => {
  it('新库没有统计，首次调用生成统计并写入 sqlite_stat1', () => {
    expect(hasQueryPlannerStats(db)).toBe(false);
    expect(ensureQueryPlannerStats(db)).toBe(true);
    expect(hasQueryPlannerStats(db)).toBe(true);
  });

  it('幂等：已有统计时不重复 ANALYZE，force 时强制重算', () => {
    ensureQueryPlannerStats(db);
    expect(ensureQueryPlannerStats(db)).toBe(false);
    expect(ensureQueryPlannerStats(db, true)).toBe(true);
  });

  it('生成统计后列表页不再全表扫描 + 临时 B 树排序', () => {
    insert(30);

    // 退化态：走 deleted_at 索引取全部活跃行，再对全表建临时 B 树排序。
    const before: string = planOf(LIST_SQL);
    expect(before).toContain('TEMP B-TREE');
    expect(before).not.toContain('idx_records_active_purchase_date');

    ensureQueryPlannerStats(db);

    // 修复态：直接按 (purchase_date, id) 反扫，取满 LIMIT 即停。
    const after: string = planOf(LIST_SQL);
    expect(after).not.toContain('TEMP B-TREE');
    expect(after).toContain('idx_records_active_purchase_date');
  });

  it('导出 keyset 分页同样受益（区间扫描而非全表 + 排序）', () => {
    insert(30);
    expect(planOf(KEYSET_SQL)).toContain('TEMP B-TREE');

    ensureQueryPlannerStats(db);

    const after: string = planOf(KEYSET_SQL);
    expect(after).not.toContain('TEMP B-TREE');
    expect(after).toContain('idx_records_active_purchase_date');
  });

  it('统计存在但被清空时（例如手工删过）会重新生成', () => {
    insert(10);
    ensureQueryPlannerStats(db);
    db.exec('DELETE FROM sqlite_stat1');
    expect(hasQueryPlannerStats(db)).toBe(false);
    expect(ensureQueryPlannerStats(db)).toBe(true);
    expect(planOf(LIST_SQL)).not.toContain('TEMP B-TREE');
  });

  it('空库上跑过 ANALYZE 不算「统计可用」：有数据后必须重算', () => {
    // 首启空库：统计表已建但估算行数为 0，此时计划仍是全表 + 临时 B 树。
    expect(ensureQueryPlannerStats(db)).toBe(true);
    expect(hasQueryPlannerStats(db)).toBe(true);
    expect(needsQueryPlannerStats(db)).toBe(false);

    // 建库之后才开始录数据 —— 若不重算，估算行数会永久钉在 0。
    insert(30);
    expect(needsQueryPlannerStats(db)).toBe(true);
    expect(ensureQueryPlannerStats(db)).toBe(true);
    expect(planOf(LIST_SQL)).not.toContain('TEMP B-TREE');
  });

  it('硬删除清空后，空表不会被 MAX(id) 误判为需要重算 ANALYZE', () => {
    // 空库先跑一次 ANALYZE：统计行首列被钉在 0。
    expect(ensureQueryPlannerStats(db)).toBe(true);
    // 进数据后全部硬删除，但不再跑 ANALYZE：估算仍是 0，而 MAX(id) 因
    // AUTOINCREMENT 仍 > 0（旧判据 `approx > 0` 在这里会误判为需要重算）。
    insert(20);
    db.exec('DELETE FROM records');

    expect(needsQueryPlannerStats(db)).toBe(false);
    expect(ensureQueryPlannerStats(db)).toBe(false);

    // 空表重新进数据后仍应重算。
    insert(2);
    expect(needsQueryPlannerStats(db)).toBe(true);
  });

  it('行数翻倍才重算，避免每次启动都 ANALYZE', () => {
    insert(100);
    expect(ensureQueryPlannerStats(db)).toBe(true);

    insert(50); // 1.5 倍，未达 2 倍阈值
    expect(needsQueryPlannerStats(db)).toBe(false);

    insert(100); // 2.5 倍
    expect(needsQueryPlannerStats(db)).toBe(true);
  });

  it('部分索引统计行在前时不误判需要重算 ANALYZE', () => {
    // records 同时有全量索引（首列=总行数）与部分索引（首列=活跃行数）。
    // 以前用 LIMIT 1 任取一行，取到部分索引时会把 5 行库估成 2 行，
    // 与 MAX(id)=5 一比就误判成「涨到 2 倍以上」，每次启动都重跑 ANALYZE。
    insert(5);
    db.prepare('UPDATE records SET deleted_at = ? WHERE id > 2').run(TS);
    expect(ensureQueryPlannerStats(db)).toBe(true);

    const rows = db
      .prepare("SELECT tbl, idx, stat FROM sqlite_stat1 WHERE tbl = 'records'")
      .all() as { tbl: string; idx: string; stat: string }[];
    expect(rows.length).toBeGreaterThan(1);
    db.exec("DELETE FROM sqlite_stat1 WHERE tbl = 'records'");
    const ordered = [...rows].sort(
      (a, b) => Number.parseInt(a.stat, 10) - Number.parseInt(b.stat, 10),
    );
    const restore = db.prepare('INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES (?, ?, ?)');
    for (const row of ordered) {
      restore.run(row.tbl, row.idx, row.stat);
    }
    expect(Number.parseInt(ordered[0]!.stat, 10)).toBe(2); // 首行是活跃行数的部分索引

    expect(needsQueryPlannerStats(db)).toBe(false);
    expect(ensureQueryPlannerStats(db)).toBe(false);
  });
});
