/**
 * Workers 运行时：用 Durable Object 的 SQLite 存储打开 `DbPort`。
 *
 * 与 Node 侧的差别只有一处：**不设连接级 PRAGMA**。
 * `journal_mode` / `synchronous` / `busy_timeout` 是文件语义的连接参数，
 * DO 由平台托管（单实例串行、自带持久化），设置它们既无意义也不在允许清单内。
 * `foreign_keys` 同样不下发：DO 的白名单里没有它，而下发给不支持的
 * PRAGMA 会抛 `SQLITE_AUTH` 把启动卡死。反过来说，关闭外键强制比开启更宽松，
 * 不会让既有业务写入在 Workers 上失败（Node 上已通过的写入必然仍能通过）。
 */
import {
  createDoSqliteAdapter,
  type DoStorageLike,
} from '../../repositories/adapters/do-sqlite.adapter';
import type { Db } from '../../repositories/db';

/** 打开 DO 存储句柄；生命周期由平台管理，应用侧不持有可关闭资源。 */
export function openDoDatabase(storage: DoStorageLike): Db {
  return createDoSqliteAdapter(storage);
}
