/**
 * 加密逻辑备份 / 一次性恢复 的 HTTP 契约。
 *
 * 用户端只读备份记录 + 立即备份；下载、恢复、间隔设置只在管理员端。
 */

/** 用户端 / 管理员端共用的逻辑备份元数据（无密钥材料）。 */
export interface LogicalBackupItem {
  readonly id: string;
  readonly schemaVersion: number;
  readonly keyId: string;
  readonly createdAt: string;
  readonly chunkCount: number;
  readonly plainBytes: number;
  readonly manifestSha256: string | null;
  readonly formatVersion: number;
}

/** 逻辑备份任务进度。 */
export interface LogicalBackupJobView {
  readonly jobId: string;
  readonly backupId: string | null;
  readonly status: 'pending' | 'running' | 'done' | 'failed';
  readonly chunkSeq: number;
  readonly totalChunks: number | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

/** GET /api/backups（用户端）与 /api/admin/logical-backups 的响应。 */
export interface LogicalBackupListResponse {
  readonly items: readonly LogicalBackupItem[];
  readonly keepCount: number;
  readonly intervalDays: number;
  readonly enabled: boolean;
  readonly lastBackupAt: string | null;
  readonly activeJob: LogicalBackupJobView | null;
}

/** POST /api/backup 触发逻辑备份的响应。 */
export interface LogicalBackupTriggerResponse {
  readonly jobId: string;
}

/** 恢复批次（POST /api/admin/restore/begin）。 */
export interface RestoreBeginResponse {
  readonly batchId: string;
  readonly issuedAt: string;
  readonly windowMs: number;
}

/** 恢复票据（本地脚本生成，POST commit 时上传）。 */
export interface RestoreTicketPayload {
  readonly v: number;
  readonly batchId: string;
  readonly issuedAt: string;
  readonly dataSha256: string;
  readonly schemaVersion: number;
  readonly keyId: string;
}

export interface RestoreTicket {
  readonly payload: RestoreTicketPayload;
  readonly signature: string;
}

/** POST /api/admin/restore/commit 的请求体。 */
export interface RestoreCommitRequest {
  readonly batchId: string;
  readonly ticket: RestoreTicket;
}

/** POST /api/admin/restore/commit 的响应。 */
export interface RestoreCommitResponse {
  readonly backupId: string;
  readonly restoredTables: number;
  readonly restoredRows: number;
}

/** 备份间隔设置（管理员端 PUT /api/admin/backup-settings）。 */
export interface BackupSettingsRequest {
  readonly logicalBackupIntervalDays?: number;
  readonly physicalBackupIntervalDays?: number;
}

export interface BackupSettingsResponse {
  readonly logicalBackupIntervalDays: number;
  readonly physicalBackupIntervalDays: number;
}

/** 备份公钥条目的来源：全部由管理台维护并落库，可增删启用。 */
export type BackupKeySource = 'database';

/** 公钥条目。**永不含私钥**，`keyId` 即公钥 SHA-256 前 32 位，可与本地 `.keys/` 对照。 */
export interface BackupKeyItem {
  readonly keyId: string;
  readonly label: string;
  /** 当前用于加密新备份的那一把（全局唯一）。 */
  readonly active: boolean;
  readonly source: BackupKeySource;
  readonly createdAt: string | null;
  readonly activatedAt: string | null;
}

/** GET /api/admin/backup-keys */
export interface BackupKeyListResponse {
  readonly items: readonly BackupKeyItem[];
  /** 是否有可用于加密的公钥（逻辑备份与恢复的开关）。 */
  readonly enabled: boolean;
}

/** POST /api/admin/backup-keys */
export interface BackupKeyAddRequest {
  readonly publicKey: string;
  readonly label?: string;
  /** 新增后立即设为加密公钥（首次接管时用）。 */
  readonly activate?: boolean;
}
