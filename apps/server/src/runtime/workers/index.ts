/**
 * Workers 运行时装配：一套端口实现，与 Node 侧共享全部业务代码。
 *
 * 这是 Workers 侧唯一的"平台知识集合"。想知道 Workers 上某项能力由谁提供，
 * 只看本文件即可（任务卡 01 验收第 4 条：所有差异在 `runtime/` 一处可查）。
 */
import type { Env } from '../../env';
import type { Db } from '../../repositories/db';
import type { RuntimeBundle } from '../ports';
import { resolvePlatform } from '../platform';
import { openDoDatabase } from './db.factory';
import { createTableVersionStore } from './version-store.table';
import { createInlineMigrationSource } from './migration-source.inline';
import { createPitrBackupPort } from './backup.pitr';
import { createAssetsStaticPort, type AssetsBinding } from './static.assets';
import { createMemoryWorkbookReader } from './workbook.memory';
import { createAlarmScheduler } from './scheduler.alarm';
import { createKvRestoreStaging } from './restore-staging.kv';
import { stringVars } from './env';
import type { DoStorageLike } from '../../repositories/adapters/do-sqlite.adapter';

export interface WorkersRuntimeInput {
  /** DO 的 `ctx.storage`。 */
  readonly storage: DoStorageLike;
  /** `[assets]` 绑定。 */
  readonly assets: AssetsBinding;
  /** 平台 `env` 对象（含 `[vars]` 与绑定）。 */
  readonly vars: Record<string, unknown>;
  /**
   * DO 关键区串行化，直接接 `ctx.blockConcurrencyWhile`。
   * 目前只用于恢复批次的一次性消费（`get → put` 不能被并发请求插入）。
   */
  readonly runExclusive?: <T>(fn: () => Promise<T>) => Promise<T>;
}

/**
 * 构造 Workers 端口集合。
 *
 * @param input DO 存储、assets 绑定与平台变量
 */
export function workersRuntime(input: WorkersRuntimeInput): RuntimeBundle {
  const platform = resolvePlatform(stringVars(input.vars));
  return {
    platform,

    openDb(_env: Env): Db {
      return openDoDatabase(input.storage);
    },

    versionStore() {
      return createTableVersionStore();
    },

    migrations() {
      return createInlineMigrationSource();
    },

    backup(env: Env) {
      return createPitrBackupPort({ keepCount: env.backupKeepCount });
    },

    staticPort() {
      return createAssetsStaticPort(input.assets);
    },

    workbookReader() {
      return createMemoryWorkbookReader();
    },

    backgroundScheduler() {
      return createAlarmScheduler({ storage: input.storage });
    },

    restoreStaging() {
      return createKvRestoreStaging({ storage: input.storage, runExclusive: input.runExclusive });
    },
  };
}

export type { AssetsBinding };
export type { DoStorageLike };
