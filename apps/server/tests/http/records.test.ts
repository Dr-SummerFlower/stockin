/**
 * 记录 / 回收站的 HTTP 层集成测试（发布审查 P1-2）。
 *
 * 覆盖鉴权与引导两道守卫、增删改查全链路、八项判重、幂等键、金额一致性
 * 校验、分页筛选、批量软删 / 批量恢复 / 批量彻底删除。
 *
 * 定点数口径：unitPrice ×1e4、quantity ×1e3、amountCents ×1e2，
 * 因此 12000 / 2000 = 1.2 × 2 = 2.4 元 = 240 分。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { derivePasswordHash, generateSaltHex, serializeScryptParams } from '../../src/lib/crypto';
import { utcNowIso } from '../../src/lib/today';
import { createHarness, type Harness } from '../support/harness';

let harness: Harness | null = null;

afterEach(() => {
  harness?.close();
  harness = null;
});

/** 默认合法载荷（未过期的简单记录）。 */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '工人牌啤酒',
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

interface RecordView {
  readonly id: number;
  readonly name: string;
  readonly version: number;
  readonly amountCents: number;
  readonly expiryStatus: string;
}

/** 建好测试台并完成引导，返回可用 Cookie。 */
async function ready(): Promise<{ h: Harness; cookie: string }> {
  harness = await createHarness();
  const cookie: string = await harness.completeSetup('owner', 'Temp-Pass-2026-11-x9');
  return { h: harness, cookie };
}

describe('守卫链', () => {
  it('未登录访问业务端点返回 401，未知 /api 路径返回 JSON 404', async () => {
    harness = await createHarness();
    const denied = await harness.json<{ code: string }>('/api/records');
    expect(denied.status).toBe(401);
    expect(denied.body.code).toBe('AUTH_REQUIRED');

    const unknown = await harness.json<{ code: string }>('/api/nope');
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('COMMON_NOT_FOUND');
    expect(unknown.headers.get('content-type')).toContain('application/json');
  });

  it('有凭据但未完成 /setup 时业务端点返回 403（init guard 先于业务）', async () => {
    harness = await createHarness();
    // 模拟从 1.0.0 就地升级的老实例：凭据行已存在（is_initial=1），
    // 但 setup_completed 仍为 0。自助引导后新实例不会出现这种中间态。
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
    const cookie: string = await harness.login('legacy-pass-1');
    const blocked = await harness.json<{ code: string }>('/api/records', { cookie });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('AUTH_INIT_REQUIRED');

    // 白名单内的 init-status 仍然可达，否则首启无法引导。
    const status = await harness.json('/api/auth/init-status', { cookie });
    expect(status.status).toBe(200);
  });
});

describe('记录增删改查', () => {
  it('创建 → 读取 → 更新 → 软删 → 回收站恢复 的完整链路', async () => {
    const { h, cookie } = await ready();

    const created = await h.json<RecordView>('/api/records', { json: payload(), cookie });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe('工人牌啤酒');
    expect(created.body.amountCents).toBe(240);
    // 版本号从 1 起（首次写入即 1，更新后 +1）。
    expect(created.body.version).toBe(1);
    const id: number = created.body.id;

    const one = await h.json<RecordView>(`/api/records/${id}`, { cookie });
    expect(one.status).toBe(200);
    expect(one.body.id).toBe(id);

    const updated = await h.json<RecordView>(`/api/records/${id}`, {
      method: 'PUT',
      json: payload({ name: '工人牌啤酒（改）', version: 1 }),
      cookie,
    });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe('工人牌啤酒（改）');
    expect(updated.body.version).toBe(2);

    // 版本号过期必须冲突，不允许静默覆盖。
    const stale = await h.json<{ code: string }>(`/api/records/${id}`, {
      method: 'PUT',
      json: payload({ name: '并发写', version: 1 }),
      cookie,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('RECORD_VERSION_CONFLICT');

    const deleted = await h.json<{ id: number }>(`/api/records/${id}`, {
      method: 'DELETE',
      cookie,
    });
    expect(deleted.status).toBe(200);

    const activeList = await h.json<{ total: number }>('/api/records', { cookie });
    expect(activeList.body.total).toBe(0);
    const trashList = await h.json<{ total: number; items: RecordView[] }>('/api/trash', {
      cookie,
    });
    expect(trashList.body.total).toBe(1);
    expect(trashList.body.items[0]?.id).toBe(id);

    const restored = await h.json<{ id: number }>(`/api/trash/${id}/restore`, {
      method: 'POST',
      cookie,
    });
    expect(restored.status).toBe(200);
    const afterRestore = await h.json<{ total: number }>('/api/records', { cookie });
    expect(afterRestore.body.total).toBe(1);

    // 彻底删除只允许回收站条目：先软删，再从回收站物理删。
    await h.json(`/api/records/${id}`, { method: 'DELETE', cookie });
    const purged = await h.json<{ id: number }>(`/api/trash/${id}`, { method: 'DELETE', cookie });
    expect(purged.status).toBe(200);
    const emptyTrash = await h.json<{ total: number }>('/api/trash', { cookie });
    expect(emptyTrash.body.total).toBe(0);
  });

  it('八项判重命中返回 409，不重复落库', async () => {
    const { h, cookie } = await ready();
    const first = await h.json('/api/records', { json: payload(), cookie });
    expect(first.status).toBe(201);

    const second = await h.json<{ code: string }>('/api/records', { json: payload(), cookie });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('RECORD_DUPLICATE');

    const list = await h.json<{ total: number }>('/api/records', { cookie });
    expect(list.body.total).toBe(1);
  });

  it('同一幂等键重复提交返回同一记录，且只落一行', async () => {
    const { h, cookie } = await ready();
    const key = 'idem-key-0001';
    const first = await h.json<RecordView>('/api/records', {
      json: payload({ idempotencyKey: key }),
      cookie,
    });
    const second = await h.json<RecordView>('/api/records', {
      json: payload({ idempotencyKey: key }),
      cookie,
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);

    const list = await h.json<{ total: number }>('/api/records', { cookie });
    expect(list.body.total).toBe(1);
  });

  it('金额与「单价 × 数量」不一致返回 422 且带中文原因', async () => {
    const { h, cookie } = await ready();
    const bad = await h.json<{ code: string; details: { reason: string } }>('/api/records', {
      json: payload({ amountCents: 999 }),
      cookie,
    });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('VALID_FAILED');
    expect(bad.body.details.reason).toContain('不一致');
  });

  it('非数字 id 返回 400，非法筛选条件返回 422', async () => {
    const { h, cookie } = await ready();
    const badId = await h.json<{ code: string }>('/api/records/abc', { cookie });
    expect(badId.status).toBe(400);
    expect(badId.body.code).toBe('COMMON_BAD_REQUEST');

    const badFilter = await h.json<{ code: string }>('/api/records?sortBy=bogus', { cookie });
    expect(badFilter.status).toBe(422);
    expect(badFilter.body.code).toBe('VALID_FAILED');
  });

  it('按名称筛选与分页参数生效', async () => {
    const { h, cookie } = await ready();
    await h.json('/api/records', { json: payload({ name: '啤酒-A' }), cookie });
    await h.json('/api/records', { json: payload({ name: '啤酒-B', amountCents: 240 }), cookie });
    await h.json('/api/records', { json: payload({ name: '花卷', amountCents: 240 }), cookie });
    await h.json('/api/records', { json: payload({ name: '鲜猪五花肉' }), cookie });

    const filtered = await h.json<{ total: number; items: RecordView[] }>(
      '/api/records?name=啤酒&page=1&pageSize=1',
      { cookie },
    );
    expect(filtered.status).toBe(200);
    expect(filtered.body.total).toBe(2);
    expect(filtered.body.items).toHaveLength(1);

    const page2 = await h.json<{ items: RecordView[] }>(
      '/api/records?name=啤酒&page=2&pageSize=1',
      {
        cookie,
      },
    );
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.items[0]?.id).not.toBe(filtered.body.items[0]?.id);

    const bySuffix = await h.json<{ total: number; items: RecordView[] }>(
      '/api/records?name=五花',
      { cookie },
    );
    expect(bySuffix.status).toBe(200);
    expect(bySuffix.body.total).toBe(1);
    expect(bySuffix.body.items[0]?.name).toBe('鲜猪五花肉');
  });
});

describe('批量操作', () => {
  it('批量软删 → 批量恢复 → 批量彻底删除', async () => {
    const { h, cookie } = await ready();
    const ids: number[] = [];
    for (const name of ['批量一', '批量二']) {
      const created = await h.json<RecordView>('/api/records', {
        json: payload({ name }),
        cookie,
      });
      ids.push(created.body.id);
    }

    const softDeleted = await h.json<{ deleted: number }>('/api/records/batch-delete', {
      json: { ids },
      cookie,
    });
    expect(softDeleted.status).toBe(200);
    expect(softDeleted.body.deleted).toBe(2);

    const restored = await h.json<{ restored: number }>('/api/trash/batch-restore', {
      json: { ids },
      cookie,
    });
    expect(restored.body.restored).toBe(2);

    await h.json('/api/records/batch-delete', { json: { ids }, cookie });
    const purged = await h.json<{ purged: number }>('/api/trash/batch-purge', {
      json: { ids },
      cookie,
    });
    expect(purged.body.purged).toBe(2);

    const trash = await h.json<{ total: number }>('/api/trash', { cookie });
    expect(trash.body.total).toBe(0);
  });

  it('空 ids 数组被 schema 拒绝（422），不会开事务', async () => {
    const { h, cookie } = await ready();
    const bad = await h.json<{ code: string }>('/api/records/batch-delete', {
      json: { ids: [] },
      cookie,
    });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('VALID_FAILED');
  });
});

describe('GET /api/records/suggestions', () => {
  it('名称建议按包含去重，并带出最近一次的规格与单价', async () => {
    const { h, cookie } = await ready();
    await h.json('/api/records', {
      json: payload({
        purchaseDate: '2026-11-01',
        spec: '500ml',
        unitPrice: 10_000,
        amountCents: 200,
      }),
      cookie,
    });
    await h.json('/api/records', {
      json: payload({
        purchaseDate: '2026-11-12',
        spec: '330ml',
        unitPrice: 12_500,
        amountCents: 250,
      }),
      cookie,
    });

    const response = await h.json<{
      items: {
        value: string;
        spec: string | null;
        unitPrice: number | null;
        lastPurchaseDate: string;
      }[];
    }>('/api/records/suggestions?field=name&q=工人', { cookie });
    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    // 未传 supplier 时不下「是否匹配供货商」的结论，只补最近进货日期。
    expect(response.body.items[0]).toEqual({
      value: '工人牌啤酒',
      spec: '330ml',
      unitPrice: 12_500,
      lastPurchaseDate: '2026-11-12',
    });
  });

  it('名称建议支持任意位置包含，多词按 AND 匹配', async () => {
    const { h, cookie } = await ready();
    await h.json('/api/records', {
      json: payload({
        name: '鲜猪五花肉',
        spec: '500g',
        unitPrice: 10_000,
        amountCents: 200,
      }),
      cookie,
    });

    const bySuffix = await h.json<{
      items: {
        value: string;
        spec: string | null;
        unitPrice: number | null;
        lastPurchaseDate: string;
      }[];
    }>('/api/records/suggestions?field=name&q=五花', { cookie });
    expect(bySuffix.status).toBe(200);
    expect(bySuffix.body.items).toEqual([
      {
        value: '鲜猪五花肉',
        spec: '500g',
        unitPrice: 10_000,
        lastPurchaseDate: '2026-11-10',
      },
    ]);

    const byTokens = await h.json<{ items: { value: string }[] }>(
      `/api/records/suggestions?field=name&q=${encodeURIComponent('鲜猪 五花')}`,
      { cookie },
    );
    expect(byTokens.status).toBe(200);
    expect(byTokens.body.items.map((item) => item.value)).toEqual(['鲜猪五花肉']);
  });

  it('规格建议去重且不返回空规格；缺 field 返回 422', async () => {
    const { h, cookie } = await ready();
    await h.json('/api/records', { json: payload({ spec: '500ml' }), cookie });
    await h.json('/api/records', { json: payload({ name: '另一种', spec: '500ml' }), cookie });
    await h.json('/api/records', { json: payload({ name: '无规格', spec: null }), cookie });

    const response = await h.json<{ items: { value: string }[] }>(
      '/api/records/suggestions?field=spec&q=ml',
      { cookie },
    );
    expect(response.status).toBe(200);
    expect(response.body.items.map((item) => item.value)).toEqual(['500ml']);

    const bad = await h.json<{ code: string }>('/api/records/suggestions', { cookie });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('VALID_FAILED');
  });

  it('未登录返回 401（建议接口不绕过守卫）', async () => {
    harness = await createHarness();
    const response = await harness.json<{ code: string }>('/api/records/suggestions?field=name');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_REQUIRED');
  });
});
