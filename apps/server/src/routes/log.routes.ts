/**
 * 操作日志路由（设计文档 §3.5 端点表）：GET /api/operation-logs。
 *
 * append-only 日志只读；筛选条件全部作为常量下推，SQL 仍在 repositories/**。
 * B1：`total` 与 `items` 同筛选口径，并回显实际生效的 `limit / offset`。
 * B5：`detail` 由 JSON 文本解析为结构化对象，前端不再自行 parse。
 */
import type { Hono } from 'hono';
import type { Action } from '@stockin/shared';
import {
  normalizeLogPaging,
  type OperationLogFilter,
} from '../repositories/operation-log.repository';
import type { AppEnv } from '../types/hono';
import type { AppDeps } from '../app';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 日期选择器只给 YYYY-MM-DD 时，按项目锁定的 `TZ=Asia/Shanghai`（UTC+8，无夏令时）
 * 把自然日边界换算成 UTC ISO 文本再比较。
 * `occurred_at` 存的是 UTC ISO 8601 文本，若直接拼 `T00:00:00Z` 会漏掉
 * 北京时间当天 00:00–08:00 对应的日志。已是 ISO 文本则原样透传。
 */
function logBoundary(raw: string | undefined, isTo: boolean): string | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  if (!DATE_ONLY.test(raw)) {
    return raw;
  }
  const local: string = isTo ? `${raw}T23:59:59.999+08:00` : `${raw}T00:00:00.000+08:00`;
  return new Date(local).toISOString();
}

/** B5：把库内 detail JSON 文本解析为对象；历史脏数据兜底为 raw 字段。 */
export function parseLogDetail(raw: string | null): Record<string, unknown> | null {
  if (raw === null || raw.trim() === '') {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { raw };
  }
}

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
      action: q.action !== undefined && q.action !== '' ? (q.action as Action) : undefined,
      targetType: q.targetType !== '' ? q.targetType : undefined,
      targetId: intOf(q.targetId),
      from: logBoundary(q.from, false),
      to: logBoundary(q.to, true),
      limit: intOf(q.limit),
      offset: intOf(q.offset),
    };
    const paging = normalizeLogPaging(filter);
    const rows = deps.repositories.logs.list(filter);
    return c.json(
      {
        items: rows.map((row) => ({ ...row, detail: parseLogDetail(row.detail) })),
        total: deps.repositories.logs.count(filter),
        limit: paging.limit,
        offset: paging.offset,
      },
      200,
    );
  });
}
