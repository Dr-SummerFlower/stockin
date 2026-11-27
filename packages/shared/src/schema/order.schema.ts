/**
 * 进货单（批次）相关 Zod schema。
 *
 * 与 `record.schema.ts` 同风格：一份 schema 同时驱动 API 校验与（将来的）表单校验。
 * 明细复用 `recordSaveSchema` —— 单条记录与整单明细必须是同一套字段规则，
 * 否则「单条能存、进单不能存」这种分裂会在联调时暴露成玄学问题。
 */
import * as z from 'zod';
import { dateStringSchema, recordSaveSchema } from './record.schema';

/** 单张单据的明细条数上限（与契约 §2.2 一致）。 */
export const ORDER_MAX_ITEMS = 200;
/** 整单备注长度上限。 */
export const ORDER_MAX_REMARK = 1000;
/** 单据列表分页上限（契约 §2.1：默认 20，上限 100）。 */
export const ORDER_PAGE_SIZE_MAX = 100;
export const ORDER_PAGE_SIZE_DEFAULT = 20;

/** 单据列表筛选；字段均可选，`q` 命中单号 / 供货商 / 商品名任一即可。 */
export const orderFilterSchema = z.object({
  q: z.string().max(100).optional(),
  supplier: z.string().max(100).optional(),
  purchaseDateFrom: dateStringSchema.optional(),
  purchaseDateTo: dateStringSchema.optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(ORDER_PAGE_SIZE_MAX).optional(),
});
export type OrderFilterInput = z.infer<typeof orderFilterSchema>;

/**
 * 新建整单。
 *
 * - `orderNo` 省略或空串 → 服务端生成；显式传入则按传入值落库（允许与已有单号重复）。
 * - `items[i].purchaseDate` 会被单头日期覆盖（前端只是占位），其余字段原样落库。
 * - `items[i].idempotencyKey` 一律忽略：幂等是整单级的，明细各自带键会让
 *   「同一张单重发」变成「部分明细命中缓存」。
 */
export const orderCreateSchema = z.object({
  orderNo: z.string().max(40).optional(),
  supplier: z.string().trim().min(1).max(100),
  purchaseDate: dateStringSchema,
  remark: z.string().max(ORDER_MAX_REMARK).nullable().optional(),
  items: z.array(recordSaveSchema).min(1).max(ORDER_MAX_ITEMS),
  idempotencyKey: z.string().min(1).max(128),
});
export type OrderCreateInput = z.infer<typeof orderCreateSchema>;

/** 单号预填查询：`date` 缺省取上海时区当天。 */
export const orderNextNoQuerySchema = z.object({
  date: dateStringSchema.optional(),
});
export type OrderNextNoQuery = z.infer<typeof orderNextNoQuerySchema>;
