/**
 * 进货记录业务服务。
 *
 * 依据：设计文档 v1.1 §2.4 / §3.5 / §5.2 ——
 * **保存只做合法性与一致性校验（金额 ≤1 分容差），不重算、不改写提交值**
 * （两组三选二联动已在前端 domain 完成）；八项判重编排；状态位幂等 +
 * `version` CAS；业务写与 operation_log 同事务（`BEGIN IMMEDIATE`）。
 */
import {
  Action,
  AMOUNT_ROUNDING_TOLERANCE_CENTS,
  DEFAULT_PAGE_SIZE,
  ErrorCode,
  IDEMPOTENCY_TTL_HOURS,
  SCALE,
  TARGET_TYPE,
  type PageResult,
  type RecordFields,
  type RecordFilter,
  type ProductNameItem,
  type ProductNameListResponse,
  type RecordSaveInput,
  type RecordSources,
  type RecordSuggestionResponse,
  type RecordView,
} from '@stockin/shared';
import { fixedMul, isValidISODate, normalizeName } from '@stockin/domain';
import type { Db } from '../repositories/db';
import { immediateTransaction } from '../repositories/db';
import type { RecordRepository, SuggestionRow } from '../repositories/record.repository';
import type { OrderRepository } from '../repositories/order.repository';
import type { OperationLogRepository } from '../repositories/operation-log.repository';
import type { SettingsRepository } from '../repositories/settings.repository';
import { toRecordView, type RecordRow, type WriteContext } from '../repositories/types';
import { epochSeconds, serverToday, utcNowIso } from '../lib/today';
import { TtlMap } from '../lib/ttl-map';
import type { ServiceResult } from '../app';

export interface RecordServiceDeps {
  readonly db: Db;
  readonly records: RecordRepository;
  /** 单据仓储：回收站恢复时把所属单据一并复活（B-13 方案 A）。 */
  readonly orders: OrderRepository;
  readonly logs: OperationLogRepository;
  readonly settings: SettingsRepository;
}

const IDEMPOTENCY_TTL_SECONDS: number = IDEMPOTENCY_TTL_HOURS * 3_600;

/**
 * 幂等键快照表（`Idempotency-Key` → 首次成功的响应）。
 *
 * 用 `TtlMap`：快照过期后没有任何读取入口，裸 `Map` 会让「每次保存一个新
 * 幂等键」的流量把内存永久撑大（24 小时后条目仍然在表里）。
 */
const idempotencyStore = new TtlMap<ServiceResult<RecordView>>();

/** 清空幂等快照（模块级单例，测试必须显式重置才能重复使用同一个键）。 */
export function resetIdempotencyStore(): void {
  idempotencyStore.clear();
}

/** RecordSaveInput → RecordFields（原样透传，绝不重算或改写）。 */
function toFields(input: RecordSaveInput): RecordFields {
  return {
    name: input.name,
    purchaseDate: input.purchaseDate,
    productionDate: input.productionDate,
    shelfLifeValue: input.shelfLifeValue,
    shelfLifeUnit: input.shelfLifeUnit,
    expiryDate: input.expiryDate,
    spec: input.spec,
    unitPrice: input.unitPrice,
    quantity: input.quantity,
    amountCents: input.amountCents,
    remark: input.remark,
  };
}

/**
 * 合法性与一致性校验。**只校验**：日期格式、数值非负整数、保质期成对、
 * 金额与「单价 × 数量」的 ≤1 分容差。不推导、不补算、不改写任何提交值。
 */
export function validateRecordFields(fields: RecordFields): string | null {
  if (fields.name.trim() === '') {
    return '商品名称不能为空';
  }
  if (!isValidISODate(fields.purchaseDate)) {
    return `进货日期不合法: ${fields.purchaseDate}`;
  }
  if (fields.productionDate !== null && !isValidISODate(fields.productionDate)) {
    return `生产日期不合法: ${fields.productionDate}`;
  }
  if (fields.expiryDate !== null && !isValidISODate(fields.expiryDate)) {
    return `到期日期不合法: ${fields.expiryDate}`;
  }
  if ((fields.shelfLifeValue === null) !== (fields.shelfLifeUnit === null)) {
    return '保质期数值与单位必须成对';
  }
  for (const [label, value] of [
    ['单价', fields.unitPrice],
    ['数量', fields.quantity],
    ['金额', fields.amountCents],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      return `${label}必须是非负整数`;
    }
  }
  const computed: number = fixedMul(
    fields.unitPrice,
    fields.quantity,
    SCALE.UNIT_PRICE,
    SCALE.QUANTITY,
    SCALE.AMOUNT_CENTS,
  );
  if (Math.abs(computed - fields.amountCents) > AMOUNT_ROUNDING_TOLERANCE_CENTS) {
    return `金额与「单价 × 数量」不一致：期望 ${computed} 分，实际 ${fields.amountCents} 分`;
  }
  return null;
}

function ctxOf(requestId: string, actor: string): WriteContext {
  return { requestId, actor, occurredAt: utcNowIso() };
}

/** 记录服务（单进程单例）。 */
export class RecordService {
  constructor(private readonly deps: RecordServiceDeps) {}

  private view(row: RecordRow): RecordView {
    return toRecordView(row, serverToday(), this.deps.settings.getThresholdDays());
  }

  private idempotent(
    key: string | undefined,
    produce: () => ServiceResult<RecordView>,
  ): ServiceResult<RecordView> {
    if (key === undefined || key === '') {
      return produce();
    }
    const now: number = epochSeconds();
    const cached: ServiceResult<RecordView> | undefined = idempotencyStore.get(key, now);
    if (cached !== undefined) {
      return cached;
    }
    const result: ServiceResult<RecordView> = produce();
    if (result.ok) {
      idempotencyStore.set(key, result, now + IDEMPOTENCY_TTL_SECONDS, now);
    }
    return result;
  }

  /**
   * GET /api/records/suggestions
   *
   * `supplier` 可选：传了就**优先**取该供货商下的最近一条（避免把别家的价带进来），
   * 该供货商没有这个商品时回退为全局最近一条，并在该条上标 `matchedSupplier: false`。
   * 返回仍保证「一个名称一行」。
   */
  suggest(
    field: 'name' | 'spec',
    q: string,
    limit: number = 10,
    supplier?: string,
  ): ServiceResult<RecordSuggestionResponse> {
    if (field === 'name') {
      const rows = this.deps.records.suggestNames(q, limit);
      // 供货商优先只在「全局最近 limit 个名称」里找该供货商的价（06-P2-10）：
      // 某商品在该供货商下有货、但不在全局 top-limit 时不会以该供货商价出现。
      // 个体自用数据量下可接受；若要求「供货商商品必现」，需改成独立来源合并。
      const normalizedSupplier: string = normalizeName(supplier ?? '');
      const preferred: Map<string, SuggestionRow> =
        normalizedSupplier === ''
          ? new Map()
          : new Map(
              this.deps.records
                .suggestNamesBySupplier(
                  rows.map((row) => row.name_norm),
                  normalizedSupplier,
                )
                .map((row): [string, SuggestionRow] => [row.name_norm, row]),
            );
      const items = rows.map((row) => {
        const hit: SuggestionRow | undefined = preferred.get(row.name_norm);
        const source: SuggestionRow = hit ?? row;
        return {
          value: source.name,
          spec: source.spec,
          unitPrice: source.unit_price,
          lastPurchaseDate: source.purchase_date,
          // 未传供货商时不下结论，字段保持缺省。
          ...(normalizedSupplier === '' ? {} : { matchedSupplier: hit !== undefined }),
        };
      });
      return { ok: true, data: { items } };
    }
    const specs: string[] = this.deps.records.suggestSpecs(q, limit);
    return {
      ok: true,
      data: { items: specs.map((spec) => ({ value: spec, spec: null, unitPrice: null })) },
    };
  }

  /**
   * GET /api/records/product-names
   *
   * 前端在浏览器本地做「编辑距离 ≤1 / 互为子串」判断，服务端只负责给出
   * 「一个名称一行 + 最近一次的规格/单价/进货日期」的干净清单。
   */
  productNames(limit: number = 500): ServiceResult<ProductNameListResponse> {
    const items: ProductNameItem[] = this.deps.records.listProductNames(limit).map((row) => ({
      name: row.name,
      spec: row.spec,
      unitPrice: row.unit_price,
      lastPurchaseDate: row.purchase_date,
    }));
    return { ok: true, data: { items } };
  }

  list(filter: RecordFilter, _requestId: string): ServiceResult<PageResult<RecordView>> {
    const page = this.deps.records.listActive(
      filter,
      serverToday(),
      this.deps.settings.getThresholdDays(),
    );
    return {
      ok: true,
      data: {
        items: page.rows.map((row) => this.view(row)),
        total: page.total,
        page: page.page,
        pageSize: page.pageSize,
      },
    };
  }

  /**
   * GET /api/records/:id
   *
   * `_requestId` 与其它服务方法保持一致的位置参数（供日志与审计串联），
   * 本方法自身不落日志，故以下划线前缀声明「有意不用」。
   */
  get(id: number, _requestId: string): ServiceResult<RecordView> {
    const row: RecordRow | null = this.deps.records.findById(id);
    return row === null
      ? { ok: false, code: ErrorCode.RECORD_NOT_FOUND }
      : { ok: true, data: this.view(row) };
  }

  /** POST /api/records：判重 + 同事务写入 + 日志。 */
  create(input: RecordSaveInput, requestId: string, actor: string): ServiceResult<RecordView> {
    return this.idempotent(input.idempotencyKey, () => {
      const fields: RecordFields = toFields(input);
      const invalid: string | null = validateRecordFields(fields);
      if (invalid !== null) {
        return { ok: false, code: ErrorCode.VALID_FAILED, details: { reason: invalid } };
      }
      if (this.deps.records.probeDuplicate(fields)) {
        return { ok: false, code: ErrorCode.RECORD_DUPLICATE };
      }
      const ctx: WriteContext = ctxOf(requestId, actor);
      // 日常新增不写审计：记录行自身带 created_at/来源位，属「只留关键操作」移除的高频噪音。
      const createdId: number = immediateTransaction(this.deps.db, () => {
        return this.deps.records.create(fields, input.sources as RecordSources, ctx);
      });
      return this.get(createdId, requestId);
    });
  }

  /** PUT /api/records/:id：version CAS 乐观锁。 */
  update(
    id: number,
    input: RecordSaveInput,
    requestId: string,
    actor: string,
  ): ServiceResult<RecordView> {
    return this.idempotent(input.idempotencyKey, () => {
      const fields: RecordFields = toFields(input);
      const invalid: string | null = validateRecordFields(fields);
      if (invalid !== null) {
        return { ok: false, code: ErrorCode.VALID_FAILED, details: { reason: invalid } };
      }
      const existing: RecordRow | null = this.deps.records.findById(id);
      if (existing === null) {
        return { ok: false, code: ErrorCode.RECORD_NOT_FOUND };
      }
      if (input.version === undefined || input.version !== existing.version) {
        return { ok: false, code: ErrorCode.RECORD_VERSION_CONFLICT };
      }
      const ctx: WriteContext = ctxOf(requestId, actor);
      // 日常修改不写审计：见 create() 的口径说明。
      const updated: boolean = immediateTransaction(this.deps.db, () => {
        return this.deps.records.update(
          id,
          fields,
          input.sources as RecordSources,
          input.version as number,
          ctx,
        );
      });
      if (!updated) {
        return { ok: false, code: ErrorCode.RECORD_VERSION_CONFLICT };
      }
      return this.get(id, requestId);
    });
  }

  /** DELETE /api/records/:id（软删）。 */
  remove(id: number, requestId: string, actor: string): ServiceResult<{ id: number }> {
    const existing: RecordRow | null = this.deps.records.findById(id);
    if (existing === null) {
      return { ok: false, code: ErrorCode.RECORD_NOT_FOUND };
    }
    const ctx: WriteContext = ctxOf(requestId, actor);
    // 单条软删不写审计；批量删除/恢复/清除仍完整记录（不可逆或批量操作）。
    immediateTransaction(this.deps.db, () => {
      this.deps.records.softDelete([id], ctx);
    });
    return { ok: true, data: { id } };
  }

  /** POST /api/records/batch-delete（整批同事务）。 */
  batchRemove(
    ids: readonly number[],
    requestId: string,
    actor: string,
  ): ServiceResult<{ deleted: number }> {
    const ctx: WriteContext = ctxOf(requestId, actor);
    const deleted: number = immediateTransaction(this.deps.db, () => {
      const count: number = this.deps.records.softDelete(ids, ctx);
      this.deps.logs.append({
        action: Action.RECORD_BATCH_DELETE,
        targetType: TARGET_TYPE.RECORD,
        targetId: null,
        detail: { ids, deleted: count },
        requestId,
        actor,
        occurredAt: ctx.occurredAt,
      });
      return count;
    });
    return { ok: true, data: { deleted } };
  }

  /** GET /api/trash */
  trash(
    page: number = 1,
    pageSize: number = DEFAULT_PAGE_SIZE,
  ): ServiceResult<PageResult<RecordView>> {
    const result = this.deps.records.listTrash(page, pageSize);
    return {
      ok: true,
      data: {
        items: result.rows.map((row) => this.view(row)),
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
      },
    };
  }

  /**
   * POST /api/trash/:id/restore
   *
   * 恢复规则（B-13 方案 A）：若这条明细所属的单据已软删，**把单据一起复活**。
   * 理由：用户的心智是「把这张单里的货捡回来」，只恢复明细会留下
   * 「记录有 order_id、单据却 404」的悬空引用。单据复活时 version +1、updated_at 更新。
   */
  restore(id: number, requestId: string, actor: string): ServiceResult<{ id: number }> {
    const ctx: WriteContext = ctxOf(requestId, actor);
    const restored: boolean = immediateTransaction(this.deps.db, () => {
      const changed: boolean = this.deps.records.restore(id, ctx);
      if (changed) {
        this.deps.orders.restoreDeleted(this.deps.records.orderIdsOf([id]), ctx);
        this.deps.logs.append({
          action: Action.RECORD_RESTORE,
          targetType: TARGET_TYPE.RECORD,
          targetId: id,
          requestId,
          actor,
          occurredAt: ctx.occurredAt,
        });
      }
      return changed;
    });
    return restored ? { ok: true, data: { id } } : { ok: false, code: ErrorCode.RECORD_NOT_FOUND };
  }

  /** DELETE /api/trash/:id（物理删，仅回收站条目）。 */
  purge(id: number, requestId: string, actor: string): ServiceResult<{ id: number }> {
    const ctx: WriteContext = ctxOf(requestId, actor);
    const purged: boolean = immediateTransaction(this.deps.db, () => {
      const changed: boolean = this.deps.records.purge(id);
      if (changed) {
        this.deps.logs.append({
          action: Action.RECORD_PURGE,
          targetType: TARGET_TYPE.RECORD,
          targetId: id,
          requestId,
          actor,
          occurredAt: ctx.occurredAt,
        });
      }
      return changed;
    });
    return purged ? { ok: true, data: { id } } : { ok: false, code: ErrorCode.RECORD_NOT_FOUND };
  }

  /** B4：POST /api/trash/batch-restore（整批同事务、复用单条恢复的幂等语义）。 */
  batchRestore(
    ids: readonly number[],
    requestId: string,
    actor: string,
  ): ServiceResult<{ restored: number }> {
    const ctx: WriteContext = ctxOf(requestId, actor);
    const restored: number = immediateTransaction(this.deps.db, () => {
      const count: number = this.deps.records.restoreMany(ids, ctx);
      // 与单条恢复同一规则：批量捡回来的明细，其所属单据也一起复活（方案 A）。
      if (count > 0) {
        this.deps.orders.restoreDeleted(this.deps.records.orderIdsOf(ids), ctx);
      }
      this.deps.logs.append({
        action: Action.RECORD_RESTORE,
        targetType: TARGET_TYPE.RECORD,
        targetId: null,
        detail: { ids, restored: count, batch: true },
        requestId,
        actor,
        occurredAt: ctx.occurredAt,
      });
      return count;
    });
    return { ok: true, data: { restored } };
  }

  /** B4：POST /api/trash/batch-purge（整批同事务，只允许回收站条目）。 */
  batchPurge(
    ids: readonly number[],
    requestId: string,
    actor: string,
  ): ServiceResult<{ purged: number }> {
    const ctx: WriteContext = ctxOf(requestId, actor);
    const purged: number = immediateTransaction(this.deps.db, () => {
      const count: number = this.deps.records.purgeMany(ids);
      this.deps.logs.append({
        action: Action.RECORD_PURGE,
        targetType: TARGET_TYPE.RECORD,
        targetId: null,
        detail: { ids, purged: count, batch: true },
        requestId,
        actor,
        occurredAt: ctx.occurredAt,
      });
      return count;
    });
    return { ok: true, data: { purged } };
  }
}
