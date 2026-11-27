/**
 * `purchase_orders` 表全部 SQL（单据侧的唯一 SQL 落点）。
 *
 * 依据：`.tmp/接口契约-进货单.md` §1 / §2、`.tmp/to-do/02-接口实现.md` B-04。
 *
 * 三条实现约束：
 *  ① 列表 + 三个汇总用**一条**聚合 SQL 出，禁止 N+1；`total` 用同一组 WHERE
 *     单独 `COUNT(*)`（带 GROUP BY 的查询不能直接数行）。
 *  ② `LEFT JOIN` 必须带 `r.deleted_at IS NULL`：单条明细被单独删掉后，
 *     品种数与合计要跟着变小，而单据本身还在。
 *  ③ 建单 = 1 张单 + N 条明细的单事务；`DbPort.transaction` 是同步的，
 *     所以归一化、日期覆盖等都要在进事务前算好。
 */
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type OrderFilter,
  type OrderView,
  type RecordFields,
  type RecordSources,
} from '@stockin/shared';
import { normalizeName } from '@stockin/domain';
import type { Db } from './db';
import { toOrderView, type OrderRow, type WriteContext } from './types';
import type { RecordRepository } from './record.repository';

/** 单据列表分页结果。 */
export interface OrderPage {
  readonly rows: readonly OrderRow[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

/** 建单入参：明细已由 Service 校验并覆盖单头日期。 */
export interface OrderWriteInput {
  readonly orderNo: string;
  readonly supplier: string;
  readonly purchaseDate: string;
  readonly remark: string | null;
  readonly items: readonly { readonly fields: RecordFields; readonly sources: RecordSources }[];
}

const ORDER_AGGREGATE_COLUMNS = `o.id            AS id,
  o.order_no      AS order_no,
  o.supplier      AS supplier,
  o.purchase_date AS purchase_date,
  o.remark        AS remark,
  o.created_at    AS created_at,
  o.updated_at    AS updated_at,
  o.version       AS version,
  COUNT(r.id)                   AS item_count,
  COALESCE(SUM(r.quantity), 0)  AS total_quantity,
  COALESCE(SUM(r.amount_cents), 0) AS total_amount_cents`;

const ORDER_AGGREGATE_FROM = `FROM purchase_orders o
  LEFT JOIN records r ON r.order_id = o.id AND r.deleted_at IS NULL`;

/** LIKE 通配符转义；用户输入中的 `%` / `_` 按普通字符处理。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function clampPage(page: number | undefined): number {
  return page !== undefined && Number.isInteger(page) && page >= 1 ? page : 1;
}

function clampPageSize(pageSize: number | undefined): number {
  if (pageSize === undefined || !Number.isInteger(pageSize) || pageSize < 1) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(pageSize, MAX_PAGE_SIZE);
}

/**
 * 组装筛选条件。`q` 的每个空白分隔词都必须在「单号 / 供货商 / 商品名」任一
 * 路径命中（词之间 OR，词与词之间 AND，与记录页的多词包含语义一致）。
 *
 * 商品名走 `EXISTS` 子查询而不是 join：明细 join 会让同一张单出现多行，
 * 品种数与合计都会被放大。
 */
function buildWhere(filter: OrderFilter): { where: string; params: unknown[] } {
  const clauses: string[] = ['o.deleted_at IS NULL'];
  const params: unknown[] = [];

  if (filter.supplier !== undefined && filter.supplier.trim() !== '') {
    clauses.push("o.supplier_norm LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(normalizeName(filter.supplier))}%`);
  }
  if (filter.purchaseDateFrom !== undefined && filter.purchaseDateFrom !== '') {
    clauses.push('o.purchase_date >= ?');
    params.push(filter.purchaseDateFrom);
  }
  if (filter.purchaseDateTo !== undefined && filter.purchaseDateTo !== '') {
    clauses.push('o.purchase_date <= ?');
    params.push(filter.purchaseDateTo);
  }
  const tokens: string[] = (filter.q ?? '')
    .trim()
    .split(/\s+/)
    .filter((token) => token !== '');
  for (const token of tokens) {
    const rawPattern = `%${escapeLike(token)}%`;
    const normPattern = `%${escapeLike(normalizeName(token))}%`;
    clauses.push(`(o.order_no LIKE ? ESCAPE '\\'
      OR o.supplier_norm LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM records rq
                  WHERE rq.order_id = o.id AND rq.deleted_at IS NULL
                    AND rq.name_norm LIKE ? ESCAPE '\\'))`);
    params.push(rawPattern, normPattern, normPattern);
  }

  return { where: clauses.join(' AND '), params };
}

export class OrderRepository {
  constructor(
    private readonly db: Db,
    private readonly records: RecordRepository,
  ) {}

  private scalar(sql: string, ...params: unknown[]): number {
    const row = this.db.prepare(sql).get(...params) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  /** 单据分页列表：一条聚合 SQL + 一次 COUNT，排序固定 `purchase_date DESC, id DESC`。 */
  list(filter: OrderFilter): OrderPage {
    const { where, params } = buildWhere(filter);
    const page: number = clampPage(filter.page);
    const pageSize: number = clampPageSize(filter.pageSize);
    const total: number = this.scalar(
      `SELECT COUNT(*) AS c FROM purchase_orders o WHERE ${where}`,
      ...params,
    );
    const rows = this.db
      .prepare(
        `SELECT ${ORDER_AGGREGATE_COLUMNS}
           ${ORDER_AGGREGATE_FROM}
          WHERE ${where}
          GROUP BY o.id
          ORDER BY o.purchase_date DESC, o.id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, (page - 1) * pageSize) as OrderRow[];
    return { rows, total, page, pageSize };
  }

  /** 单据抬头 + 汇总（未软删）；不存在返回 null。 */
  findView(id: number): OrderRow | null {
    const row = this.db
      .prepare(
        `SELECT ${ORDER_AGGREGATE_COLUMNS}
           ${ORDER_AGGREGATE_FROM}
          WHERE o.id = ? AND o.deleted_at IS NULL
          GROUP BY o.id`,
      )
      .get(id) as OrderRow | undefined;
    return row ?? null;
  }

  /** 这张单是否已在同一天存在（含回收站），用于「单号重复」提示。 */
  existsSameNo(orderNo: string, purchaseDate: string): boolean {
    const row = this.db
      .prepare(
        'SELECT 1 AS hit FROM purchase_orders WHERE order_no = ? AND purchase_date = ? LIMIT 1',
      )
      .get(orderNo, purchaseDate) as { hit: number } | undefined;
    return row !== undefined;
  }

  /**
   * 下一个单号：`YYYYMMDD` + 3 位当日序号（超过 999 自动 4 位）。
   *
   * 序号取**当日全部单据（含回收站）**的最大值 + 1，避免复用已经导出过的号
   * （照抄纸质单号允许重复，但自动生成的号不该撞已存在的）。
   */
  nextNo(date: string): string {
    const prefix: string = date.replaceAll('-', '');
    const row = this.db
      .prepare(
        `SELECT MAX(CAST(substr(order_no, 9) AS INTEGER)) AS max_seq
           FROM purchase_orders
          WHERE order_no LIKE ? AND substr(order_no, 9) GLOB '[0-9]*'`,
      )
      .get(`${prefix}%`) as { max_seq: number | null } | undefined;
    const next: number = (row?.max_seq ?? 0) + 1;
    return `${prefix}${String(next).padStart(3, '0')}`;
  }

  /**
   * 建单写库：1 条抬头 + N 条明细。
   *
   * **不开事务**：事务边界由 Service 用 `immediateTransaction` 统一开启，
   * 以便「抬头 + 明细 + 审计日志」落在同一个事务里（与 `record.service`
   * 的既有写法一致；`DbPort` 拒嵌套，仓储内再开事务会直接抛错）。
   * 明细的 10 个字段与 6 个来源位原样落库（服务端只校验不重算），
   * `purchase_date` 已由 Service 用单头日期覆盖。
   */
  create(input: OrderWriteInput, ctx: WriteContext): number {
    const inserted = this.db
      .prepare(
        `INSERT INTO purchase_orders
          (order_no, supplier, supplier_norm, purchase_date, remark,
           created_at, updated_at, deleted_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1)`,
      )
      .run(
        input.orderNo,
        input.supplier,
        normalizeName(input.supplier),
        input.purchaseDate,
        input.remark,
        ctx.occurredAt,
        ctx.occurredAt,
      );
    const orderId: number = Number(inserted.lastInsertRowid);
    for (const item of input.items) {
      this.records.create(item.fields, item.sources, ctx, orderId);
    }
    return orderId;
  }

  /**
   * 软删整单抬头：单据与其下全部有效明细一起进回收站。
   * 返回连带软删的明细条数；单据已删（或不存在）返回 null。
   * **不开事务**，理由同 `create()`。
   */
  softDelete(id: number, ctx: WriteContext): number | null {
    const affected = this.db
      .prepare(
        `UPDATE purchase_orders
            SET deleted_at = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(ctx.occurredAt, ctx.occurredAt, id).changes;
    if (affected === 0) {
      return null;
    }
    return this.records.softDeleteByOrder(id, ctx);
  }

  /**
   * 回收站恢复记录时把其所属的已软删单据一并复活（B-13 方案 A）。
   * 返回实际复活的单据数；单据仍有效时不做任何写入（幂等）。
   */
  restoreDeleted(ids: readonly number[], ctx: WriteContext): number {
    if (ids.length === 0) {
      return 0;
    }
    const placeholders: string = ids.map(() => '?').join(', ');
    return this.db
      .prepare(
        `UPDATE purchase_orders
            SET deleted_at = NULL, updated_at = ?, version = version + 1
          WHERE deleted_at IS NOT NULL AND id IN (${placeholders})`,
      )
      .run(ctx.occurredAt, ...ids).changes;
  }

  /** 回收站里这张单还有多少条明细被软删（详情页提示「另有 N 条已被删除」用）。 */
  countDeletedItems(id: number): number {
    return this.scalar(
      'SELECT COUNT(*) AS c FROM records WHERE order_id = ? AND deleted_at IS NOT NULL',
      id,
    );
  }

  /** 行 → 视图（唯一映射入口，避免 service 里再拼字段）。 */
  toView(row: OrderRow, duplicatedNo?: boolean): OrderView {
    return toOrderView(row, duplicatedNo);
  }
}
