/**
 * 恢复链路 HTTP 端到端测试。
 *
 * 与本地脚本的浏览器流程一致：begin → 分块 PUT → commit。
 * 私钥只在测试进程（模拟本地脚本）中持有，服务端只收到公钥与签名票据。
 * 走真实 app + 真实 SQLite + 真实管理员会话，不 mock 业务层。
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_SESSION_COOKIE_NAME } from '@stockin/shared';
import { createHarness, type Harness } from '../support/harness';
import { hashSessionToken } from '../../src/lib/crypto';
import { utcAfterHoursIso, utcAfterMinutesIso, utcNowIso } from '../../src/lib/today';
import { generateBackupKeyPair, signRestoreTicket } from '../../src/lib/backup-crypto';
import {
  BACKUP_WIRE_VERSION,
  encodeTicketPayload,
  ensureAllRestoreTables,
  restoreDataDigest,
  type RestoreTable,
  type RestoreTicket,
} from '../../src/lib/backup-format';
import { SCHEMA_EXPECTED } from '../../src/repositories/schema';
import { RESTORE_TABLES } from '../../src/repositories/restore.repository';

const ADMIN_CONFIG = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  logins: 'owner,admin',
};

const CHUNK_BYTES = 64 * 1024;

describe('恢复链路 HTTP 端到端', () => {
  let h: Harness;
  let keyPair: Awaited<ReturnType<typeof generateBackupKeyPair>>;
  let adminCookie: string;

  beforeEach(async (): Promise<void> => {
    keyPair = await generateBackupKeyPair();
    h = await createHarness({ admin: ADMIN_CONFIG, backupPublicKey: keyPair.publicKey });
    await h.completeSetup('shopowner', 'owner-pass-123');
    const account = h.deps.repositories.adminAccounts.upsert('owner', 1001, 'Owner', utcNowIso());
    const token = `admin-token-${randomUUID()}`;
    adminCookie = `${ADMIN_SESSION_COOKIE_NAME}=${token}`;
    h.deps.repositories.adminSessions.create({
      id: randomUUID(),
      tokenHash: hashSessionToken(token),
      adminId: account.id,
      idleExpiresAt: utcAfterMinutesIso(30),
      absoluteExpiresAt: utcAfterHoursIso(12),
      createdAt: utcNowIso(),
    });
  });

  afterEach((): void => h?.close());

  const authed = (): { cookie: string } => ({ cookie: adminCookie });

  /** 构造恢复包与票据（票据绑定 begin 返回的批次号和签发时间）。 */
  async function buildPackage(
    batchId: string,
    issuedAt: string,
  ): Promise<{ bytes: Uint8Array; ticket: RestoreTicket }> {
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
        rows: [[1, 60, 'HTTP 恢复店铺', 7, 30]],
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
            'HTTP 恢复商品',
            'http 恢复商品',
            '2026-03-01',
            '',
            '2026-03-01T00:00:00Z',
            '2026-03-01T00:00:00Z',
          ],
        ],
      },
    ];
    // 模拟本地脚本产物：补齐零行表，覆盖全部可恢复表。
    const tables: RestoreTable[] = ensureAllRestoreTables(filledTables, RESTORE_TABLES);
    const dataSha256: string = await restoreDataDigest(tables);
    const lines: string[] = [
      JSON.stringify({
        kind: 'restore-meta',
        version: BACKUP_WIRE_VERSION,
        schemaVersion: SCHEMA_EXPECTED,
        keyId: keyPair.keyId,
        dataSha256,
      }),
      ...tables.map((table: RestoreTable): string => JSON.stringify(table)),
    ];
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
    return { bytes: new TextEncoder().encode(`${lines.join('\n')}\n`), ticket };
  }

  async function upload(batchId: string, bytes: Uint8Array): Promise<number> {
    let seq = 0;
    for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
      const res: Response = await h.request(`/api/admin/restore/${batchId}/chunk/${seq}`, {
        ...authed(),
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes.slice(offset, offset + CHUNK_BYTES),
      });
      expect(res.status).toBe(200);
      seq += 1;
    }
    return seq;
  }

  it('begin → 分块上传 → commit 全量恢复，并清空会话', async () => {
    const ownerSession: string = await h.login('owner-pass-123', 'shopowner');
    expect(
      (h.deps.db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c,
    ).toBeGreaterThan(0);

    const begun = await h.json<{ batchId: string; issuedAt: string; windowMs: number }>(
      '/api/admin/restore/begin',
      { ...authed(), method: 'POST' },
    );
    expect(begun.status).toBe(200);
    expect(begun.body.batchId).toMatch(/^rb-/);
    expect(begun.body.windowMs).toBe(30 * 60 * 1000);

    const { bytes, ticket } = await buildPackage(begun.body.batchId, begun.body.issuedAt);
    const chunks: number = await upload(begun.body.batchId, bytes);
    expect(chunks).toBeGreaterThan(0);

    const committed = await h.json<{ restoredTables: number; restoredRows: number }>(
      '/api/admin/restore/commit',
      { ...authed(), method: 'POST', json: { batchId: begun.body.batchId, ticket } },
    );
    expect(committed.status).toBe(200);
    expect(committed.body).toMatchObject({
      restoredTables: RESTORE_TABLES.length,
      restoredRows: 2,
    });

    const record = h.deps.db.prepare('SELECT name FROM records ORDER BY id').get() as {
      name: string;
    };
    expect(record.name).toBe('HTTP 恢复商品');
    const settings = h.deps.db
      .prepare('SELECT shop_name, expiry_threshold_days FROM settings WHERE id = 1')
      .get() as { shop_name: string; expiry_threshold_days: number };
    expect(settings).toMatchObject({ shop_name: 'HTTP 恢复店铺', expiry_threshold_days: 60 });
    expect((h.deps.db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c).toBe(
      0,
    );
    expect(
      (h.deps.db.prepare('SELECT COUNT(*) AS c FROM admin_sessions').get() as { c: number }).c,
    ).toBe(0);

    // 原店主会话立即失效（恢复清空会话）。
    const me = await h.json<{ authenticated: boolean }>('/api/auth/me', { cookie: ownerSession });
    expect(me.body.authenticated).toBe(false);
  });

  it('签名被篡改的票据被拒绝，且批次未被消费可重试', async () => {
    const begun = await h.json<{ batchId: string; issuedAt: string }>('/api/admin/restore/begin', {
      ...authed(),
      method: 'POST',
    });
    const { bytes, ticket } = await buildPackage(begun.body.batchId, begun.body.issuedAt);
    await upload(begun.body.batchId, bytes);

    const forged: RestoreTicket = { ...ticket, signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };
    const rejected = await h.json<{ code: string }>('/api/admin/restore/commit', {
      ...authed(),
      method: 'POST',
      json: { batchId: begun.body.batchId, ticket: forged },
    });
    expect(rejected.status).toBe(403);
    expect(rejected.body.code).toBe('BACKUP_INVALID_TICKET');

    const retried = await h.json('/api/admin/restore/commit', {
      ...authed(),
      method: 'POST',
      json: { batchId: begun.body.batchId, ticket },
    });
    expect(retried.status).toBe(200);
  });
});
