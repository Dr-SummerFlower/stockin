/**
 * 后端 Workers 构建：Vite（SSR/webworker 模式）打成**单个 ESM 文件** `dist/worker.mjs`。
 *
 * 与 `vite.config.mts`（Node 单文件 CJS）并行存在，两份产物互不覆盖：
 *  - Node 产物：`dist/index.js`（CJS，`node dist/index.js` 启动）
 *  - Workers 产物：`dist/worker.mjs`（ESM，`wrangler deploy` 用）
 *
 * 关键约束：
 *  ① **`node:*` 一律 external**：workerd 通过 `nodejs_compat` 提供这些模块，
 *     打进 bundle 既没必要也会破坏平台的实现（例如 `node:crypto` 的 scryptSync）。
 *  ② **绝不能出现 `node:sqlite`**：Workers 上 `new DatabaseSync()` 抛
 *     `Illegal constructor`。这里靠"Worker 入口不 import Node 驱动模块"来保证，
 *     而不是靠 alias 兜底 —— 真正的结构性隔离在代码分层里。
 *  ③ **迁移 SQL 内联**：Worker 没有持久文件系统，`?raw` 在构建期把 `.sql`
 *     变成字符串常量；因此这里**不需要** copyMigrations 插件。
 *  ④ `emptyOutDir: false`：不能把 Node 产物 `index.js` 一起删掉。
 *  ⑤ **`exceljs` 必须显式指回 Node 入口**（见下方 alias 注释）。
 */
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig, type RollupLog } from 'vite';

/** 包根目录（本配置文件所在目录）。 */
const packageRoot: string = import.meta.dirname;

/**
 * zod 4.6.x 源码里两处 `@__PURE__` 说明注释位置在 Rollup 看来非法，构建时
 * 逐条打印 INVALID_ANNOTATION（Rollup 会自动移除，产物行为不变）。上游不可改
 * 且 4.6.7 已是最新版；按 code 精确抑制这一类噪声，其余日志原样透传。
 */
function onWarn(warning: RollupLog, defaultHandler: (warning: RollupLog) => void): void {
  if (warning.code === 'INVALID_ANNOTATION') {
    return;
  }
  defaultHandler(warning);
}

/**
 * workerd 提供的 Node 内置模块一律 external。
 *
 * 正则覆盖 `node:*` 全量（含 `node:sqlite`、`node:test` 等不在
 * `builtinModules` 清单里的），并额外保留无前缀写法，避免个别依赖漏网。
 */
const nodeExternals: (string | RegExp)[] = [
  /^node:/,
  ...builtinModules,
  'cloudflare:workers',
];

/** 裸内置模块名集合（`zlib` / `constants` / `string_decoder` …）。 */
const builtinNameSet = new Set<string>(builtinModules);

/**
 * 裸内置模块 → `node:` 前缀。
 *
 * 加了 external 只保证"不打进 bundle"，**不保证产物里的写法 workerd 能解析**。
 * exceljs 的 Node 入口（经 `archiver`/`compress-commons`）留着 `require('zlib')`
 * 这类裸写法，Rollup 原样输出成 `import … from "zlib"`；workerd 的
 * `nodejs_compat` 只对 `node:` 前缀做全量映射，裸名能否命中取决于模块，属于
 * 靠不住的假设。统一改写既消除歧义，也让产物 `import` 清单一眼可审。
 */
const toNodePrefixed = (id: string): string | undefined =>
  builtinNameSet.has(id) ? `node:${id}` : undefined;

export default defineConfig({
  root: packageRoot,
  publicDir: false,
  environments: {
    ssr: { build: { rollupOptions: { onwarn: onWarn } } },
  },
  resolve: {
    // 与 Node 构建同源：workspace 包必须指向 TS 源码，否则具名导出解析不到。
    alias: [
      { find: '@stockin/shared', replacement: resolve(packageRoot, '../../packages/shared/src/index.ts') },
      { find: '@stockin/domain', replacement: resolve(packageRoot, '../../packages/domain/src/index.ts') },
      // exceljs 的 package.json 带 `browser: ./dist/exceljs.min.js`，而
      // `ssr.target: 'webworker'` 的解析条件里含 `browser`，会把它解析到那个
      // 预打包的浏览器产物上 —— **该产物没有 `stream` 字段**，于是
      // `ExcelJS.stream.xlsx.WorkbookWriter` 抛
      // `Cannot read properties of undefined (reading 'xlsx')`，模板下载与
      // 导出都变成 200 + 0 字节（Workers 上排查时极易误判成"流式传输失败"）。
      // 这里直接钉到 Node 入口：它导出的 `stream` 走 exceljs 自带的
      // `utils/zip-stream`（zlib + 纯 JS 压缩），workerd 的 `nodejs_compat`
      // 已提供 `node:stream` / `node:zlib` / `node:buffer`，无需落盘。
      { find: 'exceljs', replacement: resolve(packageRoot, 'node_modules/exceljs/lib/exceljs.nodejs.js') },
    ],
  },
  build: {
    ssr: resolve(packageRoot, 'src/worker.ts'),
    outDir: 'dist',
    // 与 Node 产物共用一个 dist；不能清空，否则 index.js 会被删。
    emptyOutDir: false,
    minify: false,
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      external: nodeExternals,
      output: {
        format: 'es',
        entryFileNames: 'worker.mjs',
        inlineDynamicImports: true,
        paths: toNodePrefixed,
      },
    },
  },
  ssr: {
    target: 'webworker',
    noExternal: true,
  },
});
