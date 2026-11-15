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
// dev 代理：把 /api 转发到后端，并把 Origin/Referer 重写为后端期望的同源字面量，
// 否则浏览器源（http://localhost:8000）与后端 PUBLIC_ORIGIN（http://…:8080）端口不同
// 会触发 CSRF 403（仅写方法受 CSRF 约束，故 GET 能 200、POST 登录/退出全 403）。
// 仅 dev 生效；生产由 Hono 同源托管 web/dist，无代理、无此问题。目标与重写源均对齐
// PUBLIC_ORIGIN（缺省 http://127.0.0.1:8080，与后端默认一致）。
const apiTarget: string = env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${serverPort}`;

/**
 * 构建引擎开关（任务卡 01 的「一键回退」入口）。
 *
 * 默认走 Umi 4 内置 Vite 引擎（`@umijs/bundler-vite`）；
 * 设 `UMI_BUNDLER=webpack` 即整体退回 webpack 引擎，业务代码零改动：
 *   UMI_BUNDLER=webpack pnpm --filter @stockin/web build
 * 两种引擎的差异只集中在本文件：`vite` 开关与 `jsMinifier` 取值。
 */
const useVite: boolean = (env.UMI_BUNDLER ?? 'vite') !== 'webpack';

export default defineConfig({
  outputPath: 'dist',
  publicPath: '/',
  // 静态文档标题：基线复核发现 34/34 页面 document.title 为空（index.html 无 <title>）。
  // 由 Umi 配置注入 HTML 模板，避免手改构建产物 dist/index.html（每次构建会覆盖）。
  title: '进货统计',
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
    /**
     * Vite 模式下 `@stockin/shared` / `@stockin/domain` 必须指向 **TS 源码**。
     *
     * 原因：这两个包由 tsc 以 CommonJS 输出（`__exportStar(require(...))`），后端
     * `require` 消费。Vite/Rollup 把符号链接的 workspace 包按**源码**处理，不会施加
     * CommonJS 转换，直接构建会失败（日志仅剩 `✗ Build failed`，无具体原因）。
     * 指向源码后由 Vite 自行编译 TS，等价于 ESM 消费；webpack 模式仍走 dist，不受影响。
     */
    ...(useVite
      ? {
          '@stockin/shared': resolve('../../packages/shared/src/index.ts'),
          '@stockin/domain': resolve('../../packages/domain/src/index.ts'),
        }
      : {}),
  },
  // 提高到现代浏览器基线：原生支持 async/generator，减少降级与 polyfill 体积。
  // 注意：Umi 4 生产包仍自带 regenerator-runtime（其运行时用 Function("r",...) 设置
  // 全局），因此控制台 CSP eval 报错实际由 CSP 放开 script-src 'unsafe-eval' 解决，
  // 与本 targets 无关；此处仅作现代化精简。个体商家自用，手机/电脑均为现代浏览器。
  targets: { chrome: 100, firefox: 100, safari: 15, edge: 100 },
  /**
   * 构建引擎：默认启用 Umi 4 内置 Vite 引擎；`UMI_BUNDLER=webpack` 时该键不出现，
   * 即回到 webpack 引擎。`mfsu` 是 webpack 专属能力，Vite 模式下不生效，故不配置
   * （保持默认，两种引擎都不受影响）。
   */
  ...(useVite ? { vite: {} } : {}),
  /**
   * 压缩器（两种引擎取值不同，原因见下）。
   *
   * webpack 引擎必须用 `terser`：`@umijs/bundler-webpack` 的 `compressPlugin.js`
   * 会**无条件**把 `"es2015"` 追加进 esbuild minifier 的 target，而 esbuild 0.28.2
   * 无法把 antd 5 产物中的解构降级到该目标，报
   * `Transforming destructuring to the configured target environment (...es2015...) is not supported yet`。
   * 这是骨架阶段不触发、T04 引入 antd 后暴露的构建链缺陷，与业务代码无关。
   *
   * Vite 引擎走自己的压缩链（无上述 compressPlugin），用默认 `esbuild` 即可，
   * 省掉 terser 的额外依赖与耗时。
   */
  jsMinifier: useVite ? 'esbuild' : 'terser',
  proxy: {
    '/api': {
      target: apiTarget,
      changeOrigin: true,
      // 开发态重建同源：让后端 CSRF 校验看到的是 PUBLIC_ORIGIN 而非浏览器 8000 源。
      headers: {
        origin: apiTarget,
        referer: `${apiTarget}/`,
      },
    },
  },
  routes: [
    // 顶层独立路由：不使用 layout:false，天然不继承导航布局。
    { path: '/login', component: 'login' },
    { path: '/setup', component: 'setup' },
    {
      // 布局文件刻意放在 src/layouts/MainLayout.tsx 而非 src/layouts/index.tsx：
      // 后者是 Umi 4 的「全局布局约定」路径，会被自动包裹到 ALL 路由（含 /login、
      // /setup、404），且与下方显式 component 叠加，导致 / 路由渲染出两层布局（双导航栏、
      // 双内容区）。现在仅作为 / 路由的布局组件，/login、/setup、404 保持顶层独立。
      path: '/',
      component: '@/layouts/MainLayout',
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
