/**
 * 6 组指标聚合与应用内预警清单。
 *
 * 依据：设计文档 v1.1 §2.4 BR-5、§5.2「/api/dashboard 一个读事务快照内完成」、
 * §10.1 裁决 1/15。统一排除软删（Repository 保证 deleted_at IS NULL，此处再兜一层）、
 * 到期日为空不计入风险项、商品种类数按 name_norm 归一化去重、全程整数累加。
 */
import type { DashboardMetrics, ExpiryAlertItem } from '@stockin/shared';
import { normalizeName } from './normalize';
import { expiryWindow, classifyExpiry } from './expiry';
import type { Today } from './types';

/** 聚合输入：全部定点整数；deletedAt 非空即视为软删记录。 */
export interface AggregateRecord {
  id: number;
  name: string;
  spec: string | null;
  /** 已持久化的归一化列；缺省时由 normalizeName 现场计算。 */
  nameNorm?: string;
  purchaseDate: string;
  productionDate: string | null;
  expiryDate: string | null;
  /** 单价 ×1e4 */
  unitPrice: number;
  /** 数量 ×1e3 */
  quantity: number;
  /** 金额（分） */
  amountCents: number;
  deletedAt?: string | null;
}

function isDeleted(record: AggregateRecord): boolean {
  return record.deletedAt !== null && record.deletedAt !== undefined;
}

function hasExpiry(record: AggregateRecord): boolean {
  return record.expiryDate !== null && record.expiryDate.trim() !== '';
}

/**
 * 单遍条件聚合 6 组指标。零浮点：金额与数量均为整数相加。
 *
 * @param records 有效记录（调用方已按 deleted_at IS NULL 过滤，本函数再兜一层）
 * @param today 服务器本地自然日，由应用层注入
 * @param thresholdDays 当前阈值 X
 */
export function aggregateRules(
  records: readonly AggregateRecord[],
  today: Today,
  thresholdDays: number,
): DashboardMetrics {
  let totalAmountCents = 0;
  let totalRecords = 0;
  let totalQuantity = 0;
  let nearExpiryCount = 0;
  let nearExpiryAmountCents = 0;
  let expiredCount = 0;
  let expiredAmountCents = 0;
  const productNames = new Set<string>();

  for (const record of records) {
    if (isDeleted(record)) {
      continue;
    }
    totalRecords += 1;
    totalAmountCents += record.amountCents;
    totalQuantity += record.quantity;
    productNames.add(record.nameNorm ?? normalizeName(record.name));

    if (!hasExpiry(record)) {
      continue;
    }
    const d: number | null = expiryWindow(today, record.expiryDate, thresholdDays);
    const status = classifyExpiry(d, thresholdDays);
    if (status === 'near') {
      nearExpiryCount += 1;
      nearExpiryAmountCents += record.amountCents;
    } else if (status === 'expired') {
      expiredCount += 1;
      expiredAmountCents += record.amountCents;
    }
  }

  return {
    totalAmountCents,
    totalRecords,
    distinctProducts: productNames.size,
    totalQuantity,
    nearExpiryCount,
    nearExpiryAmountCents,
    expiredCount,
    expiredAmountCents,
  };
}

/**
 * 临期 / 过期预警清单（服务端排定，前端不二次排序）。
 * 排序：到期日升序 → id 升序。
 */
export function buildExpiryAlerts(
  records: readonly AggregateRecord[],
  today: Today,
  thresholdDays: number,
): ExpiryAlertItem[] {
  const items: ExpiryAlertItem[] = [];
  for (const record of records) {
    if (isDeleted(record) || !hasExpiry(record)) {
      continue;
    }
    const d: number | null = expiryWindow(today, record.expiryDate, thresholdDays);
    const status = classifyExpiry(d, thresholdDays);
    if (status !== 'near' && status !== 'expired') {
      continue;
    }
    items.push({
      id: record.id,
      name: record.name,
      spec: record.spec,
      purchaseDate: record.purchaseDate,
      productionDate: record.productionDate,
      expiryDate: record.expiryDate as string,
      unitPrice: record.unitPrice,
      quantity: record.quantity,
      amountCents: record.amountCents,
      remainingDays: d as number,
      status,
    });
  }
  items.sort((a, b) => {
    if (a.expiryDate < b.expiryDate) {
      return -1;
    }
    if (a.expiryDate > b.expiryDate) {
      return 1;
    }
    return a.id - b.id;
  });
  return items;
}
