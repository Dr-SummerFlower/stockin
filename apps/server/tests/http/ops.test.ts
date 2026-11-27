/**
 * 大屏 / 设置 / 日志 / 备份 / Excel 的 HTTP 层集成测试（发布审查 P1-2）。
 *
 * Excel 三件事必须用**真文件**验证，mock 一律不算：模板字节是合法 xlsx、
 * 导出内容能被重新解析回来、非法表头**不落任何数据**（导入链「有 issue
 * 不开写事务」的核心约束，用记录条数不变来断言）。
 */
import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';
import { EXCEL_HEADER_TEXTS } from '@stockin/shared';
import { createHarness, type Harness } from '../support/harness';

let harness: Harness | null = null;

afterEach(() => {
  harness?.close();
  harness = null;
});

interface RecordView {
  readonly id: number;
  readonly name: string;
  readonly version: number;
}

async function ready(): Promise<{ h: Harness; cookie: string }> {
  harness = await createHarness();
  const cookie: string = await harness.completeSetup('owner', 'Temp-Pass-2026-11-x9');
  return { h: harness, cookie };
}

function recordPayload(
  name: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name,
    purchaseDate: '2026-11-10',
    productionDate: null,
    shelfLifeValue: null,
    shelfLifeUnit: null,
    expiryDate: null,
    spec: '散装',
    unitPrice: 12_000,
    quantity: 2_000,
    amountCents: 240,
    remark: null,
    sources: {
      productionDateSrc: 'EMPTY',
      shelfLifeSrc: 'EMPTY',
      expiryDateSrc: 'EMPTY',
      unitPriceSrc: 'MANUAL',
      quantitySrc: 'MANUAL',
      amountSrc: 'AUTO',
    },
    ...overrides,
  };
}

/** 用 exceljs 造一个导入用的工作簿；`headers` 可替换以构造非法表头。 */
async function buildWorkbook(
  rows: readonly (readonly string[])[],
  headers: readonly string[] = EXCEL_HEADER_TEXTS,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('进货记录');
  sheet.addRow([...headers]);
  for (const row of rows) {
    sheet.addRow([...row]);
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}

/** 合法的 10 列数据行（单价 3.0000 × 数量 2.000 = 金额 6.00）。 */
const VALID_ROW: readonly string[] = [
  '导入花卷',
  '2026-11-10',
  '',
  '30天',
  '',
  '散装',
  '3.0000',
  '2.000',
  '6.00',
  '',
];

function uploadBody(buffer: Buffer, filename = 'import.xlsx'): FormData {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(buffer)], filename));
  return form;
}

describe('统计大屏', () => {
  it('返回 8 项指标、阈值与基准日，且只统计有效记录', async () => {
    const { h, cookie } = await ready();
    await h.json('/api/records', { json: recordPayload('大屏一'), cookie });
    const second = await h.json<RecordView>('/api/records', {
      json: recordPayload('大屏二', { amountCents: 240 }),
      cookie,
    });
    // 软删的不计入指标。
    await h.json(`/api/records/${second.body.id}`, { method: 'DELETE', cookie });

    const dashboard = await h.json<{
      metrics: { totalRecords: number; totalAmountCents: number; distinctProducts: number };
      thresholdDays: number;
      baseDate: string;
      alerts: unknown[];
    }>('/api/dashboard', { cookie });
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.metrics.totalRecords).toBe(1);
    expect(dashboard.body.metrics.totalAmountCents).toBe(240);
    expect(dashboard.body.metrics.distinctProducts).toBe(1);
    expect(dashboard.body.thresholdDays).toBe(30);
    expect(dashboard.body.baseDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Array.isArray(dashboard.body.alerts)).toBe(true);

    const summary = await h.json<{ metrics: { totalRecords: number } }>('/api/stats/summary', {
      cookie,
    });
    expect(summary.body.metrics.totalRecords).toBe(1);

    const expiry = await h.json<{ alerts: unknown[]; thresholdDays: number }>('/api/stats/expiry', {
      cookie,
    });
    expect(expiry.body.thresholdDays).toBe(30);
    expect(expiry.body.alerts).toEqual([]);
  });
});

describe('设置与备份', () => {
  it('阈值读改写闭环，越界值返回 422', async () => {
    const { h, cookie } = await ready();
    const initial = await h.json<{ expiryThresholdDays: number }>('/api/settings', { cookie });
    expect(initial.body.expiryThresholdDays).toBe(30);

    const updated = await h.json<{ expiryThresholdDays: number }>('/api/settings', {
      method: 'PUT',
      json: { expiryThresholdDays: 45 },
      cookie,
    });
    expect(updated.status).toBe(200);
    expect(updated.body.expiryThresholdDays).toBe(45);

    const reread = await h.json<{ expiryThresholdDays: number }>('/api/settings', { cookie });
    expect(reread.body.expiryThresholdDays).toBe(45);

    const outOfRange = await h.json<{ code: string }>('/api/settings', {
      method: 'PUT',
      json: { expiryThresholdDays: 99_999 },
      cookie,
    });
    expect(outOfRange.status).toBe(422);
    expect(outOfRange.body.code).toBe('VALID_FAILED');
  });

  it('手动触发逻辑备份：返回 jobId，异步完成后列表可见（用户端无下载）', async () => {
    const { h, cookie } = await ready();
    const triggered = await h.json<{ jobId: string }>('/api/backup', {
      method: 'POST',
      cookie,
    });
    expect(triggered.status).toBe(200);
    expect(triggered.body.jobId).toMatch(/^job-/);

    // 驱动后台分块直到备份就绪。
    // 不能只看 `tick()` 的返回值：`runtime.start()` 已经把同一个 tick 注册进调度器
    // （enqueue 里 `schedule(25ms)`），撞车时本轮 tick 会立刻返回 false（服务侧重入
    // 保护），据此 break 会把「还在跑」误判成「已完成」。这里以 `/api/backups` 的
    // 可见结果为准：出现 ready 备份，或 job 已到终态（失败），就停止空转。
    for (let i = 0; i < 200; i += 1) {
      await h.deps.logicalBackup.tick(4);
      const state = await h.json<{ items: unknown[]; activeJob: unknown }>('/api/backups', {
        cookie,
      });
      if (state.body.items.length > 0 || state.body.activeJob === null) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }

    const list = await h.json<{
      items: { id: string; chunkCount: number; manifestSha256: string | null }[];
      keepCount: number;
      enabled: boolean;
      activeJob: unknown;
    }>('/api/backups', { cookie });
    expect(list.body.enabled).toBe(true);
    expect(list.body.keepCount).toBe(5);
    expect(list.body.activeJob).toBeNull();
    expect(list.body.items.length).toBeGreaterThan(0);
    expect(list.body.items[0]?.manifestSha256).toBeTruthy();
    // 用户端响应不含文件名 / 下载字段。
    expect(JSON.stringify(list.body)).not.toContain('gzipFile');
  });

  it('两路 tick 并发推进同一 job：不产生重复 seq，备份仍能就绪', async () => {
    const { h, cookie } = await ready();
    const triggered = await h.json<{ jobId: string }>('/api/backup', {
      method: 'POST',
      cookie,
    });
    expect(triggered.status).toBe(200);

    // 回归 AUDIT-13：此前 tick 无重入保护，两路同时推进会算出同一个 seq，
    // `backup_chunks` 主键冲突 → 冲突方 failJob 把健康备份标成 failed。
    for (let i = 0; i < 60; i += 1) {
      await Promise.all([h.deps.logicalBackup.tick(4), h.deps.logicalBackup.tick(4)]);
      const state = await h.json<{ items: unknown[]; activeJob: unknown }>('/api/backups', {
        cookie,
      });
      if (state.body.items.length > 0 || state.body.activeJob === null) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }

    const list = await h.json<{ items: { chunkCount: number }[]; activeJob: unknown }>(
      '/api/backups',
      { cookie },
    );
    expect(list.body.activeJob).toBeNull();
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]?.chunkCount).toBeGreaterThan(0);
  });
});

describe('操作日志', () => {
  it('记录 setup / 登录 / 设置变更；日常新增不写审计；支持按 action 过滤与分页', async () => {
    const { h, cookie } = await ready();
    // 日常新增记录不再写审计（精简口径），只有关键操作留下痕迹。
    await h.json('/api/records', { json: recordPayload('日志用'), cookie });
    // 设置变更属关键操作，仍写审计。
    await h.json('/api/settings', {
      method: 'PUT',
      json: { expiryThresholdDays: 30, shopName: '日志测试店' },
      cookie,
    });

    const all = await h.json<{ items: { action: string }[]; total: number }>(
      '/api/operation-logs?limit=50',
      { cookie },
    );
    expect(all.status).toBe(200);
    const actions: string[] = all.body.items.map((item) => item.action);
    expect(actions).toContain('SETUP_COMPLETE');
    expect(actions).toContain('LOGIN');
    expect(actions).toContain('SETTINGS_UPDATE');
    // 日常新增不产生审计记录。
    expect(actions).not.toContain('RECORD_CREATE');

    const filtered = await h.json<{ items: { action: string }[] }>(
      '/api/operation-logs?action=SETTINGS_UPDATE',
      { cookie },
    );
    expect(filtered.body.items.length).toBe(1);
    expect(filtered.body.items[0]?.action).toBe('SETTINGS_UPDATE');

    const paged = await h.json<{ items: unknown[]; limit: number; offset: number }>(
      '/api/operation-logs?limit=1&offset=1',
      { cookie },
    );
    expect(paged.body.items).toHaveLength(1);
    expect(paged.body.limit).toBe(1);
    expect(paged.body.offset).toBe(1);
  });
});

describe('Excel 模板与导出', () => {
  it('模板是合法 xlsx（ZIP 魔数 + 可解析表头），并带下载头', async () => {
    const { h, cookie } = await ready();
    const response = await h.request('/api/excel/template', { cookie });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(response.headers.get('content-disposition')).toContain('stockin-template.xlsx');
    expect(response.headers.get('cache-control')).toBe('no-store');

    const buffer: Buffer = Buffer.from(await response.arrayBuffer());
    expect(buffer.subarray(0, 2).toString('hex')).toBe('504b');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    const sheet = workbook.worksheets[0];
    expect(sheet?.rowCount).toBe(1);
    expect(sheet?.getRow(1).values).toEqual([undefined, ...EXCEL_HEADER_TEXTS]);
  });

  it('导出把当前记录写成可回读的 xlsx（表头 + 数据行）', async () => {
    const { h, cookie } = await ready();
    await h.json('/api/records', { json: recordPayload('导出啤酒'), cookie });

    const response = await h.request('/api/excel/export', {
      method: 'POST',
      json: { filter: {} },
      cookie,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('stockin-export.xlsx');

    const buffer: Buffer = Buffer.from(await response.arrayBuffer());
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    const sheet = workbook.worksheets[0];
    expect(sheet?.rowCount).toBe(2);
    expect(sheet?.getRow(2).getCell(1).value).toBe('导出啤酒');
  });

  it('命中行数超过平台上限时返回 413，且不产出文件', async () => {
    // Workers 的 buffer 写出把整份工作簿建在 isolate 内存里，超限必须在建表前拒绝；
    // 这里用 exportMaxRows:1 在 Node 上复现同一分支。
    harness = await createHarness({ exportMaxRows: 1 });
    const cookie: string = await harness.completeSetup('owner', 'Temp-Pass-2026-11-x9');
    await harness.json('/api/records', { json: recordPayload('上限一'), cookie });
    await harness.json('/api/records', {
      json: recordPayload('上限二', { purchaseDate: '2026-11-11' }),
      cookie,
    });

    const response = await harness.json<{
      code: string;
      details: { total: number; limit: number };
    }>('/api/excel/export', { method: 'POST', json: { filter: {} }, cookie });

    expect(response.status).toBe(413);
    expect(response.body.code).toBe('EXCEL_EXPORT_TOO_LARGE');
    expect(response.body.details).toMatchObject({ total: 2, limit: 1 });
    // 错误响应不能带附件头，否则前端会把 JSON 当文件保存。
    expect(response.headers.get('content-disposition')).toBeNull();
  });
});

describe('Excel 导入', () => {
  it('合法文件整批落库，返回逐行统计', async () => {
    const { h, cookie } = await ready();
    const buffer: Buffer = await buildWorkbook([VALID_ROW]);
    const response = await h.json<{
      totalRows: number;
      acceptedRows: number;
      rejectedRows: number;
      issues: unknown[];
    }>('/api/excel/import', { method: 'POST', body: uploadBody(buffer), cookie });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ totalRows: 1, acceptedRows: 1, rejectedRows: 0 });
    expect(response.body.issues).toEqual([]);

    const list = await h.json<{ total: number; items: RecordView[] }>('/api/records', { cookie });
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]?.name).toBe('导入花卷');
  });

  it('表头不一致返回 422 且一条都不落库（有 issue 不开写事务）', async () => {
    const { h, cookie } = await ready();
    const badHeaders: readonly string[] = EXCEL_HEADER_TEXTS.map((header, index) =>
      index === 0 ? '错误的表头' : header,
    );
    const buffer: Buffer = await buildWorkbook([VALID_ROW], badHeaders);
    const response = await h.json<{ code: string; details: { issues: { code: string }[] } }>(
      '/api/excel/import',
      { method: 'POST', body: uploadBody(buffer), cookie },
    );
    expect(response.status).toBe(422);
    // 表头不一致属于「行级不可导入」，错误码是 EXCEL_ROW_INVALID（同为 422）。
    expect(response.body.code).toBe('EXCEL_ROW_INVALID');
    expect(response.body.details.issues.length).toBeGreaterThan(0);

    const list = await h.json<{ total: number }>('/api/records', { cookie });
    expect(list.body.total).toBe(0);
  });

  it('缺 file 字段返回 400，非 xlsx 字节返回 400（EXCEL_UNSUPPORTED_FILE）', async () => {
    const { h, cookie } = await ready();
    const missing = await h.json<{ code: string }>('/api/excel/import', {
      method: 'POST',
      body: new FormData(),
      cookie,
    });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('COMMON_BAD_REQUEST');

    const garbage: FormData = new FormData();
    garbage.set('file', new File([new Uint8Array([1, 2, 3, 4, 5])], 'fake.xlsx'));
    const notZip = await h.json<{ code: string }>('/api/excel/import', {
      method: 'POST',
      body: garbage,
      cookie,
    });
    // 不是 ZIP 容器：EXCEL_UNSUPPORTED_FILE 映射 400（文件本身不合法，不是行错误）。
    expect(notZip.status).toBe(400);
    expect(notZip.body.code).toBe('EXCEL_UNSUPPORTED_FILE');
  });
});
