import { describe, expect, it } from 'vitest';
import { SCALE } from '@stockin/shared';
import { fixedDiv, fixedMul, fixedRound, formatFixed, parseFixed } from '../src/fixed';

/**
 * 定点数口径（设计文档 §2.4 BR-2、§4.3）：
 * 单价 1e4、数量 1e3、金额 1e2（分）；全程 BigInt + HALF_UP，禁浮点累加。
 */
describe('parseFixed 文本 → 定点整数', () => {
  it('按倍率放大整数部分与小数部分', () => {
    expect(parseFixed('3.3333', SCALE.UNIT_PRICE)).toBe(33333);
    expect(parseFixed('12', SCALE.QUANTITY)).toBe(12000);
    expect(parseFixed('0.05', SCALE.AMOUNT_CENTS)).toBe(5);
  });

  it('超出位数按 HALF_UP 四舍五入', () => {
    // 3.33335 × 1e4 = 33333.5 → 33334
    expect(parseFixed('3.33335', SCALE.UNIT_PRICE)).toBe(33334);
    // 1.005 × 100 = 100.5 → 101
    expect(parseFixed('1.005', SCALE.AMOUNT_CENTS)).toBe(101);
  });

  it('负数向远离零方向舍入（HALF_UP 而非银行家舍入）', () => {
    expect(parseFixed('-1.005', SCALE.AMOUNT_CENTS)).toBe(-101);
    expect(parseFixed('-0.5', SCALE.AMOUNT_CENTS)).toBe(-50);
  });

  it('输入中间态与非数字返回 null，不抛错', () => {
    for (const value of ['', '   ', '0.', '-', '+', 'abc', '1.2.3', '1e5']) {
      expect(parseFixed(value, SCALE.AMOUNT_CENTS)).toBeNull();
    }
    expect(parseFixed(null, SCALE.AMOUNT_CENTS)).toBeNull();
    expect(parseFixed(undefined, SCALE.AMOUNT_CENTS)).toBeNull();
  });

  it('容忍首尾空白，number 入参按有限值处理', () => {
    expect(parseFixed('  12.5  ', SCALE.AMOUNT_CENTS)).toBe(1250);
    expect(parseFixed(12.5, SCALE.AMOUNT_CENTS)).toBe(1250);
    expect(parseFixed(0, SCALE.AMOUNT_CENTS)).toBe(0);
    expect(parseFixed(Number.POSITIVE_INFINITY, SCALE.AMOUNT_CENTS)).toBeNull();
  });
});

describe('formatFixed 定点整数 → 文本', () => {
  it('按倍率补足小数位', () => {
    expect(formatFixed(33333, SCALE.UNIT_PRICE)).toBe('3.3333');
    expect(formatFixed(5, SCALE.AMOUNT_CENTS)).toBe('0.05');
    expect(formatFixed(0, SCALE.AMOUNT_CENTS)).toBe('0.00');
    expect(formatFixed(1000, 1)).toBe('1000');
  });

  it('保留负号', () => {
    expect(formatFixed(-5, SCALE.AMOUNT_CENTS)).toBe('-0.05');
    expect(formatFixed(-33333, SCALE.UNIT_PRICE)).toBe('-3.3333');
  });
});

describe('fixedRound HALF_UP 取整', () => {
  it('0.5 向上、0.4 向下、负数远离零', () => {
    expect(fixedRound(1, 2)).toBe(1);
    expect(fixedRound(-1, 2)).toBe(-1);
    expect(fixedRound(7, 2)).toBe(4);
    expect(fixedRound(1, 3)).toBe(0);
    expect(fixedRound(2, 3)).toBe(1);
  });

  it('除零直接抛错，绝不产生 NaN / Infinity', () => {
    expect(() => fixedRound(1, 0)).toThrow(/除零/);
  });
});

describe('fixedMul 定点乘法', () => {
  it('核心用例 2：3.3333 × 3 = 10.00', () => {
    const amount: number = fixedMul(
      33333,
      3000,
      SCALE.UNIT_PRICE,
      SCALE.QUANTITY,
      SCALE.AMOUNT_CENTS,
    );
    // 9.9999 元 → HALF_UP 到分 → 1000 分 = 10.00
    expect(amount).toBe(1000);
    expect(formatFixed(amount, SCALE.AMOUNT_CENTS)).toBe('10.00');
  });

  it('小数相乘不引入浮点误差：0.1 × 0.2 = 0.02', () => {
    const price: number = parseFixed('0.1', SCALE.UNIT_PRICE) as number;
    const qty: number = parseFixed('0.2', SCALE.QUANTITY) as number;
    expect(fixedMul(price, qty, SCALE.UNIT_PRICE, SCALE.QUANTITY, SCALE.AMOUNT_CENTS)).toBe(2);
  });
});

describe('fixedDiv 定点除法', () => {
  it('金额 ÷ 数量 → 单价', () => {
    const price: number | null = fixedDiv(
      10000,
      3000,
      SCALE.AMOUNT_CENTS,
      SCALE.QUANTITY,
      SCALE.UNIT_PRICE,
    );
    expect(price).toBe(333333);
    expect(formatFixed(price as number, SCALE.UNIT_PRICE)).toBe('33.3333');
  });

  it('除数为 0 返回 null（除零不执行）', () => {
    expect(fixedDiv(10000, 0, SCALE.AMOUNT_CENTS, SCALE.QUANTITY, SCALE.UNIT_PRICE)).toBeNull();
  });
});

describe('累加不使用浮点', () => {
  it('0.1 累加 10 次精确等于 1.00', () => {
    const one: number = parseFixed('0.1', SCALE.AMOUNT_CENTS) as number;
    let sum = 0;
    for (let i = 0; i < 10; i += 1) {
      sum += one;
    }
    expect(sum).toBe(100);
    expect(formatFixed(sum, SCALE.AMOUNT_CENTS)).toBe('1.00');
    // 作为对照：浮点直接累加会出现 0.9999999999999999 类误差。
    expect(0.1 * 10 === 1).toBe(true);
  });
});
