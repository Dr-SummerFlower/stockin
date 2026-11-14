/**
 * 回收站路由（设计文档 §3.5 端点表）。
 *
 * GET /api/trash、POST /api/trash/:id/restore、DELETE /api/trash/:id（物理删）
 * B4：POST /api/trash/batch-restore、POST /api/trash/batch-purge
 */
import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { batchIdsSchema, DEFAULT_PAGE_SIZE, ErrorCode } from '@stockin/shared';
import { errorResponse } from '../lib/response';
import { parseIdParam } from './record.routes';
import type { AppEnv } from '../types/hono';
import type { AppDeps } from '../app';

/** 注册回收站端点。 */
export function registerTrashRoutes(api: Hono<AppEnv>, deps: AppDeps): void {
  api.get('/api/trash', (c) => {
    const pageRaw: string = c.req.query('page') ?? '';
    const sizeRaw: string = c.req.query('pageSize') ?? '';
    const page: number = Number.parseInt(pageRaw, 10);
    const pageSize: number = Number.parseInt(sizeRaw, 10);
    const result = deps.records.trash(
      Number.isSafeInteger(page) && page > 0 ? page : 1,
      Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : DEFAULT_PAGE_SIZE,
    );
    return result.ok
      ? c.json(result.data, 200)
      : errorResponse(result.code, c.get('requestId') ?? '', result.details);
  });

  // B4：批量端点注册在单条端点之前，避免 `/:id` 抢占路径。
  api.post(
    '/api/trash/batch-restore',
    zValidator('json', batchIdsSchema, (result, c) => {
      if (!result.success) {
        return errorResponse(ErrorCode.VALID_FAILED, String(c.get('requestId') ?? ''), {
          issues: result.error.issues,
        });
      }
      return;
    }),
    (c) => {
      const input = c.req.valid('json');
      const result = deps.records.batchRestore(
        input.ids,
        c.get('requestId') ?? '',
        c.get('actor') ?? 'user',
      );
      return result.ok
        ? c.json(result.data, 200)
        : errorResponse(result.code, c.get('requestId') ?? '', result.details);
    },
  );

  api.post(
    '/api/trash/batch-purge',
    zValidator('json', batchIdsSchema, (result, c) => {
      if (!result.success) {
        return errorResponse(ErrorCode.VALID_FAILED, String(c.get('requestId') ?? ''), {
          issues: result.error.issues,
        });
      }
      return;
    }),
    (c) => {
      const input = c.req.valid('json');
      const result = deps.records.batchPurge(
        input.ids,
        c.get('requestId') ?? '',
        c.get('actor') ?? 'user',
      );
      return result.ok
        ? c.json(result.data, 200)
        : errorResponse(result.code, c.get('requestId') ?? '', result.details);
    },
  );

  api.post('/api/trash/:id/restore', (c) => {
    const id: number | null = parseIdParam(c);
    if (id === null) {
      return errorResponse(ErrorCode.COMMON_BAD_REQUEST, c.get('requestId') ?? '');
    }
    const result = deps.records.restore(id, c.get('requestId') ?? '', c.get('actor') ?? 'user');
    return result.ok
      ? c.json(result.data, 200)
      : errorResponse(result.code, c.get('requestId') ?? '', result.details);
  });

  api.delete('/api/trash/:id', (c) => {
    const id: number | null = parseIdParam(c);
    if (id === null) {
      return errorResponse(ErrorCode.COMMON_BAD_REQUEST, c.get('requestId') ?? '');
    }
    const result = deps.records.purge(id, c.get('requestId') ?? '', c.get('actor') ?? 'user');
    return result.ok
      ? c.json(result.data, 200)
      : errorResponse(result.code, c.get('requestId') ?? '', result.details);
  });
}
