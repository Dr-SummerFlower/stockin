/**
 * Hono 应用组装（T03b 收口）。
 *
 * 中间件链固定顺序：
 * requestId → clientIp → secureHeaders/CSP → CSRF → bodyLimit → rateLimit →
 * session → authGuard → initGuard → cacheControl → zod validator →
 * handler → 静态 fallback → onError → accessLog（日志写入在链尾）。
 *
 * 依据：设计文档 v1.1 §3.5 / §3.6 / §5.2；`app.notFound` 只挂在顶层 app
 * （Hono 官方：子路由 notFound 不生效）；`/api/*` 未命中返回 JSON 404，
 * 绝不 fallback 到 index.html。
 */
import { Hono } from 'hono';
import { ErrorCode, type ErrorCode as ErrorCodeType } from '@stockin/shared';
import type { Env } from './env';
import type { Db } from './repositories/db';
import type { BootstrapRepositories } from './bootstrap';
import { errorResponse } from './lib/response';
import { logger } from './lib/logger';
import type { AppEnv } from './types/hono';
import type { StaticPort } from './runtime/ports';
import { createAccessLogMiddleware } from './middleware/access-log';
import { createRequestIdMiddleware } from './middleware/request-id';
import { createClientIpMiddleware } from './middleware/client-ip';
import { createSecureHeadersMiddleware, applySecurityHeaders } from './middleware/secure-headers';
import { createCsrfMiddleware } from './middleware/csrf';
import { createBodyLimitMiddleware } from './middleware/body-limit';
import { createRateLimitMiddleware } from './middleware/rate-limit';
import { createSessionMiddleware } from './middleware/session';
import { createAdminGuard, createAdminSessionMiddleware } from './middleware/admin-session';
import { createAuthGuard } from './middleware/auth-guard';
import { createInitGuard } from './middleware/init-guard';
import { createCacheControlMiddleware } from './middleware/cache-control';
import type { HealthService } from './services/health.service';
import type { HeavyTaskGate } from './services/heavy-task';
import type { AuthService } from './services/auth.service';
import type { AdminAuthService } from './services/admin-auth.service';
import type { AdminService } from './services/admin.service';
import type { RecordService } from './services/record.service';
import type { DashboardService } from './services/dashboard.service';
import type { ExcelService } from './services/excel.service';
import type { BackupService } from './services/backup.service';
import type { LogicalBackupService } from './services/logical-backup.service';
import type { RestoreService } from './services/restore.service';
import type { BackupKeyService } from './services/backup-key.service';
import { createApiRouter } from './routes';
import { createSpaFallback } from './static';

/**
 * 服务层统一结果。成功 / 失败用 discriminated union 表达，
 * 避免跨模块共享运行时异常类造成 CJS 循环依赖（只以 `import type` 引用）。
 */
export type ServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ErrorCodeType; details?: unknown };

/** createApp 的全部依赖，由 index.ts 在 bootstrap 之后一次性组装。 */
export interface AppDeps {
  readonly db: Db;
  readonly env: Env;
  readonly repositories: BootstrapRepositories;
  readonly auth: AuthService;
  /** 管理员 GitHub OAuth 认证。 */
  readonly adminAuth: AdminAuthService;
  /** 管理员维护能力（备份 / 导出 / 重置店主凭据）。 */
  readonly admin: AdminService;
  readonly records: RecordService;
  readonly dashboard: DashboardService;
  readonly excel: ExcelService;
  readonly backup: BackupService;
  /** 加密逻辑备份（异步分块、管理员下载 / 恢复来源）。 */
  readonly logicalBackup: LogicalBackupService;
  /** 一次性恢复（管理员）：验签票据 + 全量恢复 + 清空会话。 */
  readonly restore: RestoreService;
  /** 备份公钥（管理台维护；加密取启用中那把，验签取全部 + 部署锚点）。 */
  readonly backupKeys: BackupKeyService;
  readonly health: HealthService;
  readonly gate: HeavyTaskGate;
  /**
   * 静态资源端口。Node 传磁盘实现，Workers 传 `[assets]` 实现。
   * 由组合根按运行时注入，`app.ts` 本身不认识任何平台 API。
   */
  readonly staticPort: StaticPort;
}

/** 构造完整 Hono 应用（不含监听）。 */
export function createApp(deps: AppDeps): Hono<AppEnv> {
  // A1：index.html 的内容 ETag 由静态端口提供，`/`、`/index.html` 与
  // SPA fallback（如 `/records`）三者共用同一份，避免 304 判定不一致。
  const document = deps.staticPort.indexDocument;
  const spaFallback = createSpaFallback(document);

  const app = new Hono<AppEnv>();

  // accessLog 注册在最外层：await next() 之后写日志，语义上位于链尾。
  app.use('*', createAccessLogMiddleware());
  app.use('*', createRequestIdMiddleware());
  // clientIp 必须早于 CSRF：否则被 CSRF 拒绝的请求在访问日志里 clientIp 为空串，
  // 安全事件恰好是最需要溯源的那一类。
  app.use('*', createClientIpMiddleware());
  // 安全头只有这一个发起点（after 代码覆盖内层所有响应，含被直接拒绝的）。
  app.use('*', createSecureHeadersMiddleware());
  app.use('*', createCsrfMiddleware(deps.env.publicOrigins));
  app.use('*', createBodyLimitMiddleware());
  app.use('*', createRateLimitMiddleware());
  app.use(
    '*',
    createSessionMiddleware({
      sessions: deps.repositories.sessions,
      meta: deps.repositories.meta,
      credentials: deps.repositories.credentials,
    }),
  );
  app.use('*', createAuthGuard());
  // 管理员链路只挂 /api/admin/*：独立 Cookie、独立守卫，店主会话不参与判定。
  app.use(
    '/api/admin/*',
    createAdminSessionMiddleware({
      sessions: deps.repositories.adminSessions,
      accounts: deps.repositories.adminAccounts,
    }),
  );
  app.use('/api/admin/*', createAdminGuard());
  app.use('*', createInitGuard(deps.repositories.meta));
  // A1：把 index.html 的内容 ETag 传入缓存中间件，保证 `/`、`/index.html`、
  // SPA fallback（如 `/records`）三者 ETag 一致。
  app.use('*', createCacheControlMiddleware(document));

  // 业务端点（路径自带 /api 前缀，故挂在根路径下）。
  app.route('/', createApiRouter(deps));

  // 静态 fallback：API 命中时 handler 不调用 next，本中间件不会执行。
  app.use('*', deps.staticPort.middleware());

  // Hono 官方：notFound 只在顶层 app 生效，子路由上的 notFound 会被忽略。
  app.notFound((c) => {
    if (c.req.path.startsWith('/api/')) {
      return errorResponse(ErrorCode.COMMON_NOT_FOUND, c.get('requestId') ?? '');
    }
    return spaFallback(c);
  });

  app.onError((error, c) => {
    const requestId: string = c.get('requestId') ?? '';
    logger.error(
      { err: error instanceof Error ? error.message : String(error), requestId, path: c.req.path },
      '[app] 未处理异常',
    );
    const response: Response = errorResponse(ErrorCode.COMMON_INTERNAL, requestId);
    // 异常可能发生在安全头中间件的内层之外（如中间件自身抛错），此处再调用
    // 同一个函数，保证「任何响应都带 CSP」这条不因注册顺序而漏。
    applySecurityHeaders(response.headers);
    return response;
  });

  return app;
}
