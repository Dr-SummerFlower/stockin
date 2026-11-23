/**
 * 表存储版 VersionStore 测试（任务卡 01 第 2 条：DO 不支持 PRAGMA user_version）。
 *
 * 用 DO 适配器 + 本机 SQLite 的接口仿真来跑：测的是**语义等价** ——
 * 读 0 起步、写入即幂等、放行凭据"读取即消费"、损坏凭据 fail-closed。
 * 真机（workerd）行为由 `.tmp/port-eval` 的端到端脚本覆盖。
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
import type { Db } from '../../src/repositories/db';
import { checkUserVersion } from '../../src/repositories/schema';
import { createTableVersionStore } from '../../src/runtime/workers/version-store.table';

function makeCursor(rows: Record<string, unknown>[]): DoSqlCursorLike {
  return {
    toArray: (): Record<string, unknown>[] => rows,
    [Symbol.iterator]: (): Iterator<Record<string, unknown>> => rows[Symbol.iterator](),
  } as DoSqlCursorLike;
}

function createDoStorageFake(file: string): {
  readonly storage: DoStorageLike;
  readonly close: () => void;
} {
  const raw: DatabaseSync = new DatabaseSync(file);
  const sql: DoSqlStorageLike = {
    // DO 的 `exec(query, ...bindings)`：读语句返回游标，写语句直接执行。
    // 绑定参数必须真的透传 —— 忽略它会让 `?` 变成 NULL，测试就会以一个
    // 与端口无关的 NOT NULL 约束错误收场。
    exec(query: string, ...bindings: unknown[]): DoSqlCursorLike {
      const trimmed: string = query.trim();
      const statement = raw.prepare(query);
      if (/^(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(trimmed)) {
        return makeCursor(statement.all(...(bindings as never[])) as Record<string, unknown>[]);
      }
      if (bindings.length > 0) {
        statement.run(...(bindings as never[]));
        return makeCursor([]);
      }
      // 无绑定 + 非读语句：可能是多语句脚本（建表、迁移），走 exec。
      raw.exec(query);
      return makeCursor([]);
    },
  };
  return {
    storage: {
      sql,
      transactionSync<T>(fn: () => T): T {
        raw.exec('BEGIN IMMEDIATE');
        try {
          const result: T = fn();
          raw.exec('COMMIT');
          return result;
        } catch (error) {
          raw.exec('ROLLBACK');
          throw error;
        }
      },
      async get<T>(_key: string): Promise<T | undefined> {
        return undefined;
      },
      async put(_key: string, _value: ArrayBuffer | ArrayBufferView | string): Promise<void> {},
      async delete(_key: string): Promise<boolean> {
        return false;
      },
      async list(): Promise<Map<string, unknown>> {
        return new Map();
      },
      async setAlarm(_time: number | Date): Promise<void> {},
      async deleteAlarm(): Promise<void> {},
    } as DoStorageLike,
    close: (): void => {
      raw.close();
    },
  };
}

describe('createTableVersionStore', () => {
  let dir: string;
  let db: Db;
  let close: () => void;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockin-vstore-'));
    const fake = createDoStorageFake(path.join(dir, 'do.db'));
    close = fake.close;
    db = createDoSqliteAdapter(fake.storage);
  });

  afterEach(() => {
    close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('kind 是 table（与 pragma 实现可区分）', () => {
    expect(createTableVersionStore().kind).toBe('table');
  });

  it('空库读出 0，写入后读回同值，且重复写入幂等', () => {
    const store = createTableVersionStore();
    expect(store.read(db)).toBe(0);
    store.write(db, 1);
    expect(store.read(db)).toBe(1);
    store.write(db, 1);
    expect(store.read(db)).toBe(1);
  });

  it('放行凭据读取即消费：第二次读为 null', () => {
    const store = createTableVersionStore();
    store.writeRollbackAllowance(db, {
      fromVersion: 2,
      toVersion: 1,
      issuedAt: '2026-11-15T00:00:00.000Z',
    });
    const first = store.consumeRollbackAllowance(db);
    expect(first).not.toBeNull();
    expect(first?.fromVersion).toBe(2);
    expect(store.consumeRollbackAllowance(db)).toBeNull();
  });

  it('损坏的放行凭据按未放行处理（fail-closed），且已被消费', () => {
    const store = createTableVersionStore();
    store.write(db, 1);
    db.exec('CREATE TABLE IF NOT EXISTS app_flags (name TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT OR REPLACE INTO app_flags (name, value) VALUES (?, ?)').run(
      'schema.rollback_allowance',
      '{ not json',
    );
    expect(store.consumeRollbackAllowance(db)).toBeNull();
    // 消费掉之后不会反复触发解析
    expect(store.consumeRollbackAllowance(db)).toBeNull();
  });

  it('与 checkUserVersion 串起来：版本高于期望时凭据可放行一次，第二次拒绝', () => {
    const store = createTableVersionStore();
    store.write(db, 2);
    store.writeRollbackAllowance(db, {
      fromVersion: 2,
      toVersion: 1,
      issuedAt: '2026-11-15T00:00:00.000Z',
    });
    expect(checkUserVersion(store.read(db), 1, () => store.consumeRollbackAllowance(db))).toBe(
      'rollback-allowed',
    );
    expect(() =>
      checkUserVersion(store.read(db), 1, () => store.consumeRollbackAllowance(db)),
    ).toThrow(/镜像回退|allow-rollback/);
  });

  it('版本一致时判定 ok，空库判定 migrate', () => {
    const store = createTableVersionStore();
    expect(checkUserVersion(store.read(db), 1, () => store.consumeRollbackAllowance(db))).toBe(
      'migrate',
    );
    store.write(db, 1);
    expect(checkUserVersion(store.read(db), 1, () => store.consumeRollbackAllowance(db))).toBe(
      'ok',
    );
  });

  it('版本号非整数时回落 0，不把脏值当成有效版本', () => {
    const store = createTableVersionStore();
    store.write(db, 1);
    db.prepare('UPDATE app_schema_version SET version = ? WHERE id = 1').run('oops');
    expect(store.read(db)).toBe(0);
  });
});
