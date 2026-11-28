/**
 * AdminAuthService 单测：GitHub OAuth 的纯逻辑 + 假 fetch。
 *
 * 为什么必须单独测：`http/admin.test.ts` 的管理员会话是直接写库构造的（绕开
 * GitHub 网络），如果这里不测，换 token / 拉用户 / 白名单判定 / 审计写入这条
 * 安全关键链路就是零覆盖——那正是覆盖率表里 15.78% 的来源。
 *
 * 边界：只替换全局 `fetch`，仓储用记录型假对象；不触碰 SQLite、不发真实请求。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Action, ErrorCode } from '@stockin/shared';
import type { Env } from '../src/env';
import type { AdminAccountRepository } from '../src/repositories/admin-account.repository';
import type { AdminSessionRepository } from '../src/repositories/admin-session.repository';
import type { OperationLogRepository } from '../src/repositories/operation-log.repository';
import {
  AdminAuthService,
  generateOauthState,
  type AdminAuthDeps,
} from '../src/services/admin-auth.service';
import { hashSessionToken } from '../src/lib/crypto';
import { logger } from '../src/lib/logger';

const PUBLIC_ORIGIN = 'https://shop.example.com';
const ALLOWED_LOGINS: readonly string[] = ['owner', 'admin'];

interface CapturedUpsert {
  readonly login: string;
  readonly githubUserId: number | null;
  readonly displayName: string;
}

interface CapturedSession {
  readonly tokenHash: string;
  readonly adminId: number;
}

interface CapturedLog {
  readonly action: string;
  readonly detail: Record<string, unknown>;
  readonly actor: string;
}

interface Captured {
  readonly upserts: CapturedUpsert[];
  readonly sessions: CapturedSession[];
  readonly logs: CapturedLog[];
}

function makeDeps(options: { enabled?: boolean; logins?: readonly string[] } = {}): {
  deps: AdminAuthDeps;
  captured: Captured;
} {
  const captured: Captured = { upserts: [], sessions: [], logs: [] };
  const env: Env = {
    publicOrigin: PUBLIC_ORIGIN,
    admin: {
      enabled: options.enabled ?? true,
      githubClientId: 'client-id',
      githubClientSecret: 'client-secret',
      allowedLogins: options.logins ?? ALLOWED_LOGINS,
    },
  } as unknown as Env;

  const accounts = {
    upsert: (login: string, githubUserId: number | null, displayName: string): { id: number } => {
      captured.upserts.push({ login, githubUserId, displayName });
      return { id: 7 };
    },
  } as unknown as AdminAccountRepository;

  const sessions = {
    create: (row: { tokenHash: string; adminId: number }): void => {
      captured.sessions.push({ tokenHash: row.tokenHash, adminId: row.adminId });
    },
  } as unknown as AdminSessionRepository;

  const logs = {
    append: (row: { action: string; detail: Record<string, unknown>; actor: string }): void => {
      captured.logs.push({ action: row.action, detail: row.detail, actor: row.actor });
    },
  } as unknown as OperationLogRepository;

  return { deps: { env, accounts, sessions, logs }, captured };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 按调用顺序依次返回预置响应；`Error` 表示这次调用直接抛错。 */
function stubFetchSequence(items: readonly (Response | Error)[]): void {
  const mock = vi.fn();
  for (const item of items) {
    if (item instanceof Error) {
      mock.mockRejectedValueOnce(item);
    } else {
      mock.mockResolvedValueOnce(item);
    }
  }
  vi.stubGlobal('fetch', mock);
}

afterEach((): void => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AdminAuthService 配置与授权 URL', () => {
  it('enabled 与白名单直接映射环境配置', () => {
    const on = new AdminAuthService(makeDeps().deps);
    expect(on.enabled).toBe(true);
    expect(on.allowedLogins).toEqual(ALLOWED_LOGINS);

    const off = new AdminAuthService(makeDeps({ enabled: false }).deps);
    expect(off.enabled).toBe(false);
  });

  it('redirectUri 由 PUBLIC_ORIGIN 推导，与 GitHub App 配置逐字一致', () => {
    const service = new AdminAuthService(makeDeps().deps);
    expect(service.redirectUri()).toBe(`${PUBLIC_ORIGIN}/api/admin/auth/github/callback`);
  });

  it('授权 URL 带齐 client_id / redirect_uri / scope / state，并禁用顺带注册', () => {
    const service = new AdminAuthService(makeDeps().deps);
    const url = new URL(service.buildAuthorizeUrl('state-abc'));

    expect(url.origin).toBe('https://github.com');
    expect(url.pathname).toBe('/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(service.redirectUri());
    expect(url.searchParams.get('scope')).toBe('read:user');
    expect(url.searchParams.get('state')).toBe('state-abc');
    expect(url.searchParams.get('allow_signup')).toBe('false');
  });

  it('state 为 32 字节的 URL 安全字符，且每次不同', () => {
    const first = generateOauthState();
    const second = generateOauthState();
    // 32 字节按 base64url 编码 = 43 个无需再转义的字符（无填充）。
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
  });
});

describe('handleCallback', () => {
  it('成功：建管理员会话、落账户、写 ADMIN_LOGIN 审计，且登录名归一为小写', async () => {
    stubFetchSequence([
      jsonResponse({ access_token: 'gh-token' }),
      jsonResponse({ id: 42, login: '  Owner  ', name: '  Octo Cat  ' }),
    ]);
    const { deps, captured } = makeDeps();
    const result = await new AdminAuthService(deps).handleCallback('code-1', 'req-1', '1.2.3.4');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('预期成功');
    }
    expect(result.login).toBe('owner');
    expect(result.token).not.toBe('');

    // 会话只存 token 的哈希，明文 token 绝不入库。
    expect(captured.sessions).toHaveLength(1);
    expect(captured.sessions[0]).toEqual({
      tokenHash: hashSessionToken(result.token),
      adminId: 7,
    });
    expect(captured.sessions[0]?.tokenHash).not.toBe(result.token);

    expect(captured.upserts).toEqual([
      { login: 'owner', githubUserId: 42, displayName: 'Octo Cat' },
    ]);
    expect(captured.logs).toHaveLength(1);
    expect(captured.logs[0]).toMatchObject({
      action: Action.ADMIN_LOGIN,
      actor: 'admin:owner',
      detail: { login: 'owner', clientIp: '1.2.3.4' },
    });
  });

  it('展示名缺失时回落登录名；用户 id 非数字时存 null', async () => {
    stubFetchSequence([
      jsonResponse({ access_token: 'gh-token' }),
      jsonResponse({ login: 'owner', name: '   ' }),
    ]);
    const { deps, captured } = makeDeps();
    const result = await new AdminAuthService(deps).handleCallback('code', 'req', 'ip');

    expect(result.ok).toBe(true);
    expect(captured.upserts).toEqual([
      { login: 'owner', githubUserId: null, displayName: 'owner' },
    ]);
  });

  it('换 token 失败（HTTP 非 2xx）→ ADMIN_OAUTH_FAILED，并写 token-exchange 失败审计', async () => {
    stubFetchSequence([
      jsonResponse({ error: 'bad_verification_code', error_description: 'nope' }, 400),
    ]);
    const { deps, captured } = makeDeps();
    const result = await new AdminAuthService(deps).handleCallback('bad-code', 'req-2', '5.6.7.8');

    expect(result).toEqual({ ok: false, code: ErrorCode.ADMIN_OAUTH_FAILED });
    expect(captured.logs[0]).toMatchObject({
      action: Action.ADMIN_LOGIN_FAILED,
      actor: 'admin:anonymous',
      // GitHub 错误码进 error 字段，不能冒充 login。
      detail: {
        reason: 'token-exchange',
        login: null,
        error: 'bad_verification_code',
        clientIp: '5.6.7.8',
      },
    });
    expect(captured.sessions).toHaveLength(0);
    expect(captured.upserts).toHaveLength(0);
  });

  it('token 响应缺 access_token → 同样按 token-exchange 失败处理', async () => {
    stubFetchSequence([jsonResponse({ token_type: 'bearer' })]);
    const { deps } = makeDeps();
    const result = await new AdminAuthService(deps).handleCallback('code', 'req', 'ip');
    expect(result).toEqual({ ok: false, code: ErrorCode.ADMIN_OAUTH_FAILED });
  });

  it('拉用户失败（HTTP 非 2xx）→ user-fetch 失败', async () => {
    stubFetchSequence([
      jsonResponse({ access_token: 'gh-token' }),
      jsonResponse({ message: 'Bad credentials' }, 401),
    ]);
    const { deps, captured } = makeDeps();
    const result = await new AdminAuthService(deps).handleCallback('code', 'req', 'ip');

    expect(result).toEqual({ ok: false, code: ErrorCode.ADMIN_OAUTH_FAILED });
    expect(captured.logs[0]).toMatchObject({ detail: { reason: 'user-fetch' } });
  });

  it('用户响应没有 login → 按 user-fetch 失败处理，不做白名单判定', async () => {
    stubFetchSequence([jsonResponse({ access_token: 'gh-token' }), jsonResponse({ id: 9 })]);
    const { deps, captured } = makeDeps();
    const result = await new AdminAuthService(deps).handleCallback('code', 'req', 'ip');

    expect(result).toEqual({ ok: false, code: ErrorCode.ADMIN_OAUTH_FAILED });
    expect(captured.logs[0]).toMatchObject({ detail: { reason: 'user-fetch' } });
  });

  it('白名单外 → ADMIN_FORBIDDEN，审计记录被拒绝的登录名', async () => {
    stubFetchSequence([
      jsonResponse({ access_token: 'gh-token' }),
      jsonResponse({ id: 99, login: 'Intruder' }),
    ]);
    const { deps, captured } = makeDeps();
    const result = await new AdminAuthService(deps).handleCallback('code', 'req-3', '9.9.9.9');

    expect(result).toEqual({ ok: false, code: ErrorCode.ADMIN_FORBIDDEN });
    expect(captured.logs[0]).toMatchObject({
      action: Action.ADMIN_LOGIN_FAILED,
      detail: { reason: 'not-allowed', login: 'intruder', clientIp: '9.9.9.9' },
    });
    expect(captured.sessions).toHaveLength(0);
  });

  it('网络异常 → 记 error 日志并返回 ADMIN_OAUTH_FAILED(network)', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation((): void => undefined);
    stubFetchSequence([new Error('ECONNREFUSED')]);
    const { deps, captured } = makeDeps();
    const result = await new AdminAuthService(deps).handleCallback('code', 'req-4', 'ip');

    expect(result).toEqual({ ok: false, code: ErrorCode.ADMIN_OAUTH_FAILED });
    expect(captured.logs[0]).toMatchObject({ detail: { reason: 'network' } });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
