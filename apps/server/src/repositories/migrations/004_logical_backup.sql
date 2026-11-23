-- 004_logical_backup.sql — 加密逻辑备份与恢复任务
--
-- 设计约束：
--   * 逻辑备份数据只存密文；AES 密钥由备份时随机生成，使用 P-256 公钥封装。
--   * backup_* 三张表不参与自身备份。
--   * 物理容灾仍是 Node 文件快照 / Workers PITR，不由这些表承载。

ALTER TABLE settings ADD COLUMN logical_backup_interval_days INTEGER NOT NULL DEFAULT 7
  CHECK (logical_backup_interval_days BETWEEN 1 AND 365);
ALTER TABLE settings ADD COLUMN physical_backup_interval_days INTEGER NOT NULL DEFAULT 30
  CHECK (physical_backup_interval_days BETWEEN 1 AND 365);

CREATE TABLE IF NOT EXISTS backup_jobs (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('logical')),
  status      TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed')),
  cursor_table TEXT,
  cursor_rowid INTEGER,
  chunk_seq   INTEGER NOT NULL DEFAULT 0,
  total_chunks INTEGER,
  error       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_backup_jobs_status
  ON backup_jobs (status, created_at);

CREATE TABLE IF NOT EXISTS backups (
  id                    TEXT PRIMARY KEY,
  job_id                TEXT NOT NULL UNIQUE,
  format_version        INTEGER NOT NULL,
  schema_version        INTEGER NOT NULL,
  key_id                TEXT NOT NULL,
  ephemeral_public_key  TEXT NOT NULL,
  wrapped_key_iv        TEXT NOT NULL,
  wrapped_key_ciphertext TEXT NOT NULL,
  wrapped_key_tag       TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  chunk_count           INTEGER NOT NULL DEFAULT 0,
  plain_bytes           INTEGER NOT NULL DEFAULT 0,
  manifest_sha256       TEXT,
  status                TEXT NOT NULL CHECK (status IN ('building', 'ready', 'failed')),
  FOREIGN KEY (job_id) REFERENCES backup_jobs (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_backups_created_at
  ON backups (created_at);

CREATE TABLE IF NOT EXISTS backup_chunks (
  backup_id   TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  table_name  TEXT NOT NULL,
  row_start   INTEGER NOT NULL,
  row_count   INTEGER NOT NULL,
  iv          TEXT NOT NULL,
  ciphertext  TEXT NOT NULL,
  tag         TEXT NOT NULL,
  plain_bytes INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  PRIMARY KEY (backup_id, seq),
  FOREIGN KEY (backup_id) REFERENCES backups (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_backup_chunks_backup
  ON backup_chunks (backup_id, seq);

PRAGMA user_version = {{SCHEMA_VERSION}};
