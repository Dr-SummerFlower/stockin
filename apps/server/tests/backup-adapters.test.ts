/**
 * 备份 / 恢复平台适配器测试：Node 定时器、Workers alarm、两套暂存端口。
 *
 * 目标是把平台差异的分支也纳入覆盖率口径（这些文件此前 0%）。
 * 用内存 DoStorageLike 仿真 DO 的 KV + alarm，不依赖 workerd。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('alarm 触发后 tick 内再次 schedule 能续上（多 chunk 链不中断）', async () => {
    // 复现修复前的核心缺陷：DO alarm() 直接调 tick() 时，tick 末尾的 schedule()
    // 因 nextAlarmMs 守卫未清空而被吞，多 chunk 备份推进一次即停滞。
    const storage = createMemoryStorage();
    const scheduler = createAlarmScheduler({ storage, defaultDelayMs: 10 });
    let ticks = 0;
    scheduler.setTick(async () => {
      ticks += 1;
      // 模拟 LogicalBackupService.tick() 末尾的续调度。
      if (ticks < 3) {
        scheduler.schedule(5);
      }
      return ticks < 3;
    });
    scheduler.schedule(25);
    expect(storage.alarms.length).toBe(1);

    const handle = asAlarmScheduler(scheduler);
    // 第一次 alarm：onAlarm 清空守卫 → tick → tick 内 schedule 续上第二次 alarm。
    await handle.onAlarm();
    expect(ticks).toBe(1);
    expect(storage.alarms.length).toBe(2);
    // 第二次 alarm：同样能续上第三次。
    await handle.onAlarm();
    expect(ticks).toBe(2);
    expect(storage.alarms.length).toBe(3);
    // 第三次 tick 返回 false（工作完成），不再 schedule，链自然终止。
    await handle.onAlarm();
    expect(ticks).toBe(3);
    expect(storage.alarms.length).toBe(3);
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
    expect(await staging.isConsumed('rb-1')).toBe(false);
    expect(await staging.consumeBatch('rb-1', new Date(Date.now() + 60_000).toISOString())).toBe(
      true,
    );
    expect(await staging.isConsumed('rb-1')).toBe(true);
    // 瞬时锁 .consuming 在消费成功后应立即清理，不留残留。
    expect(existsSync(path.join(dir, 'restore-staging', 'rb-1', '.consuming'))).toBe(false);
    expect(existsSync(path.join(dir, 'restore-staging', 'rb-1', '.consumed'))).toBe(true);
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

  it('消费标记 3 小时后过期：isConsumed 直接清理，可重新消费', async () => {
    const consumedFile = path.join(dir, 'restore-staging', 'rb-ttl', '.consumed');
    await staging.consumeBatch('rb-ttl', new Date(Date.now() + 60_000).toISOString());
    expect(existsSync(consumedFile)).toBe(true);
    // 把标记改成 3 小时前签发即已过期的状态。
    writeFileSync(consumedFile, new Date(Date.now() - 1000).toISOString(), 'utf8');
    expect(await staging.isConsumed('rb-ttl')).toBe(false);
    expect(existsSync(consumedFile)).toBe(false);
    expect(await staging.consumeBatch('rb-ttl', new Date(Date.now() + 60_000).toISOString())).toBe(
      true,
    );
  });
});

describe('Workers KV 恢复暂存', () => {
  /** 让 KV 读写各跨一次宏任务，放大 get→put 之间的交错窗口。 */
  function slowStorage(base: DoStorageLike): DoStorageLike {
    return {
      ...base,
      async get<T>(key: string): Promise<T | undefined> {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return base.get<T>(key);
      },
      async put(key: string, value: ArrayBuffer | ArrayBufferView | string): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 1));
        await base.put(key, value);
      },
    };
  }

  /** 串行化器替身：对应 Workers 上的 `ctx.blockConcurrencyWhile`。 */
  function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
    let tail: Promise<unknown> = Promise.resolve();
    return <T>(fn: () => Promise<T>): Promise<T> => {
      const run: Promise<T> = tail.then(fn, fn);
      tail = run.catch(() => undefined);
      return run;
    };
  }

  it('并发 consumeBatch 未串行化会双成功，注入 runExclusive 后只成功一次', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    // 基线：用屏障强制两个并发请求都先读到「未消费」再各自写入——这正是
    // get→put 之间被插入时的竞态，说明「DO 单实例」本身不足以保证一次性消费。
    const base = createMemoryStorage();
    let arrived = 0;
    let releaseBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const racing: DoStorageLike = {
      ...base,
      async get<T>(key: string): Promise<T | undefined> {
        arrived += 1;
        if (arrived >= 2) {
          releaseBarrier();
        }
        await barrier;
        return base.get<T>(key);
      },
    };
    const plain = createKvRestoreStaging({ storage: racing });
    const unguarded = await Promise.all([
      plain.consumeBatch('rb-race', expiresAt),
      plain.consumeBatch('rb-race', expiresAt),
    ]);
    expect(unguarded).toEqual([true, true]);

    // 注入串行化（Workers 由 ctx.blockConcurrencyWhile 提供）后，只有一个成功。
    const guarded = createKvRestoreStaging({
      storage: slowStorage(createMemoryStorage()),
      runExclusive: createMutex(),
    });
    const serialized = await Promise.all([
      guarded.consumeBatch('rb-race', expiresAt),
      guarded.consumeBatch('rb-race', expiresAt),
    ]);
    expect(serialized.filter(Boolean)).toHaveLength(1);
    expect(await guarded.isConsumed('rb-race')).toBe(true);
  });

  it('分块 CRUD + 防重放 + 非法参数', async () => {
    const storage = createMemoryStorage();
    const staging = createKvRestoreStaging({ storage });
    await staging.putChunk('rb-2', 0, new TextEncoder().encode('x'));
    expect(new TextDecoder().decode((await staging.readChunk('rb-2', 0))!)).toBe('x');
    expect(await staging.listChunkSeqs('rb-2')).toEqual([0]);
    expect(await staging.isConsumed('rb-2')).toBe(false);
    expect(await staging.consumeBatch('rb-2', new Date(Date.now() + 60_000).toISOString())).toBe(
      true,
    );
    expect(await staging.isConsumed('rb-2')).toBe(true);
    expect(await staging.consumeBatch('rb-2', new Date(Date.now() + 60_000).toISOString())).toBe(
      false,
    );
    await staging.deleteBatch('rb-2');
    expect(await staging.listChunkSeqs('rb-2')).toEqual([]);
    await expect(staging.putChunk('../bad', 0, new Uint8Array([1]))).rejects.toThrow(/非法/);
    await expect(staging.putChunk('rb-3', -1, new Uint8Array([1]))).rejects.toThrow(/非法/);
    expect(await staging.consumeBatch('rb-3', new Date(Date.now() - 1).toISOString())).toBe(false);
  });

  it('消费标记过期后被清理，可重新消费', async () => {
    const storage = createMemoryStorage();
    const staging = createKvRestoreStaging({ storage });
    const key = 'restore:rb-ttl:consumed';
    await staging.consumeBatch('rb-ttl', new Date(Date.now() + 60_000).toISOString());
    expect(await staging.isConsumed('rb-ttl')).toBe(true);
    // 改写标记值为已过期时间戳。
    await storage.put(key, new Date(Date.now() - 1000).toISOString());
    expect(await staging.isConsumed('rb-ttl')).toBe(false);
    expect(await staging.consumeBatch('rb-ttl', new Date(Date.now() + 60_000).toISOString())).toBe(
      true,
    );
  });
});
