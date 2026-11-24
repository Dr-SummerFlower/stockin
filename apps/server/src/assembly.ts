/**
 * 应用装配：把「已连接的数据库 + 已解析的环境 + 端口实现」拼成 Hono 应用。
 *
 * Node 与 Workers 的组合根都调用这里，因此**服务层的接线只有一份**。
 * 之前这段代码在 `index.ts` 里，若 Worker 入口复制一遍，两边必然漂移
 * （新加一个 Service 只会改到其中一边）。
 *
 * 本文件不 import 任何平台模块（无 `node:fs`、无 `@hono/node-server`），
 * 因此在两种运行时下都能原样打包。
 */
import type { AppDeps } from './app';
import { createApp } from './app';
import type { Env } from './env';
import type { Db } from './repositories/db';
import type { BootstrapRepositories, ResolvedPorts } from './bootstrap';
import type { PlatformProfile } from './runtime/platform';
import { logger } from './lib/logger';
import { LogicalBackupRepository } from './repositories/logical-backup.repository';
import { LogicalBackupService } from './services/logical-backup.service';
import { RestoreService } from './services/restore.service';
import { AuthService } from './services/auth.service';
import { AdminAuthService } from './services/admin-auth.service';
import { AdminService } from './services/admin.service';
import { BackupService } from './services/backup.service';
import { BackupScheduler } from './services/backup-scheduler';
import { DashboardService } from './services/dashboard.service';
import { ExcelService } from './services/excel.service';
import { HealthService } from './services/health.service';
import { RecordService } from './services/record.service';
import { heavyTaskGate } from './services/heavy-task';

export interface AssemblyInput {
  readonly db: Db;
  readonly env: Env;
  readonly repositories: BootstrapRepositories;
  readonly ports: ResolvedPorts;
  readonly platform: PlatformProfile;
}

/** 装配结果：应用实例 + 生命周期钩子。 */
export interface AssembledRuntime {
  readonly app: import('hono').Hono<import('./types/hono').AppEnv>;
  readonly deps: AppDeps;
  /** 启动后台任务（Node：每日定时备份；Workers：无，交给 Cron Trigger）。 */
  start(): void;
  /** 停止后台任务（优雅停机）。 */
  stop(): void;
  /** 执行一次"每日备份"动作；Worker 的 `scheduled` 处理器调用它。 */
  runScheduledBackup(): Promise<void>;
  /** 推进一次后台逻辑备份分块；Node 定时器 / Workers alarm 调用。 */
  runBackgroundTick(): Promise<boolean>;
  /**
   * Workers alarm 触发专用入口。与 `runBackgroundTick` 的区别：先清空 alarm
   * 调度器的合并守卫，再推进 tick，保证多 chunk 备份能持续续调度。
   */
  runAlarmTick(): Promise<void>;
}

/** 构造应用与后台任务。 */
export function assemble(input: AssemblyInput): AssembledRuntime {
  const { db, env, repositories, ports, platform } = input;
  const gate = heavyTaskGate;

  const health = new HealthService();
  const backup = new BackupService({
    db,
    env,
    meta: repositories.meta,
    logs: repositories.logs,
    gate,
    settings: repositories.settings,
    port: ports.backup,
  });
  const logicalBackup = new LogicalBackupService({
    db,
    env,
    repo: new LogicalBackupRepository(db),
    settings: repositories.settings,
    meta: repositories.meta,
    logs: repositories.logs,
    scheduler: ports.backgroundScheduler,
    physicalBackup: backup,
  });
  const restore = new RestoreService({
    db,
    env,
    staging: ports.restoreStaging,
    meta: repositories.meta,
    logs: repositories.logs,
    physicalBackup: backup,
  });
  // 调度器的 tick 回调在 Service 构造好后注入（bootstrap 阶段 Service 还不存在）。
  ports.backgroundScheduler.setTick(() => logicalBackup.tick());

  const auth = new AuthService({
    db,
    env,
    credentials: repositories.credentials,
    sessions: repositories.sessions,
    meta: repositories.meta,
    settings: repositories.settings,
    logs: repositories.logs,
    backup: ports.backup,
  });
  const adminAuth = new AdminAuthService({
    env,
    accounts: repositories.adminAccounts,
    sessions: repositories.adminSessions,
    logs: repositories.logs,
  });
  const admin = new AdminService({
    db,
    env,
    runtimeTarget: platform.target,
    credentials: repositories.credentials,
    sessions: repositories.sessions,
    adminSessions: repositories.adminSessions,
    adminAccounts: repositories.adminAccounts,
    meta: repositories.meta,
    logs: repositories.logs,
    backup,
  });
  const records = new RecordService({
    db,
    records: repositories.records,
    logs: repositories.logs,
    settings: repositories.settings,
  });
  const dashboard = new DashboardService({
    db,
    records: repositories.records,
    settings: repositories.settings,
  });
  const excel = new ExcelService({
    db,
    env,
    records: repositories.records,
    logs: repositories.logs,
    settings: repositories.settings,
    gate,
    backup,
    readWorkbook: ports.workbookReader,
    excelWrite: platform.excelWrite,
  });

  const deps: AppDeps = {
    db,
    env,
    repositories,
    auth,
    adminAuth,
    admin,
    records,
    dashboard,
    excel,
    backup,
    logicalBackup,
    restore,
    health,
    gate,
    staticPort: ports.staticPort,
  };
  const app = createApp(deps);

  // 定时动作统一入口：物理快照（Node 文件 / Workers PITR）与加密逻辑备份
  // 各自按间隔判断。Node interval 与 Workers cron 都走这里，避免两套分支漂移。
  const runScheduledBackup = async (): Promise<void> => {
    // 物理快照按管理员配置的间隔触发，而非每次定时都做（此前该设置是死配置）。
    // 到期判定收口在 BackupService.isPhysicalDue()，与逻辑备份后的兜底快照共用，
    // 避免兜底刷新时间让间隔失效（遗留 A）；PITR 模式恒不到期，跳过每日空触发（遗留 E）。
    if (backup.isPhysicalDue()) {
      const physical = await backup.trigger('scheduled-daily');
      if (!physical.ok) {
        logger.warn({ code: physical.code }, '[backup-scheduler] 本次定时物理备份跳过');
      }
    }
    try {
      await logicalBackup.triggerScheduled();
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        '[backup-scheduler] 定时逻辑备份入队失败',
      );
    }
  };

  // 定时备份：`interval` 由进程内定时器驱动（Node），`cron` 由平台调度器驱动
  // （Workers 的 Cron Trigger 打 `scheduled()`，最终调用 runScheduledBackup）。
  const scheduler: BackupScheduler | null =
    input.platform.scheduler === 'interval' ? new BackupScheduler(runScheduledBackup) : null;

  const runBackgroundTick = async (): Promise<boolean> => logicalBackup.tick();

  // Workers alarm 必须走调度器的 onAlarm()：它会清空「只保留更早 alarm」的
  // 合并守卫标记，tick 内再次 schedule() 才能续上下一次 alarm。若直接调 tick()
  // （旧实现），守卫会吞掉续调度，多 chunk 备份推进一次即永久停滞。
  const runAlarmTick = async (): Promise<void> => {
    const alarm = ports.backgroundScheduler.onAlarm;
    if (alarm !== undefined) {
      await alarm.call(ports.backgroundScheduler);
      return;
    }
    // Node 定时器没有合并守卫，回落到直接推进（防御性分支）。
    await logicalBackup.tick();
  };

  return {
    app,
    deps,
    start(): void {
      health.markReady();
      scheduler?.start();
    },
    stop(): void {
      health.markNotReady();
      scheduler?.stop();
      ports.backgroundScheduler.stop?.();
    },
    runScheduledBackup,
    runBackgroundTick,
    runAlarmTick,
  };
}
