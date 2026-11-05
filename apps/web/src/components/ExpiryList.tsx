/**
 * 临期 / 过期预警清单。
 *
 * 依据：主理人 T04 口径 ⑤⑥ —— status 一律取 `/api/dashboard` 返回值，
 * **不消费 `computeDateGroup` 的派生展示字段**（那份固定用默认 30，阈值改配后会不一致）；
 * 清单由服务端排定，**前端不二次排序**；颜色 + 文字双通道可达性。
 */
import React from 'react';
import { Empty, Typography } from 'antd';
import type { ExpiryAlertItem } from '@stockin/shared';
import { EXPIRY_STATUS_META } from '@/constants/routes';
import {
  formatDate,
  formatMoney,
  formatQuantity,
  formatRemainingDays,
  formatUnitPrice,
} from '@/utils/format';

export interface ExpiryListProps {
  readonly alerts: readonly ExpiryAlertItem[];
  readonly thresholdDays: number;
  readonly baseDate: string;
}

const ExpiryList: React.FC<ExpiryListProps> = ({
  alerts,
  thresholdDays,
  baseDate,
}) => {
  if (alerts.length === 0) {
    return (
      <Empty description={`基准日 ${formatDate(baseDate)}，阈值 ${thresholdDays} 天内无临期 / 过期记录`} />
    );
  }

  return (
    <div className="stockin-alert-list">
      {alerts.map((item) => {
        // status 直接来自 /api/dashboard，不经前端重算。
        const meta = EXPIRY_STATUS_META[item.status];
        return (
          <div key={item.id} className={`stockin-alert-item is-${item.status}`}>
            <div>
              <span className="stockin-alert-name">{item.name}</span>
              <span className={`stockin-status stockin-status-${item.status}`}>
                {meta.text}
              </span>
              {item.spec !== null && item.spec !== '' ? (
                <span className="stockin-alert-meta"> 规格：{item.spec}</span>
              ) : null}
            </div>
            <div className="stockin-alert-meta">
              到期 {formatDate(item.expiryDate)} · {formatRemainingDays(item.remainingDays)} ·
              金额 {formatMoney(item.amountCents)} · 数量 {formatQuantity(item.quantity)} ·
              单价 {formatUnitPrice(item.unitPrice)}
            </div>
          </div>
        );
      })}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        基准日 {formatDate(baseDate)} · 阈值 {thresholdDays} 天 · 清单由服务端排定，前端不二次排序
      </Typography.Text>
    </div>
  );
};

export default ExpiryList;
