/**
 * `NNN_*.sql` 三位递增迁移执行器。
 *
 * 依据：设计文档 v1.1 §4.5 / §7.3 —— 已发布脚本不可改；version 为唯一权威；
 * 迁移前自动快照、单脚本单事务（BEGIN IMMEDIATE）、失败即非零退出；
 * fix-forward 优先，只有显式 CLI 放行才允许版本回退启动。
 *
 * SQL 模板中的 `{{NAME}}` 从 @stockin/shared 注入，确保业务常量单一真源。
 *
 * 2026-11-15：脚本来源、版本存储、迁移前快照三处改为端口注入，
 * 以便同一段代码在 Node（文件 + pragma + 快照池）与 Workers（内联 + 表 + PITR）
 * 上运行。业务规则与事务边界一字未改。
 */
import {
  DB_SRC_USER,
  DEFAULT_EXPIRY_THRESHOLD_DAYS,
  EXPIRY_THRESHOLD_MAX,
  EXPIRY_THRESHOLD_MIN,
  SHELF_LIFE_UNITS,
} from '@stockin/shared';
import { logger } from '../../lib/logger';
import { immediateTransaction, type Db } from '../db';
import { checkUserVersion, SCHEMA_EXPECTED, type UserVersionVerdict } from '../schema';
import type { BackupPort, MigrationFile, MigrationSource, VersionStore } from '../../runtime/ports';

export type { MigrationFile };

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
    .map((line: string): string => (line.trimStart().startsWith('--') ? line : substitute(line)))
    .join('\n');
}

export interface RunMigrationsOptions {
  readonly db: Db;
  /** 脚本来源：文件系统或构建期内联。 */
  readonly migrations: MigrationSource;
  /** 版本读写：`PRAGMA user_version` 或专用小表。 */
  readonly versionStore: VersionStore;
  /** 迁移前快照端口；`pitr` 模式下 create 恒返回 skipped。 */
  readonly backup: BackupPort;
  readonly initState: 0 | 1;
  readonly minFreeBytes?: number;
  readonly keepCount?: number;
}

export interface MigrationResult {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly applied: readonly number[];
  readonly verdict: UserVersionVerdict;
  readonly backupSkippedReason: string | null;
}

/**
 * 执行迁移。任何脚本失败都向上抛错，由 bootstrap / CLI 转为非零退出。
 * 前序已提交脚本不回滚（单脚本单事务语义），但迁移前快照保证可恢复。
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<MigrationResult> {
  const { db, migrations, versionStore, backup } = options;
  const fromVersion: number = versionStore.read(db);
  // 放行凭据只在"版本高于期望"这条分支里读取并消费，与改造前语义一致。
  const verdict: UserVersionVerdict = checkUserVersion(fromVersion, SCHEMA_EXPECTED, () =>
    versionStore.consumeRollbackAllowance(db),
  );

  if (verdict === 'ok') {
    return { fromVersion, toVersion: fromVersion, applied: [], verdict, backupSkippedReason: null };
  }
  if (verdict === 'rollback-allowed') {
    logger.warn(
      { fromVersion, expected: SCHEMA_EXPECTED },
      '[migration] 已消费一次性回滚放行：仅放行启动，不自动降级数据；请尽快 fix-forward',
    );
    return { fromVersion, toVersion: fromVersion, applied: [], verdict, backupSkippedReason: null };
  }

  const files: MigrationFile[] = migrations.discover();
  const pending: MigrationFile[] = files.filter((file) => file.version > fromVersion);
  if (pending.length === 0) {
    return { fromVersion, toVersion: fromVersion, applied: [], verdict, backupSkippedReason: null };
  }

  // 迁移前自动快照；空间不足只跳过、不阻断。
  const snapshot = await backup.create(db, {
    reason: 'pre-migration',
    initState: options.initState,
    minFreeBytes: options.minFreeBytes,
    keepCount: options.keepCount,
  });
  const backupSkippedReason: string | null = snapshot.status === 'ok' ? null : snapshot.reason;

  const applied: number[] = [];
  for (const file of pending) {
    const raw: string = migrations.read(file);
    const sql: string = renderMigrationSql(raw, file.version);
    logger.info({ script: file.filename }, '[migration] 开始执行');
    immediateTransaction(db, () => {
      db.exec(sql);
      // 版本写入与建表同一个事务：要么都生效，要么都回滚。
      // Node 侧脚本尾部的 `PRAGMA user_version` 已写过一次，此处幂等。
      versionStore.write(db, file.version);
    });
    applied.push(file.version);
  }

  const toVersion: number = versionStore.read(db);
  if (toVersion !== SCHEMA_EXPECTED) {
    throw new Error(
      `[migration] 执行后版本=${toVersion}，与 SCHEMA_EXPECTED ${SCHEMA_EXPECTED} 不符`,
    );
  }
  return { fromVersion, toVersion, applied, verdict, backupSkippedReason };
}
