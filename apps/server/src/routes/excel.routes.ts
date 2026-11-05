/**
 * Excel 路由（设计文档 §3.5 端点表）。
 *
 * GET /api/excel/template、POST /api/excel/import（multipart）、
 * POST /api/excel/export（JSON RecordFilter → 二进制流）
 */
import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { ErrorCode, excelExportSchema } from '@stockin/shared';
import { errorResponse } from '../lib/response';
import type { AppEnv } from '../types/hono';
import type { AppDeps } from '../app';

interface UploadedFileLike {
  readonly name?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** 注册 Excel 端点。 */
export function registerExcelRoutes(api: Hono<AppEnv>, deps: AppDeps): void {
  api.get('/api/excel/template', (c) => {
    return deps.excel.createTemplateResponse(c, {
      requestId: c.get('requestId') ?? '',
      actor: c.get('actor') ?? 'user',
    });
  });

  api.post('/api/excel/import', async (c) => {
    const body = await c.req.parseBody();
    const candidate: unknown = body['file'];
    if (
      candidate === undefined ||
      typeof candidate === 'string' ||
      Array.isArray(candidate) ||
      typeof (candidate as UploadedFileLike).arrayBuffer !== 'function'
    ) {
      return errorResponse(ErrorCode.COMMON_BAD_REQUEST, c.get('requestId') ?? '', {
        reason: '缺少 file 上传字段',
      });
    }
    const file = candidate as UploadedFileLike;
    const buffer: Buffer = Buffer.from(await file.arrayBuffer());
    const fileName: string =
      typeof file.name === 'string' && file.name !== '' ? file.name : 'upload.xlsx';

    const result = await deps.excel.importFile(
      { fileName, buffer, sizeBytes: buffer.length },
      { requestId: c.get('requestId') ?? '', actor: c.get('actor') ?? 'user' },
    );
    return result.ok
      ? c.json(result.data, 200)
      : errorResponse(result.code, c.get('requestId') ?? '', result.details);
  });

  api.post(
    '/api/excel/export',
    zValidator('json', excelExportSchema, (result, c) => {
      if (!result.success) {
        return errorResponse(ErrorCode.VALID_FAILED, String(c.get('requestId') ?? ''), {
          issues: result.error.issues,
        });
      }
      return;
    }),
    (c) => {
      const input = c.req.valid('json');
      return deps.excel.createExportResponse(c, input.filter ?? {}, {
        requestId: c.get('requestId') ?? '',
        actor: c.get('actor') ?? 'user',
      });
    },
  );
}
