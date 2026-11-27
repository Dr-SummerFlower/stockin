/**
 * 仪表盘增量统计的**漂移守卫**。
 *
 * 统计表由 6 个触发器逐行维护，最大的风险不是慢，而是「某条写路径漏更新 →
 * 数字悄悄错」。因此每个阶段都拿触发器算出的结果与 `aggregateSql`（唯一权威
 * 口径）做全字段比对：只要有一处不对，测试立刻红。
 *
 * 覆盖的写路径：新增（含无到期日）、修改金额/到期日/商品名、软删、回收站恢复、
 * 彻底删除、以及 `rebuild()` 后的重算。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/runtime/node/db.factory';
import { closeDatabase, readUserVersion, type Db } from '../src/repositories/db';
import { createPragmaVersionStore } from '../src/runtime/node/version-store.pragma';
import { createFilesystemMigrationSource } from '../src/runtime/node/migration-source.filesystem';
import {
  makeAddColumnsIdempotent,
  renderMigrationSql,
  runMigrations,
} from '../src/repositories/migrations/runner';
import { RecordRepository } from '../src/repositories/record.repository';
import { RecordStatsRepository } from '../src/repositories/record-stats.repository';
import type { BackupPort } from '../src/runtime/ports';

const noopBackupPort: BackupPort = {
  mode: 'filesystem',
  keepCount: 5,
  create: async () => ({ status: 'skipped', reason: 'test' }),
  list: () => [],
};

const TODAY = '2026-11-24';
const THRESHOLD = 30;
const TS = '2026-11-01T00:00:00.000Z';

let dir: string;
let db: Db;
let records: RecordRepository;
let stats: RecordStatsRepository;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'stockin-stats-'));
  db = openDatabase({ filename: path.join(dir, 'test.db') });
  await runMigrations({
    db,
    migrations: createFilesystemMigrationSource(),
    versionStore: createPragmaVersionStore({ dataDir: path.join(dir, 'data') }),
    backup: noopBackupPort,
    initState: 1,
  });
  records = new RecordRepository(db);
  stats = new RecordStatsRepository(db, records);
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

interface RowSpec {
  name: string;
  expiry?: string | null;
  amount: number;
  quantity: number;
  deletedAt?: string | null;
}

function insertRow(spec: RowSpec): number {
  const result = db
    .prepare(
      `INSERT INTO records
         (name, name_norm, purchase_date, expiry_date, spec_norm, unit_price, quantity,
          amount_cents, deleted_at, created_at, updated_at)
       VALUES (?, ?, '2026-11-01', ?, '', 100, ?, ?, ?, ?, ?)`,
    )
    .run(
      spec.name,
      spec.name.toLowerCase(),
      spec.expiry ?? null,
      spec.quantity,
      spec.amount,
      spec.deletedAt ?? null,
      TS,
      TS,
    );
  return Number(result.lastInsertRowid);
}

/** 每一步之后都跑：触发器口径必须与聚合口径逐字段一致。 */
function expectNoDrift(): void {
  const actual = stats.metrics(TODAY, THRESHOLD);
  const expected = records.aggregateSql(TODAY, THRESHOLD);
  expect(actual).toEqual(expected);
  expect(stats.matchesAggregate(TODAY, THRESHOLD)).toBe(true);
}

describe('仪表盘增量统计（触发器维护）', () => {
  it('空表时全零，且与聚合一致', () => {
    expectNoDrift();
    expect(stats.metrics(TODAY, THRESHOLD)).toEqual({
      totalAmountCents: 0,
      totalRecords: 0,
      distinctProducts: 0,
      totalQuantity: 0,
      nearExpiryCount: 0,
      nearExpiryAmountCents: 0,
      expiredCount: 0,
      expiredAmountCents: 0,
    });
  });

  it('新增：同商品累加、不同商品计入种类数、无到期日不计入临期/过期', () => {
    insertRow({ name: '牛奶', expiry: '2026-12-01', amount: 1000, quantity: 12 });
    insertRow({ name: '牛奶', expiry: '2026-12-01', amount: 2000, quantity: 24 });
    insertRow({ name: '面包', expiry: null, amount: 500, quantity: 5 });
    expectNoDrift();
    const m = stats.metrics(TODAY, THRESHOLD);
    expect(m.totalRecords).toBe(3);
    expect(m.totalAmountCents).toBe(3500);
    expect(m.totalQuantity).toBe(41);
    expect(m.distinctProducts).toBe(2);
    expect(m.nearExpiryCount).toBe(2);
    expect(m.nearExpiryAmountCents).toBe(3000);
  });

  it('临期与过期的分界跟「今天」走：隔天读同一份数据结论会变', () => {
    insertRow({ name: '酸奶', expiry: '2026-12-05', amount: 800, quantity: 8 });
    // 今天 11-24，到期 12-05 在 30 天窗口内 → 临期。
    expect(stats.metrics(TODAY, THRESHOLD).nearExpiryCount).toBe(1);
    // 换成 12-10 再看：同一条记录变成过期。
    const later = stats.metrics('2026-12-10', THRESHOLD);
    expect(later.nearExpiryCount).toBe(0);
    expect(later.expiredCount).toBe(1);
    expect(later.expiredAmountCents).toBe(800);
  });

  it('修改金额/到期日/商品名：撤销旧值、记入新值', () => {
    const id = insertRow({ name: '牛奶', expiry: '2026-12-01', amount: 1000, quantity: 12 });
    insertRow({ name: '面包', expiry: '2026-12-02', amount: 500, quantity: 5 });
    expectNoDrift();

    db.prepare(
      `UPDATE records SET amount_cents = 3000, quantity = 30, expiry_date = '2027-06-01',
         name_norm = '纯牛奶', name = '纯牛奶', version = version + 1 WHERE id = ?`,
    ).run(id);
    expectNoDrift();

    const m = stats.metrics(TODAY, THRESHOLD);
    expect(m.totalAmountCents).toBe(3500);
    expect(m.distinctProducts).toBe(2);
    // 到期日挪到窗口之外，只剩面包在临期。
    expect(m.nearExpiryCount).toBe(1);
    expect(m.nearExpiryAmountCents).toBe(500);
  });

  it('软删与回收站恢复：来回切换后数字回到原样', () => {
    const id = insertRow({ name: '牛奶', expiry: '2026-12-01', amount: 1000, quantity: 12 });
    insertRow({ name: '面包', expiry: null, amount: 500, quantity: 5 });
    expectNoDrift();

    db.prepare('UPDATE records SET deleted_at = ? WHERE id = ?').run(TS, id);
    expectNoDrift();
    expect(stats.metrics(TODAY, THRESHOLD).totalRecords).toBe(1);

    db.prepare('UPDATE records SET deleted_at = NULL WHERE id = ?').run(id);
    expectNoDrift();
    expect(stats.metrics(TODAY, THRESHOLD).totalRecords).toBe(2);
  });

  it('彻底删除只影响已经软删的行', () => {
    const soft = insertRow({ name: '牛奶', amount: 1000, quantity: 12, deletedAt: TS });
    insertRow({ name: '面包', amount: 500, quantity: 5 });
    expectNoDrift();

    // 删掉一条已软删的行：活跃统计不该变。
    db.prepare('DELETE FROM records WHERE id = ?').run(soft);
    expectNoDrift();
    expect(stats.metrics(TODAY, THRESHOLD).totalRecords).toBe(1);
  });

  it('商品键归零时从商品集合里移除，种类数不会越算越多', () => {
    const id = insertRow({ name: '牛奶', amount: 1000, quantity: 12 });
    expect(stats.metrics(TODAY, THRESHOLD).distinctProducts).toBe(1);
    db.prepare('UPDATE records SET deleted_at = ? WHERE id = ?').run(TS, id);
    expect(stats.metrics(TODAY, THRESHOLD).distinctProducts).toBe(0);
    expectNoDrift();
  });

  it('rebuild 后与触发器维护的结果一致（派生表可以随时重建）', () => {
    for (let i = 0; i < 20; i += 1) {
      insertRow({
        name: `商品${i % 7}`,
        expiry: i % 3 === 0 ? '2026-12-0' + ((i % 9) + 1) : null,
        amount: 100 * (i + 1),
        quantity: i + 1,
      });
    }
    expectNoDrift();
    const before = stats.metrics(TODAY, THRESHOLD);

    // 模拟「统计表被清空/漂移」后再重建。
    db.exec('DELETE FROM record_stats');
    db.exec('DELETE FROM record_product_stats');
    db.exec('DELETE FROM record_expiry_stats');
    stats.rebuild();

    expect(stats.metrics(TODAY, THRESHOLD)).toEqual(before);
    expectNoDrift();
  });
});

describe('006 迁移播种（老库带数据升级）', () => {
  it('v5 库升级后立即与 aggregateSql 等价，不必等下一次写入', async () => {
    // 这里必须自己建库：上面的 beforeEach 总在空库上跑迁移，播种 SQL 插入 0 行，
    // 覆盖不到「老库升级那一次」的口径（.tmp/待办 TODO-03）。
    const legacyDir: string = mkdtempSync(path.join(tmpdir(), 'stockin-schema6-seed-'));
    const legacyDb: Db = openDatabase({ filename: path.join(legacyDir, 'legacy.db') });
    const source = createFilesystemMigrationSource();
    const versionStore = createPragmaVersionStore({ dataDir: legacyDir });
    try {
      for (const file of source.discover().filter((entry) => entry.version <= 5)) {
        legacyDb.transaction('immediate', () => {
          legacyDb.exec(
            makeAddColumnsIdempotent(legacyDb, renderMigrationSql(source.read(file), file.version)),
          );
          versionStore.write(legacyDb, file.version);
        });
      }
      expect(readUserVersion(legacyDb)).toBe(5);

      const insertLegacy = (
        name: string,
        expiry: string | null,
        amount: number,
        quantity: number,
        deletedAt: string | null,
      ): void => {
        legacyDb
          .prepare(
            `INSERT INTO records
               (name, name_norm, purchase_date, expiry_date, spec_norm, unit_price, quantity,
                amount_cents, deleted_at, created_at, updated_at)
             VALUES (?, ?, '2026-11-01', ?, '', 100, ?, ?, ?, ?, ?)`,
          )
          .run(name, name.toLowerCase(), expiry, quantity, amount, deletedAt, TS, TS);
      };
      insertLegacy('临期牛奶', '2026-12-01', 1200, 2, null);
      insertLegacy('已过期面包', '2026-10-01', 800, 1, null);
      insertLegacy('无日期水果', null, 1500, 3, null);
      insertLegacy('软删酱油', '2026-12-05', 999, 1, TS);

      const result = await runMigrations({
        db: legacyDb,
        migrations: source,
        versionStore,
        backup: noopBackupPort,
        initState: 1,
      });
      expect(result.fromVersion).toBe(5);

      // 播种 SQL 与 aggregateSql 必须同口径：临期、过期、无日期、软删都覆盖到了。
      const legacyStats = new RecordStatsRepository(legacyDb, new RecordRepository(legacyDb));
      expect(legacyStats.metrics(TODAY, THRESHOLD)).toEqual(
        new RecordRepository(legacyDb).aggregateSql(TODAY, THRESHOLD),
      );
      expect(legacyStats.matchesAggregate(TODAY, THRESHOLD)).toBe(true);
    } finally {
      closeDatabase(legacyDb);
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});
