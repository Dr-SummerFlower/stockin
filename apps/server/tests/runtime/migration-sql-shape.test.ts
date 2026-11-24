/**
 * 迁移脚本「可执行形态」回归：末条语句之后只能有空白。
 *
 * 背景（2026-11-24，pre 预览 1101）：workerd 把整段 SQL 切分成语句逐条
 * prepare，末条语句之后若还残留非空内容（典型是 `SELECT 1; -- 说明` 的行尾
 * 注释），切出来的那一段没有语句，直接抛
 * `Error: SQL code did not contain a statement.` —— 于是 bootstrap 阶段
 * 迁移失败、Durable Object 每次请求都 1101。
 *
 * Node 的 `db.exec()` 对行尾注释完全宽容，所以这条约束只能在测试里钉死：
 * 每个迁移脚本（文件系统源与内联源）在「列不存在」与「列已存在」两个分支下，
 * 生成的 SQL 都必须以语句结尾。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/runtime/node/db.factory';
import { closeDatabase, type Db } from '../../src/repositories/db';
import { createPragmaVersionStore } from '../../src/runtime/node/version-store.pragma';
import { createFilesystemMigrationSource } from '../../src/runtime/node/migration-source.filesystem';
import { createInlineMigrationSource } from '../../src/runtime/workers/migration-source.inline';
import {
  hasStatementOnlyTail,
  makeAddColumnsIdempotent,
  renderMigrationSql,
  runMigrations,
  type MigrationFile,
} from '../../src/repositories/migrations/runner';
import type { BackupPort, MigrationSource } from '../../src/runtime/ports';

const noopBackupPort: BackupPort = {
  mode: 'filesystem',
  keepCount: 5,
  create: async () => ({ status: 'skipped', reason: 'test' }),
  list: () => [],
};

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'stockin-sqlshape-'));
  db = openDatabase({ filename: path.join(dir, 'test.db') });
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

/** 按运行期同样的管线生成最终 SQL：read → render → 幂等化。 */
function finalSql(source: MigrationSource, file: MigrationFile): string {
  return makeAddColumnsIdempotent(db, renderMigrationSql(source.read(file), file.version));
}

describe('迁移脚本末条语句之后只能有空白', () => {
  it('全新空库（列不存在）时每个脚本都以语句结尾', () => {
    for (const source of [createFilesystemMigrationSource(), createInlineMigrationSource()]) {
      for (const file of source.discover()) {
        const sql: string = finalSql(source, file);
        expect(hasStatementOnlyTail(sql), `${source.kind}:${file.filename}`).toBe(true);
      }
    }
  });

  it('全量迁移后（列已存在）每个脚本仍以语句结尾', async () => {
    await runMigrations({
      db,
      migrations: createFilesystemMigrationSource(),
      versionStore: createPragmaVersionStore({ dataDir: path.join(dir, 'data') }),
      backup: noopBackupPort,
      initState: 1,
    });

    for (const source of [createFilesystemMigrationSource(), createInlineMigrationSource()]) {
      for (const file of source.discover()) {
        const sql: string = finalSql(source, file);
        expect(hasStatementOnlyTail(sql), `${source.kind}:${file.filename}`).toBe(true);
      }
    }
  });

  it('幂等补列的注释独占一行，语句在最后一行', () => {
    // 004 已建好 backups.kdf_salt，再跑 005 时走幂等分支。
    db.exec("CREATE TABLE backups (id TEXT PRIMARY KEY, kdf_salt TEXT NOT NULL DEFAULT '')");
    const source = createInlineMigrationSource();
    const file: MigrationFile = {
      version: 5,
      filename: '005_logical_backup_kdf_salt.sql',
      fullPath: '',
    };
    const sql: string = finalSql(source, file);
    expect(sql).toMatch(/^\s*-- 幂等补列：backups\.kdf_salt 已存在，跳过 ALTER\n\s*SELECT 1;$/m);
  });

  it('内联源与文件源只差 `PRAGMA user_version` 一行', () => {
    const fsSource = createFilesystemMigrationSource();
    const inlineSource = createInlineMigrationSource();
    const inlineFiles = inlineSource.discover();
    for (const file of fsSource.discover()) {
      const inlineFile: MigrationFile | undefined = inlineFiles.find(
        (item) => item.filename === file.filename,
      );
      expect(inlineFile, file.filename).toBeDefined();
      // 内联源会剥掉 `PRAGMA user_version`（DO 上 SQLITE_AUTH），其余逐字节相同。
      const fsSql: string = finalSql(fsSource, file)
        .split('\n')
        .filter((line) => !/^\s*PRAGMA\s+user_version\s*=/i.test(line))
        .join('\n');
      expect(finalSql(inlineSource, inlineFile!)).toBe(fsSql);
    }
  });
});
