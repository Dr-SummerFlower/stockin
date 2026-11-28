/**
 * 运行时环境解析与校验。
 *
 * 依据：设计文档 v1.1 §7.1（PUBLIC_ORIGIN=http://<IP>:<PORT>、PORT 默认 8080、
 * COOKIE_SECURE=false、TZ=Asia/Shanghai）、§7.2（data/backups/tmp 三卷）、
 * §5.2（CSRF 按含端口的字面量精确比对）。
 *
 * 可信来源支持多值：PUBLIC_ORIGINS（逗号分隔）> PUBLIC_ORIGIN（单值，旧写法）；
 * 均未设置时默认同时含 localhost 与 127.0.0.1 两种回环写法（localhost 为首项）；
 * 任一回环写法会自动等价展开到同机其它回环写法。
 * 前端与后端分端口时（本地开发）用 WEB_ORIGIN 指定浏览器侧站点源。
 *
 * 所有默认值与业务常量一律取自 `@stockin/shared`，本文件不硬编码实现级常量。
 */
import path from 'node:path';
import {
  BACKUP_KEEP_COUNT,
  DEFAULT_PORT,
  DEFAULT_TZ,
  IMPORT_MAX_UNCOMPRESSED_BYTES,
  NODE_VERSION_EXPECTED,
  SESSION_COOKIE_NAME,
  TMPFS_BYTES,
} from '@stockin/shared';

/** 管理员 GitHub OAuth 配置（三项缺一即视为未启用）。 */
export interface AdminAuthConfig {
  readonly enabled: boolean;
  readonly githubClientId: string;
  readonly githubClientSecret: string;
  /** 允许登录的 GitHub 登录名，统一小写、去重。 */
  readonly allowedLogins: readonly string[];
}

/** 解析后的不可变环境快照。 */
export interface Env {
  readonly nodeEnv: string;
  readonly port: number;
  /** 主来源 = `publicOrigins` 的首项（保留向后兼容：日志 / Cookie 等沿用单值）。 */
  readonly publicOrigin: string;
  /** 全部可信来源（CSRF 逐项比对）。默认同时含 `localhost` 与 `127.0.0.1` 两种回环写法。 */
  readonly publicOrigins: readonly string[];
  /**
   * 前端站点源（浏览器地址栏里的地址）；未配置时为 `null`，表示与后端同源。
   *
   * 只在「前端与后端不同端口」的场景下才需要设置 —— 本地开发即如此：
   * Umi dev server 在 `http://localhost:8000`，Hono 在 8080。此时 OAuth 回调
   * 仍必须落在 `publicOrigin`（GitHub 只接受已登记的地址），但回调之后的
   * 浏览器跳转要回前端，否则会停在没有静态产物的后端端口（白屏）。
   * 生产由 Hono 同源托管 `web/dist`，留空即可，跳转一律用相对路径。
   */
  readonly webOrigin: string | null;
  /** 可信来源的 scheme：Node 纯 HTTP 为 `http`，Workers 为 `https`。 */
  readonly originScheme: OriginScheme;
  readonly tz: string;
  /** 是否给会话 Cookie 加 `Secure`：由来源 scheme 决定（https 必须加，http 不能加）。 */
  readonly cookieSecure: boolean;
  readonly cookieName: string;
  /**
   * 管理员 GitHub OAuth 配置。
   *
   * 三项缺一即视为未启用（`enabled=false`）：管理员入口返回 503
   * `ADMIN_NOT_CONFIGURED`，店主侧功能完全不受影响。
   */
  readonly admin: AdminAuthConfig;
  readonly dataDir: string;
  readonly backupDir: string;
  readonly tmpDir: string;
  readonly dbFile: string;
  /** 仅当显式设置 WEB_DIST_DIR（或自测覆盖）时才非 undefined；否则由运行时兜底。 */
  readonly staticRoot?: string;
  readonly backupKeepCount: number;
  /**
   * 逻辑备份的默认公钥（DER/SPKI base64），**仅用于首次启动播种**。
   *
   * 库内 `backup_keys` 为空时，bootstrap 把这一把写入并设为启用中；之后
   * 加密与验签一律只读库内公钥，本变量不再参与任何运行期逻辑。空串表示
   * 未提供默认公钥（全新实例需自行到管理台添加公钥才能启用备份）。
   */
  readonly backupPublicKey: string;
  readonly tmpfsBytes: number;
  readonly minFreeBytes: number;
  readonly nodeVersionExpected: string;
}

/** `loadEnv` 的可覆盖项，供内联自测与 CLI 注入临时目录使用。 */
export interface EnvOverrides {
  readonly cwd?: string;
  readonly nodeEnv?: string;
  readonly port?: number | string;
  readonly publicOrigin?: string;
  /** 逗号分隔的多来源字面量，优先级高于 `publicOrigin`。 */
  readonly publicOrigins?: string;
  /** 前端站点源（仅开发态前后端分端口时需要）。 */
  readonly webOrigin?: string;
  /**
   * 来源 scheme。由运行时画像（`ORIGIN_SCHEME`）注入；
   * 不传时回落到 `process.env.ORIGIN_SCHEME`，再回落 `http`（=改造前行为）。
   */
  readonly originScheme?: OriginScheme;
  readonly tz?: string;
  readonly cookieSecure?: string;
  readonly dataDir?: string;
  readonly backupDir?: string;
  readonly tmpDir?: string;
  readonly staticRoot?: string;
  /** 首次启动播种用的默认逻辑备份公钥（单值）。 */
  readonly backupPublicKey?: string;
  /** 管理员 OAuth 覆盖（自测注入；缺省读 process.env.GITHUB_*）。 */
  readonly admin?: {
    readonly clientId?: string;
    readonly clientSecret?: string;
    readonly logins?: string;
  };
}

/**
 * 可信来源字面量：`<scheme>://<IP或主机名>[:<端口>]`。
 *
 * 端口是否必填由 scheme 决定（见 `loadEnv`）：
 *  - `http`（Node 纯 HTTP）→ 端口必填且必须等于 `PORT`，与文档 §5.2 的
 *    「含端口的字面量精确比对」一致；
 *  - `https`（Workers）→ 端口可省略（隐式 443），写了就必须是 443 或 `PORT`。
 *
 * 两种都不接受路径、查询串。
 */
const ORIGIN_PATTERN = /^(https?):\/\/([^/:?#]+|\[[0-9a-fA-F:]+\])(?::(\d{1,5}))?$/;

/** 支持的来源 scheme。 */
export type OriginScheme = 'http' | 'https';

/**
 * 回环主机写法。信任其中任一即自动等价展开到同机其它写法，
 * 避免「配了 127.0.0.1 却用 localhost 登录被 403」这类同机地址不一致问题。
 * 只对回环主机生效，非回环（如局域网 IP）不会自动扩展。
 */
const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '[::1]'];

/** 最小可用空间推导：文档 §7.5 建议 200MB，取 shared 导入上限的 10 倍，不硬编码。 */
const MIN_FREE_BYTES = 10 * IMPORT_MAX_UNCOMPRESSED_BYTES;

/**
 * P-256 SPKI/DER 的 base64 形状：91 个字符 + `=` 补齐，字符集固定。
 * 只在启动时做形状校验，真正的密钥可用性由 WebCrypto 导入失败时报错
 * （封装阶段已有错误日志，避免把异步导入塞进同步的 `loadEnv`）。
 */
const BACKUP_PUBLIC_KEY_PATTERN = /^[A-Za-z0-9+/]{80,}={0,2}$/;

/**
 * 解析首次启动播种用的默认公钥（单值）。
 *
 * 这是「一次性种子」，不是运行期锚点：bootstrap 在库内 `backup_keys` 为空时
 * 把它写入并设为启用中，之后加密与验签只读库内，本值不再参与。
 * 形状不合法直接抛错，避免把非法公钥播种进库。
 */
function parseBackupPublicKey(raw?: string): string {
  const key: string = (raw ?? '').trim();
  if (key === '') {
    return '';
  }
  if (!BACKUP_PUBLIC_KEY_PATTERN.test(key)) {
    throw new RangeError(
      '[env] 逻辑备份默认公钥必须是单行 base64（P-256 SPKI/DER），检查是否带换行、空格或粘贴了私钥',
    );
  }
  return key;
}

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

/** 解析来源 scheme；空串视为 `http`（改造前行为），非法值直接报错。 */
export function resolveOriginScheme(raw?: string): OriginScheme {
  const value: string = (raw ?? '').trim();
  if (value === '' || value === 'http') {
    return 'http';
  }
  if (value === 'https') {
    return 'https';
  }
  throw new RangeError(`[env] ORIGIN_SCHEME 必须是 http 或 https，收到: ${raw ?? ''}`);
}

/**
 * 解析前端站点源（`WEB_ORIGIN`）。
 *
 * 与可信来源不同，这里**不要求端口等于 `PORT`** —— 它存在的意义正是
 * 「前端在另一个端口」。但仍必须是同 scheme 的原生字面量：带路径、查询串或
 * 别的 scheme 都直接报错，否则拼出来的跳转地址会重复路径段（如
 * `http://localhost:8000/admin` + `/admin/login`）。末尾斜杠会被归一化掉
 * （手写配置时最常见的手误）。
 */
export function parseWebOrigin(raw: string | undefined, originScheme: OriginScheme): string | null {
  const value: string = (raw ?? '').trim().replace(/\/+$/, '');
  if (value === '') {
    return null;
  }
  const match: RegExpExecArray | null = ORIGIN_PATTERN.exec(value);
  if (match === null) {
    throw new RangeError(
      `[env] WEB_ORIGIN 必须是 ${originScheme}://<主机>[:<端口>] 字面量（不带路径），收到: ${value}`,
    );
  }
  if ((match[1] ?? '') !== originScheme) {
    throw new RangeError(
      `[env] WEB_ORIGIN 的 scheme 必须与 ORIGIN_SCHEME(${originScheme}) 一致：${value}`,
    );
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
  const originScheme: OriginScheme = resolveOriginScheme(
    overrides.originScheme ?? process.env.ORIGIN_SCHEME,
  );

  // 可信来源集合：PUBLIC_ORIGINS（逗号分隔，优先）> PUBLIC_ORIGIN（单值，旧写法）
  // > 默认同时包含 localhost 与 127.0.0.1 两种回环写法，保证同机用不同地址都能登录。
  // 首项是主来源（OAuth 回调、日志、Cookie 语义都沿用它），因此 localhost 排第一：
  // 它既是浏览器眼里的安全上下文，也必须是 GitHub OAuth App 里登记的那个字面量。
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
    rawOrigins = [`${originScheme}://localhost:${port}`, `${originScheme}://127.0.0.1:${port}`];
  }

  const publicOrigins: string[] = [];
  for (const rawOrigin of rawOrigins) {
    const originMatch: RegExpExecArray | null = ORIGIN_PATTERN.exec(rawOrigin);
    if (originMatch === null) {
      throw new RangeError(
        `[env] 每个可信来源必须是 ${originScheme}://<IP或域名>[:<端口>] 字面量，收到: ${rawOrigin}`,
      );
    }
    const originHostScheme: string = originMatch[1] ?? '';
    if (originHostScheme !== originScheme) {
      throw new RangeError(
        `[env] 来源 scheme(${originHostScheme}) 与 ORIGIN_SCHEME(${originScheme}) 不一致：${rawOrigin}`,
      );
    }
    const rawPort: string | undefined = originMatch[3];
    if (originScheme === 'http') {
      // 纯 HTTP 直连：端口必填且必须与 PORT 一致（CSRF 按含端口字面量精确比对）。
      if (rawPort === undefined) {
        throw new RangeError(`[env] http 来源必须写明端口（http://<IP>:<PORT>）：${rawOrigin}`);
      }
      const originPort: number = Number.parseInt(rawPort, 10);
      if (originPort !== port) {
        throw new RangeError(
          `[env] 来源端口(${originPort}) 必须与 PORT(${port}) 一致：${rawOrigin}`,
        );
      }
    } else if (rawPort !== undefined) {
      // HTTPS：省略端口即 443；写了就必须是 443 或 PORT（本地 wrangler dev 会用到后者）。
      const originPort: number = Number.parseInt(rawPort, 10);
      if (originPort !== 443 && originPort !== port) {
        throw new RangeError(`[env] https 来源端口只能是 443 或 PORT(${port})：${rawOrigin}`);
      }
    }
    if (!publicOrigins.includes(rawOrigin)) {
      publicOrigins.push(rawOrigin);
    }
    // 回环等价展开：信任任一回环写法即等价信任同机其它写法（同 scheme、同端口）。
    // 只对回环主机生效，非回环（如局域网 IP / 域名）不会自动扩展。
    const originHost: string = originMatch[2] ?? '';
    if (LOOPBACK_HOSTS.includes(originHost)) {
      for (const loopbackHost of LOOPBACK_HOSTS) {
        const candidate: string =
          rawPort === undefined
            ? `${originScheme}://${loopbackHost}`
            : `${originScheme}://${loopbackHost}:${rawPort}`;
        if (!publicOrigins.includes(candidate)) {
          publicOrigins.push(candidate);
        }
      }
    }
  }
  const publicOrigin: string = publicOrigins[0] ?? `${originScheme}://localhost:${port}`;
  const webOrigin: string | null = parseWebOrigin(
    overrides.webOrigin ?? process.env.WEB_ORIGIN,
    originScheme,
  );

  // HTTPS 下必须 `Secure`；纯 HTTP 下必须不带（`__Host-` 前缀因 Secure 缺失会被浏览器丢弃，
  // 故本轮仍不使用 prefix）。显式设置与环境推导冲突时直接报错，不做静默纠正。
  const derivedSecure: boolean = originScheme === 'https';
  const rawSecure: string = (overrides.cookieSecure ?? process.env.COOKIE_SECURE ?? '').trim();
  if (
    rawSecure !== '' &&
    rawSecure !== 'true' &&
    rawSecure !== 'false' &&
    rawSecure !== '0' &&
    rawSecure !== '1'
  ) {
    throw new RangeError(`[env] COOKIE_SECURE 只能是 true / false，收到: ${rawSecure}`);
  }
  if (rawSecure !== '') {
    const explicitSecure: boolean = rawSecure === 'true' || rawSecure === '1';
    if (explicitSecure !== derivedSecure) {
      throw new RangeError(
        `[env] COOKIE_SECURE=${String(explicitSecure)} 与来源 scheme(${originScheme}) 不匹配：` +
          `https 必须为 true、http 必须为 false`,
      );
    }
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

  const rawAdminLogins: string = overrides.admin?.logins ?? process.env.ADMIN_GITHUB_LOGINS ?? '';
  const allowedLogins: readonly string[] = [
    ...new Set(
      rawAdminLogins
        .split(',')
        .map((item: string): string => item.trim().toLowerCase())
        .filter((item: string): boolean => item !== ''),
    ),
  ];
  const githubClientId: string = (
    overrides.admin?.clientId ??
    process.env.GITHUB_CLIENT_ID ??
    ''
  ).trim();
  const githubClientSecret: string = (
    overrides.admin?.clientSecret ??
    process.env.GITHUB_CLIENT_SECRET ??
    ''
  ).trim();
  const admin: AdminAuthConfig = {
    enabled: githubClientId !== '' && githubClientSecret !== '' && allowedLogins.length > 0,
    githubClientId,
    githubClientSecret,
    allowedLogins,
  };

  const backupPublicKey: string = parseBackupPublicKey(
    overrides.backupPublicKey ?? process.env.BACKUP_PUBLIC_KEY,
  );

  return {
    nodeEnv: overrides.nodeEnv ?? process.env.NODE_ENV ?? 'production',
    port,
    publicOrigin,
    publicOrigins,
    webOrigin,
    originScheme,
    tz,
    cookieSecure: derivedSecure,
    cookieName: SESSION_COOKIE_NAME,
    admin,
    dataDir,
    backupDir,
    tmpDir,
    dbFile: path.join(dataDir, 'stockin.db'),
    staticRoot,
    backupKeepCount: BACKUP_KEEP_COUNT,
    backupPublicKey,
    tmpfsBytes: TMPFS_BYTES,
    minFreeBytes: MIN_FREE_BYTES,
    nodeVersionExpected: NODE_VERSION_EXPECTED,
  };
}
