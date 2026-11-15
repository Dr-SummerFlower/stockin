/**
 * 忘记凭证的本机 CLI：`node dist/cli/reset-credentials.js`。
 *
 * 依据：设计文档 v1.1 §7.4 —— 重置前快照 → 生成新正式密码打印 →
 * `auth_epoch` 递增吊销全部会话 → `init_state` 保持 1、引导页仍不可重入；
 * 无 HTTP 改密端点、无修改密码页。
 *
 * 凭据更新 + auth_epoch + 吊销全部会话 + 操作日志四者在同一个
 * `BEGIN IMMEDIATE` 事务内完成（文档 §4.5 事务口径）。
 */
import { Action, TARGET_TYPE } from '@stockin/shared';
import { assertNodeVersion, BOOTSTRAP_USERNAME } from '../bootstrap';
import { loadEnv, type Env, type EnvOverrides } from '../env';
import { logger } from '../lib/logger';
import {
  derivePasswordHash,
  generateReadablePassword,
  generateSaltHex,
  serializeScryptParams,
} from '../lib/crypto';
import { configureServerTimeZone, utcNowIso } from '../lib/today';
import { createBackup, type BackupResult } from '../repositories/backup';
import {
  assertIntegrity,
  closeDatabase,
  immediateTransaction,
  openDatabase,
} from '../repositories/db';
import { CredentialRepository } from '../repositories/credential.repository';
import { MetaRepository } from '../repositories/meta.repository';
import { OperationLogRepository } from '../repositories/operation-log.repository';
import { SessionRepository } from '../repositories/session.repository';

export interface ResetCredentialsOptions {
  readonly overrides?: EnvOverrides;
  readonly suppressPasswordPrint?: boolean;
}

export interface ResetCredentialsResult {
  readonly username: string;
  readonly password: string;
  readonly initState: 0 | 1;
  readonly authEpoch: number;
  readonly backup: BackupResult;
}

/**
 * 执行重置。前置快照失败仅告警不阻断；事务内任一步失败整体回滚。
 */
export async function resetCredentials(
  options: ResetCredentialsOptions = {},
): Promise<ResetCredentialsResult> {
  assertNodeVersion();
  const env: Env = loadEnv(options.overrides);
  configureServerTimeZone(env.tz);

  const db = openDatabase({ filename: env.dbFile, fileMustExist: true });
  try {
    assertIntegrity(db);
    const credentials = new CredentialRepository(db);
    if (credentials.find() === null) {
      throw new Error('[reset-credentials] credentials 单行缺失，请先正常启动一次生成初始凭据');
    }
    const meta = new MetaRepository(db);
    const initStateBefore: 0 | 1 = meta.initState();

    // 重置前快照（文档 §4.5 五个触发点之一）。
    const backup: BackupResult = await createBackup(db, {
      backupDir: env.backupDir,
      reason: 'pre-reset-credentials',
      initState: initStateBefore,
      minFreeBytes: env.minFreeBytes,
      keepCount: env.backupKeepCount,
    });
    if (backup.status === 'ok') {
      meta.setLastBackup(backup.meta.createdAt, 'ok');
    } else {
      meta.setLastBackup(utcNowIso(), 'skipped');
    }

    const password: string = generateReadablePassword();
    const salt: string = generateSaltHex();
    const hash: string = derivePasswordHash(password, salt);
    const now: string = utcNowIso();

    const authEpoch: number = immediateTransaction(db, () => {
      credentials.updateCredentials(
        BOOTSTRAP_USERNAME,
        hash,
        salt,
        serializeScryptParams(),
        0,
        now,
      );
      const epoch: number = meta.increment('auth_epoch');
      new SessionRepository(db).revokeAll('credentials-reset', now, epoch);
      new OperationLogRepository(db).append({
        action: Action.CREDENTIALS_RESET,
        targetType: TARGET_TYPE.CREDENTIAL,
        targetId: null,
        detail: { event: 'credentials-reset', username: BOOTSTRAP_USERNAME, authEpoch: epoch },
        requestId: 'cli:reset-credentials',
        actor: 'cli',
        occurredAt: now,
      });
      return epoch;
    });

    const initStateAfter: 0 | 1 = meta.initState();
    if (initStateAfter !== initStateBefore) {
      throw new Error('[reset-credentials] init_state 被意外改动，事务应已回滚');
    }

    if (options.suppressPasswordPrint !== true) {
      process.stdout.write(
        `[RESET-CREDENTIALS] username=${BOOTSTRAP_USERNAME} password=${password}\n`,
      );
    }
    return { username: BOOTSTRAP_USERNAME, password, initState: initStateAfter, authEpoch, backup };
  } finally {
    closeDatabase(db);
  }
}

/** CLI 入口；失败时非零退出。 */
export async function main(): Promise<void> {
  try {
    const result: ResetCredentialsResult = await resetCredentials();
    logger.info(
      { initState: result.initState, authEpoch: result.authEpoch },
      '[reset-credentials] 完成，请用新账密重新登录',
    );
  } catch (error) {
    const message: string = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[RESET-CREDENTIALS] 失败: ${message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
