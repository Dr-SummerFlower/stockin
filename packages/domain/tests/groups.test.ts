import { describe, expect, it } from 'vitest';
import { FieldSource, ShelfLifeUnit } from '@stockin/shared';
import {
  computeAmountGroup,
  computeDateGroup,
  type AmountGroupSourceMap,
  type AmountGroupValues,
  type DateGroupSourceMap,
  type DateGroupValues,
} from '../src/groups';

const E = FieldSource.EMPTY;
const M = FieldSource.MANUAL;
const A = FieldSource.AUTO;

function dateFields(partial: Partial<DateGroupValues>): DateGroupValues {
  return {
    productionDate: null,
    shelfLifeValue: null,
    shelfLifeUnit: null,
    expiryDate: null,
    ...partial,
  };
}

function dateSources(partial: Partial<DateGroupSourceMap>): DateGroupSourceMap {
  return { productionDate: E, shelfLife: E, expiryDate: E, ...partial };
}

function numeric(raw: string, parsed: number | null) {
  return { raw, parsed };
}

function amountFields(partial: Partial<AmountGroupValues>): AmountGroupValues {
  return {
    unitPrice: numeric('', null),
    quantity: numeric('', null),
    amount: numeric('', null),
    ...partial,
  };
}

function amountSources(partial: Partial<AmountGroupSourceMap>): AmountGroupSourceMap {
  return { unitPrice: E, quantity: E, amount: E, ...partial };
}

describe('computeDateGroup 日期组三选二', () => {
  it('生产日期 + 保质期 → 自动推算到期日', () => {
    const result = computeDateGroup(
      dateFields({
        productionDate: '2024-01-01',
        shelfLifeValue: 12,
        shelfLifeUnit: ShelfLifeUnit.MONTH,
      }),
      dateSources({ productionDate: M, shelfLife: M }),
    );
    expect(result.values.expiryDate).toBe('2025-01-01');
    expect(result.sources.expiryDate).toBe(A);
    // 引擎不写 MANUAL 槽
    expect(result.sources.productionDate).toBe(M);
    expect(result.sources.shelfLife).toBe(M);
  });

  it('生产日期 + 到期日 → 自动推算保质期（缺单位时按天）', () => {
    const result = computeDateGroup(
      dateFields({ productionDate: '2024-01-01', expiryDate: '2024-01-31' }),
      dateSources({ productionDate: M, expiryDate: M }),
    );
    expect(result.values.shelfLifeValue).toBe(30);
    expect(result.values.shelfLifeUnit).toBe(ShelfLifeUnit.DAY);
    expect(result.sources.shelfLife).toBe(A);
  });

  it('保质期 + 到期日 → 自动反推生产日期', () => {
    const result = computeDateGroup(
      dateFields({
        shelfLifeValue: 1,
        shelfLifeUnit: ShelfLifeUnit.MONTH,
        expiryDate: '2024-03-01',
      }),
      dateSources({ shelfLife: M, expiryDate: M }),
    );
    expect(result.values.productionDate).toBe('2024-02-01');
    expect(result.sources.productionDate).toBe(A);
  });

  it('AUTO 槽先被清空且不作锚点：仅剩一个 MANUAL 时不推导', () => {
    const result = computeDateGroup(
      dateFields({ productionDate: '2024-01-01', expiryDate: '2025-01-01' }),
      dateSources({ productionDate: M, expiryDate: A }),
    );
    expect(result.values.expiryDate).toBeNull();
    expect(result.sources.expiryDate).toBe(E);
    expect(result.values.shelfLifeValue).toBeNull();
  });

  it('三个都为 MANUAL 时不推导（每组至多 1 个 AUTO）', () => {
    const result = computeDateGroup(
      dateFields({
        productionDate: '2024-01-01',
        shelfLifeValue: 1,
        shelfLifeUnit: ShelfLifeUnit.YEAR,
        expiryDate: '2026-06-01',
      }),
      dateSources({ productionDate: M, shelfLife: M, expiryDate: M }),
    );
    expect(result.sources.productionDate).toBe(M);
    expect(result.sources.shelfLife).toBe(M);
    expect(result.sources.expiryDate).toBe(M);
    expect(result.values.expiryDate).toBe('2026-06-01');
  });

  it('到期日早于生产日期时撤销非 MANUAL 的推导结果', () => {
    const result = computeDateGroup(
      dateFields({ productionDate: '2024-06-01', expiryDate: '2024-01-01' }),
      dateSources({ productionDate: M, expiryDate: M }),
    );
    // 两者都是 MANUAL，冲突时清掉生产日期而不是改写用户输入
    expect(result.values.productionDate).toBeNull();
    expect(result.sources.productionDate).toBe(E);
  });

  it('保质期缺单位视为空，不参与推导', () => {
    const result = computeDateGroup(
      dateFields({ productionDate: '2024-01-01', shelfLifeValue: 12 }),
      dateSources({ productionDate: M, shelfLife: M }),
    );
    expect(result.values.shelfLifeValue).toBeNull();
    expect(result.values.expiryDate).toBeNull();
  });

  it('传入 today 时附带剩余天数与临期状态', () => {
    const result = computeDateGroup(
      dateFields({
        productionDate: '2024-01-01',
        shelfLifeValue: 12,
        shelfLifeUnit: ShelfLifeUnit.MONTH,
      }),
      dateSources({ productionDate: M, shelfLife: M }),
      '2024-12-25',
    );
    expect(result.remainingDays).toBe(7);
    expect(result.expiryStatus).toBe('near');
  });
});

describe('computeAmountGroup 金额组三选二', () => {
  it('单价 + 数量 → 自动推算金额（分）', () => {
    const result = computeAmountGroup(
      amountFields({ unitPrice: numeric('3.3333', 33333), quantity: numeric('3', 3000) }),
      amountSources({ unitPrice: M, quantity: M }),
    );
    expect(result.values.amount.parsed).toBe(1000);
    expect(result.values.amount.raw).toBe('10.00');
    expect(result.sources.amount).toBe(A);
  });

  it('金额 + 数量 → 自动推算单价', () => {
    const result = computeAmountGroup(
      amountFields({ amount: numeric('100.00', 10000), quantity: numeric('3', 3000) }),
      amountSources({ amount: M, quantity: M }),
    );
    expect(result.values.unitPrice.parsed).toBe(333333);
    expect(result.values.unitPrice.raw).toBe('33.3333');
    expect(result.sources.unitPrice).toBe(A);
  });

  it('金额 + 单价 → 自动推算数量', () => {
    const result = computeAmountGroup(
      amountFields({ amount: numeric('100.00', 10000), unitPrice: numeric('25.0000', 250000) }),
      amountSources({ amount: M, unitPrice: M }),
    );
    expect(result.values.quantity.parsed).toBe(4000);
    expect(result.values.quantity.raw).toBe('4.000');
    expect(result.sources.quantity).toBe(A);
  });

  it('除零不推导：数量为 0 时单价保持空，不产生 NaN / Infinity', () => {
    const result = computeAmountGroup(
      amountFields({ amount: numeric('100.00', 10000), quantity: numeric('0', 0) }),
      amountSources({ amount: M, quantity: M }),
    );
    expect(result.values.unitPrice.parsed).toBeNull();
    expect(result.sources.unitPrice).toBe(E);
  });

  it('中间态（parsed 为 null）不作锚点', () => {
    const result = computeAmountGroup(
      amountFields({ unitPrice: numeric('0.', null), quantity: numeric('3', 3000) }),
      amountSources({ unitPrice: M, quantity: M }),
    );
    expect(result.values.amount.parsed).toBeNull();
    expect(result.sources.amount).toBe(E);
  });

  it('AUTO 槽先被清空：已自动算出的金额不会当作锚点复算', () => {
    const result = computeAmountGroup(
      amountFields({ unitPrice: numeric('25.0000', 250000), amount: numeric('100.00', 10000) }),
      amountSources({ unitPrice: M, amount: A }),
    );
    expect(result.values.amount.parsed).toBeNull();
    expect(result.values.quantity.parsed).toBeNull();
  });
});
