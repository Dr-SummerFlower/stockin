/**
 * 桌面 / 平板档记录表格。
 *
 * 临期 / 过期标记取 `RecordView.expiryStatus`（**服务端派生结果**），
 * 不消费 `computeDateGroup` 的派生展示字段（主理人 T04 口径 ⑤）。
 * 颜色 + 文字双通道可达性；单条删除的二次确认由页面持有 `ConfirmDeleteModal`。
 */
import React, { useMemo } from 'react';
import { Button, Space, Table } from 'antd';
import type { TableProps } from 'antd';
import type { RecordView } from '@stockin/shared';
import { EXPIRY_STATUS_META, TOUCH_TARGET_MIN_PX } from '@/constants/routes';
import {
  formatDate,
  formatMoney,
  formatQuantity,
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
  readonly onPageChange: (page: number, pageSize: number) => void;
}

/** 列定义按回调构造，避免模块级可变桥接造成多实例串扰。 */
function buildColumns(
  onEdit: (id: number) => void,
  onDelete: (record: RecordView) => void,
): TableProps<RecordView>['columns'] {
  return [
    { title: '商品名称', dataIndex: 'name', key: 'name', width: 160, ellipsis: true },
    {
      title: '进货日期',
      dataIndex: 'purchaseDate',
      key: 'purchaseDate',
      width: 120,
      render: (value: string): React.ReactNode => formatDate(value),
    },
    {
      title: '生产日期',
      dataIndex: 'productionDate',
      key: 'productionDate',
      width: 120,
      render: (value: string | null): React.ReactNode => formatDate(value),
    },
    {
      title: '保质期',
      key: 'shelfLife',
      width: 100,
      render: (_: unknown, record: RecordView): React.ReactNode =>
        formatShelfLife(record.shelfLifeValue, record.shelfLifeUnit),
    },
    {
      title: '到期日期',
      dataIndex: 'expiryDate',
      key: 'expiryDate',
      width: 120,
      render: (value: string | null): React.ReactNode => formatDate(value),
    },
    {
      title: '规格',
      dataIndex: 'spec',
      key: 'spec',
      width: 120,
      ellipsis: true,
      render: (value: string | null): React.ReactNode =>
        value === null || value === '' ? '—' : value,
    },
    {
      title: '单价',
      dataIndex: 'unitPrice',
      key: 'unitPrice',
      width: 110,
      align: 'right',
      render: (value: number): React.ReactNode => formatUnitPrice(value),
    },
    {
      title: '数量',
      dataIndex: 'quantity',
      key: 'quantity',
      width: 110,
      align: 'right',
      render: (value: number): React.ReactNode => formatQuantity(value),
    },
    {
      title: '金额',
      dataIndex: 'amountCents',
      key: 'amountCents',
      width: 130,
      align: 'right',
      render: (value: number): React.ReactNode => formatMoney(value),
    },
    {
      title: '状态',
      dataIndex: 'expiryStatus',
      key: 'expiryStatus',
      width: 100,
      render: (status: RecordView['expiryStatus']): React.ReactNode => (
        <span className={`stockin-status stockin-status-${status}`}>
          {EXPIRY_STATUS_META[status].text}
        </span>
      ),
    },
    {
      title: '备注',
      dataIndex: 'remark',
      key: 'remark',
      width: 160,
      ellipsis: true,
      render: (value: string | null): React.ReactNode =>
        value === null || value === '' ? '—' : value,
    },
    {
      title: '操作',
      key: 'actions',
      fixed: 'right',
      width: 160,
      render: (_: unknown, record: RecordView): React.ReactNode => (
        <Space size={4}>
          <Button
            type="link"
            size="small"
            onClick={(): void => onEdit(record.id)}
            style={{ minHeight: TOUCH_TARGET_MIN_PX }}
          >
            编辑
          </Button>
          <Button
            type="link"
            size="small"
            danger
            onClick={(): void => onDelete(record)}
            style={{ minHeight: TOUCH_TARGET_MIN_PX }}
          >
            删除
          </Button>
        </Space>
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
}) => {
  const columns = useMemo(
    () => buildColumns(onEdit, onDelete),
    [onEdit, onDelete],
  );

  return (
    <Table<RecordView>
      rowKey="id"
      size="small"
      loading={loading}
      columns={columns}
      dataSource={items as RecordView[]}
      scroll={{ x: 1500 }}
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
      pagination={{
        current: page,
        pageSize,
        total,
        showSizeChanger: true,
        showTotal: (value: number): string => `共 ${value} 条`,
        onChange: onPageChange,
      }}
      locale={{ emptyText: '暂无进货记录' }}
    />
  );
};

export default RecordTable;
