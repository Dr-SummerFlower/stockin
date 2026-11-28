/**
 * 管理员 GitHub OAuth 认证。
 *
 * 为什么不用邮箱验证码：Workers 不支持 SMTP（V8 isolate 无 TCP），而 GitHub
 * OAuth 全程只走 HTTPS `fetch`，Node 与 Workers 行为一致；GitHub 账号本身可挂
 * 2FA，强度高于一次性邮件验证码，也省掉验证码存储与限流。
 *
 * 安全要点：
 *  - `state` 一次性、写 HttpOnly Cookie、10 分钟过期，回调时严格比对（防 CSRF）；
 *  - GitHub access token 只用于取用户资料，**用完即弃，绝不入库**；
 *  - 登录名必须命中环境变量白名单，否则 403 并写审计日志；
 *  - 成功 / 失败都写 operation_logs（身份鉴别事件属 6 个月留存范围）。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  ADMIN_SESSION_ABSOLUTE_HOURS,
  ADMIN_SESSION_IDLE_MINUTES,
  Action,
  ErrorCode,
  TARGET_TYPE,
} from '@stockin/shared';
import type { Env } from '../env';
import type { AdminAccountRepository } from '../repositories/admin-account.repository';
import type { AdminSessionRepository } from '../repositories/admin-session.repository';
import type { OperationLogRepository } from '../repositories/operation-log.repository';
import { generateSessionToken, hashSessionToken } from '../lib/crypto';
import { utcAfterHoursIso, utcAfterMinutesIso, utcNowIso } from '../lib/today';
import { logger } from '../lib/logger';

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';
/** GitHub API 强制要求 User-Agent，缺失直接 403。 */
const GITHUB_USER_AGENT = 'stockin-admin/1.0';

export interface AdminAuthDeps {
  readonly env: Env;
  readonly accounts: AdminAccountRepository;
  readonly sessions: AdminSessionRepository;
  readonly logs: OperationLogRepository;
}

export type AdminCallbackResult =
  | { ok: true; token: string; login: string }
  | { ok: false; code: ErrorCode };

interface GithubTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GithubUserResponse {
  id?: number;
  login?: string;
  name?: string | null;
}

/** 生成一次性 state（32 字节 base64url，足够抗猜测）。 */
export function generateOauthState(): string {
  return randomBytes(32).toString('base64url');
}

export class AdminAuthService {
  constructor(private readonly deps: AdminAuthDeps) {}

  get enabled(): boolean {
    return this.deps.env.admin.enabled;
  }

  /** 允许登录的 GitHub 登录名（小写）。 */
  get allowedLogins(): readonly string[] {
    return this.deps.env.admin.allowedLogins;
  }

  /** OAuth 回调地址必须与 GitHub OAuth App 配置逐字一致，所以由 PUBLIC_ORIGIN 推导。 */
  redirectUri(): string {
    return `${this.deps.env.publicOrigin}/api/admin/auth/github/callback`;
  }

  buildAuthorizeUrl(state: string): string {
    const url: URL = new URL(GITHUB_AUTHORIZE_URL);
    url.searchParams.set('client_id', this.deps.env.admin.githubClientId);
    url.searchParams.set('redirect_uri', this.redirectUri());
    url.searchParams.set('scope', 'read:user');
    url.searchParams.set('state', state);
    // 管理员应是既有 GitHub 账号，不允许在登录流程里顺带注册新号。
    url.searchParams.set('allow_signup', 'false');
    return url.toString();
  }

  /**
   * 用授权码换 token → 取用户 → 白名单校验 → 建管理员会话。
   * 任何失败都返回统一错误码并写审计，不把 GitHub 原始错误暴露给浏览器。
   */
  async handleCallback(
    code: string,
    requestId: string,
    clientIp: string,
  ): Promise<AdminCallbackResult> {
    const nowUtc: string = utcNowIso();
    try {
      const tokenResponse: Response = await fetch(GITHUB_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': GITHUB_USER_AGENT,
        },
        body: new URLSearchParams({
          client_id: this.deps.env.admin.githubClientId,
          client_secret: this.deps.env.admin.githubClientSecret,
          code,
          redirect_uri: this.redirectUri(),
        }),
      });
      const tokenData = (await tokenResponse.json()) as GithubTokenResponse;
      if (!tokenResponse.ok || typeof tokenData.access_token !== 'string') {
        return this.fail('token-exchange', requestId, clientIp, nowUtc, {
          error: tokenData.error ?? null,
        });
      }

      const userResponse: Response = await fetch(GITHUB_USER_URL, {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': GITHUB_USER_AGENT,
        },
      });
      const user = (await userResponse.json()) as GithubUserResponse;
      const login: string = (user.login ?? '').trim().toLowerCase();
      if (!userResponse.ok || login === '') {
        return this.fail('user-fetch', requestId, clientIp, nowUtc);
      }

      if (!this.allowedLogins.includes(login)) {
        return this.fail('not-allowed', requestId, clientIp, nowUtc, { login });
      }

      const account = this.deps.accounts.upsert(
        login,
        typeof user.id === 'number' ? user.id : null,
        (user.name ?? '').trim() || login,
        nowUtc,
      );
      const token: string = generateSessionToken();
      this.deps.sessions.create({
        id: randomUUID(),
        tokenHash: hashSessionToken(token),
        adminId: account.id,
        idleExpiresAt: utcAfterMinutesIso(ADMIN_SESSION_IDLE_MINUTES),
        absoluteExpiresAt: utcAfterHoursIso(ADMIN_SESSION_ABSOLUTE_HOURS),
        createdAt: nowUtc,
      });
      this.deps.logs.append({
        action: Action.ADMIN_LOGIN,
        targetType: TARGET_TYPE.ADMIN,
        targetId: account.id,
        detail: { login, clientIp },
        requestId,
        actor: `admin:${login}`,
        occurredAt: nowUtc,
      });
      return { ok: true, token, login };
    } catch (error) {
      logger.error(
        { err: error instanceof Error ? error.message : String(error), requestId },
        '[admin-auth] GitHub OAuth 失败',
      );
      return this.fail('network', requestId, clientIp, nowUtc);
    }
  }

  /**
   * 统一的失败收口。
   *
   * `login` 与 `error` 分开记：换 token 失败时 GitHub 返回的是错误码
   * （如 `bad_verification_code`），不是登录名；混进 `login` 会让事后审计
   * 误判「谁尝试登录」，所以两个字段各自独立、缺省写 null。
   */
  private fail(
    reason: string,
    requestId: string,
    clientIp: string,
    nowUtc: string,
    extra: { readonly login?: string; readonly error?: string | null } = {},
  ): { ok: false; code: ErrorCode } {
    this.deps.logs.append({
      action: Action.ADMIN_LOGIN_FAILED,
      targetType: TARGET_TYPE.ADMIN,
      targetId: null,
      detail: {
        reason,
        login: extra.login ?? null,
        error: extra.error ?? null,
        clientIp,
      },
      requestId,
      actor: 'admin:anonymous',
      occurredAt: nowUtc,
    });
    // 白名单外是明确的权限拒绝，其余按认证失败处理。
    return {
      ok: false,
      code: reason === 'not-allowed' ? ErrorCode.ADMIN_FORBIDDEN : ErrorCode.ADMIN_OAUTH_FAILED,
    };
  }
}
