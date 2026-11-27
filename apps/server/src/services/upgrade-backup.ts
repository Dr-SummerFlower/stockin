/**
 * 升级专用备份：**升级前物理快照、升级后逻辑备份**，各一份（用户 2026-11-24 定调）。
 *
 * 为什么是这个顺序，而不是两样都在升级前：
 *  - 物理快照是**回滚点**，必须取改结构之前的整库字节——晚一步就回不去了。它由
 *    `runMigrations()` 里的 `backup.create('pre-migration')` 负责，本文件不碰。
 *  - 逻辑备份是**数据副本**，要能直接在当前版本恢复、能下载走、能在别的机器上用
 *    `backup:decrypt` 解开。放在升级后，它读到的就是新结构的数据，`schemaVersion`
 *    记当前版本，不再有「包里是旧结构、meta 写着新版本」那种自欺；代价是它不能
 *    用来回滚（回滚靠上面那份物理快照），也不覆盖「迁移中途失败」——那种情况
 *    迁移事务本身会回滚、进程直接退出，根本走不到这里。
 *
 * 三个必须写进注释的约束：
 *
 * ① **只在 Node（backupMode = 'filesystem'）跑**。Workers 上 `bootstrap()` 发生在
 *    Durable Object 首次请求内，整库导出要在这里同步推完上百个 chunk，128MB 内存
 *    与 10ms/次（免费版）的 CPU 预算都撑不住；那边的物理备份本来就是平台 PITR，
 *    时间点恢复由 Cloudflare 托管。要额外留一份逻辑备份，就在升级前到管理台手动
 *    点一次「立即备份」。
 *
 * ② **必须在迁移成功、统计就绪之后调用**。逻辑备份靠 keyset 分页扫 `records`，
 *    没有查询规划器统计时每个 chunk 都会退化成「全表扫描 + 临时 B 树」（实测 12
 *    万行 63ms vs 0.12ms），600 个 chunk 就是几十秒的纯浪费，还会白烧行读额度。
 *
 * ③ **失败一律降级为 skipped，不阻断启动**。迁移已经提交，此时把启动拦下来只会
 *    让用户卡在「升级完了但服务起不来」这种最差的状态。没配公钥、已有任务在跑、
 *    空间不足都属于「这条路走不通」；真正的异常会在下次启动的迁移自检里暴露。
 */
import { logger } from '../lib/logger';
import type { PlatformProfile } from '../runtime/platform';
import type { BackgroundTaskScheduler } from '../runtime/ports';
import type { Db } from '../repositories/db';
import { tableExists } from '../repositories/db';
import { SCHEMA_EXPECTED } from '../repositories/schema';
import {
  LOGICAL_BACKUP_KEEP_COUNT,
  LogicalBackupRepository,
} from '../repositories/logical-backup.repository';
import { MetaRepository } from '../repositories/meta.repository';
import { OperationLogRepository } from '../repositories/operation-log.repository';
import { SettingsRepository } from '../repositories/settings.repository';
import { BackupKeyService } from './backup-key.service';
import { BackupKeyRepository } from '../repositories/backup-key.repository';
import { LogicalBackupService } from './logical-backup.service';

/** 每轮推进的 chunk 数：启动期没有并发压力，批量大一点能少绕几圈事件循环。 */
const DRAIN_CHUNKS_PER_ROUND = 8;

/**
 * 推进轮次上限（8 chunk × 4000 轮 = 3.2 万 chunk ≈ 640 万行）。
 *
 * 正常情况下 12 万行 600 个 chunk、75 轮就结束。设上限只为「将来某次改动把
 * tick 写成永远返回 true」时不要变成启动死循环。
 */
const MAX_DRAIN_ROUNDS = 4000;

/** 启动期不需要真调度：所有推进都在当前调用栈里同步推完。 */
const DRAIN_SCHEDULER: BackgroundTaskScheduler = {
  setTick(): void {
    // 升级备份不接后台 tick，留空即可（见文件头约束 ①）。
  },
  schedule(): void {
    // 同上：不排队，避免在 bootstrap 阶段把调度器提前唤醒。
  },
};

/** 升级备份的结果（只用于日志与启动结果展示）。 */
export interface UpgradeBackupNote {
  readonly status: 'ok' | 'skipped';
  /** 逻辑备份 id（`status: 'ok'` 时有值）。 */
  readonly backupId?: string;
  /** 跳过 / 失败原因（`status: 'skipped'` 时有值，直接进日志）。 */
  readonly reason?: string;
}

export interface UpgradeBackupInput {
  readonly db: Db;
  readonly platform: PlatformProfile;
  /** 迁移前的版本，仅用于日志与「全新库」判定。 */
  readonly fromVersion: number;
}

/**
 * 生成「升级后逻辑备份」，并把任务推到 ready（或如实返回跳过原因）。
 *
 * 调用点只有一个：`bootstrap()` 在迁移成功、`ensureQueryPlannerStats()` 之后。
 * 此时 schema 已是 `SCHEMA_EXPECTED`，所以备份 meta 里记的也是它——这份包可以直接
 * 在当前版本恢复。
 */
export async function takeUpgradeLogicalBackup(
  input: UpgradeBackupInput,
): Promise<UpgradeBackupNote> {
  const { db, platform, fromVersion } = input;

  if (platform.backupMode !== 'filesystem') {
    return {
      status: 'skipped',
      reason:
        '当前运行时由平台托管备份（PITR），启动路径不生成逻辑备份；升级前请在管理台手动备份一次',
    };
  }
  if (fromVersion <= 0) {
    // 全新库：迁移就是建库，此刻没有任何业务数据，逻辑备份没有意义。
    return { status: 'skipped', reason: '全新库（schema 0），没有数据可备份' };
  }
  // 迁移已跑到 SCHEMA_EXPECTED，004 引入的备份表必然存在；这里只是防御性判断，
  // 免得将来有人把这段搬到迁移之前又忘了改。
  if (!tableExists(db, 'backups') || !tableExists(db, 'backup_jobs')) {
    return { status: 'skipped', reason: '当前库还没有备份表（004 引入），无法生成逻辑备份' };
  }

  const repo = new LogicalBackupRepository(db);
  const logs = new OperationLogRepository(db);
  // 迁移后 `backup_keys` 一定存在（006 引入）；bootstrap 已在升级备份之前完成
  // 默认公钥播种，这里只认库内真源，没有公钥就如实跳过。
  const keys = new BackupKeyService({ db, repo: new BackupKeyRepository(db), logs });
  if (!keys.enabled) {
    return {
      status: 'skipped',
      reason: '库内没有备份公钥，无法生成逻辑备份',
    };
  }

  const service = new LogicalBackupService({
    db,
    repo,
    settings: new SettingsRepository(db),
    meta: new MetaRepository(db),
    logs,
    scheduler: DRAIN_SCHEDULER,
    keys,
    // 不注入 physicalBackup：升级前的物理快照已经由 runner 生成，这里再刷一次
    // 只会多出一份内容几乎相同的快照。
  });

  try {
    const abandoned: number = service.abandonStaleJobs();
    if (abandoned > 0) {
      logger.warn({ abandoned }, '[upgrade-backup] 已作废上次进程残留的备份任务，继续生成升级备份');
    }

    const enqueued = await service.enqueue('post-migration', '');
    if (!enqueued.ok) {
      return {
        status: 'skipped',
        reason:
          enqueued.code === 'COMMON_BUSY'
            ? '已有备份任务正在推进，本次升级不再重复生成逻辑备份'
            : `逻辑备份入队失败（${enqueued.code}）`,
      };
    }
    const { jobId } = enqueued.data;
    logger.info(
      { jobId, fromVersion, schemaVersion: SCHEMA_EXPECTED },
      '[upgrade-backup] 开始生成升级后逻辑备份',
    );

    let rounds = 0;
    for (;;) {
      rounds += 1;
      if (rounds > MAX_DRAIN_ROUNDS) {
        return { status: 'skipped', reason: `逻辑备份未在 ${MAX_DRAIN_ROUNDS} 轮内完成，已放弃` };
      }
      const more: boolean = await service.tick(DRAIN_CHUNKS_PER_ROUND);
      if (!more) {
        break;
      }
    }

    const job = repo.getJob(jobId);
    const backup = repo.getBackupByJob(jobId);
    if (backup === undefined || backup.status !== 'ready') {
      return {
        status: 'skipped',
        reason: `逻辑备份未完成（job=${jobId}，状态=${job?.status ?? 'unknown'}）：${
          job?.error ?? '原因未记录'
        }`,
      };
    }
    logger.info(
      {
        jobId,
        backupId: backup.id,
        chunks: backup.chunk_count,
        plainBytes: backup.plain_bytes,
        keepCount: LOGICAL_BACKUP_KEEP_COUNT,
      },
      '[upgrade-backup] 升级后逻辑备份完成',
    );
    return { status: 'ok', backupId: backup.id };
  } catch (error) {
    const message: string = error instanceof Error ? error.message : String(error);
    logger.error({ err: message }, '[upgrade-backup] 生成升级后逻辑备份时出错');
    return { status: 'skipped', reason: `逻辑备份出错：${message}` };
  }
}
