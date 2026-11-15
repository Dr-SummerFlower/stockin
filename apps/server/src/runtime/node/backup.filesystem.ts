/**
 * Node 运行时：文件系统备份端口（在线快照池 + 校验链 + GC）。
 *
 * 只是把 `repositories/backup.ts` 的既有实现挂到 `BackupPort` 上，
 * 语义零改动：备份目录、保留份数、空间检查全部来自注入的 `env`。
 */
import type { Db } from '../../repositories/db';
import {
  createBackup,
  listBackups,
  type BackupMeta,
  type BackupResult,
} from '../../repositories/backup';
import { BACKUP_KEEP_COUNT } from '@stockin/shared';
import type { BackupCreateOptions, BackupPort } from '../ports';

export interface FilesystemBackupOptions {
  readonly backupDir: string;
  /** 磁盘余量下限；不足时只跳过本次备份，不阻断。 */
  readonly minFreeBytes?: number;
  readonly keepCount?: number;
}

export function createFilesystemBackupPort(options: FilesystemBackupOptions): BackupPort {
  const keepCount: number = options.keepCount ?? BACKUP_KEEP_COUNT;
  return {
    mode: 'filesystem',
    keepCount,

    create(db: Db, request: BackupCreateOptions): Promise<BackupResult> {
      return createBackup(db, {
        backupDir: options.backupDir,
        reason: request.reason,
        initState: request.initState,
        baseline: request.baseline,
        minFreeBytes: request.minFreeBytes ?? options.minFreeBytes,
        keepCount: request.keepCount ?? keepCount,
        expectedUserVersion: request.expectedUserVersion,
      });
    },

    list(): BackupMeta[] {
      return listBackups(options.backupDir);
    },
  };
}
