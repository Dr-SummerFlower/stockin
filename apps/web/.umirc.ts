/**
 * Umi 4 配置（裸 umi，不混装 @umijs/max）。
 *
 * 依据：设计文档 v1.1 §3.3 / §3.5 / §10.1 裁决 12、主理人 T04 口径。
 * 配置式 `routes` 显式声明全部路由；`/login` / `/setup` / `404` 保持顶层独立
 * 路由组件，规避 `layout:false` 在裸 umi 与 @umijs/max 下行为不一致的问题
 * （不使用 `layout:false`，也不使用 wrappers）。
 * `proxy` 仅 dev 生效；生产由 T03b 的 Hono 同源托管 `web/dist`，不用 `umi preview`。
 * 不配置任何 PWA / manifest / theme-color / Service Worker 相关项。
 */
import { env } from 'node:process';
import { resolve } from 'node:path';
import { defineConfig } from 'umi';

// 后端监听端口，须与 packages/shared 的 DEFAULT_PORT=8080、docker-compose 映射一致。
// 仅在后端跑在非 8080 时才用 SERVER_PORT 覆盖 dev 代理目标。此前误写为 '3000'，
// 导致 `umi dev`（默认 8000）的 /api 代理打到 127.0.0.1:3000，而 Hono 后端在 8080，
// 上游无响应 → 浏览器侧表现为 `GET /api/auth/init-status` 504 Gateway Timeout。
const serverPort: string = env.SERVER_PORT ?? '8080';

export default defineConfig({
  outputPath: 'dist',
  publicPath: '/',
  hash: true,
  history: { type: 'browser' },
  plugins: [
    '@umijs/plugins/dist/initial-state',
    '@umijs/plugins/dist/model',
  ],
  initialState: {},
  model: {},
  define: {
    'process.env.STOCKIN_WEB': JSON.stringify('1'),
  },
  // 仅追加一个自定义别名；`@` / `@@` 等内置别名由 Umi 合并提供，不覆盖。
  alias: {
    '@web': resolve('src'),
  },
  targets: { chrome: 87, firefox: 78, safari: 14, edge: 88 },
  /**
   * 配置级构建链修复（Umi 4.7.31 + esbuild 0.28.2，Node 26.13.0）。
   *
   * `@umijs/bundler-webpack` 的 `compressPlugin.js` 会**无条件**把 `"es2015"`
   * 追加进 esbuild minifier 的 target（第 53–55 行）；esbuild 0.28.2 无法把
   * antd 5 产物中的解构降级到该目标，报
   * `Transforming destructuring to the configured target environment (...es2015...) is not supported yet`。
   * 骨架阶段产物不含未转译解构故 T01 未触发，T04 引入 antd 后暴露。
   *
   * 改用 Umi 内置的 `terser` minifier 绕开该 esbuild 限制：不换构建器、
   * 不换框架、不换 Umi 版本、不改 Node 版本、不改依赖与 lock，`mfsu` 保持现状。
   */
  jsMinifier: 'terser',
  // mfsu 保持现状（Node 26.13.0 / Umi 4.7.31 已实测构建通过），不做改动。
  proxy: {
    '/api': {
      target: `http://127.0.0.1:${serverPort}`,
      changeOrigin: true,
    },
  },
  routes: [
    // 顶层独立路由：不使用 layout:false，天然不继承导航布局。
    { path: '/login', component: 'login' },
    { path: '/setup', component: 'setup' },
    {
      path: '/',
      component: '@/layouts/index',
      routes: [
        { path: '/', component: 'index' },
        { path: '/records', component: 'records/index' },
        { path: '/records/new', component: 'records/new' },
        { path: '/records/:id/edit', component: 'records/edit' },
        { path: '/settings', component: 'settings' },
        { path: '/trash', component: 'trash' },
        { path: '/logs', component: 'logs' },
      ],
    },
    // 末尾显式 404 兜底路由。
    { path: '*', component: '404' },
  ],
});
