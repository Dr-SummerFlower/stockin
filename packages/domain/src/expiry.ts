/**
 * 临期 / 过期判定。
 *
 * 依据：设计文档 v1.1 §2.4 BR-5「剩余天数 = 到期日 − 服务器本地自然日；
 * 0 ≤ d ≤ X 为临期（含等号），d < 0 为已过期；到期日为空不计入风险项」、
 * §10.1 裁决 1（单一可配阈值 X，默认 30 天）。
 * 基准日由调用方注入，本模块不读任何系统时钟。
 */
import {
  DEFAULT_EXPIRY_THRESHOLD_DAYS,
  EXPIRY_THRESHOLD_MIN,
  EXPIRY_THRESHOLD_MAX,
} from '@stockin/shared';
import { diffDays, isValidISODate } from './date';
import type { Today } from './types';

export type ExpiryStatus = 'near' | 'expired' | 'none';

function assertToday(today: Today): void {
  if (!isValidISODate(today)) {
    throw new RangeError(`[expiry] 基准日必须是 YYYY-MM-DD: ${today}`);
  }
}

function assertThreshold(thresholdDays: number): void {
  if (
    !Number.isInteger(thresholdDays) ||
    thresholdDays < EXPIRY_THRESHOLD_MIN ||
    thresholdDays > EXPIRY_THRESHOLD_MAX
  ) {
    throw new RangeError(
      `[expiry] 阈值 X 必须是 ${EXPIRY_THRESHOLD_MIN}~${EXPIRY_THRESHOLD_MAX} 的整数: ${String(thresholdDays)}`,
    );
  }
}

/**
 * 剩余天数 d = 到期日 − 基准日。
 * 到期日为空（null / 空串）返回 null 表示不参与风险判定。
 * 第三参数 X 用于阈值合法性校验（d 本身与 X 无关），缺省取 DEFAULT。
 */
export function expiryWindow(
  today: Today,
  expiryDate: Today | null,
  thresholdDays: number = DEFAULT_EXPIRY_THRESHOLD_DAYS,
): number | null {
  assertToday(today);
  assertThreshold(thresholdDays);
  if (expiryDate === null || expiryDate.trim() === '') {
    return null;
  }
  if (!isValidISODate(expiryDate)) {
    throw new RangeError(`[expiry] 到期日必须是 YYYY-MM-DD: ${expiryDate}`);
  }
  return diffDays(expiryDate, today);
}

/**
 * d → 风险分类。含等号边界：d === 0 与 d === X 均为 near；d < 0 为 expired。
 */
export function classifyExpiry(d: number | null, thresholdDays: number): ExpiryStatus {
  assertThreshold(thresholdDays);
  if (d === null) {
    return 'none';
  }
  if (!Number.isSafeInteger(d)) {
    throw new RangeError('[expiry] 剩余天数必须是安全整数');
  }
  if (d < 0) {
    return 'expired';
  }
  if (d <= thresholdDays) {
    return 'near';
  }
  return 'none';
}

/** 便捷组合：基准日 + 到期日 + X → 风险分类。 */
export function expiryStatus(
  today: Today,
  expiryDate: Today | null,
  thresholdDays: number = DEFAULT_EXPIRY_THRESHOLD_DAYS,
): ExpiryStatus {
  return classifyExpiry(expiryWindow(today, expiryDate, thresholdDays), thresholdDays);
}
