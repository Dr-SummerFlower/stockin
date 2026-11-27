/**
 * 备份公钥管理（schema 6 引入，管理台维护，首次启动由 env 播种）。
 *
 * 钉三件事：
 *  ① 库内 `backup_keys` 是唯一真源：加密用启用中的那把，验签用库内全部；
 *  ② 首次播种只在库内为空时写入一条默认公钥，幂等且不覆盖后续面板改动；
 *  ③ 误操作防护：启用中的公钥不能删、非法公钥不能入库、重复公钥不能重复添加，
 *     且每次管理台变更都落一条 `BACKUP_KEY_UPDATE` 审计（播种本身不落）。
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
import { BackupKeyRepository } from '../src/repositories/backup-key.repository';
import { OperationLogRepository } from '../src/repositories/operation-log.repository';
import { BackupKeyService, seedDefaultBackupKey } from '../src/services/backup-key.service';
import { backupKeyId, generateBackupKeyPair } from '../src/lib/backup-crypto';
import type { BackupPort } from '../src/runtime/ports';

const noopBackupPort: BackupPort = {
  mode: 'filesystem',
  keepCount: 5,
  create: async () => ({ status: 'skipped', reason: 'test' }),
  list: () => [],
};

let dir: string;
let db: Db;
let logs: OperationLogRepository;
let repo: BackupKeyRepository;
let first: Awaited<ReturnType<typeof generateBackupKeyPair>>;
let fresh: Awaited<ReturnType<typeof generateBackupKeyPair>>;

function makeService(): BackupKeyService {
  return new BackupKeyService({ db, repo, logs });
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'stockin-keys-'));
  db = openDatabase({ filename: path.join(dir, 'test.db') });
  await runMigrations({
    db,
    migrations: createFilesystemMigrationSource(),
    versionStore: createPragmaVersionStore({ dataDir: path.join(dir, 'data') }),
    backup: noopBackupPort,
    initState: 1,
  });
  logs = new OperationLogRepository(db);
  repo = new BackupKeyRepository(db);
  first = await generateBackupKeyPair();
  fresh = await generateBackupKeyPair();
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

function auditCount(): number {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM operation_logs WHERE action = 'BACKUP_KEY_UPDATE'")
    .get() as { c: number };
  return row.c;
}

describe('首次播种', () => {
  it('库内为空时写入一条启用中的默认公钥，且不落管理台审计', async () => {
    const seeded = await seedDefaultBackupKey(db, repo, first.publicKey);
    expect(seeded).toBe(true);
    expect(repo.count()).toBe(1);
    expect(repo.findActive()?.public_key).toBe(first.publicKey);
    expect(auditCount()).toBe(0);
  });

  it('未提供默认公钥时不播种', async () => {
    expect(await seedDefaultBackupKey(db, repo, '')).toBe(false);
    expect(repo.count()).toBe(0);
  });

  it('幂等：库内已有公钥时不再播种，不覆盖管理台改动', async () => {
    await seedDefaultBackupKey(db, repo, first.publicKey);
    // 模拟管理台新增并切换加密公钥。
    const service = makeService();
    await service.add({ publicKey: fresh.publicKey, activate: true }, 'admin:a', 'r1');
    const before = service.activePublicKey();

    expect(await seedDefaultBackupKey(db, repo, first.publicKey)).toBe(false);
    expect(service.activePublicKey()).toBe(before);
    expect(repo.count()).toBe(2);
  });
});

describe('BackupKeyService', () => {
  it('完全没有公钥时不可用', () => {
    const service = makeService();
    expect(service.enabled).toBe(false);
    expect(service.activePublicKey()).toBe('');
    expect(service.verifyPublicKeys()).toEqual([]);
  });

  it('库里新增第一把公钥时自动接管加密，验签含全部库内公钥', async () => {
    const service = makeService();
    const added = await service.add(
      { publicKey: fresh.publicKey, label: '2026 轮换' },
      'admin:a',
      'r1',
    );
    expect(added.ok).toBe(true);
    expect(service.activePublicKey()).toBe(fresh.publicKey);
    expect(service.verifyPublicKeys()).toEqual([fresh.publicKey]);
    expect(added.data?.items.find((item) => item.source === 'database')?.label).toBe('2026 轮换');
    expect(auditCount()).toBe(1);
  });

  it('activate 为 false 时只入库不接管', async () => {
    const service = makeService();
    await seedDefaultBackupKey(db, repo, first.publicKey);
    await service.add({ publicKey: fresh.publicKey, activate: false }, 'admin:a', 'r1');
    expect(service.activePublicKey()).toBe(first.publicKey);
    expect(service.verifyPublicKeys()).toEqual([first.publicKey, fresh.publicKey]);
  });

  it('非法公钥（形似 base64 但不是 P-256）被拒，且不落库', async () => {
    const service = makeService();
    const bad = await service.add({ publicKey: 'A'.repeat(100) }, 'admin:a', 'r1');
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('BACKUP_KEY_INVALID');
    expect(service.list().data?.items).toHaveLength(0);
    expect(auditCount()).toBe(0);
  });

  it('同一把公钥不能重复添加', async () => {
    const service = makeService();
    await service.add({ publicKey: fresh.publicKey }, 'admin:a', 'r1');
    const again = await service.add({ publicKey: fresh.publicKey }, 'admin:a', 'r2');
    expect(again.ok).toBe(false);
    expect(again.code).toBe('VALID_FAILED');
    const keyId: string = await backupKeyId(fresh.publicKey);
    expect((again.details as { reason?: string }).reason).toContain(keyId);
  });

  it('切换加密公钥：只影响加密，验签集合仍含旧公钥', async () => {
    const service = makeService();
    const second = await generateBackupKeyPair();
    await service.add({ publicKey: fresh.publicKey, activate: true }, 'admin:a', 'r1');
    await service.add({ publicKey: second.publicKey, activate: false }, 'admin:a', 'r2');
    const keyId: string = await backupKeyId(second.publicKey);

    const activated = service.activate(keyId, 'admin:a', 'r3');
    expect(activated.ok).toBe(true);
    expect(service.activePublicKey()).toBe(second.publicKey);
    expect(service.verifyPublicKeys()).toContain(fresh.publicKey);
    expect(activated.data?.items.filter((item) => item.active)).toHaveLength(1);
  });

  it('启用中的公钥不能删除，其余可以（旧公钥无需全部保留）', async () => {
    const service = makeService();
    await seedDefaultBackupKey(db, repo, first.publicKey);
    const activeId: string = await backupKeyId(first.publicKey);

    // 当前启用中的那把不允许删。
    const blocked = service.remove(activeId, 'admin:a', 'r1');
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe('BACKUP_KEY_IN_USE');

    // 新增并切换后，原来的那把退为「仅验签」，此时可以删。
    await service.add({ publicKey: fresh.publicKey, activate: true }, 'admin:a', 'r2');
    const removed = service.remove(activeId, 'admin:a', 'r3');
    expect(removed.ok).toBe(true);
    // 删掉旧公钥只影响「用它签的票据」，备份能力不受影响。
    expect(service.verifyPublicKeys()).toEqual([fresh.publicKey]);
    expect(service.enabled).toBe(true);
  });

  it('删除不存在的 keyId 返回 NOT_FOUND', () => {
    const service = makeService();
    const missing = service.remove('00000000000000000000000000000000', 'admin:a', 'r1');
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe('COMMON_NOT_FOUND');
  });
});
