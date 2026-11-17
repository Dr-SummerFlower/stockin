/**
 * 安全中间件链的 HTTP 层集成测试（发布审查 P1-2 / P2-2 / P2-5）。
 *
 * 覆盖：CSRF 三处判定（Host / Origin / Referer）、安全头在 200 / 403 / 500
 * 三种响应上的一致性（P2-2 收敛后只应有一处下发）、请求体上限、
 * 静态缓存头与 SPA 回退、以及被 CSRF 拒绝时访问日志里的 `clientIp` 不为空
 * （P2-5 的回归点：安全事件恰恰最需要溯源）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, TEST_ORIGIN, type Harness } from '../support/harness';

let harness: Harness | null = null;

afterEach(() => {
  harness?.close();
  harness = null;
  vi.restoreAllMocks();
});

/**
 * 安全头必须在**任何**响应上都是同一套。
 *
 * 断言口径与设计文档 §10.2 裁决 29 一致：CSP 逐字匹配、帧选项 DENY、
 * nosniff、no-referrer，且**不得**出现 HSTS（纯 HTTP）。
 */
function expectSecurityHeaders(headers: Headers): void {
  expect(headers.get('content-security-policy')).toBe(
    "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'",
  );
  expect(headers.get('x-frame-options')).toBe('DENY');
  expect(headers.get('x-content-type-options')).toBe('nosniff');
  expect(headers.get('referrer-policy')).toBe('no-referrer');
  expect(headers.get('strict-transport-security')).toBeNull();
}

describe('CSRF 来源校验', () => {
  it('伪造 Origin 的写请求返回 403', async () => {
    harness = await createHarness();
    const response = await harness.json<{ code: string }>('/api/auth/login', {
      json: { username: 'admin', password: 'x' },
      origin: 'http://evil.example',
    });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('AUTH_CSRF_FAILED');
    expectSecurityHeaders(response.headers);
  });

  it('伪造 Host 的写请求返回 403（拒绝 DNS rebinding）', async () => {
    harness = await createHarness();
    const response = await harness.json<{ code: string }>('/api/auth/login', {
      json: { username: 'admin', password: 'x' },
      host: 'evil.example',
    });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('AUTH_CSRF_FAILED');
  });

  it('Referer 不在白名单内的写请求返回 403', async () => {
    harness = await createHarness();
    const response = await harness.json<{ code: string }>('/api/auth/login', {
      json: { username: 'admin', password: 'x' },
      headers: { referer: 'http://evil.example/page' },
    });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('AUTH_CSRF_FAILED');
  });

  it('只读请求不受 CSRF 约束（GET 带伪造 Origin 仍放行）', async () => {
    harness = await createHarness();
    const response = await harness.json('/api/auth/init-status', {
      origin: 'http://evil.example',
    });
    expect(response.status).toBe(200);
  });

  it('被 CSRF 拒绝的请求，访问日志仍带 clientIp（P2-5）', async () => {
    harness = await createHarness();
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
      written.push(String(chunk));
      return true;
    });

    await harness.json('/api/auth/login', {
      json: { username: 'admin', password: 'x' },
      origin: 'http://evil.example',
    });
    spy.mockRestore();

    const access = written
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is Record<string, unknown> => entry !== null)
      .filter((entry) => entry.msg === 'access' && entry.path === '/api/auth/login');

    expect(access).toHaveLength(1);
    expect(access[0]?.['status']).toBe(403);
    // 关键断言：不是空串（改造前 CSRF 早于 session，这里恒为 ''）。
    expect(access[0]?.['clientIp']).toBeTruthy();
  });
});

describe('安全头与错误信封', () => {
  it('正常响应带全套安全头与自生成的 x-request-id', async () => {
    harness = await createHarness();
    const response = await harness.json('/api/auth/init-status');
    expectSecurityHeaders(response.headers);
    const requestId: string | null = response.headers.get('x-request-id');
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    // 入站同名头被忽略，响应里的 ID 必须是服务端生成的另一个值。
    const spoofed = await harness.json('/api/auth/init-status', {
      headers: { 'x-request-id': 'client-chosen' },
    });
    expect(spoofed.headers.get('x-request-id')).not.toBe('client-chosen');
  });

  it('500 响应同样是 JSON 信封且带全套安全头（不泄漏堆栈）', async () => {
    harness = await createHarness();
    const cookie: string = await harness.completeSetup('owner', 'Temp-Pass-2026-11-x9');
    // 让 Service 抛错，走 app.onError 的兜底路径。
    (harness.deps.records as unknown as { list: () => never }).list = (): never => {
      throw new Error('boom: 内部实现细节不应出现在响应里');
    };
    const response = await harness.json<{ code: string; message: string }>('/api/records', {
      cookie,
    });
    expect(response.status).toBe(500);
    expect(response.body.code).toBe('COMMON_INTERNAL');
    expect(JSON.stringify(response.body)).not.toContain('boom');
    expectSecurityHeaders(response.headers);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('超过 2MB 的请求体返回 413', async () => {
    harness = await createHarness();
    const huge: string = 'x'.repeat(2 * 1024 * 1024 + 128);
    const response = await harness.json<{ code: string }>('/api/auth/login', {
      json: { username: 'admin', password: huge },
    });
    expect(response.status).toBe(413);
    expect(response.body.code).toBe('VALID_BODY_TOO_LARGE');
  });
});

describe('静态资源与 SPA 回退', () => {
  it('SPA 路由回退到 index.html，带 ETag 与 no-cache', async () => {
    harness = await createHarness();
    const root = await harness.request('/');
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/html');
    expect(root.headers.get('etag')).toBeTruthy();
    expect(root.headers.get('cache-control')).toBe('no-cache');

    const deep = await harness.request('/records');
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain('<div id="root"></div>');
    // 三个入口共用同一份内容 ETag，避免 304 判定不一致。
    expect(deep.headers.get('etag')).toBe(root.headers.get('etag'));
  });

  it('带 hash 的静态资源下发 immutable，/api/* 一律 no-store', async () => {
    harness = await createHarness();
    const asset = await harness.request('/assets/umi-BnZ35ckD.js');
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    const api = await harness.json('/api/auth/init-status');
    expect(api.headers.get('cache-control')).toBe('no-store');
  });
});

describe('限流中间件对非登录路径的影响', () => {
  it('非登录端点的失败请求不消耗登录限流额度', async () => {
    harness = await createHarness();
    // 自助引导后才有凭据；setup 本身不计入登录失败。
    await harness.completeSetup('owner', 'Temp-Pass-2026-11-x9');
    for (let i = 0; i < 6; i += 1) {
      const denied = await harness.json('/api/records');
      expect(denied.status).toBe(401);
    }
    // 仍然可以正常登录（限流只认 /api/auth/login 的失败计数）。
    const cookie: string = await harness.login('Temp-Pass-2026-11-x9', 'owner');
    expect(cookie).toMatch(/^sid=/);
  });
});

describe('来源 scheme 与可信集合', () => {
  it('可信来源集合来自环境快照（回环写法自动等价展开），并与请求 Host 逐字比对', async () => {
    harness = await createHarness();
    // 只配了 127.0.0.1，但回环三写法会自动展开 —— 这是「忘配也能本机访问」的来源。
    expect(harness.env.publicOrigins).toContain(TEST_ORIGIN);
    expect(harness.env.publicOrigins).toContain(`http://localhost:18090`);
    expect(harness.env.publicOrigins).toContain(`http://[::1]:18090`);

    // 端口不同即视为不可信来源（CSRF 按含端口字面量精确比对）。
    const denied = await harness.json('/api/auth/login', {
      json: { username: 'admin', password: 'x' },
      host: '127.0.0.1:18091',
    });
    expect(denied.status).toBe(403);
  });
});
