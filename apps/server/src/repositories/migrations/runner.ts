/**
 * `NNN_*.sql` 三位递增迁移执行器。
 *
 * 依据：设计文档 v1.1 §4.5 / §7.3 —— 已发布脚本不可改；user_version 为唯一权威；
 * 迁移前自动快照、单脚本单事务（BEGIN IMMEDIATE）、失败即非零退出；
 * fix-forward 优先，只有显式 CLI 放行才允许 user_version 回退启动。
 *
 * SQL 模板中的 `{{NAME}}` 从 @stockin/shared 注入，确保业务常量单一真源。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  DB_SRC_USER,
  DEFAULT_EXPIRY_THRESHOLD_DAYS,
  EXPIRY_THRESHOLD_MAX,
  EXPIRY_THRESHOLD_MIN,
  SHELF_LIFE_UNITS,
} from '@stockin/shared';
import { logger } from '../../lib/logger';
import { createBackup, type BackupResult } from '../backup';
import { immediateTransaction, readUserVersion, type Db } from '../db';
import { checkUserVersion, MIGRATION_FILE_PATTERN, SCHEMA_EXPECTED, type UserVersionVerdict } from '../schema';

export interface MigrationFile {
  readonly version: number;
  readonly filename: string;
  readonly fullPath: string;
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

/** 把 `{{NAME}}` 占位符替换为 shared 中的实现级常量；未知占位符立即报错。 */
export function renderMigrationSql(raw: string, version: number): string {
  const variables: Readonly<Record<string, string>> = {
    SCHEMA_VERSION: String(version),
    DEFAULT_EXPIRY_THRESHOLD_DAYS: String(DEFAULT_EXPIRY_THRESHOLD_DAYS),
    EXPIRY_THRESHOLD_MIN: String(EXPIRY_THRESHOLD_MIN),
    EXPIRY_THRESHOLD_MAX: String(EXPIRY_THRESHOLD_MAX),
    DB_SRC_USER: String(DB_SRC_USER),
    SHELF_LIFE_UNITS_SQL: SHELF_LIFE_UNITS.map((unit) => `'${unit}'`).join(', '),
  };
  const substitute = (line: string): string =>
    line.replace(/\{\{([A-Z_]+)\}\}/g, (_whole: string, key: string): string => {
      const value: string | undefined = variables[key];
      if (value === undefined) {
        throw new Error(`[migration] 未知模板变量: {{${key}}}`);
      }
      return value;
    });

  // 注释行原样保留，避免文档里举例的占位符文本被误当作变量。
  return raw
    .split('\n')
    .map((line: string): string =>
      line.trimStart().startsWith('--') ? line : substitute(line),
    )
    .join('\n');
}

export interface RunMigrationsOptions {
  readonly db: Db;
  readonly migrationsDir: string;
  readonly dataDir: string;
  readonly backupDir: string;
  readonly initState: 0 | 1;
  readonly minFreeBytes?: number;
  readonly keepCount?: number;
}

export interface MigrationResult {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly applied: readonly number[];
  readonly verdict: UserVersionVerdict;
  readonly backup: BackupResult | null;
}

/**
 * 执行迁移。任何脚本失败都向上抛错，由 bootstrap / CLI 转为非零退出。
 * 前序已提交脚本不回滚（单脚本单事务语义），但迁移前快照保证可恢复。
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<MigrationResult> {
  const { db, migrationsDir, dataDir, backupDir, initState } = options;
  const fromVersion: number = readUserVersion(db);
  const verdict: UserVersionVerdict = checkUserVersion(fromVersion, dataDir, SCHEMA_EXPECTED);

  if (verdict === 'ok') {
    return { fromVersion, toVersion: fromVersion, applied: [], verdict, backup: null };
  }
  if (verdict === 'rollback-allowed') {
    logger.warn(
      { fromVersion, expected: SCHEMA_EXPECTED },
      '[migration] 已消费一次性回滚放行：仅放行启动，不自动降级数据；请尽快 fix-forward',
    );
    return { fromVersion, toVersion: fromVersion, applied: [], verdict, backup: null };
  }

  const files: MigrationFile[] = discoverMigrations(migrationsDir);
  const pending: MigrationFile[] = files.filter((file) => file.version > fromVersion);
  if (pending.length === 0) {
    return { fromVersion, toVersion: fromVersion, applied: [], verdict, backup: null };
  }

  // 迁移前自动快照；空间不足只跳过、不阻断。
  const backup: BackupResult = await createBackup(db, {
    backupDir,
    reason: 'pre-migration',
    initState,
    minFreeBytes: options.minFreeBytes,
    keepCount: options.keepCount,
  });

  const applied: number[] = [];
  for (const file of pending) {
    const raw: string = fs.readFileSync(file.fullPath, 'utf8');
    const sql: string = renderMigrationSql(raw, file.version);
    logger.info({ script: file.filename }, '[migration] 开始执行');
    immediateTransaction(db, () => {
      db.exec(sql);
    });
    applied.push(file.version);
  }

  const toVersion: number = readUserVersion(db);
  if (toVersion !== SCHEMA_EXPECTED) {
    throw new Error(
      `[migration] 执行后 user_version=${toVersion}，与 SCHEMA_EXPECTED ${SCHEMA_EXPECTED} 不符`,
    );
  }
  return { fromVersion, toVersion, applied, verdict, backup };
}
