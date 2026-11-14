/**
 * 进程入口：启动自检 → 迁移 → 首启凭据 → 监听 → 优雅停机。
 *
 * 依据：设计文档 v1.1 §3.6 / §7.4 / §7.5 ——
 * `bootstrap()` 内含 `assertNodeVersion()`（精确 26.13.0）、integrity_check、
 * user_version、卷可写与磁盘余量自检；监听前完成首启 `[BOOTSTRAP]` 打印；
 * SIGINT/SIGTERM 停调度器、`server.close()`、checkpoint + closeDatabase。
 * 本文件重写 T01 的最小 serve + health。
 */
import { serve } from '@hono/node-server';
import { bootstrap } from './bootstrap';
import { createApp, type AppDeps } from './app';
import { logger } from './lib/logger';
import { closeDatabase } from './repositories/db';
import { HealthService } from './services/health.service';
import { heavyTaskGate } from './services/heavy-task';
import { AuthService } from './services/auth.service';
import { RecordService } from './services/record.service';
import { DashboardService } from './services/dashboard.service';
import { BackupService } from './services/backup.service';
import { ExcelService } from './services/excel.service';
import { BackupScheduler } from './services/backup-scheduler';

/** 启动 HTTP 服务；任何失败写 fatal 日志并非零退出。 */
async function main(): Promise<void> {
  // bootstrap() 内部第一步即 assertNodeVersion()，无需在此重复。
  const boot = await bootstrap();
  const { db, env, repositories } = boot;
  const gate = heavyTaskGate;

  const health = new HealthService();
  const backup = new BackupService({
    db,
    env,
    meta: repositories.meta,
    logs: repositories.logs,
    gate,
  });
  const auth = new AuthService({
    db,
    env,
    credentials: repositories.credentials,
    sessions: repositories.sessions,
    meta: repositories.meta,
    logs: repositories.logs,
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
  };
  const app = createApp(deps);
  const scheduler = new BackupScheduler(backup);

  health.markReady();
  const server = serve({ fetch: app.fetch, port: env.port });
  scheduler.start();
  logger.info(
    { port: env.port, publicOrigins: env.publicOrigins, userVersion: boot.migration.toVersion },
    '[stockin] server listening',
  );

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    health.markNotReady();
    scheduler.stop();
    server.close(() => {
      closeDatabase(db);
      logger.info('[stockin] 优雅停机完成');
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main().catch((error: unknown) => {
  logger.fatal(
    { err: error instanceof Error ? error.message : String(error) },
    '[stockin] 启动失败',
  );
  process.exitCode = 1;
});
