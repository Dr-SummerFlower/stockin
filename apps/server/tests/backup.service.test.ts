/**
 * BackupService 到期判定测试（遗留 A / E）：
 * 定时入口与逻辑备份兜底共用 isPhysicalDue()，物理间隔配置才真正生效；
 * PITR 模式恒不到期，避免每日空触发写噪声日志。
 */
import { describe, expect, it } from 'vitest';
import { BackupService } from '../src/services/backup.service';
import type { BackupMeta } from '../src/repositories/backup';
import type { BackupPort } from '../src/runtime/ports';
import type { SettingsRepository } from '../src/repositories/settings.repository';

const NOW = Date.parse('2026-11-24T12:00:00.000Z');

function makeService(options: {
  mode: 'filesystem' | 'pitr';
  latestCreatedAt: string | null;
  intervalDays: number;
}): BackupService {
  const items: BackupMeta[] =
    options.latestCreatedAt === null
      ? []
      : [{ createdAt: options.latestCreatedAt } as unknown as BackupMeta];
  const port = {
    mode: options.mode,
    keepCount: 7,
    list: () => items,
  } as unknown as BackupPort;
  const settings = {
    getPhysicalBackupIntervalDays: () => options.intervalDays,
  } as unknown as SettingsRepository;
  return new BackupService({
    db: {} as never,
    env: {} as never,
    meta: { lastBackupAt: () => null } as never,
    logs: {} as never,
    gate: {} as never,
    settings,
    port,
  });
}

describe('BackupService.isPhysicalDue（物理间隔语义）', () => {
  it('从未有物理快照时到期（首次即做）', () => {
    const svc = makeService({ mode: 'filesystem', latestCreatedAt: null, intervalDays: 30 });
    expect(svc.isPhysicalDue(NOW)).toBe(true);
  });

  it('距最近快照未达间隔时不到期', () => {
    const svc = makeService({
      mode: 'filesystem',
      latestCreatedAt: '2026-11-20T12:00:00.000Z', // 4 天前
      intervalDays: 30,
    });
    expect(svc.isPhysicalDue(NOW)).toBe(false);
  });

  it('距最近快照达到间隔时到期', () => {
    const svc = makeService({
      mode: 'filesystem',
      latestCreatedAt: '2026-10-25T12:00:00.000Z', // 30 天前
      intervalDays: 30,
    });
    expect(svc.isPhysicalDue(NOW)).toBe(true);
  });

  it('快照时间非法时按到期处理，不阻断备份', () => {
    const svc = makeService({
      mode: 'filesystem',
      latestCreatedAt: 'not-a-date',
      intervalDays: 30,
    });
    expect(svc.isPhysicalDue(NOW)).toBe(true);
  });

  it('PITR 模式恒不到期（回滚点由平台托管，跳过每日空触发）', () => {
    const svc = makeService({ mode: 'pitr', latestCreatedAt: null, intervalDays: 30 });
    expect(svc.isPhysicalDue(NOW)).toBe(false);
  });
});
