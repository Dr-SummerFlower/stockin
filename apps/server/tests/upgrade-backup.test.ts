/**
 * 升级备份：**升级前物理快照 + 升级后逻辑备份**，各一份。
 *
 * 钉五件事：
 *  ① 有数据的旧库升级后逻辑备份真的生成（ready、含 chunk、schema_version=升级后版本，
 *     因此可以直接在当前版本恢复）；
 *  ② 顺序是「物理快照 → 改结构 → 逻辑备份」，物理那份必须取改结构之前的整库字节；
 *  ③ 走不通的路径（全新库 / 库内没公钥 / 平台托管 PITR）只降级为 skipped，不阻断迁移；
 *  ④ 上次进程留下的卡死任务不会把这次备份挡在 COMMON_BUSY 上；
 *  ⑤ 真实 `bootstrap()` 路径上两份都拿到，且逻辑备份用的是库内那把公钥（首次由
 *     `BACKUP_PUBLIC_KEY` 播种）。
 *
 * 用真实 SQLite + 真实 runner + 真实加密，不 mock 数据库。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/runtime/node/db.factory';
import { closeDatabase, readUserVersion, tableExists, type Db } from '../src/repositories/db';
import { assemble } from '../src/assembly';
import { createPragmaVersionStore } from '../src/runtime/node/version-store.pragma';
import { createFilesystemMigrationSource } from '../src/runtime/node/migration-source.filesystem';
import {
  makeAddColumnsIdempotent,
  renderMigrationSql,
  runMigrations,
} from '../src/repositories/migrations/runner';
import { SCHEMA_EXPECTED } from '../src/repositories/schema';
import { bootstrap } from '../src/bootstrap';
import { generateBackupKeyPair } from '../src/lib/backup-crypto';
import { LogicalBackupRepository } from '../src/repositories/logical-backup.repository';
import { BackupKeyRepository } from '../src/repositories/backup-key.repository';
import { seedDefaultBackupKey } from '../src/services/backup-key.service';
import { takeUpgradeLogicalBackup, type UpgradeBackupNote } from '../src/services/upgrade-backup';
import { nodeRuntime } from '../src/runtime/node';
import { PLATFORM_PRESETS } from '../src/runtime/platform';
import type { BackupPort } from '../src/runtime/ports';

const TS = '2026-11-01T00:00:00.000Z';

let dir: string;
let db: Db;
/** 首次启动要播种的默认公钥（模拟 BACKUP_PUBLIC_KEY）。 */
let defaultPublicKey: string;

/** 记录「物理快照 / 逻辑备份」的先后顺序，用来钉住两份备份的次序。 */
let events: string[];

const backupPort: BackupPort = {
  mode: 'filesystem',
  keepCount: 5,
  create: async () => {
    // 记录快照被调用那一刻的真实 user_version，而不是只记「调用过」。
    // 这样即使有人把 backup.create 挪到 db.exec(sql) 之后，下面的断言也会失败。
    events.push(`physical@${readUserVersion(db)}`);
    return {
      status: 'ok',
      meta: {
        file: 'snapshot.db',
        gzipFile: 'snapshot.db.gz',
        createdAt: TS,
        userVersion: 5,
        initState: 1,
        integrity: 'ok',
        sha256: 'deadbeef',
        magic: 'SQLite format 3\u0000',
        reason: 'pre-migration',
        baseline: false,
        sizeBytes: 1,
      },
    };
  },
  list: () => [],
};

function versionStore() {
  return createPragmaVersionStore({ dataDir: path.join(dir, 'data') });
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'stockin-upgrade-'));
  db = openDatabase({ filename: path.join(dir, 'test.db') });
  events = [];
  defaultPublicKey = (await generateBackupKeyPair()).publicKey;
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

/** 把一个新库迁移到指定版本，构造「升级前」的历史库状态。 */
function migrateTo(targetVersion: number, handle: Db = db): void {
  const source = createFilesystemMigrationSource();
  const store = versionStore();
  for (const file of source.discover().filter((entry) => entry.version <= targetVersion)) {
    handle.transaction('immediate', () => {
      handle.exec(
        makeAddColumnsIdempotent(handle, renderMigrationSql(source.read(file), file.version)),
      );
      store.write(handle, file.version);
    });
  }
  expect(readUserVersion(handle)).toBe(targetVersion);
}

function insertRecord(name: string, handle: Db = db): void {
  handle
    .prepare(
      `INSERT INTO records
       (name, name_norm, purchase_date, expiry_date, spec_norm, unit_price, quantity,
        amount_cents, deleted_at, created_at, updated_at)
     VALUES (?, ?, '2026-11-01', '2026-12-31', '', 100, 2, 200, NULL, ?, ?)`,
    )
    .run(name, name.toLowerCase(), TS, TS);
}

/**
 * 跑一次完整升级：先迁移（runner 内生成物理快照），再生成逻辑备份——与
 * `bootstrap()` 里的实际顺序一致。
 */
async function upgrade(
  notes: UpgradeBackupNote[],
): Promise<Awaited<ReturnType<typeof runMigrations>>> {
  const result = await runMigrations({
    db,
    migrations: createFilesystemMigrationSource(),
    versionStore: versionStore(),
    backup: backupPort,
    initState: 1,
  });
  // 模拟 bootstrap 的首次播种：直接调 takeUpgradeLogicalBackup 不经过 bootstrap，
  // 必须先把默认公钥写入库内，否则这份升级备份会因无公钥而跳过。
  await seedDefaultBackupKey(db, new BackupKeyRepository(db), defaultPublicKey);
  events.push('logical');
  const note = await takeUpgradeLogicalBackup({
    db,
    platform: PLATFORM_PRESETS.node,
    fromVersion: result.fromVersion,
  });
  notes.push(note);
  return result;
}

describe('升级备份', () => {
  it('v5 库升级：物理快照先行，逻辑备份随后且标升级后的版本', async () => {
    migrateTo(5);
    insertRecord('啤酒');
    insertRecord('酱油');

    const notes: UpgradeBackupNote[] = [];
    const result = await upgrade(notes);

    expect(readUserVersion(db)).toBe(SCHEMA_EXPECTED);
    // 物理快照必须取改结构之前的整库字节：调用时库还是 v5。
    expect(events).toEqual(['physical@5', 'logical']);
    expect(result.backupSkippedReason).toBeNull();
    expect(notes[0]?.status).toBe('ok');

    const backupId: string = notes[0]?.backupId ?? '';
    const backup = new LogicalBackupRepository(db).getBackup(backupId);
    expect(backup?.status).toBe('ready');
    // 逻辑备份读的是升级后的数据，所以版本记当前版本 —— 可直接在当前版本恢复。
    expect(backup?.schema_version).toBe(SCHEMA_EXPECTED);
    expect(backup?.chunk_count).toBeGreaterThan(0);
    expect(backup?.manifest_sha256).toEqual(expect.any(String));
  });

  it('全新库没有数据可备份：跳过且不阻断迁移，物理快照照旧', async () => {
    const notes: UpgradeBackupNote[] = [];
    await upgrade(notes);

    expect(notes[0]).toEqual({
      status: 'skipped',
      reason: '全新库（schema 0），没有数据可备份',
    });
    expect(readUserVersion(db)).toBe(SCHEMA_EXPECTED);
    // 全新库在迁移前版本仍是 0。
    expect(events).toEqual(['physical@0', 'logical']);
  });

  it('未配置公钥时跳过逻辑备份，迁移照常完成', async () => {
    migrateTo(5);
    insertRecord('啤酒');
    // 没有默认公钥可播种 => 库内为空 => 逻辑备份跳过。
    defaultPublicKey = '';

    const notes: UpgradeBackupNote[] = [];
    await upgrade(notes);

    expect(notes[0]?.status).toBe('skipped');
    expect(notes[0]?.reason).toContain('公钥');
    expect(readUserVersion(db)).toBe(SCHEMA_EXPECTED);
  });

  it('平台托管 PITR 时不生成逻辑备份，提示去管理台手动备份', async () => {
    migrateTo(5);
    insertRecord('啤酒');
    const note = await takeUpgradeLogicalBackup({
      db,
      platform: { ...PLATFORM_PRESETS.node, backupMode: 'pitr' },
      fromVersion: 5,
    });

    expect(note.status).toBe('skipped');
    expect(note.reason).toContain('PITR');
    expect(note.reason).toContain('管理台');
  });

  it('上次进程残留的卡死任务不会挡住升级备份', async () => {
    migrateTo(5);
    insertRecord('啤酒');
    // 进程被 kill 后留下的 job：状态 running，最后推进时间在 1 小时前。
    const staleAt: string = new Date(Date.now() - 3_600_000).toISOString();
    db.prepare(
      `INSERT INTO backup_jobs
         (id, kind, status, cursor_table, cursor_rowid, chunk_seq, total_chunks, error,
          created_at, updated_at, finished_at)
       VALUES ('job-stale', 'logical', 'running', 'records', 0, 0, NULL, NULL, ?, ?, NULL)`,
    ).run(staleAt, staleAt);

    const notes: UpgradeBackupNote[] = [];
    await upgrade(notes);

    expect(notes[0]?.status).toBe('ok');
    const repo = new LogicalBackupRepository(db);
    // 卡死任务要么被标成 failed、要么被终态 GC 收回，两种都不再占用活动任务位。
    expect(repo.getJob('job-stale')?.status ?? 'failed').toBe('failed');
    expect(repo.hasActiveJob()).toBe(false);
  });
});

describe('bootstrap 接线', () => {
  it('真实启动路径：升级前物理快照 + 升级后逻辑备份，各一份', async () => {
    const dataDir: string = path.join(dir, 'data');
    const backupDir: string = path.join(dir, 'backups');
    mkdirSync(dataDir, { recursive: true });
    const legacy: Db = openDatabase({ filename: path.join(dataDir, 'stockin.db') });
    try {
      migrateTo(5, legacy);
      insertRecord('啤酒', legacy);
    } finally {
      closeDatabase(legacy);
    }

    const base = nodeRuntime({});
    const boot = await bootstrap({
      bundle: { ...base, platform: { ...base.platform, nodeVersionAssert: 'skip' } },
      overrides: {
        nodeEnv: 'test',
        dataDir,
        backupDir,
        tmpDir: path.join(dir, 'tmp'),
        backupPublicKey: defaultPublicKey,
      },
    });
    try {
      expect(boot.migration.fromVersion).toBe(5);
      expect(boot.migration.toVersion).toBe(SCHEMA_EXPECTED);
      // 物理那份：迁移前的快照真的落盘（不是 skipped）。
      expect(boot.migration.backupSkippedReason).toBeNull();
      const snapshotMeta = boot.ports.backup.list().find((meta) => meta.reason === 'pre-migration');
      expect(snapshotMeta).toBeDefined();
      // 读回快照字节本身：版本必须仍是迁移前的 5，且不含 006 新增的表。
      // 只断言 list().length > 0 无法发现「快照取在改结构之后」。
      const snapshotDb: Db = openDatabase({
        filename: path.join(backupDir, snapshotMeta!.file),
      });
      try {
        expect(readUserVersion(snapshotDb)).toBe(5);
        expect(tableExists(snapshotDb, 'backup_keys')).toBe(false);
        expect(tableExists(snapshotDb, 'record_stats')).toBe(false);
      } finally {
        closeDatabase(snapshotDb);
      }
      // 逻辑那份：迁移后生成，版本记当前版本。
      expect(boot.upgradeBackup?.status).toBe('ok');
      const ready = new LogicalBackupRepository(boot.db).listReady();
      expect(ready).toHaveLength(1);
      expect(ready[0]?.schema_version).toBe(SCHEMA_EXPECTED);
    } finally {
      closeDatabase(boot.db);
    }
  });

  it('v6→v7 升级：新表与索引也拿到查询规划器统计', async () => {
    const dataDir: string = path.join(dir, 'data');
    const backupDir: string = path.join(dir, 'backups');
    mkdirSync(dataDir, { recursive: true });
    const legacy: Db = openDatabase({ filename: path.join(dataDir, 'stockin.db') });
    try {
      migrateTo(6, legacy);
      insertRecord('啤酒', legacy);
      // 旧库已经有 records 的统计行：这正是原判据误判「无需 ANALYZE」的前提。
      legacy.exec('ANALYZE');
      const before = legacy
        .prepare("SELECT COUNT(*) AS c FROM sqlite_stat1 WHERE tbl = 'purchase_orders'")
        .get() as { c: number };
      expect(before.c).toBe(0);
    } finally {
      closeDatabase(legacy);
    }

    const base = nodeRuntime({});
    const boot = await bootstrap({
      bundle: { ...base, platform: { ...base.platform, nodeVersionAssert: 'skip' } },
      overrides: {
        nodeEnv: 'test',
        dataDir,
        backupDir,
        tmpDir: path.join(dir, 'tmp'),
        backupPublicKey: defaultPublicKey,
      },
    });
    try {
      expect(boot.migration.fromVersion).toBe(6);
      expect(boot.migration.applied).toEqual([7]);
      const rows = boot.db
        .prepare("SELECT idx FROM sqlite_stat1 WHERE tbl = 'purchase_orders'")
        .all() as { idx: string }[];
      // 空表的 ANALYZE 只为部分索引写统计行；有单据后普通索引才会有自己的行。
      // 这里只要证明新表进入了统计即可（列表页依赖的正是 idx_orders_date）。
      expect(rows.map((row) => row.idx)).toContain('idx_orders_date');
    } finally {
      closeDatabase(boot.db);
    }
  });

  it('没有发生迁移时不生成逻辑备份', async () => {
    const dataDir: string = path.join(dir, 'data');
    const backupDir: string = path.join(dir, 'backups');
    mkdirSync(dataDir, { recursive: true });
    const seeded: Db = openDatabase({ filename: path.join(dataDir, 'stockin.db') });
    try {
      migrateTo(SCHEMA_EXPECTED, seeded);
      insertRecord('啤酒', seeded);
    } finally {
      closeDatabase(seeded);
    }

    const base = nodeRuntime({});
    const boot = await bootstrap({
      bundle: { ...base, platform: { ...base.platform, nodeVersionAssert: 'skip' } },
      overrides: {
        nodeEnv: 'test',
        dataDir,
        backupDir,
        tmpDir: path.join(dir, 'tmp'),
        backupPublicKey: defaultPublicKey,
      },
    });
    try {
      expect(boot.migration.applied).toEqual([]);
      // 已经是当前版本：升级这件事没发生，没有必要凭空做一份备份。
      expect(boot.upgradeBackup).toBeNull();
    } finally {
      closeDatabase(boot.db);
    }
  });

  it('普通启动（无迁移）也清理上次进程残留的卡死任务', async () => {
    const dataDir: string = path.join(dir, 'data');
    const backupDir: string = path.join(dir, 'backups');
    mkdirSync(dataDir, { recursive: true });
    const staleAt: string = new Date(Date.now() - 3_600_000).toISOString();
    const seeded: Db = openDatabase({ filename: path.join(dataDir, 'stockin.db') });
    try {
      migrateTo(SCHEMA_EXPECTED, seeded);
      insertRecord('啤酒', seeded);
      seeded
        .prepare(
          `INSERT INTO backup_jobs
             (id, kind, status, cursor_table, cursor_rowid, chunk_seq, total_chunks, error,
              created_at, updated_at, finished_at)
           VALUES ('job-stale-boot', 'logical', 'running', 'records', 0, 0, NULL, NULL, ?, ?, NULL)`,
        )
        .run(staleAt, staleAt);
    } finally {
      closeDatabase(seeded);
    }

    const base = nodeRuntime({});
    const boot = await bootstrap({
      bundle: { ...base, platform: { ...base.platform, nodeVersionAssert: 'skip' } },
      overrides: {
        nodeEnv: 'test',
        dataDir,
        backupDir,
        tmpDir: path.join(dir, 'tmp'),
        backupPublicKey: defaultPublicKey,
      },
    });
    const runtime = assemble({
      db: boot.db,
      env: boot.env,
      repositories: boot.repositories,
      ports: boot.ports,
      platform: base.platform,
    });
    try {
      // 没有任何迁移：这条路径此前完全不调用 abandonStaleJobs，残留 job 会让
      // 后续所有 enqueue 返回 COMMON_BUSY（.tmp/待办 TODO-01）。
      expect(boot.migration.applied).toEqual([]);
      expect(new LogicalBackupRepository(boot.db).hasActiveJob()).toBe(false);
    } finally {
      runtime.stop();
      closeDatabase(boot.db);
    }
  });
});
