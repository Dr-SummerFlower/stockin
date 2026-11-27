/**
 * 进货单（批次）业务服务。
 *
 * 依据：`.tmp/接口契约-进货单.md` §2、`.tmp/to-do/02-接口实现.md` B-05。
 *
 * 分工：
 *  - 校验：单头单独校验（供货商 1..100、日期合法、明细 1..200），
 *    明细复用 `recordSaveSchema` + `validateRecordFields`（与单条新增同一套规则），
 *    失败返回 422 并带 `details.index`（0 基）指明第几条；
 *  - 幂等：整单级 `idempotencyKey`，命中时**返回首次结果**（不是 409）；
 *  - 事务：一次 `immediateTransaction` 内写「抬头 + N 条明细 + 审计日志」，
 *    任一失败整单回滚，库里不留半张单；
 *  - 审计：只记 `ORDER_CREATE` / `ORDER_DELETE` 两条关键操作，
 *    「读上一张单」这类查询一律不写。
 */
import {
  Action,
  TARGET_TYPE,
  ErrorCode,
  IDEMPOTENCY_TTL_HOURS,
  ORDER_MAX_ITEMS,
  type OrderCreateInput,
  type OrderDetailView,
  type OrderFilter,
  type OrderNextNoResponse,
  type OrderView,
  type PageResult,
  type RecordFields,
  type RecordSources,
  type RecordView,
} from '@stockin/shared';
import { isValidISODate } from '@stockin/domain';
import type { Db } from '../repositories/db';
import { immediateTransaction } from '../repositories/db';
import type { OrderRepository, OrderWriteInput } from '../repositories/order.repository';
import type { RecordRepository } from '../repositories/record.repository';
import type { OperationLogRepository } from '../repositories/operation-log.repository';
import type { SettingsRepository } from '../repositories/settings.repository';
import { nullable, toRecordView, type RecordRow, type WriteContext } from '../repositories/types';
import { epochSeconds, serverToday, utcNowIso } from '../lib/today';
import { TtlMap } from '../lib/ttl-map';
import { validateRecordFields } from './record.service';
import type { ServiceResult } from '../app';

export interface OrderServiceDeps {
  readonly db: Db;
  readonly orders: OrderRepository;
  readonly records: RecordRepository;
  readonly logs: OperationLogRepository;
  /** 明细的 `expiryStatus` / `remainingDays` 要按当前阈值算，与记录页口径一致。 */
  readonly settings: SettingsRepository;
}

const IDEMPOTENCY_TTL_SECONDS: number = IDEMPOTENCY_TTL_HOURS * 3_600;

/**
 * 整单幂等快照（`idempotencyKey` → 首次成功的响应）。
 *
 * 与 `record.service` 同样用 `TtlMap`：快照过期后没有读取入口，裸 `Map` 会让
 * 「每次保存都换一个键」的流量把内存永久撑大。
 */
const idempotencyStore = new TtlMap<ServiceResult<OrderView>>();

/** 清空幂等快照（模块级单例，测试必须显式重置）。 */
export function resetOrderIdempotencyStore(): void {
  idempotencyStore.clear();
}

/** `OrderCreateInput.items[i]` → 落库字段（单头日期覆盖明细日期）。 */
function toFields(item: OrderCreateInput['items'][number], purchaseDate: string): RecordFields {
  return {
    name: item.name,
    purchaseDate,
    productionDate: item.productionDate,
    shelfLifeValue: item.shelfLifeValue,
    shelfLifeUnit: item.shelfLifeUnit,
    expiryDate: item.expiryDate,
    spec: item.spec,
    unitPrice: item.unitPrice,
    quantity: item.quantity,
    amountCents: item.amountCents,
    remark: item.remark,
  };
}

function ctxOf(requestId: string, actor: string): WriteContext {
  return { requestId, actor, occurredAt: utcNowIso() };
}

/** 单据服务（单进程单例）。 */
export class OrderService {
  constructor(private readonly deps: OrderServiceDeps) {}

  private idempotent(
    key: string,
    produce: () => ServiceResult<OrderView>,
  ): ServiceResult<OrderView> {
    // 内部直调可能传空 key：空串不该成为所有调用共享的缓存槽（06-P2-6）。
    if (key === '') {
      return produce();
    }
    const now: number = epochSeconds();
    const cached: ServiceResult<OrderView> | undefined = idempotencyStore.get(key, now);
    if (cached !== undefined) {
      return cached;
    }
    const result: ServiceResult<OrderView> = produce();
    if (result.ok) {
      idempotencyStore.set(key, result, now + IDEMPOTENCY_TTL_SECONDS, now);
    }
    return result;
  }

  /** GET /api/orders：分页 + 三个汇总，恒排除软删。 */
  list(filter: OrderFilter): ServiceResult<PageResult<OrderView>> {
    const page = this.deps.orders.list(filter);
    return {
      ok: true,
      data: {
        items: page.rows.map((row) => this.deps.orders.toView(row)),
        total: page.total,
        page: page.page,
        pageSize: page.pageSize,
      },
    };
  }

  /** GET /api/orders/:id：抬头 + 明细（按 id 升序，只含未删除的）。 */
  get(id: number): ServiceResult<OrderDetailView> {
    const row = this.deps.orders.findView(id);
    if (row === null) {
      return { ok: false, code: ErrorCode.COMMON_NOT_FOUND };
    }
    const today: string = serverToday();
    const thresholdDays: number = this.deps.settings.getThresholdDays();
    const items: RecordView[] = this.deps.records
      .listByOrder(id)
      .map((item: RecordRow) => toRecordView(item, today, thresholdDays));
    return { ok: true, data: { ...this.deps.orders.toView(row), items } };
  }

  /**
   * POST /api/orders：校验 → 单号 → 单事务写入 + 审计。
   *
   * `orderNo` 为空则服务端按单头日期生成；显式传入则原样落库（允许与已有单号重复，
   * 但返回 `duplicatedNo: true` 供前端提示）。
   */
  create(input: OrderCreateInput, requestId: string, actor: string): ServiceResult<OrderView> {
    return this.idempotent(input.idempotencyKey, () => {
      const supplier: string = input.supplier.trim();
      if (supplier === '' || supplier.length > 100) {
        return {
          ok: false,
          code: ErrorCode.VALID_FAILED,
          details: { reason: '供货商不能为空且不超过 100 字' },
        };
      }
      if (!isValidISODate(input.purchaseDate)) {
        return {
          ok: false,
          code: ErrorCode.VALID_FAILED,
          details: { reason: `进货日期不合法: ${input.purchaseDate}` },
        };
      }
      if (input.items.length < 1 || input.items.length > ORDER_MAX_ITEMS) {
        return {
          ok: false,
          code: ErrorCode.VALID_FAILED,
          details: { reason: `明细条数必须在 1..${ORDER_MAX_ITEMS} 之间` },
        };
      }

      // 明细逐条校验：复用单条记录的同一份规则（只校验不重算）。
      const prepared: { fields: RecordFields; sources: RecordSources }[] = [];
      for (const [index, item] of input.items.entries()) {
        const fields: RecordFields = toFields(item, input.purchaseDate);
        const invalid: string | null = validateRecordFields(fields);
        if (invalid !== null) {
          return {
            ok: false,
            code: ErrorCode.VALID_FAILED,
            details: { index, reason: invalid },
          };
        }
        prepared.push({ fields, sources: item.sources as RecordSources });
      }

      const explicitNo: string = (input.orderNo ?? '').trim();
      const ctx: WriteContext = ctxOf(requestId, actor);

      // 单号生成、重复标记、写入、审计与回读全部落在同一个 BEGIN IMMEDIATE：
      // ① 并发自动单号在写锁下串行，取 MAX+1 不会撞号；
      // ② duplicatedNo 在事务内判定，不会被并发提交「漏标」；
      // ③ 回读失败即抛错回滚（不留半张单），重试同 key 不会造重复单（06-P2-3/4）。
      const view: OrderView = immediateTransaction(this.deps.db, () => {
        const orderNo: string =
          explicitNo === '' ? this.deps.orders.nextNo(input.purchaseDate) : explicitNo;
        const duplicatedNo: boolean = this.deps.orders.existsSameNo(orderNo, input.purchaseDate);
        const write: OrderWriteInput = {
          orderNo,
          supplier,
          purchaseDate: input.purchaseDate,
          remark: nullable(input.remark ?? null),
          items: prepared,
        };
        const orderId: number = this.deps.orders.create(write, ctx);
        this.deps.logs.append({
          action: Action.ORDER_CREATE,
          targetType: TARGET_TYPE.ORDER,
          targetId: orderId,
          detail: {
            orderNo,
            supplier,
            purchaseDate: write.purchaseDate,
            itemCount: prepared.length,
            totalAmountCents: prepared.reduce((sum, item) => sum + item.fields.amountCents, 0),
            duplicatedNo,
          },
          requestId,
          actor,
          occurredAt: ctx.occurredAt,
        });
        const row = this.deps.orders.findView(orderId);
        if (row === null) {
          throw new Error(`[order.service] 建单后回读失败: id=${orderId}`);
        }
        return this.deps.orders.toView(row, duplicatedNo);
      });
      return { ok: true, data: view };
    });
  }

  /** DELETE /api/orders/:id：整单软删（连带明细），返回连带条数。 */
  remove(
    id: number,
    requestId: string,
    actor: string,
  ): ServiceResult<{ id: number; deletedRecords: number }> {
    const existing = this.deps.orders.findView(id);
    if (existing === null) {
      return { ok: false, code: ErrorCode.COMMON_NOT_FOUND };
    }
    const ctx: WriteContext = ctxOf(requestId, actor);
    const deletedRecords: number = immediateTransaction(this.deps.db, () => {
      const count: number | null = this.deps.orders.softDelete(id, ctx);
      if (count === null) {
        return -1;
      }
      this.deps.logs.append({
        action: Action.ORDER_DELETE,
        targetType: TARGET_TYPE.ORDER,
        targetId: id,
        detail: { orderNo: existing.order_no, supplier: existing.supplier, deletedRecords: count },
        requestId,
        actor,
        occurredAt: ctx.occurredAt,
      });
      return count;
    });
    // -1 表示并发下单据已被删除（与事务内 0 条明细区分开）。
    if (deletedRecords < 0) {
      return { ok: false, code: ErrorCode.COMMON_NOT_FOUND };
    }
    return { ok: true, data: { id, deletedRecords } };
  }

  /** GET /api/orders/next-no：预填单号；`date` 缺省取上海时区当天。 */
  nextNo(date?: string): ServiceResult<OrderNextNoResponse> {
    if (date !== undefined && date !== '' && !isValidISODate(date)) {
      return {
        ok: false,
        code: ErrorCode.VALID_FAILED,
        details: { reason: `日期不合法: ${date}` },
      };
    }
    const day: string = date !== undefined && date !== '' ? date : serverToday();
    return { ok: true, data: { orderNo: this.deps.orders.nextNo(day) } };
  }
}
