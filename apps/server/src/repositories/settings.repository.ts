/**
 * `settings` 单行表 SQL：临期阈值 X。
 *
 * 依据：设计文档 v1.1 §4.2 / §10.1 裁决 1 —— 单一可配阈值，默认 30 天，
 * 范围 0~3650，默认值与范围全部取自 @stockin/shared。
 */
import {
  DEFAULT_EXPIRY_THRESHOLD_DAYS,
  EXPIRY_THRESHOLD_MAX,
  EXPIRY_THRESHOLD_MIN,
} from '@stockin/shared';
import type { Db } from './db';
import type { SettingsRow } from './types';

export class SettingsRepository {
  constructor(private readonly db: Db) {}

  getRow(): SettingsRow {
    const row = this.db.prepare('SELECT * FROM settings WHERE id = 1').get() as
      | SettingsRow
      | undefined;
    if (row === undefined) {
      throw new Error('[settings] 单行配置缺失，迁移未正确执行');
    }
    return row;
  }

  getThresholdDays(): number {
    const value: number = this.getRow().expiry_threshold_days;
    return Number.isSafeInteger(value) ? value : DEFAULT_EXPIRY_THRESHOLD_DAYS;
  }

  /** 写入前在应用层校验范围（表级 CHECK 再兜一层）。 */
  setThresholdDays(days: number): boolean {
    if (!Number.isInteger(days) || days < EXPIRY_THRESHOLD_MIN || days > EXPIRY_THRESHOLD_MAX) {
      throw new RangeError(
        `[settings] 阈值必须是 ${EXPIRY_THRESHOLD_MIN}~${EXPIRY_THRESHOLD_MAX} 的整数: ${String(days)}`,
      );
    }
    return (
      this.db.prepare('UPDATE settings SET expiry_threshold_days = ? WHERE id = 1').run(days)
        .changes > 0
    );
  }

  getShopName(): string {
    return this.getRow().shop_name ?? '';
  }

  /** 店铺名称纯展示，不做业务校验，仅裁掉首尾空白。 */
  setShopName(name: string): boolean {
    return (
      this.db.prepare('UPDATE settings SET shop_name = ? WHERE id = 1').run(name.trim()).changes > 0
    );
  }
}
