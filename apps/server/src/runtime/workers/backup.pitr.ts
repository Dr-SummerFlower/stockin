/**
 * Workers 运行时：备份改由平台托管（PITR / Time Travel）。
 *
 * Durable Objects 没有文件系统，`db.backup()` 这类"写一份快照到盘上"的做法
 * 在 Workers 上不成立；平台的等价能力是 PITR（付费档默认保留 30 天）。
 *
 * 端口语义（与 `db.port.ts` 的 `UnsupportedCapabilityError` 一脉相承）：
 * **绝不假装成功**。`create()` 返回 `{ status: 'skipped', reason }`，
 * 上层照常写一条"已跳过"的操作日志，界面按"当前运行时由平台托管备份"展示，
 * 而不是显示一份并不存在的快照。
 */
import type { BackupMeta, BackupResult } from '../../repositories/backup';
import type { BackupCreateOptions, BackupPort } from '../ports';

/** 跳过原因（同时用于操作日志与界面提示，措辞一次写清避免前端再拼）。 */
export const PITR_SKIP_REASON =
  '当前运行时由平台托管备份（PITR / Time Travel），应用侧不生成文件快照';

export interface PitrBackupOptions {
  /** 保留份数仅用于界面文案；PITR 的实际保留策略由平台决定。 */
  readonly keepCount: number;
}

export function createPitrBackupPort(options: PitrBackupOptions): BackupPort {
  return {
    mode: 'pitr',
    keepCount: options.keepCount,

    create(_db, _request: BackupCreateOptions): Promise<BackupResult> {
      return Promise.resolve({ status: 'skipped', reason: PITR_SKIP_REASON });
    },

    list(): BackupMeta[] {
      // 应用侧没有可见的备份池；界面据此显示为空并给出平台托管说明。
      return [];
    },
  };
}
