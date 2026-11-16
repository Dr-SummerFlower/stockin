/**
 * 认证 / 首次引导的 HTTP 层集成测试（发布审查 P1-2）。
 *
 * 覆盖：init-status、登录三条失败路径（错密码、**错用户名**、缺字段）、
 * 成功后签 Cookie、me 的匿名与已登录两种语义、setup 的 409 幂等、
 * 登录失败限流的 429 与 Retry-After、logout 清 Cookie。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../support/harness';

let harness: Harness | null = null;

afterEach(() => {
  harness?.close();
  harness = null;
});

describe('GET /api/auth/init-status', () => {
  it('新库返回未初始化、initState=0、默认账号 admin', async () => {
    harness = await createHarness();
    const response = await harness.json<{
      initialized: boolean;
      initState: number;
      username: string;
    }>('/api/auth/init-status');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ initialized: false, initState: 0, username: 'admin' });
  });
});

describe('POST /api/auth/login', () => {
  it('密码错误返回 401 与统一错误码，且不签 Cookie', async () => {
    harness = await createHarness();
    const response = await harness.json<{ code: string; message: string }>('/api/auth/login', {
      json: { username: 'admin', password: 'wrong-password' },
    });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(response.setCookie).toHaveLength(0);
  });

  it('用户名错误即使密码正确也必须拒绝（审计署名不可由客户端指定）', async () => {
    harness = await createHarness();
    const response = await harness.json<{ code: string }>('/api/auth/login', {
      json: { username: 'attacker', password: harness.initialPassword },
    });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(response.setCookie).toHaveLength(0);
  });

  it('凭据正确返回 200、initState 与 HttpOnly 会话 Cookie', async () => {
    harness = await createHarness();
    const response = await harness.json<{ ok: boolean; initState: number }>('/api/auth/login', {
      json: { username: 'admin', password: harness.initialPassword },
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, initState: 0 });
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
      json: { username: 'admin' },
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALID_FAILED');
  });

  it('连续 5 次失败后第 6 次返回 429 并带 Retry-After', async () => {
    harness = await createHarness();
    for (let i = 0; i < 5; i += 1) {
      const attempt = await harness.json('/api/auth/login', {
        json: { username: 'admin', password: 'nope' },
      });
      expect(attempt.status).toBe(401);
    }
    const blocked = await harness.json<{ code: string }>('/api/auth/login', {
      json: { username: 'admin', password: 'nope' },
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
    const cookie: string = await harness.login(harness.initialPassword);
    const response = await harness.json<{
      authenticated: boolean;
      user: { username: string } | null;
    }>('/api/auth/me', { cookie });
    expect(response.body.authenticated).toBe(true);
    expect(response.body.user?.username).toBe('admin');
  });
});

describe('POST /api/auth/setup', () => {
  it('完成后重复 setup 返回 409（0→1 单向状态机）', async () => {
    harness = await createHarness();
    await harness.completeSetup('owner', 'Temp-Pass-2026-11-x9');

    const second = await harness.json<{ code: string }>('/api/auth/setup', {
      json: {
        currentPassword: 'Temp-Pass-2026-11-x9',
        username: 'other',
        password: 'Another-Pass-1',
      },
    });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('AUTH_INIT_COMPLETED');
  });

  it('setup 不签新会话，旧会话被 auth_epoch 吊销', async () => {
    harness = await createHarness();
    const beforeCookie: string = await harness.login(harness.initialPassword);
    const afterCookie: string = await harness.completeSetup('owner', 'Temp-Pass-2026-11-x9');

    const staleMe = await harness.json<{ authenticated: boolean }>('/api/auth/me', {
      cookie: beforeCookie,
    });
    expect(staleMe.body.authenticated).toBe(false);

    const me = await harness.json<{ authenticated: boolean; user: { username: string } }>(
      '/api/auth/me',
      { cookie: afterCookie },
    );
    expect(me.body.authenticated).toBe(true);
    expect(me.body.user.username).toBe('owner');
  });

  it('引导前的初始密码错误返回 401，不改变初始化状态', async () => {
    harness = await createHarness();
    const bad = await harness.json<{ code: string }>('/api/auth/setup', {
      json: { currentPassword: 'not-the-password', username: 'owner', password: 'Passw0rd-x1' },
    });
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('AUTH_INVALID_CREDENTIALS');

    const status = await harness.json<{ initialized: boolean }>('/api/auth/init-status');
    expect(status.body.initialized).toBe(false);
  });
});

describe('POST /api/auth/logout', () => {
  it('吊销会话并清空 Cookie；重复调用保持幂等 200', async () => {
    harness = await createHarness();
    const cookie: string = await harness.login(harness.initialPassword);

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
