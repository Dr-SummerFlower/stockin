import { describe, expect, it } from 'vitest';
import {
  addCalendarMonthsClamped,
  addDays,
  compareISODate,
  daysInMonth,
  diffDays,
  formatISODate,
  fromDayNumber,
  isLeapYear,
  isValidISODate,
  parseISODate,
  toDayNumber,
} from '../src/date';

/**
 * 纯算术日历（不读系统时钟、不构造 Date）：
 * 闰年、月末钳制、跨年回退、非法日期一律不静默放过。
 */
describe('isLeapYear 闰年判定', () => {
  it('4 年一闰，100 年不闰，400 年再闰', () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2023)).toBe(false);
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
  });
});

describe('daysInMonth', () => {
  it('二月随闰年变化，非法月份返回 0', () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2025, 2)).toBe(28);
    expect(daysInMonth(2024, 4)).toBe(30);
    expect(daysInMonth(2024, 12)).toBe(31);
    expect(daysInMonth(2024, 13)).toBe(0);
    expect(daysInMonth(2024, 0)).toBe(0);
  });
});

describe('parseISODate 严格解析', () => {
  it('接受合法日期', () => {
    expect(parseISODate('2024-02-29')).toEqual({ year: 2024, month: 2, day: 29 });
  });

  it('拒绝非闰年 2 月 29 日、越界日与格式错误', () => {
    for (const value of [
      '2025-02-29',
      '2024-02-30',
      '2024-13-01',
      '2024-00-10',
      '2024-1-1',
      '2024/01/01',
      '',
    ]) {
      expect(parseISODate(value)).toBeNull();
      expect(isValidISODate(value)).toBe(false);
    }
  });
});

describe('formatISODate', () => {
  it('补零到 YYYY-MM-DD', () => {
    expect(formatISODate({ year: 2024, month: 1, day: 5 })).toBe('2024-01-05');
  });
});

describe('天序号往返与加减', () => {
  it('1970-01-01 为 0，往返一致', () => {
    expect(toDayNumber('1970-01-01')).toBe(0);
    expect(formatISODate(fromDayNumber(0))).toBe('1970-01-01');
    expect(formatISODate(fromDayNumber(toDayNumber('2024-02-29')))).toBe('2024-02-29');
  });

  it('跨月、跨年、闰日加天都正确', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2024-02-29', 1)).toBe('2024-03-01');
    expect(addDays('2024-12-31', 1)).toBe('2025-01-01');
    expect(addDays('2024-01-01', -1)).toBe('2023-12-31');
  });

  it('diffDays 与 compareISODate 同源', () => {
    expect(diffDays('2024-03-01', '2024-02-28')).toBe(2);
    expect(compareISODate('2024-01-01', '2024-01-02')).toBe(-1);
    expect(compareISODate('2024-01-02', '2024-01-02')).toBe(0);
    expect(compareISODate('2024-01-03', '2024-01-02')).toBe(1);
  });
});

describe('addCalendarMonthsClamped 日历月 + 月末钳制', () => {
  it('1/31 + 1 月钳制到 2 月末（闰年 29 日、平年 28 日）', () => {
    expect(addCalendarMonthsClamped('2025-01-31', 1)).toBe('2025-02-28');
    expect(addCalendarMonthsClamped('2024-01-31', 1)).toBe('2024-02-29');
  });

  it('跨年回退与负增量正确', () => {
    expect(addCalendarMonthsClamped('2024-01-31', 12)).toBe('2025-01-31');
    expect(addCalendarMonthsClamped('2024-03-31', -1)).toBe('2024-02-29');
    expect(addCalendarMonthsClamped('2024-01-15', -1)).toBe('2023-12-15');
  });

  it('无需钳制时日期不变', () => {
    expect(addCalendarMonthsClamped('2024-01-15', 1)).toBe('2024-02-15');
  });

  it('非法输入抛错，不静默返回非法日期', () => {
    expect(() => addCalendarMonthsClamped('2024-02-30', 1)).toThrow();
    expect(() => addCalendarMonthsClamped('2024-01-01', 1.5)).toThrow();
  });
});
