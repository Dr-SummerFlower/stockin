/**
 * HTTP 层集成测试的测试台：真实数据库 + 真实中间件链 + 真实 Service。
 *
 * 为什么不是 mock：发布审查 P1-2 指出的问题正是「路由 / Service / 中间件
 * 约 6000 行零自动化覆盖」。用 mock 拼出来的测试只能证明自己通，证明不了
 * 这条链路能用。这里走 `bootstrap()` → `assemble()` 的生产路径，唯一替换的
 * 是「数据目录指向 .tmp 下的临时目录」与「静态根指向临时 index.html」。
 *
 * 硬约束：
 *  - 数据库与快照**只能**落在 `.tmp/tests/<随机>/`，绝不碰 `apps/server/data`；
 *  - 每个测试台自己 close（关闭 SQLite 句柄）并删除临时目录；
 *  - 迁移脚本目录显式传入，避免依赖 `resolveMigrationsDir()` 的产物反推
 *    （那套候选链是为 dist 设计的，测试里指向 src 更直白）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import { assemble, type AssembledRuntime } from '../../src/assembly';
import { bootstrap } from '../../src/bootstrap';
import { closeDatabase, type Db } from '../../src/repositories/db';
import { BackupKeyRepository } from '../../src/repositories/backup-key.repository';
import { BackupKeyService } from '../../src/services/backup-key.service';
import { OperationLogRepository } from '../../src/repositories/operation-log.repository';
import { RecordRepository } from '../../src/repositories/record.repository';
import { RecordStatsRepository } from '../../src/repositories/record-stats.repository';
import type { Env } from '../../src/env';
import type { AppDeps } from '../../src/app';
import type { AppEnv } from '../../src/types/hono';
import { nodeRuntime } from '../../src/runtime/node';
import { createFilesystemMigrationSource } from '../../src/runtime/node/migration-source.filesystem';
import { resetLoginRateLimit, resetSecurityRateLimit } from '../../src/middleware/rate-limit';
import { resetIdempotencyStore } from '../../src/services/record.service';
import { resetOrderIdempotencyStore } from '../../src/services/order.service';

/** 测试台固定端口：`env.ts` 要求 http 来源的端口与 PORT 相同。 */
const TEST_PORT = 18090;
const TEST_ORIGIN = `http://127.0.0.1:${TEST_PORT}`;
const TEST_HOST = `127.0.0.1:${TEST_PORT}`;

const repoRoot: string = path.resolve(import.meta.dirname, '../../../..');
const tmpRoot: string = path.join(repoRoot, '.tmp', 'tests');
const migrationsDir: string = path.join(
  repoRoot,
  'apps',
  'server',
  'src',
  'repositories',
  'migrations',
);

/**
 * 测试用逻辑备份公钥（合法 P-256 SPKI DER base64）。
 * 服务端只用公钥封装数据密钥，无需配对私钥；解密在独立脚本测试里覆盖。
 */
export const TEST_BACKUP_PUBLIC_KEY =
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEJ5lDQomj+ROr1cDXBrz5KTHtY/0j9W/42TBFYj6/4XS3K9bzDp9VJmdgWRscHXsWE53lRwrERuPuEj2vzHX+Mw==';

/** 与真实构建产物同形的 index.html（ETag / 缓存头用例需要稳定内容）。 */
const INDEX_HTML =
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>进货统计</title></head><body><div id="root"></div></body></html>';

export interface HarnessRequestInit {
  readonly method?: string;
  readonly json?: unknown;
  readonly body?: BodyInit;
  readonly headers?: Record<string, string>;
  /** 覆盖 Host（用于 CSRF 用例）；默认是本机测试来源的 host。 */
  readonly host?: string;
  /** 覆盖 Origin；`null` 表示**不带** Origin 头。 */
  readonly origin?: string | null;
  /** 会话 Cookie（`sid=...` 形式）；默认不带。 */
  readonly cookie?: string | null;
  /** 是否自动补 Origin（写方法默认 true）。 */
  readonly autoOrigin?: boolean;
}

export interface HarnessResponse<T = unknown> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T;
  readonly setCookie: readonly string[];
}

/** 自助引导测试用的固定密保问题与答案（各用例共享，便于忘记密码用例）。 */
export const HARNESS_SECURITY_QUESTION = '你小学的名称是？';
export const HARNESS_SECURITY_ANSWER = 'test-school';

export interface Harness {
  readonly app: Hono<AppEnv>;
  readonly runtime: AssembledRuntime;
  readonly deps: AppDeps;
  readonly env: Env;
  readonly dir: string;
  readonly backupDir: string;
  request(pathname: string, init?: HarnessRequestInit): Promise<Response>;
  json<T = unknown>(pathname: string, init?: HarnessRequestInit): Promise<HarnessResponse<T>>;
  /** 登录并返回可直接放入 Cookie 头的 `sid=...`。 */
  login(password: string, username?: string): Promise<string>;
  /** 完成自助引导并返回新的 `sid=...`（setup 本身不签会话，需再登录一次）。 */
  completeSetup(username: string, password: string): Promise<string>;
  close(): void;
}

export interface HarnessOptions {
  /** 静态根是否放置真实 index.html（默认放）。 */
  readonly withIndexHtml?: boolean;
  /** 管理员 OAuth 覆盖（默认未配置；管理员端点测试需注入）。 */
  readonly admin?: {
    readonly clientId?: string;
    readonly clientSecret?: string;
    readonly logins?: string;
  };
  /** 逻辑备份公钥覆盖（恢复端到端测试需注入与本地私钥配对的公钥）。 */
  readonly backupPublicKey?: string;
  /** 前端站点源覆盖（验证「开发态登录后跳回 8000」的跳转目标）。 */
  readonly webOrigin?: string;
  /**
   * 覆盖平台的单次导出行上限。
   *
   * 生产上由 `assembly` 按 `excelWrite` 推出（Workers buffer = 5,000 行、Node
   * 流式 = 不限）；测试要在 Node 上验证上限行为，必须显式传入。
   */
  readonly exportMaxRows?: number;
}

/** 创建测试台。返回时数据库已迁移、凭据已生成，但 `setup` 尚未完成。 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  mkdirSync(tmpRoot, { recursive: true });
  const dir: string = mkdtempSync(path.join(tmpRoot, 'h-'));
  const dataDir: string = path.join(dir, 'data');
  const backupDir: string = path.join(dir, 'backups');
  const tmpDir: string = path.join(dir, 'tmp');
  const staticRoot: string = path.join(dir, 'web');
  for (const sub of [dataDir, backupDir, tmpDir, staticRoot]) {
    mkdirSync(sub, { recursive: true });
  }
  if (options.withIndexHtml !== false) {
    writeFileSync(path.join(staticRoot, 'index.html'), INDEX_HTML, 'utf8');
  }

  const base = nodeRuntime({});
  const result = await bootstrap({
    // 只关掉 Node 版本断言：测试不该因为本机小版本不同而整片报红，
    // 版本等值本身由 bootstrap 的既有测试与启动脚本覆盖。
    bundle: {
      ...base,
      platform: { ...base.platform, nodeVersionAssert: 'skip' },
      migrations: () => createFilesystemMigrationSource({ migrationsDir }),
    },
    overrides: {
      nodeEnv: 'test',
      port: TEST_PORT,
      publicOrigin: TEST_ORIGIN,
      publicOrigins: TEST_ORIGIN,
      webOrigin: options.webOrigin ?? '',
      dataDir,
      backupDir,
      tmpDir,
      staticRoot,
      admin: options.admin,
      backupPublicKey: options.backupPublicKey ?? TEST_BACKUP_PUBLIC_KEY,
    },
  });

  const runtime: AssembledRuntime = assemble({
    db: result.db,
    env: result.env,
    repositories: result.repositories,
    ports: result.ports,
    platform: base.platform,
    exportMaxRows: options.exportMaxRows,
  });
  runtime.start();

  // 限流桶与幂等键是模块级单例，跨用例会互相污染，每个测试台重置一次。
  resetLoginRateLimit();
  resetSecurityRateLimit();
  resetIdempotencyStore();
  resetOrderIdempotencyStore();

  const request = async (pathname: string, init: HarnessRequestInit = {}): Promise<Response> => {
    const method: string = (
      init.method ?? (init.json !== undefined ? 'POST' : 'GET')
    ).toUpperCase();
    const headers: Record<string, string> = { host: init.host ?? TEST_HOST, ...init.headers };
    const isWrite: boolean = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(method);
    const autoOrigin: boolean = init.autoOrigin ?? isWrite;
    if (autoOrigin) {
      headers.origin = init.origin ?? TEST_ORIGIN;
    }
    if (init.cookie !== undefined && init.cookie !== null) {
      headers.cookie = init.cookie;
    }
    let body: BodyInit | undefined = init.body;
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.json);
    }
    // `origin: null` 表示刻意不带该头（含写方法）。
    if (init.origin === null) {
      delete headers.origin;
    }
    return runtime.app.request(pathname, { method, headers, body });
  };

  const json = async <T>(
    pathname: string,
    init?: HarnessRequestInit,
  ): Promise<HarnessResponse<T>> => {
    const response: Response = await request(pathname, init);
    const text: string = await response.text();
    let parsed: unknown = null;
    if (text !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return {
      status: response.status,
      headers: response.headers,
      body: parsed as T,
      setCookie: response.headers.getSetCookie(),
    };
  };

  const login = async (password: string, username = 'admin'): Promise<string> => {
    const response: HarnessResponse = await json('/api/auth/login', {
      json: { username, password },
    });
    if (response.status !== 200) {
      throw new Error(`登录失败：${response.status} ${JSON.stringify(response.body)}`);
    }
    const cookie: string | undefined = response.setCookie[0];
    if (cookie === undefined) {
      throw new Error('登录成功但没有下发会话 Cookie');
    }
    return cookie.split(';')[0] as string;
  };

  return {
    app: runtime.app,
    runtime,
    deps: runtime.deps,
    env: result.env,
    dir,
    backupDir,
    request,
    json,
    login,
    async completeSetup(username: string, password: string): Promise<string> {
      const setup = await json('/api/auth/setup', {
        json: {
          username,
          password,
          securityQuestion: HARNESS_SECURITY_QUESTION,
          securityAnswer: HARNESS_SECURITY_ANSWER,
          shopName: '测试店铺',
          expiryThresholdDays: 30,
        },
      });
      if (setup.status !== 200) {
        throw new Error(`setup 失败：${setup.status} ${JSON.stringify(setup.body)}`);
      }
      return login(password, username);
    },
    close(): void {
      runtime.stop();
      closeDatabase(result.db);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export { TEST_HOST, TEST_ORIGIN, TEST_PORT };

/**
 * 构造测试用的备份公钥服务（库 + env 锚点）。
 *
 * 多数测试只关心「有公钥/没公钥」，不关心管理台流程，因此这里直接装配
 * 仓储与服务，不经过 HTTP。需要断言审计或管理台行为时再单独建实例。
 */
export function createTestBackupKeys(
  db: Db,
  logs?: OperationLogRepository,
  defaultPublicKey?: string,
): BackupKeyService {
  // 公钥一律读库内，各测试按需播种（见 seedDefaultBackupKey）。
  return new BackupKeyService({
    db,
    repo: new BackupKeyRepository(db),
    logs: logs ?? new OperationLogRepository(db),
    defaultPublicKey,
  });
}

/** 测试用仪表盘统计仓储（依赖真实 records 仓储）。 */
export function createTestStats(db: Db): RecordStatsRepository {
  return new RecordStatsRepository(db, new RecordRepository(db));
}
