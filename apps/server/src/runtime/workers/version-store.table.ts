/**
 * Workers 运行时：schema 版本与回滚放行落在 DO 存储的小表里。
 *
 * 为什么不能沿用 `PRAGMA user_version`：2026-11-15 在真实 Cloudflare 环境实测，
 * DO 执行 `PRAGMA user_version` 返回 `not authorized: SQLITE_AUTH`；
 * 同一份探针里 `PRAGMA table_list` 是通的，说明这是白名单限制而非语法问题。
 *
 * 表结构刻意与业务表无关（`app_schema_version` / `app_flags`），
 * 这样迁移脚本里的 `PRAGMA user_version = N` 被剥离后，版本仍有唯一落点，
 * 且不需要在业务 schema 里为"版本"这件事额外留一列。
 */
import type { Db } from '../../repositories/db';
import type { RollbackAllowance } from '../../repositories/schema';
import type { VersionStore } from '../ports';

const VERSION_TABLE = 'app_schema_version';
const FLAGS_TABLE = 'app_flags';
const ALLOWANCE_KEY = 'schema.rollback_allowance';

/** 幂等建表；每次读写前调用，避免"首次启动时表不存在"的特例分支。 */
function ensureTables(db: Db): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${VERSION_TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`,
  );
  db.exec(`CREATE TABLE IF NOT EXISTS ${FLAGS_TABLE} (name TEXT PRIMARY KEY, value TEXT NOT NULL)`);
}

/** 读单值旗标。 */
function readFlag(db: Db, name: string): string | null {
  const row = db.prepare(`SELECT value FROM ${FLAGS_TABLE} WHERE name = ?`).get(name) as
    | { value: string }
    | undefined;
  return row === undefined ? null : row.value;
}

export function createTableVersionStore(): VersionStore {
  return {
    kind: 'table',

    read(db: Db): number {
      ensureTables(db);
      const row = db.prepare(`SELECT version FROM ${VERSION_TABLE} WHERE id = 1`).get() as
        | { version: number }
        | undefined;
      if (row === undefined) {
        return 0;
      }
      const parsed: number = typeof row.version === 'number' ? row.version : Number(row.version);
      return Number.isInteger(parsed) ? parsed : 0;
    },

    write(db: Db, version: number): void {
      ensureTables(db);
      db.prepare(`INSERT OR REPLACE INTO ${VERSION_TABLE} (id, version) VALUES (1, ?)`).run(
        version,
      );
    },

    consumeRollbackAllowance(db: Db): RollbackAllowance | null {
      // Worker 上没有 CLI，放行凭据只能由运维写入（或压根不存在）。
      // 语义与 Node 侧一致：**读取即消费**，保证一次性。
      ensureTables(db);
      const raw: string | null = readFlag(db, ALLOWANCE_KEY);
      if (raw === null) {
        return null;
      }
      db.prepare(`DELETE FROM ${FLAGS_TABLE} WHERE name = ?`).run(ALLOWANCE_KEY);
      try {
        const parsed: unknown = JSON.parse(raw);
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          Number.isInteger((parsed as RollbackAllowance).fromVersion) &&
          Number.isInteger((parsed as RollbackAllowance).toVersion) &&
          typeof (parsed as RollbackAllowance).issuedAt === 'string'
        ) {
          return parsed as RollbackAllowance;
        }
      } catch {
        // 损坏的凭据按未放行处理（fail-closed）。
      }
      return null;
    },

    writeRollbackAllowance(db: Db, allowance: RollbackAllowance): void {
      ensureTables(db);
      db.prepare(`INSERT OR REPLACE INTO ${FLAGS_TABLE} (name, value) VALUES (?, ?)`).run(
        ALLOWANCE_KEY,
        JSON.stringify(allowance),
      );
    },
  };
}
