/**
 * 导出分页（keyset）契约测试：只验证 SQL 层行为，用真实 SQLite + 真实迁移建库。
 *
 * 这里是「导出不再依赖 SQL 游标」的兜底：`iteratePages` 必须与
 * `ORDER BY purchase_date, id` 严格同序、页边界不跳行不重复，且 `count`
 * 与分页命中数一致（导出上限判定依赖后者）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/runtime/node/db.factory';
import { closeDatabase, type Db } from '../src/repositories/db';
import { createPragmaVersionStore } from '../src/runtime/node/version-store.pragma';
import { createFilesystemMigrationSource } from '../src/runtime/node/migration-source.filesystem';
import { runMigrations } from '../src/repositories/migrations/runner';
import type { BackupPort } from '../src/runtime/ports';
import { RecordRepository } from '../src/repositories/record.repository';
import type { RecordRow } from '../src/repositories/types';

const noopBackupPort: BackupPort = {
  mode: 'filesystem',
  keepCount: 5,
  create: async () => ({ status: 'skipped', reason: 'test' }),
  list: () => [],
};

let dir: string;
let db: Db;
let repo: RecordRepository;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'stockin-paging-'));
  db = openDatabase({ filename: path.join(dir, 'test.db') });
  await runMigrations({
    db,
    migrations: createFilesystemMigrationSource(),
    versionStore: createPragmaVersionStore({ dataDir: path.join(dir, 'data') }),
    backup: noopBackupPort,
    initState: 1,
  });
  repo = new RecordRepository(db);
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

const TS = '2026-01-01T00:00:00.000Z';

/** 直接写库存最小合法行：只为验证排序与分页，不经过 domain 补算。 */
function insert(
  name: string,
  purchaseDate: string,
  deletedAt: string | null = null,
  expiryDate: string | null = null,
): void {
  db.prepare(
    `INSERT INTO records
       (name, name_norm, purchase_date, expiry_date, spec_norm, unit_price, quantity,
        amount_cents, deleted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', 100, 1, 100, ?, ?, ?)`,
  ).run(name, name.toLowerCase(), purchaseDate, expiryDate, deletedAt, TS, TS);
}

function ids(rows: Iterable<RecordRow>): number[] {
  return [...rows].map((row) => row.id);
}

function expectedIds(): number[] {
  const rows = db
    .prepare('SELECT id FROM records WHERE deleted_at IS NULL ORDER BY purchase_date ASC, id ASC')
    .all() as { id: number }[];
  return rows.map((row) => row.id);
}

describe('RecordRepository.iteratePages', () => {
  it('跨页与整体顺序一致，且每行只出现一次', () => {
    // 同一天多条 + 不同天交错，覆盖「只按日期推进会漏行」的边界。
    insert('A', '2026-01-02');
    insert('B', '2026-01-01');
    insert('C', '2026-01-01');
    insert('D', '2026-01-03');
    insert('E', '2026-01-01');

    const paged = ids(repo.iteratePages({}, '2026-01-01', 30, 2));
    expect(paged).toEqual(expectedIds());
    expect(new Set(paged).size).toBe(paged.length);
    expect(paged.length).toBe(5);
  });

  it('页大小大于总行数时一次取完', () => {
    insert('A', '2026-01-01');
    insert('B', '2026-01-02');
    expect(ids(repo.iteratePages({}, '2026-01-01', 30, 200))).toEqual(expectedIds());
  });

  it('筛选条件与分页同时生效（软删与日期范围都在 SQL 层排除）', () => {
    insert('保留', '2026-01-01');
    insert('范围外', '2025-12-31');
    insert('已删除', '2026-01-02', TS);

    const paged = ids(repo.iteratePages({ purchaseDateFrom: '2026-01-01' }, '2026-01-01', 30, 1));
    expect(paged).toEqual([1]);
    expect(repo.count({ purchaseDateFrom: '2026-01-01' }, '2026-01-01', 30)).toBe(1);
  });

  it('count 与分页命中行数一致（导出上限判定的前提）', () => {
    for (let i = 0; i < 7; i += 1) {
      insert(`记录${i}`, `2026-01-0${(i % 3) + 1}`);
    }
    const total = repo.count({}, '2026-01-01', 30);
    expect(total).toBe(7);
    expect(ids(repo.iteratePages({}, '2026-01-01', 30, 2)).length).toBe(total);
  });

  it('多参数筛选（expiryStatus）+ 每页 1 行时参数顺序不与 keyset 游标错位', () => {
    // near 会往 buildFilter.params 注入两个边界值；若与 keyset 的
    // (purchase_date, id) 占位符顺序错位，游标会被当成日期边界而漏行/重复。
    insert('临期A', '2026-01-03', null, '2026-01-15');
    insert('远期B', '2026-01-02', null, '2026-02-15');
    insert('过期C', '2026-01-01', null, '2025-12-31');
    insert('无日期D', '2026-01-04');
    insert('临期E', '2026-01-02', null, '2026-01-20');

    const expected = (
      db
        .prepare(
          `SELECT id FROM records
            WHERE deleted_at IS NULL AND expiry_date >= ? AND expiry_date <= ?
            ORDER BY purchase_date ASC, id ASC`,
        )
        .all('2026-01-01', '2026-01-31') as { id: number }[]
    ).map((row) => row.id);
    const filter = { expiryStatus: 'near' as const };
    expect(expected).toEqual([5, 1]); // 按 purchase_date：临期E(01-02)、临期A(01-03)
    expect(repo.count(filter, '2026-01-01', 30)).toBe(expected.length);
    expect(ids(repo.iteratePages(filter, '2026-01-01', 30, 1))).toEqual(expected);
  });

  it('总行数恰为页大小整数倍时不漏最后一行', () => {
    for (let i = 0; i < 4; i += 1) {
      insert(`记录${i}`, `2026-01-0${i + 1}`);
    }
    const paged = ids(repo.iteratePages({}, '2026-01-01', 30, 2));
    expect(paged).toEqual(expectedIds());
    expect(new Set(paged).size).toBe(4);
  });
});
