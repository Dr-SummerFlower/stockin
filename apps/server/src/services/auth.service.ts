/**
 * 认证、首次引导与账号安全服务。
 *
 * 依据：设计文档 v1.1 §2.1 / §3.5 / §5.2 / §7.4 ——
 * **首启不再生成随机初始密码**：首次访问走自助引导 `/setup`，一次性设置
 * 正式账密、密保问题与店铺配置；`setup` 状态机 0→1 CAS + `auth_epoch` 递增
 * 吊销全部会话 + **完成引导不签新会话** + 重复 setup 409；
 * **setup 各写入（凭据 + 密保 + 设置 + 状态位 + 吊销会话 + 日志）同一事务**；
 * setup 完成后生成 baseline 基线快照。
 *
 * 账号安全：
 * - 改密：校验当前密码 → 换 salt/hash → `auth_epoch` 递增 → 全量吊销（含当前），
 *   前端收到成功即跳登录；
 * - 忘记密码：用户名 + 密保答案 + 新密码一步式重置；用户名不存在 / 未设密保 /
 *   答案错误统一错误码与文案，且都跑一次等耗时 scrypt，消除时序侧信道；
 * - 密保答案归一化后加盐哈希存储，绝不落明文。
 */
import { randomUUID } from 'node:crypto';
import {
  Action,
  ErrorCode,
  PRESET_SECURITY_QUESTIONS,
  SESSION_ABSOLUTE_DAYS,
  SESSION_IDLE_DAYS,
  TARGET_TYPE,
  normalizeSecurityAnswer,
  type AuthMeResponse,
  type ChangePasswordInput,
  type ForgotPasswordInput,
  type InitStatusResponse,
  type LoginInput,
  type LogoutResponse,
  type SecurityQuestionResponse,
  type SetupInput,
  type SimpleOkResponse,
  type UpdateSecurityInput,
} from '@stockin/shared';
import type { SessionIdentity, SessionRepository } from '../repositories/session.repository';
import type { CredentialRepository } from '../repositories/credential.repository';
import type { MetaRepository } from '../repositories/meta.repository';
import type { OperationLogRepository } from '../repositories/operation-log.repository';
import type { SettingsRepository } from '../repositories/settings.repository';
import type { CredentialRow } from '../repositories/types';
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
import {
  clearLoginFailures,
  clearSecurityFailures,
  recordLoginFailure,
  recordSecurityFailure,
  securityBlockState,
} from '../middleware/rate-limit';
import type { ServiceResult } from '../app';

export interface AuthContext {
  readonly requestId: string;
  readonly clientIp: string;
  /** 已登录操作的审计署名；未知时回落 'user'。 */
  readonly actor?: string;
}

export interface AuthServiceDeps {
  readonly db: Db;
  readonly env: Env;
  readonly credentials: CredentialRepository;
  readonly sessions: SessionRepository;
  readonly meta: MetaRepository;
  readonly settings: SettingsRepository;
  readonly logs: OperationLogRepository;
  /** 引导完成后的基线快照端口（Node 落快照池，Workers 走 PITR 并明确跳过）。 */
  readonly backup: BackupPort;
}

export interface LoginResult {
  readonly token: string;
  readonly initState: 0 | 1;
}

/**
 * 未知用户名的密保比对用假盐 / 假哈希。
 *
 * 长度按真实取值构造（salt 16B → 32 hex，keylen 64B → 128 hex），
 * 让 `verifyPasswordHash` 走完整的 scrypt 派生 + 定长比较，耗时与真实比对同阶。
 * 假哈希全零，正常答案不可能撞上；外层另有 `matched` 与用户名共同取与。
 */
const DUMMY_SECURITY_SALT: string = '0'.repeat(32);
const DUMMY_SECURITY_HASH: string = '0'.repeat(128);

/** 查不到账号时回显的掩护问题，避免通过回显探测用户名是否存在。 */
function decoyQuestion(): string {
  return PRESET_SECURITY_QUESTIONS[0] ?? '请回答密保问题';
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
   * 未完成初始化时凭据行不存在，必然登录失败——前端据 initState=0 直接引导 /setup。
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
   * POST /api/auth/setup：自助引导初始化。
   *
   * 不再校验「初始密码」（首启已不生成），直接把用户设定的账密、密保与
   * 店铺配置写入；CAS 0→1 保证并发重复 setup 只有一个成功。
   * 完成后不签新会话，并生成 baseline 基线快照。
   */
  async setup(input: SetupInput, ctx: AuthContext): Promise<ServiceResult<{ initState: 1 }>> {
    if (this.deps.meta.setupCompleted()) {
      return { ok: false, code: ErrorCode.AUTH_INIT_COMPLETED };
    }

    const username: string = input.username.trim();
    const question: string = input.securityQuestion.trim();
    const answer: string = normalizeSecurityAnswer(input.securityAnswer);
    if (username === '' || question === '' || answer === '') {
      return { ok: false, code: ErrorCode.VALID_FAILED };
    }

    const salt: string = generateSaltHex();
    const hash: string = derivePasswordHash(input.password, salt);
    const answerSalt: string = generateSaltHex();
    const answerHash: string = derivePasswordHash(answer, answerSalt);
    const nowUtc: string = utcNowIso();

    const committed: boolean = immediateTransaction(this.deps.db, () => {
      // CAS 0→1：并发重复 setup 只有一个能改成功。
      if (!this.deps.meta.markSetupCompleted()) {
        return false;
      }
      this.deps.credentials.saveCredentials({
        username,
        passwordHash: hash,
        salt,
        scryptParams: serializeScryptParams(),
        isInitial: 0,
        securityQuestion: question,
        securityAnswerSalt: answerSalt,
        securityAnswerHash: answerHash,
        createdAt: nowUtc,
        updatedAt: nowUtc,
      });
      this.deps.settings.setShopName(input.shopName);
      this.deps.settings.setThresholdDays(input.expiryThresholdDays);
      const epoch: number = this.deps.meta.increment('auth_epoch');
      this.deps.sessions.revokeAll('setup-complete', nowUtc, epoch);
      this.deps.logs.append({
        action: Action.SETUP_COMPLETE,
        targetType: TARGET_TYPE.CREDENTIAL,
        targetId: null,
        detail: {
          username,
          shopName: input.shopName,
          expiryThresholdDays: input.expiryThresholdDays,
        },
        requestId: ctx.requestId,
        actor: username,
        occurredAt: nowUtc,
      });
      return true;
    });

    if (!committed) {
      return { ok: false, code: ErrorCode.AUTH_INIT_COMPLETED };
    }

    // baseline 基线快照：避免「恢复后要求引导但正式凭据已存在」死锁。
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

  /**
   * POST /api/auth/change-password：登录态改密。
   *
   * 校验当前密码 → 换 salt/hash → `auth_epoch` 递增 → 吊销全部会话（**含当前**）。
   * 调用方在成功响应后清 Cookie，前端跳登录页重新登录。
   */
  changePassword(input: ChangePasswordInput, ctx: AuthContext): ServiceResult<SimpleOkResponse> {
    const row: CredentialRow | null = this.deps.credentials.find();
    if (row === null) {
      return { ok: false, code: ErrorCode.COMMON_INTERNAL };
    }
    if (!verifyPasswordHash(input.currentPassword, row.password_hash, row.salt)) {
      return { ok: false, code: ErrorCode.AUTH_INVALID_CREDENTIALS };
    }

    const salt: string = generateSaltHex();
    const hash: string = derivePasswordHash(input.newPassword, salt);
    const nowUtc: string = utcNowIso();
    const actor: string = ctx.actor ?? row.username;

    immediateTransaction(this.deps.db, () => {
      this.deps.credentials.updatePassword(hash, salt, serializeScryptParams(), nowUtc);
      const epoch: number = this.deps.meta.increment('auth_epoch');
      this.deps.sessions.revokeAll('password-change', nowUtc, epoch);
      this.deps.logs.append({
        action: Action.PASSWORD_CHANGE,
        targetType: TARGET_TYPE.CREDENTIAL,
        targetId: null,
        detail: { username: row.username },
        requestId: ctx.requestId,
        actor,
        occurredAt: nowUtc,
      });
    });
    return { ok: true, data: { ok: true } };
  }

  /** POST /api/auth/security：登录态设置 / 修改密保问题（需再次校验当前密码）。 */
  updateSecurity(input: UpdateSecurityInput, ctx: AuthContext): ServiceResult<SimpleOkResponse> {
    const row: CredentialRow | null = this.deps.credentials.find();
    if (row === null) {
      return { ok: false, code: ErrorCode.COMMON_INTERNAL };
    }
    if (!verifyPasswordHash(input.currentPassword, row.password_hash, row.salt)) {
      return { ok: false, code: ErrorCode.AUTH_INVALID_CREDENTIALS };
    }
    const question: string = input.securityQuestion.trim();
    const answer: string = normalizeSecurityAnswer(input.securityAnswer);
    if (question === '' || answer === '') {
      return { ok: false, code: ErrorCode.VALID_FAILED };
    }

    const answerSalt: string = generateSaltHex();
    const answerHash: string = derivePasswordHash(answer, answerSalt);
    const nowUtc: string = utcNowIso();
    immediateTransaction(this.deps.db, () => {
      this.deps.credentials.updateSecurity(question, answerSalt, answerHash, nowUtc);
      this.deps.logs.append({
        action: Action.SECURITY_UPDATE,
        targetType: TARGET_TYPE.CREDENTIAL,
        targetId: null,
        detail: { username: row.username, question },
        requestId: ctx.requestId,
        actor: ctx.actor ?? row.username,
        occurredAt: nowUtc,
      });
    });
    return { ok: true, data: { ok: true } };
  }

  /**
   * POST /api/auth/security-question：按用户名回显密保问题（忘记密码第一步）。
   *
   * - 用户名匹配且已设密保 → 真实问题 + configured:true；
   * - 用户名匹配但密保为空（1.0.0 升级上来的老库）→ 预设掩护问题 + configured:false，
   *   前端据此提示「尚未设置密保」，而不是假装有密保；
   * - 用户名不存在 → 预设掩护问题 + configured:true，不泄漏账号是否存在。
   */
  securityQuestion(username: string): ServiceResult<SecurityQuestionResponse> {
    const row: CredentialRow | null = this.deps.credentials.find();
    const trimmed: string = username.trim();
    if (row !== null && row.username === trimmed) {
      if (row.security_question !== '') {
        return { ok: true, data: { question: row.security_question, configured: true } };
      }
      return { ok: true, data: { question: decoyQuestion(), configured: false } };
    }
    return { ok: true, data: { question: decoyQuestion(), configured: true } };
  }

  /**
   * POST /api/auth/forgot-password：一步式密保重置。
   *
   * 失败一律 `AUTH_INVALID_SECURITY`（同名同文案），且无论用户名是否存在、
   * 是否设过密保，都恰好跑一次 scrypt —— 未命中走假盐/假哈希，耗时同阶。
   */
  forgotPassword(input: ForgotPasswordInput, ctx: AuthContext): ServiceResult<SimpleOkResponse> {
    if (this.deps.meta.initState() === 0) {
      return { ok: false, code: ErrorCode.AUTH_INIT_REQUIRED };
    }
    const username: string = input.username.trim();
    const blocked = securityBlockState(ctx.clientIp, username);
    if (blocked.blocked) {
      return { ok: false, code: ErrorCode.AUTH_SECURITY_RATE_LIMITED };
    }

    const row: CredentialRow | null = this.deps.credentials.find();
    const normalized: string = normalizeSecurityAnswer(input.securityAnswer);
    const realRow: CredentialRow | null =
      row !== null &&
      row.username === username &&
      row.security_question !== '' &&
      row.security_answer_hash !== '' &&
      normalized !== ''
        ? row
        : null;

    // 两条分支都只调用一次 scrypt：真实比对 / 假比对，耗时同阶。
    const answerOk: boolean =
      realRow !== null
        ? verifyPasswordHash(normalized, realRow.security_answer_hash, realRow.security_answer_salt)
        : verifyPasswordHash(
            normalized === '' ? '\u0000' : normalized,
            DUMMY_SECURITY_HASH,
            DUMMY_SECURITY_SALT,
          );

    if (realRow === null || !answerOk) {
      recordSecurityFailure(ctx.clientIp, username);
      return { ok: false, code: ErrorCode.AUTH_INVALID_SECURITY };
    }
    clearSecurityFailures(ctx.clientIp, username);

    const salt: string = generateSaltHex();
    const hash: string = derivePasswordHash(input.newPassword, salt);
    const nowUtc: string = utcNowIso();
    immediateTransaction(this.deps.db, () => {
      this.deps.credentials.updatePassword(hash, salt, serializeScryptParams(), nowUtc);
      const epoch: number = this.deps.meta.increment('auth_epoch');
      this.deps.sessions.revokeAll('forgot-password', nowUtc, epoch);
      this.deps.logs.append({
        action: Action.PASSWORD_RESET,
        targetType: TARGET_TYPE.CREDENTIAL,
        targetId: null,
        detail: { username },
        requestId: ctx.requestId,
        actor: 'forgot-password',
        occurredAt: nowUtc,
      });
    });
    return { ok: true, data: { ok: true } };
  }
}
