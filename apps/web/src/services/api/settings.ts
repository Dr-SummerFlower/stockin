/**
 * 设置 API（路径以 T03b `settings.routes.ts` 实际注册为准）。
 * 设置页只改阈值 `expiryThresholdDays`。
 */
import type { SettingsInput } from '@stockin/shared';
import { request } from '../request';

export interface SettingsView {
  readonly expiryThresholdDays: number;
  readonly shopName: string;
}

export function getSettings(): Promise<SettingsView> {
  return request<SettingsView>('/api/settings');
}

export function updateSettings(input: SettingsInput): Promise<SettingsView> {
  return request<SettingsView>('/api/settings', { method: 'PUT', json: input, silent: true });
}
