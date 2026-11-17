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
import { AuthService } from './services/auth.service';
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
    port: ports.backup,
  });
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
    records,
    dashboard,
    excel,
    backup,
    health,
    gate,
    staticPort: ports.staticPort,
  };
  const app = createApp(deps);

  // 定时备份：`interval` 由进程内定时器驱动（Node），`cron` 由平台调度器驱动
  // （Workers 的 Cron Trigger 打 `scheduled()`，最终调用 runScheduledBackup）。
  const scheduler: BackupScheduler | null =
    input.platform.scheduler === 'interval' ? new BackupScheduler(backup) : null;

  const runScheduledBackup = async (): Promise<void> => {
    const result = await backup.trigger('scheduled-daily');
    if (!result.ok) {
      logger.warn({ code: result.code }, '[backup-scheduler] 本次定时备份跳过');
    }
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
    },
    runScheduledBackup,
  };
}
