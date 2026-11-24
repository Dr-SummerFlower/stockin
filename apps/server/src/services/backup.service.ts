/**
 * 备份服务：复用备份端口的在线快照与校验链。
 *
 * 依据：设计文档 v1.1 §4.5 / §7.5 —— 手动 / 每日 / 导入前触发；最近 7 份；
 * 应用内空间提示；**无下载端点**；与导入共用全局信号量(1) 互斥。
 *
 * 2026-11-15：快照实现改为 `BackupPort` 注入 —— Node 是文件快照池，
 * Workers 是平台 PITR（`create` 恒返回 skipped，界面按"平台托管"展示）。
 */
import { Action, ErrorCode, TARGET_TYPE } from '@stockin/shared';
import type { Db } from '../repositories/db';
import { immediateTransaction } from '../repositories/db';
import type { BackupMeta } from '../repositories/backup';
import type { BackupPort } from '../runtime/ports';
import type { MetaRepository } from '../repositories/meta.repository';
import type { OperationLogRepository } from '../repositories/operation-log.repository';
import type { SettingsRepository } from '../repositories/settings.repository';
import type { Env } from '../env';
import { utcNowIso } from '../lib/today';
import type { HeavyTaskGate } from './heavy-task';
import type { ServiceResult } from '../app';

export interface BackupServiceDeps {
  readonly db: Db;
  readonly env: Env;
  readonly meta: MetaRepository;
  readonly logs: OperationLogRepository;
  readonly gate: HeavyTaskGate;
  readonly settings: SettingsRepository;
  /** 备份端口：Node 文件快照 / Workers 平台 PITR。 */
  readonly port: BackupPort;
}

export interface BackupTriggerResult {
  readonly status: 'ok' | 'skipped';
  readonly meta: BackupMeta | null;
}

export interface BackupListResult {
  readonly items: readonly BackupMeta[];
  readonly keepCount: number;
  readonly lastBackupAt: string | null;
}

/** 备份服务（单进程内唯一实例）。 */
export class BackupService {
  constructor(private readonly deps: BackupServiceDeps) {}

  /** 触发一次备份；导入占用信号量时返回 503 `COMMON_BUSY`，不排队。 */
  async trigger(
    reason: string,
    requestId: string = '',
  ): Promise<ServiceResult<BackupTriggerResult>> {
    if (!this.deps.gate.acquire()) {
      return { ok: false, code: ErrorCode.COMMON_BUSY };
    }
    try {
      const result = await this.deps.port.create(this.deps.db, {
        reason,
        initState: this.deps.meta.initState(),
        minFreeBytes: this.deps.env.minFreeBytes,
        keepCount: this.deps.port.keepCount,
      });
      const status: 'ok' | 'skipped' | 'failed' = result.status === 'ok' ? 'ok' : 'skipped';
      const meta: BackupMeta | null = result.status === 'ok' ? result.meta : null;
      const nowUtc: string = utcNowIso();

      immediateTransaction(this.deps.db, () => {
        this.deps.meta.setLastBackup(nowUtc, status);
        this.deps.logs.append({
          action: Action.BACKUP_CREATE,
          targetType: TARGET_TYPE.BACKUP,
          targetId: null,
          detail: { reason, status, file: meta?.file ?? null },
          requestId,
          actor: 'system',
          occurredAt: nowUtc,
        });
      });

      return { ok: true, data: { status: result.status, meta } };
    } finally {
      this.deps.gate.release();
    }
  }

  /** 仅返回元数据列表，绝不下发文件路径供下载。 */
  list(): ServiceResult<BackupListResult> {
    const items: BackupMeta[] = this.deps.port.list().map((meta) => ({
      file: meta.file,
      gzipFile: meta.gzipFile,
      createdAt: meta.createdAt,
      userVersion: meta.userVersion,
      initState: meta.initState,
      integrity: meta.integrity,
      sha256: meta.sha256,
      magic: meta.magic,
      reason: meta.reason,
      baseline: meta.baseline,
      sizeBytes: meta.sizeBytes,
    }));
    return {
      ok: true,
      data: {
        items,
        keepCount: this.deps.port.keepCount,
        lastBackupAt: this.deps.meta.lastBackupAt(),
      },
    };
  }

  /** 备份池形态：`filesystem` 可下载，`pitr` 由平台托管。 */
  get mode(): 'filesystem' | 'pitr' {
    return this.deps.port.mode;
  }

  /**
   * 应用侧物理快照是否到期：距最近一份快照已达管理员配置的间隔。
   * 定时入口与逻辑备份后的兜底快照共用此判定，避免兜底快照不断刷新
   * 「最近快照时间」而让物理间隔配置失效（遗留 A）。
   * - 从未有快照：到期（首次即做）。
   * - PITR 模式：恒不到期——回滚点由平台托管，应用侧 trigger 只会 skipped，
   *   跳过可避免每日写入无意义的 BACKUP_CREATE skipped 日志（遗留 E）。
   * @param nowMs 注入当前时间，便于确定性测试。
   */
  isPhysicalDue(nowMs: number = Date.now()): boolean {
    if (this.mode === 'pitr') {
      return false;
    }
    const intervalDays: number = this.deps.settings.getPhysicalBackupIntervalDays();
    const listResult = this.list();
    const latest = listResult.ok ? listResult.data.items[0] : undefined;
    if (latest === undefined) {
      return true;
    }
    const lastMs: number = Date.parse(latest.createdAt);
    return !Number.isFinite(lastMs) || nowMs - lastMs >= intervalDays * 86_400_000;
  }

  /**
   * 读取一份备份（仅管理员下载端点使用）。
   * 返回 null 表示「当前运行时没有文件」或「文件名不在备份池内」。
   */
  download(file: string): { data: Uint8Array; filename: string } | null {
    return this.deps.port.read?.(file) ?? null;
  }

  /** 供导入前备份复用：不占用信号量（调用方已持有）。 */
  async backupWithoutGate(
    reason: string,
    requestId: string,
    actor: string,
  ): Promise<ServiceResult<BackupTriggerResult>> {
    const result = await this.deps.port.create(this.deps.db, {
      reason,
      initState: this.deps.meta.initState(),
      minFreeBytes: this.deps.env.minFreeBytes,
      keepCount: this.deps.port.keepCount,
    });
    const meta: BackupMeta | null = result.status === 'ok' ? result.meta : null;
    const nowUtc: string = utcNowIso();
    immediateTransaction(this.deps.db, () => {
      this.deps.meta.setLastBackup(nowUtc, result.status === 'ok' ? 'ok' : 'skipped');
      this.deps.logs.append({
        action: Action.BACKUP_CREATE,
        targetType: TARGET_TYPE.BACKUP,
        targetId: null,
        detail: { reason, status: result.status, file: meta?.file ?? null },
        requestId,
        actor,
        occurredAt: nowUtc,
      });
    });
    return { ok: true, data: { status: result.status, meta } };
  }
}
