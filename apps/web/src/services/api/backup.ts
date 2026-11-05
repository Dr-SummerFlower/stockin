/**
 * 备份 API（路径以 T03b `settings.routes.ts` 实际注册为准）。
 * `GET /api/backups` 仅返回元数据，**无下载端点**；`POST /api/backup` 手动触发一次。
 */
import { request } from '../request';

export interface BackupMetaView {
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

export interface BackupListView {
  readonly items: readonly BackupMetaView[];
  readonly keepCount: number;
  readonly lastBackupAt: string | null;
}

export interface BackupTriggerView {
  readonly status: 'ok' | 'skipped' | 'failed';
  readonly meta: BackupMetaView | null;
}

export function triggerBackup(): Promise<BackupTriggerView> {
  return request<BackupTriggerView>('/api/backup', { method: 'POST' });
}

export function listBackups(): Promise<BackupListView> {
  return request<BackupListView>('/api/backups');
}
