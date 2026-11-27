/**
 * 进货单（批次）路由。
 *
 * GET/POST /api/orders、GET/DELETE /api/orders/:id、GET /api/orders/next-no
 * 约定与 `record.routes.ts` 一致：本层只做「HTTP → ServiceResult → 统一信封」，
 * 业务分支与 SQL 留在 service / repository。
 */
import type { Context, Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { ErrorCode, orderCreateSchema, orderFilterSchema, type OrderFilter } from '@stockin/shared';
import { errorResponse } from '../lib/response';
import { parseIdParam } from './record.routes';
import type { AppEnv } from '../types/hono';
import type { AppDeps } from '../app';

/** 从 query 构造单据筛选；形状校验走 shared 的 orderFilterSchema。 */
export function parseOrderFilterQuery(c: Context): OrderFilter | null {
  const q = c.req.query();
  const intOf = (raw: string | undefined): number | undefined => {
    if (raw === undefined || raw.trim() === '') {
      return undefined;
    }
    const value: number = Number.parseInt(raw, 10);
    return Number.isInteger(value) ? value : undefined;
  };
  const candidate: Record<string, unknown> = {
    q: q.q,
    supplier: q.supplier,
    purchaseDateFrom: q.purchaseDateFrom,
    purchaseDateTo: q.purchaseDateTo,
    page: intOf(q.page),
    pageSize: intOf(q.pageSize),
  };
  for (const key of Object.keys(candidate)) {
    if (candidate[key] === undefined) {
      delete candidate[key];
    }
  }
  const parsed = orderFilterSchema.safeParse(candidate);
  return parsed.success ? (parsed.data as OrderFilter) : null;
}

/**
 * 从 Zod issue 里取明细行下标（0 基）。
 *
 * 整单提交的校验错误绝大多数落在 `items.<n>.<field>`；前端按 `details.index`
 * 高亮对应行，所以这里把下标单独提出来，同时保留原始 issues 供排障。
 */
export function firstItemIndexOf(issues: readonly { path: PropertyKey[] }[]): number | null {
  for (const issue of issues) {
    if (issue.path[0] === 'items' && typeof issue.path[1] === 'number') {
      return issue.path[1];
    }
  }
  return null;
}

/** 注册进货单端点。 */
export function registerOrderRoutes(api: Hono<AppEnv>, deps: AppDeps): void {
  api.get('/api/orders', (c) => {
    const filter: OrderFilter | null = parseOrderFilterQuery(c);
    if (filter === null) {
      return errorResponse(ErrorCode.VALID_FAILED, c.get('requestId') ?? '');
    }
    const result = deps.orders.list(filter);
    return result.ok
      ? c.json(result.data, 200)
      : errorResponse(result.code, c.get('requestId') ?? '', result.details);
  });

  // 必须注册在 `/:id` 之前，否则会被当成 id 解析。
  api.get('/api/orders/next-no', (c) => {
    const result = deps.orders.nextNo(c.req.query('date'));
    return result.ok
      ? c.json(result.data, 200)
      : errorResponse(result.code, c.get('requestId') ?? '', result.details);
  });

  api.get('/api/orders/:id', (c) => {
    const id: number | null = parseIdParam(c);
    if (id === null) {
      return errorResponse(ErrorCode.COMMON_BAD_REQUEST, c.get('requestId') ?? '');
    }
    const result = deps.orders.get(id);
    return result.ok
      ? c.json(result.data, 200)
      : errorResponse(result.code, c.get('requestId') ?? '', result.details);
  });

  api.post(
    '/api/orders',
    zValidator('json', orderCreateSchema, (result, c) => {
      if (!result.success) {
        const requestId = String(c.get('requestId') ?? '');
        const index: number | null = firstItemIndexOf(result.error.issues);
        // 明细行的字段错误带 index，前端据此高亮；单头错误只有 issues。
        return errorResponse(
          ErrorCode.VALID_FAILED,
          requestId,
          index === null ? { issues: result.error.issues } : { index, issues: result.error.issues },
        );
      }
      return;
    }),
    (c) => {
      const input = c.req.valid('json');
      const result = deps.orders.create(input, c.get('requestId') ?? '', c.get('actor') ?? 'user');
      return result.ok
        ? c.json(result.data, 201)
        : errorResponse(result.code, c.get('requestId') ?? '', result.details);
    },
  );

  api.delete('/api/orders/:id', (c) => {
    const id: number | null = parseIdParam(c);
    if (id === null) {
      return errorResponse(ErrorCode.COMMON_BAD_REQUEST, c.get('requestId') ?? '');
    }
    const result = deps.orders.remove(id, c.get('requestId') ?? '', c.get('actor') ?? 'user');
    return result.ok
      ? c.json(result.data, 200)
      : errorResponse(result.code, c.get('requestId') ?? '', result.details);
  });
}
