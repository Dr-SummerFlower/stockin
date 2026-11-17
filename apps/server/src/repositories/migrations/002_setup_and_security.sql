-- 002_setup_and_security.sql — 自助引导与账号安全字段
--
-- 依据：Phase 1 自助引导初始化 + 密保问题（忘记密码）。
--
-- 硬约束：
--   * 只用 ADD COLUMN，不改既有列、不删列、不重建表；
--   * 时间戳仍由应用层注入，本文件不出现任何日期函数；
--   * 新增列一律带 DEFAULT，保证 1→2 就地升级时老行可读。

-- 店铺名称（自助引导时收集，设置页可改）；空串表示未设置。
ALTER TABLE settings ADD COLUMN shop_name TEXT NOT NULL DEFAULT '';

-- 密保问题：存问题文本而非 key（预设文案或自定义原文），空串表示未设置。
ALTER TABLE credentials ADD COLUMN security_question TEXT NOT NULL DEFAULT '';
ALTER TABLE credentials ADD COLUMN security_answer_salt TEXT NOT NULL DEFAULT '';
ALTER TABLE credentials ADD COLUMN security_answer_hash TEXT NOT NULL DEFAULT '';

PRAGMA user_version = {{SCHEMA_VERSION}};
