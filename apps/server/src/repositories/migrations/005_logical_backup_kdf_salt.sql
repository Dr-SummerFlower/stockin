-- 005_logical_backup_kdf_salt.sql — 幂等补齐 backups.kdf_salt
--
-- 背景：逻辑备份提交链中，004 曾就地新增 `kdf_salt TEXT NOT NULL`
-- （d8c2bbd 版 004 无此列，242a816 版加入），但 schema 版本一直停留在 4。
-- 于是存在两类 user_version=4 的库：
--   * 含列：跑过 242a816 版 004 的开发库 / Worker DO；
--   * 缺列：跑过 d8c2bbd 版 004 后未升级的库。
-- 两者都已越过 004，不会因版本比较重跑 004 的 CREATE TABLE。
--
-- 本迁移用幂等 ADD COLUMN 兼容三种起点：
--   * 全新库：004 已含列 → runner 检测到列存在，跳过本语句；
--   * 含列 v4 库：同样跳过；
--   * 缺列 v4 库：补上列（带 DEFAULT，兼容 backups 表已有行）。
-- 跳过逻辑由 migrations/runner.ts 的 makeAddColumnsIdempotent 统一提供，
-- 对所有迁移脚本生效（ADD COLUMN 的语义本就是「确保列存在」）。

ALTER TABLE backups ADD COLUMN kdf_salt TEXT NOT NULL DEFAULT '';

PRAGMA user_version = {{SCHEMA_VERSION}};
