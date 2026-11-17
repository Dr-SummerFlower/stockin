/**
 * Workers 运行时：迁移脚本构建期内联。
 *
 * 单一真源仍是 `repositories/migrations/NNN_*.sql` —— 这里用 Vite 的 `?raw`
 * 把它们当字符串引入，构建时字节级内联进 bundle，不存在"另抄一份 SQL 到 TS"
 * 的漂移风险。
 *
 * 两处与文件系统实现不同的处理：
 *  ① **剥离 `PRAGMA user_version = N`**：DO 对该 PRAGMA 返回 `SQLITE_AUTH`，
 *     整脚本会因此失败。版本改写由 `VersionStore`（表存储）在同一事务内完成，
 *     语义等价（任务卡 01 第 2 条）。
 *  ② **序号连续性仍校验**：新增脚本忘了加 import 会让 `files.length` 小于
 *     `SCHEMA_EXPECTED`，启动即报错，不会静默漏迁移。
 */
import initSql from '../../repositories/migrations/001_init.sql?raw';
import setupSecuritySql from '../../repositories/migrations/002_setup_and_security.sql?raw';
import adminAccessSql from '../../repositories/migrations/003_admin_access.sql?raw';
import { MIGRATION_FILE_PATTERN, SCHEMA_EXPECTED } from '../../repositories/schema';
import type { MigrationFile } from '../../repositories/migrations/runner';
import type { MigrationSource } from '../ports';

/**
 * 内联脚本清单。**新增迁移时在这里追加一行 import + 一个表项**，
 * 其余逻辑（排序、连续性、版本比对）复用共享实现。
 */
const INLINE_SCRIPTS: Readonly<Record<string, string>> = {
  '001_init.sql': initSql,
  '002_setup_and_security.sql': setupSecuritySql,
  '003_admin_access.sql': adminAccessSql,
};

/** 去掉 DO 不允许的 `PRAGMA user_version` 赋值行；其余内容逐字节保留。 */
export function stripUserVersionPragma(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !/^\s*PRAGMA\s+user_version\s*=/i.test(line))
    .join('\n');
}

/** 从内联清单发现脚本，校验方式与文件系统实现一致。 */
export function discoverInlineMigrations(
  scripts: Readonly<Record<string, string>> = INLINE_SCRIPTS,
): MigrationFile[] {
  const files: MigrationFile[] = [];
  for (const filename of Object.keys(scripts)) {
    const match: RegExpExecArray | null = MIGRATION_FILE_PATTERN.exec(filename);
    if (match === null) {
      continue;
    }
    files.push({
      version: Number.parseInt(match[1] ?? '', 10),
      filename,
      // 内联后已无路径；给空串而不是假路径，避免排障时误以为文件在盘上。
      fullPath: '',
    });
  }
  files.sort((a, b) => a.version - b.version);

  for (let i = 0; i < files.length; i += 1) {
    const expected: number = i + 1;
    const current: MigrationFile | undefined = files[i];
    if (current === undefined || current.version !== expected) {
      throw new Error(
        `[migration] 内联脚本序号不连续：期望 ${String(expected).padStart(3, '0')}_*.sql，` +
          `实际 ${current?.filename ?? '缺失'}（检查 migration-source.inline.ts 的 import 清单）`,
      );
    }
  }
  if (files.length < SCHEMA_EXPECTED) {
    throw new Error(
      `[migration] 内联脚本最高版本 ${files.length} 低于 SCHEMA_EXPECTED ${SCHEMA_EXPECTED}；` +
        '新增 SQL 后必须同步在 migration-source.inline.ts 里 import',
    );
  }
  return files;
}

export function createInlineMigrationSource(
  scripts: Readonly<Record<string, string>> = INLINE_SCRIPTS,
): MigrationSource {
  return {
    kind: 'inline',
    discover(): MigrationFile[] {
      return discoverInlineMigrations(scripts);
    },
    read(file: MigrationFile): string {
      const raw: string | undefined = scripts[file.filename];
      if (raw === undefined) {
        throw new Error(`[migration] 内联清单里没有 ${file.filename}`);
      }
      return stripUserVersionPragma(raw);
    },
  };
}
