/**
 * 管理员（系统维护）契约。
 *
 * 管理员是独立于店主的身份：只用 GitHub OAuth 登录，只做备份、导出、
 * 审计与凭据维护，**不接触业务记录**。前端只消费这些 DTO。
 */

/** `GET /api/admin/me`：未登录时 `authenticated=false`，不返回任何身份细节。 */
export interface AdminMeResponse {
  authenticated: boolean;
  /** GitHub 登录名（小写）；未登录为 null。 */
  login: string | null;
  displayName: string | null;
  /** 部署侧是否配置了 GitHub OAuth（false 时前端提示联系部署者）。 */
  configured: boolean;
}

/** 备份池中的一份快照（元数据，不含服务器路径）。 */
export interface AdminBackupItem {
  file: string;
  gzipFile: string;
  createdAt: string;
  sizeBytes: number;
  userVersion: number;
  integrity: 'ok' | 'failed';
  reason: string;
  baseline: boolean;
  sha256: string;
}

/**
 * 备份列表。`mode='pitr'` 表示当前运行时由平台托管（Workers），
 * 应用侧没有文件可下载，前端据此展示说明而不是空列表。
 */
export interface AdminBackupListResponse {
  items: AdminBackupItem[];
  keepCount: number;
  mode: 'filesystem' | 'pitr';
  lastBackupAt: string | null;
}

/** 系统概览：只暴露运维所需的计数与版本，不含任何业务明细。 */
export interface AdminSystemResponse {
  version: string;
  runtime: string;
  schemaVersion: number;
  recordCount: number;
  trashCount: number;
  logCount: number;
  backupMode: 'filesystem' | 'pitr';
  adminLogins: string[];
}

/** 管理员重置店主密码（用户名保持不变）。 */
export interface AdminOwnerResetRequest {
  newPassword: string;
}

/**
 * 逻辑导出的结构。刻意**不含**任何凭据材料：
 * 密码哈希、盐、密保答案、会话 token 一律不出现。
 */
export interface AdminExportPayload {
  exportedAt: string;
  schemaVersion: number;
  appVersion: string;
  tables: {
    records: unknown[];
    settings: unknown[];
    operationLogs: unknown[];
    adminAccounts: unknown[];
    meta: unknown[];
  };
}
