/**
 * 装配后的定时入口：物理快照间隔、逻辑备份入队、alarm 回落。
 *
 * 这些回调是「每日备份」唯一的执行路径，平时代码审查看不出问题——线接错了
 * 就是备份永远不跑，而且没有任何报错。故直接调运行时暴露的三个入口。
 */
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateBackupKeyPair } from '../src/lib/backup-crypto';
import { BackupScheduler } from '../src/services/backup-scheduler';
import { createHarness, type Harness } from './support/harness';

let harness: Harness | null = null;

afterEach(() => {
  harness?.close();
  harness = null;
});

describe('运行时定时入口', () => {
  it('runScheduledBackup：物理快照到期时落盘，逻辑备份同时入队', async () => {
    const pair = await generateBackupKeyPair();
    harness = await createHarness({ backupPublicKey: pair.publicKey });
    const h: Harness = harness;

    // 迁移期已生成一份基线快照，此时物理快照「未到期」。清空备份池以构造
    // 到期场景：到期判定只看池内最新一份的创建时间。
    rmSync(h.backupDir, { recursive: true, force: true });
    mkdirSync(h.backupDir, { recursive: true });

    await h.runtime.runScheduledBackup();

    const physical = h.deps.backup.list();
    expect(physical.ok).toBe(true);
    expect(physical.data?.items.length).toBeGreaterThan(0);
    expect(physical.data?.lastBackupAt).toBeTruthy();

    const listed = h.deps.logicalBackup.list();
    expect(listed.ok).toBe(true);
    expect(listed.data?.activeJob).not.toBeNull();
  });

  it('物理快照未到期时跳过，但仍推进逻辑备份（两者互不阻塞）', async () => {
    const pair = await generateBackupKeyPair();
    harness = await createHarness({ backupPublicKey: pair.publicKey });
    const h: Harness = harness;
    const before: number = readdirSync(h.backupDir).length;

    await h.runtime.runScheduledBackup();

    // 刚生成过基线快照 → 本次不重复拍，文件数不变。
    expect(readdirSync(h.backupDir)).toHaveLength(before);
    expect(h.deps.logicalBackup.list().data?.activeJob).not.toBeNull();
  });

  it('runBackgroundTick 无任务时返回 false（不空转、不抛错）', async () => {
    harness = await createHarness();
    await expect(harness.runtime.runBackgroundTick()).resolves.toBe(false);
  });

  it('runAlarmTick：Node 定时器没有 onAlarm，回落到直接推进 tick', async () => {
    harness = await createHarness();
    await expect(harness.runtime.runAlarmTick()).resolves.toBeUndefined();
  });

  it('start/stop 幂等，可安全重复调用', async () => {
    harness = await createHarness();
    const h: Harness = harness;
    h.runtime.start();
    h.runtime.start();
    h.runtime.stop();
    h.runtime.stop();
  });
});

describe('BackupScheduler', () => {
  it('start 幂等、到点触发一次、stop 后不再触发', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const scheduler = new BackupScheduler(async (): Promise<void> => {
        calls += 1;
      });

      scheduler.start();
      scheduler.start();
      expect(scheduler.isRunning()).toBe(true);

      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
      expect(calls).toBe(1);

      scheduler.stop();
      scheduler.stop();
      expect(scheduler.isRunning()).toBe(false);

      await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1_000);
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
