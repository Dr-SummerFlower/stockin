/**
 * 逻辑备份服务测试：异步分块状态机 + 加密闭环 + 解密还原。
 *
 * 走真实 SQLite、真实迁移、真实加密，不 mock 数据库。
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
import type { BackupPort, BackgroundTaskScheduler } from '../src/runtime/ports';
import { loadEnv } from '../src/env';
import { configureServerTimeZone } from '../src/lib/today';
import { MetaRepository } from '../src/repositories/meta.repository';
import { SettingsRepository } from '../src/repositories/settings.repository';
import { OperationLogRepository } from '../src/repositories/operation-log.repository';
import {
  LOGICAL_BACKUP_CHUNK_ROWS,
  LogicalBackupRepository,
} from '../src/repositories/logical-backup.repository';
import { LogicalBackupService } from '../src/services/logical-backup.service';
import {
  decryptBackupChunk,
  generateBackupKeyPair,
  unwrapBackupDataKey,
} from '../src/lib/backup-crypto';
import { chunkAad, parseBackupLine } from '../src/lib/backup-format';

const noopBackupPort: BackupPort = {
  mode: 'filesystem',
  keepCount: 5,
  create: async () => ({ status: 'skipped', reason: 'test' }),
  list: () => [],
};

/** 记录调度次数但不真正异步执行，测试里手动 tick 驱动。 */
class ManualScheduler implements BackgroundTaskScheduler {
  scheduled = 0;
  setTick(_fn: () => Promise<boolean>): void {
    // 测试手动驱动 tick，无需注册回调。
  }
  schedule(): void {
    this.scheduled += 1;
  }
}

let dir: string;
let db: Db;
let repo: LogicalBackupRepository;
let service: LogicalBackupService;
let keyPair: Awaited<ReturnType<typeof generateBackupKeyPair>>;
let scheduler: ManualScheduler;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'stockin-lbsvc-'));
  configureServerTimeZone('Asia/Shanghai');
  db = openDatabase({ filename: path.join(dir, 'test.db') });
  const dataDir = path.join(dir, 'data');
  await runMigrations({
    db,
    migrations: createFilesystemMigrationSource(),
    versionStore: createPragmaVersionStore({ dataDir }),
    backup: noopBackupPort,
    initState: 1,
  });
  keyPair = await generateBackupKeyPair();
  const env = loadEnv({
    cwd: dir,
    dataDir,
    backupDir: path.join(dir, 'backups'),
    tmpDir: path.join(dir, 'tmp'),
    backupPublicKey: keyPair.publicKey,
  });
  repo = new LogicalBackupRepository(db);
  scheduler = new ManualScheduler();
  service = new LogicalBackupService({
    db,
    env,
    repo,
    settings: new SettingsRepository(db),
    meta: new MetaRepository(db),
    logs: new OperationLogRepository(db),
    scheduler,
  });
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

function insertRecords(count: number): void {
  for (let i = 0; i < count; i += 1) {
    db.prepare(
      `INSERT INTO records (name, name_norm, purchase_date, spec_norm, created_at, updated_at)
       VALUES (?, ?, '2026-01-01', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run(`商品${i}`, `商品${i}`);
  }
}

describe('LogicalBackupService', () => {
  it('公钥未配置时禁止入队', async () => {
    const env = loadEnv({ cwd: dir, backupPublicKey: '' });
    const disabled = new LogicalBackupService({
      db,
      env,
      repo,
      settings: new SettingsRepository(db),
      meta: new MetaRepository(db),
      logs: new OperationLogRepository(db),
      scheduler,
    });
    expect(disabled.enabled).toBe(false);
    const result = await disabled.enqueue('test');
    expect(result.ok).toBe(false);
  });

  it('enqueue → 多次 tick → ready，且 chunk 可解密还原行数', async () => {
    const recordCount = LOGICAL_BACKUP_CHUNK_ROWS * 2 + 3;
    insertRecords(recordCount);

    const enq = await service.enqueue('manual-test');
    expect(enq.ok).toBe(true);
    expect(scheduler.scheduled).toBeGreaterThan(0);
    // 已有 active job 时再次入队应 BUSY。
    const dup = await service.enqueue('dup');
    expect(dup.ok).toBe(false);

    // 驱动直到无剩余工作（设一个上限防死循环）。
    for (let i = 0; i < 200; i += 1) {
      const more = await service.tick(2);
      if (!more) {
        break;
      }
    }

    const list = service.list();
    expect(list.ok).toBe(true);
    expect(list.data?.items).toHaveLength(1);
    const meta = list.data?.items[0];
    expect(meta?.manifestSha256).toBeTruthy();
    expect(meta?.chunkCount).toBeGreaterThan(0);
    expect(list.data?.activeJob).toBeNull();

    const download = service.buildDownload(meta!.id);
    expect(download.ok).toBe(true);
    const lines = download.data!.chunks.map((c) => JSON.stringify(c));
    const metaLine = JSON.stringify(download.data!.meta);
    const parsedMeta = parseBackupLine(metaLine);
    expect(parsedMeta.kind).toBe('meta');

    // 用本地私钥解封数据密钥，逐 chunk 解密，验证记录表总行数还原。
    const backupRow = repo.getBackup(meta!.id)!;
    const dataKey = await unwrapBackupDataKey(keyPair.privateKey, {
      keyId: backupRow.key_id,
      ephemeralPublicKey: backupRow.ephemeral_public_key,
      kdfSalt: backupRow.kdf_salt,
      iv: backupRow.wrapped_key_iv,
      ciphertext: backupRow.wrapped_key_ciphertext,
      tag: backupRow.wrapped_key_tag,
    });

    let restoredRecords = 0;
    for (const line of lines) {
      const chunk = parseBackupLine(line);
      if (chunk.kind !== 'chunk') {
        continue;
      }
      if (chunk.table !== 'records') {
        continue;
      }
      const plain = await decryptBackupChunk(
        dataKey,
        { iv: chunk.iv, ciphertext: chunk.ciphertext, tag: chunk.tag },
        chunkAad(meta!.id, chunk.seq, chunk.table),
      );
      const payload = JSON.parse(new TextDecoder().decode(plain)) as { rows: unknown[][] };
      restoredRecords += payload.rows.length;
    }
    expect(restoredRecords).toBe(recordCount);
  });
});
