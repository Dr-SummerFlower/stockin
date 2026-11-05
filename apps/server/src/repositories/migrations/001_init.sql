-- 001_init.sql — 进货统计应用初始 schema
--
-- 依据：设计文档 v1.1 §4.2（6 表）、§4.3（整数定点 / TEXT 日期 / 审计时间戳
-- 由应用层生成）、§4.4（8 条显式索引，含部分索引 WHERE deleted_at IS NULL）、
-- §4.5（迁移只用 ADD COLUMN / ADD INDEX、单脚本单事务）。
--
-- 硬约束：
--   * 本文件不得出现 date('now') / CURRENT_DATE / CURRENT_TIMESTAMP；
--     所有时间戳列由应用层以 UTC ISO 8601 文本注入。
--   * 双花括号包裹的 NAME 占位符由 migrations/runner.ts 从 @stockin/shared 注入，
--     保证业务常量单一真源、SQL 内不硬编码（注释行不参与模板替换）。
--   * sessions.token_hash 的 UNIQUE 走表级命名约束（自动索引），
--     8 条显式 CREATE INDEX 对应 §4.4 的「8 条索引」。

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- credentials
CREATE TABLE IF NOT EXISTS credentials (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  username       TEXT    NOT NULL,
  password_hash  TEXT    NOT NULL,
  salt           TEXT    NOT NULL,
  scrypt_params  TEXT    NOT NULL,
  is_initial     INTEGER NOT NULL DEFAULT 0 CHECK (is_initial IN (0, 1)),
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

-- ------------------------------------------------------------------- settings
CREATE TABLE IF NOT EXISTS settings (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  expiry_threshold_days INTEGER NOT NULL DEFAULT {{DEFAULT_EXPIRY_THRESHOLD_DAYS}}
                        CHECK (expiry_threshold_days BETWEEN {{EXPIRY_THRESHOLD_MIN}} AND {{EXPIRY_THRESHOLD_MAX}})
);

-- ------------------------------------------------------------------- sessions
CREATE TABLE IF NOT EXISTS sessions (
  id                   TEXT    PRIMARY KEY,
  token_hash           TEXT    NOT NULL,
  account_id           INTEGER NOT NULL,
  idle_expires_at      TEXT    NOT NULL,
  absolute_expires_at  TEXT    NOT NULL,
  revoked              INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
  revoked_reason       TEXT,
  auth_epoch           INTEGER NOT NULL,
  created_at           TEXT    NOT NULL,
  last_seen_at         TEXT    NOT NULL,
  CONSTRAINT uq_sessions_token_hash UNIQUE (token_hash),
  FOREIGN KEY (account_id) REFERENCES credentials (id)
);

-- -------------------------------------------------------------------- records
CREATE TABLE IF NOT EXISTS records (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT    NOT NULL,
  name_norm           TEXT    NOT NULL,
  purchase_date       TEXT    NOT NULL,
  production_date     TEXT,
  shelf_life_value    INTEGER,
  shelf_life_unit     TEXT,
  expiry_date         TEXT,
  spec                TEXT,
  spec_norm           TEXT    NOT NULL,
  unit_price          INTEGER NOT NULL DEFAULT 0,
  quantity            INTEGER NOT NULL DEFAULT 0,
  amount_cents        INTEGER NOT NULL DEFAULT 0,
  remark              TEXT,
  production_date_src INTEGER NOT NULL DEFAULT {{DB_SRC_USER}} CHECK (production_date_src IN (0, 1)),
  shelf_life_src      INTEGER NOT NULL DEFAULT {{DB_SRC_USER}} CHECK (shelf_life_src IN (0, 1)),
  expiry_date_src     INTEGER NOT NULL DEFAULT {{DB_SRC_USER}} CHECK (expiry_date_src IN (0, 1)),
  unit_price_src      INTEGER NOT NULL DEFAULT {{DB_SRC_USER}} CHECK (unit_price_src IN (0, 1)),
  quantity_src        INTEGER NOT NULL DEFAULT {{DB_SRC_USER}} CHECK (quantity_src IN (0, 1)),
  amount_src          INTEGER NOT NULL DEFAULT {{DB_SRC_USER}} CHECK (amount_src IN (0, 1)),
  version             INTEGER NOT NULL DEFAULT 1,
  deleted_at          TEXT,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  CHECK (
    (shelf_life_value IS NULL AND shelf_life_unit IS NULL)
    OR (shelf_life_value IS NOT NULL AND shelf_life_unit IS NOT NULL)
  ),
  CHECK (shelf_life_unit IS NULL OR shelf_life_unit IN ({{SHELF_LIFE_UNITS_SQL}}))
);

-- ------------------------------------------------------------- operation_logs
CREATE TABLE IF NOT EXISTS operation_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  action       TEXT    NOT NULL,
  target_type  TEXT    NOT NULL,
  target_id    INTEGER,
  detail       TEXT,
  request_id   TEXT    NOT NULL,
  actor        TEXT    NOT NULL,
  occurred_at  TEXT    NOT NULL
);

-- ------------------------------------------------------------------------ meta
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

-- ------------------------------------------------------- 8 条显式命名索引
CREATE INDEX IF NOT EXISTS idx_records_active_purchase_date
  ON records (purchase_date, id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_records_active_expiry_date
  ON records (expiry_date, amount_cents) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_records_active_name_norm
  ON records (name_norm) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_records_active_dedup
  ON records (name_norm, purchase_date, production_date, expiry_date,
              spec_norm, unit_price, quantity, amount_cents)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_records_trash_deleted_at
  ON records (deleted_at, id);

CREATE INDEX IF NOT EXISTS idx_oplogs_occurred_action
  ON operation_logs (occurred_at, action);

CREATE INDEX IF NOT EXISTS idx_oplogs_target
  ON operation_logs (target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_sessions_active_expiry
  ON sessions (revoked, idle_expires_at, absolute_expires_at);

-- ------------------------------------------- meta.setup_completed 单向 0→1
CREATE TRIGGER IF NOT EXISTS trg_meta_setup_no_reset
BEFORE UPDATE OF value ON meta
WHEN OLD.key = 'setup_completed' AND OLD.value = '1' AND NEW.value <> '1'
BEGIN
  SELECT RAISE(ABORT, 'meta.setup_completed 只能 0->1，不可回退');
END;

CREATE TRIGGER IF NOT EXISTS trg_meta_setup_no_rename
BEFORE UPDATE OF key ON meta
WHEN OLD.key = 'setup_completed' AND OLD.value = '1'
BEGIN
  SELECT RAISE(ABORT, 'meta.setup_completed 键不可改名');
END;

CREATE TRIGGER IF NOT EXISTS trg_meta_setup_no_delete
BEFORE DELETE ON meta
WHEN OLD.key = 'setup_completed' AND OLD.value = '1'
BEGIN
  SELECT RAISE(ABORT, 'meta.setup_completed 不可删除');
END;

-- ---------------------------------------------- operation_logs append-only
CREATE TRIGGER IF NOT EXISTS trg_oplogs_no_update
BEFORE UPDATE ON operation_logs
BEGIN
  SELECT RAISE(ABORT, 'operation_logs 是 append-only 表');
END;

CREATE TRIGGER IF NOT EXISTS trg_oplogs_no_delete
BEFORE DELETE ON operation_logs
BEGIN
  SELECT RAISE(ABORT, 'operation_logs 是 append-only 表');
END;

-- --------------------------------------------------------------- 初始行
INSERT OR IGNORE INTO settings (id, expiry_threshold_days)
VALUES (1, {{DEFAULT_EXPIRY_THRESHOLD_DAYS}});

INSERT OR IGNORE INTO meta (key, value) VALUES
  ('setup_completed', '0'),
  ('schema_version', '{{SCHEMA_VERSION}}'),
  ('auth_epoch', '0'),
  ('baseline', ''),
  ('last_backup_at', ''),
  ('last_backup_status', '');

PRAGMA user_version = {{SCHEMA_VERSION}};
