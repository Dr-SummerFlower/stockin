/**
 * 全项目常量（数值、上限、安全基线、部署参数）。
 *
 * 依据：设计文档 v1.1 §3.6、§4.2、§5.2、§7.1、§10.2 裁决 30/38、附录 A。
 * 所有值为实现级默认值，集中在此，禁止在别处硬编码。
 */

/** 整数定点倍率：单价 1e4 / 数量 1e3 / 金额（分）1e2。文档 §4.3。 */
export const SCALE = {
  UNIT_PRICE: 10_000,
  QUANTITY: 1_000,
  AMOUNT_CENTS: 100,
} as const;

/** 金额校验允许的舍入容差（分）。文档 §5.2「金额允许 ≤1 分舍入容差」。 */
export const AMOUNT_ROUNDING_TOLERANCE_CENTS = 1;

/** 临期阈值 X：默认 30 天，可配范围 0~3650。文档 §4.2。 */
export const DEFAULT_EXPIRY_THRESHOLD_DAYS = 30;
export const EXPIRY_THRESHOLD_MIN = 0;
export const EXPIRY_THRESHOLD_MAX = 3650;

/** 导入上限：2MB / 1000 行 / 15s / 解压后 ≤20MB。文档 §10.2 裁决 30。 */
export const IMPORT_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 1_000;
export const IMPORT_DEADLINE_MS = 15_000;
export const IMPORT_MAX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;
export const IMPORT_YIELD_EVERY_ROWS = 500;
export const BODY_LIMIT_BYTES = IMPORT_MAX_FILE_BYTES;

/** 会话：空闲 7 天 / 绝对 30 天双过期。文档 §4.2。 */
export const SESSION_IDLE_DAYS = 7;
export const SESSION_ABSOLUTE_DAYS = 30;
export const SESSION_COOKIE_NAME = 'sid';

/** 密码哈希 scrypt 参数（Node 内置 crypto）。文档 §3.4。N = 2^15。 */
export const SCRYPT_PARAMS = {
  N: 32_768,
  r: 8,
  p: 1,
  keylen: 64,
  saltBytes: 16,
  maxmem: 64 * 1024 * 1024,
} as const;

/** 登录失败限流：5 次 / 15 分钟，双维度。文档 §3.6。 */
export const LOGIN_RATE_LIMIT = {
  maxAttempts: 5,
  windowMinutes: 15,
} as const;

/** 幂等键快照保留 24 小时。文档 §5.2。 */
export const IDEMPOTENCY_TTL_HOURS = 24;

/** 默认端口（可经 PORT 覆盖）。文档 §7.1 / §10.2 裁决 38。 */
export const DEFAULT_PORT = 8_080;
export const DEFAULT_TZ = 'Asia/Shanghai';
export const NODE_VERSION_EXPECTED = '26.13.0';
export const PNPM_MAJOR_VERSION = 12;

/** 备份：保留最近 7 份。文档 §4.5。 */
export const BACKUP_KEEP_COUNT = 7;

/** 资源参数。文档 §7.2 / §10.2 裁决 38。 */
export const TMPFS_BYTES = 32 * 1024 * 1024;
export const NODE_MAX_OLD_SPACE_MB = 512;
export const CONTAINER_MEMORY_LIMIT = '768m';
export const STOP_TIMEOUT_SECONDS = 40;

/** 全站日期展示格式与 Excel 日期列格式。文档 §2.4 BR-11。 */
export const DATE_FORMAT = 'YYYY-MM-DD';

/** 纯 HTTP 下的 CSP 字面量（由 Hono 唯一发起点下发）。文档 §10.2 裁决 29。 */
export const CSP_DEFAULT_SRC = "'self'";
export const CSP_STYLE_SRC = "'self' 'unsafe-inline'";
export const CSP_HEADER_VALUE = `default-src ${CSP_DEFAULT_SRC}; style-src ${CSP_STYLE_SRC}`;

/** 其他安全响应头字面量。文档 §3.6。 */
export const SECURITY_HEADERS = {
  X_CONTENT_TYPE_OPTIONS: 'nosniff',
  X_FRAME_OPTIONS: 'DENY',
  REFERRER_POLICY: 'no-referrer',
  CACHE_CONTROL_API: 'no-store',
  CACHE_CONTROL_INDEX_HTML: 'no-cache',
  CACHE_CONTROL_HASHED_ASSET: 'public, max-age=31536000, immutable',
} as const;

/** Cookie 基线：纯 HTTP 下 Secure 必须为 false，且禁用 __Host- 前缀。文档 §10.2 裁决 28。 */
export const COOKIE_POLICY = {
  httpOnly: true,
  sameSite: 'Lax' as const,
  secure: false,
  path: '/',
} as const;

/** 分页默认值。 */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 200;

/** init guard 白名单（文档 §3.5）。 */
export const INIT_GUARD_WHITELIST: readonly string[] = [
  'health',
  'init-status',
  'login',
  'logout',
  'me',
  'setup',
];
