import { describe, expect, it } from 'vitest';
import { DEFAULT_EXPIRY_THRESHOLD_DAYS } from '@stockin/shared';
import { classifyExpiry, expiryStatus, expiryWindow } from '../src/expiry';

/**
 * 临期/过期判定（设计文档 §2.4 BR-5）：
 * d = 到期日 − 基准日；0 ≤ d ≤ X 为临期（含等号），d < 0 为过期，到期日为空不计入。
 */
describe('expiryWindow 剩余天数', () => {
  it('到期日 − 基准日，可正可负', () => {
    expect(expiryWindow('2024-01-01', '2024-01-31')).toBe(30);
    expect(expiryWindow('2024-01-31', '2024-01-01')).toBe(-30);
    expect(expiryWindow('2024-01-01', '2024-01-01')).toBe(0);
  });

  it('到期日为空返回 null（不参与风险项）', () => {
    expect(expiryWindow('2024-01-01', null)).toBeNull();
    expect(expiryWindow('2024-01-01', '')).toBeNull();
  });

  it('跨年与闰日计算正确', () => {
    expect(expiryWindow('2024-12-31', '2025-01-01')).toBe(1);
    expect(expiryWindow('2024-02-28', '2024-03-01')).toBe(2);
  });

  it('非法基准日或到期日抛错', () => {
    expect(() => expiryWindow('2024-02-30', '2024-03-01')).toThrow();
    expect(() => expiryWindow('2024-01-01', '2024-02-30')).toThrow();
  });

  it('阈值越界抛错', () => {
    expect(() => expiryWindow('2024-01-01', '2024-03-01', -1)).toThrow();
    expect(() => expiryWindow('2024-01-01', '2024-03-01', 3651)).toThrow();
  });
});

describe('classifyExpiry 风险分类边界', () => {
  it('d = 0 与 d = X 都属于临期（含等号）', () => {
    expect(classifyExpiry(0, DEFAULT_EXPIRY_THRESHOLD_DAYS)).toBe('near');
    expect(classifyExpiry(DEFAULT_EXPIRY_THRESHOLD_DAYS, DEFAULT_EXPIRY_THRESHOLD_DAYS)).toBe(
      'near',
    );
  });

  it('d = X + 1 不告警，d = -1 为过期', () => {
    expect(classifyExpiry(DEFAULT_EXPIRY_THRESHOLD_DAYS + 1, DEFAULT_EXPIRY_THRESHOLD_DAYS)).toBe(
      'none',
    );
    expect(classifyExpiry(-1, DEFAULT_EXPIRY_THRESHOLD_DAYS)).toBe('expired');
  });

  it('到期日为空归类为 none', () => {
    expect(classifyExpiry(null, DEFAULT_EXPIRY_THRESHOLD_DAYS)).toBe('none');
  });

  it('阈值 0 时只有当天算临期', () => {
    expect(classifyExpiry(0, 0)).toBe('near');
    expect(classifyExpiry(1, 0)).toBe('none');
  });
});

describe('expiryStatus 组合判定', () => {
  it('基准日 + 到期日 → 状态', () => {
    expect(expiryStatus('2024-01-01', '2024-01-15')).toBe('near');
    expect(expiryStatus('2024-01-01', '2023-12-31')).toBe('expired');
    expect(expiryStatus('2024-01-01', '2024-12-31')).toBe('none');
    expect(expiryStatus('2024-01-01', null)).toBe('none');
  });
});
