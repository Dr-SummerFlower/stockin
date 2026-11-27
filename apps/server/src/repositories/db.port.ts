/**
 * 数据层端口（Port）：Repository 与「具体 SQLite 驱动」之间唯一的契约。
 *
 * 设计要点（2026-11-15 引入）：
 *  ① **同步签名是刻意的**。better-sqlite3、`node:sqlite`、Durable Objects 的
 *     SQL 存储三者都是同步 API；一旦把端口改成 async，事务窗口内出现 `await`
 *     就会让两个请求交错进同一个事务（实测：两个并发导入会互相 ROLLBACK，
 *     两个请求都报错、库里却残留部分数据）。故端口保持同步，任何异步后端
 *     只能通过「同步适配器」接入，不能污染到这里。
 *  ② **语句级而不是查询级**。现有代码 35 处 `prepare` 会复用语句对象，
 *     若端口只暴露 `query(sql, params)` 会强制全部重写。
 *  ③ **事务机制由适配器决定**。`BEGIN IMMEDIATE` 是 SQLite 的文件语义，
 *     Durable Objects 不允许 `exec('BEGIN')`、只能用 `transactionSync()`，
 *     故端口只声明"要一个写事务 / 读事务"，不声明 SQL 文本。
 *  ④ **备份与 PRAGMA 是能力而非必然**。Durable Objects 没有文件系统，
 *     在线备份必须走 PITR；能力缺失时抛 `UnsupportedCapabilityError`，
 *     由调用方降级，不允许静默返回假成功。
 */

/** 一次写语句的影响面。`lastInsertRowid` 统一归一化为 number。 */
export interface RunResultPort {
  readonly changes: number;
  readonly lastInsertRowid: number;
}

/** 预编译语句。参数一律位置绑定（本仓库 35 处 SQL 全部使用 `?`）。 */
export interface StatementPort {
  /** 取首行；无结果返回 undefined。 */
  get(...params: unknown[]): unknown;
  /**
   * 取全部行。
   *
   * 端口**不提供**逐行游标（2026-11-24 移除 `iterate`）：Durable Objects 的
   * 游标不能跨 `await`，适配器只能先 `toArray()` 再迭代，`iterate` 在 Workers
   * 上就是整表物化——同一个方法在两种运行时语义不同，是最容易踩的内存陷阱。
   * 无界扫描统一走 Repository 的 keyset 分页（`iteratePages`）：`LIMIT` 由 SQL
   * 保证，Node 与 Workers 的内存水位一致。
   */
  all(...params: unknown[]): unknown[];
  /** 执行写语句并返回影响面。 */
  run(...params: unknown[]): RunResultPort;
}

/**
 * 事务模式。
 * - `immediate`：立刻取写锁（导入、业务写 + 操作日志同事务）。
 * - `deferred`：读快照 / 常规组合写。
 * 不支持区分的后端（如 Durable Objects）可统一按写事务处理。
 */
export type TransactionMode = 'immediate' | 'deferred';

/** 适配器不具备某项能力时抛出；调用方据此降级而非崩溃。 */
export class UnsupportedCapabilityError extends Error {
  constructor(
    public readonly capability: string,
    detail: string,
  ) {
    super(`[db] 当前适配器不支持「${capability}」：${detail}`);
    this.name = 'UnsupportedCapabilityError';
  }
}

/** 连接端口。Repository 只依赖此接口，不认识任何驱动。 */
export interface DbPort {
  /** 连接是否仍可用。 */
  readonly isOpen: boolean;

  /** 预编译一条 SQL。 */
  prepare(sql: string): StatementPort;

  /** 直接执行一段 SQL（DDL / 多语句脚本 / PRAGMA 赋值）。 */
  exec(sql: string): void;

  /** 在一个事务里执行同步闭包；闭包抛错则整体回滚并原样抛出。 */
  transaction<T>(mode: TransactionMode, fn: () => T): T;

  /**
   * 读取单值 PRAGMA（`user_version` / `integrity_check` 等），返回标量；
   * 多行结果只取首行首列。不支持 PRAGMA 的后端抛 `UnsupportedCapabilityError`。
   */
  readPragma(text: string): unknown;

  /** 在线一致性快照到目标文件。无文件系统的后端抛 `UnsupportedCapabilityError`。 */
  backupTo(destination: string): Promise<void>;

  /** 停机前把 WAL 截断回主库。无 WAL 控制权的后端可为 no-op。 */
  checkpointTruncate(): void;

  /** 关闭连接。可重复调用。 */
  close(): void;
}
