/**
 * 设置 Zod schema（zod v4.6.7）。
 * 依据：设计文档 v1.1 §4.2「expiry_threshold_days 默认 30，范围 0~3650」。
 */
import * as z from 'zod';
import {
  DEFAULT_EXPIRY_THRESHOLD_DAYS,
  EXPIRY_THRESHOLD_MIN,
  EXPIRY_THRESHOLD_MAX,
} from '../constants';
import { SHOP_NAME_MAX_LENGTH } from '../security';

export const settingsSchema = z.object({
  expiryThresholdDays: z.number().int().min(EXPIRY_THRESHOLD_MIN).max(EXPIRY_THRESHOLD_MAX),
  /** 店铺名称可选：不传则保持原值，传空串表示清空。 */
  shopName: z.string().max(SHOP_NAME_MAX_LENGTH).optional(),
});
export type SettingsInput = z.infer<typeof settingsSchema>;

/** 阈值缺省值（单一真源来自 constants）。 */
export const DEFAULT_SETTINGS_INPUT: SettingsInput = {
  expiryThresholdDays: DEFAULT_EXPIRY_THRESHOLD_DAYS,
};
