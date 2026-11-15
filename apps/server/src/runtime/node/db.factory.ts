/**
 * Node 运行时：打开 `node:sqlite` 连接并设置启动 PRAGMA。
 *
 * 从 `repositories/db.ts` 拆出，原因有二：
 *  ① `db.ts` 会被 Workers 侧共享层引用，若它 import 具体驱动，
 *     `node:sqlite` 就会被打进 Worker bundle（Workers 上 `new DatabaseSync()`
 *     会抛 `Illegal constructor`）；
 *  ② "打开连接"本身就是 Node 平台能力（进程私有文件句柄），
 *     Durable Objects 那边对应的是 `ctx.storage`，语义并不相同。
 */
import { createNodeSqliteAdapter } from '../../repositories/adapters/node-sqlite.adapter';
import type { Db } from '../../repositories/db';

export interface OpenDatabaseOptions {
  readonly filename: string;
  readonly readonly?: boolean;
  readonly fileMustExist?: boolean;
}

/**
 * 打开连接并一次性设置三项 PRAGMA（文档要求维持原值，不调优）。
 *
 * 只读连接不设 WAL / synchronous / busy_timeout（无写入语义），
 * 但仍开启外键约束，保持与写入连接一致的语义。
 */
export function openDatabase(options: OpenDatabaseOptions): Db {
  const db: Db = createNodeSqliteAdapter(options);
  if (!(options.readonly ?? false)) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 5000');
  }
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}
