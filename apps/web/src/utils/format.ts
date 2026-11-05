/**
 * 全站展示格式化工具。
 *
 * 依据：设计文档 v1.1 §2.4「展示格式」——全站 `YYYY-MM-DD`；
 * 金额千分位 + 2 位（展示态带 ¥、录入态不带）；保质期「数值 + 单位」。
 * 单位文案一律取 `@stockin/shared` 的 `SHELF_LIFE_UNIT_LABELS`（Excel「12个月」唯一真源），
 * 定点整数 ↔ 文本一律复用 `@stockin/domain` 的 `formatFixed` / `parseFixed`，不重新实现。
 */
import {
  DATE_FORMAT,
  SCALE,
  SHELF_LIFE_UNIT_LABELS,
  type ShelfLifeUnit,
} from '@stockin/shared';
import { formatFixed } from '@stockin/domain';

/** 全站日期展示格式常量（来自 shared，避免另写一份）。 */
export const DISPLAY_DATE_FORMAT: string = DATE_FORMAT;

/** YYYY-MM-DD 合法性（仅格式，日历合法性由 domain/date.ts 负责）。 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 日期展示：空值显示占位符，其余原样输出 YYYY-MM-DD。 */
export function formatDate(value: string | null | undefined): string {
  if (value === null || value === undefined || value.trim() === '') {
    return '—';
  }
  return DATE_PATTERN.test(value) ? value : value;
}

/** 是否为 YYYY-MM-DD 文本。 */
export function isDateString(value: string): boolean {
  return DATE_PATTERN.test(value);
}

/** UTC ISO 8601 审计时间戳 → `YYYY-MM-DD HH:mm:ss`（日志只读展示）。 */
export function formatDateTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') {
    return '—';
  }
  const match: RegExpExecArray | null = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(iso);
  if (match === null) {
    return iso;
  }
  return `${match[1]} ${match[2]}`;
}

/** 千分位分隔（作用于不含小数的整数文本）。 */
export function groupThousands(intText: string): string {
  const negative: boolean = intText.startsWith('-');
  const digits: string = negative ? intText.slice(1) : intText;
  const grouped: string = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return negative ? `-${grouped}` : grouped;
}

/** 定点整数 → 带千分位的小数文本（金额展示态）。 */
export function formatMoney(cents: number, withSymbol: boolean = true): string {
  const plain: string = formatFixed(Math.trunc(cents), SCALE.AMOUNT_CENTS);
  const dot: number = plain.indexOf('.');
  const intPart: string = dot === -1 ? plain : plain.slice(0, dot);
  const fracPart: string = dot === -1 ? '' : plain.slice(dot);
  const text: string = `${groupThousands(intPart)}${fracPart}`;
  return withSymbol ? `¥${text}` : text;
}

/** 金额录入态：不带 ¥、不带千分位、固定 2 位小数（供输入框初值）。 */
export function formatMoneyInput(cents: number): string {
  return formatFixed(Math.trunc(cents), SCALE.AMOUNT_CENTS);
}

/** 单价展示（×1e4 定点整数 → 4 位小数文本）。 */
export function formatUnitPrice(scaled: number): string {
  return formatFixed(Math.trunc(scaled), SCALE.UNIT_PRICE);
}

/** 数量展示（×1e3 定点整数 → 3 位小数文本）。 */
export function formatQuantity(scaled: number): string {
  return formatFixed(Math.trunc(scaled), SCALE.QUANTITY);
}

/** 整数（笔数 / 种类数 / 数量汇总）千分位展示。 */
export function formatCount(value: number): string {
  return groupThousands(String(Math.trunc(value)));
}

/** 保质期「数值 + 单位」：单位文案来自 shared 唯一真源（如 "12个月"）。 */
export function formatShelfLife(
  value: number | null | undefined,
  unit: ShelfLifeUnit | null | undefined,
): string {
  if (value === null || value === undefined || unit === null || unit === undefined) {
    return '—';
  }
  return `${value}${SHELF_LIFE_UNIT_LABELS[unit]}`;
}

/**
 * 下拉单字单位标签（**仅展示层**使用）。
 * 绝不修改 shared 的 `SHELF_LIFE_UNIT_LABELS`，避免打断「导出→导入」闭环。
 * 提交与 Excel 列文案仍走 `SHELF_LIFE_UNIT_LABELS` / `formatShelfLife`。
 */
export const SHORT_UNIT_LABELS: Readonly<Record<ShelfLifeUnit, string>> = {
  day: '天',
  month: '月',
  year: '年',
};

/** 剩余天数文案：临期 ≥0，过期 <0。 */
export function formatRemainingDays(days: number): string {
  if (days < 0) {
    return `已过期 ${Math.abs(days)} 天`;
  }
  return `剩余 ${days} 天`;
}
