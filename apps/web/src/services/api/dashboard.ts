/**
 * 统计大屏 API。
 *
 * B2：`GET /api/dashboard` 与 `GET /api/stats/expiry` 支持预警清单分页与状态分段，
 * 响应附带 `alertsTotal / alertsPage / alertsPageSize / alertsStatus`；
 * 6 组指标始终是全表聚合，不受清单分页影响。清单由服务端排定，前端不二次排序。
 */
import type {
  DashboardResponse,
  ExpiryAlertQuery,
  StatsExpiryResponse,
  StatsSummaryResponse,
} from '@stockin/shared';
import { request } from '../request';

/** 分页参数序列化（undefined 由 request 层省略）。 */
function toAlertQuery(query: ExpiryAlertQuery): Readonly<
  Record<string, string | number | boolean | undefined>
> {
  return {
    page: query.page,
    pageSize: query.pageSize,
    status: query.status,
  };
}

export function getDashboard(query: ExpiryAlertQuery = {}): Promise<DashboardResponse> {
  return request<DashboardResponse>('/api/dashboard', { query: toAlertQuery(query) });
}

export function getStatsSummary(): Promise<StatsSummaryResponse> {
  return request<StatsSummaryResponse>('/api/stats/summary');
}

export function getStatsExpiry(query: ExpiryAlertQuery = {}): Promise<StatsExpiryResponse> {
  return request<StatsExpiryResponse>('/api/stats/expiry', { query: toAlertQuery(query) });
}
