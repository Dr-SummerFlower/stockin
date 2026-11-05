/**
 * 大屏 6 组指标卡（纯 CSS Grid / DOM，零图表库）。
 *
 * 依据：设计文档 §2.4 BR-5、主理人 T04 口径 ⑥。
 * 数值一律经 `utils/format.ts` 复用 domain 定点格式化，不在此重算。
 * 临期 / 过期卡片用「颜色 + 文字」双通道表达，不只靠颜色。
 */
import React from 'react';
import type { DashboardMetrics } from '@stockin/shared';
import { formatCount, formatMoney, formatQuantity } from '@/utils/format';

export interface MetricCardsProps {
  readonly metrics: DashboardMetrics;
}

interface CardDef {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly sub?: string;
  readonly tone?: 'near' | 'expired';
}

const MetricCards: React.FC<MetricCardsProps> = ({ metrics }) => {
  const cards: readonly CardDef[] = [
    {
      key: 'amount',
      label: '① 累计进货金额',
      value: formatMoney(metrics.totalAmountCents),
    },
    {
      key: 'records',
      label: '② 累计进货笔数',
      value: `${formatCount(metrics.totalRecords)} 笔`,
    },
    {
      key: 'products',
      label: '③ 商品种类数',
      value: `${formatCount(metrics.distinctProducts)} 种`,
    },
    {
      key: 'quantity',
      label: '④ 累计进货数量',
      value: formatQuantity(metrics.totalQuantity),
    },
    {
      key: 'near',
      label: '⑤ 临期笔数 / 金额',
      value: `${formatCount(metrics.nearExpiryCount)} 笔`,
      sub: formatMoney(metrics.nearExpiryAmountCents),
      tone: 'near',
    },
    {
      key: 'expired',
      label: '⑥ 过期笔数 / 金额',
      value: `${formatCount(metrics.expiredCount)} 笔`,
      sub: formatMoney(metrics.expiredAmountCents),
      tone: 'expired',
    },
  ];

  return (
    <div className="stockin-metric-grid">
      {cards.map((card) => (
        <div
          key={card.key}
          className={`stockin-metric-card${card.tone !== undefined ? ` is-${card.tone}` : ''}`}
        >
          <div className="stockin-metric-label">{card.label}</div>
          <div className="stockin-metric-value">{card.value}</div>
          {card.sub !== undefined ? (
            <div className="stockin-metric-sub">金额 {card.sub}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
};

export default MetricCards;
