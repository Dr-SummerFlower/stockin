/**
 * 进货单（批次）的 HTTP 层集成测试。
 *
 * 覆盖 `.tmp/to-do/02-接口实现.md` B-11 的清单：建单、原子性、幂等、单号生成、
 * 列表筛选、详情 404、软删连带明细、`RecordView.order` 三处带出、
 * suggestions 的供货商优先、product-names 去重，以及回收站恢复时的单据联动
 * （B-13 方案 A）。
 *
 * 定点数口径：unitPrice ×1e4、quantity ×1e3、amountCents ×1e2，
 * 因此 12000 / 2000 = 1.2 × 2 = 2.4 元 = 240 分。
 */
import * as ExcelJS from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../support/harness';
import { RecordRepository } from '../../src/repositories/record.repository';
import { serverToday } from '../../src/lib/today';

let harness: Harness | null = null;

afterEach(() => {
  harness?.close();
  harness = null;
});

interface OrderView {
  readonly id: number;
  readonly orderNo: string;
  readonly supplier: string;
  readonly purchaseDate: string;
  readonly remark: string | null;
  readonly itemCount: number;
  readonly totalQuantity: number;
  readonly totalAmountCents: number;
  readonly version: number;
  readonly duplicatedNo?: boolean;
}

interface RecordView {
  readonly id: number;
  readonly name: string;
  readonly order?: { id: number; orderNo: string; supplier: string } | null;
  readonly deletedAt: string | null;
}

/** 一条合法明细（1.2 元 × 2 件 = 2.4 元 = 240 分）。 */
function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '整单啤酒',
    purchaseDate: '2026-11-10',
    productionDate: null,
    shelfLifeValue: null,
    shelfLifeUnit: null,
    expiryDate: null,
    spec: null,
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

let keySeq = 0;
function nextKey(): string {
  keySeq += 1;
  return `order-key-${keySeq}`;
}

/** 整单载荷；`items` 缺省给一条合法明细。 */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    supplier: '红星批发部',
    purchaseDate: '2026-11-25',
    remark: null,
    items: [item()],
    idempotencyKey: nextKey(),
    ...overrides,
  };
}

async function ready(): Promise<{ h: Harness; cookie: string }> {
  harness = await createHarness();
  const cookie: string = await harness.completeSetup('owner', 'Temp-Pass-2026-11-x9');
  return { h: harness, cookie };
}

function scalar(h: Harness, sql: string, ...params: unknown[]): number {
  const row = h.deps.db.prepare(sql).get(...params) as { c: number } | undefined;
  return row?.c ?? 0;
}

describe('建单', () => {
  it('201 + 单号/汇总正确，明细落在同一张单下', async () => {
    const { h, cookie } = await ready();
    const created = await h.json<OrderView>('/api/orders', {
      json: payload({
        orderNo: '20261125001',
        items: [
          item({ name: '整单甲' }),
          item({ name: '整单乙', quantity: 1_000, amountCents: 120 }),
        ],
      }),
      cookie,
    });

    expect(created.status).toBe(201);
    expect(created.body.orderNo).toBe('20261125001');
    expect(created.body.supplier).toBe('红星批发部');
    expect(created.body.itemCount).toBe(2);
    expect(created.body.totalQuantity).toBe(3_000);
    expect(created.body.totalAmountCents).toBe(360);
    expect(created.body.version).toBe(1);

    const sameOrder: number = scalar(
      h,
      'SELECT COUNT(*) AS c FROM records WHERE order_id = ? AND deleted_at IS NULL',
      created.body.id,
    );
    expect(sameOrder).toBe(2);
  });

  it('明细第 2 条不合法时 422 带 index，且库里不留半张单', async () => {
    const { h, cookie } = await ready();
    const rejected = await h.json<{ code: string; details: { index: number } }>('/api/orders', {
      json: payload({
        items: [item({ name: '好的' }), item({ name: '错的', amountCents: 999 })],
      }),
      cookie,
    });

    expect(rejected.status).toBe(422);
    expect(rejected.body.code).toBe('VALID_FAILED');
    expect(rejected.body.details.index).toBe(1);
    expect(scalar(h, 'SELECT COUNT(*) AS c FROM purchase_orders')).toBe(0);
    expect(scalar(h, 'SELECT COUNT(*) AS c FROM records')).toBe(0);
  });

  it('明细条数超上限时 422 且 details.index=200', async () => {
    const { h, cookie } = await ready();
    const items = Array.from({ length: 201 }, (_, i) => item({ name: `商品${i}` }));
    const rejected = await h.json<{ code: string; details: { index?: number } }>('/api/orders', {
      json: payload({ items }),
      cookie,
    });
    expect(rejected.status).toBe(422);
    expect(rejected.body.code).toBe('VALID_FAILED');
    expect(rejected.body.details.index).toBe(200);
    expect(scalar(h, 'SELECT COUNT(*) AS c FROM purchase_orders')).toBe(0);
  });

  it('分页参数非整数时 422（parseInt 截断回归）', async () => {
    const { h, cookie } = await ready();
    const fractional = await h.json('/api/orders?page=1.5&pageSize=20', { cookie });
    const trailing = await h.json('/api/orders?pageSize=20abc', { cookie });
    expect(fractional.status).toBe(422);
    expect(trailing.status).toBe(422);
  });

  it('同一幂等键重复提交只建一张单，两次响应一致', async () => {
    const { h, cookie } = await ready();
    const body = payload({ idempotencyKey: 'same-key-1' });
    const first = await h.json<OrderView>('/api/orders', { json: body, cookie });
    const second = await h.json<OrderView>('/api/orders', { json: body, cookie });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.orderNo).toBe(first.body.orderNo);
    expect(scalar(h, 'SELECT COUNT(*) AS c FROM purchase_orders')).toBe(1);
  });

  it('单号重复允许保存，但回带 duplicatedNo', async () => {
    const { h, cookie } = await ready();
    const first = await h.json<OrderView>('/api/orders', {
      json: payload({ orderNo: '纸-001' }),
      cookie,
    });
    const second = await h.json<OrderView>('/api/orders', {
      json: payload({ orderNo: '纸-001', items: [item({ name: '重复号商品' })] }),
      cookie,
    });

    expect(first.body.duplicatedNo).toBe(false);
    expect(second.status).toBe(201);
    expect(second.body.duplicatedNo).toBe(true);
    expect(scalar(h, 'SELECT COUNT(*) AS c FROM purchase_orders')).toBe(2);
  });
});

describe('单号生成', () => {
  it('同日三张单依次 001/002/003，删掉中间/最后一张后都不复用已删号', async () => {
    const { h, cookie } = await ready();
    const first = await h.json<OrderView>('/api/orders', { json: payload(), cookie });
    const second = await h.json<OrderView>('/api/orders', { json: payload(), cookie });
    const third = await h.json<OrderView>('/api/orders', { json: payload(), cookie });

    expect([first.body.orderNo, second.body.orderNo, third.body.orderNo]).toEqual([
      '20261125001',
      '20261125002',
      '20261125003',
    ]);

    const next = await h.json<{ orderNo: string }>('/api/orders/next-no?date=2026-11-25', {
      cookie,
    });
    expect(next.body.orderNo).toBe('20261125004');

    // 删中间一张（002）：最大号仍是 003，下一单必须继续到 004（06-P2-19）。
    await h.json(`/api/orders/${second.body.id}`, { method: 'DELETE', cookie });
    const afterMiddle = await h.json<OrderView>('/api/orders', { json: payload(), cookie });
    expect(afterMiddle.body.orderNo).toBe('20261125004');

    // 再删最后一张（004）：同样不复用。
    await h.json(`/api/orders/${afterMiddle.body.id}`, { method: 'DELETE', cookie });
    const fifth = await h.json<OrderView>('/api/orders', { json: payload(), cookie });
    expect(fifth.body.orderNo).toBe('20261125005');
  });

  it('非法日期返回 422', async () => {
    const { h, cookie } = await ready();
    const bad = await h.json<{ code: string }>('/api/orders/next-no?date=2026-02-30', { cookie });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('VALID_FAILED');
  });
});

describe('列表与详情', () => {
  it('按供货商 / 日期 / 商品名筛选，汇总字段与明细一致', async () => {
    const { h, cookie } = await ready();
    await h.json('/api/orders', {
      json: payload({
        supplier: '红星批发部',
        purchaseDate: '2026-11-20',
        items: [item({ name: '龙口粉丝' }), item({ name: '飞天粉丝' })],
      }),
      cookie,
    });
    await h.json('/api/orders', {
      json: payload({
        supplier: '蓝天批发部',
        purchaseDate: '2026-11-24',
        items: [item({ name: '矿泉水' })],
      }),
      cookie,
    });

    const bySupplier = await h.json<{ total: number; items: OrderView[] }>(
      '/api/orders?supplier=红星',
      { cookie },
    );
    expect(bySupplier.body.total).toBe(1);
    expect(bySupplier.body.items[0]?.itemCount).toBe(2);
    expect(bySupplier.body.items[0]?.totalAmountCents).toBe(480);

    const byDate = await h.json<{ total: number; items: OrderView[] }>(
      '/api/orders?purchaseDateFrom=2026-11-21&purchaseDateTo=2026-11-30',
      { cookie },
    );
    expect(byDate.body.total).toBe(1);
    expect(byDate.body.items[0]?.supplier).toBe('蓝天批发部');

    const byProduct = await h.json<{ total: number; items: OrderView[] }>('/api/orders?q=粉丝', {
      cookie,
    });
    expect(byProduct.body.total).toBe(1);
    // 同一张单里两条明细都命中时不能被 join 放大成两行。
    expect(byProduct.body.items).toHaveLength(1);
    expect(byProduct.body.items[0]?.itemCount).toBe(2);

    const byNo = await h.json<{ total: number }>('/api/orders?q=20261124001', { cookie });
    expect(byNo.body.total).toBe(1);
  });

  it('详情包含明细，已软删单据返回 404', async () => {
    const { h, cookie } = await ready();
    const created = await h.json<OrderView>('/api/orders', {
      json: payload({
        remark: '含赠品 2 箱',
        items: [item({ name: '甲货' }), item({ name: '乙货' })],
      }),
      cookie,
    });

    const detail = await h.json<OrderView & { items: RecordView[] }>(
      `/api/orders/${created.body.id}`,
      { cookie },
    );
    expect(detail.status).toBe(200);
    expect(detail.body.remark).toBe('含赠品 2 箱');
    expect(detail.body.items.map((row) => row.name)).toEqual(['甲货', '乙货']);
    // 明细自身也带所属单据引用。
    expect(detail.body.items[0]?.order?.orderNo).toBe(created.body.orderNo);

    await h.json(`/api/orders/${created.body.id}`, { method: 'DELETE', cookie });
    const gone = await h.json<{ code: string }>(`/api/orders/${created.body.id}`, { cookie });
    expect(gone.status).toBe(404);
    expect(gone.body.code).toBe('COMMON_NOT_FOUND');
  });
});

describe('删除与回收站', () => {
  it('软删整单连带明细进回收站，回收站里能看到所属单据', async () => {
    const { h, cookie } = await ready();
    const created = await h.json<OrderView>('/api/orders', {
      json: payload({
        items: [item({ name: '甲货' }), item({ name: '乙货' }), item({ name: '丙货' })],
      }),
      cookie,
    });

    const removed = await h.json<{ id: number; deletedRecords: number }>(
      `/api/orders/${created.body.id}`,
      { method: 'DELETE', cookie },
    );
    expect(removed.status).toBe(200);
    expect(removed.body.deletedRecords).toBe(3);

    const trash = await h.json<{ total: number; items: RecordView[] }>('/api/trash', { cookie });
    expect(trash.body.total).toBe(3);
    expect(trash.body.items[0]?.order?.orderNo).toBe(created.body.orderNo);
    expect(trash.body.items[0]?.order?.supplier).toBe('红星批发部');

    // 再次删除已删单据 → 404。
    const again = await h.json<{ code: string }>(`/api/orders/${created.body.id}`, {
      method: 'DELETE',
      cookie,
    });
    expect(again.status).toBe(404);
  });

  it('恢复其中 1 条明细时，所属单据自动复活（方案 A）', async () => {
    const { h, cookie } = await ready();
    const created = await h.json<OrderView>('/api/orders', {
      json: payload({ items: [item({ name: '甲货' }), item({ name: '乙货' })] }),
      cookie,
    });
    await h.json(`/api/orders/${created.body.id}`, { method: 'DELETE', cookie });

    const trash = await h.json<{ items: RecordView[] }>('/api/trash', { cookie });
    const one = trash.body.items[0];
    expect(one).toBeDefined();
    const restored = await h.json<{ id: number }>(`/api/trash/${one?.id}/restore`, {
      method: 'POST',
      cookie,
    });
    expect(restored.status).toBe(200);

    const detail = await h.json<OrderView & { items: RecordView[] }>(
      `/api/orders/${created.body.id}`,
      { cookie },
    );
    expect(detail.status).toBe(200);
    expect(detail.body.items).toHaveLength(1);
    // 汇总随明细变化（聚合查询，不需要额外维护）。
    expect(detail.body.itemCount).toBe(1);

    // 另一条仍在回收站。
    const stillTrash = await h.json<{ total: number }>('/api/trash', { cookie });
    expect(stillTrash.body.total).toBe(1);
  });

  it('单条删除明细后单据还在，品种数变小', async () => {
    const { h, cookie } = await ready();
    const created = await h.json<OrderView>('/api/orders', {
      json: payload({ items: [item({ name: '甲货' }), item({ name: '乙货' })] }),
      cookie,
    });
    const detail = await h.json<{ items: RecordView[] }>(`/api/orders/${created.body.id}`, {
      cookie,
    });
    const firstItemId: number = detail.body.items[0]?.id ?? 0;
    const removed = await h.json(`/api/records/${firstItemId}`, { method: 'DELETE', cookie });
    expect(removed.status).toBe(200);

    const after = await h.json<OrderView>(`/api/orders/${created.body.id}`, { cookie });
    expect(after.body.itemCount).toBe(1);
  });

  it('单据软删后彻底删除其明细，明细物理消失且不可恢复（06-P2-17）', async () => {
    const { h, cookie } = await ready();
    const created = await h.json<OrderView>('/api/orders', {
      json: payload({ items: [item({ name: '甲货' }), item({ name: '乙货' })] }),
      cookie,
    });
    await h.json(`/api/orders/${created.body.id}`, { method: 'DELETE', cookie });

    const trash = await h.json<{ items: RecordView[] }>('/api/trash', { cookie });
    const ids: number[] = trash.body.items.map((row: RecordView): number => row.id);
    expect(ids).toHaveLength(2);
    const purged = await h.json<{ purged: number }>('/api/trash/batch-purge', {
      method: 'POST',
      json: { ids },
      cookie,
    });
    expect(purged.status).toBe(200);
    expect(purged.body.purged).toBe(2);

    expect(scalar(h, 'SELECT COUNT(*) AS c FROM records')).toBe(0);
    const restore = await h.json(`/api/trash/${ids[0]}/restore`, { method: 'POST', cookie });
    expect(restore.status).toBe(404);
  });
});

describe('记录视图带出单据', () => {
  it('列表 / 详情带出 order，散记不带', async () => {
    const { h, cookie } = await ready();
    const created = await h.json<OrderView>('/api/orders', {
      json: payload({ items: [item({ name: '单内商品' })] }),
      cookie,
    });
    const loose = await h.json<RecordView>('/api/records', {
      json: item({ name: '散记商品' }),
      cookie,
    });

    const list = await h.json<{ items: RecordView[] }>('/api/records?pageSize=50', { cookie });
    const inOrder = list.body.items.find((row) => row.name === '单内商品');
    const scattered = list.body.items.find((row) => row.name === '散记商品');
    expect(inOrder?.order?.orderNo).toBe(created.body.orderNo);
    expect(inOrder?.order?.supplier).toBe('红星批发部');
    expect(scattered?.order ?? null).toBeNull();

    const one = await h.json<RecordView>(`/api/records/${loose.body.id}`, { cookie });
    expect(one.body.order ?? null).toBeNull();

    // B-11 第 8 条正例：`/api/records/:id` 单条详情也带单据（06-P2-14）。
    const fromOrder = await h.json<RecordView>(`/api/records/${inOrder?.id}`, { cookie });
    expect(fromOrder.status).toBe(200);
    expect(fromOrder.body.order?.orderNo).toBe(created.body.orderNo);
    expect(fromOrder.body.order?.supplier).toBe('红星批发部');
  });
});

describe('建议与商品名清单', () => {
  it('suggestions 传 supplier 时优先该供货商的价，没有则回退全局', async () => {
    const { h, cookie } = await ready();
    // A 家更早更便宜，B 家更晚更贵。
    await h.json('/api/orders', {
      json: payload({
        supplier: 'A 家',
        purchaseDate: '2026-11-01',
        items: [item({ name: '可口可乐', unitPrice: 10_000, amountCents: 200 })],
      }),
      cookie,
    });
    await h.json('/api/orders', {
      json: payload({
        supplier: 'B 家',
        purchaseDate: '2026-11-05',
        items: [item({ name: '可口可乐', unitPrice: 20_000, amountCents: 400 })],
      }),
      cookie,
    });

    interface SuggestionResponse {
      items: {
        value: string;
        unitPrice: number | null;
        lastPurchaseDate?: string | null;
        matchedSupplier?: boolean;
      }[];
    }

    const fromA = await h.json<SuggestionResponse>(
      '/api/records/suggestions?field=name&q=可乐&supplier=A 家',
      { cookie },
    );
    expect(fromA.body.items).toHaveLength(1);
    expect(fromA.body.items[0]?.unitPrice).toBe(10_000);
    expect(fromA.body.items[0]?.matchedSupplier).toBe(true);
    expect(fromA.body.items[0]?.lastPurchaseDate).toBe('2026-11-01');

    const fromC = await h.json<SuggestionResponse>(
      '/api/records/suggestions?field=name&q=可乐&supplier=C 家',
      { cookie },
    );
    expect(fromC.body.items[0]?.unitPrice).toBe(20_000);
    expect(fromC.body.items[0]?.matchedSupplier).toBe(false);
  });

  it('product-names 一个名称只出现一次，按最近进货倒序', async () => {
    const { h, cookie } = await ready();
    await h.json('/api/records', {
      json: item({ name: '龙口粉丝', purchaseDate: '2026-11-10' }),
      cookie,
    });
    await h.json('/api/records', {
      json: item({ name: '龙口粉丝', purchaseDate: '2026-11-18', spec: '200g/袋' }),
      cookie,
    });
    await h.json('/api/records', {
      json: item({ name: '矿泉水', purchaseDate: '2026-11-12' }),
      cookie,
    });

    const names = await h.json<{
      items: { name: string; spec: string | null; lastPurchaseDate: string | null }[];
    }>('/api/records/product-names?limit=10', { cookie });

    expect(names.status).toBe(200);
    expect(names.body.items.map((row) => row.name)).toEqual(['龙口粉丝', '矿泉水']);
    expect(names.body.items[0]?.spec).toBe('200g/袋');
    expect(names.body.items[0]?.lastPurchaseDate).toBe('2026-11-18');
  });

  it('product-names 传 supplier：只给该供货商的货，价/日期取该供货商最近一次', async () => {
    const { h, cookie } = await ready();
    // 同一商品两家都进过；A 家自己还有两条，近的一条更贵；散记里有一条更晚的。
    await h.json('/api/orders', {
      json: payload({
        supplier: 'A 家',
        orderNo: '20261110001',
        purchaseDate: '2026-11-10',
        items: [
          item({ name: '龙口粉丝', spec: '100g/袋', unitPrice: 10_000, amountCents: 200 }),
          item({ name: '只有A有的货', unitPrice: 30_000, amountCents: 600 }),
        ],
      }),
      cookie,
    });
    await h.json('/api/orders', {
      json: payload({
        supplier: 'A 家',
        orderNo: '20261118001',
        purchaseDate: '2026-11-18',
        items: [item({ name: '龙口粉丝', spec: '200g/袋', unitPrice: 11_000, amountCents: 220 })],
      }),
      cookie,
    });
    await h.json('/api/orders', {
      json: payload({
        supplier: 'B 家',
        orderNo: '20261120001',
        purchaseDate: '2026-11-20',
        items: [item({ name: '龙口粉丝', spec: '500g/袋', unitPrice: 20_000, amountCents: 400 })],
      }),
      cookie,
    });
    await h.json('/api/records', {
      json: item({
        name: '龙口粉丝',
        spec: '散装',
        purchaseDate: '2026-11-25',
        unitPrice: 99_000,
        amountCents: 1_980,
      }),
      cookie,
    });

    interface NamesResponse {
      items: {
        name: string;
        spec: string | null;
        unitPrice: number | null;
        lastPurchaseDate: string | null;
      }[];
    }

    const fromA = await h.json<NamesResponse>(
      `/api/records/product-names?limit=10&supplier=${encodeURIComponent('A 家')}`,
      { cookie },
    );
    expect(fromA.status).toBe(200);
    expect(fromA.body.items.map((row) => row.name)).toEqual(['龙口粉丝', '只有A有的货']);
    // 去重按该供货商范围内取最近一次，不能被 B 家或散记的价覆盖。
    expect(fromA.body.items[0]?.spec).toBe('200g/袋');
    expect(fromA.body.items[0]?.unitPrice).toBe(11_000);
    expect(fromA.body.items[0]?.lastPurchaseDate).toBe('2026-11-18');

    const fromB = await h.json<NamesResponse>(
      `/api/records/product-names?limit=10&supplier=${encodeURIComponent('B 家')}`,
      { cookie },
    );
    expect(fromB.status).toBe(200);
    // B 家没进过的名称不回退全局；散记同名也不算 B 家的货。
    expect(fromB.body.items).toHaveLength(1);
    expect(fromB.body.items[0]?.name).toBe('龙口粉丝');
    expect(fromB.body.items[0]?.unitPrice).toBe(20_000);
    expect(fromB.body.items[0]?.lastPurchaseDate).toBe('2026-11-20');

    const noSupplier = await h.json<NamesResponse>('/api/records/product-names?limit=10', {
      cookie,
    });
    expect(noSupplier.status).toBe(200);
    // 不传参数仍是全局最近一条（散记 11-25 的价），行为不变。
    expect(noSupplier.body.items[0]?.unitPrice).toBe(99_000);
    expect(noSupplier.body.items[0]?.lastPurchaseDate).toBe('2026-11-25');

    const nobody = await h.json<NamesResponse>(
      `/api/records/product-names?supplier=${encodeURIComponent('C 家')}`,
      { cookie },
    );
    expect(nobody.status).toBe(200);
    expect(nobody.body.items).toEqual([]);
  });

  it('product-names 的 supplier 归一化与查询边界', async () => {
    const { h, cookie } = await ready();
    await h.json('/api/orders', {
      json: payload({
        supplier: 'A 家',
        orderNo: '20261110001',
        purchaseDate: '2026-11-10',
        items: [item({ name: '归一化测试商品' })],
      }),
      cookie,
    });
    await h.json('/api/records', {
      json: item({ name: '归一化测试商品', purchaseDate: '2026-11-20' }),
      cookie,
    });

    interface NamesResponse {
      items: { name: string; lastPurchaseDate: string | null }[];
    }
    // 与 suggestions 共用 normalizeName：全角/空白归一后命中同一张单。
    const normalized = await h.json<NamesResponse>(
      `/api/records/product-names?supplier=${encodeURIComponent(' Ａ 家 ')}`,
      { cookie },
    );
    expect(normalized.body.items[0]?.lastPurchaseDate).toBe('2026-11-10');

    // 空白串按未传处理，仍取全局最近一条。
    const blank = await h.json<NamesResponse>(
      `/api/records/product-names?supplier=${encodeURIComponent('   ')}`,
      { cookie },
    );
    expect(blank.body.items[0]?.lastPurchaseDate).toBe('2026-11-20');

    const tooMany = await h.json<{ code: string }>('/api/records/product-names?limit=1001', {
      cookie,
    });
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.code).toBe('VALID_FAILED');

    const upperBound = await h.json<NamesResponse>(
      `/api/records/product-names?limit=1000&supplier=${encodeURIComponent('A 家')}`,
      { cookie },
    );
    expect(upperBound.status).toBe(200);

    const tooLong = await h.json<{ code: string }>(
      `/api/records/product-names?supplier=${encodeURIComponent('x'.repeat(101))}`,
      { cookie },
    );
    expect(tooLong.status).toBe(422);
    expect(tooLong.body.code).toBe('VALID_FAILED');
  });
});

describe('路由边界', () => {
  it('非法 id 返回 400，未登录返回 401', async () => {
    const { h, cookie } = await ready();
    expect((await h.json('/api/orders/abc', { cookie })).status).toBe(400);
    expect((await h.json('/api/orders/1', { cookie: null })).status).toBe(401);
  });

  it('单头字段错误返回 422 且 details 不含明细 index', async () => {
    const { h, cookie } = await ready();
    const bad = await h.json<{ code: string; details: { index?: number } }>('/api/orders', {
      json: payload({ supplier: '   ' }),
      cookie,
    });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('VALID_FAILED');
    expect(bad.body.details.index).toBeUndefined();
  });
});

describe('统计口径', () => {
  it('建单与删单让仪表盘笔数同步增减，不额外改变口径', async () => {
    const { h, cookie } = await ready();
    const created = await h.json<OrderView>('/api/orders', {
      json: payload({ items: [item({ name: '统计甲' }), item({ name: '统计乙' })] }),
      cookie,
    });

    const before = await h.json<{ metrics: { totalRecords: number; totalAmountCents: number } }>(
      '/api/dashboard',
      { cookie },
    );
    expect(before.body.metrics.totalRecords).toBe(2);
    expect(before.body.metrics.totalAmountCents).toBe(480);

    await h.json(`/api/orders/${created.body.id}`, { method: 'DELETE', cookie });
    const after = await h.json<{ metrics: { totalRecords: number; totalAmountCents: number } }>(
      '/api/dashboard',
      { cookie },
    );
    expect(after.body.metrics.totalRecords).toBe(0);
    expect(after.body.metrics.totalAmountCents).toBe(0);
  });

  it('建单后 dashboard 与 aggregateSql 口径逐字段一致（06-P2-15）', async () => {
    const { h, cookie } = await ready();
    await h.json('/api/orders', {
      json: payload({
        items: [
          item({ name: '口径甲', expiryDate: '2026-12-10' }),
          item({ name: '口径乙', expiryDate: '2026-11-01' }),
          item({ name: '口径甲', expiryDate: null }),
        ],
      }),
      cookie,
    });

    const dashboard = await h.json<{ metrics: Record<string, number>; thresholdDays: number }>(
      '/api/dashboard',
      { cookie },
    );
    const expected = new RecordRepository(h.deps.db).aggregateSql(
      serverToday(),
      dashboard.body.thresholdDays,
    );
    expect(dashboard.body.metrics).toEqual(expected);
  });
});

describe('单据导出', () => {
  it('导出汇总 xlsx：7 列、一单一行、金额换算成元', async () => {
    const { h, cookie } = await ready();
    await h.json('/api/orders', {
      json: payload({
        supplier: '导出甲',
        items: [
          item({ quantity: 2000, unitPrice: 12000, amountCents: 240 }),
          item({ name: '整单啤酒乙', quantity: 3000, unitPrice: 5000, amountCents: 150 }),
        ],
      }),
      cookie,
    });

    const response: Response = await h.request('/api/orders/export', { cookie });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('spreadsheetml');
    expect(response.headers.get('content-disposition')).toContain('stockin-orders.xlsx');

    const buffer: Buffer = Buffer.from(await response.arrayBuffer());
    expect(buffer.byteLength).toBeGreaterThan(1000);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];
    expect(sheet.name).toBe('进货单');
    expect(sheet.getRow(1).values).toMatchObject([
      undefined,
      '单据编号',
      '供货商',
      '进货日期',
      '品种数',
      '数量合计',
      '金额合计',
      '录入时间',
    ]);
    // 只建了一张单，所以是表头 + 1 行
    expect(sheet.rowCount).toBe(2);
    const row = sheet.getRow(2);
    expect(row.getCell(2).value).toBe('导出甲');
    expect(row.getCell(4).value).toBe(2);
    // 2 件 + 3 件 = 5；2.40 + 1.50 = 3.90 元
    expect(row.getCell(5).value).toBe(5);
    expect(row.getCell(6).value).toBe(3.9);
  });

  it('导出的行受筛选条件约束（供货商）', async () => {
    const { h, cookie } = await ready();
    await h.json('/api/orders', { json: payload({ supplier: '导出甲' }), cookie });
    await h.json('/api/orders', { json: payload({ supplier: '导出乙' }), cookie });

    const response: Response = await h.request(
      `/api/orders/export?supplier=${encodeURIComponent('导出乙')}`,
      { cookie },
    );
    expect(response.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()) as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];
    expect(sheet.rowCount).toBe(2);
    expect(sheet.getRow(2).getCell(2).value).toBe('导出乙');
  });
});

describe('单张进货单打印版导出', () => {
  function detailItems(count: number): Record<string, unknown>[] {
    return Array.from({ length: count }, (_, index) => item({ name: `打印明细${index + 1}` }));
  }

  it('单页：输出完整单据，含明细区 10 行与打印设置', async () => {
    const { h, cookie } = await ready();
    const created = await h.json<{ id: number }>('/api/orders', {
      json: payload({ items: detailItems(8) }),
      cookie,
    });
    expect(created.status).toBe(201);

    const response: Response = await h.request(`/api/orders/${created.body.id}/export`, { cookie });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('.xlsx');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()) as unknown as ArrayBuffer);
    expect(workbook.worksheets.length).toBe(1);
    const sheet = workbook.getWorksheet('进货单-第1页');
    expect(sheet).toBeDefined();
    if (sheet === undefined) return;
    expect(sheet.getRow(1).getCell(1).value).toBe('进 货 单');
    expect(sheet.getRow(5).getCell(2).value).toBe('商品名称');
    expect(sheet.getRow(6).getCell(2).value).toBe('打印明细1');
    expect(sheet.getRow(13).getCell(2).value).toBe('打印明细8');
    expect(sheet.pageSetup?.orientation).toBe('landscape');
    expect(sheet.pageSetup?.fitToHeight).toBe(1);
  });

  it('多页：12 条拆两页，序号连续且末页给出整单总计', async () => {
    const { h, cookie } = await ready();
    const created = await h.json<{ id: number }>('/api/orders', {
      json: payload({ items: detailItems(12) }),
      cookie,
    });
    expect(created.status).toBe(201);

    const response: Response = await h.request(`/api/orders/${created.body.id}/export`, { cookie });
    expect(response.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()) as unknown as ArrayBuffer);
    expect(workbook.worksheets.length).toBe(2);
    const page1 = workbook.getWorksheet('进货单-第1页');
    const page2 = workbook.getWorksheet('进货单-第2页');
    expect(page1?.getRow(1).getCell(1).value).toBe('进 货 单　第 1 / 2 页');
    expect(page2?.getRow(1).getCell(1).value).toBe('进 货 单　第 2 / 2 页');
    expect(page1?.getRow(15).getCell(2).value).toBe('打印明细10');
    expect(page2?.getRow(6).getCell(2).value).toBe('打印明细11');
    expect(String(page2?.getRow(18).getCell(1).value ?? '')).toContain('整单总计：共 12 项');
  });

  it('单据不存在时返回 404', async () => {
    const { h, cookie } = await ready();
    const response: Response = await h.request('/api/orders/999999/export', { cookie });
    expect(response.status).toBe(404);
  });
});
