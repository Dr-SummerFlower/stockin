/**
 * 运行时环境解析与校验。
 *
 * 依据：设计文档 v1.1 §7.1（PUBLIC_ORIGIN=http://<IP>:<PORT>、PORT 默认 8080、
 * COOKIE_SECURE=false、TZ=Asia/Shanghai）、§7.2（data/backups/tmp 三卷）、
 * §5.2（CSRF 按含端口的字面量精确比对）。
 *
 * 可信来源支持多值：PUBLIC_ORIGINS（逗号分隔）> PUBLIC_ORIGIN（单值，旧写法）；
 * 均未设置时默认同时含 127.0.0.1 与 localhost 两种回环写法；
 * 任一回环写法会自动等价展开到同机其它回环写法。
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
  /** 主来源 = `publicOrigins` 的首项（保留向后兼容：日志 / Cookie 等沿用单值）。 */
  readonly publicOrigin: string;
  /** 全部可信来源（CSRF 逐项比对）。默认同时含 `127.0.0.1` 与 `localhost` 两种回环写法。 */
  readonly publicOrigins: readonly string[];
  readonly tz: string;
  /** 本期固定 false（COOKIE_POLICY.secure 为唯一真源）。 */
  readonly cookieSecure: false;
  readonly cookieName: string;
  readonly dataDir: string;
  readonly backupDir: string;
  readonly tmpDir: string;
  readonly dbFile: string;
  /** 仅当显式设置 WEB_DIST_DIR（或自测覆盖）时才非 undefined；否则由 app.ts 用 defaultStaticRoot() 兜底。 */
  readonly staticRoot?: string;
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
  /** 逗号分隔的多来源字面量，优先级高于 `publicOrigin`。 */
  readonly publicOrigins?: string;
  readonly tz?: string;
  readonly cookieSecure?: string;
  readonly dataDir?: string;
  readonly backupDir?: string;
  readonly tmpDir?: string;
  readonly staticRoot?: string;
}

/** `http://<IP或主机名>:<PORT>` 字面量；禁止 https、路径、查询串、缺省端口。 */
const PUBLIC_ORIGIN_PATTERN = /^http:\/\/([^/:?#]+|\[[0-9a-fA-F:]+\]):(\d{1,5})$/;

/**
 * 回环主机写法。信任其中任一即自动等价展开到同机其它写法，
 * 避免「配了 127.0.0.1 却用 localhost 登录被 403」这类同机地址不一致问题。
 * 只对回环主机生效，非回环（如局域网 IP）不会自动扩展。
 */
const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '[::1]'];

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
  // 可信来源集合：PUBLIC_ORIGINS（逗号分隔，优先）> PUBLIC_ORIGIN（单值，旧写法）
  // > 默认同时包含 127.0.0.1 与 localhost 两种回环写法，保证同机用不同地址都能登录。
  const rawOriginsCsv: string | undefined = overrides.publicOrigins ?? process.env.PUBLIC_ORIGINS;
  const legacySingle: string | undefined = overrides.publicOrigin ?? process.env.PUBLIC_ORIGIN;

  let rawOrigins: string[] = [];
  if (rawOriginsCsv !== undefined && rawOriginsCsv.trim() !== '') {
    rawOrigins = rawOriginsCsv
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
  } else if (legacySingle !== undefined && legacySingle.trim() !== '') {
    rawOrigins = [legacySingle.trim()];
  }
  if (rawOrigins.length === 0) {
    rawOrigins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  }

  const publicOrigins: string[] = [];
  for (const rawOrigin of rawOrigins) {
    const originMatch: RegExpExecArray | null = PUBLIC_ORIGIN_PATTERN.exec(rawOrigin);
    if (originMatch === null) {
      throw new RangeError(
        `[env] 每个可信来源必须是含端口的字面量 http://<IP>:<PORT>，收到: ${rawOrigin}`,
      );
    }
    const originPort: number = Number.parseInt(originMatch[2] ?? '', 10);
    if (originPort !== port) {
      throw new RangeError(`[env] 来源端口(${originPort}) 必须与 PORT(${port}) 一致：${rawOrigin}`);
    }
    if (!publicOrigins.includes(rawOrigin)) {
      publicOrigins.push(rawOrigin);
    }
    // 回环等价展开：信任任一回环写法即等价信任同机其它写法（同端口）。
    const originHost: string = originMatch[1] ?? '';
    if (LOOPBACK_HOSTS.includes(originHost)) {
      for (const loopbackHost of LOOPBACK_HOSTS) {
        const candidate: string = `http://${loopbackHost}:${port}`;
        if (!publicOrigins.includes(candidate)) {
          publicOrigins.push(candidate);
        }
      }
    }
  }
  const publicOrigin: string = publicOrigins[0] ?? `http://127.0.0.1:${port}`;

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
  // 静态根：仅当显式设置 WEB_DIST_DIR（或自测覆盖）时才解析为具体路径；
  // 未设置时留 undefined，由 app.ts 的 defaultStaticRoot() 从 __filename 反推
  // apps/web/dist，保证「裸跑 node dist/index.js」时不受 cwd 影响（修复 A4）。
  const rawStaticRoot: string | undefined = overrides.staticRoot ?? process.env.WEB_DIST_DIR;
  const staticRoot: string | undefined = rawStaticRoot
    ? path.resolve(cwd, rawStaticRoot)
    : undefined;

  // §7.2 / Hono 官方对大小写不敏感文件系统的安全警告：三卷绝不能落进静态托管根。
  // 仅在静态根明确指定时才校验（未指定时由 app.ts 用 defaultStaticRoot() 兜底，
  // 该兜底从 __filename 反推，与 cwd 无关）。
  if (staticRoot !== undefined) {
    for (const [label, dir] of [
      ['DATA_DIR', dataDir],
      ['BACKUP_DIR', backupDir],
      ['TMP_DIR', tmpDir],
    ] as const) {
      if (isUnderDirectory(dir, staticRoot)) {
        throw new RangeError(`[env] ${label} 不得位于静态托管根之下: ${dir}`);
      }
    }
  }

  return {
    nodeEnv: overrides.nodeEnv ?? process.env.NODE_ENV ?? 'production',
    port,
    publicOrigin,
    publicOrigins,
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
