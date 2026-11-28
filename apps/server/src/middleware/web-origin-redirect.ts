/**
 * 页面导航回前端站点源。
 *
 * 只在配置了 `WEB_ORIGIN` 时启用，也就是本地开发：前端跑在 Umi dev server
 * （8000），后端在 8080。后端在 dev 下没有新鲜的静态产物（`apps/web/dist` 里
 * 顶多残留上一次构建的旧包），用户直接把地址栏敲成 8080 时只会看到白屏或旧版本，
 * 很难自己判断「该开哪个端口」。这里把**页面级导航**（GET/HEAD 且 `Accept`
 * 含 `text/html`）统一送回前端。
 *
 * 边界：
 *  - `/api/*` 一律不参与 —— 接口请求要如实返回 JSON（404/401），不能变成 302；
 *  - 静态资源（`Accept: *` 或 `text/javascript` 等）不参与，避免把 JS/CSS 请求
 *    重定向成 HTML 造成 MIME 错误；
 *  - `webOrigin` 为 `null` 时不安装本中间件，生产同源托管行为完全不变。
 */
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types/hono';

/** 只有文档级请求会被重定向；表单 POST 等写方法一律放行到业务链。 */
const PAGE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

export function createWebOriginRedirect(webOrigin: string): MiddlewareHandler<AppEnv> {
  return async (c, next): Promise<Response | void> => {
    const path: string = c.req.path;
    const isApi: boolean = path === '/api' || path.startsWith('/api/');
    if (isApi || !PAGE_METHODS.has(c.req.method.toUpperCase())) {
      await next();
      return;
    }
    const accept: string = c.req.header('accept') ?? '';
    if (!accept.includes('text/html')) {
      await next();
      return;
    }
    const search: string = new URL(c.req.url).search;
    return c.redirect(`${webOrigin}${path}${search}`, 302);
  };
}
