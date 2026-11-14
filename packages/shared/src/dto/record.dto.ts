/**
 * 进货记录契约：10 业务字段、6 个来源位、视图、筛选与 raw/parsed 双态输入。
 *
 * 依据：设计文档 v1.1 §2.4（10 字段、两组三选二）、§4.2（6 个 *_src 来源位，
 * 不含进货日期）、§4.3（金额以分整数存储）、§5.1（raw/parsed 双态）、
 * §10.1 裁决 11 / 14。
 */
import type { FieldSource, ShelfLifeUnit } from '../enums';

/**
 * 数值输入的 raw/parsed 双态：`"0."` / `"-"` 等中间态 parsed 为 null，
 * 避免被误判为 0 而触发除零或错误推导。
 */
export interface NumericInput {
  readonly raw: string;
  /** 已按定点倍率换算后的整数；null 表示尚未解析完成。 */
  readonly parsed: number | null;
}

/** 保质期输入（数值 + 单位成对）。 */
export interface ShelfLifeInput {
  readonly value: NumericInput;
  readonly unit: ShelfLifeUnit | null;
}

/**
 * 10 个业务字段（保质期按「数值 + 单位」记为 1 个字段，与 Excel 列序一致）。
 * 数值字段全部为定点整数：unitPrice ×1e4、quantity ×1e3、amountCents ×1e2（分）。
 */
export interface RecordFields {
  /** 1 商品名称 */
  name: string;
  /** 2 进货日期 YYYY-MM-DD（无来源位） */
  purchaseDate: string;
  /** 3 生产日期 YYYY-MM-DD，可空 */
  productionDate: string | null;
  /** 4 保质期数值，可空 */
  shelfLifeValue: number | null;
  /** 4 保质期单位，可空 */
  shelfLifeUnit: ShelfLifeUnit | null;
  /** 5 到期日期 YYYY-MM-DD，可空 */
  expiryDate: string | null;
  /** 6 规格，可空 */
  spec: string | null;
  /** 7 单价，×1e4 整数 */
  unitPrice: number;
  /** 8 数量，×1e3 整数 */
  quantity: number;
  /** 9 金额，分整数（文档 §10.1 裁决 11：空值落 0，不返回 null） */
  amountCents: number;
  /** 10 备注，可空 */
  remark: string | null;
}

/** 6 个联动槽位的来源位；进货日期不在其中。 */
export interface RecordSources {
  productionDateSrc: FieldSource;
  shelfLifeSrc: FieldSource;
  expiryDateSrc: FieldSource;
  unitPriceSrc: FieldSource;
  quantitySrc: FieldSource;
  amountSrc: FieldSource;
}

export const EMPTY_RECORD_SOURCES: Readonly<RecordSources> = {
  productionDateSrc: 'EMPTY',
  shelfLifeSrc: 'EMPTY',
  expiryDateSrc: 'EMPTY',
  unitPriceSrc: 'EMPTY',
  quantitySrc: 'EMPTY',
  amountSrc: 'EMPTY',
};

/** 保存/新建请求的完整载荷（业务字段 + 来源标记）。 */
export interface RecordDraft extends RecordFields {
  sources: RecordSources;
  /** 乐观锁版本，编辑时必填。 */
  version?: number;
  /** 幂等键（24h 快照）。 */
  idempotencyKey?: string;
}

/** 列表/详情返回的记录视图。 */
export interface RecordView extends RecordFields {
  id: number;
  sources: RecordSources;
  nameNorm: string;
  specNorm: string;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  /** 派生展示属性，不落库；到期日为空时为 null。 */
  remainingDays: number | null;
  expiryStatus: 'near' | 'expired' | 'none';
}

/**
 * 列表排序字段白名单（单一真源）：Repository 与 Zod schema 共用。
 * B3 扩展：主表 7 列均可点列头；`remainingDays` 与 `expiryDate` 单调等价，
 * `expiryStatus` 由服务端 CASE 表达式排序，均不引入新的业务规则。
 */
export const RECORD_SORT_FIELDS = [
  'purchaseDate',
  'expiryDate',
  'createdAt',
  'name',
  'spec',
  'quantity',
  'amountCents',
  'remainingDays',
  'expiryStatus',
] as const;
export type RecordSortField = (typeof RECORD_SORT_FIELDS)[number];

/** 条件筛选（列表、导出共用）。回收站走独立端点，不再保留无效的 includeDeleted。 */
export interface RecordFilter {
  name?: string;
  purchaseDateFrom?: string;
  purchaseDateTo?: string;
  expiryDateFrom?: string;
  expiryDateTo?: string;
  spec?: string;
  expiryStatus?: 'near' | 'expired' | 'none';
  page?: number;
  pageSize?: number;
  sortBy?: RecordSortField;
  sortOrder?: 'asc' | 'desc';
}

/** 批量删除请求（二次确认在前端，服务端仍校验上限）。 */
export interface BatchDeleteRequest {
  ids: number[];
}

/** 写操作可携带的幂等键。 */
export interface IdempotentWrite {
  idempotencyKey?: string;
}

/** 回收站批量恢复 / 批量彻底删除请求（B4）。 */
export interface BatchIdsRequest {
  ids: number[];
}
