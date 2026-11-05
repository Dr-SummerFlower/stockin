/**
 * 保质期 ↔ 日期换算（日历月钳制、闰年、不减 1）。
 *
 * 依据：设计文档 v1.1 §2.4 BR-4「到期日 = 生产日期 + N（不减 1）；月/年按日历
 * 回退并钳制到目标月最后一日；不允许到期日早于生产日期」、
 * §8.3 核心用例 3「月/年钳制、闰年、不可逆不静默改写」。
 */
import { ShelfLifeUnit } from '@stockin/shared';
import {
  addDays,
  addCalendarMonthsClamped,
  compareISODate,
  diffDays,
  parseISODate,
  isValidISODate,
  type CivilDate,
} from './date';
import type { Today } from './types';

function assertDate(value: string, label: string): void {
  if (!isValidISODate(value)) {
    throw new RangeError(`[shelf-life] ${label} 不是合法的 YYYY-MM-DD: ${value}`);
  }
}

function assertValue(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`[shelf-life] 保质期数值必须是非负整数，收到: ${String(value)}`);
  }
}

/** 单位对应的日历月增量（年 = 12 月）。 */
function monthsFor(value: number, unit: ShelfLifeUnit): number {
  switch (unit) {
    case ShelfLifeUnit.MONTH:
      return value;
    case ShelfLifeUnit.YEAR:
      return value * 12;
    default:
      return 0;
  }
}

/**
 * 生产日期 + 保质期 → 到期日期（**不减 1**）。
 * day 走加天；month/year 走日历月并钳制到目标月最后一日。
 */
export function addShelfLife(productionDate: Today, value: number, unit: ShelfLifeUnit): Today {
  assertDate(productionDate, 'productionDate');
  assertValue(value);

  let result: Today;
  if (unit === ShelfLifeUnit.DAY) {
    result = addDays(productionDate, value);
  } else if (unit === ShelfLifeUnit.MONTH || unit === ShelfLifeUnit.YEAR) {
    result = addCalendarMonthsClamped(productionDate, monthsFor(value, unit));
  } else {
    throw new RangeError(`[shelf-life] 未知单位: ${String(unit)}`);
  }

  if (compareISODate(result, productionDate) < 0) {
    throw new RangeError('[shelf-life] 到期日不得早于生产日期');
  }
  return result;
}

/**
 * 到期日期 − 保质期 → 生产日期（日期组「保质期 + 到期日」反推生产日时使用）。
 * 注意：日历月钳制不可逆（1/31 + 1 月 = 2/28，反推得到 1/28），
 * 文档已裁决「钳制不可逆可接受，靠手填优先兜底」。
 */
export function subtractShelfLife(expiryDate: Today, value: number, unit: ShelfLifeUnit): Today {
  assertDate(expiryDate, 'expiryDate');
  assertValue(value);

  if (unit === ShelfLifeUnit.DAY) {
    return addDays(expiryDate, -value);
  }
  if (unit === ShelfLifeUnit.MONTH || unit === ShelfLifeUnit.YEAR) {
    return addCalendarMonthsClamped(expiryDate, -monthsFor(value, unit));
  }
  throw new RangeError(`[shelf-life] 未知单位: ${String(unit)}`);
}

/**
 * 生产日期 + 到期日期 → 保质期数值（按指定单位）。
 * day 直接取天数差；month/year 取「使 addShelfLife 结果不超过到期日」的最大整数 N。
 */
export function diffShelfLife(
  productionDate: Today,
  expiryDate: Today,
  unit: ShelfLifeUnit,
): number {
  assertDate(productionDate, 'productionDate');
  assertDate(expiryDate, 'expiryDate');
  if (compareISODate(expiryDate, productionDate) < 0) {
    throw new RangeError('[shelf-life] 到期日不得早于生产日期');
  }

  if (unit === ShelfLifeUnit.DAY) {
    return diffDays(expiryDate, productionDate);
  }
  if (unit !== ShelfLifeUnit.MONTH && unit !== ShelfLifeUnit.YEAR) {
    throw new RangeError(`[shelf-life] 未知单位: ${String(unit)}`);
  }

  const step: number = unit === ShelfLifeUnit.YEAR ? 12 : 1;
  const start: CivilDate | null = parseISODate(productionDate);
  const end: CivilDate | null = parseISODate(expiryDate);
  if (start === null || end === null) {
    throw new RangeError('[shelf-life] 日期解析失败');
  }
  const monthDelta: number = (end.year - start.year) * 12 + (end.month - start.month);
  let n: number = Math.max(0, Math.floor(monthDelta / step));

  // 上限保护：避免异常输入导致长循环。
  const maxIterations = 10_000;
  let iterations = 0;
  while (n > 0 && compareISODate(addShelfLife(productionDate, n, unit), expiryDate) > 0) {
    n -= 1;
    iterations += 1;
    if (iterations > maxIterations) {
      break;
    }
  }
  while (compareISODate(addShelfLife(productionDate, n + 1, unit), expiryDate) <= 0) {
    n += 1;
    iterations += 1;
    if (iterations > maxIterations) {
      break;
    }
  }
  return n;
}
