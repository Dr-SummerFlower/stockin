/**
 * 恢复服务测试：本地签名票据 → 分块上传 → 验签 → 全量恢复 → 防重放。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/runtime/node/db.factory';
import { closeDatabase, type Db } from '../src/repositories/db';
import { createPragmaVersionStore } from '../src/runtime/node/version-store.pragma';
import { createFilesystemMigrationSource } from '../src/runtime/node/migration-source.filesystem';
import { runMigrations } from '../src/repositories/migrations/runner';
import type { BackupPort } from '../src/runtime/ports';
import { loadEnv, type Env } from '../src/env';
import { configureServerTimeZone, serverToday } from '../src/lib/today';
import { MetaRepository } from '../src/repositories/meta.repository';
import { OperationLogRepository } from '../src/repositories/operation-log.repository';
import { BackupKeyRepository } from '../src/repositories/backup-key.repository';
import { createFilesystemRestoreStaging } from '../src/runtime/node/restore-staging.filesystem';
import { RestoreService } from '../src/services/restore.service';
import { seedDefaultBackupKey } from '../src/services/backup-key.service';
import type { BackupService } from '../src/services/backup.service';
import { generateBackupKeyPair, signRestoreTicket } from '../src/lib/backup-crypto';
import {
  BACKUP_WIRE_VERSION,
  encodeTicketPayload,
  ensureAllRestoreTables,
  restoreDataDigest,
  type RestoreTable,
  type RestoreTicket,
} from '../src/lib/backup-format';
import { SCHEMA_EXPECTED } from '../src/repositories/schema';
import {
  RESTORE_TABLES,
  LOGICAL_BACKUP_FORMAT_VERSION,
  requiredRestoreTables,
} from '../src/repositories/restore.repository';
import { createTestBackupKeys, createTestStats } from './support/harness';

const noopBackupPort: BackupPort = {
  mode: 'filesystem',
  keepCount: 5,
  create: async () => ({ status: 'skipped', reason: 'test' }),
  list: () => [],
};

let dir: string;
let db: Db;
let env: Env;
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
  // 首次播种：验签只读库内公钥，env 不再参与。
  await seedDefaultBackupKey(db, new BackupKeyRepository(db), keyPair.publicKey);
  env = loadEnv({
    cwd: dir,
    dataDir,
    backupDir: path.join(dir, 'backups'),
    tmpDir: path.join(dir, 'tmp'),
  });
  service = new RestoreService({
    db,
    env,
    staging: createFilesystemRestoreStaging({ tmpDir: env.tmpDir }),
    meta: new MetaRepository(db),
    logs: new OperationLogRepository(db),
    stats: createTestStats(db),
    keys: createTestBackupKeys(db),
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
  const filledTables: RestoreTable[] = [
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
      table: 'purchase_orders',
      columns: [
        'id',
        'order_no',
        'supplier',
        'supplier_norm',
        'purchase_date',
        'created_at',
        'updated_at',
      ],
      rows: [
        [
          1,
          '20260201001',
          '恢复供货商',
          '恢复供货商',
          '2026-02-01',
          '2026-02-01T00:00:00Z',
          '2026-02-01T00:00:00Z',
        ],
      ],
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
        'order_id',
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
          1,
          '2026-02-01T00:00:00Z',
          '2026-02-01T00:00:00Z',
        ],
      ],
    },
  ];
  // 模拟本地脚本产物：ensureAllRestoreTables 补齐零行表，覆盖该格式版本必需的全部表。
  const tables: RestoreTable[] = ensureAllRestoreTables(
    filledTables,
    requiredRestoreTables(LOGICAL_BACKUP_FORMAT_VERSION),
  );
  const lines: string[] = [
    JSON.stringify({
      kind: 'restore-meta',
      version: BACKUP_WIRE_VERSION,
      formatVersion: LOGICAL_BACKUP_FORMAT_VERSION,
      schemaVersion: SCHEMA_EXPECTED,
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
    schemaVersion: SCHEMA_EXPECTED,
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
    // 恢复包覆盖全部 7 张可恢复表（含补齐的空表），其中 3 张非空共 3 行。
    expect(result.data?.restoredTables).toBe(RESTORE_TABLES.length);
    expect(result.data?.restoredRows).toBe(3);

    // 验证数据已被替换。
    const records = db.prepare('SELECT name, order_id FROM records ORDER BY id').all() as {
      name: string;
      order_id: number | null;
    }[];
    expect(records).toHaveLength(1);
    expect(records[0]?.name).toBe('恢复商品A');
    // v2 包必须把单据↔明细的关联一起回填（06-P2-16）。
    expect(records[0]?.order_id).toBe(1);
    const order = db.prepare('SELECT id, order_no FROM purchase_orders WHERE id = 1').get() as
      | { id: number; order_no: string }
      | undefined;
    expect(order?.order_no).toBe('20260201001');
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

    // 全量恢复会摘掉统计触发器、回填后再一次性 rebuild；这里必须验证派生表
    // 与 aggregateSql 仍等价，且触发器确实被重新挂上（.tmp/待办 TODO-04）。
    const stats = createTestStats(db);
    const threshold: number = 45; // 与恢复包中 settings.expiry_threshold_days 一致
    expect(stats.matchesAggregate(serverToday(), threshold)).toBe(true);
    db.prepare(
      `INSERT INTO records
         (name, name_norm, purchase_date, expiry_date, spec_norm, unit_price, quantity,
          amount_cents, created_at, updated_at)
       VALUES ('恢复后新增', '恢复后新增', '2026-03-01', '2026-12-15', '', 100, 2, 500, ?, ?)`,
    ).run('2026-03-01T00:00:00Z', '2026-03-01T00:00:00Z');
    expect(stats.matchesAggregate(serverToday(), threshold)).toBe(true);
    expect(stats.metrics(serverToday(), threshold).totalRecords).toBe(2);
  });

  it('分块在行中间（含多字节字符）被切开时仍能正确解析', async () => {
    const begun = service.beginBatch();
    const { batchId, issuedAt } = begun.data!;
    const { lines, ticket } = await buildPackageAndTicket(batchId, issuedAt);
    const payload: Uint8Array = new TextEncoder().encode(`${lines.join('\n')}\n`);
    // 每 37 字节切一块：切点必然落在 JSON 行内部，且会切断中文的 3 字节序列，
    // 覆盖「流式解码 + 跨块拼接行」两条路径（旧实现靠整包拼接，不会暴露这里）。
    const STEP = 37;
    let seq = 0;
    for (let offset = 0; offset < payload.byteLength; offset += STEP) {
      const slice = payload.subarray(offset, Math.min(offset + STEP, payload.byteLength));
      const put = await service.putChunk(batchId, seq, slice);
      expect(put.ok).toBe(true);
      seq += 1;
    }
    expect(seq).toBeGreaterThan(lines.length);

    const result = await service.commit(batchId, ticket);
    expect(result.ok).toBe(true);
    expect(result.data?.restoredRows).toBe(3);
    expect(
      (db.prepare('SELECT shop_name FROM settings WHERE id = 1').get() as { shop_name: string })
        .shop_name,
    ).toBe('恢复后的店铺');
    // 消费标记存活 3 小时（远长于票据 30 分钟窗口），过期由 staging 惰性清理。
    const consumedFile = path.join(env.tmpDir, 'restore-staging', batchId, '.consumed');
    const expiresAt: number = Date.parse(readFileSync(consumedFile, 'utf8'));
    expect(expiresAt - Date.now()).toBeGreaterThan(3 * 60 * 60 * 1000 - 60_000);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(3 * 60 * 60 * 1000);
  });

  it('恢复包超过当前运行时字节上限时提前拒绝（避免 Workers OOM）', async () => {
    const staging = createFilesystemRestoreStaging({ tmpDir: path.join(dir, 'tmp-tiny') });
    const tiny = new RestoreService({
      db,
      env,
      staging,
      meta: new MetaRepository(db),
      logs: new OperationLogRepository(db),
      stats: createTestStats(db),
      keys: createTestBackupKeys(db),
      maxRestoreBytes: 64,
    });
    const begun = tiny.beginBatch();
    const { batchId, issuedAt } = begun.data!;
    const { lines, ticket } = await buildPackageAndTicket(batchId, issuedAt);
    for (let i = 0; i < lines.length; i += 1) {
      await tiny.putChunk(batchId, i, new TextEncoder().encode(`${lines[i]}\n`));
    }
    const result = await tiny.commit(batchId, ticket);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('BACKUP_RESTORE_FAILED');
    expect((result.details as { reason?: string }).reason).toContain('字节上限');
    // 超限发生在消费之前：批次未被烧掉，但明文分块必须立即清理，不能长期残留。
    expect(await staging.isConsumed(batchId)).toBe(false);
    expect(await staging.listChunkSeqs(batchId)).toEqual([]);
  });

  it('上传数据与票据摘要不符时拒绝恢复（签名仍有效）', async () => {
    const begun = service.beginBatch();
    const { batchId, issuedAt } = begun.data!;
    const { lines, ticket } = await buildPackageAndTicket(batchId, issuedAt);
    // 上传篡改后的数据，但票据签名保持不变：服务端重算摘要与票据不符即拒绝。
    const tamperedLines = lines.map((line) =>
      line.includes('恢复后的店铺') ? line.replace('恢复后的店铺', '被篡改') : line,
    );
    for (let i = 0; i < tamperedLines.length; i += 1) {
      await service.putChunk(batchId, i, new TextEncoder().encode(`${tamperedLines[i]}\n`));
    }
    const result = await service.commit(batchId, ticket);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('BACKUP_INVALID_TICKET');
    // 校验失败路径也要清理明文分块（旧实现直接 return，分块残留到人工清理）。
    expect(
      await createFilesystemRestoreStaging({ tmpDir: env.tmpDir }).listChunkSeqs(batchId),
    ).toEqual([]);
  });

  it('票据签名被篡改时拒绝恢复', async () => {
    const begun = service.beginBatch();
    const { batchId, issuedAt } = begun.data!;
    const { ticket } = await buildPackageAndTicket(batchId, issuedAt);
    const forged: RestoreTicket = { ...ticket, signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };
    const result = await service.commit(batchId, forged);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('BACKUP_INVALID_TICKET');
  });

  it('票据过期时返回 BACKUP_TICKET_EXPIRED', async () => {
    const begun = service.beginBatch();
    const { batchId } = begun.data!;
    const staleIssuedAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const { ticket } = await buildPackageAndTicket(batchId, staleIssuedAt);
    const result = await service.commit(batchId, ticket);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('BACKUP_TICKET_EXPIRED');
  });

  it('签发时间超前容忍窗口时拒绝（单向时间窗）', async () => {
    const begun = service.beginBatch();
    const { batchId } = begun.data!;
    const futureIssuedAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const { ticket } = await buildPackageAndTicket(batchId, futureIssuedAt);
    const result = await service.commit(batchId, ticket);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('BACKUP_TICKET_EXPIRED');
  });

  it('分块序号不连续时明确拒绝', async () => {
    const begun = service.beginBatch();
    const { batchId, issuedAt } = begun.data!;
    const { lines, ticket } = await buildPackageAndTicket(batchId, issuedAt);
    // 故意跳过 seq=0，从 seq=1 开始上传。
    for (let i = 0; i < lines.length; i += 1) {
      await service.putChunk(batchId, i + 1, new TextEncoder().encode(`${lines[i]}\n`));
    }
    const result = await service.commit(batchId, ticket);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('BACKUP_RESTORE_FAILED');
    expect(String(result.details?.reason)).toMatch(/序号不连续/);
  });

  it('票据 schema 版本高于当前程序时返回 BACKUP_RESTORE_FAILED', async () => {
    const begun = service.beginBatch();
    const { batchId, issuedAt } = begun.data!;
    const { ticket } = await buildPackageAndTicket(batchId, issuedAt);
    const mismatched: RestoreTicket = {
      ...ticket,
      payload: { ...ticket.payload, schemaVersion: SCHEMA_EXPECTED + 1 },
    };
    // schema 不匹配发生在验签之后，需要重新签名使验签通过，才能触达 schema 分支。
    mismatched.signature = await signRestoreTicket(
      keyPair.privateKey,
      encodeTicketPayload(mismatched.payload),
    );
    const result = await service.commit(batchId, mismatched);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('BACKUP_RESTORE_FAILED');
    expect(String(result.details?.reason)).toMatch(/schema/);
  });

  it('升级前导出的 v1 旧包（schema 低一版、无 purchase_orders）仍能恢复', async () => {
    // 升级前的老包：6 张表、没有单据表、restore-meta 里也没有 formatVersion。
    // 硬编码升级前的 6 表清单：不调用 requiredRestoreTables，避免实现有误时夹具跟着错（06-P2-20）。
    const LEGACY_TABLE_NAMES: readonly string[] = [
      'credentials',
      'settings',
      'records',
      'operation_logs',
      'meta',
      'admin_accounts',
    ];
    const legacyTables: RestoreTable[] = ensureAllRestoreTables(
      [
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
              '旧包商品',
              '旧包商品',
              '2026-02-01',
              '',
              '2026-02-01T00:00:00Z',
              '2026-02-01T00:00:00Z',
            ],
          ],
        },
      ],
      LEGACY_TABLE_NAMES,
    );
    const dataSha256: string = await restoreDataDigest(legacyTables);
    const begun = service.beginBatch();
    const { batchId, issuedAt } = begun.data!;
    const lines: string[] = [
      JSON.stringify({
        kind: 'restore-meta',
        version: BACKUP_WIRE_VERSION,
        schemaVersion: SCHEMA_EXPECTED - 1,
        keyId: keyPair.keyId,
        dataSha256,
      }),
      ...legacyTables.map((table) => JSON.stringify(table)),
    ];
    for (let i = 0; i < lines.length; i += 2) {
      const put = await service.putChunk(
        batchId,
        i / 2,
        new TextEncoder().encode(`${lines.slice(i, i + 2).join('\n')}\n`),
      );
      expect(put.ok).toBe(true);
    }
    const payload = {
      v: BACKUP_WIRE_VERSION,
      batchId,
      issuedAt,
      dataSha256,
      schemaVersion: SCHEMA_EXPECTED - 1,
      keyId: keyPair.keyId,
    };
    const ticket: RestoreTicket = {
      payload,
      signature: await signRestoreTicket(keyPair.privateKey, encodeTicketPayload(payload)),
    };

    const result = await service.commit(batchId, ticket);
    expect(result.ok).toBe(true);
    const records = db.prepare('SELECT name, order_id FROM records').all() as {
      name: string;
      order_id: number | null;
    }[];
    expect(records).toHaveLength(1);
    expect(records[0]?.name).toBe('旧包商品');
    // 单据表按空表处理，历史记录全部是散记。
    expect(records[0]?.order_id).toBeNull();
    const orders = db.prepare('SELECT COUNT(*) AS c FROM purchase_orders').get() as { c: number };
    expect(orders.c).toBe(0);
  });

  it('恢复包未覆盖全部可恢复表时被拒绝（服务端强制防半恢复）', async () => {
    const begun = service.beginBatch();
    const { batchId, issuedAt } = begun.data!;
    // 故意只给一张表：正常脚本会补齐，这里模拟私钥持有者构造的缺表包。
    const partial: RestoreTable[] = [
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
        rows: [[1, 45, '部分恢复', 7, 30]],
      },
    ];
    const dataSha256: string = await restoreDataDigest(partial);
    const payload = {
      v: BACKUP_WIRE_VERSION,
      batchId,
      issuedAt,
      dataSha256,
      schemaVersion: SCHEMA_EXPECTED,
      keyId: keyPair.keyId,
    };
    const ticket: RestoreTicket = {
      payload,
      signature: await signRestoreTicket(keyPair.privateKey, encodeTicketPayload(payload)),
    };
    // 先写入一条记录，确认恢复被拒后数据未被清空（无半恢复）。
    db.prepare(
      `INSERT INTO records (name, name_norm, purchase_date, spec_norm, created_at, updated_at)
       VALUES ('应保留', '应保留', '2026-01-01', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run();
    const lines = [
      JSON.stringify({
        kind: 'restore-meta',
        version: BACKUP_WIRE_VERSION,
        schemaVersion: SCHEMA_EXPECTED,
        keyId: keyPair.keyId,
        dataSha256,
      }),
      ...partial.map((t) => JSON.stringify(t)),
    ];
    for (let i = 0; i < lines.length; i += 1) {
      await service.putChunk(batchId, i, new TextEncoder().encode(`${lines[i]}\n`));
    }
    const result = await service.commit(batchId, ticket);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('BACKUP_RESTORE_FAILED');
    expect(String(result.details?.reason)).toMatch(/缺少.*表/);
    const names = db.prepare('SELECT name FROM records').all() as { name: string }[];
    expect(names.map((n) => n.name)).toEqual(['应保留']);
  });

  it('恢复中途失败时整事务回滚，业务表与会话保持原状（§F）', async () => {
    // 先塞入原始数据与会话，作为回滚后的比对基线。
    db.prepare(
      `INSERT INTO records (name, name_norm, purchase_date, spec_norm, created_at, updated_at)
       VALUES ('原始商品', '原始商品', '2026-01-01', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare("UPDATE settings SET shop_name = '原始店铺' WHERE id = 1").run();
    db.prepare(
      `INSERT INTO credentials (id, username, password_hash, salt, scrypt_params, created_at, updated_at)
       VALUES (1, 'admin', 'h', 's', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, token_hash, account_id, idle_expires_at, absolute_expires_at, auth_epoch, created_at, last_seen_at)
       VALUES ('s-rollback', 'h', 1, '2027-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run();

    const begun = service.beginBatch();
    const { batchId, issuedAt } = begun.data!;
    // settings 给合法新值（回填时先执行），records 用非法列名让回填中途抛错。
    const base: RestoreTable[] = [
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
        rows: [[1, 45, '应被回滚的店铺', 7, 30]],
      },
      {
        kind: 'table',
        table: 'records',
        columns: ['id', 'bad column name'],
        rows: [[1, '非法']],
      },
    ];
    const tables: RestoreTable[] = ensureAllRestoreTables(base, RESTORE_TABLES);
    const dataSha256: string = await restoreDataDigest(tables);
    const payload = {
      v: BACKUP_WIRE_VERSION,
      batchId,
      issuedAt,
      dataSha256,
      schemaVersion: SCHEMA_EXPECTED,
      keyId: keyPair.keyId,
    };
    const ticket: RestoreTicket = {
      payload,
      signature: await signRestoreTicket(keyPair.privateKey, encodeTicketPayload(payload)),
    };
    const lines = [
      JSON.stringify({
        kind: 'restore-meta',
        version: BACKUP_WIRE_VERSION,
        schemaVersion: SCHEMA_EXPECTED,
        keyId: keyPair.keyId,
        dataSha256,
      }),
      ...tables.map((t) => JSON.stringify(t)),
    ];
    for (let i = 0; i < lines.length; i += 1) {
      await service.putChunk(batchId, i, new TextEncoder().encode(`${lines[i]}\n`));
    }

    const result = await service.commit(batchId, ticket);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('BACKUP_RESTORE_FAILED');

    // 整事务回滚：原始业务数据、settings、会话都应保持不变。
    const names = db.prepare('SELECT name FROM records ORDER BY id').all() as { name: string }[];
    expect(names.map((n) => n.name)).toEqual(['原始商品']);
    const shop = db.prepare('SELECT shop_name FROM settings WHERE id = 1').get() as {
      shop_name: string;
    };
    expect(shop.shop_name).toBe('原始店铺');
    expect((db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c).toBe(1);
  });

  it('恢复包格式版本高于当前程序时拒绝', async () => {
    const begun = service.beginBatch();
    const { batchId, issuedAt } = begun.data!;
    const { lines, ticket } = await buildPackageAndTicket(batchId, issuedAt);
    // 只改包的 meta 行（数据行与票据摘要不变）：读取阶段的上界校验先于摘要比对。
    const futureLines: string[] = lines.map((line: string): string => {
      const parsed: unknown = JSON.parse(line);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { kind?: string }).kind === 'restore-meta'
      ) {
        return JSON.stringify({
          ...parsed,
          formatVersion: LOGICAL_BACKUP_FORMAT_VERSION + 1,
        });
      }
      return line;
    });
    for (let i = 0; i < futureLines.length; i += 1) {
      await service.putChunk(batchId, i, new TextEncoder().encode(`${futureLines[i]}\n`));
    }
    const result = await service.commit(batchId, ticket);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('BACKUP_RESTORE_FAILED');
    expect(String(result.details?.reason)).toMatch(/格式版本/);
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

describe('恢复前物理快照校验（§4）与审计署名（§7）', () => {
  /** 构造一个带可控物理备份 spy 的 RestoreService（其余依赖沿用真实实例）。 */
  function withBackupSpy(
    mode: 'filesystem' | 'pitr',
    status: 'ok' | 'skipped',
  ): { service: RestoreService; calls: string[] } {
    const calls: string[] = [];
    const spy = {
      mode,
      async backupWithoutGate(_reason: string, _requestId: string, actor: string) {
        calls.push(`snapshot:${_reason}:${actor}`);
        return { ok: true, data: { status, meta: null } };
      },
    } as unknown as BackupService;
    const env = loadEnv({
      cwd: dir,
      dataDir: path.join(dir, 'data'),
      backupDir: path.join(dir, 'backups'),
      tmpDir: path.join(dir, 'tmp'),
    });
    return {
      calls,
      service: new RestoreService({
        db,
        env,
        staging: createFilesystemRestoreStaging({ tmpDir: env.tmpDir }),
        meta: new MetaRepository(db),
        logs: new OperationLogRepository(db),
        stats: createTestStats(db),
        keys: createTestBackupKeys(db),
        physicalBackup: spy,
      }),
    };
  }

  /** 上传一份合法恢复包并返回 begin/ticket。 */
  async function seed(svc: RestoreService): Promise<{ batchId: string; ticket: RestoreTicket }> {
    const begun = svc.beginBatch();
    const { batchId, issuedAt } = begun.data!;
    const { lines, ticket } = await buildPackageAndTicket(batchId, issuedAt);
    for (let i = 0; i < lines.length; i += 1) {
      await svc.putChunk(batchId, i, new TextEncoder().encode(`${lines[i]}\n`));
    }
    return { batchId, ticket };
  }

  it('filesystem 模式快照 skipped 时中止恢复，数据保持不变', async () => {
    // 先写入一条会被恢复覆盖的数据，用于确认恢复未执行。
    db.prepare(
      `INSERT INTO records (name, name_norm, purchase_date, spec_norm, created_at, updated_at)
       VALUES ('原始商品', '原始商品', '2026-01-01', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run();
    const { service: svc, calls } = withBackupSpy('filesystem', 'skipped');
    const { batchId, ticket } = await seed(svc);
    const result = await svc.commit(batchId, ticket, 'admin:alice');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('BACKUP_RESTORE_FAILED');
    expect(String(result.details?.reason)).toMatch(/快照/);
    expect(calls).toEqual(['snapshot:pre-restore:admin:alice']);
    const names = db.prepare('SELECT name FROM records').all() as { name: string }[];
    expect(names.map((n) => n.name)).toEqual(['原始商品']);
  });

  it('pitr 模式以平台 PITR 为回滚点，快照 skipped 仍继续恢复', async () => {
    const { service: svc, calls } = withBackupSpy('pitr', 'skipped');
    const { batchId, ticket } = await seed(svc);
    const result = await svc.commit(batchId, ticket, 'admin:bob');
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['snapshot:pre-restore:admin:bob']);
    const logs = db
      .prepare("SELECT actor FROM operation_logs WHERE action = 'BACKUP_RESTORE'")
      .all() as {
      actor: string;
    }[];
    expect(logs[0]?.actor).toBe('admin:bob');
  });

  it('filesystem 模式快照成功时执行恢复并按传入 actor 记审计', async () => {
    const { service: svc, calls } = withBackupSpy('filesystem', 'ok');
    const { batchId, ticket } = await seed(svc);
    const result = await svc.commit(batchId, ticket, 'admin:carol');
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['snapshot:pre-restore:admin:carol']);
    const logs = db
      .prepare("SELECT actor FROM operation_logs WHERE action = 'BACKUP_RESTORE'")
      .all() as {
      actor: string;
    }[];
    expect(logs.some((row) => row.actor === 'admin:carol')).toBe(true);
  });
});
