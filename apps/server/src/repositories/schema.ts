/**
 * Schema 版本、回滚放行与不可回滚下限登记。
 *
 * 依据：设计文档 v1.1 §4.5 / §7.3 / §10.1 裁决 21 ——
 * `PRAGMA user_version` 是唯一权威版本；等值自检 + 显式 CLI
 * `schema:allow-rollback` 放行 + fix-forward 优先；破坏性迁移登记不可回滚下限。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 当前代码期望的 schema 版本（与 001_init.sql 末尾的 PRAGMA user_version 一致）。 */
export const SCHEMA_EXPECTED = 1;

/** 不可回滚下限：低于此版本的库必须先 fix-forward，禁止直接启动。 */
export const SCHEMA_MIN_USER_VERSION = 1;

/** 迁移脚本命名：三位递增序号 + 下划线 + 描述。 */
export const MIGRATION_FILE_PATTERN = /^(\d{3})_[A-Za-z0-9_-]+\.sql$/;

/** 显式放行状态文件名（落在 data 卷内，不进静态托管根）。 */
export const ROLLBACK_ALLOW_FILE = '.allow-rollback.json';

/** 破坏性迁移登记表（本期只有 001，无破坏性脚本）。 */
export interface BreakingMigration {
  readonly version: number;
  readonly reason: string;
}

export const BREAKING_MIGRATIONS: readonly BreakingMigration[] = [
  { version: 1, reason: '初始建表，后续只允许 ADD COLUMN / ADD INDEX' },
];

/** 回滚放行凭据，由 CLI `schema:allow-rollback` 一次性签发。 */
export interface RollbackAllowance {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly issuedAt: string;
}

export type UserVersionVerdict = 'ok' | 'migrate' | 'rollback-allowed';

/** 放行文件绝对路径。 */
export function rollbackAllowancePath(dataDir: string): string {
  return path.join(dataDir, ROLLBACK_ALLOW_FILE);
}

/** 读取放行状态；文件损坏视为未放行（fail-closed）。 */
export function readRollbackAllowance(dataDir: string): RollbackAllowance | null {
  const file: string = rollbackAllowancePath(dataDir);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Number.isInteger((parsed as RollbackAllowance).fromVersion) &&
      Number.isInteger((parsed as RollbackAllowance).toVersion) &&
      typeof (parsed as RollbackAllowance).issuedAt === 'string'
    ) {
      return parsed as RollbackAllowance;
    }
  } catch {
    // 损坏的放行文件按未放行处理。
  }
  return null;
}

/** 签发一次性回滚放行。 */
export function writeRollbackAllowance(dataDir: string, allowance: RollbackAllowance): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    rollbackAllowancePath(dataDir),
    `${JSON.stringify(allowance, null, 2)}\n`,
    'utf8',
  );
}

/** 读取并消费（删除）放行状态，保证一次性。 */
export function consumeRollbackAllowance(dataDir: string): RollbackAllowance | null {
  const allowance: RollbackAllowance | null = readRollbackAllowance(dataDir);
  if (allowance !== null) {
    fs.rmSync(rollbackAllowancePath(dataDir), { force: true });
  }
  return allowance;
}

/**
 * user_version 等值自检。
 *
 * - 相等 → ok；低于期望 → migrate（runner 执行 fix-forward）；
 * - 高于期望 → 必须存在匹配的一次性放行，否则抛错并提示先升级应用（fix-forward 优先）。
 *
 * @param dataDir 用于查找并消费一次性放行状态
 */
export function checkUserVersion(
  actual: number,
  dataDir: string,
  expected: number = SCHEMA_EXPECTED,
): UserVersionVerdict {
  if (!Number.isInteger(actual) || actual < 0) {
    throw new RangeError(`[schema] user_version 非法: ${String(actual)}`);
  }
  if (actual === expected) {
    return 'ok';
  }
  if (actual === 0) {
    // 全新空库：user_version 默认 0，是初始迁移的正常起点，不受不可回滚下限约束。
    return 'migrate';
  }
  if (actual < expected) {
    if (actual < SCHEMA_MIN_USER_VERSION) {
      throw new RangeError(
        `[schema] user_version=${actual} 低于不可回滚下限 ${SCHEMA_MIN_USER_VERSION}，` +
          '必须先 fix-forward 到兼容版本，不能跨版本直接升级',
      );
    }
    return 'migrate';
  }

  const allowance: RollbackAllowance | null = consumeRollbackAllowance(dataDir);
  if (allowance !== null && allowance.fromVersion >= actual && allowance.toVersion <= expected) {
    return 'rollback-allowed';
  }
  throw new RangeError(
    `[schema] user_version=${actual} 高于当前程序期望 ${expected}（疑似镜像回退）。` +
      'fix-forward 优先：请先升级应用到匹配版本；确需回退请显式执行 CLI `schema:allow-rollback` 放行后重启。',
  );
}

/** 返回某版本是否为已登记的破坏性迁移。 */
export function isBreakingVersion(version: number): boolean {
  return BREAKING_MIGRATIONS.some((item) => item.version === version);
}
