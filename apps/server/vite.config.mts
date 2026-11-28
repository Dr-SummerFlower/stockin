/**
 * 后端构建：Vite（SSR 模式）打成**单个 CommonJS 文件** `dist/index.js`。
 *
 * 为什么单文件：`apps/server` 由 `tsc` 逐文件编译时，`dist/` 会有上百个碎片文件；
 * 改为单文件后发布产物只有 `index.js` + 迁移 SQL，镜像层更干净，启动时模块解析也更少。
 *
 * 必须保持的三件事（改动前请先读 `src/bootstrap.ts`）：
 *  ① **CommonJS 输出**：`package.json` 是 `"type": "commonjs"`，`start` 脚本是
 *     `node dist/index.js`，`__dirname` 依赖 CJS 语义（迁移目录探测用它）。
 *  ② **原生扩展已清零**：数据库走 Node 内置 `node:sqlite`，产物里没有任何
 *     `.node`；`node:sqlite` 只能以 `node:` 前缀访问且不在 `builtinModules`
 *     清单内，故在 `nodeBuiltins` 里手工补一条才不会被 Rollup 当第三方包解析。
 *  ③ **迁移 SQL 必须随产物落地**：`tsc` 从来不拷贝 `.sql`，历史上靠 Dockerfile
 *     手工 `COPY` 进 `dist`。这里由 `copyMigrations` 插件在写盘后复制到
 *     `dist/repositories/migrations/`，正好命中 `resolveMigrationsDir()` 的候选 ②。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, resolve } from 'node:path';
import { defineConfig, type Plugin, type RollupLog } from 'vite';

/** 包根目录（本配置文件所在目录）。Node 26 支持 `import.meta.dirname`。 */
const packageRoot: string = import.meta.dirname;

/**
 * zod 4.6.x 源码里两处 `@__PURE__` 说明注释位置在 Rollup 看来非法，构建时
 * 逐条打印 INVALID_ANNOTATION（Rollup 会自动移除，产物行为不变）。上游不可改
 * 且 4.6.7 已是最新版；按 code 精确抑制这一类噪声，其余日志原样透传。
 * Vite 7 的 client / ssr 是独立 Rollup 实例，需分别挂载 onwarn。
 */
function onWarn(warning: RollupLog, defaultHandler: (warning: RollupLog) => void): void {
  if (warning.code === 'INVALID_ANNOTATION') {
    return;
  }
  defaultHandler(warning);
}

/**
 * Node 内置模块一律 external（`fs` 与 `node:fs` 两种写法都覆盖）。
 *
 * 注意 `node:sqlite` **不在** `builtinModules` 里：`builtinModules` 只列
 * 「可省略 `node:` 前缀」的模块，`node:sqlite` 这类只能带前缀访问的被排除。
 * 不显式补上的话，Rollup 会把它当第三方包去解析并报 unresolved。
 */
const nodeBuiltins: string[] = [
  ...builtinModules,
  ...builtinModules.map((name: string) => `node:${name}`),
  'node:sqlite',
];

/**
 * 需要保持 external 的运行时依赖。
 *
 * 2026-11-15 起为空：数据库改用 Node 内置 `node:sqlite`，不再有原生扩展，
 * 全部依赖（hono / zod / pino / exceljs）均为纯 JS，由 `ssr.noExternal: true`
 * 打进单文件。
 */
const runtimeExternals: string[] = [];

/**
 * 把 `src/repositories/migrations/*.sql` 复制到 `dist/repositories/migrations/`。
 *
 * `writeBundle` 时机在产物落盘之后、进程退出之前，构建失败时不会执行。
 */
function copyMigrations(): Plugin {
  return {
    name: 'stockin:copy-migrations',
    apply: 'build',
    writeBundle() {
      const from: string = resolve(packageRoot, 'src/repositories/migrations');
      const to: string = resolve(packageRoot, 'dist/repositories/migrations');
      if (!existsSync(from)) {
        this.warn(`[copy-migrations] 源目录不存在，已跳过：${from}`);
        return;
      }
      mkdirSync(to, { recursive: true });
      const copies: string[] = readdirSync(from).filter((name: string) => name.endsWith('.sql'));
      for (const name of copies) {
        copyFileSync(join(from, name), join(to, name));
      }
      this.info?.(`[copy-migrations] 已复制 ${copies.length} 个迁移脚本到 ${to}`);
    },
  };
}

export default defineConfig({
  root: packageRoot,
  // 后端无前端资源，关闭 publicDir 探测，避免误把静态目录当资产根。
  publicDir: false,
  plugins: [copyMigrations()],
  environments: {
    client: { build: { rollupOptions: { onwarn: onWarn } } },
    ssr: { build: { rollupOptions: { onwarn: onWarn } } },
  },
  resolve: {
    /**
     * `@stockin/shared` 与 `@stockin/domain` 必须指向 **TS 源码**。
     *
     * 这两个包由 tsc 输出 CommonJS，而 Rollup 解析 workspace 符号链接时按源码处理，
     * 不会施加 CommonJS 转换 → 命名导出无法识别，构建报
     * `"XXX" is not exported by packages/shared/dist/index.js`。
     * 指向源码后由 Vite 直接编译进单文件；tsc 的 CJS 产物仍保留给
     * `tsc --noEmit` 类型检查与其它 CommonJS 消费方。
     */
    alias: {
      '@stockin/shared': resolve(packageRoot, '../../packages/shared/src/index.ts'),
      '@stockin/domain': resolve(packageRoot, '../../packages/domain/src/index.ts'),
    },
  },
  build: {
    ssr: resolve(packageRoot, 'src/index.ts'),
    outDir: 'dist',
    emptyOutDir: true,
    // 服务端不需要压缩：启动耗时与可读堆栈优先。
    minify: false,
    sourcemap: false,
    // 锁定运行时语法基线，避免向下转译出用不到的垫片。
    target: 'node26',
    rollupOptions: {
      external: [...nodeBuiltins, ...runtimeExternals],
      output: {
        format: 'cjs',
        entryFileNames: 'index.js',
        // 单文件：内联全部动态导入，杜绝额外的 chunk 文件。
        inlineDynamicImports: true,
      },
    },
  },
  ssr: {
    // node 目标：解析条件走 `node` + `require`，与运行时一致。
    target: 'node',
    // 除 external 列表外，全部依赖打进 bundle。
    noExternal: true,
  },
});
