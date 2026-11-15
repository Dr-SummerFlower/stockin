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
      // 覆盖率只对「纯逻辑层」设门槛：domain 与 shared 是全部业务规则的落点。
      include: ['packages/domain/src/**/*.ts', 'packages/shared/src/**/*.ts'],
      exclude: [
        '**/*.d.ts',
        // 纯类型/契约声明，无可执行语句。
        'packages/shared/src/dto/**',
        'packages/shared/src/schema/**',
        'packages/domain/src/types.ts',
        '**/index.ts',
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
