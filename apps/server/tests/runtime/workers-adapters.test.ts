/**
 * Workers 运行时端口实现的单元测试（发布审查 P1-3）。
 *
 * 这几块代码只能在 workerd 里跑到完整链路，但它们**不是**不能测：
 *  - `workerEnvOverrides` 是纯映射，错了就是线上 403 或端口错位；
 *  - PITR 备份端口的第一契约是「绝不假装成功」，这条必须由测试钉住；
 *  - 内存工作簿读取器与 `[assets]` 静态端口都能用假绑定验证。
 *
 * 真正的平台能力（DO storage、真实 assets 绑定）仍由 `wrangler dev`
 * 端到端脚本覆盖，这里只钉住与平台无关的那部分逻辑。
 */
import ExcelJS from 'exceljs';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { stringVars, workerEnvOverrides } from '../../src/runtime/workers/env';
import { PITR_SKIP_REASON, createPitrBackupPort } from '../../src/runtime/workers/backup.pitr';
import { createMemoryWorkbookReader } from '../../src/runtime/workers/workbook.memory';
import {
  createAssetsStaticPort,
  readIndexDocumentFromAssets,
  type AssetsBinding,
} from '../../src/runtime/workers/static.assets';
import type { Db } from '../../src/repositories/db';

describe('workerEnvOverrides', () => {
  it('只取字符串绑定，忽略 Durable Object / ASSETS 等非字符串绑定', () => {
    const vars: Record<string, string> = stringVars({
      PORT: '8787',
      TZ: 'Asia/Shanghai',
      STOCKIN_DO: { idFromName: () => ({}) },
      ASSETS: { fetch: () => Promise.resolve(new Response(null)) },
      FLAG: 42,
    });
    expect(vars).toEqual({ PORT: '8787', TZ: 'Asia/Shanghai' });
  });

  it('映射出 loadEnv 需要的 7 项，并去掉首尾空白；空串视为未设置', () => {
    const overrides = workerEnvOverrides({
      PORT: ' 8787 ',
      PUBLIC_ORIGINS: 'https://a.example.workers.dev',
      PUBLIC_ORIGIN: '   ',
      TZ: 'Asia/Shanghai',
      ORIGIN_SCHEME: 'https',
      COOKIE_SECURE: 'true',
      NODE_ENV: 'production',
    });
    expect(overrides).toEqual({
      port: '8787',
      publicOrigins: 'https://a.example.workers.dev',
      publicOrigin: undefined,
      tz: 'Asia/Shanghai',
      originScheme: 'https',
      cookieSecure: 'true',
      nodeEnv: 'production',
    });
  });

  it('不映射目录类变量（Workers 没有持久盘，传进去只会制造假配置）', () => {
    const overrides = workerEnvOverrides({
      DATA_DIR: '/app/data',
      BACKUP_DIR: '/app/backups',
      TMP_DIR: '/app/tmp',
      WEB_DIST_DIR: '/app/apps/web/dist',
    });
    expect(overrides).toEqual({
      port: undefined,
      publicOrigins: undefined,
      publicOrigin: undefined,
      tz: undefined,
      originScheme: undefined,
      cookieSecure: undefined,
      nodeEnv: undefined,
    });
  });
});

describe('PITR 备份端口', () => {
  it('create 恒返回 skipped 且带明确原因，绝不伪装成功', async () => {
    const port = createPitrBackupPort({ keepCount: 7 });
    expect(port.mode).toBe('pitr');
    expect(port.keepCount).toBe(7);
    const result = await port.create({} as Db, {
      reason: 'manual',
      initState: 1,
      minFreeBytes: 0,
      keepCount: 7,
    });
    expect(result).toEqual({ status: 'skipped', reason: PITR_SKIP_REASON });
    expect(port.list()).toEqual([]);
  });
});

describe('内存工作簿读取器', () => {
  it('能从内存字节读出工作簿（Workers 没有持久临时文件）', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('进货记录');
    sheet.addRow(['商品名称', '进货日期']);
    sheet.addRow(['内存读取', '2026-11-10']);
    const buffer: Buffer = Buffer.from((await workbook.xlsx.writeBuffer()) as ArrayBuffer);

    const reader = createMemoryWorkbookReader();
    const read = await reader(buffer);
    expect(read.worksheets).toHaveLength(1);
    expect(read.worksheets[0]?.getRow(2).getCell(1).value).toBe('内存读取');
  });
});

describe('[assets] 静态端口', () => {
  function fakeAssets(html: string, present: boolean): AssetsBinding {
    return {
      fetch(request: Request): Promise<Response> {
        if (present && request.url.endsWith('/index.html')) {
          return Promise.resolve(
            new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
          );
        }
        return Promise.resolve(new Response('not found', { status: 404 }));
      },
    };
  }

  const HTML =
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>进货统计</title></head><body><div id="root"></div></body></html>';

  it('index 文档与 ETag 取自 assets 绑定', async () => {
    const doc = await readIndexDocumentFromAssets(fakeAssets(HTML, true));
    expect(doc.html).toBe(HTML);
    expect(doc.etag).toMatch(/^"[0-9a-f]{24}"$/);
  });

  it('取不到 index.html 时退到兜底页而不是启动失败', async () => {
    const doc = await readIndexDocumentFromAssets(fakeAssets('', false));
    expect(doc.html).toContain('id="root"');
    expect(doc.etag).toMatch(/^"[0-9a-f]{24}"$/);
  });

  it('中间件：/api/* 直接交给 Hono，命中资源则复制响应，未命中则 next()', async () => {
    const port = await createAssetsStaticPort(fakeAssets(HTML, true));
    const app = new Hono();
    app.use('*', port.middleware());
    app.get('/api/health', (c) => c.json({ ok: true }));
    app.notFound((c) => c.text('spa-fallback', 404));

    const api = await app.request('/api/health');
    expect(api.status).toBe(200);
    expect(await api.json()).toEqual({ ok: true });

    const served = await app.request('/index.html');
    expect(served.status).toBe(200);
    expect(await served.text()).toBe(HTML);

    const missing = await app.request('/records');
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('spa-fallback');
  });
});
