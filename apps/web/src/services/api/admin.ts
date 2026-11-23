/**
 * 管理员（系统维护）API 封装。
 *
 * 与店主侧完全隔离：独立 Cookie `admin_sid`、独立端点前缀 `/api/admin/*`。
 * 所有请求都带 `silent: true` 的探测语义由页面自行处理——管理员未登录时
 * 不应触发店主侧「跳 /login」的全局动作（见 request.ts 的 isAdminPath）。
 *
 * 注意：这里**没有任何业务记录端点**，管理员只做备份、导出、审计与凭据维护。
 */
import type {
  AdminBackupListResponse,
  AdminMeResponse,
  AdminSystemResponse,
  BackupSettingsRequest,
  BackupSettingsResponse,
  LogicalBackupListResponse,
  LogicalBackupTriggerResponse,
  RestoreBeginResponse,
  RestoreCommitRequest,
  RestoreCommitResponse,
} from '@stockin/shared';
import { download, request, type BlobResult } from '../request';

/** `GET /api/admin/me`：未登录返回 authenticated=false，不抛错。 */
export function getAdminMe(): Promise<AdminMeResponse> {
  return request<AdminMeResponse>('/api/admin/me', { silent: true });
}

/** `GET /api/admin/system`：版本与计数概览。 */
export function getAdminSystem(): Promise<AdminSystemResponse> {
  return request<AdminSystemResponse>('/api/admin/system', { silent: true });
}

/** `GET /api/admin/backups`：备份池元数据。 */
export function listAdminBackups(): Promise<AdminBackupListResponse> {
  return request<AdminBackupListResponse>('/api/admin/backups', { silent: true });
}

export interface AdminBackupTriggerView {
  readonly status: 'ok' | 'skipped';
  readonly meta: unknown;
}

/** `POST /api/admin/backups`：立即生成一份快照。 */
export function triggerAdminBackup(): Promise<AdminBackupTriggerView> {
  return request<AdminBackupTriggerView>('/api/admin/backups', {
    method: 'POST',
    silent: true,
  });
}

/** `GET /api/admin/backups/:file/download`：下载 .db.gz（仅 filesystem 运行时）。 */
export function downloadAdminBackup(file: string): Promise<BlobResult> {
  return download(`/api/admin/backups/${encodeURIComponent(file)}/download`);
}

/* ------------------------- 加密逻辑备份（管理员） ------------------------- */

/** `GET /api/admin/logical-backups`：逻辑备份记录与任务状态。 */
export function listAdminLogicalBackups(): Promise<LogicalBackupListResponse> {
  return request<LogicalBackupListResponse>('/api/admin/logical-backups', { silent: true });
}

/** `POST /api/admin/logical-backups`：入队一次手动逻辑备份。 */
export function triggerAdminLogicalBackup(): Promise<LogicalBackupTriggerResponse> {
  return request<LogicalBackupTriggerResponse>('/api/admin/logical-backups', {
    method: 'POST',
    silent: true,
  });
}

/** `GET /api/admin/logical-backups/:id/download`：下载加密 NDJSON（全平台可用）。 */
export function downloadAdminLogicalBackup(id: string): Promise<BlobResult> {
  return download(`/api/admin/logical-backups/${encodeURIComponent(id)}/download`);
}

/** `GET /api/admin/backup-settings`：逻辑 / 物理备份间隔。 */
export function getBackupSettings(): Promise<BackupSettingsResponse> {
  return request<BackupSettingsResponse>('/api/admin/backup-settings', { silent: true });
}

/** `PUT /api/admin/backup-settings`：更新至少一项间隔（1～365 天）。 */
export function updateBackupSettings(input: BackupSettingsRequest): Promise<BackupSettingsResponse> {
  return request<BackupSettingsResponse>('/api/admin/backup-settings', {
    method: 'PUT',
    json: input,
    silent: true,
  });
}

/** `POST /api/admin/restore/begin`：开启一次性恢复批次。 */
export function beginRestore(): Promise<RestoreBeginResponse> {
  return request<RestoreBeginResponse>('/api/admin/restore/begin', {
    method: 'POST',
    silent: true,
  });
}

/** `PUT /api/admin/restore/:batchId/chunk/:seq`：上传恢复包分块。 */
export function putRestoreChunk(batchId: string, seq: number, bytes: Uint8Array): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/admin/restore/${encodeURIComponent(batchId)}/chunk/${seq}`, {
    method: 'PUT',
    bytes,
    silent: true,
  });
}

/** `POST /api/admin/restore/commit`：验签并提交全量恢复。 */
export function commitRestore(input: RestoreCommitRequest): Promise<RestoreCommitResponse> {
  return request<RestoreCommitResponse>('/api/admin/restore/commit', {
    method: 'POST',
    json: input,
    silent: true,
  });
}

/** `GET /api/admin/export`：逻辑导出 JSON（脱敏，不含凭据）。 */
export function exportAdminData(): Promise<BlobResult> {
  return download('/api/admin/export');
}

/** `GET /api/admin/audit-logs/export`：审计日志 CSV（带 BOM）。 */
export function exportAdminAudit(): Promise<BlobResult> {
  return download('/api/admin/audit-logs/export');
}

/** `POST /api/admin/owner-credentials`：重置店主密码。 */
export function resetOwnerCredentials(newPassword: string): Promise<{ ok: true }> {
  return request<{ ok: true }>('/api/admin/owner-credentials', {
    method: 'POST',
    json: { newPassword },
    silent: true,
  });
}

/** `POST /api/admin/auth/logout`：吊销当前管理员会话。 */
export function logoutAdmin(): Promise<{ ok: true }> {
  return request<{ ok: true }>('/api/admin/auth/logout', { method: 'POST', silent: true });
}

/** 发起 GitHub OAuth：浏览器整页跳转到授权页（302）。 */
export function startAdminGithubLogin(): void {
  if (typeof window !== 'undefined') {
    window.location.assign('/api/admin/auth/github/start');
  }
}
