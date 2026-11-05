/**
 * 设置与备份路由（设计文档 §3.5 端点表）。
 *
 * GET/PUT /api/settings、POST /api/backup、GET /api/backups（**仅元数据，无下载**）
 */
import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { Action, ErrorCode, TARGET_TYPE, settingsSchema } from '@stockin/shared';
import { errorResponse } from '../lib/response';
import { immediateTransaction } from '../repositories/db';
import { utcNowIso } from '../lib/today';
import type { AppEnv } from '../types/hono';
import type { AppDeps } from '../app';

/** 注册设置与备份端点。 */
export function registerSettingsRoutes(api: Hono<AppEnv>, deps: AppDeps): void {
  api.get('/api/settings', (c) => {
    return c.json({ expiryThresholdDays: deps.repositories.settings.getThresholdDays() }, 200);
  });

  api.put(
    '/api/settings',
    zValidator('json', settingsSchema, (result, c) => {
      if (!result.success) {
        return errorResponse(ErrorCode.VALID_FAILED, String(c.get('requestId') ?? ''), {
          issues: result.error.issues,
        });
      }
      return;
    }),
    (c) => {
      const input = c.req.valid('json');
      const nowUtc: string = utcNowIso();
      const requestId: string = c.get('requestId') ?? '';
      const actor: string = c.get('actor') ?? 'user';
      immediateTransaction(deps.db, () => {
        deps.repositories.settings.setThresholdDays(input.expiryThresholdDays);
        deps.repositories.logs.append({
          action: Action.SETTINGS_UPDATE,
          targetType: TARGET_TYPE.SETTINGS,
          targetId: null,
          detail: { expiryThresholdDays: input.expiryThresholdDays },
          requestId,
          actor,
          occurredAt: nowUtc,
        });
      });
      return c.json({ expiryThresholdDays: input.expiryThresholdDays }, 200);
    },
  );

  api.post('/api/backup', async (c) => {
    const result = await deps.backup.trigger('manual', c.get('requestId') ?? '');
    return result.ok
      ? c.json(result.data, 200)
      : errorResponse(result.code, c.get('requestId') ?? '', result.details);
  });

  api.get('/api/backups', (c) => {
    const result = deps.backup.list();
    return result.ok
      ? c.json(result.data, 200)
      : errorResponse(result.code, c.get('requestId') ?? '', result.details);
  });
}
