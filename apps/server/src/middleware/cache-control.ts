/**
 * 静态缓存策略（标准 HTTP 缓存头，由 Hono 唯一发起点下发）。
 *
 * 依据：设计文档 v1.1 §3.5 / §3.6 / §10.1 裁决 12 ——
 * `/api/*` 与全部下载响应 `no-store`；`index.html` `no-cache` + ETag；
 * 带 hash 资源 `public, max-age=31536000, immutable`；PWA/SW 已取消。
 *
 * QA 修复 A1：SPA 文档请求（`/`、`/index.html`）此前只下发 cache-control，
 * 缺 ETag；现在复用 `static.ts` 已算好的 `IndexDocument.etag`，
 * 保证 `/`、`/index.html` 与 SPA fallback（如 `/records`）三者 ETag 一致。
 * 以 `import type` 引入 `IndexDocument`，避免运行时循环依赖。
 */
import type { MiddlewareHandler } from 'hono';
import { SECURITY_HEADERS } from '@stockin/shared';
import type { AppEnv } from '../types/hono';
import type { IndexDocument } from '../static';

/**
 * 带 hash 的静态资源命名，两套构建引擎并存（任务卡 01 切换 Vite 引擎后新增）。
 *
 *  ① Umi webpack：`umi.bfc5c5f2.js`、`p__index.18002071.async.js` —— 点号分隔 + 纯 hex；
 *  ② Umi Vite ：`assets/umi-BxyOB4sm.js` —— 连字符分隔 + base64url（含 `-` `_`、大小写）。
 *
 * 两套写法不重叠，分别匹配，避免把普通路由路径误判为不可变资源。
 */
const HASHED_ASSET_PATTERNS: readonly RegExp[] = [
  /\.[0-9a-f]{8,}\./i,
  /-[0-9A-Za-z_-]{8,}\.[a-z0-9]+$/i,
];

/** 是否为带 hash 的静态资源。 */
export function isHashedAsset(path: string): boolean {
  return HASHED_ASSET_PATTERNS.some((pattern: RegExp) => pattern.test(path));
}

/** 是否 SPA 文档请求（含 SPA fallback 的目标）。 */
export function isIndexHtmlPath(path: string): boolean {
  return path === '/' || path === '/index.html' || path.endsWith('/index.html');
}

/**
 * 构造缓存头中间件；在 next() 之后按响应类型落头，覆盖错误/404 响应。
 *
 * @param document 已读取的 index.html 文档（含内容 ETag）
 */
export function createCacheControlMiddleware(document: IndexDocument): MiddlewareHandler<AppEnv> {
  return async (c, next): Promise<void> => {
    await next();
    const headers: Headers = c.res.headers;
    const path: string = c.req.path;
    const isDownload: boolean = headers.get('content-disposition') !== null;

    if (path.startsWith('/api/') || isDownload) {
      headers.set('cache-control', SECURITY_HEADERS.CACHE_CONTROL_API);
      return;
    }
    if (isIndexHtmlPath(path)) {
      headers.set('cache-control', SECURITY_HEADERS.CACHE_CONTROL_INDEX_HTML);
      // A1：与 createSpaFallback 使用同一份内容 ETag。
      headers.set('etag', document.etag);
      return;
    }
    if (isHashedAsset(path)) {
      headers.set('cache-control', SECURITY_HEADERS.CACHE_CONTROL_HASHED_ASSET);
    }
  };
}
