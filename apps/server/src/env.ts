/**
 * 运行时环境解析与校验。
 *
 * 依据：设计文档 v1.1 §7.1（PUBLIC_ORIGIN=http://<IP>:<PORT>、PORT 默认 8080、
 * COOKIE_SECURE=false、TZ=Asia/Shanghai）、§7.2（data/backups/tmp 三卷）、
 * §5.2（CSRF 按含端口的字面量精确比对）。
 *
 * 所有默认值与业务常量一律取自 `@stockin/shared`，本文件不硬编码实现级常量。
 */
import path from 'node:path';
import {
  BACKUP_KEEP_COUNT,
  COOKIE_POLICY,
  DEFAULT_PORT,
  DEFAULT_TZ,
  IMPORT_MAX_UNCOMPRESSED_BYTES,
  NODE_VERSION_EXPECTED,
  SESSION_COOKIE_NAME,
  TMPFS_BYTES,
} from '@stockin/shared';

/** 解析后的不可变环境快照。 */
export interface Env {
  readonly nodeEnv: string;
  readonly port: number;
  readonly publicOrigin: string;
  readonly tz: string;
  /** 本期固定 false（COOKIE_POLICY.secure 为唯一真源）。 */
  readonly cookieSecure: false;
  readonly cookieName: string;
  readonly dataDir: string;
  readonly backupDir: string;
  readonly tmpDir: string;
  readonly dbFile: string;
  readonly staticRoot: string;
  readonly backupKeepCount: number;
  readonly tmpfsBytes: number;
  readonly minFreeBytes: number;
  readonly nodeVersionExpected: string;
}

/** loadEnv 的可覆盖项，供内联自测与 CLI 注入临时目录使用。 */
export interface EnvOverrides {
  readonly cwd?: string;
  readonly nodeEnv?: string;
  readonly port?: number | string;
  readonly publicOrigin?: string;
  readonly tz?: string;
  readonly cookieSecure?: string;
  readonly dataDir?: string;
  readonly backupDir?: string;
  readonly tmpDir?: string;
  readonly staticRoot?: string;
}

/** `http://<IP或主机名>:<PORT>` 字面量；禁止 https、路径、查询串、缺省端口。 */
const PUBLIC_ORIGIN_PATTERN = /^http:\/\/([^/:?#]+|\[[0-9a-fA-F:]+\]):(\d{1,5})$/;

/** 最小可用空间推导：文档 §7.5 建议 200MB，取 shared 导入上限的 10 倍，不硬编码。 */
const MIN_FREE_BYTES = 10 * IMPORT_MAX_UNCOMPRESSED_BYTES;

function parsePort(raw: number | string | undefined): number {
  if (raw === undefined || raw === '') {
    return DEFAULT_PORT;
  }
  const value: number = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new RangeError(`[env] PORT 必须是 1~65535 的整数，收到: ${String(raw)}`);
  }
  return value;
}

function resolveDir(raw: string | undefined, cwd: string, fallback: string): string {
  return path.resolve(cwd, raw ?? fallback);
}

/** 判断 child 是否位于 parent 目录之下（含自身），用于阻止数据卷落入静态托管根。 */
export function isUnderDirectory(child: string, parent: string): boolean {
  const relative: string = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * 解析并校验环境。任何不合法配置直接抛错，由 bootstrap 统一 fail-fast。
 *
 * @param overrides 覆盖项（CLI / 自测注入）
 */
export function loadEnv(overrides: EnvOverrides = {}): Env {
  const cwd: string = path.resolve(overrides.cwd ?? process.cwd());
  const port: number = parsePort(overrides.port ?? process.env.PORT);
  const rawOrigin: string =
    overrides.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`;
  const originMatch: RegExpExecArray | null = PUBLIC_ORIGIN_PATTERN.exec(rawOrigin);
  if (originMatch === null) {
    throw new RangeError(
      `[env] PUBLIC_ORIGIN 必须是含端口的字面量 http://<IP>:<PORT>，收到: ${rawOrigin}`,
    );
  }
  const originPort: number = Number.parseInt(originMatch[2] ?? '', 10);
  if (originPort !== port) {
    throw new RangeError(
      `[env] PUBLIC_ORIGIN 端口(${originPort}) 必须与 PORT(${port}) 一致：${rawOrigin}`,
    );
  }

  const rawSecure: string = overrides.cookieSecure ?? process.env.COOKIE_SECURE ?? 'false';
  if (rawSecure !== '' && rawSecure !== 'false' && rawSecure !== '0') {
    throw new RangeError('[env] 本期 COOKIE_SECURE 固定为 false，不接受 true');
  }

  const tz: string = overrides.tz ?? process.env.TZ ?? DEFAULT_TZ;
  if (tz.trim() === '') {
    throw new RangeError('[env] TZ 不能为空');
  }

  const dataDir: string = resolveDir(overrides.dataDir ?? process.env.DATA_DIR, cwd, 'data');
  const backupDir: string = resolveDir(
    overrides.backupDir ?? process.env.BACKUP_DIR,
    cwd,
    'backups',
  );
  const tmpDir: string = resolveDir(overrides.tmpDir ?? process.env.TMP_DIR, cwd, 'tmp');
  const staticRoot: string = resolveDir(
    overrides.staticRoot ?? process.env.WEB_DIST_DIR,
    cwd,
    path.join('..', 'web', 'dist'),
  );

  // §7.2 / Hono 官方对大小写不敏感文件系统的安全警告：三卷绝不能落进静态托管根。
  for (const [label, dir] of [
    ['DATA_DIR', dataDir],
    ['BACKUP_DIR', backupDir],
    ['TMP_DIR', tmpDir],
  ] as const) {
    if (isUnderDirectory(dir, staticRoot)) {
      throw new RangeError(`[env] ${label} 不得位于静态托管根之下: ${dir}`);
    }
  }

  return {
    nodeEnv: overrides.nodeEnv ?? process.env.NODE_ENV ?? 'production',
    port,
    publicOrigin: rawOrigin,
    tz,
    cookieSecure: COOKIE_POLICY.secure,
    cookieName: SESSION_COOKIE_NAME,
    dataDir,
    backupDir,
    tmpDir,
    dbFile: path.join(dataDir, 'stockin.db'),
    staticRoot,
    backupKeepCount: BACKUP_KEEP_COUNT,
    tmpfsBytes: TMPFS_BYTES,
    minFreeBytes: MIN_FREE_BYTES,
    nodeVersionExpected: NODE_VERSION_EXPECTED,
  };
}

/** 供 T03b CSRF 中间件使用：解析出可信 Origin 的主机部分（含端口）。 */
export function publicOriginHost(env: Env): string {
  return env.publicOrigin.slice('http://'.length);
}
