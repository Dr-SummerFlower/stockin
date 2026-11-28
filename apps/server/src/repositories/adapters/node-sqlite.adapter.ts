/**
 * `node:sqlite` 适配器（Node 22+ 内置，26.x 为 1.2 RC）。
 *
 * 为什么用它：SQLite 引擎编进 Node 二进制本身，**不再有 `.node` 原生扩展**，
 * 于是 Docker 里不需要 build-essential / 各架构 prebuild，多架构只是
 * `docker buildx --platform` 的事。本机实测写路径比 better-sqlite3 快 20%~28%。
 *
 * 与 better-sqlite3 的三处差异（本文件均已抹平，上层无感）：
 *  ① 没有 `db.pragma()` 助手 → 用 `PRAGMA x` 语句 + 取首行首列。
 *  ② 没有 `db.transaction()` 助手 → 手写 `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`，
 *     并且**拒绝嵌套**：同步闭包内再开事务会直接抛错，而不是静默复用外层事务。
 *  ③ 备份是模块级函数 `backup(source, destination)`，不是方法。
 */
import fs from 'node:fs';
import { backup as sqliteBackup, DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  UnsupportedCapabilityError,
  type DbPort,
  type RunResultPort,
  type StatementPort,
  type TransactionMode,
} from '../db.port';

/** 打开参数：与 `openDatabase` 的选项一一对应。 */
export interface NodeSqliteOpenOptions {
  readonly filename: string;
  readonly readonly?: boolean;
  readonly fileMustExist?: boolean;
}

/** 把驱动返回的 bigint/undefined 归一化成端口约定的 number。 */
function toCount(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return 0;
}

// 端口对外是 `unknown[]`（不绑定任何驱动），驱动侧要求确切的 SQLInputValue；
// 绑定值的合法性由 SQLite 在运行期校验，这里只做类型收窄。
function bind(params: unknown[]): SQLInputValue[] {
  return params as SQLInputValue[];
}

/** 包一层语句，抹平 `RunResult` 字段差异。 */
function wrapStatement(db: DatabaseSync, sql: string): StatementPort {
  const statement = db.prepare(sql);
  return {
    get: (...params: unknown[]): unknown => statement.get(...bind(params)),
    all: (...params: unknown[]): unknown[] => statement.all(...bind(params)),
    run: (...params: unknown[]): RunResultPort => {
      const result = statement.run(...bind(params));
      return {
        changes: toCount(result.changes),
        lastInsertRowid: toCount(result.lastInsertRowid),
      };
    },
  };
}

/** 创建基于 `node:sqlite` 的端口实现。 */
export function createNodeSqliteAdapter(options: NodeSqliteOpenOptions): DbPort {
  const readonly: boolean = options.readonly ?? false;
  // node:sqlite 默认「文件不存在就新建」，better-sqlite3 的 fileMustExist 语义需自行补。
  if (options.fileMustExist === true && !fs.existsSync(options.filename)) {
    throw new Error(`[db] 数据库文件不存在: ${options.filename}`);
  }

  const db: DatabaseSync = new DatabaseSync(options.filename, { readOnly: readonly });
  let closed = false;

  return {
    get isOpen(): boolean {
      return !closed && db.isOpen;
    },

    prepare(sql: string): StatementPort {
      return wrapStatement(db, sql);
    },

    exec(sql: string): void {
      db.exec(sql);
    },

    transaction<T>(mode: TransactionMode, fn: () => T): T {
      // 同步端口下事务窗口内没有 await，天然是临界区；嵌套说明调用方写错了，
      // 直接报错好过用 SAVEPOINT 掩盖（会破坏「整批单事务」的语义保证）。
      if (db.isTransaction) {
        throw new Error('[db] 检测到事务嵌套：同步端口不支持在事务内再开事务');
      }
      db.exec(mode === 'immediate' ? 'BEGIN IMMEDIATE' : 'BEGIN DEFERRED');
      try {
        const result: T = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // 事务已因致命错误自动回滚，此处忽略二次回滚失败。
        }
        throw error;
      }
    },

    readPragma(text: string): unknown {
      const rows: unknown[] = db.prepare(`PRAGMA ${text}`).all();
      const first: unknown = rows[0];
      if (typeof first !== 'object' || first === null) {
        return first;
      }
      const values: unknown[] = Object.values(first as Record<string, unknown>);
      return values[0];
    },

    async backupTo(destination: string): Promise<void> {
      if (readonly) {
        throw new UnsupportedCapabilityError('backup', '只读连接不能发起备份');
      }
      await sqliteBackup(db, destination);
    },

    checkpointTruncate(): void {
      if (readonly) {
        return;
      }
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    },

    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      db.close();
    },
  };
}
