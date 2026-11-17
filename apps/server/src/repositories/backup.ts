/**
 * 在线备份、校验链与 GC。
 *
 * 依据：设计文档 v1.1 §4.5 / §7.5 / §10.1 裁决 32 ——
 * `db.backupTo()` 在线一致性快照；校验链 integrity_check → user_version →
 * 魔数 → sha256 → gzip → gzip -t → 入池 → GC（GC 前断言至少留 1 份 integrity=ok）；
 * 保留最近 7 份；空间不足跳过本次但不阻断启动；
 * baseline 基线快照 + init_state 元数据，避免「恢复后状态与凭据不一致」的死锁。
 *
 * 说明：Windows/Git Bash 未必带外部 `gzip` 可执行文件，故 `gzip -t` 环节用
 * Node 内置 zlib 的 gzipSync + gunzipSync 往返比对实现等价完整性校验。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { BACKUP_KEEP_COUNT } from '@stockin/shared';
import { sha256Hex } from '../lib/crypto';
import { utcNowIso } from '../lib/today';
import { logger } from '../lib/logger';
import type { Db } from './db';
import { assertIntegrity, readUserVersion } from './db';
import { openDatabase } from '../runtime/node/db.factory';

/** SQLite 文件头魔数（前 16 字节）。 */
export const SQLITE_MAGIC = 'SQLite format 3\u0000';
export const SQLITE_HEADER_BYTES = 16;
export const BACKUP_META_SUFFIX = '.meta.json';

export interface BackupMeta {
  readonly file: string;
  readonly gzipFile: string;
  readonly createdAt: string;
  readonly userVersion: number;
  readonly initState: 0 | 1;
  readonly integrity: 'ok' | 'failed';
  readonly sha256: string;
  readonly magic: string;
  readonly reason: string;
  readonly baseline: boolean;
  readonly sizeBytes: number;
}

export type BackupResult =
  | { readonly status: 'ok'; readonly meta: BackupMeta }
  | { readonly status: 'skipped'; readonly reason: string };

export interface CreateBackupOptions {
  readonly backupDir: string;
  readonly reason: string;
  readonly initState: 0 | 1;
  readonly baseline?: boolean;
  readonly minFreeBytes?: number;
  readonly keepCount?: number;
  /**
   * 校验链中 user_version 的比对基准。缺省取备份发起时库内的实际版本：
   * 迁移前快照的 user_version 必然是旧版本，不能硬编码要求等于 SCHEMA_EXPECTED。
   */
  readonly expectedUserVersion?: number;
}

export interface VerifiedBackupFile {
  readonly magic: string;
  readonly integrity: 'ok' | 'failed';
  readonly userVersion: number;
  readonly sha256: string;
  readonly sizeBytes: number;
}

/** 读取 sqlite_master 之外的文件头魔数，确认这是 SQLite 数据库而非任意文件。 */
export function readSqliteMagic(file: string): string {
  const fd: number = fs.openSync(file, 'r');
  try {
    const buffer: Buffer = Buffer.alloc(SQLITE_HEADER_BYTES);
    fs.readSync(fd, buffer, 0, SQLITE_HEADER_BYTES, 0);
    return buffer.toString('latin1');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 清理只读打开 WAL 库时 SQLite 自动生成的边车文件。
 *
 * 背景（2026-11-15 实测）：快照文件头记录了 `journal_mode=WAL`，只读打开时
 * SQLite 仍会生成 `<db>-shm`（32KB）与 `<db>-wal`（0 字节）。数据全在主文件里
 * （已用隔离副本验证 integrity=ok），但 `gcBackups` 只删 .db/.gz/.meta.json，
 * 边车会一直堆在备份池里。
 *
 * 仅当 `-wal` 为 0 字节时才删（0 字节表示没有待回放帧，删掉不丢数据）；
 * 非 0 字节说明库不完整，此时保留边车并让上层看见。
 */
function removeStraySidecars(file: string): void {
  const wal: string = `${file}-wal`;
  const shm: string = `${file}-shm`;
  try {
    if (fs.existsSync(wal) && fs.statSync(wal).size === 0) {
      fs.rmSync(wal, { force: true });
      fs.rmSync(shm, { force: true });
    }
  } catch {
    // 清理失败不影响校验结论；下次 GC 仍会看到 .db 本体。
  }
}

/**
 * 校验链（不含 gzip）：integrity_check → user_version → 魔数 → sha256。
 * 只读打开，绝不改动快照内容。
 */
export function verifyBackupFile(file: string): VerifiedBackupFile {
  const magic: string = readSqliteMagic(file);
  if (magic !== SQLITE_MAGIC) {
    throw new Error(`[backup] 魔数不匹配，非 SQLite 文件: ${file}`);
  }
  const buffer: Buffer = fs.readFileSync(file);
  const sha256: string = sha256Hex(buffer);

  const snapshot: Db = openDatabase({
    filename: file,
    readonly: true,
    fileMustExist: true,
  });
  let integrity: 'ok' | 'failed' = 'failed';
  let userVersion = 0;
  try {
    assertIntegrity(snapshot);
    integrity = 'ok';
    userVersion = readUserVersion(snapshot);
  } finally {
    snapshot.close();
    removeStraySidecars(file);
  }
  return { magic, integrity, userVersion, sha256, sizeBytes: buffer.length };
}

/** 列出备份池中的全部元数据，按创建时间倒序。 */
export function listBackups(backupDir: string): BackupMeta[] {
  if (!fs.existsSync(backupDir)) {
    return [];
  }
  const items: BackupMeta[] = [];
  for (const name of fs.readdirSync(backupDir)) {
    if (!name.endsWith(BACKUP_META_SUFFIX)) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(backupDir, name), 'utf8'));
      if (typeof parsed === 'object' && parsed !== null) {
        items.push(parsed as BackupMeta);
      }
    } catch {
      // 损坏的元数据不参与选片，但也不主动删除（留给人工排障）。
    }
  }
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return items;
}

export interface GcResult {
  readonly removed: string[];
  readonly kept: number;
  readonly integrityOkCount: number;
}

/**
 * 保留最近 `keepCount` 份；GC 前与 GC 后都断言至少保留 1 份 integrity=ok。
 * 违反断言时不删除任何文件（fail-safe）。
 */
export function gcBackups(backupDir: string, keepCount: number = BACKUP_KEEP_COUNT): GcResult {
  const all: BackupMeta[] = listBackups(backupDir);
  const removed: string[] = [];
  const integrityOkCount: number = all.filter((m) => m.integrity === 'ok').length;
  if (integrityOkCount <= 1) {
    return { removed, kept: all.length, integrityOkCount };
  }
  const victims: BackupMeta[] = all.slice(keepCount);
  const remainingOk: number = all.slice(0, keepCount).filter((m) => m.integrity === 'ok').length;
  if (remainingOk < 1) {
    return { removed, kept: all.length, integrityOkCount };
  }
  for (const meta of victims) {
    const metaPath: string = path.join(backupDir, `${meta.file}${BACKUP_META_SUFFIX}`);
    for (const file of [
      metaPath,
      path.join(backupDir, meta.file),
      path.join(backupDir, meta.gzipFile),
    ]) {
      fs.rmSync(file, { force: true });
    }
    removed.push(meta.file);
  }
  return { removed, kept: all.length - removed.length, integrityOkCount: remainingOk };
}

/** 检查剩余空间；无法判定时返回 true（不阻断启动）。 */
export function hasEnoughSpace(backupDir: string, minFreeBytes: number | undefined): boolean {
  if (minFreeBytes === undefined) {
    return true;
  }
  try {
    const stats: fs.StatsFs = fs.statfsSync(backupDir);
    return stats.bavail * stats.bsize >= minFreeBytes;
  } catch {
    return true;
  }
}

/**
 * 生成一次备份。空间不足时返回 `{ status: 'skipped' }` 并写 WARN，
 * 调用方（bootstrap / 迁移 / CLI）据此提示但不阻断。
 */
export async function createBackup(db: Db, options: CreateBackupOptions): Promise<BackupResult> {
  const { backupDir, reason, initState } = options;
  fs.mkdirSync(backupDir, { recursive: true });
  if (!hasEnoughSpace(backupDir, options.minFreeBytes)) {
    const hint = '[backup] 剩余空间不足，跳过本次备份；请在应用内清理旧快照';
    logger.warn({ reason }, hint);
    return { status: 'skipped', reason: hint };
  }

  // 校验链的 user_version 基准 = 发起备份时库内的实际版本（迁移前快照是旧版本）。
  const expectedUserVersion: number = options.expectedUserVersion ?? readUserVersion(db);
  const stamp: string = utcNowIso().replace(/[:.]/g, '-');
  const suffix: string = randomBytes(3).toString('hex');
  const tag: string = options.baseline === true ? 'baseline' : 'auto';
  const fileName: string = `stockin-${stamp}-${tag}-${suffix}.db`;
  const destination: string = path.join(backupDir, fileName);

  // backupTo 在 WAL 下仍是一致性快照；不使用 cp 直接复制主库文件。
  await db.backupTo(destination);

  const verified: VerifiedBackupFile = verifyBackupFile(destination);
  if (verified.integrity !== 'ok') {
    fs.rmSync(destination, { force: true });
    throw new Error(`[backup] 快照 integrity_check 未通过，已丢弃: ${destination}`);
  }
  if (verified.userVersion !== expectedUserVersion) {
    fs.rmSync(destination, { force: true });
    throw new Error(
      `[backup] 快照 user_version=${verified.userVersion} 与发起备份时的 ${expectedUserVersion} 不符，已丢弃`,
    );
  }

  // gzip + 等价 gzip -t：解压回原文并比对 sha256。
  const raw: Buffer = fs.readFileSync(destination);
  const gzipFile: string = `${fileName}.gz`;
  fs.writeFileSync(path.join(backupDir, gzipFile), zlib.gzipSync(raw));
  const roundTrip: Buffer = zlib.gunzipSync(fs.readFileSync(path.join(backupDir, gzipFile)));
  if (sha256Hex(roundTrip) !== verified.sha256) {
    throw new Error(`[backup] gzip 往返校验失败: ${gzipFile}`);
  }

  const meta: BackupMeta = {
    file: fileName,
    gzipFile,
    createdAt: utcNowIso(),
    userVersion: verified.userVersion,
    initState,
    integrity: verified.integrity,
    sha256: verified.sha256,
    magic: verified.magic,
    reason,
    baseline: options.baseline ?? false,
    sizeBytes: verified.sizeBytes,
  };
  fs.writeFileSync(
    path.join(backupDir, `${fileName}${BACKUP_META_SUFFIX}`),
    `${JSON.stringify(meta, null, 2)}\n`,
    'utf8',
  );

  gcBackups(backupDir, options.keepCount ?? BACKUP_KEEP_COUNT);
  logger.info({ file: fileName, reason, userVersion: meta.userVersion }, '[backup] 快照已入池');
  return { status: 'ok', meta };
}

/** 引导完成后立即生成 baseline 基线快照（恢复死锁修复）。 */
export async function createBaselineBackup(
  db: Db,
  options: Omit<CreateBackupOptions, 'baseline' | 'initState' | 'reason'>,
): Promise<BackupResult> {
  return createBackup(db, {
    ...options,
    reason: 'post-setup-baseline',
    initState: 1,
    baseline: true,
  });
}
