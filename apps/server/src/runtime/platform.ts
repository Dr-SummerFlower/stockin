/**
 * 运行时平台判定：**所有平台差异的唯一开关表**。
 *
 * 设计口径（任务卡 01）：同一份后端代码要能跑在 Node 26.13.0 与 Cloudflare
 * Workers 上，差异一律由环境变量控制，不维护两套代码、不在业务代码里散落
 * `if (isWorkers)`。
 *
 * 分两层：
 *  ① **预设**：`RUNTIME_TARGET=node|workers` 选一套默认值。缺省 `node`，
 *     且每一项默认值都与改造前逐字一致 —— 不设任何环境变量时行为零变化。
 *  ② **逐项覆盖**：`DB_DRIVER` / `SCHEMA_VERSION_STORE` / `INTEGRITY_CHECK` /
 *     `MIGRATIONS_SOURCE` / `STATIC_HANDLER` / `BACKUP_MODE` / `EXCEL_IO` /
 *     `EXCEL_WRITE` / `SCHEDULER` / `ORIGIN_SCHEME` / `NODE_VERSION_ASSERT`
 *     可单独改写某一项，
 *     便于在同一运行时里做局部替换（例如 Node 上试跑内联迁移）。
 *
 * 业务代码只读 `PlatformProfile` 的字段，不读 `target` 本身；组合根读
 * `target` 决定装配哪套端口实现。
 */

/** 支持的运行时。 */
export type RuntimeTarget = 'node' | 'workers';

/** 数据库驱动：本地文件 vs Durable Objects 存储。 */
export type DbDriver = 'node-sqlite' | 'do-sqlite';

/** schema 版本存放位置。DO 不支持 `PRAGMA user_version`（SQLITE_AUTH）。 */
export type SchemaVersionStoreKind = 'pragma' | 'table';

/** 启动完整性自检。DO 不支持 `PRAGMA integrity_check`。 */
export type IntegrityCheckKind = 'pragma' | 'skip';

/** 迁移脚本来源。Worker 无持久文件系统，只能构建期内联。 */
export type MigrationSourceKind = 'filesystem' | 'inline';

/** 静态资源托管方式。Node 走 `serveStatic`，Worker 走 `[assets]` 绑定。 */
export type StaticHandlerKind = 'filesystem' | 'assets';

/** 备份方式。Worker 无文件可快照，改平台 PITR。 */
export type BackupMode = 'filesystem' | 'pitr';

/** Excel 读取方式。Worker 的临时文件不持久，改内存 `load(buffer)`。 */
export type ExcelIoKind = 'tempfile' | 'memory';

/**
 * Excel 写出方式。
 *
 * `stream`：`StreamingWorkbookWriter` 逐行 commit，管道进 HTTP 响应（Node 默认）。
 * `buffer`：`Workbook.writeBuffer()` 一次性生成整份字节再返回（Workers 默认）。
 *
 * 不能统一走 `stream`：流式 writer 在 `addWorksheet` 时会把 exceljs 自己的
 * `StreamBuf` 当 zip 条目塞进 archiver，而 archiver 用
 * `source instanceof Stream` 判流。Node 上 `readable-stream@2`/`@3` 两份副本的
 * `Stream` 都指向同一个 `node:stream.Stream`，判定成立；Worker 产物里被 `browser`
 * 字段换成了各自独立的 `stream-browser.js` 类，判定不成立，直接抛
 * `ArchiverError: input source must be valid Stream or Buffer instance`。
 * 非流式路径的 zip 条目是 Buffer，不走那条判定，因此在 Workers 上稳定。
 */
export type ExcelWriteKind = 'stream' | 'buffer';

/** 定时备份驱动。Node 用 `setInterval`，Worker 用 Cron Trigger。 */
export type SchedulerKind = 'interval' | 'cron';

/** 来源 scheme。Worker 恒为 HTTPS/443 无端口。 */
export type OriginScheme = 'http' | 'https';

/** Node 版本精确断言。Worker 的 `process.versions.node` 是兼容层谎报值。 */
export type NodeVersionAssertKind = 'strict' | 'skip';

/** 一套完整的平台画像。 */
export interface PlatformProfile {
  readonly target: RuntimeTarget;
  readonly dbDriver: DbDriver;
  readonly schemaVersionStore: SchemaVersionStoreKind;
  readonly integrityCheck: IntegrityCheckKind;
  readonly migrationsSource: MigrationSourceKind;
  readonly staticHandler: StaticHandlerKind;
  readonly backupMode: BackupMode;
  readonly excelIo: ExcelIoKind;
  readonly excelWrite: ExcelWriteKind;
  readonly scheduler: SchedulerKind;
  readonly originScheme: OriginScheme;
  readonly nodeVersionAssert: NodeVersionAssertKind;
  /**
   * 是否存在**持久化**文件卷。
   *
   * 由预设决定、不接受单独覆盖：它同时决定「卷可写 / 磁盘余量 / 启动失败
   * sentinel / 迁移脚本读文件」四处是否执行。Workers 的 `node:fs` 可写但
   * 无持久性（实测），任何落在盘上的东西都在请求结束后消失，因此这四处
   * 必须整体跳过而不是逐项打补丁。
   */
  readonly persistentFileSystem: boolean;
}

/** Node 预设：与改造前行为逐字一致。 */
const NODE_PRESET: PlatformProfile = {
  target: 'node',
  dbDriver: 'node-sqlite',
  schemaVersionStore: 'pragma',
  integrityCheck: 'pragma',
  migrationsSource: 'filesystem',
  staticHandler: 'filesystem',
  backupMode: 'filesystem',
  excelIo: 'tempfile',
  excelWrite: 'stream',
  scheduler: 'interval',
  originScheme: 'http',
  nodeVersionAssert: 'strict',
  persistentFileSystem: true,
};

/** Workers 预设：按 2026-11-15 真实环境能力矩阵逐项反转。 */
const WORKERS_PRESET: PlatformProfile = {
  target: 'workers',
  dbDriver: 'do-sqlite',
  schemaVersionStore: 'table',
  integrityCheck: 'skip',
  migrationsSource: 'inline',
  staticHandler: 'assets',
  backupMode: 'pitr',
  excelIo: 'memory',
  excelWrite: 'buffer',
  scheduler: 'cron',
  originScheme: 'https',
  nodeVersionAssert: 'skip',
  persistentFileSystem: false,
};

/** 预设表；新增运行时只需在此追加一项。 */
export const PLATFORM_PRESETS: Readonly<Record<RuntimeTarget, PlatformProfile>> = {
  node: NODE_PRESET,
  workers: WORKERS_PRESET,
};

/** 环境变量名 → 可选值清单。用于解析与报错文案，避免各处重复写魔法字符串。 */
const OVERRIDE_SPECS = {
  DB_DRIVER: ['node-sqlite', 'do-sqlite'],
  SCHEMA_VERSION_STORE: ['pragma', 'table'],
  INTEGRITY_CHECK: ['pragma', 'skip'],
  MIGRATIONS_SOURCE: ['filesystem', 'inline'],
  STATIC_HANDLER: ['filesystem', 'assets'],
  BACKUP_MODE: ['filesystem', 'pitr'],
  EXCEL_IO: ['tempfile', 'memory'],
  EXCEL_WRITE: ['stream', 'buffer'],
  SCHEDULER: ['interval', 'cron'],
  ORIGIN_SCHEME: ['http', 'https'],
  NODE_VERSION_ASSERT: ['strict', 'skip'],
} as const;

type OverrideKey = keyof typeof OVERRIDE_SPECS;

/** 覆盖项与 `PlatformProfile` 字段的对应关系。 */
const OVERRIDE_FIELDS: Readonly<Record<OverrideKey, keyof PlatformProfile>> = {
  DB_DRIVER: 'dbDriver',
  SCHEMA_VERSION_STORE: 'schemaVersionStore',
  INTEGRITY_CHECK: 'integrityCheck',
  MIGRATIONS_SOURCE: 'migrationsSource',
  STATIC_HANDLER: 'staticHandler',
  BACKUP_MODE: 'backupMode',
  EXCEL_IO: 'excelIo',
  EXCEL_WRITE: 'excelWrite',
  SCHEDULER: 'scheduler',
  ORIGIN_SCHEME: 'originScheme',
  NODE_VERSION_ASSERT: 'nodeVersionAssert',
};

/** 环境变量读取面（`process.env` 与 Worker 的 vars 对象都符合此形状）。 */
export type PlatformEnvSource = Readonly<Record<string, string | undefined>>;

/**
 * 解析 `RUNTIME_TARGET`。
 *
 * 空串与未设置都视为 `node`；非法值直接抛错，不做静默兜底 —— 平台判定错了
 * 会让整个进程用错驱动，静默兜底只会把问题推迟到更难定位的地方。
 */
export function resolveRuntimeTarget(raw?: string): RuntimeTarget {
  const value: string = (raw ?? '').trim();
  if (value === '' || value === 'node') {
    return 'node';
  }
  if (value === 'workers') {
    return 'workers';
  }
  throw new RangeError(
    `[platform] RUNTIME_TARGET 必须是 node 或 workers，收到: ${raw ?? ''}（留空即 node）`,
  );
}

/** 读取单项覆盖；未设置返回 undefined，非法值抛错。 */
function readOverride<K extends OverrideKey>(
  source: PlatformEnvSource,
  key: K,
): (typeof OVERRIDE_SPECS)[K][number] | undefined {
  const raw: string | undefined = source[key];
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value: string = raw.trim();
  const allowed: readonly string[] = OVERRIDE_SPECS[key];
  if (!allowed.includes(value)) {
    throw new RangeError(`[platform] ${key} 必须是 ${allowed.join(' / ')} 之一，收到: ${value}`);
  }
  return value as (typeof OVERRIDE_SPECS)[K][number];
}

/**
 * 解析最终平台画像：先取预设，再叠加逐项覆盖。
 *
 * @param source 环境变量来源，通常直接传 `process.env`
 */
export function resolvePlatform(source: PlatformEnvSource = process.env): PlatformProfile {
  const target: RuntimeTarget = resolveRuntimeTarget(source.RUNTIME_TARGET);
  const preset: PlatformProfile = PLATFORM_PRESETS[target];

  const overrides: Partial<PlatformProfile> = {};
  for (const key of Object.keys(OVERRIDE_SPECS) as OverrideKey[]) {
    const value: string | undefined = readOverride(source, key);
    if (value !== undefined) {
      // 逐个赋值而非展开合并：每个 key 的联合类型互不相同，展开会丢类型。
      (overrides as Record<string, string>)[OVERRIDE_FIELDS[key]] = value;
    }
  }

  return {
    ...preset,
    ...overrides,
    // target 与 persistentFileSystem 不接受覆盖：前者是预设选择的依据，
    // 后者是对「有没有持久盘」这一客观事实的陈述，不是策略开关。
    target,
    persistentFileSystem: preset.persistentFileSystem,
  };
}

/** 是否允许下发 `Secure` Cookie（仅 HTTPS 来源下有意义）。 */
export function shouldSecureCookie(profile: PlatformProfile): boolean {
  return profile.originScheme === 'https';
}
