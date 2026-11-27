/**
 * 统计大屏路由（设计文档 §3.5 端点表）。
 *
 * GET /api/dashboard（一次往返含 6 组指标 + 预警清单 + 阈值 + 基准日）
 * GET /api/stats/summary、GET /api/stats/expiry
 *
 * B2：dashboard / stats/expiry 接受 `page / pageSize / status(near|expired)`，
 * 响应附带同筛选口径的 `alertsTotal / alertsPage / alertsPageSize / alertsStatus`。
 * 不传参数时使用服务端默认分页，指标口径始终是全表聚合，不受清单分页影响。
 */
import type { Context, Hono } from 'hono';
import type { ExpiryAlertQuery, ExpiryAlertStatus } from '@stockin/shared';
import { errorResponse } from '../lib/response';
import type { AppEnv } from '../types/hono';
import type { AppDeps } from '../app';
import { queryPositiveOrUndefined } from './query';

/** 解析预警清单分页参数；非法值一律回落为「不传」，由服务端给默认值。 */
export function parseAlertQuery(c: Context): ExpiryAlertQuery {
  const q = c.req.query();
  const status: ExpiryAlertStatus | undefined =
    q.status === 'near' || q.status === 'expired' ? q.status : undefined;
  return {
    page: queryPositiveOrUndefined(q.page),
    pageSize: queryPositiveOrUndefined(q.pageSize),
    status,
  };
}

/** 注册统计端点。 */
export function registerDashboardRoutes(api: Hono<AppEnv>, deps: AppDeps): void {
  api.get('/api/dashboard', (c) => {
    const result = deps.dashboard.snapshot(parseAlertQuery(c));
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
    const result = deps.dashboard.expiry(parseAlertQuery(c));
    return result.ok
      ? c.json(result.data, 200)
      : errorResponse(result.code, c.get('requestId') ?? '', result.details);
  });
}
