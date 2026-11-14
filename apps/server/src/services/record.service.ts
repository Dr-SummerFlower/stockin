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
  type RecordSaveInput,
  type RecordSources,
  type RecordView,
} from '@stockin/shared';
import { fixedMul, isValidISODate } from '@stockin/domain';
import type { Db } from '../repositories/db';
import { immediateTransaction } from '../repositories/db';
import type { RecordRepository } from '../repositories/record.repository';
import type { OperationLogRepository } from '../repositories/operation-log.repository';
import type { SettingsRepository } from '../repositories/settings.repository';
import { toRecordView, type RecordRow, type WriteContext } from '../repositories/types';
import { epochSeconds, serverToday, utcNowIso } from '../lib/today';
import type { ServiceResult } from '../app';

export interface RecordServiceDeps {
  readonly db: Db;
  readonly records: RecordRepository;
  readonly logs: OperationLogRepository;
  readonly settings: SettingsRepository;
}

interface IdempotencyEntry {
  readonly snapshot: ServiceResult<RecordView>;
  readonly expiresAt: number;
}

const IDEMPOTENCY_TTL_SECONDS: number = IDEMPOTENCY_TTL_HOURS * 3_600;
const idempotencyStore = new Map<string, IdempotencyEntry>();

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
    const cached: IdempotencyEntry | undefined = idempotencyStore.get(key);
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.snapshot;
    }
    const result: ServiceResult<RecordView> = produce();
    if (result.ok) {
      idempotencyStore.set(key, {
        snapshot: result,
        expiresAt: now + IDEMPOTENCY_TTL_SECONDS,
      });
    }
    return result;
  }

  /** GET /api/records：分页筛选，恒排除软删。 */
  list(filter: RecordFilter, requestId: string): ServiceResult<PageResult<RecordView>> {
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

  /** GET /api/records/:id */
  get(id: number, requestId: string): ServiceResult<RecordView> {
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
      const createdId: number = immediateTransaction(this.deps.db, () => {
        const id: number = this.deps.records.create(fields, input.sources as RecordSources, ctx);
        this.deps.logs.append({
          action: Action.RECORD_CREATE,
          targetType: TARGET_TYPE.RECORD,
          targetId: id,
          requestId,
          actor,
          occurredAt: ctx.occurredAt,
        });
        return id;
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
      const updated: boolean = immediateTransaction(this.deps.db, () => {
        const changed: boolean = this.deps.records.update(
          id,
          fields,
          input.sources as RecordSources,
          input.version as number,
          ctx,
        );
        if (changed) {
          this.deps.logs.append({
            action: Action.RECORD_UPDATE,
            targetType: TARGET_TYPE.RECORD,
            targetId: id,
            requestId,
            actor,
            occurredAt: ctx.occurredAt,
          });
        }
        return changed;
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
    immediateTransaction(this.deps.db, () => {
      this.deps.records.softDelete([id], ctx);
      this.deps.logs.append({
        action: Action.RECORD_DELETE,
        targetType: TARGET_TYPE.RECORD,
        targetId: id,
        requestId,
        actor,
        occurredAt: ctx.occurredAt,
      });
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
  trash(page: number = 1, pageSize: number = DEFAULT_PAGE_SIZE): ServiceResult<PageResult<RecordView>> {
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

  /** POST /api/trash/:id/restore */
  restore(id: number, requestId: string, actor: string): ServiceResult<{ id: number }> {
    const ctx: WriteContext = ctxOf(requestId, actor);
    const restored: boolean = immediateTransaction(this.deps.db, () => {
      const changed: boolean = this.deps.records.restore(id, ctx);
      if (changed) {
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
    return restored
      ? { ok: true, data: { id } }
      : { ok: false, code: ErrorCode.RECORD_NOT_FOUND };
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
    return purged
      ? { ok: true, data: { id } }
      : { ok: false, code: ErrorCode.RECORD_NOT_FOUND };
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
