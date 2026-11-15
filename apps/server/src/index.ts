/**
 * Node 组合根：启动自检 → 装配 → 迁移 → 首启凭据 → 监听 → 优雅停机。
 *
 * 依据：设计文档 v1.1 §3.6 / §7.4 / §7.5 ——
 * 启动自检（Node 版本断言 / 卷可写 / 磁盘余量 / integrity_check / 版本等值）
 * 失败 fail-fast 并写 `.selfcheck_failed` sentinel；监听前完成首启
 * `[BOOTSTRAP]` 打印；SIGINT/SIGTERM 停调度器、`server.close()`、
 * checkpoint + closeDatabase。
 *
 * 2026-11-15 双运行时改造后，本文件只负责 **Node 特有**的部分：
 * 套用 `nodeRuntime()` 端口集合、用 `@hono/node-server` 监听、处理信号。
 * 服务接线已移入 `assembly.ts`，与 Worker 组合根共用同一份。
 */
import path from 'node:path';
import { serve } from '@hono/node-server';
import { bootstrap, writeSelfcheckFailed } from './bootstrap';
import { assemble } from './assembly';
import { logger } from './lib/logger';
import { loadEnv } from './env';
import { closeDatabase } from './repositories/db';
import { assertStaticRootSafe } from './static';
import { nodeRuntime, resolveStaticRoot } from './runtime/node';

/** 启动 HTTP 服务；任何失败写 fatal 日志、落 sentinel 并非零退出。 */
async function main(): Promise<void> {
  // 平台判定先于一切：它决定后面用哪套端口。
  const bundle = nodeRuntime();
  // bootstrap 内部第一步即 assertNodeVersion()（Node 预设下 nodeVersionAssert=strict）。
  const boot = await bootstrap({ bundle });
  const { db, env, repositories, ports } = boot;

  // 静态根安全守卫：三卷绝不能落进静态托管根（loadEnv 与静态层双守卫，
  // 后者在此显式执行 —— 静态根的最终值由 runtime/node 解析，env 层看不到）。
  assertStaticRootSafe(env, resolveStaticRoot(env));

  const runtime = assemble({
    db,
    env,
    repositories,
    ports,
    platform: bundle.platform,
  });

  runtime.start();
  const server = serve({ fetch: runtime.app.fetch, port: env.port });
  logger.info(
    {
      runtime: bundle.platform.target,
      port: env.port,
      publicOrigins: env.publicOrigins,
      userVersion: boot.migration.toVersion,
    },
    '[stockin] server listening',
  );

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    runtime.stop();
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
  // sentinel 落在 data 卷；env 可能还没解析成功，故先按 cwd 兜底再尝试 loadEnv。
  let dataDir: string = path.resolve(process.cwd(), 'data');
  try {
    dataDir = loadEnv().dataDir;
  } catch {
    // 环境非法时仍写 cwd/data，保证"失败可见"。
  }
  writeSelfcheckFailed(dataDir, error);
  logger.fatal(
    { err: error instanceof Error ? error.message : String(error) },
    '[stockin] 启动失败，已写 .selfcheck_failed',
  );
  process.exitCode = 1;
});
