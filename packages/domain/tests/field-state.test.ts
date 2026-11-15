import { describe, expect, it } from 'vitest';
import { FieldSource, ShelfLifeUnit } from '@stockin/shared';
import { applyFieldEvent, countAuto, createInitialLinkageState } from '../src/field-state';

/**
 * 三选二状态机不变量（设计文档 §2.4 BR-1、§5.1）：
 * ① 引擎永不写 MANUAL 槽；② 每组至多 1 个 AUTO；③ AUTO 不可作锚点；
 * ④ 自动值可被手动覆盖，覆盖后该组锁定、不再重算。
 */
describe('createInitialLinkageState', () => {
  it('初始全空且两组均未锁定', () => {
    const state = createInitialLinkageState();
    expect(state.date.locked).toBe(false);
    expect(state.amount.locked).toBe(false);
    expect(state.date.productionDate.source).toBe(FieldSource.EMPTY);
    expect(state.amount.amount.parsed).toBeNull();
  });
});

describe('applyFieldEvent 日期组', () => {
  it('依次输入生产日期与保质期后，到期日变为 AUTO', () => {
    let state = createInitialLinkageState();
    state = applyFieldEvent(state, {
      type: 'userInput',
      slot: 'productionDate',
      raw: '2024-01-01',
    });
    state = applyFieldEvent(state, {
      type: 'userInput',
      slot: 'shelfLife',
      raw: '12',
      parsed: 12,
      unit: ShelfLifeUnit.MONTH,
    });

    expect(state.date.expiryDate.value).toBe('2025-01-01');
    expect(state.date.expiryDate.source).toBe(FieldSource.AUTO);
    expect(state.date.productionDate.source).toBe(FieldSource.MANUAL);
    expect(
      countAuto({
        slots: [state.date.productionDate, state.date.shelfLife, state.date.expiryDate],
      }),
    ).toBe(1);
  });

  it('覆盖 AUTO 值后该组锁定，后续输入不再自动重算', () => {
    let state = createInitialLinkageState();
    state = applyFieldEvent(state, {
      type: 'userInput',
      slot: 'productionDate',
      raw: '2024-01-01',
    });
    state = applyFieldEvent(state, {
      type: 'userInput',
      slot: 'shelfLife',
      raw: '12',
      parsed: 12,
      unit: ShelfLifeUnit.MONTH,
    });
    // 手动覆盖自动算出的到期日
    state = applyFieldEvent(state, { type: 'userInput', slot: 'expiryDate', raw: '2025-03-01' });

    expect(state.date.locked).toBe(true);
    expect(state.date.expiryDate.value).toBe('2025-03-01');
    expect(state.date.expiryDate.source).toBe(FieldSource.MANUAL);

    // 锁定后改生产日期不应再改动到期日
    state = applyFieldEvent(state, {
      type: 'userInput',
      slot: 'productionDate',
      raw: '2024-02-01',
    });
    expect(state.date.expiryDate.value).toBe('2025-03-01');
    expect(state.date.locked).toBe(true);
  });

  it('清空组内全部字段后锁定解除', () => {
    let state = createInitialLinkageState();
    state = applyFieldEvent(state, {
      type: 'userInput',
      slot: 'productionDate',
      raw: '2024-01-01',
    });
    state = applyFieldEvent(state, {
      type: 'userInput',
      slot: 'shelfLife',
      raw: '12',
      parsed: 12,
      unit: ShelfLifeUnit.MONTH,
    });
    state = applyFieldEvent(state, { type: 'userInput', slot: 'expiryDate', raw: '2025-03-01' });
    expect(state.date.locked).toBe(true);

    for (const slot of ['productionDate', 'shelfLife', 'expiryDate'] as const) {
      state = applyFieldEvent(state, { type: 'userClear', slot });
    }
    expect(state.date.locked).toBe(false);
    expect(state.date.productionDate.source).toBe(FieldSource.EMPTY);
  });

  it('输入非法日期不会让联动崩溃，也不产生 AUTO', () => {
    let state = createInitialLinkageState();
    state = applyFieldEvent(state, {
      type: 'userInput',
      slot: 'productionDate',
      raw: '2024-13-45',
    });
    state = applyFieldEvent(state, {
      type: 'userInput',
      slot: 'shelfLife',
      raw: '1',
      parsed: 1,
      unit: ShelfLifeUnit.MONTH,
    });
    expect(state.date.expiryDate.source).toBe(FieldSource.EMPTY);
    expect(state.date.expiryDate.value).toBeNull();
  });
});

describe('applyFieldEvent 金额组', () => {
  it('单价 + 数量 → 金额 AUTO，且覆盖后锁定', () => {
    let state = createInitialLinkageState();
    state = applyFieldEvent(state, { type: 'userInput', slot: 'unitPrice', raw: '3.3333' });
    state = applyFieldEvent(state, { type: 'userInput', slot: 'quantity', raw: '3' });

    expect(state.amount.amount.parsed).toBe(1000);
    expect(state.amount.amount.source).toBe(FieldSource.AUTO);

    state = applyFieldEvent(state, { type: 'userInput', slot: 'amount', raw: '9.99' });
    expect(state.amount.locked).toBe(true);
    expect(state.amount.amount.parsed).toBe(999);
    expect(state.amount.amount.source).toBe(FieldSource.MANUAL);

    state = applyFieldEvent(state, { type: 'userInput', slot: 'quantity', raw: '5' });
    expect(state.amount.amount.parsed).toBe(999);
  });

  it('数量为 0 时不推导单价（除零不执行）', () => {
    let state = createInitialLinkageState();
    state = applyFieldEvent(state, { type: 'userInput', slot: 'amount', raw: '100.00' });
    state = applyFieldEvent(state, { type: 'userInput', slot: 'quantity', raw: '0' });

    expect(state.amount.unitPrice.parsed).toBeNull();
    expect(state.amount.unitPrice.source).toBe(FieldSource.EMPTY);
  });
});
