/**
 * 显式放行 user_version 回退的 CLI：`node dist/cli/schema-allow-rollback.js [from] [to]`。
 *
 * 依据：设计文档 v1.1 §4.5 / §7.3 / §10.1 裁决 21 ——
 * `user_version` 等值自检默认挡住镜像回退；fix-forward 优先，
 * 只有人工显式执行本 CLI 才一次性放行，未放行则启动非零退出。
 *
 * 放行状态是一次性的：bootstrap 读取后即消费（删除），避免长期敞口。
 */
import path from 'node:path';
import { assertNodeVersion } from '../bootstrap';
import { loadEnv, type Env, type EnvOverrides } from '../env';
import { openDatabase, closeDatabase, readUserVersion } from '../repositories/db';
import {
  SCHEMA_EXPECTED,
  rollbackAllowancePath,
  writeRollbackAllowance,
  type RollbackAllowance,
} from '../repositories/schema';
import { utcNowIso } from '../lib/today';

export interface AllowRollbackOptions {
  readonly overrides?: EnvOverrides;
  readonly fromVersion?: number;
  readonly toVersion?: number;
}

function parseVersion(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value: number = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`[allow-rollback] ${label} 必须是非负整数: ${raw}`);
  }
  return value;
}

/** 读取库内 user_version（只读打开，不改动数据）。 */
export function readCurrentUserVersion(overrides?: EnvOverrides): number {
  const env: Env = loadEnv(overrides);
  const db = openDatabase({ filename: env.dbFile, readonly: true, fileMustExist: true });
  try {
    return readUserVersion(db);
  } finally {
    closeDatabase(db);
  }
}

/** 签发一次性放行。 */
export function allowRollback(options: AllowRollbackOptions = {}): RollbackAllowance {
  assertNodeVersion();
  const env: Env = loadEnv(options.overrides);
  const fromVersion: number = options.fromVersion ?? readCurrentUserVersion(options.overrides);
  const toVersion: number = options.toVersion ?? SCHEMA_EXPECTED;

  if (fromVersion <= toVersion) {
    throw new RangeError(
      `[allow-rollback] 当前 user_version=${fromVersion} 未高于期望 ${toVersion}，无需放行；` +
        'fix-forward 优先，请先升级应用',
    );
  }
  const allowance: RollbackAllowance = {
    fromVersion,
    toVersion,
    issuedAt: utcNowIso(),
  };
  writeRollbackAllowance(env.dataDir, allowance);
  return allowance;
}

/** CLI 入口。 */
export function main(argv: readonly string[] = process.argv): void {
  try {
    assertNodeVersion();
    const from: number | undefined = parseVersion(argv[2], 'from');
    const to: number | undefined = parseVersion(argv[3], 'to');
    const allowance: RollbackAllowance = allowRollback({ fromVersion: from, toVersion: to });
    process.stdout.write(
      `[ALLOW-ROLLBACK] 已一次性放行 user_version ${allowance.fromVersion} -> ${allowance.toVersion}；` +
        `状态文件 ${rollbackAllowancePath(path.resolve(process.cwd(), 'data'))} 将在下次启动被消费\n`,
    );
  } catch (error) {
    const message: string = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[ALLOW-ROLLBACK] 失败: ${message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
