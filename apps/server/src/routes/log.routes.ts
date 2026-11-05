/**
 * 操作日志路由（设计文档 §3.5 端点表）：GET /api/operation-logs。
 *
 * append-only 日志只读；筛选条件全部作为常量下推，SQL 仍在 repositories/**。
 */
import type { Hono } from 'hono';
import type { Action } from '@stockin/shared';
import type { OperationLogFilter } from '../repositories/operation-log.repository';
import type { AppEnv } from '../types/hono';
import type { AppDeps } from '../app';

/** 注册操作日志端点。 */
export function registerLogRoutes(api: Hono<AppEnv>, deps: AppDeps): void {
  api.get('/api/operation-logs', (c) => {
    const q = c.req.query();
    const intOf = (raw: string | undefined): number | undefined => {
      if (raw === undefined || raw.trim() === '') {
        return undefined;
      }
      const value: number = Number.parseInt(raw, 10);
      return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    };
    const filter: OperationLogFilter = {
      action: q.action as Action | undefined,
      targetType: q.targetType,
      targetId: intOf(q.targetId),
      from: q.from,
      to: q.to,
      limit: intOf(q.limit),
      offset: intOf(q.offset),
    };
    const rows = deps.repositories.logs.list(filter);
    return c.json({ items: rows, total: deps.repositories.logs.count() }, 200);
  });
}
