/**
 * 统计大屏契约：6 组指标 + 临期/过期清单 + 阈值 X + 基准日。
 * 依据：设计文档 v1.1 §2.4 BR-5、§5.2「一次 GET /api/dashboard」，§10.1 裁决 1/15。
 */

export type ExpiryStatus = 'near' | 'expired' | 'none';

/**
 * 6 组指标，全部为整数（金额/数量是定点整数，禁止浮点累加）。
 * 分组：① 累计进货金额 ② 累计笔数 ③ 商品种类数 ④ 累计数量
 * ⑤ 临期笔数与金额 ⑥ 过期笔数与金额。
 */
export interface DashboardMetrics {
  /** ① 累计进货金额，分整数 */
  totalAmountCents: number;
  /** ② 累计笔数 */
  totalRecords: number;
  /** ③ 商品种类数，按 name_norm 归一化去重 */
  distinctProducts: number;
  /** ④ 累计数量，×1e3 整数 */
  totalQuantity: number;
  /** ⑤ 临期笔数 */
  nearExpiryCount: number;
  /** ⑤ 临期金额，分整数 */
  nearExpiryAmountCents: number;
  /** ⑥ 过期笔数 */
  expiredCount: number;
  /** ⑥ 过期金额，分整数 */
  expiredAmountCents: number;
}

/** 预警清单项（服务端排定，前端不二次排序）。 */
export interface ExpiryAlertItem {
  id: number;
  name: string;
  spec: string | null;
  purchaseDate: string;
  productionDate: string | null;
  expiryDate: string;
  unitPrice: number;
  quantity: number;
  amountCents: number;
  /** 剩余天数 = 到期日 − 基准日；临期 ≥0，过期 <0 */
  remainingDays: number;
  status: 'near' | 'expired';
}

/** 预警清单的状态分段（B2）。 */
export type ExpiryAlertStatus = 'near' | 'expired';

/** 预警清单分页请求（B2）；不传时服务端使用默认 page/pageSize/status=全部。 */
export interface ExpiryAlertQuery {
  page?: number;
  pageSize?: number;
  status?: ExpiryAlertStatus;
}

/**
 * 预警清单分页元信息（B2）。与 `alerts` 数组同级返回，不改变已有字段形态；
 * `alertsTotal` 是同 status 条件下的 COUNT，不再受 1000 条扫描上限影响。
 */
export interface ExpiryAlertPageMeta {
  alertsTotal: number;
  alertsPage: number;
  alertsPageSize: number;
  alertsStatus: ExpiryAlertStatus | null;
}

/** GET /api/dashboard 单往返响应。 */
export interface DashboardResponse extends ExpiryAlertPageMeta {
  metrics: DashboardMetrics;
  alerts: ExpiryAlertItem[];
  /** 当前生效阈值 X（天），默认 30，范围 0~3650 */
  thresholdDays: number;
  /** 服务器本地自然日 YYYY-MM-DD，由应用层注入，domain 不读时钟 */
  baseDate: string;
}

/** 统计子端点响应（/api/stats/summary、/api/stats/expiry）。 */
export interface StatsSummaryResponse {
  metrics: DashboardMetrics;
  baseDate: string;
  thresholdDays: number;
}

export interface StatsExpiryResponse extends ExpiryAlertPageMeta {
  alerts: ExpiryAlertItem[];
  thresholdDays: number;
  baseDate: string;
}
