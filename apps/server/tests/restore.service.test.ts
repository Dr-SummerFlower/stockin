/**
 * 恢复服务测试：本地签名票据 → 分块上传 → 验签 → 全量恢复 → 防重放。
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
import { loadEnv } from '../src/env';
import { configureServerTimeZone } from '../src/lib/today';
import { MetaRepository } from '../src/repositories/meta.repository';
import { OperationLogRepository } from '../src/repositories/operation-log.repository';
import { createFilesystemRestoreStaging } from '../src/runtime/node/restore-staging.filesystem';
import { RestoreService } from '../src/services/restore.service';
import { generateBackupKeyPair, signRestoreTicket } from '../src/lib/backup-crypto';
import {
  BACKUP_WIRE_VERSION,
  encodeTicketPayload,
  restoreDataDigest,
  type RestoreTable,
  type RestoreTicket,
} from '../src/lib/backup-format';

const noopBackupPort: BackupPort = {
  mode: 'filesystem',
  keepCount: 5,
  create: async () => ({ status: 'skipped', reason: 'test' }),
  list: () => [],
};

let dir: string;
let db: Db;
let keyPair: Awaited<ReturnType<typeof generateBackupKeyPair>>;
let service: RestoreService;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'stockin-restore-'));
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
  service = new RestoreService({
    db,
    env,
    staging: createFilesystemRestoreStaging({ tmpDir: env.tmpDir }),
    meta: new MetaRepository(db),
    logs: new OperationLogRepository(db),
  });
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

/** 构造一个合法的恢复包 + 票据（模拟本地脚本产物）。 */
async function buildPackageAndTicket(
  batchId: string,
  issuedAt: string,
): Promise<{
  lines: string[];
  ticket: RestoreTicket;
}> {
  const tables: RestoreTable[] = [
    {
      kind: 'table',
      table: 'settings',
      columns: [
        'id',
        'expiry_threshold_days',
        'shop_name',
        'logical_backup_interval_days',
        'physical_backup_interval_days',
      ],
      rows: [[1, 45, '恢复后的店铺', 7, 30]],
    },
    {
      kind: 'table',
      table: 'records',
      columns: [
        'id',
        'name',
        'name_norm',
        'purchase_date',
        'spec_norm',
        'created_at',
        'updated_at',
      ],
      rows: [
        [
          1,
          '恢复商品A',
          '恢复商品a',
          '2026-02-01',
          '',
          '2026-02-01T00:00:00Z',
          '2026-02-01T00:00:00Z',
        ],
      ],
    },
  ];
  const lines: string[] = [
    JSON.stringify({
      kind: 'restore-meta',
      version: BACKUP_WIRE_VERSION,
      schemaVersion: 4,
      keyId: keyPair.keyId,
      dataSha256: await restoreDataDigest(tables),
    }),
    ...tables.map((t) => JSON.stringify(t)),
  ];
  const dataSha256: string = await restoreDataDigest(tables);
  const payload = {
    v: BACKUP_WIRE_VERSION,
    batchId,
    issuedAt,
    dataSha256,
    schemaVersion: 4,
    keyId: keyPair.keyId,
  };
  const signature: string = await signRestoreTicket(
    keyPair.privateKey,
    encodeTicketPayload(payload),
  );
  return { lines, ticket: { payload, signature } };
}

describe('RestoreService', () => {
  it('完整恢复：验签通过 → 数据回填 → 会话清空', async () => {
    // 先塞入一条待被覆盖的记录、一个凭据与一个会话。
    db.prepare(
      `INSERT INTO credentials (id, username, password_hash, salt, scrypt_params, created_at, updated_at)
       VALUES (1, 'admin', 'h', 's', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO records (name, name_norm, purchase_date, spec_norm, created_at, updated_at)
       VALUES ('旧商品', '旧商品', '2026-01-01', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, token_hash, account_id, idle_expires_at, absolute_expires_at, auth_epoch, created_at, last_seen_at)
       VALUES ('s1', 'h1', 1, '2027-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run();
    expect((db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c).toBe(1);

    const begun = service.beginBatch();
    expect(begun.ok).toBe(true);
    const { batchId, issuedAt } = begun.data!;
    const { lines, ticket } = await buildPackageAndTicket(batchId, issuedAt);

    // 模拟浏览器按 2 行一块上传。
    for (let i = 0; i < lines.length; i += 2) {
      const chunk = `${lines.slice(i, i + 2).join('\n')}\n`;
      const put = await service.putChunk(batchId, i / 2, new TextEncoder().encode(chunk));
      expect(put.ok).toBe(true);
    }

    const result = await service.commit(batchId, ticket);
    expect(result.ok).toBe(true);
    expect(result.data?.restoredTables).toBe(2);
    expect(result.data?.restoredRows).toBe(2);

    // 验证数据已被替换。
    const records = db.prepare('SELECT name FROM records ORDER BY id').all() as { name: string }[];
    expect(records).toHaveLength(1);
    expect(records[0]?.name).toBe('恢复商品A');
    const shop = db
      .prepare('SELECT shop_name, expiry_threshold_days FROM settings WHERE id = 1')
      .get() as {
      shop_name: string;
      expiry_threshold_days: number;
    };
    expect(shop.shop_name).toBe('恢复后的店铺');
    expect(shop.expiry_threshold_days).toBe(45);
    // 会话被清空。
    expect((db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c).toBe(0);
  });

  it('票据被篡改（batchId 不符）时拒绝恢复', async () => {
    const begun = service.beginBatch();
    const { batchId, issuedAt } = begun.data!;
    const { ticket } = await buildPackageAndTicket(batchId, issuedAt);
    const forged: RestoreTicket = {
      ...ticket,
      payload: { ...ticket.payload, dataSha256: 'deadbeef' },
    };
    const result = await service.commit(batchId, forged);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('BACKUP_INVALID_TICKET');
  });

  it('同一 batchId 不能重复恢复（防重放）', async () => {
    const begun = service.beginBatch();
    const { batchId, issuedAt } = begun.data!;
    const { lines, ticket } = await buildPackageAndTicket(batchId, issuedAt);
    for (let i = 0; i < lines.length; i += 1) {
      await service.putChunk(batchId, i, new TextEncoder().encode(`${lines[i]}\n`));
    }
    const first = await service.commit(batchId, ticket);
    expect(first.ok).toBe(true);
    const second = await service.commit(batchId, ticket);
    expect(second.ok).toBe(false);
    expect(second.code).toBe('BACKUP_RESTORE_CONFLICT');
  });
});
