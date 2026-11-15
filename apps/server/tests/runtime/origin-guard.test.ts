/**
 * 跨运行时来源校验测试（任务卡 01 第 6 条）。
 *
 * Node 侧是 `http://<IP>:<PORT>`，Workers 侧是 `https://<name>.workers.dev`
 * **且通常不带端口**。改造前 `hostOfPublicOrigin()` 是硬切 `'http://'` 前缀，
 * 在 HTTPS 下会切出 `s://...` 这种恒不命中的串 —— 于是所有写请求 403。
 * 这两处必须由测试钉住，否则回归时只表现为"登录后什么都点不动"。
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { clientIpOf } from '../../src/middleware/rate-limit';
import { createCsrfMiddleware, hostOfPublicOrigin } from '../../src/middleware/csrf';

describe('hostOfPublicOrigin', () => {
  it('HTTP 带端口取 host:port', () => {
    expect(hostOfPublicOrigin('http://127.0.0.1:8080')).toBe('127.0.0.1:8080');
    expect(hostOfPublicOrigin('http://192.168.1.20:8080')).toBe('192.168.1.20:8080');
  });

  it('HTTPS 无端口只取域名（Workers 的常态）', () => {
    expect(hostOfPublicOrigin('https://stockin.example.workers.dev')).toBe(
      'stockin.example.workers.dev',
    );
  });

  it('IPv6 字面量保留方括号', () => {
    expect(hostOfPublicOrigin('http://[::1]:8080')).toBe('[::1]:8080');
  });

  it('非法字面量不静默返回空串', () => {
    expect(() => hostOfPublicOrigin('not-a-url')).toThrow();
  });
});

/** 组装一个只带 CSRF 中间件的应用，便于逐条打请求。 */
function buildApp(origins: readonly string[]): Hono {
  const app = new Hono();
  app.use('*', createCsrfMiddleware(origins));
  app.post('/api/records', (c) => c.json({ ok: true }));
  app.get('/api/records', (c) => c.json({ ok: true }));
  return app;
}

describe('CSRF 中间件在 HTTPS/无端口来源下的行为', () => {
  const origins = ['https://stockin.example.workers.dev'];
  const app = buildApp(origins);

  it('Origin 命中可信来源 → 放行', async () => {
    const res = await app.request('/api/records', {
      method: 'POST',
      headers: { host: 'stockin.example.workers.dev', origin: origins[0] ?? '' },
    });
    expect(res.status).toBe(200);
  });

  it('Origin 伪造 → 403', async () => {
    const res = await app.request('/api/records', {
      method: 'POST',
      headers: { host: 'stockin.example.workers.dev', origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
  });

  it('Host 不在可信集合（DNS rebinding）→ 403', async () => {
    const res = await app.request('/api/records', {
      method: 'POST',
      headers: { host: 'evil.example', origin: origins[0] ?? '' },
    });
    expect(res.status).toBe(403);
  });

  it('缺 Host 头 → 403', async () => {
    const res = await app.request('/api/records', { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('只带 Referer 且命中 → 放行；Referer 伪造 → 403', async () => {
    const ok = await app.request('/api/records', {
      method: 'POST',
      headers: {
        host: 'stockin.example.workers.dev',
        referer: 'https://stockin.example.workers.dev/records',
      },
    });
    expect(ok.status).toBe(200);
    const forged = await app.request('/api/records', {
      method: 'POST',
      headers: {
        host: 'stockin.example.workers.dev',
        referer: 'https://evil.example/records',
      },
    });
    expect(forged.status).toBe(403);
  });

  it('读请求不校验来源', async () => {
    const res = await app.request('/api/records', { method: 'GET' });
    expect(res.status).toBe(200);
  });

  it('非 /api 的写请求不校验（静态资源与 SPA 路由）', async () => {
    const res = await app.request('/records', {
      method: 'POST',
      headers: { host: 'evil.example' },
    });
    // 没有对应路由 → 404，而不是 403：说明 CSRF 放行了，交给路由裁决。
    expect(res.status).toBe(404);
  });
});

describe('clientIpOf 的跨运行时取舍', () => {
  /** 只构造 clientIpOf 真正读的两处：c.env 与 c.req.header。 */
  function fakeContext(
    env: unknown,
    headers: Record<string, string> = {},
  ): Parameters<typeof clientIpOf>[0] {
    return {
      env,
      req: { header: (name: string): string | undefined => headers[name.toLowerCase()] },
    } as unknown as Parameters<typeof clientIpOf>[0];
  }

  it('Node：只认 socket 地址', () => {
    const c = fakeContext({ incoming: { socket: { remoteAddress: '10.1.2.3' } } });
    expect(clientIpOf(c)).toBe('10.1.2.3');
  });

  it('Node：socket 缺失也不回落头部（XFF 可伪造）', () => {
    const c = fakeContext({ incoming: {} }, { 'cf-connecting-ip': '1.2.3.4' });
    expect(clientIpOf(c)).toBe('unknown');
  });

  it('Workers：没有 incoming 时读边缘写入的 cf-connecting-ip', () => {
    const c = fakeContext({}, { 'cf-connecting-ip': '203.0.113.9' });
    expect(clientIpOf(c)).toBe('203.0.113.9');
  });

  it('Workers：头部为空或缺失时回落 unknown', () => {
    expect(clientIpOf(fakeContext({}, { 'cf-connecting-ip': '   ' }))).toBe('unknown');
    expect(clientIpOf(fakeContext({}))).toBe('unknown');
  });
});
