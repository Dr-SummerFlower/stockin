/**
 * 统计大屏路由（设计文档 §3.5 端点表）。
 *
 * GET /api/dashboard（一次往返含 6 组指标 + 预警清单 + 阈值 + 基准日）
 * GET /api/stats/summary、GET /api/stats/expiry
 */
import type { Hono } from 'hono';
import { errorResponse } from '../lib/response';
import type { AppEnv } from '../types/hono';
import type { AppDeps } from '../app';

/** 注册统计端点。 */
export function registerDashboardRoutes(api: Hono<AppEnv>, deps: AppDeps): void {
  api.get('/api/dashboard', (c) => {
    const result = deps.dashboard.snapshot();
    return result.ok
      ? c.json(result.data, 200)
      : errorResponse(result.code, c.get('requestId') ?? '', result.details);
  });

  api.get('/api/stats/summary', (c) => {
    const result = deps.dashboard.summary();
    return result.ok
      ? c.json(result.data, 200)
      : errorResponse(result.code, c.get('requestId') ?? '', result.details);
  });

  api.get('/api/stats/expiry', (c) => {
    const result = deps.dashboard.expiry();
    return result.ok
      ? c.json(result.data, 200)
      : errorResponse(result.code, c.get('requestId') ?? '', result.details);
  });
}
