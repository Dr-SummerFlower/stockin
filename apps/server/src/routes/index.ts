/**
 * API 路由聚合器：按设计文档 §3.5 端点表注册业务端点。
 * 界面优化轮新增 B4 的两个回收站批量端点（batch-restore / batch-purge）。
 *
 * 所有子路由只做「HTTP → ServiceResult → 统一信封」的适配，
 * 业务逻辑与 SQL 一律留在 services / repositories。
 */
import { Hono } from 'hono';
import type { AppEnv } from '../types/hono';
import type { AppDeps } from '../app';
import { registerAuthRoutes } from './auth.routes';
import { registerRecordRoutes } from './record.routes';
import { registerTrashRoutes } from './trash.routes';
import { registerLogRoutes } from './log.routes';
import { registerDashboardRoutes } from './dashboard.routes';
import { registerExcelRoutes } from './excel.routes';
import { registerSettingsRoutes } from './settings.routes';
import { registerAdminRoutes } from './admin.routes';

/** 构造 `/api` 路由集合（挂载到顶层 app 前）。 */
export function createApiRouter(deps: AppDeps): Hono<AppEnv> {
  const api = new Hono<AppEnv>();
  registerAuthRoutes(api, deps);
  registerRecordRoutes(api, deps);
  registerTrashRoutes(api, deps);
  registerLogRoutes(api, deps);
  registerDashboardRoutes(api, deps);
  registerExcelRoutes(api, deps);
  registerSettingsRoutes(api, deps);
  registerAdminRoutes(api, {
    adminAuth: deps.adminAuth,
    admin: deps.admin,
    adminSessions: deps.repositories.adminSessions,
    backup: deps.backup,
  });
  return api;
}
