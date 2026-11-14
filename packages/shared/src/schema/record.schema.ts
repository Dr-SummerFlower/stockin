/**
 * 记录相关 Zod schema（zod v4.6.7 写法）。
 * 一份 schema 同时驱动表单、API、Excel 三处校验（文档 §3.4）。
 */
import * as z from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants';
import { RECORD_SORT_FIELDS } from '../dto/record.dto';

/** 全站日期格式 YYYY-MM-DD（ stricter 的日历合法性由 domain/date.ts 校验）。 */
export const dateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const fieldSourceSchema = z.enum(['EMPTY', 'AUTO', 'MANUAL']);

export const shelfLifeUnitSchema = z.enum(['day', 'month', 'year']);

/** 6 个联动槽位来源标记（不含进货日期）。 */
export const recordSourcesSchema = z.object({
  productionDateSrc: fieldSourceSchema,
  shelfLifeSrc: fieldSourceSchema,
  expiryDateSrc: fieldSourceSchema,
  unitPriceSrc: fieldSourceSchema,
  quantitySrc: fieldSourceSchema,
  amountSrc: fieldSourceSchema,
});

/**
 * 保存/新建记录。数值字段为定点整数（unitPrice ×1e4、quantity ×1e3、amountCents ×1e2）。
 * 字段长度上限为实现级默认值；文档未规定更长约束，不做额外臆造。
 */
export const recordSaveSchema = z.object({
  name: z.string().min(1).max(200),
  purchaseDate: dateStringSchema,
  productionDate: dateStringSchema.nullable(),
  shelfLifeValue: z.number().int().min(0).max(36_500).nullable(),
  shelfLifeUnit: shelfLifeUnitSchema.nullable(),
  expiryDate: dateStringSchema.nullable(),
  spec: z.string().max(200).nullable(),
  unitPrice: z.number().int().min(0),
  quantity: z.number().int().min(0),
  amountCents: z.number().int().min(0),
  remark: z.string().max(1_000).nullable(),
  sources: recordSourcesSchema,
  version: z.number().int().min(0).optional(),
  idempotencyKey: z.string().max(128).optional(),
});
export type RecordSaveInput = z.infer<typeof recordSaveSchema>;

export const recordFilterSchema = z.object({
  name: z.string().max(200).optional(),
  purchaseDateFrom: dateStringSchema.optional(),
  purchaseDateTo: dateStringSchema.optional(),
  expiryDateFrom: dateStringSchema.optional(),
  expiryDateTo: dateStringSchema.optional(),
  spec: z.string().max(200).optional(),
  expiryStatus: z.enum(['near', 'expired', 'none']).optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  sortBy: z.enum(RECORD_SORT_FIELDS).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
});
export type RecordFilterInput = z.infer<typeof recordFilterSchema>;

/** 分页默认值辅助（schema 本身保持 optional，避免改变请求契约）。 */
export function withDefaultPagination(filter: RecordFilterInput): {
  page: number;
  pageSize: number;
} {
  return {
    page: filter.page ?? 1,
    pageSize: filter.pageSize ?? DEFAULT_PAGE_SIZE,
  };
}

export const batchDeleteSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(1_000),
  idempotencyKey: z.string().max(128).optional(),
});
export type BatchDeleteInput = z.infer<typeof batchDeleteSchema>;

/** 回收站批量恢复 / 批量彻底删除（B4），与 batch-delete 同上限。 */
export const batchIdsSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(1_000),
});
export type BatchIdsInput = z.infer<typeof batchIdsSchema>;

/**
 * Excel 导入行的原始字符串形态：10 列均允许空串（空单元格补算由 domain 负责）。
 * 语义/日历/定点校验在 domain/excel-rules.ts，避免 schema 与规则层重复实现。
 */
export const importRowSchema = z.object({
  name: z.string(),
  purchaseDate: z.string(),
  productionDate: z.string(),
  shelfLife: z.string(),
  expiryDate: z.string(),
  spec: z.string(),
  unitPrice: z.string(),
  quantity: z.string(),
  amount: z.string(),
  remark: z.string(),
});
export type ImportRowInput = z.infer<typeof importRowSchema>;
