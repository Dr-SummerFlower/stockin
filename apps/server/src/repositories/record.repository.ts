/**
 * `records` 表全部 SQL（SQL 唯一落点之一）。
 *
 * 依据：设计文档 v1.1 §4.2 / §4.3 / §4.4 / §5.2 ——
 * 每条查询显式 `deleted_at IS NULL`；金额以分整数存储、禁止浮点累加；
 * SQL 内禁 `date('now')` / `CURRENT_DATE`，基准日与边界常量由应用层注入；
 * 八项判重用普通部分索引探测 + `IS` 做 NULL 安全等值；
 * 单遍条件聚合 6 组指标；导出走游标 `iterate()`，**禁止 all() 整表缓冲**。
 */
import {
  DEFAULT_EXPIRY_THRESHOLD_DAYS,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type DashboardMetrics,
  type RecordFields,
  type RecordFilter,
  type RecordSources,
} from '@stockin/shared';
import { addDays, normalizeName, normalizeSpec } from '@stockin/domain';
import type { Db } from './db';
import { toDbSourceFlags, type DbSourceFlags, type RecordRow, type WriteContext } from './types';

/** 有界分页结果。 */
export interface RecordPage {
  readonly rows: readonly RecordRow[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

/**
 * B3：排序字段白名单（与 shared 的 RECORD_SORT_FIELDS 一一对应）。
 * `remainingDays` 与 `expiry_date` 单调等价，空到期日统一沉底；
 * `expiryStatus` 需要注入 today / nearEnd 常量，在 listActive 里单独构造 CASE 表达式。
 * 所有列名都来自本表常量，不含外部输入，可安全拼接。
 */
const SORT_COLUMNS: Readonly<Record<string, string>> = {
  purchaseDate: 'purchase_date',
  expiryDate: 'expiry_date',
  createdAt: 'created_at',
  name: 'name_norm',
  spec: 'spec_norm',
  quantity: 'quantity',
  amountCents: 'amount_cents',
};

function clampPageSize(raw: number | undefined): number {
  if (raw === undefined || !Number.isInteger(raw) || raw < 1) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(raw, MAX_PAGE_SIZE);
}

function clampPage(raw: number | undefined): number {
  return raw !== undefined && Number.isInteger(raw) && raw >= 1 ? raw : 1;
}

/**
 * 组装筛选条件。**SQL 内不对列做函数运算**，所有边界是应用层传入的常量；
 * 常规查询恒带 `deleted_at IS NULL`。
 */
function buildFilter(
  filter: RecordFilter,
  today: string,
  thresholdDays: number,
): { where: string; params: unknown[] } {
  const clauses: string[] = ['deleted_at IS NULL'];
  const params: unknown[] = [];

  if (filter.name !== undefined && filter.name.trim() !== '') {
    clauses.push('name_norm LIKE ?');
    params.push(`${normalizeName(filter.name)}%`);
  }
  if (filter.spec !== undefined && filter.spec.trim() !== '') {
    clauses.push('spec_norm LIKE ?');
    params.push(`${normalizeSpec(filter.spec)}%`);
  }
  if (filter.purchaseDateFrom !== undefined && filter.purchaseDateFrom !== '') {
    clauses.push('purchase_date >= ?');
    params.push(filter.purchaseDateFrom);
  }
  if (filter.purchaseDateTo !== undefined && filter.purchaseDateTo !== '') {
    clauses.push('purchase_date <= ?');
    params.push(filter.purchaseDateTo);
  }
  if (filter.expiryDateFrom !== undefined && filter.expiryDateFrom !== '') {
    clauses.push('expiry_date >= ?');
    params.push(filter.expiryDateFrom);
  }
  if (filter.expiryDateTo !== undefined && filter.expiryDateTo !== '') {
    clauses.push('expiry_date <= ?');
    params.push(filter.expiryDateTo);
  }

  // 临期/过期边界由 domain.addDays 在应用层算成常量（含等号 0 <= d <= X）。
  if (filter.expiryStatus === 'near') {
    clauses.push('expiry_date >= ? AND expiry_date <= ?');
    params.push(today, addDays(today, thresholdDays));
  } else if (filter.expiryStatus === 'expired') {
    clauses.push('expiry_date IS NOT NULL AND expiry_date < ?');
    params.push(today);
  } else if (filter.expiryStatus === 'none') {
    clauses.push('(expiry_date IS NULL OR expiry_date > ?)');
    params.push(addDays(today, thresholdDays));
  }

  return { where: clauses.join(' AND '), params };
}

/**
 * B2：预警清单筛选条件唯一组装点，COUNT 与分页扫描共用。
 * 全量 = 过期（< today）+ 临期（today ≤ expiry_date ≤ nearEnd），两者天然按到期日升序衔接。
 */
function buildRiskWhere(
  today: string,
  nearEnd: string,
  status?: 'near' | 'expired',
): { where: string; params: unknown[] } {
  const clauses: string[] = ['deleted_at IS NULL', 'expiry_date IS NOT NULL', 'expiry_date <= ?'];
  const params: unknown[] = [nearEnd];
  if (status === 'near') {
    clauses.push('expiry_date >= ?');
    params.push(today);
  } else if (status === 'expired') {
    clauses.push('expiry_date < ?');
    params.push(today);
  }
  return { where: clauses.join(' AND '), params };
}

export class RecordRepository {
  constructor(private readonly db: Db) {}

  private row(sql: string, ...params: unknown[]): RecordRow | null {
    return (this.db.prepare(sql).get(...params) as RecordRow | undefined) ?? null;
  }

  /** `all()` 仅用于有界分页（pageSize <= MAX_PAGE_SIZE）；导出必须走 iterate()。 */
  private rows(sql: string, ...params: unknown[]): RecordRow[] {
    return this.db.prepare(sql).all(...params) as RecordRow[];
  }

  private scalar(sql: string, ...params: unknown[]): number {
    const result = this.db.prepare(sql).get(...params) as { c: number } | undefined;
    return result?.c ?? 0;
  }

  /**
   * 新建记录。name_norm / spec_norm 由 domain 归一化真源生成；
   * created_at / updated_at 由 WriteContext 注入 UTC ISO 8601 文本。
   */
  create(fields: RecordFields, sources: RecordSources, ctx: WriteContext): number {
    const flags: DbSourceFlags = toDbSourceFlags(sources);
    const sql = `INSERT INTO records (
      name, name_norm, purchase_date, production_date,
      shelf_life_value, shelf_life_unit, expiry_date,
      spec, spec_norm, unit_price, quantity, amount_cents, remark,
      production_date_src, shelf_life_src, expiry_date_src,
      unit_price_src, quantity_src, amount_src,
      version, deleted_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`;
    const result = this.db
      .prepare(sql)
      .run(
        fields.name,
        normalizeName(fields.name),
        fields.purchaseDate,
        fields.productionDate,
        fields.shelfLifeValue,
        fields.shelfLifeUnit,
        fields.expiryDate,
        fields.spec,
        normalizeSpec(fields.spec),
        fields.unitPrice,
        fields.quantity,
        fields.amountCents,
        fields.remark,
        flags.production_date_src,
        flags.shelf_life_src,
        flags.expiry_date_src,
        flags.unit_price_src,
        flags.quantity_src,
        flags.amount_src,
        ctx.occurredAt,
        ctx.occurredAt,
      );
    return Number(result.lastInsertRowid);
  }

  /** 按 id 查询；常规路径显式排除软删。 */
  findById(id: number, includeDeleted: boolean = false): RecordRow | null {
    const sql: string = includeDeleted
      ? 'SELECT * FROM records WHERE id = ?'
      : 'SELECT * FROM records WHERE id = ? AND deleted_at IS NULL';
    return this.row(sql, id);
  }

  /** 乐观锁 CAS 更新；返回 false 表示版本冲突或记录已软删。 */
  update(
    id: number,
    fields: RecordFields,
    sources: RecordSources,
    version: number,
    ctx: WriteContext,
  ): boolean {
    const flags: DbSourceFlags = toDbSourceFlags(sources);
    const sql = `UPDATE records SET
      name = ?, name_norm = ?, purchase_date = ?, production_date = ?,
      shelf_life_value = ?, shelf_life_unit = ?, expiry_date = ?,
      spec = ?, spec_norm = ?, unit_price = ?, quantity = ?, amount_cents = ?, remark = ?,
      production_date_src = ?, shelf_life_src = ?, expiry_date_src = ?,
      unit_price_src = ?, quantity_src = ?, amount_src = ?,
      version = version + 1, updated_at = ?
      WHERE id = ? AND version = ? AND deleted_at IS NULL`;
    const result = this.db
      .prepare(sql)
      .run(
        fields.name,
        normalizeName(fields.name),
        fields.purchaseDate,
        fields.productionDate,
        fields.shelfLifeValue,
        fields.shelfLifeUnit,
        fields.expiryDate,
        fields.spec,
        normalizeSpec(fields.spec),
        fields.unitPrice,
        fields.quantity,
        fields.amountCents,
        fields.remark,
        flags.production_date_src,
        flags.shelf_life_src,
        flags.expiry_date_src,
        flags.unit_price_src,
        flags.quantity_src,
        flags.amount_src,
        ctx.occurredAt,
        id,
        version,
      );
    return result.changes > 0;
  }

  /** 批量软删（只对有效记录生效），返回实际软删条数。 */
  softDelete(ids: readonly number[], ctx: WriteContext): number {
    if (ids.length === 0) {
      return 0;
    }
    const placeholders: string = ids.map(() => '?').join(', ');
    const sql = `UPDATE records SET deleted_at = ?, updated_at = ?, version = version + 1
      WHERE deleted_at IS NULL AND id IN (${placeholders})`;
    return this.db.prepare(sql).run(ctx.occurredAt, ctx.occurredAt, ...ids).changes;
  }

  /** 回收站恢复：保留原字段与来源标记，只清 deleted_at。 */
  restore(id: number, ctx: WriteContext): boolean {
    const sql = `UPDATE records SET deleted_at = NULL, updated_at = ?, version = version + 1
      WHERE id = ? AND deleted_at IS NOT NULL`;
    return this.db.prepare(sql).run(ctx.occurredAt, id).changes > 0;
  }

  /** 彻底删除（二次确认在前端）；只允许删回收站条目。 */
  purge(id: number): boolean {
    return (
      this.db.prepare('DELETE FROM records WHERE id = ? AND deleted_at IS NOT NULL').run(id)
        .changes > 0
    );
  }

  /** B4：批量恢复，返回实际恢复条数（已恢复的 id 幂等跳过）。 */
  restoreMany(ids: readonly number[], ctx: WriteContext): number {
    if (ids.length === 0) {
      return 0;
    }
    const placeholders: string = ids.map(() => '?').join(', ');
    const sql = `UPDATE records SET deleted_at = NULL, updated_at = ?, version = version + 1
      WHERE deleted_at IS NOT NULL AND id IN (${placeholders})`;
    return this.db.prepare(sql).run(ctx.occurredAt, ...ids).changes;
  }

  /** B4：批量彻底删除，只对回收站条目生效。 */
  purgeMany(ids: readonly number[]): number {
    if (ids.length === 0) {
      return 0;
    }
    const placeholders: string = ids.map(() => '?').join(', ');
    const sql = `DELETE FROM records WHERE deleted_at IS NOT NULL AND id IN (${placeholders})`;
    return this.db.prepare(sql).run(...ids).changes;
  }

  /** 有效记录分页列表（恒带 deleted_at IS NULL）。 */
  listActive(filter: RecordFilter, today: string, thresholdDays: number): RecordPage {
    const { where, params } = buildFilter(filter, today, thresholdDays);
    const page: number = clampPage(filter.page);
    const pageSize: number = clampPageSize(filter.pageSize);
    const sortBy: string = filter.sortBy ?? 'purchaseDate';
    const direction: 'ASC' | 'DESC' = filter.sortOrder === 'asc' ? 'ASC' : 'DESC';
    // ORDER BY 的占位符排在 WHERE 之后、LIMIT/OFFSET 之前，参数顺序必须一致。
    const orderParams: unknown[] = [];
    let sortExpr: string = SORT_COLUMNS[sortBy] ?? 'purchase_date';
    if (sortBy === 'remainingDays') {
      // 剩余天数与到期日单调等价；无到期日的记录恒定沉底（与方向无关）。
      sortExpr = `CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END ASC, expiry_date`;
    } else if (sortBy === 'expiryStatus') {
      // 0=过期 / 1=临期 / 2=正常或无到期日，边界常量由应用层注入。
      sortExpr =
        'CASE WHEN expiry_date IS NULL THEN 2 WHEN expiry_date < ? THEN 0 WHEN expiry_date <= ? THEN 1 ELSE 2 END';
      orderParams.push(today, addDays(today, thresholdDays));
    }
    const total: number = this.scalar(
      `SELECT COUNT(*) AS c FROM records WHERE ${where}`,
      ...params,
    );
    // sortExpr / direction 来自白名单，不是外部输入，可安全拼接。
    const rows: RecordRow[] = this.rows(
      `SELECT * FROM records WHERE ${where} ORDER BY ${sortExpr} ${direction}, id ${direction} LIMIT ? OFFSET ?`,
      ...params,
      ...orderParams,
      pageSize,
      (page - 1) * pageSize,
    );
    return { rows, total, page, pageSize };
  }

  /** 回收站分页列表（显式 deleted_at IS NOT NULL）。 */
  listTrash(page: number = 1, pageSize: number = DEFAULT_PAGE_SIZE): RecordPage {
    const safePage: number = clampPage(page);
    const safeSize: number = clampPageSize(pageSize);
    const total: number = this.scalar(
      'SELECT COUNT(*) AS c FROM records WHERE deleted_at IS NOT NULL',
    );
    const rows: RecordRow[] = this.rows(
      `SELECT * FROM records WHERE deleted_at IS NOT NULL
       ORDER BY deleted_at DESC, id DESC LIMIT ? OFFSET ?`,
      safeSize,
      (safePage - 1) * safeSize,
    );
    return { rows, total, page: safePage, pageSize: safeSize };
  }

  countActive(): number {
    return this.scalar('SELECT COUNT(*) AS c FROM records WHERE deleted_at IS NULL');
  }

  countTrash(): number {
    return this.scalar('SELECT COUNT(*) AS c FROM records WHERE deleted_at IS NOT NULL');
  }

  /**
   * 八项判重探测（库内）。八项 = 商品名 + 进货日期 + 生产日期 + 到期日期 +
   * 规格 + 单价 + 数量 + 金额；备注与保质期**不参与**；回收站由
   * `deleted_at IS NULL` 排除。可空列用 `IS ?` 做 NULL 安全等值。
   */
  probeDuplicate(fields: RecordFields): boolean {
    const sql = `SELECT 1 AS hit FROM records
      WHERE deleted_at IS NULL
        AND name_norm = ?
        AND purchase_date = ?
        AND production_date IS ?
        AND expiry_date IS ?
        AND spec_norm = ?
        AND unit_price = ?
        AND quantity = ?
        AND amount_cents = ?
      LIMIT 1`;
    const hit = this.db
      .prepare(sql)
      .get(
        normalizeName(fields.name),
        fields.purchaseDate,
        fields.productionDate,
        fields.expiryDate,
        normalizeSpec(fields.spec),
        fields.unitPrice,
        fields.quantity,
        fields.amountCents,
      ) as { hit: number } | undefined;
    return hit !== undefined;
  }

  /** 批量库内判重（prepared statement 复用，供导入整批调用）。 */
  probeDuplicates(list: readonly RecordFields[]): boolean[] {
    return list.map((fields) => this.probeDuplicate(fields));
  }

  /**
   * 单遍条件聚合 6 组指标（文档 §3.6 性能要求）。
   * 临期边界 `today + X` 由 domain.addDays 在应用层算成常量；
   * 分类语义与 domain.classifyExpiry 一致（0 <= d <= X 含等号，d < 0 过期）。
   * 阈值注入后与 domain.aggregateRules 结果一致（内联自测交叉验证）。
   */
  aggregateSql(today: string, thresholdDays: number): DashboardMetrics {
    const nearEnd: string = addDays(today, thresholdDays);
    const sql = `SELECT
      COALESCE(SUM(amount_cents), 0) AS totalAmountCents,
      COUNT(*) AS totalRecords,
      COUNT(DISTINCT name_norm) AS distinctProducts,
      COALESCE(SUM(quantity), 0) AS totalQuantity,
      COALESCE(SUM(CASE WHEN expiry_date IS NOT NULL AND expiry_date >= ? AND expiry_date <= ? THEN 1 ELSE 0 END), 0) AS nearExpiryCount,
      COALESCE(SUM(CASE WHEN expiry_date IS NOT NULL AND expiry_date >= ? AND expiry_date <= ? THEN amount_cents ELSE 0 END), 0) AS nearExpiryAmountCents,
      COALESCE(SUM(CASE WHEN expiry_date IS NOT NULL AND expiry_date < ? THEN 1 ELSE 0 END), 0) AS expiredCount,
      COALESCE(SUM(CASE WHEN expiry_date IS NOT NULL AND expiry_date < ? THEN amount_cents ELSE 0 END), 0) AS expiredAmountCents
      FROM records WHERE deleted_at IS NULL`;
    const row = this.db.prepare(sql).get(today, nearEnd, today, nearEnd, today, today) as
      | DashboardMetrics
      | undefined;
    if (row === undefined) {
      throw new Error('[record.repository] 条件聚合未返回行');
    }
    return row;
  }

  /** 到期日区间索引扫描（裸列比较，SQL 内无函数运算）。 */
  scanExpiryRange(
    from: string,
    to: string,
    limit: number,
    offset: number = 0,
  ): readonly RecordRow[] {
    return this.rows(
      `SELECT * FROM records
       WHERE deleted_at IS NULL AND expiry_date IS NOT NULL
         AND expiry_date >= ? AND expiry_date <= ?
       ORDER BY expiry_date ASC, id ASC LIMIT ? OFFSET ?`,
      from,
      to,
      limit,
      offset,
    );
  }

  /** B2：预警清单同筛选条件 COUNT（不再受 1000 条一次性扫描上限影响）。 */
  countExpiryAlerts(today: string, nearEnd: string, status?: 'near' | 'expired'): number {
    const { where, params } = buildRiskWhere(today, nearEnd, status);
    return this.scalar(`SELECT COUNT(*) AS c FROM records WHERE ${where}`, ...params);
  }

  /** B2：预警清单分页扫描，按到期日升序由服务端排定，前端不二次排序。 */
  scanExpiryAlerts(
    today: string,
    nearEnd: string,
    status: 'near' | 'expired' | undefined,
    limit: number,
    offset: number,
  ): readonly RecordRow[] {
    const { where, params } = buildRiskWhere(today, nearEnd, status);
    return this.rows(
      `SELECT * FROM records WHERE ${where}
       ORDER BY expiry_date ASC, id ASC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    );
  }

  /**
   * 导出专用游标：逐行迭代，**禁止 all() 整表缓冲**。
   * 供 T03b 的 StreamingWorkbookWriter 与 domain.aggregateRules 兜底校验共用。
   */
  iterate(
    filter: RecordFilter = {},
    today: string = '1970-01-01',
    thresholdDays: number = DEFAULT_EXPIRY_THRESHOLD_DAYS,
  ): IterableIterator<RecordRow> {
    const { where, params } = buildFilter(filter, today, thresholdDays);
    const stmt = this.db.prepare(
      `SELECT * FROM records WHERE ${where} ORDER BY purchase_date ASC, id ASC`,
    );
    return stmt.iterate(...params) as IterableIterator<RecordRow>;
  }
}
