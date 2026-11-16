/**
 * 认证与首次引导服务。
 *
 * 依据：设计文档 v1.1 §2.1 / §3.5 / §5.2 / §7.4 ——
 * 首启 `admin` + 随机初始密码由 bootstrap 打印 `[BOOTSTRAP]`（本服务不重生成）；
 * `setup` 状态机 0→1 CAS + `auth_epoch` 递增吊销全部会话 + **完成引导不签新会话**
 * + 重复 setup 409 + 卷保留不重生成/不重打印；
 * **setup 四者（凭据 + 状态位 + 吊销全部会话 + 日志）同一事务**；
 * setup 完成后生成 baseline 基线快照。
 */
import { randomUUID } from 'node:crypto';
import {
  Action,
  ErrorCode,
  SESSION_ABSOLUTE_DAYS,
  SESSION_IDLE_DAYS,
  TARGET_TYPE,
  type AuthMeResponse,
  type InitStatusResponse,
  type LoginInput,
  type LogoutResponse,
  type SetupInput,
} from '@stockin/shared';
import type { SessionIdentity, SessionRepository } from '../repositories/session.repository';
import type { CredentialRepository } from '../repositories/credential.repository';
import type { MetaRepository } from '../repositories/meta.repository';
import type { OperationLogRepository } from '../repositories/operation-log.repository';
import type { Db } from '../repositories/db';
import { immediateTransaction } from '../repositories/db';
import type { BackupPort } from '../runtime/ports';
import type { Env } from '../env';
import {
  derivePasswordHash,
  generateSaltHex,
  generateSessionToken,
  hashSessionToken,
  serializeScryptParams,
  verifyPasswordHash,
} from '../lib/crypto';
import { utcAfterDaysIso, utcNowIso } from '../lib/today';
import { recordLoginFailure, clearLoginFailures } from '../middleware/rate-limit';
import type { ServiceResult } from '../app';

export interface AuthContext {
  readonly requestId: string;
  readonly clientIp: string;
}

export interface AuthServiceDeps {
  readonly db: Db;
  readonly env: Env;
  readonly credentials: CredentialRepository;
  readonly sessions: SessionRepository;
  readonly meta: MetaRepository;
  readonly logs: OperationLogRepository;
  /** 引导完成后的基线快照端口（Node 落快照池，Workers 走 PITR 并明确跳过）。 */
  readonly backup: BackupPort;
}

export interface LoginResult {
  readonly token: string;
  readonly initState: 0 | 1;
}

/**
 * 凭据比对：**用户名与密码同时校验**。
 *
 * 此前只看密码，任何用户名配正确密码都能登录；而 `operation_logs.actor`
 * 记录的是请求里提交的用户名 —— 等于让攻击者自定义审计署名。
 *
 * 两项都算完再取与、不做短路：scrypt 是耗时主体，短路会让「用户名错」
 * 比「密码错」快一个数量级，反而泄漏账号是否存在。
 */
export function credentialsMatch(
  row: { readonly username: string; readonly password_hash: string; readonly salt: string },
  input: { readonly username: string; readonly password: string },
): boolean {
  const usernameMatches: boolean = row.username === input.username;
  const passwordMatches: boolean = verifyPasswordHash(input.password, row.password_hash, row.salt);
  return usernameMatches && passwordMatches;
}

/** 认证服务（单进程单例）。 */
export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  /** GET /api/auth/init-status：只信 meta.setup_completed。 */
  initStatus(): ServiceResult<InitStatusResponse> {
    return {
      ok: true,
      data: {
        initialized: this.deps.meta.setupCompleted(),
        initState: this.deps.meta.initState(),
        username: this.deps.credentials.find()?.username ?? null,
      },
    };
  }

  /** GET /api/auth/me：允许匿名，返回 authenticated:false。 */
  me(session: SessionIdentity | null): ServiceResult<AuthMeResponse> {
    const username: string | null = this.deps.credentials.find()?.username ?? null;
    return {
      ok: true,
      data: {
        authenticated: session !== null,
        user: session === null ? null : { id: session.accountId, username: username ?? 'admin' },
        initState: this.deps.meta.initState(),
      },
    };
  }

  /**
   * POST /api/auth/login：统一失败文案；成功后轮换 sid（吊销旧会话）并签新会话。
   */
  login(
    input: LoginInput,
    previousToken: string | null,
    ctx: AuthContext,
  ): ServiceResult<LoginResult> {
    const row = this.deps.credentials.find();
    const valid: boolean = row !== null && credentialsMatch(row, input);

    if (!valid) {
      recordLoginFailure(ctx.clientIp, input.username);
      const nowUtc: string = utcNowIso();
      this.deps.logs.appendFailure(
        Action.LOGIN_FAILED,
        ErrorCode.AUTH_INVALID_CREDENTIALS,
        ctx.requestId,
        input.username,
        nowUtc,
      );
      return { ok: false, code: ErrorCode.AUTH_INVALID_CREDENTIALS };
    }
    clearLoginFailures(ctx.clientIp, input.username);

    const token: string = generateSessionToken();
    const nowUtc: string = utcNowIso();
    const epoch: number = this.deps.meta.authEpoch();
    const oldSessionId: string | null =
      previousToken === null
        ? null
        : (this.deps.sessions.findByTokenHash(hashSessionToken(previousToken))?.id ?? null);

    immediateTransaction(this.deps.db, () => {
      if (oldSessionId !== null) {
        this.deps.sessions.revoke(oldSessionId, 'login-rotate', nowUtc);
      }
      this.deps.sessions.create({
        id: randomUUID(),
        tokenHash: hashSessionToken(token),
        accountId: 1,
        idleExpiresAt: utcAfterDaysIso(SESSION_IDLE_DAYS),
        absoluteExpiresAt: utcAfterDaysIso(SESSION_ABSOLUTE_DAYS),
        authEpoch: epoch,
        createdAt: nowUtc,
      });
      this.deps.logs.append({
        action: Action.LOGIN,
        targetType: TARGET_TYPE.SESSION,
        targetId: null,
        detail: { username: input.username },
        requestId: ctx.requestId,
        actor: input.username,
        occurredAt: nowUtc,
      });
    });

    return { ok: true, data: { token, initState: this.deps.meta.initState() } };
  }

  /** POST /api/auth/logout：幂等，吊销当前会话并写日志。 */
  logout(token: string | null, ctx: AuthContext): ServiceResult<LogoutResponse> {
    const row = token === null ? null : this.deps.sessions.findByTokenHash(hashSessionToken(token));
    if (row !== null) {
      const nowUtc: string = utcNowIso();
      immediateTransaction(this.deps.db, () => {
        this.deps.sessions.revoke(row.id, 'logout', nowUtc);
        this.deps.logs.append({
          action: Action.LOGOUT,
          targetType: TARGET_TYPE.SESSION,
          targetId: null,
          requestId: ctx.requestId,
          actor: 'user',
          occurredAt: nowUtc,
        });
      });
    }
    return { ok: true, data: { ok: true } };
  }

  /**
   * POST /api/auth/setup：四者同事务的 0→1 状态机。
   * 完成后不签新会话，并生成 baseline 基线快照。
   */
  async setup(input: SetupInput, ctx: AuthContext): Promise<ServiceResult<{ initState: 1 }>> {
    if (this.deps.meta.setupCompleted()) {
      return { ok: false, code: ErrorCode.AUTH_INIT_COMPLETED };
    }
    const credential = this.deps.credentials.find();
    if (credential === null) {
      return { ok: false, code: ErrorCode.COMMON_INTERNAL };
    }
    if (!verifyPasswordHash(input.currentPassword, credential.password_hash, credential.salt)) {
      return { ok: false, code: ErrorCode.AUTH_INVALID_CREDENTIALS };
    }

    const salt: string = generateSaltHex();
    const hash: string = derivePasswordHash(input.password, salt);
    const nowUtc: string = utcNowIso();

    const committed: boolean = immediateTransaction(this.deps.db, () => {
      // CAS 0→1：并发重复 setup 只有一个能改成功。
      if (!this.deps.meta.markSetupCompleted()) {
        return false;
      }
      this.deps.credentials.updateCredentials(
        input.username,
        hash,
        salt,
        serializeScryptParams(),
        0,
        nowUtc,
      );
      this.deps.credentials.clearInitialFlag(nowUtc);
      const epoch: number = this.deps.meta.increment('auth_epoch');
      this.deps.sessions.revokeAll('setup-complete', nowUtc, epoch);
      this.deps.logs.append({
        action: Action.SETUP_COMPLETE,
        targetType: TARGET_TYPE.CREDENTIAL,
        targetId: null,
        detail: { username: input.username },
        requestId: ctx.requestId,
        actor: input.username,
        occurredAt: nowUtc,
      });
      return true;
    });

    if (!committed) {
      return { ok: false, code: ErrorCode.AUTH_INIT_COMPLETED };
    }

    // baseline 基线快照：避免「恢复后要求引导但初始密码已清」死锁。
    // Workers 上端口走 PITR，`create()` 返回 skipped，此时不写 baseline 文件名。
    const baseline = await this.deps.backup.create(this.deps.db, {
      reason: 'post-setup-baseline',
      initState: 1,
      baseline: true,
      minFreeBytes: this.deps.env.minFreeBytes,
      keepCount: this.deps.backup.keepCount,
    });
    if (baseline.status === 'ok') {
      this.deps.meta.setBaseline(baseline.meta.file);
    }
    return { ok: true, data: { initState: 1 } };
  }
}
