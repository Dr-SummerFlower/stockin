/**
 * 启动自检、迁移与首启引导。
 *
 * 依据：设计文档 v1.1 §3.6 / §7.2 / §7.4 ——
 * 启动自检（卷可写 / 磁盘余量 / integrity_check / user_version）失败 fail-fast；
 * 失败写 `.selfcheck_failed` sentinel 后非零退出，避免无限重启风暴；
 * 首启生成 `admin` + 随机初始密码并打印 `[BOOTSTRAP]`；
 * **卷保留时不重生成、不重打印**；`meta.setup_completed` 单向 0→1。
 *
 * 硬约束（主理人裁决 / T01 勘误）：`process.versions.node` 必须精确等于
 * `NODE_VERSION_EXPECTED`（26.13.0），不匹配打印明确错误并非零退出。
 */
import fs from 'node:fs';
import path from 'node:path';
import { NODE_VERSION_EXPECTED } from '@stockin/shared';
import { loadEnv, type Env, type EnvOverrides } from './env';
import { logger } from './lib/logger';
import {
  derivePasswordHash,
  generateReadablePassword,
  generateSaltHex,
  serializeScryptParams,
} from './lib/crypto';
import { configureServerTimeZone, utcNowIso } from './lib/today';
import {
  assertIntegrity,
  closeDatabase,
  openDatabase,
  tableExists,
  type Db,
} from './repositories/db';
import { runMigrations, type MigrationResult } from './repositories/migrations/runner';
import { CredentialRepository } from './repositories/credential.repository';
import { MetaRepository } from './repositories/meta.repository';
import { RecordRepository } from './repositories/record.repository';
import { SessionRepository } from './repositories/session.repository';
import { SettingsRepository } from './repositories/settings.repository';
import { OperationLogRepository } from './repositories/operation-log.repository';

/** 启动自检失败 sentinel 文件名（落在 data 卷）。 */
export const SELFCHECK_FAILED_FILE = '.selfcheck_failed';

/** 首启默认账号（文档 §7.4 `[BOOTSTRAP] admin + 随机初始密码`）。 */
export const BOOTSTRAP_USERNAME = 'admin';

export class BootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapError';
  }
}

/** Node 版本精确断言；不匹配时打印明确错误（调用方负责非零退出）。 */
export function assertNodeVersion(expected: string = NODE_VERSION_EXPECTED): void {
  const actual: string = process.versions.node;
  if (actual !== expected) {
    const message = `[BOOTSTRAP] Node 版本不匹配：期望 ${expected}，实际 ${actual}。` +
      '本项目锁定 Node 26.13.0，禁止改运行时大版本；请切换到 .node-version 指定版本后重启。';
    process.stderr.write(`${message}\n`);
    throw new BootstrapError(message);
  }
}

/**
 * 解析迁移脚本目录（QA 修复 A3：**完全不依赖 process.cwd()**）。
 *
 * tsc 只编译 `.ts`，不会把 `001_init.sql` 拷进 dist；QA 实测
 * `apps/server/dist/repositories/migrations/` 里只有 `runner.js`。
 * 因此每个候选都以「目录内存在 001_init.sql」判定，避免选中空目录。
 *
 * 优先级：
 *  ① `BootstrapOptions.migrationsDir` / `MIGRATIONS_DIR` 显式覆盖；
 *  ② 编译产物内 migrations 目录（`<dist>/repositories/migrations`）——
 *     T05 Dockerfile 会把 `001_init.sql` 一并拷进 dist；
 *  ③ 从 `__filename` 反推的源码目录（`<root>/src/repositories/migrations`）——
 *     本机 / tsx 开发形态；
 *  ④ 兼容 `rootDir=src` 时 `<root>/dist/src/*.js` 的编译形态。
 *
 * `node apps/server/dist/index.js` 在任意 cwd 下都能命中 ②（容器）或 ③（本机）。
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
  throw new BootstrapError(
    `[BOOTSTRAP] 找不到 ${marker}，已尝试: ${candidates.join(' | ')}。` +
      'T05 runtime 镜像必须把 migrations/*.sql 一并拷入 dist（或设置 MIGRATIONS_DIR）。',
  );
}

/** 写 sentinel；返回写入路径，写失败不覆盖原始错误。 */
export function writeSelfcheckFailed(dataDir: string, error: unknown): string {
  const file: string = path.join(dataDir, SELFCHECK_FAILED_FILE);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const message: string = error instanceof Error ? error.message : String(error);
    fs.writeFileSync(file, `${utcNowIso()}\n${message}\n`, 'utf8');
  } catch {
    // 卷不可写时无法写 sentinel，原始错误仍由调用方上报。
  }
  return file;
}

/** 卷可写检查：实际写一个临时文件再删除，不做只读 stat 的假阳性判断。 */
export function assertVolumeWritable(dir: string, label: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const probe: string = path.join(dir, `.write-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, 'ok', 'utf8');
    const content: string = fs.readFileSync(probe, 'utf8');
    if (content !== 'ok') {
      throw new BootstrapError(`[BOOTSTRAP] ${label} 写入校验失败: ${dir}`);
    }
  } finally {
    fs.rmSync(probe, { force: true });
  }
}

/** 磁盘余量检查：不足只告警，不阻断启动（文档 §7.5）。 */
export function checkDiskSpace(dir: string, minFreeBytes: number): boolean {
  try {
    const stats: fs.StatsFs = fs.statfsSync(dir);
    const free: number = stats.bavail * stats.bsize;
    if (free < minFreeBytes) {
      logger.warn(
        { dir, freeBytes: free, minFreeBytes },
        '[BOOTSTRAP] 磁盘余量偏低，备份可能被跳过；请在应用内清理旧快照',
      );
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

export interface BootstrapOptions {
  readonly overrides?: EnvOverrides;
  readonly migrationsDir?: string;
  /** 关闭 [BOOTSTRAP] 明文打印（仅供内联自测使用，生产必须开启）。 */
  readonly suppressCredentialPrint?: boolean;
}

export interface BootstrapRepositories {
  readonly records: RecordRepository;
  readonly sessions: SessionRepository;
  readonly credentials: CredentialRepository;
  readonly meta: MetaRepository;
  readonly settings: SettingsRepository;
  readonly logs: OperationLogRepository;
}

export interface BootstrapResult {
  readonly db: Db;
  readonly env: Env;
  readonly initializedNow: boolean;
  /** 仅首启时非 null；卷保留重启恒为 null。 */
  readonly initialPassword: string | null;
  readonly migration: MigrationResult;
  readonly repositories: BootstrapRepositories;
}

/**
 * 完整启动流程。抛出 BootstrapError 时由 main() 写 sentinel 并非零退出。
 * 返回的 db 保持打开状态，交给 T03b 的 app 使用；优雅停机调用 closeDatabase。
 */
export async function bootstrap(options: BootstrapOptions = {}): Promise<BootstrapResult> {
  assertNodeVersion();
  const env: Env = loadEnv(options.overrides);
  configureServerTimeZone(env.tz);

  for (const [label, dir] of [
    ['DATA_DIR', env.dataDir],
    ['BACKUP_DIR', env.backupDir],
    ['TMP_DIR', env.tmpDir],
  ] as const) {
    assertVolumeWritable(dir, label);
  }
  checkDiskSpace(env.dataDir, env.minFreeBytes);

  const db: Db = openDatabase({ filename: env.dbFile });
  try {
    assertIntegrity(db);
    // user_version 等值自检与「一次性回滚放行」的消费统一由 runMigrations 执行：
    // 若在此处提前校验会消费掉放行状态，导致 runner 第二次校验误判为未放行。

    // 全新空库在迁移前还没有 meta 表，此时 init_state 视作 0（快照元数据用）。
    const initStateForBackup: 0 | 1 = tableExists(db, 'meta')
      ? new MetaRepository(db).initState()
      : 0;
    const migration: MigrationResult = await runMigrations({
      db,
      migrationsDir: resolveMigrationsDir(options.migrationsDir),
      dataDir: env.dataDir,
      backupDir: env.backupDir,
      initState: initStateForBackup,
      minFreeBytes: env.minFreeBytes,
      keepCount: env.backupKeepCount,
    });

    // meta 必须在迁移成功后才构造（其查询依赖已建表）。
    const meta = new MetaRepository(db);

    // 首启凭据：卷保留（credentials 行已存在 / setup 已完成）时绝不重生成、不重打印。
    const credentials = new CredentialRepository(db);
    let initializedNow = false;
    let initialPassword: string | null = null;
    if (credentials.find() === null && !meta.setupCompleted()) {
      const password: string = generateReadablePassword();
      const salt: string = generateSaltHex();
      const hash: string = derivePasswordHash(password, salt);
      const now: string = utcNowIso();
      credentials.create({
        username: BOOTSTRAP_USERNAME,
        passwordHash: hash,
        salt,
        scryptParams: serializeScryptParams(),
        isInitial: 1,
        createdAt: now,
        updatedAt: now,
      });
      // 首启只经 stdout 打印 [BOOTSTRAP]，不写 operation_logs：
      // 此时 setup 尚未完成，写 SETUP_COMPLETE 会污染审计语义（文档 §7.4 要求收尾清理首启日志）。
      initializedNow = true;
      initialPassword = password;
      if (options.suppressCredentialPrint !== true) {
        process.stdout.write(
          `[BOOTSTRAP] username=${BOOTSTRAP_USERNAME} password=${password}\n`,
        );
      }
    }

    const repositories: BootstrapRepositories = {
      records: new RecordRepository(db),
      sessions: new SessionRepository(db),
      credentials,
      meta,
      settings: new SettingsRepository(db),
      logs: new OperationLogRepository(db),
    };
    return { db, env, initializedNow, initialPassword, migration, repositories };
  } catch (error) {
    closeDatabase(db);
    throw error;
  }
}

/** CLI 入口：供 `node dist/bootstrap.js` 或 T05 CMD 前的自检阶段调用。 */
export async function main(): Promise<void> {
  let dataDir: string = path.resolve(process.cwd(), 'data');
  try {
    assertNodeVersion();
    dataDir = loadEnv().dataDir;
    const result: BootstrapResult = await bootstrap();
    logger.info(
      {
        initializedNow: result.initializedNow,
        userVersion: result.migration.toVersion,
        applied: result.migration.applied,
      },
      '[BOOTSTRAP] 启动自检通过',
    );
    // CLI 自检模式不常驻，正常关闭连接；T03b 的 app 模式不调用 main()。
    closeDatabase(result.db);
  } catch (error) {
    writeSelfcheckFailed(dataDir, error);
    logger.fatal(
      { err: error instanceof Error ? error.message : String(error) },
      '[BOOTSTRAP] 启动自检失败，已写 .selfcheck_failed',
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
