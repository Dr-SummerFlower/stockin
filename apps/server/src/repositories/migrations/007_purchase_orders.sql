-- 007_purchase_orders.sql — 进货单（批次）表 + 记录的单据归属
--
-- 一张进货单 = 抬头（单号 / 供货商 / 进货日期 / 备注）+ N 条明细；
-- 每条明细就是既有的 `records` 行，只是多一个可空的 `order_id`。
--
-- 三条硬约束：
--  ① `records.order_id` 必须可空：历史数据与「单条补录」都是 NULL（散记），
--     SQLite 加列只能 `ALTER TABLE ... ADD COLUMN`，不能重建表。
--  ② `order_no` 不建唯一索引：个体商家会照抄纸质单号，允许当天同号多张。
--  ③ 统计口径（record_stats / record_product_stats / record_expiry_stats）
--     与其触发器一行都不动 —— 单据只做分组，不参与任何统计。

CREATE TABLE IF NOT EXISTS purchase_orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no      TEXT    NOT NULL,
  supplier      TEXT    NOT NULL,
  -- 与 records.name_norm 同一套归一化规则（NFKC + 折空白 + 小写），
  -- 否则「红星批发部 」与「红星批发部」会分裂成两个供货商。
  supplier_norm TEXT    NOT NULL,
  purchase_date TEXT    NOT NULL,
  remark        TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  deleted_at    TEXT,
  version       INTEGER NOT NULL DEFAULT 1
);

-- 活跃单据按进货日期倒序翻页（部分索引，与列表查询同序）。
CREATE INDEX IF NOT EXISTS idx_orders_date
  ON purchase_orders(purchase_date DESC, id DESC) WHERE deleted_at IS NULL;

-- 单号探测：next-no 取当日最大序号、创建前查同日同号（含回收站，避免复用已导出的号）。
CREATE INDEX IF NOT EXISTS idx_orders_no ON purchase_orders(order_no);

ALTER TABLE records ADD COLUMN order_id INTEGER REFERENCES purchase_orders(id);

-- 单据详情按 order_id 取明细；散记不进入索引。
CREATE INDEX IF NOT EXISTS idx_records_order
  ON records(order_id) WHERE order_id IS NOT NULL;

PRAGMA user_version = {{SCHEMA_VERSION}};
