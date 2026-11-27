/**
 * 进货单（批次）DTO。
 *
 * 一张单据 = 抬头（单号 / 供货商 / 进货日期 / 备注）+ N 条明细；
 * 每条明细就是现有的一条 `records`，10 个业务字段与来源位全部沿用。
 * 契约见 `.tmp/接口契约-进货单.md`。
 */
import type { RecordDraft, RecordView } from './record.dto';

/** 记录所属单据的最小引用（`RecordView.order` 用，散记为 null）。 */
export interface RecordOrderRef {
  id: number;
  orderNo: string;
  supplier: string;
}

/** 列表行：不含明细，供单据列表与详情页抬头共用。 */
export interface OrderView {
  id: number;
  orderNo: string;
  supplier: string;
  /** YYYY-MM-DD */
  purchaseDate: string;
  remark: string | null;
  /** 明细条数。 */
  itemCount: number;
  /** 数量合计（×1e3 定点整数）。 */
  totalQuantity: number;
  /** 金额合计（分）。 */
  totalAmountCents: number;
  createdAt: string;
  updatedAt: string;
  version: number;
  /**
   * 建单响应专用：该单号当天已存在另一张单据（照抄纸质单号）。
   * 不阻断保存，仅用于前端提示；列表行不返回此字段。
   */
  duplicatedNo?: boolean;
}

/** 详情：抬头 + 明细（按 id 升序）。 */
export interface OrderDetailView extends OrderView {
  items: RecordView[];
}

/** 新建整单请求；`orderNo` 省略或空串时由服务端生成。 */
export interface OrderCreateRequest {
  orderNo?: string;
  /** 1..100 字符，去空格后非空。 */
  supplier: string;
  /** YYYY-MM-DD */
  purchaseDate: string;
  remark?: string | null;
  /** 1..200 条；每条复用 RecordDraft（单头日期会覆盖 item 内的 purchaseDate）。 */
  items: RecordDraft[];
  /** 24h 幂等键。 */
  idempotencyKey: string;
}

/** 单据列表筛选；字段均可选。 */
export interface OrderFilter {
  /** 单号 / 供货商 / 商品名，模糊匹配。 */
  q?: string;
  supplier?: string;
  purchaseDateFrom?: string;
  purchaseDateTo?: string;
  page?: number;
  pageSize?: number;
}

/** 下一个单号建议。 */
export interface OrderNextNoResponse {
  orderNo: string;
}

/** 商品名清单（相似名检测用）。 */
export interface ProductNameItem {
  name: string;
  spec: string | null;
  /** ×1e4 定点整数；无历史价时为 null。 */
  unitPrice: number | null;
  /** YYYY-MM-DD；无历史时为 null。 */
  lastPurchaseDate: string | null;
}

export interface ProductNameListResponse {
  items: ProductNameItem[];
}
