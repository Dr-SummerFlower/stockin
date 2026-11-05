/**
 * 手机档（<768）记录卡片列表：表格降级为卡片 + 复选。
 *
 * 依据：主理人 T04 口径 ⑦ —— <768 表格降级卡片列表 + 底部 BatchActionBar；
 * 触控目标 ≥44×44px；颜色 + 文字双通道可达性。
 */
import React from 'react';
import { Button, Checkbox, Empty, Space, Tag } from 'antd';
import type { RecordView } from '@stockin/shared';
import { EXPIRY_STATUS_META, TOUCH_TARGET_MIN_PX } from '@/constants/routes';
import {
  formatDate,
  formatMoney,
  formatQuantity,
  formatShelfLife,
  formatUnitPrice,
} from '@/utils/format';

export interface RecordCardListProps {
  readonly items: readonly RecordView[];
  readonly selectedIds: readonly number[];
  readonly onToggle: (id: number, checked: boolean) => void;
  readonly onEdit: (id: number) => void;
  readonly onDelete: (record: RecordView) => void;
}

interface CellProps {
  readonly label: string;
  readonly value: React.ReactNode;
}

const Cell: React.FC<CellProps> = ({ label, value }) => (
  <div>
    <span className="stockin-record-cell-label">{label}</span>
    {value}
  </div>
);

const RecordCardList: React.FC<RecordCardListProps> = ({
  items,
  selectedIds,
  onToggle,
  onEdit,
  onDelete,
}) => {
  if (items.length === 0) {
    return <Empty description="暂无进货记录" />;
  }
  return (
    <div className="stockin-card-list">
      {items.map((record) => {
        const checked: boolean = selectedIds.includes(record.id);
        const meta = EXPIRY_STATUS_META[record.expiryStatus];
        return (
          <div key={record.id} className="stockin-record-card">
            <div className="stockin-record-card-head">
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <Checkbox
                  checked={checked}
                  aria-label={`选择 ${record.name}`}
                  onChange={(event): void => onToggle(record.id, event.target.checked)}
                  style={{ marginTop: 4 }}
                />
                <span className="stockin-record-card-title">{record.name}</span>
              </div>
              <span className={`stockin-status stockin-status-${record.expiryStatus}`}>
                {meta.text}
              </span>
            </div>
            <div className="stockin-record-grid">
              <Cell label="进货" value={formatDate(record.purchaseDate)} />
              <Cell label="生产" value={formatDate(record.productionDate)} />
              <Cell label="保质期" value={formatShelfLife(record.shelfLifeValue, record.shelfLifeUnit)} />
              <Cell label="到期" value={formatDate(record.expiryDate)} />
              <Cell label="规格" value={record.spec === null || record.spec === '' ? '—' : record.spec} />
              <Cell label="单价" value={formatUnitPrice(record.unitPrice)} />
              <Cell label="数量" value={formatQuantity(record.quantity)} />
              <Cell label="金额" value={formatMoney(record.amountCents)} />
            </div>
            {record.remark !== null && record.remark !== '' ? (
              <div style={{ marginTop: 8, fontSize: 13, color: 'rgba(0,0,0,0.45)' }}>
                备注：{record.remark}
              </div>
            ) : null}
            <Space style={{ marginTop: 10 }}>
              <Button
                onClick={(): void => onEdit(record.id)}
                style={{ minHeight: TOUCH_TARGET_MIN_PX }}
              >
                编辑
              </Button>
              <Button
                danger
                onClick={(): void => onDelete(record)}
                style={{ minHeight: TOUCH_TARGET_MIN_PX }}
              >
                删除
              </Button>
            </Space>
          </div>
        );
      })}
    </div>
  );
};

export default RecordCardList;
