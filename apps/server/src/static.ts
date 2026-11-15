/**
 * 静态资源与 SPA fallback 的**平台无关**部分。
 *
 * 依据：设计文档 v1.1 §3.5 / §3.6 / §10.1 裁决 12 ——
 * SPA fallback 只对非 `/api/*` 生效；**`/api/*` 未命中返回 JSON 404，
 * 绝不 fallback 到 index.html**；`app.notFound` 挂在顶层 app（Hono 官方：
 * 子路由 notFound 不生效）；静态根复用 `loadEnv()` 的 `isUnderDirectory` 守卫，
 * 确保 `data/` / `backups/` / `tmp/` 不在其内。
 *
 * 具体的静态文件读取（Node 的 `serveStatic` / Workers 的 `[assets]` 绑定）
 * 已移入 `runtime/<target>/static.*`；本文件因此在两种运行时都能原样打包 ——
 * 这一点很关键：Workers 构建期解析不了 `@hono/node-server/serve-static`。
 */
import type { Context } from 'hono';
import { SECURITY_HEADERS } from '@stockin/shared';
import { isUnderDirectory, type Env } from './env';
import type { AppEnv } from './types/hono';

/** 断言三卷不落在静态托管根之内（与 loadEnv 同源守卫，静态层再兜一层）。 */
export function assertStaticRootSafe(env: Env, staticRoot: string): void {
  for (const [label, dir] of [
    ['DATA_DIR', env.dataDir],
    ['BACKUP_DIR', env.backupDir],
    ['TMP_DIR', env.tmpDir],
  ] as const) {
    if (isUnderDirectory(dir, staticRoot)) {
      throw new RangeError(`[static] ${label} 不得位于静态托管根之下: ${dir}`);
    }
  }
}

export interface IndexDocument {
  readonly html: string;
  readonly etag: string;
}

/** SPA fallback：只对非 `/api/*` 生效，`no-cache` + ETag。 */
export function createSpaFallback(document: IndexDocument): (c: Context<AppEnv>) => Response {
  return (c: Context<AppEnv>): Response => {
    const headers: Record<string, string> = {
      'content-type': 'text/html; charset=UTF-8',
      'cache-control': SECURITY_HEADERS.CACHE_CONTROL_INDEX_HTML,
      etag: document.etag,
    };
    const requestId: string = c.get('requestId') ?? '';
    if (requestId !== '') {
      headers['x-request-id'] = requestId;
    }
    if (c.req.header('if-none-match') === document.etag) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(document.html, { status: 200, headers });
  };
}
