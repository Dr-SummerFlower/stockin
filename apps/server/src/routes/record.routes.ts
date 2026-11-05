/**
 * 进货记录路由（设计文档 §3.5 端点表）。
 *
 * GET/POST /api/records、GET/PUT/DELETE /api/records/:id、
 * POST /api/records/batch-delete
 */
import type { Context, Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  ErrorCode,
  batchDeleteSchema,
  recordFilterSchema,
  recordSaveSchema,
  type RecordFilter,
} from '@stockin/shared';
import { errorResponse } from '../lib/response';
import type { AppEnv } from '../types/hono';
import type { AppDeps } from '../app';

/** 从 query 构造筛选；形状校验走 shared 的 recordFilterSchema。 */
export function parseRecordFilterQuery(c: Context): RecordFilter | null {
  const q = c.req.query();
  const intOf = (raw: string | undefined): number | undefined => {
    if (raw === undefined || raw.trim() === '') {
      return undefined;
    }
    const value: number = Number.parseInt(raw, 10);
    return Number.isInteger(value) ? value : undefined;
  };
  const candidate: Record<string, unknown> = {
    name: q.name,
    purchaseDateFrom: q.purchaseDateFrom,
    purchaseDateTo: q.purchaseDateTo,
    expiryDateFrom: q.expiryDateFrom,
    expiryDateTo: q.expiryDateTo,
    spec: q.spec,
    expiryStatus: q.expiryStatus,
    page: intOf(q.page),
    pageSize: intOf(q.pageSize),
    sortBy: q.sortBy,
    sortOrder: q.sortOrder,
  };
  for (const key of Object.keys(candidate)) {
    if (candidate[key] === undefined) {
      delete candidate[key];
    }
  }
  const parsed = recordFilterSchema.safeParse(candidate);
  return parsed.success ? (parsed.data as RecordFilter) : null;
}

/** 解析正整数路径参数。 */
export function parseIdParam(c: Context): number | null {
  const raw: string = c.req.param('id') ?? '';
  const value: number = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** 注册记录端点。 */
export function registerRecordRoutes(api: Hono<AppEnv>, deps: AppDeps): void {
  api.get('/api/records', (c) => {
    const filter: RecordFilter | null = parseRecordFilterQuery(c);
    if (filter === null) {
      return errorResponse(ErrorCode.VALID_FAILED, c.get('requestId') ?? '');
    }
    const result = deps.records.list(filter, c.get('requestId') ?? '');
    return result.ok
      ? c.json(result.data, 200)
      : errorResponse(result.code, c.get('requestId') ?? '', result.details);
  });

  api.get('/api/records/:id', (c) => {
    const id: number | null = parseIdParam(c);
    if (id === null) {
      return errorResponse(ErrorCode.COMMON_BAD_REQUEST, c.get('requestId') ?? '');
    }
    const result = deps.records.get(id, c.get('requestId') ?? '');
    return result.ok
      ? c.json(result.data, 200)
      : errorResponse(result.code, c.get('requestId') ?? '', result.details);
  });

  api.post(
    '/api/records',
    zValidator('json', recordSaveSchema, (result, c) => {
      if (!result.success) {
        return errorResponse(ErrorCode.VALID_FAILED, String(c.get('requestId') ?? ''), {
          issues: result.error.issues,
        });
      }
      return;
    }),
    (c) => {
      const input = c.req.valid('json');
      const result = deps.records.create(
        input,
        c.get('requestId') ?? '',
        c.get('actor') ?? 'user',
      );
      return result.ok
        ? c.json(result.data, 201)
        : errorResponse(result.code, c.get('requestId') ?? '', result.details);
    },
  );

  api.put(
    '/api/records/:id',
    zValidator('json', recordSaveSchema, (result, c) => {
      if (!result.success) {
        return errorResponse(ErrorCode.VALID_FAILED, String(c.get('requestId') ?? ''), {
          issues: result.error.issues,
        });
      }
      return;
    }),
    (c) => {
      const id: number | null = parseIdParam(c);
      if (id === null) {
        return errorResponse(ErrorCode.COMMON_BAD_REQUEST, c.get('requestId') ?? '');
      }
      const input = c.req.valid('json');
      const result = deps.records.update(
        id,
        input,
        c.get('requestId') ?? '',
        c.get('actor') ?? 'user',
      );
      return result.ok
        ? c.json(result.data, 200)
        : errorResponse(result.code, c.get('requestId') ?? '', result.details);
    },
  );

  api.delete('/api/records/:id', (c) => {
    const id: number | null = parseIdParam(c);
    if (id === null) {
      return errorResponse(ErrorCode.COMMON_BAD_REQUEST, c.get('requestId') ?? '');
    }
    const result = deps.records.remove(id, c.get('requestId') ?? '', c.get('actor') ?? 'user');
    return result.ok
      ? c.json(result.data, 200)
      : errorResponse(result.code, c.get('requestId') ?? '', result.details);
  });

  api.post(
    '/api/records/batch-delete',
    zValidator('json', batchDeleteSchema, (result, c) => {
      if (!result.success) {
        return errorResponse(ErrorCode.VALID_FAILED, String(c.get('requestId') ?? ''), {
          issues: result.error.issues,
        });
      }
      return;
    }),
    (c) => {
      const input = c.req.valid('json');
      const result = deps.records.batchRemove(
        input.ids,
        c.get('requestId') ?? '',
        c.get('actor') ?? 'user',
      );
      return result.ok
        ? c.json(result.data, 200)
        : errorResponse(result.code, c.get('requestId') ?? '', result.details);
    },
  );
}
