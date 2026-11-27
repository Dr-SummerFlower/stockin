/**
 * 仪表盘增量统计仓储（派生表读写）。
 *
 * 三张表都由 `006` 里的触发器逐行维护，本仓储只负责：
 *   * 读（`metrics`）：把三张表拼成 6 组指标；
 *   * 重建（`rebuild`）：迁移播种、全量恢复之后、自检发现漂移时从 `records` 重算。
 *
 * 为什么不让仪表盘继续走 `RecordRepository.aggregateSql`：那是一次整表聚合，
 * 12 万行下每次刷新约 12 万行读取，而 Workers 免费版每日只有 500 万行读取。
 * 走统计表后是「1 行 + 商品集合行数 + 区间内到期日桶数」，与总行数无关。
 *
 * `aggregateSql` 保留为**唯一权威口径**：`matchesAggregate` 用它做交叉校验，
 * 避免「触发器口径」和「聚合口径」悄悄分叉。
 */
import type { DashboardMetrics } from '@stockin/shared';
import { addDays } from '@stockin/domain';
import type { Db } from './db';
import { immediateTransaction } from './db';
import type { RecordRepository } from './record.repository';

export class RecordStatsRepository {
  constructor(
    private readonly db: Db,
    private readonly records: RecordRepository,
  ) {}

  /**
   * 从 `records` 全量重算三张统计表（调用方已处于事务内时用这个版本）。
   *
   * 刻意不接受 `today` / `thresholdDays`：总量、商品集合、到期日分桶都与「今天」
   * 无关，临期/过期是读取时按基准日切分的。这样重建在恢复事务里也能直接调用。
   */
  rebuildInTransaction(): void {
    this.db.exec('DELETE FROM record_stats');
    this.db.exec('DELETE FROM record_product_stats');
    this.db.exec('DELETE FROM record_expiry_stats');

    this.db.exec(
      `INSERT INTO record_stats (id, active_records, total_amount_cents, total_quantity)
       SELECT 1, COUNT(*), COALESCE(SUM(amount_cents), 0), COALESCE(SUM(quantity), 0)
         FROM records WHERE deleted_at IS NULL`,
    );
    this.db.exec(
      `INSERT INTO record_product_stats (name_norm, active_count)
       SELECT name_norm, COUNT(*) FROM records
        WHERE deleted_at IS NULL
        GROUP BY name_norm`,
    );
    // 到期日只入非空桶：空值的记录不计入临期/过期（与 aggregateSql 的 CASE 一致）。
    this.db.exec(
      `INSERT INTO record_expiry_stats (expiry_date, cnt, amount_cents)
       SELECT expiry_date, COUNT(*), COALESCE(SUM(amount_cents), 0) FROM records
        WHERE deleted_at IS NULL AND expiry_date IS NOT NULL
        GROUP BY expiry_date`,
    );
  }

  /** 独立事务版本（迁移播种 / 自检修复用）。 */
  rebuild(): void {
    immediateTransaction(this.db, () => {
      this.rebuildInTransaction();
    });
  }

  /**
   * 读 6 组指标。
   *
   * 临期 = 到期日在 `[today, today+X]`（含两端），过期 = 到期日 `< today`：
   * 与 `domain.classifyExpiry` 的 `0 <= d <= X` / `d < 0` 完全一致，
   * 只是把「逐行判断」换成了「按到期日分桶后区间求和」。
   */
  metrics(today: string, thresholdDays: number): DashboardMetrics {
    const nearEnd: string = addDays(today, thresholdDays);
    const row = this.db
      .prepare(
        `SELECT
           COALESCE((SELECT total_amount_cents FROM record_stats WHERE id = 1), 0) AS totalAmountCents,
           COALESCE((SELECT active_records     FROM record_stats WHERE id = 1), 0) AS totalRecords,
           (SELECT COUNT(*) FROM record_product_stats)                                AS distinctProducts,
           COALESCE((SELECT total_quantity     FROM record_stats WHERE id = 1), 0) AS totalQuantity,
           COALESCE((SELECT SUM(cnt)          FROM record_expiry_stats
                      WHERE expiry_date >= ? AND expiry_date <= ?), 0)             AS nearExpiryCount,
           COALESCE((SELECT SUM(amount_cents) FROM record_expiry_stats
                      WHERE expiry_date >= ? AND expiry_date <= ?), 0)             AS nearExpiryAmountCents,
           COALESCE((SELECT SUM(cnt)          FROM record_expiry_stats
                      WHERE expiry_date < ?), 0)                                   AS expiredCount,
           COALESCE((SELECT SUM(amount_cents) FROM record_expiry_stats
                      WHERE expiry_date < ?), 0)                                   AS expiredAmountCents`,
      )
      .get(today, nearEnd, today, nearEnd, today, today) as DashboardMetrics | undefined;
    if (row === undefined) {
      throw new Error('[record-stats] 指标查询未返回行');
    }
    return row;
  }

  /** 统计表当前是否与 `records` 的聚合口径一致（自检 / 测试用）。 */
  matchesAggregate(today: string, thresholdDays: number): boolean {
    const expected: DashboardMetrics = this.records.aggregateSql(today, thresholdDays);
    const actual: DashboardMetrics = this.metrics(today, thresholdDays);
    return (
      actual.totalAmountCents === expected.totalAmountCents &&
      actual.totalRecords === expected.totalRecords &&
      actual.distinctProducts === expected.distinctProducts &&
      actual.totalQuantity === expected.totalQuantity &&
      actual.nearExpiryCount === expected.nearExpiryCount &&
      actual.nearExpiryAmountCents === expected.nearExpiryAmountCents &&
      actual.expiredCount === expected.expiredCount &&
      actual.expiredAmountCents === expected.expiredAmountCents
    );
  }
}
