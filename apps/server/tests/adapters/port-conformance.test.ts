/**
 * 端口一致性测试：同一套断言跑在两个适配器上。
 *
 * 目的不是"测 SQLite"，而是钉住**端口契约**：本地 `node:sqlite` 与
 * Durable Objects 存储的 API 形状差别很大（无 prepare、无 lastInsertRowid、
 * 不能 exec('BEGIN')），只要两者都能通过同一组断言，Repository 就不必关心
 * 自己跑在哪个运行时上。
 *
 * DO 侧用的是结构化替身：**接口形状仿真 DO，SQL 引擎仍是本机 SQLite**。
 * 这能验证适配器的翻译逻辑，但**不能**替代真机验证（真机还需验证
 * transactionSync 的同步回调约束与 DO 特有的语句白名单）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDoSqliteAdapter,
  type DoSqlCursorLike,
  type DoSqlStorageLike,
  type DoStorageLike,
} from '../../src/repositories/adapters/do-sqlite.adapter';
import { createNodeSqliteAdapter } from '../../src/repositories/adapters/node-sqlite.adapter';
import { UnsupportedCapabilityError, type DbPort } from '../../src/repositories/db.port';
import { verifyBackupFile } from '../../src/repositories/backup';

/** 只读语句判定（本测试替身自行识别，真实 DO 由引擎判定）。 */
const READER_PATTERN: RegExp = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i;

function makeCursor(
  rows: Record<string, unknown>[],
  rowsRead: number,
  rowsWritten: number,
): DoSqlCursorLike {
  return {
    toArray: (): Record<string, unknown>[] => rows,
    rowsRead,
    rowsWritten,
    [Symbol.iterator]: (): Iterator<Record<string, unknown>> => rows[Symbol.iterator](),
  };
}

/** DO storage 的接口仿真（SQL 由本机 SQLite 执行）。 */
function createDoStorageFake(file: string): {
  readonly storage: DoStorageLike;
  readonly dispose: () => void;
} {
  const raw: DatabaseSync = new DatabaseSync(file);
  const sql: DoSqlStorageLike = {
    exec(query: string, ...bindings: unknown[]): DoSqlCursorLike {
      const args = bindings as never[];
      if (READER_PATTERN.test(query)) {
        const rows = raw.prepare(query).all(...args) as Record<string, unknown>[];
        return makeCursor(rows, rows.length, 0);
      }
      try {
        const info = raw.prepare(query).run(...args);
        return makeCursor([], 0, Number(info.changes));
      } catch {
        // 多语句脚本（迁移）无法 prepare，退回 exec。
        raw.exec(query);
        return makeCursor([], 0, 0);
      }
    },
  };
  const storage: DoStorageLike = {
    sql,
    transactionSync<T>(callback: () => T): T {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const result: T = callback();
        raw.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          raw.exec('ROLLBACK');
        } catch {
          // 事务已自动回滚。
        }
        throw error;
      }
    },
  };
  return { storage, dispose: (): void => raw.close() };
}

interface OpenedPort {
  readonly db: DbPort;
  readonly dispose: () => void;
}

/** 两个适配器的统一装配入口。 */
const ADAPTERS: readonly { label: string; open: (file: string) => OpenedPort }[] = [
  {
    label: 'node:sqlite',
    open: (file: string): OpenedPort => {
      const db: DbPort = createNodeSqliteAdapter({ filename: file });
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA foreign_keys = ON');
      return { db, dispose: (): void => db.close() };
    },
  },
  {
    label: 'Durable Objects(仿真)',
    open: (file: string): OpenedPort => {
      const fake = createDoStorageFake(file);
      const db: DbPort = createDoSqliteAdapter(fake.storage);
      db.exec('CREATE TABLE IF NOT EXISTS _warmup (x INTEGER)');
      return { db, dispose: (): void => fake.dispose() };
    },
  },
];

for (const adapter of ADAPTERS) {
  describe(`端口契约 · ${adapter.label}`, () => {
    let dir: string;
    let port: OpenedPort;
    let db: DbPort;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockin-port-'));
      port = adapter.open(path.join(dir, 'main.db'));
      db = port.db;
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)');
    });

    afterEach(() => {
      port.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('run 返回归一化的 changes 与 lastInsertRowid（不是 bigint）', () => {
      const first = db.prepare('INSERT INTO t (name) VALUES (?)').run('牛奶');
      expect(typeof first.changes).toBe('number');
      expect(typeof first.lastInsertRowid).toBe('number');
      expect(first.changes).toBe(1);
      expect(first.lastInsertRowid).toBe(1);

      const second = db.prepare('INSERT INTO t (name) VALUES (?)').run('面包');
      expect(second.lastInsertRowid).toBe(2);
    });

    it('get 命中返回行；未命中返回 undefined', () => {
      db.prepare('INSERT INTO t (name) VALUES (?)').run('牛奶');
      const hit = db.prepare('SELECT name FROM t WHERE id = ?').get(1) as { name: string };
      expect(hit.name).toBe('牛奶');
      expect(db.prepare('SELECT name FROM t WHERE id = ?').get(999)).toBeUndefined();
    });

    it('all 返回全部行（顺序稳定）', () => {
      for (const name of ['A', 'B', 'C']) {
        db.prepare('INSERT INTO t (name) VALUES (?)').run(name);
      }
      const rows = db.prepare('SELECT name FROM t ORDER BY id').all() as { name: string }[];
      expect(rows.map((row) => row.name)).toEqual(['A', 'B', 'C']);
    });

    it('iterate 逐行产出，且不依赖 all()', () => {
      for (const name of ['A', 'B', 'C', 'D']) {
        db.prepare('INSERT INTO t (name) VALUES (?)').run(name);
      }
      const seen: string[] = [];
      for (const row of db.prepare('SELECT name FROM t ORDER BY id').iterate()) {
        seen.push((row as { name: string }).name);
      }
      expect(seen).toEqual(['A', 'B', 'C', 'D']);
    });

    it('事务提交后数据可见', () => {
      db.transaction('immediate', () => {
        db.prepare('INSERT INTO t (name) VALUES (?)').run('X');
        db.prepare('INSERT INTO t (name) VALUES (?)').run('Y');
      });
      const rows = db.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number };
      expect(rows.c).toBe(2);
    });

    it('事务内抛错则整体回滚，且错误原样抛出', () => {
      expect(() => {
        db.transaction('immediate', () => {
          db.prepare('INSERT INTO t (name) VALUES (?)').run('X');
          throw new Error('业务校验失败');
        });
      }).toThrow('业务校验失败');

      const rows = db.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number };
      expect(rows.c).toBe(0);
    });

    it('事务闭包可返回聚合值', () => {
      const id: number = db.transaction('immediate', () => {
        return db.prepare('INSERT INTO t (name) VALUES (?)').run('Z').lastInsertRowid;
      });
      expect(id).toBe(1);
    });

    it('readPragma 可读可写 user_version', () => {
      expect(db.readPragma('user_version')).toBe(0);
      db.exec('PRAGMA user_version = 7');
      expect(db.readPragma('user_version')).toBe(7);
    });

    it('readPragma(integrity_check) 返回 ok', () => {
      expect(db.readPragma('integrity_check')).toBe('ok');
    });

    it('checkpointTruncate 不抛错（无 WAL 控制权的后端为 no-op）', () => {
      expect(() => db.checkpointTruncate()).not.toThrow();
    });

    it('close 可重复调用', () => {
      db.close();
      expect(() => db.close()).not.toThrow();
    });
  });
}

describe('端口能力差异（按后端断言，不是缺陷）', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockin-port-cap-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('node:sqlite 的 backupTo 产出可校验的自包含快照，且不留边车文件', async () => {
    const file: string = path.join(dir, 'main.db');
    const db: DbPort = createNodeSqliteAdapter({ filename: file });
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    db.prepare('INSERT INTO t (name) VALUES (?)').run('牛奶');

    const dest: string = path.join(dir, 'snapshot.db');
    await db.backupTo(dest);
    db.close();

    const verified = verifyBackupFile(dest);
    expect(verified.integrity).toBe('ok');
    expect(verified.magic).toContain('SQLite format 3');
    expect(verified.userVersion).toBe(0);
    // 只读校验会临时生成 -shm/-wal；removeStraySidecars 应清掉 0 字节的组合。
    expect(fs.existsSync(`${dest}-wal`)).toBe(false);
    expect(fs.existsSync(`${dest}-shm`)).toBe(false);
  });

  it('node:sqlite 的 fileMustExist 语义被保留（不会静默新建空库）', () => {
    expect(() => {
      createNodeSqliteAdapter({ filename: path.join(dir, 'missing.db'), fileMustExist: true });
    }).toThrow('数据库文件不存在');
  });

  it('node:sqlite 拒绝事务嵌套（同步端口靠它保证临界区）', () => {
    const db: DbPort = createNodeSqliteAdapter({ filename: path.join(dir, 'nest.db') });
    expect(() => {
      db.transaction('immediate', () => {
        db.transaction('immediate', () => undefined);
      });
    }).toThrow('事务嵌套');
    db.close();
  });

  it('DO 适配器的 backupTo 明确抛能力缺失，而不是静默假成功', async () => {
    const fake = createDoStorageFake(path.join(dir, 'do.db'));
    const db: DbPort = createDoSqliteAdapter(fake.storage);
    await expect(db.backupTo(path.join(dir, 'nope.db'))).rejects.toBeInstanceOf(
      UnsupportedCapabilityError,
    );
    fake.dispose();
  });

  it('DO 适配器不产生文件（无文件系统语义）', async () => {
    const fake = createDoStorageFake(path.join(dir, 'do2.db'));
    const db: DbPort = createDoSqliteAdapter(fake.storage);
    const target: string = path.join(dir, 'should-not-exist.db');
    await expect(db.backupTo(target)).rejects.toThrow();
    expect(fs.existsSync(target)).toBe(false);
    fake.dispose();
  });

  it('node:sqlite 只读连接：写入失败、备份拒绝、checkpoint 为 no-op', async () => {
    const file: string = path.join(dir, 'ro.db');
    const writable: DbPort = createNodeSqliteAdapter({ filename: file });
    writable.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    writable.close();

    const readonly: DbPort = createNodeSqliteAdapter({ filename: file, readonly: true });
    expect(() => readonly.prepare('INSERT INTO t (name) VALUES (?)').run('x')).toThrow();
    await expect(readonly.backupTo(path.join(dir, 'ro-snap.db'))).rejects.toBeInstanceOf(
      UnsupportedCapabilityError,
    );
    expect(() => readonly.checkpointTruncate()).not.toThrow();
    readonly.close();
  });

  it('node:sqlite 的 isOpen 反映真实句柄状态', () => {
    const db: DbPort = createNodeSqliteAdapter({ filename: path.join(dir, 'state.db') });
    expect(db.isOpen).toBe(true);
    db.close();
    expect(db.isOpen).toBe(false);
  });

  it('deferred 事务同样生效（只读快照 / 常规组合写）', () => {
    const db: DbPort = createNodeSqliteAdapter({ filename: path.join(dir, 'deferred.db') });
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    db.transaction('deferred', () => {
      db.prepare('INSERT INTO t (name) VALUES (?)').run('A');
    });
    const row = db.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number };
    expect(row.c).toBe(1);
    db.close();
  });
});
