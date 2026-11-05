/**
 * 三选二联动状态机 reducer：`applyFieldEvent(state, event) → state`。
 *
 * 不变量（设计文档 v1.1 §2.4 BR-1、§5.1）：
 *  ① 引擎永不写 MANUAL 槽；② 每组至多 1 个 AUTO；
 *  ③ AUTO 不可作推导锚点；④ 全同步纯函数，无异步竞态。
 * 「自动值可手动覆盖，覆盖后不再重算」：当用户覆盖一个 AUTO 槽时，该组置 locked，
 * 之后不再自动推导任何字段（这是「覆盖后锁定」的严格解释，便于前后端一份实现）。
 */
import { FieldSource, groupOfSlot, SCALE, type LinkageSlot } from '@stockin/shared';
import type {
  LinkageState,
  DateGroupState,
  AmountGroupState,
  FieldEvent,
  FieldState,
  GroupState,
  NumericFieldState,
  ShelfLifeValue,
} from './types';
import {
  computeDateGroup,
  computeAmountGroup,
  type DateGroupValues,
  type DateGroupSourceMap,
  type DateGroupResult,
  type AmountGroupValues,
  type AmountGroupSourceMap,
  type AmountGroupResult,
} from './groups';
import { parseFixed } from './fixed';

const EMPTY_DATE_TEXT: FieldState<string> = { value: null, source: FieldSource.EMPTY };
const EMPTY_SHELF_LIFE: FieldState<ShelfLifeValue> = { value: null, source: FieldSource.EMPTY };
const EMPTY_NUMERIC: NumericFieldState = { raw: '', parsed: null, source: FieldSource.EMPTY };

/** 初始（全空）联动状态。 */
export function createInitialLinkageState(): LinkageState {
  return {
    date: {
      productionDate: { ...EMPTY_DATE_TEXT },
      shelfLife: { ...EMPTY_SHELF_LIFE },
      expiryDate: { ...EMPTY_DATE_TEXT },
      locked: false,
    },
    amount: {
      unitPrice: { ...EMPTY_NUMERIC },
      quantity: { ...EMPTY_NUMERIC },
      amount: { ...EMPTY_NUMERIC },
      locked: false,
    },
  };
}

/** 统计组内 AUTO 槽数量，用于校验「每组至多 1 个 AUTO」。 */
export function countAuto<T>(group: GroupState<T>): number {
  let count = 0;
  for (const slot of group.slots) {
    if (slot.source === FieldSource.AUTO) {
      count += 1;
    }
  }
  return count;
}

/** 校验两组不变量，违反时抛错（正常流程下不会触发）。 */
function assertInvariants(date: DateGroupState, amount: AmountGroupState): void {
  const dateGroup: GroupState<unknown> = {
    slots: [date.productionDate, date.shelfLife, date.expiryDate],
  };
  const amountGroup: GroupState<unknown> = {
    slots: [
      { value: amount.unitPrice.parsed, source: amount.unitPrice.source },
      { value: amount.quantity.parsed, source: amount.quantity.source },
      { value: amount.amount.parsed, source: amount.amount.source },
    ],
  };
  if (countAuto(dateGroup) > 1 || countAuto(amountGroup) > 1) {
    throw new Error('[field-state] 不变量破坏：每组至多 1 个 AUTO');
  }
}

function scaleFor(slot: LinkageSlot): number {
  if (slot === 'unitPrice') {
    return SCALE.UNIT_PRICE;
  }
  if (slot === 'quantity') {
    return SCALE.QUANTITY;
  }
  return SCALE.AMOUNT_CENTS;
}

/** 保质期数值必须是非负整数文本。 */
function parseShelfLifeValue(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) {
    return null;
  }
  const value: number = Number.parseInt(raw.trim(), 10);
  return Number.isSafeInteger(value) ? value : null;
}

function dateSourceOf(date: DateGroupState, slot: LinkageSlot): FieldSource {
  if (slot === 'productionDate') {
    return date.productionDate.source;
  }
  if (slot === 'shelfLife') {
    return date.shelfLife.source;
  }
  if (slot === 'expiryDate') {
    return date.expiryDate.source;
  }
  return FieldSource.EMPTY;
}

function allDateEmpty(date: DateGroupState): boolean {
  return (
    date.productionDate.source === FieldSource.EMPTY &&
    date.shelfLife.source === FieldSource.EMPTY &&
    date.expiryDate.source === FieldSource.EMPTY
  );
}

function allAmountEmpty(amount: AmountGroupState): boolean {
  return (
    amount.unitPrice.source === FieldSource.EMPTY &&
    amount.quantity.source === FieldSource.EMPTY &&
    amount.amount.source === FieldSource.EMPTY
  );
}

function toDateValues(date: DateGroupState): DateGroupValues {
  return {
    productionDate: date.productionDate.value,
    shelfLifeValue: date.shelfLife.value === null ? null : date.shelfLife.value.value,
    shelfLifeUnit: date.shelfLife.value === null ? null : date.shelfLife.value.unit,
    expiryDate: date.expiryDate.value,
  };
}

function toDateSources(date: DateGroupState): DateGroupSourceMap {
  return {
    productionDate: date.productionDate.source,
    shelfLife: date.shelfLife.source,
    expiryDate: date.expiryDate.source,
  };
}

function fromDateResult(result: DateGroupResult, locked: boolean): DateGroupState {
  const shelfValue: ShelfLifeValue | null =
    result.values.shelfLifeValue !== null && result.values.shelfLifeUnit !== null
      ? { value: result.values.shelfLifeValue, unit: result.values.shelfLifeUnit }
      : null;
  return {
    productionDate: {
      value: result.values.productionDate,
      source: result.sources.productionDate,
    },
    shelfLife: { value: shelfValue, source: result.sources.shelfLife },
    expiryDate: { value: result.values.expiryDate, source: result.sources.expiryDate },
    locked,
  };
}

function toAmountValues(amount: AmountGroupState): AmountGroupValues {
  return {
    unitPrice: { raw: amount.unitPrice.raw, parsed: amount.unitPrice.parsed },
    quantity: { raw: amount.quantity.raw, parsed: amount.quantity.parsed },
    amount: { raw: amount.amount.raw, parsed: amount.amount.parsed },
  };
}

function toAmountSources(amount: AmountGroupState): AmountGroupSourceMap {
  return {
    unitPrice: amount.unitPrice.source,
    quantity: amount.quantity.source,
    amount: amount.amount.source,
  };
}

function fromAmountResult(result: AmountGroupResult, locked: boolean): AmountGroupState {
  return {
    unitPrice: { ...result.values.unitPrice, source: result.sources.unitPrice },
    quantity: { ...result.values.quantity, source: result.sources.quantity },
    amount: { ...result.values.amount, source: result.sources.amount },
    locked,
  };
}

function applyDateEvent(date: DateGroupState, event: FieldEvent): DateGroupState {
  const slot: LinkageSlot = event.slot;
  const previousSource: FieldSource = dateSourceOf(date, slot);
  let locked: boolean = date.locked;
  if (event.type === 'userInput' && previousSource === FieldSource.AUTO) {
    locked = true;
  }

  let next: DateGroupState = { ...date, locked };
  if (event.type === 'userClear' || event.raw.trim() === '') {
    if (slot === 'productionDate') {
      next = { ...next, productionDate: { ...EMPTY_DATE_TEXT } };
    } else if (slot === 'shelfLife') {
      next = { ...next, shelfLife: { ...EMPTY_SHELF_LIFE } };
    } else if (slot === 'expiryDate') {
      next = { ...next, expiryDate: { ...EMPTY_DATE_TEXT } };
    }
  } else if (slot === 'productionDate') {
    next = {
      ...next,
      productionDate: { value: event.raw.trim(), source: FieldSource.MANUAL },
    };
  } else if (slot === 'expiryDate') {
    next = {
      ...next,
      expiryDate: { value: event.raw.trim(), source: FieldSource.MANUAL },
    };
  } else if (slot === 'shelfLife') {
    const parsed: number | null = event.parsed ?? parseShelfLifeValue(event.raw);
    const unit = event.unit ?? null;
    const value: ShelfLifeValue | null =
      parsed !== null && unit !== null ? { value: parsed, unit } : null;
    next = { ...next, shelfLife: { value, source: FieldSource.MANUAL } };
  }

  if (allDateEmpty(next)) {
    next = { ...next, locked: false };
  }
  if (next.locked) {
    return next;
  }
  return fromDateResult(computeDateGroup(toDateValues(next), toDateSources(next)), next.locked);
}

function numericSourceOf(amount: AmountGroupState, slot: LinkageSlot): FieldSource {
  if (slot === 'unitPrice') {
    return amount.unitPrice.source;
  }
  if (slot === 'quantity') {
    return amount.quantity.source;
  }
  if (slot === 'amount') {
    return amount.amount.source;
  }
  return FieldSource.EMPTY;
}

function buildNumericField(slot: LinkageSlot, event: FieldEvent): NumericFieldState {
  if (event.type === 'userClear' || event.raw.trim() === '') {
    return { ...EMPTY_NUMERIC };
  }
  const parsed: number | null =
    event.parsed !== undefined ? event.parsed : parseFixed(event.raw, scaleFor(slot));
  return { raw: event.raw, parsed, source: FieldSource.MANUAL };
}

function applyAmountEvent(amount: AmountGroupState, event: FieldEvent): AmountGroupState {
  const slot: LinkageSlot = event.slot;
  const previousSource: FieldSource = numericSourceOf(amount, slot);
  let locked: boolean = amount.locked;
  if (event.type === 'userInput' && previousSource === FieldSource.AUTO) {
    locked = true;
  }

  let next: AmountGroupState = { ...amount, locked };
  const field: NumericFieldState = buildNumericField(slot, event);
  if (slot === 'unitPrice') {
    next = { ...next, unitPrice: field };
  } else if (slot === 'quantity') {
    next = { ...next, quantity: field };
  } else if (slot === 'amount') {
    next = { ...next, amount: field };
  }

  if (allAmountEmpty(next)) {
    next = { ...next, locked: false };
  }
  if (next.locked) {
    return next;
  }
  return fromAmountResult(
    computeAmountGroup(toAmountValues(next), toAmountSources(next)),
    next.locked,
  );
}

/**
 * 全同步纯 reducer：只处理用户输入/清空事件，返回新的不可变状态。
 * 引擎内部推导不改变入参，也不写 MANUAL 槽。
 */
export function applyFieldEvent(state: LinkageState, event: FieldEvent): LinkageState {
  let next: LinkageState;
  if (groupOfSlot(event.slot) === 'date') {
    next = { date: applyDateEvent(state.date, event), amount: state.amount };
  } else {
    next = { date: state.date, amount: applyAmountEvent(state.amount, event) };
  }
  assertInvariants(next.date, next.amount);
  return next;
}
