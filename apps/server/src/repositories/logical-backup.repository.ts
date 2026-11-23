/**
 * 逻辑备份仓储：备份任务、密文 chunk 与备份池。
 *
 * 所有 SQL 只允许出现在本文件；Service 不拼表名、不读 sqlite_master。
 * 表名来自 sqlite_master 的白名单过滤，不直接使用用户输入。
 */
import type { Db } from './db';

export const LOGICAL_BACKUP_FORMAT_VERSION = 1;
export const LOGICAL_BACKUP_KEEP_COUNT = 5;
export const LOGICAL_BACKUP_CHUNK_ROWS = 200;

const EXCLUDED_TABLES = new Set([
  'backup_jobs',
  'backups',
  'backup_chunks',
  'sessions',
  'admin_sessions',
]);

export interface BackupJobRow {
  id: string;
  kind: 'logical';
  status: 'pending' | 'running' | 'done' | 'failed';
  cursor_table: string | null;
  cursor_rowid: number | null;
  chunk_seq: number;
  total_chunks: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface BackupRow {
  id: string;
  job_id: string;
  format_version: number;
  schema_version: number;
  key_id: string;
  ephemeral_public_key: string;
  kdf_salt: string;
  wrapped_key_iv: string;
  wrapped_key_ciphertext: string;
  wrapped_key_tag: string;
  created_at: string;
  chunk_count: number;
  plain_bytes: number;
  manifest_sha256: string | null;
  status: 'building' | 'ready' | 'failed';
}

export interface BackupChunkRow {
  backup_id: string;
  seq: number;
  table_name: string;
  row_start: number;
  row_count: number;
  iv: string;
  ciphertext: string;
  tag: string;
  plain_bytes: number;
  sha256: string;
}

export interface BackupDataRow {
  readonly rowid: number;
  readonly values: readonly unknown[];
}

export class LogicalBackupRepository {
  constructor(private readonly db: Db) {}

  createJob(row: BackupJobRow): void {
    this.db
      .prepare(
        `INSERT INTO backup_jobs
          (id, kind, status, cursor_table, cursor_rowid, chunk_seq, total_chunks, error,
           created_at, updated_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.kind,
        row.status,
        row.cursor_table,
        row.cursor_rowid,
        row.chunk_seq,
        row.total_chunks,
        row.error,
        row.created_at,
        row.updated_at,
        row.finished_at,
      );
  }

  createBackup(row: BackupRow): void {
    this.db
      .prepare(
        `INSERT INTO backups
          (id, job_id, format_version, schema_version, key_id, ephemeral_public_key,
           kdf_salt, wrapped_key_iv, wrapped_key_ciphertext, wrapped_key_tag, created_at,
           chunk_count, plain_bytes, manifest_sha256, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.job_id,
        row.format_version,
        row.schema_version,
        row.key_id,
        row.ephemeral_public_key,
        row.kdf_salt,
        row.wrapped_key_iv,
        row.wrapped_key_ciphertext,
        row.wrapped_key_tag,
        row.created_at,
        row.chunk_count,
        row.plain_bytes,
        row.manifest_sha256,
        row.status,
      );
  }

  getJob(id: string): BackupJobRow | undefined {
    return this.db.prepare('SELECT * FROM backup_jobs WHERE id = ?').get(id) as
      | BackupJobRow
      | undefined;
  }

  nextRunnableJob(): BackupJobRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM backup_jobs
         WHERE status IN ('pending', 'running')
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get() as BackupJobRow | undefined;
  }

  updateJobCursor(
    id: string,
    cursorTable: string | null,
    cursorRowid: number | null,
    chunkSeq: number,
    totalChunks: number | null,
  ): void {
    this.db
      .prepare(
        `UPDATE backup_jobs
         SET status = 'running', cursor_table = ?, cursor_rowid = ?, chunk_seq = ?,
             total_chunks = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(cursorTable, cursorRowid, chunkSeq, totalChunks, new Date().toISOString(), id);
  }

  finishJob(id: string, status: 'done' | 'failed', error: string | null): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE backup_jobs
         SET status = ?, error = ?, updated_at = ?, finished_at = ?
         WHERE id = ?`,
      )
      .run(status, error, now, now, id);
  }

  getBackup(id: string): BackupRow | undefined {
    return this.db.prepare('SELECT * FROM backups WHERE id = ?').get(id) as BackupRow | undefined;
  }

  updateBackupProgress(id: string, chunkCount: number, plainBytes: number): void {
    this.db
      .prepare('UPDATE backups SET chunk_count = ?, plain_bytes = ? WHERE id = ?')
      .run(chunkCount, plainBytes, id);
  }

  markBackupReady(id: string): void {
    this.db.prepare("UPDATE backups SET status = 'ready' WHERE id = ?").run(id);
  }

  markBackupFailed(id: string): void {
    this.db.prepare("UPDATE backups SET status = 'failed' WHERE id = ?").run(id);
  }

  /** 备份完成后写入整包 manifest 的 SHA-256（覆盖所有 chunk 的有序摘要）。 */
  setManifest(backupId: string, manifestSha256: string): void {
    this.db
      .prepare('UPDATE backups SET manifest_sha256 = ? WHERE id = ?')
      .run(manifestSha256, backupId);
  }

  /** 是否已有未完成的 job（pending/running）；避免并发重复入队。 */
  hasActiveJob(): boolean {
    const row = this.db
      .prepare("SELECT 1 AS hit FROM backup_jobs WHERE status IN ('pending', 'running') LIMIT 1")
      .get() as { hit: number } | undefined;
    return row !== undefined;
  }

  /** 最近 N 个任务（含已完成），供前端展示进度与历史。 */
  listJobs(limit = 20): BackupJobRow[] {
    return this.db
      .prepare('SELECT * FROM backup_jobs ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(limit) as BackupJobRow[];
  }

  /** 距离最近一份 ready 备份的毫秒数；无 ready 备份时返回 Infinity。 */
  millisecondsSinceLastReady(nowMs: number): number {
    const row = this.db
      .prepare(
        "SELECT created_at FROM backups WHERE status = 'ready' ORDER BY created_at DESC LIMIT 1",
      )
      .get() as { created_at: string } | undefined;
    if (row === undefined) {
      return Number.POSITIVE_INFINITY;
    }
    const ts: number = Date.parse(row.created_at);
    return Number.isFinite(ts) ? nowMs - ts : Number.POSITIVE_INFINITY;
  }

  insertChunk(row: BackupChunkRow): void {
    this.db
      .prepare(
        `INSERT INTO backup_chunks
          (backup_id, seq, table_name, row_start, row_count, iv, ciphertext, tag,
           plain_bytes, sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.backup_id,
        row.seq,
        row.table_name,
        row.row_start,
        row.row_count,
        row.iv,
        row.ciphertext,
        row.tag,
        row.plain_bytes,
        row.sha256,
      );
  }

  listReady(limit = 20): BackupRow[] {
    return this.db
      .prepare("SELECT * FROM backups WHERE status = 'ready' ORDER BY created_at DESC LIMIT ?")
      .all(limit) as BackupRow[];
  }

  listChunks(backupId: string): BackupChunkRow[] {
    return this.db
      .prepare('SELECT * FROM backup_chunks WHERE backup_id = ? ORDER BY seq ASC')
      .all(backupId) as BackupChunkRow[];
  }

  /** 保留最近 N 份 ready 备份；失败/构建中的任务不参与 GC。 */
  gcReady(keepCount = LOGICAL_BACKUP_KEEP_COUNT): void {
    const rows = this.db
      .prepare("SELECT id FROM backups WHERE status = 'ready' ORDER BY created_at DESC, id DESC")
      .all() as { id: string }[];
    for (const row of rows.slice(keepCount)) {
      this.db.prepare('DELETE FROM backups WHERE id = ?').run(row.id);
    }
  }

  /** 白名单：只备份普通业务表，排除备份表与会话表。 */
  listTables(): string[] {
    const rows = this.db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name ASC`,
      )
      .all() as { name: string }[];
    return rows.map((row) => row.name).filter((name) => !EXCLUDED_TABLES.has(name));
  }

  listColumns(table: string): string[] {
    if (!this.listTables().includes(table)) {
      throw new Error(`[logical-backup] 非法表名: ${table}`);
    }
    const rows = this.db.prepare(`PRAGMA table_info('${table.replaceAll("'", "''")}')`).all() as {
      name: string;
    }[];
    return rows.map((row) => row.name);
  }

  readRows(table: string, afterRowid: number, limit = LOGICAL_BACKUP_CHUNK_ROWS): BackupDataRow[] {
    if (!this.listTables().includes(table)) {
      throw new Error(`[logical-backup] 非法表名: ${table}`);
    }
    const quoted = `"${table.replaceAll('"', '""')}"`;
    const rows = this.db
      .prepare(
        `SELECT rowid AS __rowid, * FROM ${quoted} WHERE rowid > ? ORDER BY rowid ASC LIMIT ?`,
      )
      .all(afterRowid, limit) as Record<string, unknown>[];
    const columns = this.listColumns(table);
    return rows.map((row) => ({
      rowid: Number(row.__rowid),
      values: columns.map((column) => row[column]),
    }));
  }
}
