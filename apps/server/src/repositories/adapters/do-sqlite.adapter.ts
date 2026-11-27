/**
 * Cloudflare Durable Objects（SQLite 存储后端）适配器。
 *
 * 为什么是 DO 而不是 D1：D1 的 API 是**异步**的，且没有交互式事务
 * （`BEGIN`/`COMMIT` 不可用，只有 `batch()`）、不支持 `PRAGMA user_version`、
 * 没有文件可备份。DO 的 `ctx.storage.sql.exec()` 是**同步**的，并自带
 * `transactionSync(fn)`（明确要求同步回调），与本端口的同步契约天然对齐。
 * 官方限制：单 DO 10GB（付费）/1GB（免费）、单行 8MB、CPU 30s 可调至 5min。
 *
 * 与本地适配器的三处语义差异（已在实现里处理，并在一致性测试里显式断言）：
 *  ① **没有 `prepare`**：`exec(sql, ...bindings)` 每次重建语句。这里用闭包
 *     缓存 SQL 文本、调用时再 exec，签名与本地一致，但**没有真正的预编译收益**。
 *  ② **拿不到 `lastInsertRowid`**：游标只给 `rowsWritten`/`rowsRead`，故写语句
 *     执行后补一次 `SELECT last_insert_rowid()`（同连接，事务内同样成立）。
 *  ③ **不能 `exec('BEGIN')`**：事务必须走 `transactionSync`；`immediate` 与
 *     `deferred` 在此处无区别（DO 单实例串行执行，本身即写者独占）。
 *  ④ **没有可跨 `await` 的游标**：端口因此不提供 `iterate`，无界扫描一律走
 *     Repository 的 keyset 分页（见 `db.port.ts` 的说明）。
 *
 * **现状边界（勿误读）**：本适配器已接入 Worker 入口（`runtime/workers/db.factory.ts`），
 * 与驱动无关的三块工作（迁移内联、备份改 PITR、Excel 临时文件改内存）分别由
 * `migration-source.inline.ts`、`backup.pitr.ts`、`workbook.memory.ts` 承担。
 */
import {
  UnsupportedCapabilityError,
  type DbPort,
  type RunResultPort,
  type StatementPort,
  type TransactionMode,
} from '../db.port';

/**
 * DO 游标的最小结构（官方 `SqlStorageCursor` 的子集）。
 * 只声明本适配器真正用到的成员，便于测试替身实现。
 */
export interface DoSqlCursorLike extends Iterable<Record<string, unknown>> {
  toArray(): Record<string, unknown>[];
  readonly rowsRead: number;
  readonly rowsWritten: number;
}

/** DO SQL 存储的最小结构（官方 `SqlStorage` 的子集）。 */
export interface DoSqlStorageLike {
  exec(query: string, ...bindings: unknown[]): DoSqlCursorLike;
}

/** DO storage 的最小结构。`transactionSync` 仅 SQLite 后端提供；KV / alarm 供暂存与调度使用。 */
export interface DoStorageLike {
  readonly sql: DoSqlStorageLike;
  transactionSync<T>(callback: () => T): T;
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: ArrayBuffer | ArrayBufferView | string): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(options?: { prefix?: string }): Promise<Map<string, unknown>>;
  setAlarm(time: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}

/** 归一化驱动返回值。 */
function toCount(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return 0;
}

/** 取首行首列（PRAGMA / 聚合查询通用）。 */
function firstValue(rows: Record<string, unknown>[]): unknown {
  const row: Record<string, unknown> | undefined = rows[0];
  if (row === undefined) {
    return undefined;
  }
  return Object.values(row)[0];
}

function wrapStatement(storage: DoSqlStorageLike, sql: string): StatementPort {
  /** 写语句执行后补取自增主键（DO 游标不暴露 last_insert_rowid）。 */
  const lastInsertRowid = (): number => {
    const rows: Record<string, unknown>[] = storage
      .exec('SELECT last_insert_rowid() AS id')
      .toArray();
    return toCount(firstValue(rows));
  };

  /**
   * 主表受影响行数（= Node 侧 `sqlite3_changes` 的口径）。
   *
   * **不要**用游标的 `rowsWritten`：它把触发器与索引层的写入也算进去，
   * 而 `records` 上有 7 个统计/去重触发器，一次 UPDATE 会被放大 5~11 倍
   * （线上实测：删 1 条明细报 7、恢复 1 条报 11）。`changes()` 只数顶层
   * 语句直接改动的行，与 Node 完全一致；它读取的是最近一次 DML 的结果，
   * 中间的 SELECT（含 last_insert_rowid）不会重置它。
   */
  const lastChanges = (): number => {
    const rows: Record<string, unknown>[] = storage.exec('SELECT changes() AS c').toArray();
    return toCount(firstValue(rows));
  };

  return {
    get: (...params: unknown[]): unknown => storage.exec(sql, ...params).toArray()[0],
    all: (...params: unknown[]): unknown[] => storage.exec(sql, ...params).toArray(),
    run: (...params: unknown[]): RunResultPort => {
      const cursor: DoSqlCursorLike = storage.exec(sql, ...params);
      // 必须消费游标语句才会真正执行（DO 的 cursor 是惰性的）。
      cursor.toArray();
      const changes: number = lastChanges();
      return { changes, lastInsertRowid: lastInsertRowid() };
    },
  };
}

/**
 * 用 DO storage 构造端口实现。
 *
 * @param storage 通常直接传 `ctx.storage`（DurableObjectState.storage）
 */
export function createDoSqliteAdapter(storage: DoStorageLike): DbPort {
  let closed = false;

  return {
    get isOpen(): boolean {
      return !closed;
    },

    prepare(sql: string): StatementPort {
      return wrapStatement(storage.sql, sql);
    },

    exec(sql: string): void {
      // 多语句脚本（迁移）可直接下发；`BEGIN` 会被 DO 拒绝，事务请走 transaction。
      storage.sql.exec(sql).toArray();
    },

    transaction<T>(_mode: TransactionMode, fn: () => T): T {
      // transactionSync 要求回调完全同步；返回 Promise 会被 DO 判定为违规。
      return storage.transactionSync(fn);
    },

    readPragma(text: string): unknown {
      return firstValue(storage.sql.exec(`PRAGMA ${text}`).toArray());
    },

    backupTo(destination: string): Promise<void> {
      // 端口契约是 Promise<void>，故用 rejected promise 而非同步 throw，
      // 否则调用方的 `await` / `.catch` 拿不到这个错误。
      return Promise.reject(
        new UnsupportedCapabilityError(
          'backup',
          `DO 没有文件系统，无法写出 ${destination}；请改用 Time Travel / PITR 或定期导出`,
        ),
      );
    },

    checkpointTruncate(): void {
      // WAL 由平台托管，应用侧没有 checkpoint 权限；停机无需额外动作。
    },

    close(): void {
      // 存储生命周期由 runtime 管理，应用侧不持有可关闭的句柄。
      closed = true;
    },
  };
}
