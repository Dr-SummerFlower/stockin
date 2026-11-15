import { describe, expect, it } from 'vitest';
import { ShelfLifeUnit } from '@stockin/shared';
import { addShelfLife, diffShelfLife, subtractShelfLife } from '../src/shelf-life';

/**
 * 保质期 ↔ 日期换算（设计文档 §2.4 BR-4）：
 * 到期日 = 生产日期 + N（**不减 1**）；月/年按日历月回退并钳制月末；到期日不早于生产日期。
 */
describe('addShelfLife 生产日期 + 保质期 → 到期日', () => {
  it('按天：直接加天数，且不减 1', () => {
    expect(addShelfLife('2024-01-01', 30, ShelfLifeUnit.DAY)).toBe('2024-01-31');
    expect(addShelfLife('2024-01-01', 1, ShelfLifeUnit.DAY)).toBe('2024-01-02');
    expect(addShelfLife('2024-01-01', 0, ShelfLifeUnit.DAY)).toBe('2024-01-01');
  });

  it('按月：日历月推进并钳制到目标月最后一日', () => {
    expect(addShelfLife('2024-01-31', 1, ShelfLifeUnit.MONTH)).toBe('2024-02-29');
    expect(addShelfLife('2025-01-31', 1, ShelfLifeUnit.MONTH)).toBe('2025-02-28');
    expect(addShelfLife('2024-01-15', 1, ShelfLifeUnit.MONTH)).toBe('2024-02-15');
    expect(addShelfLife('2024-11-30', 3, ShelfLifeUnit.MONTH)).toBe('2025-02-28');
  });

  it('按年：等价 12 个日历月', () => {
    expect(addShelfLife('2024-01-01', 1, ShelfLifeUnit.YEAR)).toBe('2025-01-01');
    expect(addShelfLife('2024-02-29', 1, ShelfLifeUnit.YEAR)).toBe('2025-02-28');
    expect(addShelfLife('2024-01-01', 2, ShelfLifeUnit.YEAR)).toBe('2026-01-01');
  });

  it('非法日期、负数保质期、未知单位抛错', () => {
    expect(() => addShelfLife('2024-02-30', 1, ShelfLifeUnit.DAY)).toThrow();
    expect(() => addShelfLife('2024-01-01', -1, ShelfLifeUnit.DAY)).toThrow();
    expect(() => addShelfLife('2024-01-01', 1.5, ShelfLifeUnit.DAY)).toThrow();
    expect(() => addShelfLife('2024-01-01', 1, 'week' as ShelfLifeUnit)).toThrow();
  });
});

describe('subtractShelfLife 到期日 − 保质期 → 生产日', () => {
  it('按天/按月回退', () => {
    expect(subtractShelfLife('2024-01-31', 30, ShelfLifeUnit.DAY)).toBe('2024-01-01');
    expect(subtractShelfLife('2024-03-01', 1, ShelfLifeUnit.MONTH)).toBe('2024-02-01');
    expect(subtractShelfLife('2025-01-01', 1, ShelfLifeUnit.YEAR)).toBe('2024-01-01');
  });

  it('日历月钳制不可逆：1/31 + 1 月 = 2/29，反推得 1/29', () => {
    const expiry: string = addShelfLife('2024-01-31', 1, ShelfLifeUnit.MONTH);
    expect(expiry).toBe('2024-02-29');
    expect(subtractShelfLife(expiry, 1, ShelfLifeUnit.MONTH)).toBe('2024-01-29');
  });
});

describe('diffShelfLife 生产日 + 到期日 → 保质期数值', () => {
  it('按天返回天数差', () => {
    expect(diffShelfLife('2024-01-01', '2024-01-31', ShelfLifeUnit.DAY)).toBe(30);
    expect(diffShelfLife('2024-01-01', '2024-01-01', ShelfLifeUnit.DAY)).toBe(0);
  });

  it('按月取「不超过到期日」的最大整数 N', () => {
    expect(diffShelfLife('2024-01-01', '2024-12-01', ShelfLifeUnit.MONTH)).toBe(11);
    expect(diffShelfLife('2024-01-01', '2024-12-31', ShelfLifeUnit.MONTH)).toBe(11);
    expect(diffShelfLife('2024-01-01', '2025-01-01', ShelfLifeUnit.MONTH)).toBe(12);
  });

  it('按月对钳制日期向下取整：1/31 → 2/29 不足 1 个整月', () => {
    expect(diffShelfLife('2024-01-31', '2024-02-29', ShelfLifeUnit.MONTH)).toBe(1);
    expect(diffShelfLife('2024-01-31', '2024-02-28', ShelfLifeUnit.MONTH)).toBe(0);
  });

  it('按年按 12 个月步进', () => {
    expect(diffShelfLife('2020-01-01', '2024-01-01', ShelfLifeUnit.YEAR)).toBe(4);
    expect(diffShelfLife('2024-01-01', '2024-12-31', ShelfLifeUnit.YEAR)).toBe(0);
  });

  it('到期日早于生产日抛错', () => {
    expect(() => diffShelfLife('2024-02-01', '2024-01-01', ShelfLifeUnit.DAY)).toThrow(
      /不得早于生产日期/,
    );
  });
});
