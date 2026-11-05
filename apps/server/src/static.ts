/**
 * 静态托管根与 SPA fallback。
 *
 * 依据：设计文档 v1.1 §3.5 / §3.6 / §10.1 裁决 12 ——
 * `serveStatic` from `@hono/node-server/serve-static`，root 用绝对路径
 * （`fileURLToPath(new URL(...))`）；SPA fallback 只对非 `/api/*` 生效；
 * **`/api/*` 未命中返回 JSON 404，绝不 fallback 到 index.html**；
 * `app.notFound` 挂在顶层 app（Hono 官方：子路由 notFound 不生效）；
 * 静态根复用 `loadEnv()` 的 `isUnderDirectory` 守卫，确保
 * `data/` / `backups/` / `tmp/` 不在其内。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Context, MiddlewareHandler } from 'hono';
import { SECURITY_HEADERS } from '@stockin/shared';
import { isUnderDirectory, type Env } from './env';
import { sha256Hex } from './lib/crypto';
import type { AppEnv } from './types/hono';

/** 默认静态根：从编译产物 dist/static.js 反推 apps/web/dist（绝对路径）。 */
export function defaultStaticRoot(): string {
  return fileURLToPath(new URL('../../web/dist/', pathToFileURL(__filename)));
}

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

/** 读取 index.html 并生成内容 ETag；产物缺失时给最小可启动兜底页。 */
export function readIndexDocument(staticRoot: string): IndexDocument {
  const file: string = path.join(staticRoot, 'index.html');
  let html: string;
  try {
    html = fs.readFileSync(file, 'utf8');
  } catch {
    html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>进货统计</title></head><body><div id="root"></div></body></html>';
  }
  return { html, etag: `"${sha256Hex(html).slice(0, 24)}"` };
}

/** 静态文件中间件；root 为绝对路径。 */
export function createStaticMiddleware(staticRoot: string): MiddlewareHandler<AppEnv> {
  return serveStatic({ root: staticRoot }) as MiddlewareHandler<AppEnv>;
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
