/**
 * 健康检查与静态回退单测。
 *
 * 两块都是「小函数、大后果」：
 *  - HealthService 的 not-ready 是发布/重导入期间的唯一熔断信号；
 *  - SPA fallback 的三卷越界守卫一旦失效，`data/`、`backups/` 会被当静态资源托管。
 *
 * 此前只覆盖了 ready 后的 200 与 fallback 的 200，`markNotReady`、越界抛错、
 * 304 协商缓存都没有用例。
 */
import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';
import { SECURITY_HEADERS } from '@stockin/shared';
import type { Env } from '../src/env';
import { HealthService } from '../src/services/health.service';
import { assertStaticRootSafe, createSpaFallback, type IndexDocument } from '../src/static';
import type { AppEnv } from '../src/types/hono';

describe('HealthService', () => {
  it('初始为 not-ready：check 返回状态对象，isReady 为 false', () => {
    const health = new HealthService();
    expect(health.stateNow()).toBe('not-ready');
    expect(health.check()).toEqual({ status: 'not-ready' });
    expect(health.isReady()).toBe(false);
  });

  it('markReady 后可应答 ok；markNotReady 可退回（停机前语义）', () => {
    const health = new HealthService();
    health.markReady();
    expect(health.stateNow()).toBe('ok');
    expect(health.check()).toEqual({ status: 'ok' });
    expect(health.isReady()).toBe(true);

    health.markNotReady();
    expect(health.stateNow()).toBe('not-ready');
    expect(health.isReady()).toBe(false);
  });
});

function fakeEnv(dirs: {
  readonly dataDir?: string;
  readonly backupDir?: string;
  readonly tmpDir?: string;
}): Env {
  return {
    dataDir: dirs.dataDir ?? 'C:/srv/stockin/data',
    backupDir: dirs.backupDir ?? 'C:/srv/stockin/backups',
    tmpDir: dirs.tmpDir ?? 'C:/srv/stockin/tmp',
  } as unknown as Env;
}

describe('assertStaticRootSafe', () => {
  const staticRoot = 'C:/srv/stockin/web';

  it('三卷都在静态根之外 → 放行', () => {
    expect(() => assertStaticRootSafe(fakeEnv({}), staticRoot)).not.toThrow();
  });

  it('DATA_DIR / BACKUP_DIR / TMP_DIR 任一落在静态根内 → 抛错并点名变量', () => {
    expect(() =>
      assertStaticRootSafe(fakeEnv({ dataDir: 'C:/srv/stockin/web/data' }), staticRoot),
    ).toThrow(/DATA_DIR/);
    expect(() =>
      assertStaticRootSafe(fakeEnv({ backupDir: 'C:/srv/stockin/web/backups' }), staticRoot),
    ).toThrow(/BACKUP_DIR/);
    expect(() =>
      assertStaticRootSafe(fakeEnv({ tmpDir: 'C:/srv/stockin/web/tmp' }), staticRoot),
    ).toThrow(/TMP_DIR/);
  });

  it('静态根本身就是某卷目录 → 同样拒绝（相对路径为空也算在内）', () => {
    expect(() => assertStaticRootSafe(fakeEnv({ dataDir: staticRoot }), staticRoot)).toThrow(
      /DATA_DIR/,
    );
  });
});

interface FakeContextOptions {
  readonly requestId?: string;
  readonly ifNoneMatch?: string;
}

function fakeContext(options: FakeContextOptions = {}): Context<AppEnv> {
  return {
    get: (key: string): unknown => (key === 'requestId' ? options.requestId : undefined),
    req: {
      header: (name: string): string | undefined =>
        name.toLowerCase() === 'if-none-match' ? options.ifNoneMatch : undefined,
    },
  } as unknown as Context<AppEnv>;
}

describe('createSpaFallback', () => {
  const document: IndexDocument = { html: '<html>spa</html>', etag: '"etag-1"' };

  it('无 If-None-Match → 200 返回 index.html，带 ETag 与 no-cache', async () => {
    const response = createSpaFallback(document)(fakeContext({ requestId: 'req-1' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe(SECURITY_HEADERS.CACHE_CONTROL_INDEX_HTML);
    expect(response.headers.get('etag')).toBe('"etag-1"');
    expect(response.headers.get('x-request-id')).toBe('req-1');
    expect(await response.text()).toBe(document.html);
  });

  it('没有 requestId 时不发 x-request-id（不写空串）', () => {
    const response = createSpaFallback(document)(fakeContext());
    expect(response.headers.get('x-request-id')).toBeNull();
  });

  it('If-None-Match 命中 → 304 且无响应体', async () => {
    const response = createSpaFallback(document)(
      fakeContext({ requestId: 'req-2', ifNoneMatch: '"etag-1"' }),
    );
    expect(response.status).toBe(304);
    expect(await response.text()).toBe('');
  });

  it('If-None-Match 不匹配 → 正常 200', () => {
    const response = createSpaFallback(document)(fakeContext({ ifNoneMatch: '"other"' }));
    expect(response.status).toBe(200);
  });
});
