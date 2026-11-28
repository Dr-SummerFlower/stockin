/**
 * 开发态页面导航回前端（`WEB_ORIGIN`）。
 *
 * 触发场景很具体：本地 `pnpm dev` 时前端在 8000、后端在 8080，用户习惯了
 * 直接开 8080 —— 那里没有新鲜静态产物，只会白屏。中间件把文档级导航送回
 * 8000，但**不能**碰接口请求（接口要如实返回 JSON 状态码）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../support/harness';

const WEB_ORIGIN = 'http://localhost:8000';

describe('WEB_ORIGIN 页面导航重定向', () => {
  let h: Harness;
  afterEach((): void => {
    h?.close();
  });

  it('文档级导航（Accept: text/html）跳到前端站点源，并保留查询串', async () => {
    h = await createHarness({ webOrigin: WEB_ORIGIN });

    const res = await h.request('/admin?from=8080', { headers: { accept: 'text/html' } });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${WEB_ORIGIN}/admin?from=8080`);
  });

  it('接口请求不被重定向：即便客户端声明接受 HTML，也必须拿到 JSON', async () => {
    h = await createHarness({ webOrigin: WEB_ORIGIN });

    const res = await h.request('/api/health', { headers: { accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('非文档请求（如静态资源 / 接口探测）不重定向', async () => {
    h = await createHarness({ webOrigin: WEB_ORIGIN });

    const res = await h.request('/', { headers: { accept: '*/*' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('未配置 WEB_ORIGIN 时行为不变：直接由静态 fallback 返回 index.html', async () => {
    h = await createHarness();

    const res = await h.request('/admin', { headers: { accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});
