/**
 * 桌面 / 平板档记录表格：8 列高频信息 + 行展开查看完整字段。
 *
 * 依据：design/stockin-ui-design-system.md §5.2 与原型 view-records。
 * 主表 = 商品名称 / 进货日期 / 到期日期 / 规格 / 单价 / 数量 / 金额 / 状态 + 操作，
 * 桌面无横向滚动，去掉旧的 1500px 滚动；Excel 导出仍为 10 列全量。
 * 生产日期、保质期、备注、创建时间、字段来源收进展开行（排查信息不删除）。
 * 列头点击排序，字段白名单取 shared 的 RECORD_SORT_FIELDS；服务端排定顺序
 * 不做前端二次排序。创建时间按北京时间换算，不再裸截 UTC ISO 前 10 位。
 */
import React, { useMemo } from 'react';
import { Table, Tooltip } from 'antd';
import type { TableProps } from 'antd';
import type { RecordSortField, RecordView } from '@stockin/shared';
import EmptyState from '@/components/EmptyState';
import Icon from '@/components/Icon';
import Pager from '@/components/Pager';
import { TOUCH_TARGET_MIN_PX } from '@/constants/routes';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatQuantity,
  formatRemainingDays,
  formatShelfLife,
  formatUnitPrice,
} from '@/utils/format';

export interface RecordTableProps {
  readonly items: readonly RecordView[];
  readonly loading: boolean;
  readonly selectedIds: readonly number[];
  readonly onSelectedIdsChange: (ids: number[]) => void;
  readonly onEdit: (id: number) => void;
  readonly onDelete: (record: RecordView) => void;
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly onPageChange: (page: number) => void;
  readonly sortBy?: RecordSortField;
  readonly sortOrder?: 'asc' | 'desc';
  readonly onSortChange?: (field: RecordSortField) => void;
}

interface SortTitleProps {
  readonly label: string;
  readonly field: RecordSortField;
  readonly activeField: RecordSortField | undefined;
  readonly order: 'asc' | 'desc' | undefined;
  readonly onSortChange: ((field: RecordSortField) => void) | undefined;
}

/** 可点击列头：当前字段显示方向箭头，其余显示中立符号。 */
const SortTitle: React.FC<SortTitleProps> = ({
  label,
  field,
  activeField,
  order,
  onSortChange,
}) => {
  const active: boolean = activeField === field;
  const trigger = (): void => onSortChange?.(field);
  // 屏幕阅读器读不到 ↑ / ↓ 的语义，方向必须进 aria-label。
  const direction: string =
    active && order !== undefined ? `（当前${order === 'asc' ? '升序' : '降序'}）` : '';
  return (
    <span
      className="stockin-sortable-th"
      role="button"
      tabIndex={0}
      aria-label={`按${label}排序${direction}`}
      onClick={trigger}
      onKeyDown={(event: React.KeyboardEvent<HTMLSpanElement>): void => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          trigger();
        }
      }}
    >
      {label} {active ? (order === 'asc' ? '↑' : '↓') : '↕'}
    </span>
  );
};

/** 状态与来源一律中文映射，未知值回落中性文案，不把服务端枚举原样显示。 */
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
const SOURCE_TEXT: Readonly<Record<string, string>> = {
  EMPTY: '未填写',
  AUTO: '自动推算',
  MANUAL: '手填',
};
function sourceText(source: string): string {
  return SOURCE_TEXT[source] ?? '未标注';
}

/** 展开行：低频字段 + 6 个来源标记，数据全在现有 RecordView 里。 */
function renderExpanded(record: RecordView): React.ReactNode {
  const s = record.sources;
  const pairs: readonly (readonly [string, string])[] = [
    ['生产日期', formatDate(record.productionDate)],
    ['保质期', formatShelfLife(record.shelfLifeValue, record.shelfLifeUnit)],
    ['备注', record.remark === null || record.remark === '' ? '—' : record.remark],
    ['创建时间', formatDateTime(record.createdAt)],
    [
      '所属单据',
      record.order !== null && record.order !== undefined
        ? `${record.order.orderNo}（${record.order.supplier}）`
        : '未关联单据',
    ],
  ];
  const sourcePairs: readonly (readonly [string, string])[] = [
    ['生产日期', s.productionDateSrc],
    ['保质期', s.shelfLifeSrc],
    ['到期日期', s.expiryDateSrc],
    ['单价', s.unitPriceSrc],
    ['数量', s.quantitySrc],
    ['金额', s.amountSrc],
  ];
  return (
    <div className="stockin-expand-inner">
      {pairs.map(([label, value]) => (
        <div key={label}>
          {label}
          <b className={label === '创建时间' ? 'stockin-mono' : undefined}>{value}</b>
        </div>
      ))}
      <div style={{ gridColumn: '1 / -1' }}>
        字段来源
        <b style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 12px', marginTop: 4 }}>
          {sourcePairs.map(([label, value]) => (
            <span key={label} style={{ fontWeight: 400, fontSize: 12 }}>
              {label}：{sourceText(value)}
            </span>
          ))}
        </b>
      </div>
    </div>
  );
}

function buildColumns(
  onEdit: (id: number) => void,
  onDelete: (record: RecordView) => void,
  sortBy: RecordSortField | undefined,
  sortOrder: 'asc' | 'desc' | undefined,
  onSortChange: ((field: RecordSortField) => void) | undefined,
): TableProps<RecordView>['columns'] {
  const title = (label: string, field: RecordSortField): React.ReactNode => (
    <SortTitle
      label={label}
      field={field}
      activeField={sortBy}
      order={sortOrder}
      onSortChange={onSortChange}
    />
  );
  return [
    {
      title: title('商品名称', 'name'),
      dataIndex: 'name',
      key: 'name',
      width: 200,
      /* 关掉 antd 的原生 title（会与主题 Tooltip 同时出现两套提示），
         改用主题化 Tooltip 给出完整值；单元格 DOM 里始终是完整文本。 */
      ellipsis: { showTitle: false },
      render: (value: string, record: RecordView): React.ReactNode => (
        <div className="stockin-record-name-cell">
          <Tooltip title={value} placement="topLeft" trigger={['hover', 'focus']}>
            <span className="stockin-alert-row-name">{value}</span>
          </Tooltip>
          {record.order !== null && record.order !== undefined ? (
            <div className="stockin-cell-sub">
              {record.order.supplier}
              <span className="stockin-cell-sub__sep"> · </span>
              <span className="stockin-mono">{record.order.orderNo}</span>
            </div>
          ) : null}
        </div>
      ),
    },
    {
      title: title('进货日期', 'purchaseDate'),
      dataIndex: 'purchaseDate',
      key: 'purchaseDate',
      width: 92,
      render: (value: string): React.ReactNode => (
        <span className="stockin-mono">{formatDate(value)}</span>
      ),
    },
    {
      title: title('到期日期', 'expiryDate'),
      dataIndex: 'expiryDate',
      key: 'expiryDate',
      width: 92,
      render: (value: string): React.ReactNode => (
        <span className="stockin-mono">{formatDate(value)}</span>
      ),
    },
    {
      title: title('规格', 'spec'),
      dataIndex: 'spec',
      key: 'spec',
      width: 84,
      /* 规格列只有 84px，长规格必被截断；全值必须有一个出口。 */
      ellipsis: { showTitle: false },
      render: (value: string | null): React.ReactNode =>
        value === null || value === '' ? (
          '—'
        ) : (
          <Tooltip title={value} placement="topLeft" trigger={['hover', 'focus']}>
            <span>{value}</span>
          </Tooltip>
        ),
    },
    {
      title: '单价',
      dataIndex: 'unitPrice',
      key: 'unitPrice',
      width: 88,
      align: 'right',
      render: (value: number): React.ReactNode => (
        <span className="stockin-num">{formatUnitPrice(value)}</span>
      ),
    },
    {
      title: title('数量', 'quantity'),
      dataIndex: 'quantity',
      key: 'quantity',
      width: 88,
      align: 'right',
      render: (value: number): React.ReactNode => (
        <span className="stockin-num">{formatQuantity(value)}</span>
      ),
    },
    {
      title: title('金额', 'amountCents'),
      dataIndex: 'amountCents',
      key: 'amountCents',
      width: 96,
      align: 'right',
      render: (value: number): React.ReactNode => (
        <span className="stockin-num">{formatMoney(value)}</span>
      ),
    },
    {
      title: title('状态', 'expiryStatus'),
      key: 'expiryStatus',
      width: 136,
      render: (_: unknown, record: RecordView): React.ReactNode => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
          <span className={`stockin-tag ${statusTone(record.expiryStatus)}`}>
            <i aria-hidden="true" />
            {statusText(record.expiryStatus)}
          </span>
          {record.remainingDays !== null ? (
            <span className="stockin-hint">{formatRemainingDays(record.remainingDays)}</span>
          ) : null}
        </div>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 96,
      align: 'right',
      render: (_: unknown, record: RecordView): React.ReactNode => (
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
      ),
    },
  ];
}

const RecordTable: React.FC<RecordTableProps> = ({
  items,
  loading,
  selectedIds,
  onSelectedIdsChange,
  onEdit,
  onDelete,
  total,
  page,
  pageSize,
  onPageChange,
  sortBy,
  sortOrder,
  onSortChange,
}) => {
  const columns = useMemo(
    () => buildColumns(onEdit, onDelete, sortBy, sortOrder, onSortChange),
    [onEdit, onDelete, sortBy, sortOrder, onSortChange],
  );
  // 桌面档 8 列全显、无横向滚动；平板档允许横向滚动。
  const { isDesktop } = useBreakpoint();

  return (
    <div className="stockin-table-card">
      {/* 列表型区块统一用行骨架（~60px/行），不再叠加 antd Table 的居中 Spin。 */}
      {loading ? (
        <div className="stockin-skeleton-list" aria-busy="true">
          {[0, 1, 2, 3, 4].map((key: number) => (
            <div key={key} className="stockin-skeleton-row" />
          ))}
        </div>
      ) : (
      <div className="stockin-table-scroll">
        <Table<RecordView>
          rowKey="id"
          size="small"
          loading={false}
          columns={columns}
          dataSource={items as RecordView[]}
          scroll={isDesktop ? undefined : { x: 1080 }}
          rowSelection={{
            selectedRowKeys: selectedIds as React.Key[],
            onChange: (keys: React.Key[]): void => {
              onSelectedIdsChange(
                keys
                  .map((key) => (typeof key === 'number' ? key : Number.parseInt(String(key), 10)))
                  .filter((value) => Number.isInteger(value)),
              );
            },
          }}
          expandable={{
            expandedRowRender: renderExpanded,
            expandRowByClick: false,
          }}
          pagination={false}
          locale={{ emptyText: <EmptyState title="暂无进货记录" /> }}
        />
      </div>
      )}
      <div className="stockin-table-foot">
        <Pager page={page} pageSize={pageSize} total={total} onChange={onPageChange} />
      </div>
    </div>
  );
};

export default RecordTable;
