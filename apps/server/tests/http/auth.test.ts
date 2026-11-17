/**
 * 认证 / 自助引导 / 账号安全的 HTTP 层集成测试（发布审查 P1-2）。
 *
 * 覆盖：init-status、登录失败路径（错密码、错用户名、缺字段）、成功签 Cookie、
 * me 的匿名与已登录语义、自助 setup（新契约）与 409 幂等、登录失败限流、
 * logout 清 Cookie、修改密码（全量吊销）、密保问题回显 / 修改、
 * 忘记密码（统一错误、时序无关、限流、重置后旧会话失效）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { derivePasswordHash, generateSaltHex, serializeScryptParams } from '../../src/lib/crypto';
import { utcNowIso } from '../../src/lib/today';
import {
  HARNESS_SECURITY_ANSWER,
  HARNESS_SECURITY_QUESTION,
  createHarness,
  type Harness,
} from '../support/harness';

let harness: Harness | null = null;

afterEach(() => {
  harness?.close();
  harness = null;
});

/** 合法的自助引导载荷（密保必填）。 */
function setupPayload(
  username: string,
  password: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    username,
    password,
    securityQuestion: HARNESS_SECURITY_QUESTION,
    securityAnswer: HARNESS_SECURITY_ANSWER,
    shopName: '测试店铺',
    expiryThresholdDays: 30,
    ...overrides,
  };
}

describe('GET /api/auth/init-status', () => {
  it('新库返回未初始化、initState=0、无用户名（不再预置 admin 凭据）', async () => {
    harness = await createHarness();
    const response = await harness.json<{
      initialized: boolean;
      initState: number;
      username: string | null;
    }>('/api/auth/init-status');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ initialized: false, initState: 0, username: null });
  });
});

describe('POST /api/auth/login', () => {
  it('未初始化时没有任何凭据，登录必然 401 且不签 Cookie', async () => {
    harness = await createHarness();
    const response = await harness.json<{ code: string }>('/api/auth/login', {
      json: { username: 'admin', password: 'anything' },
    });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(response.setCookie).toHaveLength(0);
  });

  it('密码错误返回 401 与统一错误码，且不签 Cookie', async () => {
    harness = await createHarness();
    await harness.completeSetup('owner', 'Owner-Pass-2026-11');
    const response = await harness.json<{ code: string }>('/api/auth/login', {
      json: { username: 'owner', password: 'wrong-password' },
    });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(response.setCookie).toHaveLength(0);
  });

  it('用户名错误即使密码正确也必须拒绝（审计署名不可由客户端指定）', async () => {
    harness = await createHarness();
    await harness.completeSetup('owner', 'Owner-Pass-2026-11');
    const response = await harness.json<{ code: string }>('/api/auth/login', {
      json: { username: 'attacker', password: 'Owner-Pass-2026-11' },
    });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(response.setCookie).toHaveLength(0);
  });

  it('凭据正确返回 200、initState 与 HttpOnly 会话 Cookie', async () => {
    harness = await createHarness();
    await harness.completeSetup('owner', 'Owner-Pass-2026-11');
    const response = await harness.json<{ ok: boolean; initState: number }>('/api/auth/login', {
      json: { username: 'owner', password: 'Owner-Pass-2026-11' },
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, initState: 1 });
    const cookie: string = response.setCookie[0] ?? '';
    expect(cookie).toMatch(/^sid=/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    // 纯 HTTP 方案下不得带 Secure，否则浏览器不会回传。
    expect(cookie).not.toContain('Secure');
  });

  it('缺字段返回 422（zod 边界校验，不进 Service）', async () => {
    harness = await createHarness();
    const response = await harness.json<{ code: string }>('/api/auth/login', {
      json: { username: 'owner' },
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALID_FAILED');
  });

  it('连续 5 次失败后第 6 次返回 429 并带 Retry-After', async () => {
    harness = await createHarness();
    await harness.completeSetup('owner', 'Owner-Pass-2026-11');
    for (let i = 0; i < 5; i += 1) {
      const attempt = await harness.json('/api/auth/login', {
        json: { username: 'owner', password: 'nope' },
      });
      expect(attempt.status).toBe(401);
    }
    const blocked = await harness.json<{ code: string }>('/api/auth/login', {
      json: { username: 'owner', password: 'nope' },
    });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('AUTH_RATE_LIMITED');
    const retryAfter: string | null = blocked.headers.get('retry-after');
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });
});

describe('GET /api/auth/me', () => {
  it('匿名返回 authenticated=false 而不是 401', async () => {
    harness = await createHarness();
    const response = await harness.json<{ authenticated: boolean }>('/api/auth/me');
    expect(response.status).toBe(200);
    expect(response.body.authenticated).toBe(false);
  });

  it('带会话 Cookie 返回 authenticated=true 与账号名', async () => {
    harness = await createHarness();
    const cookie: string = await harness.completeSetup('owner', 'Owner-Pass-2026-11');
    const response = await harness.json<{
      authenticated: boolean;
      user: { username: string } | null;
    }>('/api/auth/me', { cookie });
    expect(response.body.authenticated).toBe(true);
    expect(response.body.user?.username).toBe('owner');
  });
});

describe('POST /api/auth/setup', () => {
  it('自助引导成功：initState 变 1、用户名生效、可直接登录', async () => {
    harness = await createHarness();
    const setup = await harness.json<{ initState: number }>('/api/auth/setup', {
      json: setupPayload('owner', 'Owner-Pass-2026-11'),
    });
    expect(setup.status).toBe(200);
    expect(setup.body.initState).toBe(1);

    const status = await harness.json<{ initialized: boolean; username: string }>(
      '/api/auth/init-status',
    );
    expect(status.body.initialized).toBe(true);
    expect(status.body.username).toBe('owner');
  });

  it('缺密保字段返回 422（密保为必填项）', async () => {
    harness = await createHarness();
    const response = await harness.json<{ code: string }>('/api/auth/setup', {
      json: {
        username: 'owner',
        password: 'Owner-Pass-2026-11',
        shopName: '',
        expiryThresholdDays: 30,
      },
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALID_FAILED');
  });

  it('完成后重复 setup 返回 409（0→1 单向状态机）', async () => {
    harness = await createHarness();
    await harness.completeSetup('owner', 'Owner-Pass-2026-11');
    const second = await harness.json<{ code: string }>('/api/auth/setup', {
      json: setupPayload('other', 'Another-Pass-1'),
    });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('AUTH_INIT_COMPLETED');
  });
});

describe('POST /api/auth/logout', () => {
  it('吊销会话并清空 Cookie；重复调用保持幂等 200', async () => {
    harness = await createHarness();
    const cookie: string = await harness.completeSetup('owner', 'Owner-Pass-2026-11');

    const first = await harness.json<{ ok: boolean }>('/api/auth/logout', {
      method: 'POST',
      cookie,
    });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true });
    expect(first.setCookie.join(';')).toMatch(/sid=;|Max-Age=0|Expires=Thu, 01 Jan 1970/i);

    const second = await harness.json<{ ok: boolean }>('/api/auth/logout', {
      method: 'POST',
      cookie,
    });
    expect(second.status).toBe(200);

    const me = await harness.json<{ authenticated: boolean }>('/api/auth/me', { cookie });
    expect(me.body.authenticated).toBe(false);
  });
});

describe('POST /api/auth/change-password', () => {
  it('改密成功后当前会话立即失效，旧密码拒绝、新密码可登录（A1）', async () => {
    harness = await createHarness();
    const cookie: string = await harness.completeSetup('owner', 'Owner-Pass-2026-11');

    const changed = await harness.json<{ ok: boolean }>('/api/auth/change-password', {
      json: { currentPassword: 'Owner-Pass-2026-11', newPassword: 'Owner-Pass-2026-12' },
      cookie,
    });
    expect(changed.status).toBe(200);
    expect(changed.body).toEqual({ ok: true });
    // 全量吊销含当前会话，响应同时清 Cookie。
    expect(changed.setCookie.join(';')).toMatch(/sid=;|Max-Age=0|Expires=Thu, 01 Jan 1970/i);

    const stale = await harness.json<{ authenticated: boolean }>('/api/auth/me', { cookie });
    expect(stale.body.authenticated).toBe(false);

    const oldLogin = await harness.json<{ code: string }>('/api/auth/login', {
      json: { username: 'owner', password: 'Owner-Pass-2026-11' },
    });
    expect(oldLogin.status).toBe(401);

    const newLogin = await harness.json<{ ok: boolean }>('/api/auth/login', {
      json: { username: 'owner', password: 'Owner-Pass-2026-12' },
    });
    expect(newLogin.status).toBe(200);
  });

  it('当前密码错误返回 401，密码不变', async () => {
    harness = await createHarness();
    const cookie: string = await harness.completeSetup('owner', 'Owner-Pass-2026-11');
    const response = await harness.json<{ code: string }>('/api/auth/change-password', {
      json: { currentPassword: 'not-current', newPassword: 'Whatever-1' },
      cookie,
    });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_INVALID_CREDENTIALS');

    const stillWorks = await harness.json<{ ok: boolean }>('/api/auth/login', {
      json: { username: 'owner', password: 'Owner-Pass-2026-11' },
    });
    expect(stillWorks.status).toBe(200);
  });

  it('未登录调用返回 401（不在白名单内）', async () => {
    harness = await createHarness();
    await harness.completeSetup('owner', 'Owner-Pass-2026-11');
    const response = await harness.json<{ code: string }>('/api/auth/change-password', {
      json: { currentPassword: 'Owner-Pass-2026-11', newPassword: 'Whatever-1' },
    });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_REQUIRED');
  });
});

describe('POST /api/auth/security 与 security-question', () => {
  it('设置密保后回显新问题；错误当前密码不改变密保', async () => {
    harness = await createHarness();
    const cookie: string = await harness.completeSetup('owner', 'Owner-Pass-2026-11');

    const bad = await harness.json<{ code: string }>('/api/auth/security', {
      json: {
        currentPassword: 'wrong',
        securityQuestion: '新问题？',
        securityAnswer: 'new-answer',
      },
      cookie,
    });
    expect(bad.status).toBe(401);

    const afterBad = await harness.json<{ question: string; configured: boolean }>(
      '/api/auth/security-question',
      { json: { username: 'owner' } },
    );
    expect(afterBad.body.question).toBe(HARNESS_SECURITY_QUESTION);
    expect(afterBad.body.configured).toBe(true);

    const ok = await harness.json<{ ok: boolean }>('/api/auth/security', {
      json: {
        currentPassword: 'Owner-Pass-2026-11',
        securityQuestion: '新问题？',
        securityAnswer: 'New-Answer-2026',
      },
      cookie,
    });
    expect(ok.status).toBe(200);

    const afterOk = await harness.json<{ question: string }>('/api/auth/security-question', {
      json: { username: 'owner' },
    });
    expect(afterOk.body.question).toBe('新问题？');
  });

  it('未初始化 / 未知用户名都返回一条预设问题作掩护', async () => {
    harness = await createHarness();
    const before = await harness.json<{ question: string; configured: boolean }>(
      '/api/auth/security-question',
      { json: { username: 'nobody' } },
    );
    expect(before.status).toBe(200);
    expect(before.body.question).toBe(HARNESS_SECURITY_QUESTION);
    // 未知用户名一律 configured:true，避免枚举出账号是否存在。
    expect(before.body.configured).toBe(true);
  });

  it('1.0 老库：凭据存在但密保为空时返回 configured=false', async () => {
    harness = await createHarness();
    const salt: string = generateSaltHex();
    const now: string = utcNowIso();
    harness.deps.repositories.credentials.create({
      username: 'admin',
      passwordHash: derivePasswordHash('legacy-pass-1', salt),
      salt,
      scryptParams: serializeScryptParams(),
      isInitial: 1,
      securityQuestion: '',
      securityAnswerSalt: '',
      securityAnswerHash: '',
      createdAt: now,
      updatedAt: now,
    });
    const response = await harness.json<{ question: string; configured: boolean }>(
      '/api/auth/security-question',
      { json: { username: 'admin' } },
    );
    expect(response.status).toBe(200);
    expect(response.body.configured).toBe(false);
    expect(response.body.question).toBe(HARNESS_SECURITY_QUESTION);
  });
});

describe('POST /api/auth/forgot-password', () => {
  it('未初始化返回 403 AUTH_INIT_REQUIRED', async () => {
    harness = await createHarness();
    const response = await harness.json<{ code: string }>('/api/auth/forgot-password', {
      json: { username: 'owner', securityAnswer: 'x', newPassword: 'Whatever-1' },
    });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('AUTH_INIT_REQUIRED');
  });

  it('密保答案错误与用户名不存在返回同一错误码与文案', async () => {
    harness = await createHarness();
    await harness.completeSetup('owner', 'Owner-Pass-2026-11');

    const wrongAnswer = await harness.json<{ code: string; message: string }>(
      '/api/auth/forgot-password',
      {
        json: { username: 'owner', securityAnswer: 'wrong-answer', newPassword: 'New-Pass-2026' },
      },
    );
    expect(wrongAnswer.status).toBe(401);
    expect(wrongAnswer.body.code).toBe('AUTH_INVALID_SECURITY');

    const unknownUser = await harness.json<{ code: string; message: string }>(
      '/api/auth/forgot-password',
      {
        json: { username: 'nobody', securityAnswer: 'whatever', newPassword: 'New-Pass-2026' },
      },
    );
    expect(unknownUser.status).toBe(401);
    expect(unknownUser.body.code).toBe('AUTH_INVALID_SECURITY');
    expect(unknownUser.body.message).toBe(wrongAnswer.body.message);
  });

  it('答案正确（大小写与首尾空格归一化）后重置密码，旧会话失效、新密码可登录', async () => {
    harness = await createHarness();
    const cookie: string = await harness.completeSetup('owner', 'Owner-Pass-2026-11');

    const reset = await harness.json<{ ok: boolean }>('/api/auth/forgot-password', {
      json: {
        username: 'owner',
        securityAnswer: `  ${HARNESS_SECURITY_ANSWER.toUpperCase()}  `,
        newPassword: 'Reset-Pass-2026',
      },
    });
    expect(reset.status).toBe(200);
    expect(reset.body).toEqual({ ok: true });

    const stale = await harness.json<{ authenticated: boolean }>('/api/auth/me', { cookie });
    expect(stale.body.authenticated).toBe(false);

    const oldLogin = await harness.json<{ code: string }>('/api/auth/login', {
      json: { username: 'owner', password: 'Owner-Pass-2026-11' },
    });
    expect(oldLogin.status).toBe(401);

    const newLogin = await harness.json<{ ok: boolean }>('/api/auth/login', {
      json: { username: 'owner', password: 'Reset-Pass-2026' },
    });
    expect(newLogin.status).toBe(200);
  });

  it('连续 5 次答案错误后第 6 次返回 429 与 Retry-After', async () => {
    harness = await createHarness();
    await harness.completeSetup('owner', 'Owner-Pass-2026-11');
    for (let i = 0; i < 5; i += 1) {
      const attempt = await harness.json('/api/auth/forgot-password', {
        json: { username: 'owner', securityAnswer: `wrong-${i}`, newPassword: 'New-Pass-2026' },
      });
      expect(attempt.status).toBe(401);
    }
    const blocked = await harness.json<{ code: string }>('/api/auth/forgot-password', {
      json: { username: 'owner', securityAnswer: 'wrong-final', newPassword: 'New-Pass-2026' },
    });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('AUTH_SECURITY_RATE_LIMITED');
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});
