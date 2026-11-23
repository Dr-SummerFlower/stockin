/**
 * 逻辑备份仓储测试：只验证 SQL 层的契约（白名单 / 分块游标 / GC / 信封字段）。
 *
 * 用真实 SQLite + 真实迁移建库，不 mock 数据库（唯一门禁口径）。
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
import {
  LOGICAL_BACKUP_CHUNK_ROWS,
  LogicalBackupRepository,
  type BackupJobRow,
  type BackupRow,
} from '../src/repositories/logical-backup.repository';

const noopBackupPort: BackupPort = {
  mode: 'filesystem',
  keepCount: 5,
  create: async () => ({ status: 'skipped', reason: 'test' }),
  list: () => [],
};

let dir: string;
let db: Db;
let repo: LogicalBackupRepository;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'stockin-lbrepo-'));
  db = openDatabase({
    filename: path.join(dir, 'test.db'),
  });
  const dataDir = path.join(dir, 'data');
  await runMigrations({
    db,
    migrations: createFilesystemMigrationSource(),
    versionStore: createPragmaVersionStore({ dataDir }),
    backup: noopBackupPort,
    initState: 1,
  });
  repo = new LogicalBackupRepository(db);
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

function makeJob(id: string): BackupJobRow {
  return {
    id,
    kind: 'logical',
    status: 'pending',
    cursor_table: null,
    cursor_rowid: null,
    chunk_seq: 0,
    total_chunks: null,
    error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    finished_at: null,
  };
}

function makeBackup(id: string, jobId: string): BackupRow {
  return {
    id,
    job_id: jobId,
    format_version: 1,
    schema_version: 4,
    key_id: 'key-1',
    ephemeral_public_key: 'eph-pub',
    kdf_salt: 'salt',
    wrapped_key_iv: 'iv',
    wrapped_key_ciphertext: 'cipher',
    wrapped_key_tag: 'tag',
    created_at: new Date().toISOString(),
    chunk_count: 0,
    plain_bytes: 0,
    manifest_sha256: null,
    status: 'building',
  };
}

describe('LogicalBackupRepository', () => {
  it('listTables 排除备份表与会话表', () => {
    const tables = repo.listTables();
    expect(tables).toContain('records');
    expect(tables).toContain('settings');
    expect(tables).toContain('credentials');
    expect(tables).not.toContain('sessions');
    expect(tables).not.toContain('admin_sessions');
    expect(tables).not.toContain('backup_jobs');
    expect(tables).not.toContain('backups');
    expect(tables).not.toContain('backup_chunks');
    expect(tables).not.toContain('sqlite_sequence');
  });

  it('readRows 按 rowid 分块推进，且不越过 limit', () => {
    for (let i = 0; i < LOGICAL_BACKUP_CHUNK_ROWS + 5; i += 1) {
      db.prepare(
        `INSERT INTO records (name, name_norm, purchase_date, spec_norm, created_at, updated_at)
         VALUES (?, ?, '2026-01-01', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      ).run(`商品${i}`, `商品${i}`);
    }
    const first = repo.readRows('records', 0);
    expect(first).toHaveLength(LOGICAL_BACKUP_CHUNK_ROWS);
    expect(first[0]?.rowid).toBeGreaterThan(0);
    const lastRowid = first[first.length - 1]?.rowid ?? 0;
    const second = repo.readRows('records', lastRowid);
    expect(second).toHaveLength(5);
    expect(second[0]?.rowid).toBeGreaterThan(lastRowid);
  });

  it('listColumns / readRows 拒绝白名单外的表名（SQL 注入防护）', () => {
    expect(() => repo.listColumns('backup_chunks')).toThrow(/非法表名/);
    expect(() => repo.listColumns("records'; DROP TABLE records; --")).toThrow(/非法表名/);
    expect(() => repo.readRows('sessions', 0)).toThrow(/非法表名/);
  });

  it('信封字段（含 kdf_salt）可被完整读回，wrap 解封所需材料不丢', () => {
    repo.createJob(makeJob('job-1'));
    repo.createBackup(makeBackup('bk-1', 'job-1'));
    const row = repo.getBackup('bk-1');
    expect(row).toBeDefined();
    expect(row?.kdf_salt).toBe('salt');
    expect(row?.ephemeral_public_key).toBe('eph-pub');
    expect(row?.wrapped_key_ciphertext).toBe('cipher');
    expect(row?.status).toBe('building');
  });

  it('job 状态机与 chunk 写入、manifest 落库', () => {
    repo.createJob(makeJob('job-2'));
    repo.createBackup(makeBackup('bk-2', 'job-2'));
    expect(repo.hasActiveJob()).toBe(true);
    expect(repo.nextRunnableJob()?.id).toBe('job-2');

    repo.updateJobCursor('job-2', 'records', 10, 1, 3);
    repo.insertChunk({
      backup_id: 'bk-2',
      seq: 1,
      table_name: 'records',
      row_start: 0,
      row_count: 10,
      iv: 'iv',
      ciphertext: 'cipher',
      tag: 'tag',
      plain_bytes: 512,
      sha256: 'hash1',
    });
    expect(repo.listChunks('bk-2')).toHaveLength(1);
    repo.updateBackupProgress('bk-2', 1, 512);
    repo.setManifest('bk-2', 'manifest-hash');
    repo.markBackupReady('bk-2');
    repo.finishJob('job-2', 'done', null);

    expect(repo.getBackup('bk-2')?.manifest_sha256).toBe('manifest-hash');
    expect(repo.getBackup('bk-2')?.status).toBe('ready');
    expect(repo.getJob('job-2')?.status).toBe('done');
    expect(repo.hasActiveJob()).toBe(false);
  });

  it('gcReady 仅保留最近 N 份 ready 备份，chunks 级联删除', () => {
    for (let i = 0; i < 6; i += 1) {
      const jobId = `gc-job-${i}`;
      const backupId = `gc-bk-${i}`;
      repo.createJob({ ...makeJob(jobId), created_at: `2026-01-0${i + 1}T00:00:00Z` });
      repo.createBackup({
        ...makeBackup(backupId, jobId),
        created_at: `2026-01-0${i + 1}T00:00:00Z`,
        status: 'ready',
      });
      repo.insertChunk({
        backup_id: backupId,
        seq: 1,
        table_name: 'records',
        row_start: 0,
        row_count: 1,
        iv: 'iv',
        ciphertext: 'cipher',
        tag: 'tag',
        plain_bytes: 10,
        sha256: 'h',
      });
    }
    expect(repo.listReady()).toHaveLength(6);
    repo.gcReady(5);
    const ready = repo.listReady();
    expect(ready).toHaveLength(5);
    // 最旧的那份（gc-bk-0）应被删除，其 chunks 级联删除。
    expect(repo.getBackup('gc-bk-0')).toBeUndefined();
    expect(repo.listChunks('gc-bk-0')).toHaveLength(0);
  });
});
