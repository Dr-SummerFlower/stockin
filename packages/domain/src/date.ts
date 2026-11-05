/**
 * 纯算术日期工具（YYYY-MM-DD）。
 *
 * 硬约束：全文件不读系统时钟、不构造 `Date` 对象、不调用 `Date.now()`，
 * 所有换算基于整数「civil date ↔ days since 1970-01-01」算法，
 * 因此跨时区结果完全一致。依据：设计文档 v1.1 §2.4 BR-4、§5.1。
 */

export interface CivilDate {
  year: number;
  month: number;
  day: number;
}

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 闰年判定（格里高利历）。 */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const MONTH_LENGTHS: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** 某年某月的天数（也是该月最后一日）。非法月份返回 0。 */
export function daysInMonth(year: number, month: number): number {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return 0;
  }
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }
  return MONTH_LENGTHS[month - 1] ?? 0;
}

/** 月末日期（别名，语义更明确）。 */
export function endOfMonth(year: number, month: number): number {
  return daysInMonth(year, month);
}

/** 严格解析 YYYY-MM-DD，含闰年与月份范围校验。失败返回 null。 */
export function parseISODate(value: string): CivilDate | null {
  const match: RegExpExecArray | null = ISO_DATE_PATTERN.exec(value);
  if (match === null) {
    return null;
  }
  const year: number = Number.parseInt(match[1] ?? '', 10);
  const month: number = Number.parseInt(match[2] ?? '', 10);
  const day: number = Number.parseInt(match[3] ?? '', 10);
  if (!Number.isInteger(year) || year < 1 || year > 9999) {
    return null;
  }
  if (month < 1 || month > 12) {
    return null;
  }
  const lastDay: number = daysInMonth(year, month);
  if (day < 1 || day > lastDay) {
    return null;
  }
  return { year, month, day };
}

/** 格式化为 YYYY-MM-DD（不校验，调用方需保证日期合法）。 */
export function formatISODate(date: CivilDate): string {
  const y: string = String(date.year).padStart(4, '0');
  const m: string = String(date.month).padStart(2, '0');
  const d: string = String(date.day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function isValidISODate(value: string): boolean {
  return parseISODate(value) !== null;
}

/** 断言合法日期，否则抛错（避免静默产生非法结果）。 */
function requireISODate(value: string, label: string): CivilDate {
  const parsed: CivilDate | null = parseISODate(value);
  if (parsed === null) {
    throw new RangeError(`[date] ${label} 不是合法的 YYYY-MM-DD: ${value}`);
  }
  return parsed;
}

/**
 * civil date → 距 1970-01-01 的天数（Howard Hinnant days_from_civil）。
 * 纯整数运算，负数年份也正确。
 */
function daysFromCivil(year: number, month: number, day: number): number {
  let y: number = year;
  y -= month <= 2 ? 1 : 0;
  const era: number = Math.floor(y / 400);
  const yoe: number = y - era * 400;
  const mp: number = month + (month > 2 ? -3 : 9);
  const doy: number = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe: number = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** 距 1970-01-01 的天数 → civil date（Hinnant civil_from_days）。 */
function civilFromDays(dayNumber: number): CivilDate {
  const z: number = dayNumber + 719468;
  const era: number = Math.floor(z / 146097);
  const doe: number = z - era * 146097;
  const yoe: number = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  let y: number = yoe + era * 400;
  const doy: number = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp: number = Math.floor((5 * doy + 2) / 153);
  const d: number = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m: number = mp + (mp < 10 ? 3 : -9);
  y += m <= 2 ? 1 : 0;
  return { year: y, month: m, day: d };
}

/** 日期 → 天序号。 */
export function toDayNumber(date: string | CivilDate): number {
  const civil: CivilDate | null = typeof date === 'string' ? parseISODate(date) : date;
  if (civil === null) {
    throw new RangeError('[date] 非法日期');
  }
  return daysFromCivil(civil.year, civil.month, civil.day);
}

/** 天序号 → YYYY-MM-DD。 */
export function fromDayNumber(dayNumber: number): CivilDate {
  if (!Number.isSafeInteger(dayNumber)) {
    throw new RangeError('[date] 天序号必须是安全整数');
  }
  return civilFromDays(dayNumber);
}

/** 日期加 N 天（N 可为负）。 */
export function addDays(date: string, days: number): string {
  const civil: CivilDate = requireISODate(date, 'date');
  if (!Number.isSafeInteger(days)) {
    throw new RangeError('[date] 天数必须是安全整数');
  }
  return formatISODate(civilFromDays(daysFromCivil(civil.year, civil.month, civil.day) + days));
}

/** a − b 的天数差；a 晚于 b 为正。 */
export function diffDays(a: string, b: string): number {
  return toDayNumber(a) - toDayNumber(b);
}

/** 字典序即时间序；返回 -1 / 0 / 1。 */
export function compareISODate(a: string, b: string): number {
  const delta: number = diffDays(a, b);
  return delta < 0 ? -1 : delta > 0 ? 1 : 0;
}

/**
 * 按日历月加减并**钳制到目标月最后一日**。
 * 例：2025-01-31 + 1 月 → 2025-02-28；2024-01-31 + 1 月 → 2024-02-29。
 * 钳制不可逆（文档 §2.4「钳制不可逆可接受，靠手填优先兜底」）。
 */
export function addCalendarMonthsClamped(date: string, months: number): string {
  const civil: CivilDate = requireISODate(date, 'date');
  if (!Number.isSafeInteger(months)) {
    throw new RangeError('[date] 月数必须是安全整数');
  }
  const total: number = civil.year * 12 + (civil.month - 1) + months;
  const year: number = Math.floor(total / 12);
  const month: number = ((total % 12) + 12) % 12 + 1;
  const day: number = Math.min(civil.day, daysInMonth(year, month));
  return formatISODate({ year, month, day });
}
