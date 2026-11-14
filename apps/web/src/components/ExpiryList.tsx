/**
 * 临期 / 过期预警清单：面板 + 预警行（左侧状态条 + 主信息 / 右侧金额）。
 *
 * 依据：design/stockin-ui-design-system.md §5.1 与原型 alert-row。
 * 分段 / 分页仍只回调 `onQueryChange`，由页面统一重调唯一数据源
 * `getDashboard({ page, pageSize, status })`；清单由服务端按到期日排定，
 * **前端不二次排序**；status 取 dashboard 返回值，未知值回落中性文案。
 * 状态用「颜色 + 文字 + 位置」三通道；<768 由 `useCardList` 降级为卡片。
 */
import React, { useEffect, useState } from 'react';
import { Button } from 'antd';
import type {
  DashboardMetrics,
  ExpiryAlertItem,
  ExpiryAlertQuery,
  ExpiryAlertStatus,
} from '@stockin/shared';
import EmptyState from '@/components/EmptyState';
import Icon from '@/components/Icon';
import Pager from '@/components/Pager';
import { TOUCH_TARGET_MIN_PX } from '@/constants/routes';
import {
  formatCount,
  formatDate,
  formatMoney,
  formatQuantity,
  formatRemainingDays,
  formatUnitPrice,
} from '@/utils/format';

export interface ExpiryListProps {
  readonly alerts: readonly ExpiryAlertItem[];
  /** 分段计数取全表聚合指标，不受清单分页影响。 */
  readonly metrics: DashboardMetrics;
  readonly alertsTotal: number;
  readonly alertsPage: number;
  readonly alertsPageSize: number;
  readonly alertsStatus: ExpiryAlertStatus | null;
  readonly loading: boolean;
  readonly useCardList: boolean;
  /** 分段 / 分页变化：交给页面重调 getDashboard，不引入第二数据源。 */
  readonly onQueryChange: (query: ExpiryAlertQuery) => void;
  /** 用 alerts[].id 跳现有编辑页。 */
  readonly onView: (id: number) => void;
  readonly onRefresh: () => void;
}

/** 空态结论句随分段变化：当前分段下确实没有记录，不再加条件状语。 */
const EMPTY_TEXT: Readonly<Record<string, string>> = {
  all: '没有临期或已过期记录',
  near: '没有临期记录',
  expired: '没有已过期记录',
};

/** 状态文案：未知值回落中性中文，不把服务端枚举原样显示。 */
const STATUS_TEXT: Readonly<Record<string, string>> = {
  near: '临期',
  expired: '已过期',
  none: '正常',
};
function statusText(status: string): string {
  return STATUS_TEXT[status] ?? '状态未知';
}
function statusClass(status: string): string {
  return status === 'near' || status === 'expired' ? ` is-${status}` : '';
}
function tagClass(status: string): string {
  return status === 'near' || status === 'expired'
    ? `stockin-tag--${status}`
    : 'stockin-tag--none';
}

interface AlertRowProps {
  readonly item: ExpiryAlertItem;
  readonly onView: (id: number) => void;
}

const AlertRow: React.FC<AlertRowProps> = ({ item, onView }) => (
  <div className={`stockin-alert-row${statusClass(item.status)}`}>
    <div className="stockin-alert-row-main">
      <span className="stockin-alert-row-name">{item.name}</span>
      {item.spec !== null && item.spec !== '' ? (
        <span className="stockin-alert-row-spec">{item.spec}</span>
      ) : null}
      <span className={`stockin-tag ${tagClass(item.status)}`}>
        <i aria-hidden="true" />
        {statusText(item.status)}
      </span>
    </div>
    <div className="stockin-alert-row-meta">
      <span>到期 {formatDate(item.expiryDate)}</span>
      <span>数量 {formatQuantity(item.quantity)}</span>
      <span>单价 {formatUnitPrice(item.unitPrice)}</span>
      {/* 出口用文字而非 icon-only：纯 chevron 在桌面上没有可读标签，
          与手机卡片的「查看」统一；热区仍由 .stockin-link-btn 保证 ≥44px。 */}
      <button
        type="button"
        className="stockin-link-btn stockin-alert-view"
        onClick={(): void => onView(item.id)}
        aria-label={`查看「${item.name}」详情`}
      >
        查看
        <Icon name="chevron" size="sm" />
      </button>
    </div>
    <div className="stockin-alert-row-right">
      <div className="stockin-alert-row-money">{formatMoney(item.amountCents)}</div>
      <div className="stockin-alert-row-days">
        {formatRemainingDays(item.remainingDays)}
      </div>
    </div>
  </div>
);

/** 手机档卡片：主信息 + 金额 + 到期 + 状态，操作入口不隐藏。 */
const AlertCard: React.FC<AlertRowProps> = ({ item, onView }) => (
  <div className="stockin-simple-card">
    <div className="stockin-simple-card-head">
      <span>
        {item.name}
        {item.spec !== null && item.spec !== '' ? ` · ${item.spec}` : ''}
      </span>
      <span className={`stockin-tag ${tagClass(item.status)}`}>
        <i aria-hidden="true" />
        {statusText(item.status)}
      </span>
    </div>
    <div className="stockin-simple-card-value">{formatMoney(item.amountCents)}</div>
    <div className="stockin-simple-card-meta">
      到期 {formatDate(item.expiryDate)} · {formatRemainingDays(item.remainingDays)}
    </div>
    {/* 与桌面 AlertRow 统一字段口径：补齐数量与单价。 */}
    <div className="stockin-simple-card-meta">
      数量 {formatQuantity(item.quantity)} · 单价 {formatUnitPrice(item.unitPrice)}
    </div>
    <Button
      type="link"
      onClick={(): void => onView(item.id)}
      aria-label={`查看「${item.name}」详情`}
      style={{ minHeight: TOUCH_TARGET_MIN_PX, paddingLeft: 0 }}
    >
      查看
    </Button>
  </div>
);

const ExpiryList: React.FC<ExpiryListProps> = ({
  alerts,
  metrics,
  alertsTotal,
  alertsPage,
  alertsPageSize,
  alertsStatus,
  loading,
  useCardList,
  onQueryChange,
  onView,
  onRefresh,
}) => {
  const allCount: number = metrics.nearExpiryCount + metrics.expiredCount;
  // 点击立即高亮，不等服务端回显；回显后再同步，避免请求往返期间「点了没反应」。
  const [segmentValue, setSegmentValue] = useState<string>(alertsStatus ?? 'all');
  useEffect((): void => {
    setSegmentValue(alertsStatus ?? 'all');
  }, [alertsStatus]);
  const segmentOptions: { label: string; value: string }[] = [
    { label: `全部 ${formatCount(allCount)}`, value: 'all' },
    { label: `临期 ${formatCount(metrics.nearExpiryCount)}`, value: 'near' },
    { label: `已过期 ${formatCount(metrics.expiredCount)}`, value: 'expired' },
  ];

  const handleSegmentChange = (value: string | number): void => {
    // 'all' 表示不传 status（服务端默认全部）；切分段一律回到第 1 页。
    const text: string = String(value);
    setSegmentValue(text);
    const nextStatus: ExpiryAlertStatus | undefined =
      text === 'near' || text === 'expired' ? text : undefined;
    onQueryChange({ page: 1, pageSize: alertsPageSize, status: nextStatus });
  };

  const handlePageChange = (nextPage: number): void => {
    // 每页条数固定，翻页只改页码；状态沿用当前分段。
    onQueryChange({
      page: nextPage,
      pageSize: alertsPageSize,
      status: alertsStatus ?? undefined,
    });
  };

  let body: React.ReactNode;
  const emptyText: string = EMPTY_TEXT[segmentValue] ?? EMPTY_TEXT.all;
  if (useCardList) {
    body = loading ? (
      <div className="stockin-card-list" style={{ padding: 12 }}>
        {[0, 1, 2].map((key: number) => (
          <div key={key} className="stockin-skeleton-card" />
        ))}
      </div>
    ) : alerts.length === 0 ? (
      <EmptyState icon="alert" title={emptyText} />
    ) : (
      <div className="stockin-card-list" style={{ padding: 12 }}>
        {alerts.map((item: ExpiryAlertItem) => (
          <AlertCard key={item.id} item={item} onView={onView} />
        ))}
      </div>
    );
  } else {
    body = loading ? (
      /* 桌面列表用行骨架（60px），与表格 / 时间线同一加载语言。 */
      <div className="stockin-skeleton-list" aria-busy="true">
        {[0, 1, 2, 3].map((key: number) => (
          <div key={key} className="stockin-skeleton-row" />
        ))}
      </div>
    ) : alerts.length === 0 ? (
      <EmptyState icon="alert" title={emptyText} />
    ) : (
      <div className="stockin-alert-list">
        {alerts.map((item: ExpiryAlertItem) => (
          <AlertRow key={item.id} item={item} onView={onView} />
        ))}
      </div>
    );
  }

  return (
    <section className="stockin-panel">
      <div className="stockin-panel-head">
        <h2 className="stockin-panel-title">
          <Icon name="alert" size="sm" />
          临期 / 过期预警
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div className="stockin-alert-segment" role="group" aria-label="预警状态">
            {segmentOptions.map((option) => {
              const active: boolean = segmentValue === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={active}
                  className={`stockin-segment-btn${active ? ' is-active' : ''}`}
                  onClick={(): void => handleSegmentChange(option.value)}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="stockin-icon-btn"
            onClick={onRefresh}
            title="刷新"
            aria-label="刷新"
            style={{ width: TOUCH_TARGET_MIN_PX, height: TOUCH_TARGET_MIN_PX }}
          >
            <Icon name="refresh" size="sm" />
          </button>
        </div>
      </div>

      {body}

      <div className="stockin-panel-foot">
        <Pager
          page={alertsPage}
          pageSize={alertsPageSize}
          total={alertsTotal}
          disabled={loading}
          onChange={handlePageChange}
        />
      </div>
    </section>
  );
};

export default ExpiryList;
