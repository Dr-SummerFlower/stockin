/**
 * 手机档（<768）记录卡片列表。
 *
 * 依据：design/stockin-ui-design-system.md §7 —— 表格降级为卡片时，
 * 字段按「商品名 / 日期 / 金额 / 状态」优先级重排，其余收入展开区，
 * 不隐藏任何业务功能（编辑、删除、选择、分页全部保留）。
 * 状态用「颜色 + 文字」双通道，未知值回落中性中文。
 */
import React, { useState } from 'react';
import { Button, Checkbox } from 'antd';
import type { RecordView } from '@stockin/shared';
import EmptyState from '@/components/EmptyState';
import Icon from '@/components/Icon';
import Pager from '@/components/Pager';
import { TOUCH_TARGET_MIN_PX } from '@/constants/routes';
import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatQuantity,
  formatRemainingDays,
  formatShelfLife,
  formatUnitPrice,
} from '@/utils/format';

export interface RecordCardListProps {
  readonly items: readonly RecordView[];
  readonly loading?: boolean;
  readonly selectedIds: readonly number[];
  readonly onToggle: (id: number, checked: boolean) => void;
  readonly onEdit: (id: number) => void;
  readonly onDelete: (record: RecordView) => void;
  readonly total?: number;
  readonly page?: number;
  readonly pageSize?: number;
  readonly onPageChange?: (page: number) => void;
}

const STATUS_TEXT: Readonly<Record<string, string>> = {
  near: '临期',
  expired: '已过期',
  none: '正常',
};
function statusText(status: string): string {
  return STATUS_TEXT[status] ?? '状态未知';
}
function statusTone(status: string): string {
  return status === 'near' || status === 'expired' || status === 'none'
    ? `stockin-tag--${status}`
    : 'stockin-tag--none';
}

/** 字段来源中文映射与桌面展开行保持同一口径，不显示服务端枚举原值。 */
const SOURCE_TEXT: Readonly<Record<string, string>> = {
  EMPTY: '未填写',
  AUTO: '自动推算',
  MANUAL: '手填',
};
function sourceText(source: string): string {
  return SOURCE_TEXT[source] ?? '未标注';
}
const SOURCE_LABELS: readonly (readonly [string, string])[] = [
  ['生产日期', 'productionDateSrc'],
  ['保质期', 'shelfLifeSrc'],
  ['到期日期', 'expiryDateSrc'],
  ['单价', 'unitPriceSrc'],
  ['数量', 'quantitySrc'],
  ['金额', 'amountSrc'],
];

interface CardProps {
  readonly record: RecordView;
  readonly checked: boolean;
  readonly onToggle: (id: number, checked: boolean) => void;
  readonly onEdit: (id: number) => void;
  readonly onDelete: (record: RecordView) => void;
}

const RecordCard: React.FC<CardProps> = ({
  record,
  checked,
  onToggle,
  onEdit,
  onDelete,
}) => {
  const [expanded, setExpanded] = useState<boolean>(false);
  return (
    <div className="stockin-record-card">
      <div className="stockin-record-card-head">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0 }}>
          <Checkbox
            checked={checked}
            aria-label={`选择 ${record.name}`}
            onChange={(event): void => onToggle(record.id, event.target.checked)}
            style={{ marginTop: 4 }}
          />
          <span className="stockin-record-card-title">
            {record.name}
            {record.spec !== null && record.spec !== '' ? (
              <span style={{ fontWeight: 400, color: 'var(--stockin-color-muted)', marginLeft: 6 }}>
                {record.spec}
              </span>
            ) : null}
          </span>
        </div>
        <span className={`stockin-tag ${statusTone(record.expiryStatus)}`}>
          <i aria-hidden="true" />
          {statusText(record.expiryStatus)}
        </span>
      </div>

      {record.order !== null && record.order !== undefined ? (
        <div className="stockin-record-card-sub">
          {record.order.supplier} · <span className="stockin-mono">{record.order.orderNo}</span>
        </div>
      ) : null}
      <div className="stockin-simple-card-value">{formatMoney(record.amountCents)}</div>
      <div className="stockin-simple-card-meta">
        到期 {formatDate(record.expiryDate)}
        {record.remainingDays !== null ? ` · ${formatRemainingDays(record.remainingDays)}` : ''}
      </div>

      {expanded ? (
        <div className="stockin-card-detail">
          <div><span className="stockin-expand-label">进货日期</span>{formatDate(record.purchaseDate)}</div>
          <div><span className="stockin-expand-label">生产日期</span>{formatDate(record.productionDate)}</div>
          <div><span className="stockin-expand-label">保质期</span>{formatShelfLife(record.shelfLifeValue, record.shelfLifeUnit)}</div>
          <div><span className="stockin-expand-label">规格</span>{record.spec ?? '—'}</div>
          <div><span className="stockin-expand-label">数量</span>{formatQuantity(record.quantity)}</div>
          <div><span className="stockin-expand-label">单价</span>{formatUnitPrice(record.unitPrice)}</div>
          <div style={{ gridColumn: '1 / -1' }}>
            <span className="stockin-expand-label">备注</span>{record.remark ?? '—'}
          </div>
          {/* 与桌面展开行统一：补齐创建时间与 6 个字段来源标记。 */}
          <div style={{ gridColumn: '1 / -1' }}>
            <span className="stockin-expand-label">创建时间</span>{formatDateTime(record.createdAt)}
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <span className="stockin-expand-label">字段来源</span>
            <span style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px', fontWeight: 400, fontSize: 12 }}>
              {SOURCE_LABELS.map(([label, key]) => (
                <span key={key}>{label}：{sourceText(record.sources[key as keyof typeof record.sources])}</span>
              ))}
            </span>
          </div>
        </div>
      ) : null}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
        <Button
          type="link"
          onClick={(): void => setExpanded((value: boolean): boolean => !value)}
          aria-expanded={expanded}
          style={{ minHeight: TOUCH_TARGET_MIN_PX, padding: 0 }}
        >
          {expanded ? '收起' : '查看完整字段'}
        </Button>
        <div className="stockin-row-actions">
          <button
            type="button"
            className="stockin-icon-btn"
            onClick={(): void => onEdit(record.id)}
            title="编辑"
            aria-label={`编辑 ${record.name}`}
            style={{ width: TOUCH_TARGET_MIN_PX, height: TOUCH_TARGET_MIN_PX }}
          >
            <Icon name="edit" size="sm" />
          </button>
          <button
            type="button"
            className="stockin-icon-btn"
            onClick={(): void => onDelete(record)}
            title="删除"
            aria-label={`删除 ${record.name}`}
            style={{ width: TOUCH_TARGET_MIN_PX, height: TOUCH_TARGET_MIN_PX }}
          >
            <Icon name="trash" size="sm" />
          </button>
        </div>
      </div>
    </div>
  );
};

const RecordCardList: React.FC<RecordCardListProps> = ({
  items,
  loading = false,
  selectedIds,
  onToggle,
  onEdit,
  onDelete,
  total = 0,
  page = 1,
  pageSize = 20,
  onPageChange,
}) => {
  if (loading) {
    return (
      <div className="stockin-card-list" aria-busy="true">
        {[0, 1, 2].map((index: number) => (
          <div key={index} className="stockin-skeleton-card" />
        ))}
      </div>
    );
  }
  return (
    <>
      {items.length === 0 ? (
        <EmptyState title="暂无进货记录" />
      ) : (
        <div className="stockin-card-list">
          {items.map((record) => (
            <RecordCard
              key={record.id}
              record={record}
              checked={selectedIds.includes(record.id)}
              onToggle={onToggle}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
      {onPageChange !== undefined ? (
        <div className="stockin-card-pager">
          <Pager page={page} pageSize={pageSize} total={total} onChange={onPageChange} />
        </div>
      ) : null}
    </>
  );
};

export default RecordCardList;
