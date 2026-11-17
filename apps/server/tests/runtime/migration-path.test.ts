/**
 * 迁移目录解析回归：dev（tsx 直跑源码）不能因为 `__filename` 位于
 * `src/runtime/node/` 而找不到 `src/repositories/migrations`。
 *
 * 这是 2026-11-17 本地 `pnpm dev` 启动失败的根因：旧候选链只按
 * 「dist 根 / src 根」反推，层级差一级，三个候选全部落空。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveMigrationsDir } from '../../src/runtime/node/migration-source.filesystem';

describe('resolveMigrationsDir', () => {
  it('源码/tsx 布局下能解析到包含 001、002 的迁移目录', () => {
    const dir: string = resolveMigrationsDir();
    expect(fs.existsSync(path.join(dir, '001_init.sql'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '002_setup_and_security.sql'))).toBe(true);
  });

  it('显式目录优先于自动探测', () => {
    const explicit: string = path.resolve(import.meta.dirname, '../../src/repositories/migrations');
    expect(resolveMigrationsDir(explicit)).toBe(explicit);
  });
});
