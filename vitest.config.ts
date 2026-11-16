/**
 * Vitest 配置（任务卡 02：质量门禁的单测层）。
 *
 * 与前端同一套 Vite 生态，模块解析规则一致；后端与域层的 TS 直接由 Vite 转换，
 * 不需要额外的 ts-jest / babel 链路。
 *
 * 关键点：`@stockin/*` 必须指向 **TS 源码**。这两个包由 tsc 输出 CommonJS，
 * 而 Vite 把 workspace 符号链接当源码处理、不施加 CJS 转换，直接指向 dist 会
 * 报「XXX is not exported by packages/shared/dist/index.js」。
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir: string = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@stockin/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
      '@stockin/domain': fileURLToPath(new URL('./packages/domain/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    root: rootDir,
    include: ['packages/*/tests/**/*.test.ts', 'apps/server/tests/**/*.test.ts'],
    reporters: ['default'],
    // 用例必须可重复：同一份输入任何顺序都应通过。
    sequence: { shuffle: false },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      /**
       * 覆盖率统计范围（发布审查 P1-3）。
       *
       * 旧口径只含 domain/shared/adapters，报出的 91% 是**子集**指标：
       * 路由 + Service + 中间件约 6000 行完全不在分母里，读数再高也不代表
       * 后端被测过。现在口径 = 两个共享包 + 整个 `apps/server/src`，
       * 由 `tests/http/**` 的集成测试在真实 Hono 应用上覆盖。
       *
       * 仍然排除的只有三类，排除理由都是「结构性不可测」，不是「没测好」：
       *  ① 入口文件（进程入口 / Worker 入口 / CLI）——import 即启动副作用；
       *  ② 纯类型声明（dto/schema/types/ports.d 等）——没有可执行语句；
       *  ③ Worker 运行时端口实现（`runtime/workers/*` 里依赖 `cloudflare:workers`
       *     与 DO storage 的部分）——只能在 workerd 里跑，由 `wrangler dev`
       *     端到端脚本覆盖（见任务卡 01 的执行结论）。
       * 这些文件若出现在报告里会显式报 0%，不要用 `exclude` 去把它们藏起来。
       */
      include: [
        'packages/domain/src/**/*.ts',
        'packages/shared/src/**/*.ts',
        'apps/server/src/**/*.ts',
      ],
      exclude: [
        '**/*.d.ts',
        // 纯类型/契约声明，无可执行语句。
        'packages/shared/src/dto/**',
        'packages/shared/src/schema/**',
        'packages/domain/src/types.ts',
        'apps/server/src/types/**',
        'apps/server/src/runtime/ports.ts',
        // 对外 barrel，只做 re-export。
        'packages/shared/src/index.ts',
        'packages/domain/src/index.ts',
        // 入口文件：import 即产生进程副作用（监听端口 / 注册 Worker 处理器）。
        'apps/server/src/index.ts',
        'apps/server/src/worker.ts',
        'apps/server/src/cli/**',
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        statements: 70,
        branches: 65,
      },
    },
  },
});
