/**
 * 大屏指标区：4 项细线指标带（①–④）+ 2 项独立风险栏（⑤⑥）。
 *
 * 依据：design/stockin-ui-design-system.md §5.1 与原型 view-dashboard。
 * 6 组指标编号与 v1.1 §2.4 口径一一对应，数值直接取 `GET /api/dashboard`
 * 的全表聚合结果，前端不二次加工、不做趋势图 / 排行 / 下钻。
 * 风险项独立成栏且权重高于普通累计值；颜色 + 文字双通道，不只靠颜色。
 * 纯 CSS Grid / DOM，零图表库。
 */
import React from 'react';
import type { DashboardMetrics } from '@stockin/shared';
import Icon, { type IconName } from '@/components/Icon';
import { formatCount, formatMoney, formatQuantity } from '@/utils/format';

export interface MetricCardsProps {
  readonly metrics: DashboardMetrics;
}

interface BandItem {
  readonly icon: IconName;
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
}

/** ①–④ 基础指标：细线分隔的指标带，不是 6 个等大英雄卡。图标替代序号，语义更直观。 */
export const MetricBand: React.FC<MetricCardsProps> = ({ metrics }) => {
  const items: readonly BandItem[] = [
    {
      icon: 'wallet',
      label: '累计进货金额',
      value: formatMoney(metrics.totalAmountCents),
    },
    {
      icon: 'receipt',
      label: '累计进货笔数',
      value: formatCount(metrics.totalRecords),
      unit: '笔',
    },
    {
      icon: 'boxes',
      label: '商品种类',
      value: formatCount(metrics.distinctProducts),
      unit: '种',
    },
    {
      icon: 'layers',
      label: '累计进货数量',
      value: formatQuantity(metrics.totalQuantity),
    },
  ];

  return (
    <div className="stockin-metric-band-wrap">
      <div className="stockin-metric-band">
        {items.map((item) => (
          <div key={item.label} className="stockin-metric">
            <div className="stockin-metric-label">
              <Icon name={item.icon} />
              {item.label}
            </div>
            <div className="stockin-metric-value">
              {item.value}
              {item.unit !== undefined ? (
                <span className="stockin-metric-unit">{item.unit}</span>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export interface RiskColumnProps extends MetricCardsProps {
  readonly onAdjust: () => void;
}

/** ⑤⑥ 风险栏：左侧色条 + 语义浅底 + 大数，与普通累计值视觉区分。 */
export const RiskColumn: React.FC<RiskColumnProps> = ({
  metrics,
  onAdjust,
}) => (
  <aside className="stockin-risk-column">
    <div className="stockin-risk-block is-near">
      <div className="stockin-risk-block-label">
        <Icon name="clock" /> 临期笔数
      </div>
      <div className="stockin-risk-block-value">
        {formatCount(metrics.nearExpiryCount)}
        <small>笔</small>
      </div>
      <div className="stockin-risk-block-sub">
        金额 {formatMoney(metrics.nearExpiryAmountCents)}
      </div>
    </div>

    <div className="stockin-risk-block is-expired">
      <div className="stockin-risk-block-label">
        <Icon name="calendarX" /> 已过期笔数
      </div>
      <div className="stockin-risk-block-value">
        {formatCount(metrics.expiredCount)}
        <small>笔</small>
      </div>
      <div className="stockin-risk-block-sub">
        金额 {formatMoney(metrics.expiredAmountCents)}
      </div>
    </div>

    <div className="stockin-note-panel">
      <button
        type="button"
        className="stockin-link-btn"
        onClick={onAdjust}
        style={{ paddingLeft: 0 }}
      >
        调整阈值 <Icon name="chevron" size="sm" />
      </button>
    </div>
  </aside>
);

export default MetricBand;
