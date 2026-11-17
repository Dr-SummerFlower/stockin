/**
 * Node 运行时：从文件系统读取 `migrations/NNN_*.sql`。
 *
 * 由 `bootstrap.ts` 的 `resolveMigrationsDir()` 与 `runner.ts` 的
 * `discoverMigrations()` 合并而来，语义与候选顺序逐字保留（见下）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATION_FILE_PATTERN, SCHEMA_EXPECTED } from '../../repositories/schema';
import type { MigrationFile } from '../../repositories/migrations/runner';
import type { MigrationSource } from '../ports';

/**
 * 解析迁移脚本目录（QA 修复 A3：**完全不依赖 process.cwd()**）。
 *
 * tsc 只编译 `.ts`，不会把 `NNN_*.sql` 拷进 dist；因此每个候选都以
 * 「目录内存在 001_init.sql」判定，避免选中空目录。
 *
 * 三种实际形态的 `__filename` 位置不同，不能只按固定层级反推：
 *  - `tsx watch src/index.ts`（dev）：`src/runtime/node/migration-source.filesystem.ts`
 *    → 需要向上两级到 `src/`；
 *  - 单文件打包（`dist/index.js`）：`dist/` → 同级的 `dist/repositories/migrations`；
 *  - tsc 未打包：`dist/runtime/node/*.js` → 向上两级到 `dist/`。
 *
 * 故实现为**从当前文件位置逐级向上**查找 `repositories/migrations` 与
 * `src/repositories/migrations`，最多回溯 4 层；仍保留 `explicit` /
 * `MIGRATIONS_DIR` 的最高优先级。
 */
export function resolveMigrationsDir(explicit?: string): string {
  const here: string = path.dirname(__filename);
  const marker = '001_init.sql';
  const fixed: string[] = [explicit ?? '', process.env.MIGRATIONS_DIR ?? ''].filter(
    (item) => item !== '',
  );

  const candidates: string[] = [...fixed];
  for (let depth = 0; depth <= 4; depth += 1) {
    const base: string =
      depth === 0 ? here : path.resolve(here, ...Array<string>(depth).fill('..'));
    candidates.push(path.join(base, 'repositories', 'migrations'));
    candidates.push(path.join(base, 'src', 'repositories', 'migrations'));
  }

  const tried: string[] = [...new Set(candidates)];
  for (const candidate of tried) {
    if (fs.existsSync(path.join(candidate, marker))) {
      return candidate;
    }
  }
  throw new Error(
    `[migration] 找不到 ${marker}，已尝试: ${tried.join(' | ')}。` +
      'runtime 镜像必须把 migrations/*.sql 一并拷入 dist（或设置 MIGRATIONS_DIR）。',
  );
}

/** 发现并校验迁移脚本：三位递增、连续、无重号、不超出期望版本。 */
export function discoverMigrations(migrationsDir: string): MigrationFile[] {
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`[migration] 迁移目录不存在: ${migrationsDir}`);
  }
  const files: MigrationFile[] = [];
  for (const filename of fs.readdirSync(migrationsDir)) {
    const match: RegExpExecArray | null = MIGRATION_FILE_PATTERN.exec(filename);
    if (match === null) {
      continue;
    }
    files.push({
      version: Number.parseInt(match[1] ?? '', 10),
      filename,
      fullPath: path.join(migrationsDir, filename),
    });
  }
  files.sort((a, b) => a.version - b.version);

  for (let i = 0; i < files.length; i += 1) {
    const expected: number = i + 1;
    const current: MigrationFile | undefined = files[i];
    if (current === undefined || current.version !== expected) {
      throw new Error(
        `[migration] 脚本序号不连续：期望 ${String(expected).padStart(3, '0')}_*.sql，` +
          `实际 ${current?.filename ?? '缺失'}`,
      );
    }
  }
  if (files.length < SCHEMA_EXPECTED) {
    throw new Error(
      `[migration] 脚本最高版本 ${files.length} 低于 SCHEMA_EXPECTED ${SCHEMA_EXPECTED}`,
    );
  }
  return files;
}

export interface FilesystemMigrationOptions {
  /** 显式目录；缺省走 `resolveMigrationsDir()` 的候选链。 */
  readonly migrationsDir?: string;
}

/** 构造文件系统迁移源。目录在 `discover()` 时才解析，保持原时序。 */
export function createFilesystemMigrationSource(
  options: FilesystemMigrationOptions = {},
): MigrationSource {
  return {
    kind: 'filesystem',
    discover(): MigrationFile[] {
      return discoverMigrations(resolveMigrationsDir(options.migrationsDir));
    },
    read(file: MigrationFile): string {
      return fs.readFileSync(file.fullPath, 'utf8');
    },
  };
}
