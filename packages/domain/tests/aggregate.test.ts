import { describe, expect, it } from 'vitest';
import { aggregateRules, buildExpiryAlerts, type AggregateRecord } from '../src/aggregate';

function rec(overrides: Partial<AggregateRecord> = {}): AggregateRecord {
  return {
    id: 1,
    name: '纯牛奶',
    spec: '500ml',
    purchaseDate: '2024-01-10',
    productionDate: '2024-01-01',
    expiryDate: '2024-01-31',
    unitPrice: 33333,
    quantity: 3000,
    amountCents: 1000,
    ...overrides,
  };
}

/**
 * 大屏 6 卡指标与预警清单（设计文档 §2.4 BR-5、§5.2）：
 * 排除软删、到期日为空不计入风险、商品种类按 name_norm 去重、全程整数累加。
 */
describe('aggregateRules 六组指标', () => {
  it('整数累加总额、数量与记录数', () => {
    const metrics = aggregateRules(
      [rec(), rec({ id: 2, amountCents: 2500, quantity: 1500 })],
      '2024-01-15',
      30,
    );
    expect(metrics.totalRecords).toBe(2);
    expect(metrics.totalAmountCents).toBe(3500);
    expect(metrics.totalQuantity).toBe(4500);
  });

  it('排除软删记录', () => {
    const metrics = aggregateRules(
      [rec(), rec({ id: 2, amountCents: 9000, deletedAt: '2024-02-01T00:00:00.000Z' })],
      '2024-01-15',
      30,
    );
    expect(metrics.totalRecords).toBe(1);
    expect(metrics.totalAmountCents).toBe(1000);
  });

  it('商品种类按归一化名去重', () => {
    const metrics = aggregateRules(
      [rec({ name: 'Pure Milk' }), rec({ id: 2, name: 'puremilk' }), rec({ id: 3, name: '鸡蛋' })],
      '2024-01-15',
      30,
    );
    expect(metrics.distinctProducts).toBe(2);
  });

  it('到期日为空的记录不计入临期/过期，但仍计入总额', () => {
    const metrics = aggregateRules([rec({ expiryDate: null })], '2024-01-15', 30);
    expect(metrics.totalRecords).toBe(1);
    expect(metrics.nearExpiryCount).toBe(0);
    expect(metrics.expiredCount).toBe(0);
  });

  it('临期与过期分别统计条数与金额（含 d = X 边界）', () => {
    const metrics = aggregateRules(
      [
        rec({ id: 1, expiryDate: '2024-02-14' }), // d = 30 → near
        rec({ id: 2, expiryDate: '2024-02-15', amountCents: 500 }), // d = 31 → none
        rec({ id: 3, expiryDate: '2024-01-14', amountCents: 700 }), // d = -1 → expired
      ],
      '2024-01-15',
      30,
    );
    expect(metrics.nearExpiryCount).toBe(1);
    expect(metrics.nearExpiryAmountCents).toBe(1000);
    expect(metrics.expiredCount).toBe(1);
    expect(metrics.expiredAmountCents).toBe(700);
  });

  it('空输入返回全零', () => {
    expect(aggregateRules([], '2024-01-15', 30)).toEqual({
      totalAmountCents: 0,
      totalRecords: 0,
      distinctProducts: 0,
      totalQuantity: 0,
      nearExpiryCount: 0,
      nearExpiryAmountCents: 0,
      expiredCount: 0,
      expiredAmountCents: 0,
    });
  });
});

describe('buildExpiryAlerts 预警清单', () => {
  it('只含临期/过期，按到期日升序再按 id 升序', () => {
    const alerts = buildExpiryAlerts(
      [
        rec({ id: 3, expiryDate: '2024-02-01' }),
        rec({ id: 1, expiryDate: '2024-01-20' }),
        rec({ id: 2, expiryDate: '2024-01-20' }),
        rec({ id: 4, expiryDate: '2024-06-01' }), // 不告警
        rec({ id: 5, expiryDate: null }), // 无到期日
      ],
      '2024-01-15',
      30,
    );
    expect(alerts.map((item) => item.id)).toEqual([1, 2, 3]);
    expect(alerts.map((item) => item.remainingDays)).toEqual([5, 5, 17]);
    expect(alerts.every((item) => item.status === 'near')).toBe(true);
  });

  it('过期项状态为 expired，排除软删', () => {
    const alerts = buildExpiryAlerts(
      [
        rec({ id: 1, expiryDate: '2024-01-01' }),
        rec({ id: 2, expiryDate: '2024-01-01', deletedAt: 'x' }),
      ],
      '2024-01-15',
      30,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.status).toBe('expired');
    expect(alerts[0]?.remainingDays).toBe(-14);
  });
});
