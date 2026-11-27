/**
 * `cloudflare:workers` 的最小类型声明。
 *
 * 项目刻意不引入 `@cloudflare/workers-types`：那是个把整套 Workers 全局变量
 * 塞进 tsc 视野的类型包，会与 Node 侧的 `@types/node` 大量重名冲突。
 * 这里只声明本项目真正用到的两个成员：
 *  - `DurableObject` 基类（workerd 要求导出的 DO 类必须继承它，
 *    否则 bindings 里的 `class_name` 绑不上）；
 *  - 受保护的 `ctx` / `env`，分别提供 SQLite 存储与平台变量。
 *
 * **本文件不能有任何顶层 import / export**：一旦成为模块，
 * `declare module 'cloudflare:workers'` 就会被当成"对已存在模块的增强"，
 * 而该模块在 tsc 眼里并不存在，于是报 TS2307。保持脚本形态才能声明新模块。
 *
 * 运行时由 workerd 注入，构建时以 `cloudflare:workers` 保持 external。
 */
declare module 'cloudflare:workers' {
  /** DO SQL 游标（结构上与 `DoSqlCursorLike` 一致）。 */
  interface DurableObjectSqlCursor extends Iterable<Record<string, unknown>> {
    toArray(): Record<string, unknown>[];
    readonly rowsRead: number;
    readonly rowsWritten: number;
  }

  /** DO SQL 存储（结构上与 `DoSqlStorageLike` 一致）。 */
  interface DurableObjectSqlStorage {
    exec(query: string, ...bindings: unknown[]): DurableObjectSqlCursor;
  }

  /** DO 存储句柄（结构上与 `DoStorageLike` 一致）。 */
  interface DurableObjectStorage {
    readonly sql: DurableObjectSqlStorage;
    transactionSync<T>(callback: () => T): T;
    /** KV：恢复分块暂存（值可为 ArrayBuffer / Uint8Array / string）。 */
    get<T = unknown>(key: string): Promise<T | undefined>;
    put(key: string, value: ArrayBuffer | ArrayBufferView | string): Promise<void>;
    delete(key: string): Promise<boolean>;
    list(options?: { prefix?: string }): Promise<Map<string, unknown>>;
    /** DO alarm：驱动异步备份/恢复 tick。 */
    setAlarm(time: number | Date): Promise<void>;
    deleteAlarm(): Promise<void>;
  }

  /** DO 运行时上下文（仅声明本项目用到的部分）。 */
  export interface DurableObjectContext {
    readonly storage: DurableObjectStorage;
    waitUntil(promise: Promise<unknown>): void;
    /**
     * 在回调执行期间暂停投递其他事件（输入门），用于关键区串行化。
     * 本项目只用在「恢复批次一次性消费」这一处，避免 get→put 之间被并发请求插入。
     */
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  }

  export class DurableObject<Env = unknown> {
    protected readonly ctx: DurableObjectContext;
    protected readonly env: Env;
    constructor(ctx: DurableObjectContext, env: Env);
  }
}
