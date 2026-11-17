-- 003_admin_access.sql — 系统维护身份（超级管理员）
--
-- 依据：合规审计要求「系统管理员与业务用户权限分离」；管理员只用
-- GitHub OAuth 登录，只做备份 / 导出 / 审计 / 凭据维护，不接触业务记录。
--
-- 硬约束：
--   * 只新增表与索引，不改既有列、不删列、不重建表；
--   * 时间戳仍由应用层注入，本文件不出现任何日期函数；
--   * 管理员会话与店主会话物理隔离（独立表、独立 Cookie），互不影响。

-- 管理员账户：GitHub 登录名是唯一身份标识（统一存小写）。
CREATE TABLE IF NOT EXISTS admin_accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  github_login   TEXT    NOT NULL UNIQUE,
  github_user_id INTEGER,
  display_name   TEXT    NOT NULL DEFAULT '',
  created_at     TEXT    NOT NULL,
  last_login_at  TEXT
);

-- 管理员会话：只存 token 的 sha256，明文 token 仅存在于浏览器 Cookie。
-- Cookie 不设 Max-Age（窗口级），服务端仍按 idle / absolute 双过期兜底。
CREATE TABLE IF NOT EXISTS admin_sessions (
  id                  TEXT    PRIMARY KEY,
  token_hash          TEXT    NOT NULL UNIQUE,
  admin_id            INTEGER NOT NULL,
  idle_expires_at     TEXT    NOT NULL,
  absolute_expires_at TEXT    NOT NULL,
  revoked             INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
  created_at          TEXT    NOT NULL,
  last_seen_at        TEXT    NOT NULL,
  FOREIGN KEY (admin_id) REFERENCES admin_accounts (id)
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin
  ON admin_sessions (admin_id, revoked);

PRAGMA user_version = {{SCHEMA_VERSION}};
