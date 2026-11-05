/**
 * 统计大屏服务：**一个读事务快照**。
 *
 * 依据：设计文档 v1.1 §2.4 BR-5 / §3.5 / §5.2 ——
 * 取一次 `serverToday()` → 读阈值 X → 单遍聚合 6 组 → 到期日区间索引扫描取清单；
 * 临期/过期统一走 domain 的 `buildExpiryAlerts`（阈值 X 注入），
 * **不消费 `computeDateGroup` 的派生展示字段**；清单由服务端排定，前端不二次排序。
 */
import {
  IMPORT_MAX_ROWS,
  type DashboardMetrics,
  type DashboardResponse,
  type ExpiryAlertItem,
  type StatsExpiryResponse,
  type StatsSummaryResponse,
} from '@stockin/shared';
import { addDays, aggregateRules, buildExpiryAlerts, type AggregateRecord } from '@stockin/domain';
import type { Db } from '../repositories/db';
import { deferredTransaction } from '../repositories/db';
import type { RecordRepository } from '../repositories/record.repository';
import type { SettingsRepository } from '../repositories/settings.repository';
import { nullable, type RecordRow } from '../repositories/types';
import { serverToday } from '../lib/today';
import type { ServiceResult } from '../app';

export interface DashboardServiceDeps {
  readonly db: Db;
  readonly records: RecordRepository;
  readonly settings: SettingsRepository;
}

/** SQL 行 → domain 聚合输入（软删已由 scanExpiryRange 排除）。 */
function toAggregateRecord(row: RecordRow): AggregateRecord {
  return {
    id: row.id,
    name: row.name,
    spec: nullable(row.spec),
    nameNorm: row.name_norm,
    purchaseDate: row.purchase_date,
    productionDate: nullable(row.production_date),
    expiryDate: nullable(row.expiry_date),
    unitPrice: row.unit_price,
    quantity: row.quantity,
    amountCents: row.amount_cents,
    deletedAt: nullable(row.deleted_at),
  };
}

/** 统计大屏服务（单进程单例）。 */
export class DashboardService {
  constructor(private readonly deps: DashboardServiceDeps) {}

  /**
   * 一个 DEFERRED 读事务快照：今天、阈值、指标、清单全部取自同一瞬间。
   * 6 组指标走 Repository 的单遍条件聚合 SQL（与 domain.aggregateRules 口径一致）。
   */
  snapshot(): ServiceResult<DashboardResponse> {
    const data: DashboardResponse = deferredTransaction(this.deps.db, () => {
      const baseDate: string = serverToday();
      const thresholdDays: number = this.deps.settings.getThresholdDays();
      const metrics: DashboardMetrics = this.deps.records.aggregateSql(baseDate, thresholdDays);

      // 一次区间索引扫描覆盖「全部过期 + 全部临期」，上限保护内存。
      const rows: readonly RecordRow[] = this.deps.records.scanExpiryRange(
        '0000-01-01',
        addDays(baseDate, thresholdDays),
        IMPORT_MAX_ROWS,
        0,
      );
      const alerts: ExpiryAlertItem[] = buildExpiryAlerts(
        rows.map(toAggregateRecord),
        baseDate,
        thresholdDays,
      );
      return { metrics, alerts, thresholdDays, baseDate };
    });
    return { ok: true, data };
  }

  /** GET /api/stats/summary */
  summary(): ServiceResult<StatsSummaryResponse> {
    const result = this.snapshot();
    if (!result.ok) {
      return result;
    }
    return {
      ok: true,
      data: {
        metrics: result.data.metrics,
        baseDate: result.data.baseDate,
        thresholdDays: result.data.thresholdDays,
      },
    };
  }

  /** GET /api/stats/expiry */
  expiry(): ServiceResult<StatsExpiryResponse> {
    const result = this.snapshot();
    if (!result.ok) {
      return result;
    }
    return {
      ok: true,
      data: {
        alerts: result.data.alerts,
        thresholdDays: result.data.thresholdDays,
        baseDate: result.data.baseDate,
      },
    };
  }

  /**
   * 供自测交叉验证：用 domain.aggregateRules 对同一批有效记录重算 6 组指标，
   * 必须与 snapshot() 的 SQL 单遍聚合逐字段相等。
   */
  crossCheckWithDomain(): { sql: DashboardMetrics; rules: DashboardMetrics; equal: boolean } {
    return deferredTransaction(this.deps.db, () => {
      const baseDate: string = serverToday();
      const thresholdDays: number = this.deps.settings.getThresholdDays();
      const sql: DashboardMetrics = this.deps.records.aggregateSql(baseDate, thresholdDays);
      const rows: AggregateRecord[] = [];
      for (const row of this.deps.records.iterate({}, baseDate, thresholdDays)) {
        rows.push(toAggregateRecord(row));
      }
      const rules: DashboardMetrics = aggregateRules(rows, baseDate, thresholdDays);
      const keys: readonly (keyof DashboardMetrics)[] = [
        'totalAmountCents',
        'totalRecords',
        'distinctProducts',
        'totalQuantity',
        'nearExpiryCount',
        'nearExpiryAmountCents',
        'expiredCount',
        'expiredAmountCents',
      ];
      const equal: boolean = keys.every((key) => sql[key] === rules[key]);
      return { sql, rules, equal };
    });
  }
}
