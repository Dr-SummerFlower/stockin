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
      // 覆盖率对「纯逻辑层 + 数据层端口」设门槛：
      // domain/shared 是业务规则的落点；adapters 与 db.port 是数据层唯一的
      // 可替换边界（2026-11-15 引入端口后加入），必须由一致性测试钉住。
      include: [
        'packages/domain/src/**/*.ts',
        'packages/shared/src/**/*.ts',
        'apps/server/src/repositories/adapters/**/*.ts',
        'apps/server/src/repositories/db.port.ts',
        // 运行时层里**纯逻辑**的三块（任务卡 01）：平台开关表、内联迁移清单、
        // 表存储版版本登记。落盘/静态资源/exceljs 等端口实现不在此列 —— 它们
        // 依赖真实运行时能力，由端到端脚本覆盖，塞进来只会把门槛稀释成数字游戏。
        'apps/server/src/runtime/platform.ts',
        'apps/server/src/runtime/workers/migration-source.inline.ts',
        'apps/server/src/runtime/workers/version-store.table.ts',
      ],
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
