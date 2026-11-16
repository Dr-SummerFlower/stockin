/**
 * Workers 运行时：`[assets]` 绑定托管前端静态产物。
 *
 * 关键点：**静态请求必须穿过 Hono**，不能靠 assets 的 `run_worker_first=false`
 * 直接短路。原因是 CSP、`cache-control`、`x-request-id` 这三个头由 Hono 的
 * 中间件链唯一签发（见 `middleware/secure-headers.ts` 与
 * `middleware/cache-control.ts`）；一旦让平台直接返回静态文件，
 * 整站安全头就会在 HTML 与 JS 上缺失。
 *
 * 因此 `wrangler.toml` 需要 `[assets] run_worker_first = true` +
 * `not_found_handling = "none"`：所有请求先到 Worker，未命中的再由本文件
 * `next()` 交给 Hono 的 `notFound`（`/api/*` → JSON 404，其它 → SPA index）。
 */
import { sha256Hex } from '../../lib/crypto';
import type { IndexDocument } from '../../static';
import type { StaticPort } from '../ports';

/** `[assets]` 绑定的最小结构（官方 `Fetcher` 子集）。 */
export interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

/** 绑定内部取文件用的假 origin；不参与任何来源校验。 */
const ASSETS_ORIGIN = 'https://assets.internal';

/** 产物缺失时的最小可启动兜底页（与 Node 侧逐字一致）。 */
const FALLBACK_HTML =
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>进货统计</title></head><body><div id="root"></div></body></html>';

/** 从 assets 绑定读取 index.html 并算内容 ETag。 */
export async function readIndexDocumentFromAssets(assets: AssetsBinding): Promise<IndexDocument> {
  let html: string = FALLBACK_HTML;
  try {
    const response: Response = await assets.fetch(new Request(`${ASSETS_ORIGIN}/index.html`));
    if (response.ok) {
      html = await response.text();
    }
  } catch {
    // 取不到就退到兜底页：与 Node 侧 readIndexDocument 的行为一致。
  }
  return { html, etag: `"${sha256Hex(html).slice(0, 24)}"` };
}

export async function createAssetsStaticPort(assets: AssetsBinding): Promise<StaticPort> {
  const indexDocument: IndexDocument = await readIndexDocumentFromAssets(assets);
  return {
    indexDocument,
    middleware() {
      return async (c, next): Promise<void> => {
        // `/api/*` 一律不进静态分支：否则未命中的 API 会拿到 index.html 而不是 JSON 404。
        if (c.req.path.startsWith('/api/')) {
          await next();
          return;
        }
        const served: Response = await assets.fetch(c.req.raw);
        if (!served.ok) {
          // SPA 路由（如 /records）在 assets 里不存在，交给 notFound → SPA fallback。
          await next();
          return;
        }
        // 复制一份再赋给 Hono：平台返回的 Response 头是只读视图，
        // 外层 cache-control / finalize 中间件需要在它上面写头。
        c.res = new Response(served.body, {
          status: served.status,
          headers: new Headers(served.headers),
        });
      };
    },
  };
}
