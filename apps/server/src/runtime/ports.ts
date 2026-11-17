/**
 * 运行时端口（Port）：`bootstrap` / `runner` / 各 Service 与「具体平台」之间
 * 唯一的契约。运行时差异全部收在这几个接口的实现里，共享层只认接口。
 *
 * 与 `repositories/db.port.ts` 的分工：
 *  - `DbPort` 抹平的是**数据库驱动**差异（node:sqlite / Durable Objects）；
 *  - 本文件抹平的是**平台能力**差异（文件系统 / 静态托管 / 定时器 / 备份）。
 *
 * 三条硬约束：
 *  ① 端口一律同步或纯 Promise，不引入新的异步事务语义（见 `db.port.ts`）。
 *  ② 能力缺失必须显式表达（返回 `pitr` / 抛 `UnsupportedCapabilityError`），
 *     不允许静默返回假成功 —— 备份"看起来成功但没文件"是最坏的结果。
 *  ③ 端口实现只在 `runtime/<target>/` 下，共享层不 import 任何具体实现。
 */
import type { BackupMeta, BackupResult } from '../repositories/backup';
import type { RollbackAllowance } from '../repositories/schema';
import type { Db } from '../repositories/db';

/** 一条迁移脚本的描述。 */
export interface MigrationFile {
  readonly version: number;
  readonly filename: string;
  /**
   * 物理路径：仅 `filesystem` 源有意义。
   * `inline` 源给空串 —— 构建期内联后已经不存在"路径"这个概念，
   * 用假路径冒充只会让排障时误以为文件在盘上。
   */
  readonly fullPath: string;
}

/**
 * schema 版本与回滚放行的存放位置。
 *
 * Node：`PRAGMA user_version` + `data/.allow-rollback.json`（原实现，逐字保留）。
 * Workers：Do 不支持 `PRAGMA user_version`（实测 `SQLITE_AUTH`），改一张
 * 专用小表 `app_schema_version`；放行凭据同样落表（Worker 上没有 CLI，
 * 也就不存在人工签发流程，`consume` 恒为 null 即可）。
 */
export interface VersionStore {
  readonly kind: 'pragma' | 'table';
  /** 读取当前 schema 版本；全新空库返回 0。 */
  read(db: Db): number;
  /** 写入 schema 版本；与迁移脚本同一个事务内调用。 */
  write(db: Db, version: number): void;
  /** 一次性放行凭据（读取即消费，保证一次性）。 */
  consumeRollbackAllowance(db: Db): RollbackAllowance | null;
  /** 签发一次性放行凭据（仅 Node CLI 使用）。 */
  writeRollbackAllowance(db: Db, allowance: RollbackAllowance): void;
}

/**
 * 迁移脚本来源。
 *
 * Node：读 `migrations/` 目录里的 `NNN_*.sql`。
 * Workers：构建期把同样的文件以 `?raw` 字符串内联进 bundle —— 单一真源仍是
 * 那些 `.sql` 文件，不存在"手抄一份 SQL 到 TS 里"的漂移风险。
 */
export interface MigrationSource {
  readonly kind: 'filesystem' | 'inline';
  /** 发现并校验脚本序号（三位递增、连续、补足 SCHEMA_EXPECTED）。 */
  discover(): MigrationFile[];
  /** 读取脚本原文（仍含 `{{NAME}}` 模板占位符，由 runner 统一渲染）。 */
  read(file: MigrationFile): string;
}

/** 备份端口。 `mode='pitr'` 时平台托管，`create` 恒返回 skipped。 */
export interface BackupPort {
  readonly mode: 'filesystem' | 'pitr';
  /** 保留份数（PITR 下仅用于界面提示）。 */
  readonly keepCount: number;
  /**
   * 生成一次备份。
   * 空间不足 / 平台不支持时返回 `{ status: 'skipped' }` 并写 WARN，不抛错 ——
   * 备份失败不应阻断启动与导入。
   */
  create(db: Db, options: BackupCreateOptions): Promise<BackupResult>;
  /** 列出备份池元数据（PITR 下为空数组）。 */
  list(): BackupMeta[];
  /**
   * 读取一份备份文件的字节（**仅管理员下载端点使用**）。
   * PITR 没有文件系统，不实现该方法；调用方据此返回「平台托管」而不是假成功。
   * 文件名必须已与 `list()` 的元数据逐字比对，禁止把入参直接拼进路径。
   */
  read?(file: string): { data: Uint8Array; filename: string } | null;
}

/** 备份入参；`backupDir` 由各实现从自身配置取，调用方不传。 */
export interface BackupCreateOptions {
  readonly reason: string;
  readonly initState: 0 | 1;
  readonly baseline?: boolean;
  readonly minFreeBytes?: number;
  readonly keepCount?: number;
  /** 校验链里 user_version 的比对基准；缺省取发起备份时的实际版本。 */
  readonly expectedUserVersion?: number;
}

/**
 * 工作簿读取器：把上传的字节变成可解析的 ExcelJS 工作簿。
 *
 * 之所以做成函数而不是能力开关：Node 侧刻意保留"落 tmp 卷再 readFile"的
 * 既有行为（临时文件按主理人口径不清理，便于排障），Workers 侧没有持久盘，
 * 只能 `load(buffer)`。两种实现都满足同一个签名，调用方无感知。
 */
export type WorkbookReader = (buffer: Buffer) => Promise<import('exceljs').Workbook>;

/**
 * 静态资源端口。
 *
 * Node：`serveStatic` 从磁盘目录读，并自行读取 `index.html` 算内容 ETag。
 * Workers：`[assets]` 绑定（`env.ASSETS.fetch()`），`index.html` 也从绑定里取 ——
 * 但**必须由 Hono 出面调用**，否则静态响应会绕过 CSP / cache-control 中间件。
 */
export interface StaticPort {
  /** index.html 文本与内容 ETag；`/`、`/index.html` 与 SPA fallback 共用。 */
  readonly indexDocument: import('../static').IndexDocument;
  /** 静态文件中间件；未命中时必须 `await next()` 而不是返回空响应。 */
  middleware(): import('hono').MiddlewareHandler<import('../types/hono').AppEnv>;
}

/**
 * 一整套运行时端口实现。
 *
 * 组合根（`index.ts` / `worker.ts`）拿到 bundle 后原样交给 `bootstrap()` 与
 * `assemble()`，自己不拼装任何具体实现 —— 于是"哪套端口"只在一个地方决定。
 *
 * 全部以 `Env` 为入参而不是在构造时固定：`loadEnv()` 发生在 `bootstrap()`
 * 内部，而 Worker 侧的 `env` 来自平台 vars，两者都必须在拿到 `Env` 之后才能
 * 解析目录、份数等派生值。
 */
export interface RuntimeBundle {
  readonly platform: import('./platform').PlatformProfile;
  openDb(env: import('../env').Env): Db;
  versionStore(env: import('../env').Env): VersionStore;
  migrations(env: import('../env').Env): MigrationSource;
  backup(env: import('../env').Env): BackupPort;
  /**
   * 静态端口。**返回 Promise**：Workers 侧要先从 `[assets]` 绑定取一次
   * index.html 才能算出内容 ETag，Node 侧直接同步返回。
   */
  staticPort(env: import('../env').Env): Promise<StaticPort>;
  workbookReader(env: import('../env').Env): WorkbookReader;
}
