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
 * tsc 只编译 `.ts`，不会把 `001_init.sql` 拷进 dist；QA 实测
 * `apps/server/dist/repositories/migrations/` 里只有 `runner.js`。
 * 因此每个候选都以「目录内存在 001_init.sql」判定，避免选中空目录。
 *
 * 优先级：
 *  ① `explicit` / `MIGRATIONS_DIR` 显式覆盖；
 *  ② 编译产物内 migrations 目录（`<dist>/repositories/migrations`）——
 *     构建插件会把 `001_init.sql` 一并写进 dist；
 *  ③ 从 `__filename` 反推的源码目录（`<root>/src/repositories/migrations`）——
 *     本机 / tsx 开发形态；
 *  ④ 兼容 `rootDir=src` 时 `<root>/dist/src/*.js` 的编译形态。
 *
 * `node dist/index.js` 在任意 cwd 下都能命中 ②（容器）或 ③（本机）。
 */
export function resolveMigrationsDir(explicit?: string): string {
  const here: string = path.dirname(__filename);
  const marker = '001_init.sql';
  const candidates: string[] = [
    explicit ?? '',
    process.env.MIGRATIONS_DIR ?? '',
    path.join(here, 'repositories', 'migrations'),
    path.join(here, '..', 'src', 'repositories', 'migrations'),
    path.join(here, '..', '..', 'src', 'repositories', 'migrations'),
  ].filter((item) => item !== '');
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, marker))) {
      return candidate;
    }
  }
  throw new Error(
    `[migration] 找不到 ${marker}，已尝试: ${candidates.join(' | ')}。` +
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
