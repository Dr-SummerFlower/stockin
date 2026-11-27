-- 006_backup_keys_and_record_stats.sql — 备份公钥落库 + 仪表盘增量统计
--
-- 两件事：
--  ① 备份公钥可以落库并在管理台维护。此前公钥只能通过 env / Secret 配置，
--     轮换必须重新部署才能让 Worker 看见新公钥。
--  ② 仪表盘指标改增量维护。此前每次刷新都整表聚合（12 万行下约 12 万行读取），
--     在「只写不恢复、连跑 5 年」的场景里会撞上 Workers 免费版每日 500 万行读取。
--
-- 这两组表都**不在** RESTORE_TABLES 里，全量恢复不会清空它们：
--   * `backup_keys` 描述「本实例信任哪些公钥」，属于实例级配置，不该被业务备份
--     覆盖（否则恢复一份旧备份会把后来新增的公钥一起回滚掉）；
--   * 统计表是派生数据，恢复后由 `rebuildRecordStats()` 从 records 重算，
--     回填旧备份里的统计等于把陈旧数字写进新库。

-- -------------------------------------------------------------- 备份公钥 ----
CREATE TABLE IF NOT EXISTS backup_keys (
  key_id       TEXT    PRIMARY KEY,
  public_key   TEXT    NOT NULL,
  label        TEXT    NOT NULL DEFAULT '',
  is_active    INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  created_at   TEXT    NOT NULL,
  activated_at TEXT,
  CONSTRAINT uq_backup_keys_public_key UNIQUE (public_key)
);

-- 同一时刻只允许一把「加密用」公钥；其余公钥仅参与恢复票据验签（轮换过渡期）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_backup_keys_active
  ON backup_keys (is_active) WHERE is_active = 1;

-- -------------------------------------------------- 仪表盘增量统计（派生表）----
-- 单行总量：活跃记录数、金额合计、数量合计。
CREATE TABLE IF NOT EXISTS record_stats (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  active_records     INTEGER NOT NULL DEFAULT 0,
  total_amount_cents INTEGER NOT NULL DEFAULT 0,
  total_quantity     INTEGER NOT NULL DEFAULT 0
);

-- 商品去重集合：`COUNT(*)` 即「不同商品数」，比 `COUNT(DISTINCT name_norm)` 便宜两个量级。
CREATE TABLE IF NOT EXISTS record_product_stats (
  name_norm    TEXT    PRIMARY KEY,
  active_count INTEGER NOT NULL
);

-- 按到期日分桶：临期/过期依赖「今天」，只能靠分桶做区间求和，不能合成单行计数器。
CREATE TABLE IF NOT EXISTS record_expiry_stats (
  expiry_date  TEXT    PRIMARY KEY,
  cnt          INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL
);

-- 以下 7 个触发器维护上面三张表。逐行增量，写放大很小（每天几十条记录），
-- 换来仪表盘 O(桶数) 而不是 O(行数)。
--
-- 为什么用触发器而不是在各仓储方法里手写增量：写路径有 6 处（新增、批量导入、
-- 修改、软删、回收站恢复、彻底删除），漏一处就会静默漂移 —— 数字错了比慢更糟。

CREATE TRIGGER IF NOT EXISTS trg_records_stats_ins
AFTER INSERT ON records
WHEN NEW.deleted_at IS NULL
BEGIN
  INSERT INTO record_stats (id, active_records, total_amount_cents, total_quantity)
    VALUES (1, 1, NEW.amount_cents, NEW.quantity)
    ON CONFLICT (id) DO UPDATE SET
      active_records     = active_records + 1,
      total_amount_cents = total_amount_cents + NEW.amount_cents,
      total_quantity     = total_quantity + NEW.quantity;

  INSERT INTO record_product_stats (name_norm, active_count)
    VALUES (NEW.name_norm, 1)
    ON CONFLICT (name_norm) DO UPDATE SET active_count = active_count + 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_records_stats_ins_exp
AFTER INSERT ON records
WHEN NEW.deleted_at IS NULL AND NEW.expiry_date IS NOT NULL
BEGIN
  INSERT INTO record_expiry_stats (expiry_date, cnt, amount_cents)
    VALUES (NEW.expiry_date, 1, NEW.amount_cents)
    ON CONFLICT (expiry_date) DO UPDATE SET
      cnt          = cnt + 1,
      amount_cents = amount_cents + NEW.amount_cents;
END;

-- 「撤销一条活跃行」的三个动作被删除与更新共用；SQL 不支持子程序，
-- 只能在本文件里重复两遍（触发器体内的语句必须字面展开）。
CREATE TRIGGER IF NOT EXISTS trg_records_stats_del
AFTER DELETE ON records
WHEN OLD.deleted_at IS NULL
BEGIN
  UPDATE record_stats SET
    active_records     = active_records - 1,
    total_amount_cents = total_amount_cents - OLD.amount_cents,
    total_quantity     = total_quantity - OLD.quantity
   WHERE id = 1;

  UPDATE record_product_stats SET active_count = active_count - 1
   WHERE name_norm = OLD.name_norm;
  DELETE FROM record_product_stats WHERE active_count <= 0;
END;

CREATE TRIGGER IF NOT EXISTS trg_records_stats_del_exp
AFTER DELETE ON records
WHEN OLD.deleted_at IS NULL AND OLD.expiry_date IS NOT NULL
BEGIN
  UPDATE record_expiry_stats SET
    cnt          = cnt - 1,
    amount_cents = amount_cents - OLD.amount_cents
   WHERE expiry_date = OLD.expiry_date;
  DELETE FROM record_expiry_stats WHERE cnt <= 0;
END;

CREATE TRIGGER IF NOT EXISTS trg_records_stats_upd_old
AFTER UPDATE ON records
WHEN OLD.deleted_at IS NULL
BEGIN
  UPDATE record_stats SET
    active_records     = active_records - 1,
    total_amount_cents = total_amount_cents - OLD.amount_cents,
    total_quantity     = total_quantity - OLD.quantity
   WHERE id = 1;

  UPDATE record_product_stats SET active_count = active_count - 1
   WHERE name_norm = OLD.name_norm;
  DELETE FROM record_product_stats WHERE active_count <= 0;

  UPDATE record_expiry_stats SET
    cnt          = cnt - 1,
    amount_cents = amount_cents - OLD.amount_cents
   WHERE OLD.expiry_date IS NOT NULL AND expiry_date = OLD.expiry_date;
  DELETE FROM record_expiry_stats WHERE cnt <= 0;
END;

-- 「记入一条活跃行」：必须用 UPSERT 而不是「不存在则 INSERT，再加 1」。
-- 后者在计数行被清零删除后再恢复（回收站还原）时会加两次 —— 实测踩过。
CREATE TRIGGER IF NOT EXISTS trg_records_stats_upd_new
AFTER UPDATE ON records
WHEN NEW.deleted_at IS NULL
BEGIN
  INSERT INTO record_stats (id, active_records, total_amount_cents, total_quantity)
    VALUES (1, 1, NEW.amount_cents, NEW.quantity)
    ON CONFLICT (id) DO UPDATE SET
      active_records     = active_records + 1,
      total_amount_cents = total_amount_cents + NEW.amount_cents,
      total_quantity     = total_quantity + NEW.quantity;

  INSERT INTO record_product_stats (name_norm, active_count)
    VALUES (NEW.name_norm, 1)
    ON CONFLICT (name_norm) DO UPDATE SET active_count = active_count + 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_records_stats_upd_new_exp
AFTER UPDATE ON records
WHEN NEW.deleted_at IS NULL AND NEW.expiry_date IS NOT NULL
BEGIN
  INSERT INTO record_expiry_stats (expiry_date, cnt, amount_cents)
    VALUES (NEW.expiry_date, 1, NEW.amount_cents)
    ON CONFLICT (expiry_date) DO UPDATE SET
      cnt          = cnt + 1,
      amount_cents = amount_cents + NEW.amount_cents;
END;

-- ------------------------------------------------------------------ 播种 ----
-- 老库升级：统计表是新建的，从既有记录回填一次。
-- 注意这些语句的目标是统计表而非 records，不会触发上面的触发器。
INSERT OR REPLACE INTO record_stats (id, active_records, total_amount_cents, total_quantity)
SELECT 1, COUNT(*), COALESCE(SUM(amount_cents), 0), COALESCE(SUM(quantity), 0)
  FROM records WHERE deleted_at IS NULL;

INSERT OR REPLACE INTO record_product_stats (name_norm, active_count)
SELECT name_norm, COUNT(*) FROM records
 WHERE deleted_at IS NULL
 GROUP BY name_norm;

INSERT OR REPLACE INTO record_expiry_stats (expiry_date, cnt, amount_cents)
SELECT expiry_date, COUNT(*), COALESCE(SUM(amount_cents), 0) FROM records
 WHERE deleted_at IS NULL AND expiry_date IS NOT NULL
 GROUP BY expiry_date;

PRAGMA user_version = {{SCHEMA_VERSION}};
