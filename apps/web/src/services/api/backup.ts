/**
 * 用户端备份 API。
 *
 * 后端只暴露加密逻辑备份：GET /api/backups 返回记录与任务状态，
 * POST /api/backup 入队一次备份。下载 / 恢复只在管理员端提供。
 */
import type {
  LogicalBackupItem,
  LogicalBackupListResponse,
  LogicalBackupTriggerResponse,
} from '@stockin/shared';
import { request } from '../request';

/** 兼容旧调用的展示类型别名；字段以 shared 契约为准。 */
export type BackupMetaView = LogicalBackupItem;
export type BackupListView = LogicalBackupListResponse;

/** `POST /api/backup`：返回任务号，备份在后台分块完成。 */
export function triggerBackup(): Promise<LogicalBackupTriggerResponse> {
  return request<LogicalBackupTriggerResponse>('/api/backup', { method: 'POST' });
}

/** `GET /api/backups`：逻辑备份记录、保留策略与当前任务。 */
export function listBackups(): Promise<LogicalBackupListResponse> {
  return request<LogicalBackupListResponse>('/api/backups');
}
