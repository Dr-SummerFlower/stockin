/**
 * 两组「三选二」推导。
 *
 * 依据：设计文档 v1.1 §2.4 BR-1/BR-2/BR-3、§5.1 三选二状态机不变量
 * 「引擎永不写 MANUAL 槽 / 每组至多 1 个 AUTO / AUTO 不可作推导锚点 / 全同步」、
 * §5.1「数值输入用 raw/parsed 双态，避免 0. 等中间态误判除零」。
 */
import {
  SCALE,
  FieldSource,
  ShelfLifeUnit,
  DEFAULT_EXPIRY_THRESHOLD_DAYS,
  type NumericInput,
} from '@stockin/shared';
import { addShelfLife, subtractShelfLife, diffShelfLife } from './shelf-life';
import { fixedMul, fixedDiv, formatFixed } from './fixed';
import { expiryWindow, classifyExpiry, type ExpiryStatus } from './expiry';
import { isValidISODate, compareISODate } from './date';
import type { Today } from './types';

export interface DateGroupValues {
  productionDate: string | null;
  shelfLifeValue: number | null;
  shelfLifeUnit: ShelfLifeUnit | null;
  expiryDate: string | null;
}

export interface DateGroupSourceMap {
  productionDate: FieldSource;
  shelfLife: FieldSource;
  expiryDate: FieldSource;
}

export interface DateGroupResult {
  values: DateGroupValues;
  sources: DateGroupSourceMap;
  /** 传入 today 时附带派生展示属性（不落库）。 */
  remainingDays?: number | null;
  expiryStatus?: ExpiryStatus;
}

export interface AmountGroupValues {
  unitPrice: NumericInput;
  quantity: NumericInput;
  amount: NumericInput;
}

export interface AmountGroupSourceMap {
  unitPrice: FieldSource;
  quantity: FieldSource;
  amount: FieldSource;
}

export interface AmountGroupResult {
  values: AmountGroupValues;
  sources: AmountGroupSourceMap;
}

function emptyNumeric(): NumericInput {
  return { raw: '', parsed: null };
}

function isManual(source: FieldSource): boolean {
  return source === FieldSource.MANUAL;
}

function validDate(value: string | null): value is string {
  return value !== null && value.trim() !== '' && isValidISODate(value);
}

/** 捕获推导过程的非法输入，返回 null 而不是让整组联动崩溃。 */
function tryDerive<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/**
 * 日期组三选二。
 *
 * @param fields 三个槽位的当前值
 * @param sources 三个槽位的来源标记
 * @param today 可选基准日；传入时额外计算 remainingDays / expiryStatus
 */
export function computeDateGroup(
  fields: DateGroupValues,
  sources: DateGroupSourceMap,
  today?: Today,
): DateGroupResult {
  const values: DateGroupValues = { ...fields };
  const src: DateGroupSourceMap = { ...sources };

  // 1) 清空全部 AUTO 槽：AUTO 不可作锚点，且保证每组至多 1 个 AUTO。
  if (src.productionDate === FieldSource.AUTO) {
    values.productionDate = null;
    src.productionDate = FieldSource.EMPTY;
  }
  if (src.shelfLife === FieldSource.AUTO) {
    values.shelfLifeValue = null;
    values.shelfLifeUnit = null;
    src.shelfLife = FieldSource.EMPTY;
  }
  if (src.expiryDate === FieldSource.AUTO) {
    values.expiryDate = null;
    src.expiryDate = FieldSource.EMPTY;
  }

  // 2) 保质期「数值 + 单位」必须成对，否则视为空。
  const shelfOk: boolean =
    values.shelfLifeValue !== null && values.shelfLifeUnit !== null;
  if (!shelfOk) {
    values.shelfLifeValue = null;
    values.shelfLifeUnit = null;
  }

  const hasProd: boolean = isManual(src.productionDate) && validDate(values.productionDate);
  const hasShelf: boolean = isManual(src.shelfLife) && shelfOk;
  const hasExpiry: boolean = isManual(src.expiryDate) && validDate(values.expiryDate);
  const anchorCount: number = Number(hasProd) + Number(hasShelf) + Number(hasExpiry);

  // 3) 恰好 2 个 MANUAL 锚点时，仅当第三槽为 EMPTY 才写 AUTO（引擎永不写 MANUAL 槽）。
  if (anchorCount === 2) {
    if (!hasProd && src.productionDate === FieldSource.EMPTY && hasShelf && hasExpiry) {
      const derived = tryDerive(() =>
        subtractShelfLife(
          values.expiryDate as string,
          values.shelfLifeValue as number,
          values.shelfLifeUnit as ShelfLifeUnit,
        ),
      );
      if (derived !== null && validDate(derived)) {
        values.productionDate = derived;
        src.productionDate = FieldSource.AUTO;
      }
    } else if (!hasShelf && src.shelfLife === FieldSource.EMPTY && hasProd && hasExpiry) {
      const unit: ShelfLifeUnit = values.shelfLifeUnit ?? ShelfLifeUnit.DAY;
      const prod: string = values.productionDate as string;
      const expiry: string = values.expiryDate as string;
      const derived = tryDerive(() => {
        if (compareISODate(expiry, prod) < 0) {
          throw new RangeError('[groups] 到期日早于生产日期');
        }
        return diffShelfLife(prod, expiry, unit);
      });
      if (derived !== null) {
        values.shelfLifeValue = derived;
        values.shelfLifeUnit = unit;
        src.shelfLife = FieldSource.AUTO;
      }
    } else if (!hasExpiry && src.expiryDate === FieldSource.EMPTY && hasProd && hasShelf) {
      const derived = tryDerive(() =>
        addShelfLife(
          values.productionDate as string,
          values.shelfLifeValue as number,
          values.shelfLifeUnit as ShelfLifeUnit,
        ),
      );
      if (derived !== null && validDate(derived)) {
        values.expiryDate = derived;
        src.expiryDate = FieldSource.AUTO;
      }
    }
  }

  // 4) 推导完成后再次校验「到期日不得早于生产日期」，非法则撤销本次推导结果。
  if (validDate(values.productionDate) && validDate(values.expiryDate)) {
    if (compareISODate(values.expiryDate, values.productionDate) < 0) {
      if (src.expiryDate === FieldSource.AUTO) {
        values.expiryDate = null;
        src.expiryDate = FieldSource.EMPTY;
      } else {
        values.productionDate = null;
        src.productionDate = FieldSource.EMPTY;
      }
    }
  }

  const result: DateGroupResult = { values, sources: src };
  if (today !== undefined) {
    const d: number | null = expiryWindow(today, values.expiryDate, DEFAULT_EXPIRY_THRESHOLD_DAYS);
    result.remainingDays = d;
    result.expiryStatus = classifyExpiry(d, DEFAULT_EXPIRY_THRESHOLD_DAYS);
  }
  return result;
}

/**
 * 金额组三选二。除零（数量或单价为 0）时 `fixedDiv` 返回 null，
 * 本函数**不执行推导**，绝不产生 NaN/Infinity。`parsed === null` 的中间态不作锚点。
 */
export function computeAmountGroup(
  fields: AmountGroupValues,
  sources: AmountGroupSourceMap,
): AmountGroupResult {
  const values: AmountGroupValues = {
    unitPrice: { ...fields.unitPrice },
    quantity: { ...fields.quantity },
    amount: { ...fields.amount },
  };
  const src: AmountGroupSourceMap = { ...sources };

  // 1) 清空全部 AUTO 槽。
  if (src.unitPrice === FieldSource.AUTO) {
    values.unitPrice = emptyNumeric();
    src.unitPrice = FieldSource.EMPTY;
  }
  if (src.quantity === FieldSource.AUTO) {
    values.quantity = emptyNumeric();
    src.quantity = FieldSource.EMPTY;
  }
  if (src.amount === FieldSource.AUTO) {
    values.amount = emptyNumeric();
    src.amount = FieldSource.EMPTY;
  }

  const hasPrice: boolean = isManual(src.unitPrice) && values.unitPrice.parsed !== null;
  const hasQty: boolean = isManual(src.quantity) && values.quantity.parsed !== null;
  const hasAmount: boolean = isManual(src.amount) && values.amount.parsed !== null;
  const anchorCount: number = Number(hasPrice) + Number(hasQty) + Number(hasAmount);

  if (anchorCount === 2) {
    const price: number = values.unitPrice.parsed as number;
    const qty: number = values.quantity.parsed as number;
    const amount: number = values.amount.parsed as number;

    if (!hasAmount && src.amount === FieldSource.EMPTY && hasPrice && hasQty) {
      const derived: number = fixedMul(
        price,
        qty,
        SCALE.UNIT_PRICE,
        SCALE.QUANTITY,
        SCALE.AMOUNT_CENTS,
      );
      values.amount = {
        raw: formatFixed(derived, SCALE.AMOUNT_CENTS),
        parsed: derived,
      };
      src.amount = FieldSource.AUTO;
    } else if (!hasPrice && src.unitPrice === FieldSource.EMPTY && hasAmount && hasQty) {
      const derived: number | null = fixedDiv(
        amount,
        qty,
        SCALE.AMOUNT_CENTS,
        SCALE.QUANTITY,
        SCALE.UNIT_PRICE,
      );
      if (derived !== null) {
        values.unitPrice = {
          raw: formatFixed(derived, SCALE.UNIT_PRICE),
          parsed: derived,
        };
        src.unitPrice = FieldSource.AUTO;
      }
    } else if (!hasQty && src.quantity === FieldSource.EMPTY && hasAmount && hasPrice) {
      const derived: number | null = fixedDiv(
        amount,
        price,
        SCALE.AMOUNT_CENTS,
        SCALE.UNIT_PRICE,
        SCALE.QUANTITY,
      );
      if (derived !== null) {
        values.quantity = {
          raw: formatFixed(derived, SCALE.QUANTITY),
          parsed: derived,
        };
        src.quantity = FieldSource.AUTO;
      }
    }
  }

  return { values, sources: src };
}
