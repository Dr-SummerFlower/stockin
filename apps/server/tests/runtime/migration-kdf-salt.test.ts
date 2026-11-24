/**
 * 迁移 005 回归：004 曾就地加 kdf_salt 但版本未升，导致两类 v4 库并存。
 *
 * 钉死三件事：
 *  ① 全新库能从 0 一路迁移到 SCHEMA_EXPECTED，且 backups 含 kdf_salt；
 *  ② 不含 kdf_salt 的 v4 库升级后补上该列；
 *  ③ 已含 kdf_salt 的 v4 库升级不因 duplicate column 中断。
 *
 * 用真实 SQLite + 真实 runner，不 mock 数据库。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/runtime/node/db.factory';
import { closeDatabase, readUserVersion, type Db } from '../../src/repositories/db';
import { createPragmaVersionStore } from '../../src/runtime/node/version-store.pragma';
import { createFilesystemMigrationSource } from '../../src/runtime/node/migration-source.filesystem';
import {
  columnExists,
  makeAddColumnsIdempotent,
  renderMigrationSql,
  runMigrations,
} from '../../src/repositories/migrations/runner';
import { SCHEMA_EXPECTED } from '../../src/repositories/schema';
import type { BackupPort } from '../../src/runtime/ports';

const noopBackupPort: BackupPort = {
  mode: 'filesystem',
  keepCount: 5,
  create: async () => ({ status: 'skipped', reason: 'test' }),
  list: () => [],
};

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'stockin-mig005-'));
  db = openDatabase({ filename: path.join(dir, 'test.db') });
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

function backupsHasKdfSalt(): boolean {
  return columnExists(db, 'backups', 'kdf_salt');
}

async function migrate(): Promise<void> {
  await runMigrations({
    db,
    migrations: createFilesystemMigrationSource(),
    versionStore: createPragmaVersionStore({ dataDir: path.join(dir, 'data') }),
    backup: noopBackupPort,
    initState: 1,
  });
}

describe('makeAddColumnsIdempotent', () => {
  it('列已存在时把 ADD COLUMN 改写成无副作用的 SELECT 1', () => {
    db.exec('CREATE TABLE t (id INTEGER, existing_col TEXT);');
    const sql = [
      "ALTER TABLE t ADD COLUMN existing_col TEXT NOT NULL DEFAULT '';",
      "ALTER TABLE t ADD COLUMN new_col TEXT NOT NULL DEFAULT '';",
    ].join('\n');
    const out = makeAddColumnsIdempotent(db, sql);
    expect(out).toContain('SELECT 1;');
    expect(out).toContain('existing_col 已存在');
    expect(out).toContain('ALTER TABLE t ADD COLUMN new_col');
  });
});

describe('迁移 005：幂等补齐 kdf_salt', () => {
  it('全新库迁移到 SCHEMA_EXPECTED 后 backups 含 kdf_salt', async () => {
    await migrate();
    expect(readUserVersion(db)).toBe(SCHEMA_EXPECTED);
    expect(backupsHasKdfSalt()).toBe(true);
  });

  it('不含 kdf_salt 的 v4 库升级后补上该列', async () => {
    // 模拟 d8c2bbd 版 004 执行后的库：先迁移到 v4，再删掉 kdf_salt 列并锁定版本。
    db.exec('PRAGMA user_version = 0;');
    await runMigrationsTo(4);
    expect(backupsHasKdfSalt()).toBe(true);
    // SQLite 3.35+ 支持 DROP COLUMN；用重建表方式兼容旧版运行时。
    db.exec(`
      CREATE TABLE backups_v4 (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, format_version INTEGER NOT NULL,
        schema_version INTEGER NOT NULL, key_id TEXT NOT NULL, ephemeral_public_key TEXT NOT NULL,
        wrapped_key_iv TEXT NOT NULL, wrapped_key_ciphertext TEXT NOT NULL, wrapped_key_tag TEXT NOT NULL,
        created_at TEXT NOT NULL, chunk_count INTEGER NOT NULL DEFAULT 0,
        plain_bytes INTEGER NOT NULL DEFAULT 0, manifest_sha256 TEXT,
        status TEXT NOT NULL, FOREIGN KEY (job_id) REFERENCES backup_jobs(id) ON DELETE CASCADE
      );
      INSERT INTO backups_v4 SELECT id, job_id, format_version, schema_version, key_id,
        ephemeral_public_key, wrapped_key_iv, wrapped_key_ciphertext, wrapped_key_tag,
        created_at, chunk_count, plain_bytes, manifest_sha256, status FROM backups;
      DROP TABLE backups;
      ALTER TABLE backups_v4 RENAME TO backups;
      PRAGMA user_version = 4;
    `);
    expect(backupsHasKdfSalt()).toBe(false);

    await migrate();
    expect(readUserVersion(db)).toBe(SCHEMA_EXPECTED);
    expect(backupsHasKdfSalt()).toBe(true);
  });

  it('已含 kdf_salt 的 v4 库升级不因 duplicate column 中断', async () => {
    await runMigrationsTo(4);
    expect(readUserVersion(db)).toBe(4);
    expect(backupsHasKdfSalt()).toBe(true);

    await migrate();
    expect(readUserVersion(db)).toBe(SCHEMA_EXPECTED);
    expect(backupsHasKdfSalt()).toBe(true);
  });
});

/** 把一个新库迁移到指定版本（不依赖 SCHEMA_EXPECTED），用于构造历史库状态。 */
async function runMigrationsTo(targetVersion: number): Promise<void> {
  const source = createFilesystemMigrationSource();
  const versionStore = createPragmaVersionStore({ dataDir: path.join(dir, 'data') });
  // 用真实脚本渲染逻辑，逐个执行到目标版本，构造历史库的结构与版本号。
  for (const file of source.discover().filter((f) => f.version <= targetVersion)) {
    const raw = source.read(file);
    const render = renderMigrationSql(raw, file.version);
    db.transaction('immediate', () => {
      db.exec(makeAddColumnsIdempotent(db, render));
      versionStore.write(db, file.version);
    });
  }
  expect(readUserVersion(db)).toBe(targetVersion);
}
