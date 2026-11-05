/**
 * 统计大屏 API（路径以 T03b `dashboard.routes.ts` 实际注册为准）。
 * 开屏只发一次 `GET /api/dashboard`；6 组指标 + 预警清单由服务端排定，前端不二次排序。
 */
import type {
  DashboardResponse,
  StatsExpiryResponse,
  StatsSummaryResponse,
} from '@stockin/shared';
import { request } from '../request';

export function getDashboard(): Promise<DashboardResponse> {
  return request<DashboardResponse>('/api/dashboard');
}

export function getStatsSummary(): Promise<StatsSummaryResponse> {
  return request<StatsSummaryResponse>('/api/stats/summary');
}

export function getStatsExpiry(): Promise<StatsExpiryResponse> {
  return request<StatsExpiryResponse>('/api/stats/expiry');
}
