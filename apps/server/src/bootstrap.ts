/**
 * 启动自检、迁移与首启引导。
 *
 * 依据：设计文档 v1.1 §3.6 / §7.2 / §7.4 ——
 * 启动自检（卷可写 / 磁盘余量 / integrity_check / 版本等值）失败 fail-fast；
 * **首启不再生成随机初始密码**，改由首次访问自助引导（`/setup`）设置正式
 * 账密与密保；`meta.setup_completed` 单向 0→1。
 *
 * 2026-11-15：四处平台相关动作改为读 `PlatformProfile` 而不是无条件执行 ——
 * Workers 上「卷可写 / 磁盘余量 / integrity_check / Node 版本断言」既无意义
 * （没有持久盘、没有真实 socket、`process.versions.node` 是兼容层谎报值）
 * 又会直接失败，必须按运行时画像跳过。判定只有 `platform.*` 字段，
 * 不出现 `if (isWorkers)`。
 *
 * 硬约束（主理人裁决 / T01 勘误）：Node 下 `process.versions.node` 必须精确等于
 * `NODE_VERSION_EXPECTED`（26.13.0），不匹配打印明确错误并非零退出。
 */
import fs from 'node:fs';
import path from 'node:path';
import { NODE_VERSION_EXPECTED } from '@stockin/shared';
import { loadEnv, type Env, type EnvOverrides } from './env';
import { logger } from './lib/logger';
import { configureCookiePolicy } from './lib/cookie';
import { configureServerTimeZone, utcNowIso } from './lib/today';
import { assertIntegrity, closeDatabase, tableExists, type Db } from './repositories/db';
import { runMigrations, type MigrationResult } from './repositories/migrations/runner';
import { CredentialRepository } from './repositories/credential.repository';
import { MetaRepository } from './repositories/meta.repository';
import { RecordRepository } from './repositories/record.repository';
import { SessionRepository } from './repositories/session.repository';
import { SettingsRepository } from './repositories/settings.repository';
import { OperationLogRepository } from './repositories/operation-log.repository';
import type {
  BackupPort,
  MigrationSource,
  RuntimeBundle,
  StaticPort,
  VersionStore,
  WorkbookReader,
} from './runtime/ports';

/** 启动自检失败 sentinel 文件名（落在 data 卷；仅持久文件系统运行时使用）。 */
export const SELFCHECK_FAILED_FILE = '.selfcheck_failed';

/** CLI 凭据重置使用的固定账号名（自助引导不再预置账号）。 */
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
    const message =
      `[BOOTSTRAP] Node 版本不匹配：期望 ${expected}，实际 ${actual}。` +
      '本项目锁定 Node 26.13.0，禁止改运行时大版本；请切换到 .node-version 指定版本后重启。';
    process.stderr.write(`${message}\n`);
    throw new BootstrapError(message);
  }
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
  /** 运行时端口集合；决定用哪套驱动、迁移来源、备份方式。 */
  readonly bundle: RuntimeBundle;
  readonly overrides?: EnvOverrides;
}

export interface BootstrapRepositories {
  readonly records: RecordRepository;
  readonly sessions: SessionRepository;
  readonly credentials: CredentialRepository;
  readonly meta: MetaRepository;
  readonly settings: SettingsRepository;
  readonly logs: OperationLogRepository;
}

/** 装配期解析出的端口实例，交给 `assemble()` 复用，避免重复构造。 */
export interface ResolvedPorts {
  readonly versionStore: VersionStore;
  readonly migrations: MigrationSource;
  readonly backup: BackupPort;
  readonly staticPort: StaticPort;
  readonly workbookReader: WorkbookReader;
}

export interface BootstrapResult {
  readonly db: Db;
  readonly env: Env;
  readonly migration: MigrationResult;
  readonly repositories: BootstrapRepositories;
  readonly ports: ResolvedPorts;
}

/**
 * 完整启动流程。抛出 BootstrapError 时由组合根写 sentinel 并非零退出。
 * 返回的 db 保持打开状态，交给 app 使用；优雅停机调用 closeDatabase。
 */
export async function bootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const { bundle } = options;
  const platform = bundle.platform;

  if (platform.nodeVersionAssert === 'strict') {
    assertNodeVersion();
  }
  const env: Env = loadEnv({
    ...options.overrides,
    originScheme: options.overrides?.originScheme ?? platform.originScheme,
  });
  configureServerTimeZone(env.tz);
  configureCookiePolicy({ secure: env.cookieSecure });

  if (platform.persistentFileSystem) {
    for (const [label, dir] of [
      ['DATA_DIR', env.dataDir],
      ['BACKUP_DIR', env.backupDir],
      ['TMP_DIR', env.tmpDir],
    ] as const) {
      assertVolumeWritable(dir, label);
    }
    checkDiskSpace(env.dataDir, env.minFreeBytes);
  } else {
    // 无持久盘：卷可写与余量都不成立（写了也在请求结束后消失），如实记录后跳过。
    logger.info(
      { target: platform.target },
      '[BOOTSTRAP] 当前运行时不提供持久文件卷，已跳过卷可写与磁盘余量自检',
    );
  }

  const db: Db = bundle.openDb(env);
  try {
    if (platform.integrityCheck === 'pragma') {
      assertIntegrity(db);
    } else {
      // DO 的 `PRAGMA integrity_check` 返回 `not authorized: SQLITE_AUTH`，
      // 平台侧另有完整性保障，这里跳过而不是把启动卡死。
      logger.info('[BOOTSTRAP] 当前运行时不允许 PRAGMA integrity_check，已跳过完整性自检');
    }
    // 版本等值自检与「一次性回滚放行」的消费统一由 runMigrations 执行：
    // 若在此处提前校验会消费掉放行状态，导致 runner 第二次校验误判为未放行。

    // 全新空库在迁移前还没有 meta 表，此时 init_state 视作 0（快照元数据用）。
    const initStateForBackup: 0 | 1 = tableExists(db, 'meta')
      ? new MetaRepository(db).initState()
      : 0;

    const versionStore: VersionStore = bundle.versionStore(env);
    const migrations: MigrationSource = bundle.migrations(env);
    const backup: BackupPort = bundle.backup(env);

    const migration: MigrationResult = await runMigrations({
      db,
      migrations,
      versionStore,
      backup,
      initState: initStateForBackup,
      minFreeBytes: env.minFreeBytes,
      keepCount: env.backupKeepCount,
    });

    // meta 必须在迁移成功后才构造（其查询依赖已建表）。
    const meta = new MetaRepository(db);

    // 自助引导：首启不再生成随机初始密码、也不打印任何凭据。
    //
    // 首次访问直接进入 `/setup` 设置正式账密、密保问题与店铺配置。这样
    // Workers 上「初始密码只打印一次、日志里又读不到」的问题从根上消失。
    // 代价是 setup 完成前任何能访问到该实例的人都能成为管理员（抢注风险），
    // 由部署侧在 setup 前限制入口访问承担，README 已写明。
    const credentials = new CredentialRepository(db);
    if (!meta.setupCompleted()) {
      logger.info('[BOOTSTRAP] 尚未完成初始化，首次访问将进入自助引导');
    }

    const repositories: BootstrapRepositories = {
      records: new RecordRepository(db),
      sessions: new SessionRepository(db),
      credentials,
      meta,
      settings: new SettingsRepository(db),
      logs: new OperationLogRepository(db),
    };
    const ports: ResolvedPorts = {
      versionStore,
      migrations,
      backup,
      staticPort: await bundle.staticPort(env),
      workbookReader: bundle.workbookReader(env),
    };
    return { db, env, migration, repositories, ports };
  } catch (error) {
    closeDatabase(db);
    throw error;
  }
}
