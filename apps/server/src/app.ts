/**
 * Hono 应用组装（T03b 收口）。
 *
 * 中间件链固定顺序：
 * requestId → secureHeaders/CSP → CSRF → bodyLimit → rateLimit →
 * session → authGuard → initGuard → cacheControl → zod validator →
 * handler → 静态 fallback → onError → accessLog（日志写入在链尾）。
 *
 * 依据：设计文档 v1.1 §3.5 / §3.6 / §5.2；`app.notFound` 只挂在顶层 app
 * （Hono 官方：子路由 notFound 不生效）；`/api/*` 未命中返回 JSON 404，
 * 绝不 fallback 到 index.html。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import {
  CSP_HEADER_VALUE,
  ErrorCode,
  SECURITY_HEADERS,
  type ErrorCode as ErrorCodeType,
} from '@stockin/shared';
import type { Env } from './env';
import type { Db } from './repositories/db';
import type { BootstrapRepositories } from './bootstrap';
import { errorResponse } from './lib/response';
import { logger } from './lib/logger';
import type { AppEnv } from './types/hono';
import { createAccessLogMiddleware } from './middleware/access-log';
import { createRequestIdMiddleware } from './middleware/request-id';
import { createSecureHeadersMiddleware } from './middleware/secure-headers';
import { createCsrfMiddleware } from './middleware/csrf';
import { createBodyLimitMiddleware } from './middleware/body-limit';
import { createRateLimitMiddleware } from './middleware/rate-limit';
import { createSessionMiddleware } from './middleware/session';
import { createAuthGuard } from './middleware/auth-guard';
import { createInitGuard } from './middleware/init-guard';
import { createCacheControlMiddleware } from './middleware/cache-control';
import type { HealthService } from './services/health.service';
import type { HeavyTaskGate } from './services/heavy-task';
import type { AuthService } from './services/auth.service';
import type { RecordService } from './services/record.service';
import type { DashboardService } from './services/dashboard.service';
import type { ExcelService } from './services/excel.service';
import type { BackupService } from './services/backup.service';
import { createApiRouter } from './routes';
import {
  assertStaticRootSafe,
  createSpaFallback,
  createStaticMiddleware,
  defaultStaticRoot,
  readIndexDocument,
  type IndexDocument,
} from './static';

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
  readonly records: RecordService;
  readonly dashboard: DashboardService;
  readonly excel: ExcelService;
  readonly backup: BackupService;
  readonly health: HealthService;
  readonly gate: HeavyTaskGate;
  /** 可覆盖的静态根（自测用）；缺省由 static.ts 以绝对路径推导。 */
  readonly staticRoot?: string;
  /** 可覆盖的 index.html 文档（自测用）。 */
  readonly indexDocument?: IndexDocument;
}

/** 构造完整 Hono 应用（不含监听）。 */
export function createApp(deps: AppDeps): Hono<AppEnv> {
  // A4：静态根优先级 = 自测覆盖(deps.staticRoot) > WEB_DIST_DIR(env.staticRoot) >
  // defaultStaticRoot()（从 __filename 反推 apps/web/dist，与 cwd 无关）。
  // env.staticRoot 仅在显式设置 WEB_DIST_DIR 时非 undefined，故裸跑时回落到
  // defaultStaticRoot()；T05 容器在 WORKDIR=/app 下显式 WEB_DIST_DIR=/app/apps/web/dist。
  const staticRoot: string =
    deps.staticRoot ?? deps.env.staticRoot ?? defaultStaticRoot();
  assertStaticRootSafe(deps.env, staticRoot);
  const document: IndexDocument = deps.indexDocument ?? readIndexDocument(staticRoot);
  const spaFallback = createSpaFallback(document);

  const app = new Hono<AppEnv>();

  // accessLog 注册在最外层：await next() 之后写日志，语义上位于链尾。
  app.use('*', createAccessLogMiddleware());
  // 兜底安全头注册在次外层：洋葱模型下它的 after 代码在所有内层中间件之后执行，
  // 保证中间件直接返回的原生 Response / notFound / onError 同样带 CSP 基线头。
  app.use('*', createFinalizeHeadersMiddleware());
  app.use('*', createRequestIdMiddleware());
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
  app.use('*', createInitGuard(deps.repositories.meta));
  // A1：把 index.html 的内容 ETag 传入缓存中间件，保证 `/`、`/index.html`、
  // SPA fallback（如 `/records`）三者 ETag 一致。
  app.use('*', createCacheControlMiddleware(document));

  // 业务端点（路径自带 /api 前缀，故挂在根路径下）。
  app.route('/', createApiRouter(deps));

  // 静态 fallback：API 命中时 handler 不调用 next，本中间件不会执行。
  app.use('*', createStaticMiddleware(staticRoot));

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
    return errorResponse(ErrorCode.COMMON_INTERNAL, requestId);
  });

  return app;
}

/**
 * 兜底安全头：在 next() 之后把 CSP 基线头写到最终响应，
 * 并显式删除 HSTS（纯 HTTP）。注册位置在次外层，覆盖所有内层响应。
 */
function createFinalizeHeadersMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next): Promise<void> => {
    await next();
    const headers: Headers = c.res.headers;
    headers.set('content-security-policy', CSP_HEADER_VALUE);
    headers.set('x-frame-options', SECURITY_HEADERS.X_FRAME_OPTIONS);
    headers.set('x-content-type-options', SECURITY_HEADERS.X_CONTENT_TYPE_OPTIONS);
    headers.set('referrer-policy', SECURITY_HEADERS.REFERRER_POLICY);
    headers.delete('strict-transport-security');
    const requestId: string = c.get('requestId') ?? '';
    if (requestId !== '') {
      headers.set('x-request-id', requestId);
    }
  };
}
