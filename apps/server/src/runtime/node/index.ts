/**
 * Node 运行时装配：一套端口实现，全部行为与改造前一致。
 *
 * 这是 Node 侧唯一的"平台知识集合" —— 想知道 Node 上某项能力由谁提供，
 * 只看本文件即可。
 */
import type { Env } from '../../env';
import type { Db } from '../../repositories/db';
import type { RuntimeBundle } from '../ports';
import { resolvePlatform } from '../platform';
import { openDatabase } from './db.factory';
import { createPragmaVersionStore } from './version-store.pragma';
import { createFilesystemMigrationSource } from './migration-source.filesystem';
import { createFilesystemBackupPort } from './backup.filesystem';
import { createFilesystemStaticPort, defaultStaticRoot } from './static.filesystem';
import { createTempfileWorkbookReader } from './workbook.tempfile';
import { createNodeScheduler } from './scheduler.interval';
import { createFilesystemRestoreStaging } from './restore-staging.filesystem';

/** 静态根优先级 = `WEB_DIST_DIR`（env.staticRoot）> 从产物反推的 apps/web/dist。 */
function resolveStaticRoot(env: Env): string {
  return env.staticRoot ?? defaultStaticRoot();
}

/**
 * 构造 Node 端口集合。
 *
 * @param envSource 环境变量来源，缺省 `process.env`
 */
export function nodeRuntime(
  envSource: Record<string, string | undefined> = process.env,
): RuntimeBundle {
  const platform = resolvePlatform(envSource);
  return {
    platform,

    openDb(env: Env): Db {
      return openDatabase({ filename: env.dbFile });
    },

    versionStore(env: Env) {
      return createPragmaVersionStore({ dataDir: env.dataDir });
    },

    migrations() {
      return createFilesystemMigrationSource();
    },

    backup(env: Env) {
      return createFilesystemBackupPort({
        backupDir: env.backupDir,
        minFreeBytes: env.minFreeBytes,
        keepCount: env.backupKeepCount,
      });
    },

    staticPort(env: Env) {
      return Promise.resolve(createFilesystemStaticPort(resolveStaticRoot(env)));
    },

    workbookReader(env: Env) {
      return createTempfileWorkbookReader({ tmpDir: env.tmpDir });
    },

    backgroundScheduler(_env: Env) {
      return createNodeScheduler();
    },

    restoreStaging(env: Env) {
      return createFilesystemRestoreStaging({ tmpDir: env.tmpDir });
    },
  };
}

export { resolveStaticRoot };
