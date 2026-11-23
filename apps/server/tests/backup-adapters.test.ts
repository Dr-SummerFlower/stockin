/**
 * 备份 / 恢复平台适配器测试：Node 定时器、Workers alarm、两套暂存端口。
 *
 * 目标是把平台差异的分支也纳入覆盖率口径（这些文件此前 0%）。
 * 用内存 DoStorageLike 仿真 DO 的 KV + alarm，不依赖 workerd。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DoStorageLike } from '../src/repositories/adapters/do-sqlite.adapter';
import { createNodeScheduler } from '../src/runtime/node/scheduler.interval';
import { createFilesystemRestoreStaging } from '../src/runtime/node/restore-staging.filesystem';
import { createAlarmScheduler, asAlarmScheduler } from '../src/runtime/workers/scheduler.alarm';
import { createKvRestoreStaging } from '../src/runtime/workers/restore-staging.kv';

function createMemoryStorage(): DoStorageLike & { alarms: (number | Date)[] } {
  const kv = new Map<string, ArrayBuffer | ArrayBufferView | string>();
  const alarms: (number | Date)[] = [];
  return {
    alarms,
    sql: {
      exec: () => ({
        toArray: () => [],
        rowsRead: 0,
        rowsWritten: 0,
        [Symbol.iterator]: function* () {},
      }),
    },
    transactionSync<T>(fn: () => T): T {
      return fn();
    },
    async get<T>(key: string): Promise<T | undefined> {
      return kv.get(key) as T | undefined;
    },
    async put(key: string, value: ArrayBuffer | ArrayBufferView | string): Promise<void> {
      kv.set(key, value);
    },
    async delete(key: string): Promise<boolean> {
      return kv.delete(key);
    },
    async list(options?: { prefix?: string }): Promise<Map<string, unknown>> {
      const result = new Map<string, unknown>();
      for (const [key, value] of kv) {
        if (options?.prefix === undefined || key.startsWith(options.prefix)) {
          result.set(key, value);
        }
      }
      return result;
    },
    async setAlarm(time: number | Date): Promise<void> {
      alarms.push(time);
    },
    async deleteAlarm(): Promise<void> {
      alarms.length = 0;
    },
  };
}

describe('Node 后台调度器', () => {
  it('setTick + schedule：tick 返回 true 后续调度，stop 后不再调度', async () => {
    const scheduler = createNodeScheduler({ continueDelayMs: 1, minDelayMs: 1 });
    let calls = 0;
    scheduler.setTick(async () => {
      calls += 1;
      return calls < 2; // 第一次 true（续调度），第二次 false（停止）
    });
    scheduler.schedule(1);
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toBeGreaterThanOrEqual(2);
    scheduler.stop?.();
    const before = calls;
    scheduler.schedule(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(before);
  });

  it('tick 抛错被吞掉，不冒泡', async () => {
    const scheduler = createNodeScheduler({ minDelayMs: 1 });
    scheduler.setTick(async () => {
      throw new Error('boom');
    });
    expect(() => scheduler.schedule(1)).not.toThrow();
    await new Promise((r) => setTimeout(r, 30));
    scheduler.stop?.();
  });
});

describe('Workers alarm 调度器', () => {
  it('schedule 合并更早的 alarm，onAlarm 触发 tick，stop 删 alarm', async () => {
    const storage = createMemoryStorage();
    const scheduler = createAlarmScheduler({ storage, defaultDelayMs: 10 });
    let called = 0;
    scheduler.setTick(async () => {
      called += 1;
      return false;
    });
    scheduler.schedule(100);
    scheduler.schedule(1); // 更早，覆盖（DO 的 setAlarm 会替换前一个）
    await Promise.resolve();
    expect(storage.alarms.length).toBe(2);
    expect(storage.alarms[1]).toBeLessThan(storage.alarms[0] as number);
    const handle = asAlarmScheduler(scheduler);
    await handle.onAlarm();
    expect(called).toBe(1);
    scheduler.stop?.();
  });

  it('非 alarm 调度器取 handle 抛错', () => {
    const nodeScheduler = createNodeScheduler();
    expect(() => asAlarmScheduler(nodeScheduler)).toThrow(/alarm/);
  });
});

describe('Node 文件系统恢复暂存', () => {
  let dir: string;
  let staging: ReturnType<typeof createFilesystemRestoreStaging>;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'staging-fs-'));
    staging = createFilesystemRestoreStaging({ tmpDir: dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('分块读写、列举、删除；消费一次性', async () => {
    await staging.putChunk('rb-1', 0, new TextEncoder().encode('a'));
    await staging.putChunk('rb-1', 1, new TextEncoder().encode('b'));
    expect(await staging.listChunkSeqs('rb-1')).toEqual([0, 1]);
    expect(new TextDecoder().decode((await staging.readChunk('rb-1', 1))!)).toBe('b');
    expect(await staging.consumeBatch('rb-1', new Date(Date.now() + 60_000).toISOString())).toBe(
      true,
    );
    expect(await staging.consumeBatch('rb-1', new Date(Date.now() + 60_000).toISOString())).toBe(
      false,
    );
    await staging.deleteBatch('rb-1');
    expect(await staging.listChunkSeqs('rb-1')).toEqual([]);
  });

  it('非法 batchId / seq 被拒绝', async () => {
    await expect(staging.putChunk('../evil', 0, new Uint8Array([1]))).rejects.toThrow(/非法/);
    await expect(staging.putChunk('rb-1', -1, new Uint8Array([1]))).rejects.toThrow(/非法/);
  });

  it('过期票据消费返回 false', async () => {
    expect(await staging.consumeBatch('rb-1', new Date(Date.now() - 1000).toISOString())).toBe(
      false,
    );
  });
});

describe('Workers KV 恢复暂存', () => {
  it('分块 CRUD + 防重放 + 非法参数', async () => {
    const storage = createMemoryStorage();
    const staging = createKvRestoreStaging({ storage });
    await staging.putChunk('rb-2', 0, new TextEncoder().encode('x'));
    expect(new TextDecoder().decode((await staging.readChunk('rb-2', 0))!)).toBe('x');
    expect(await staging.listChunkSeqs('rb-2')).toEqual([0]);
    expect(await staging.consumeBatch('rb-2', new Date(Date.now() + 60_000).toISOString())).toBe(
      true,
    );
    expect(await staging.consumeBatch('rb-2', new Date(Date.now() + 60_000).toISOString())).toBe(
      false,
    );
    await staging.deleteBatch('rb-2');
    expect(await staging.listChunkSeqs('rb-2')).toEqual([]);
    await expect(staging.putChunk('../bad', 0, new Uint8Array([1]))).rejects.toThrow(/非法/);
    await expect(staging.putChunk('rb-3', -1, new Uint8Array([1]))).rejects.toThrow(/非法/);
    expect(await staging.consumeBatch('rb-3', new Date(Date.now() - 1).toISOString())).toBe(false);
  });
});
