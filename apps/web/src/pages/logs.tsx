/**
 * 操作日志页（**只读**）。
 *
 * `operation_logs` 为 append-only；本页只展示 `GET /api/operation-logs` 的结果，
 * 不提供任何新增 / 编辑 / 删除入口。request_id 可经 `ClipboardButton` 三级降级复制。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Button, Pagination, Select, Space, Table, Typography } from 'antd';
import type { TableProps } from 'antd';
import { useModel } from 'umi';
import {
  listOperationLogs,
  type OperationLogEntry,
} from '@/services/api/log';
import ClipboardButton from '@/components/ClipboardButton';
import ErrorView from '@/components/ErrorView';
import {
  ACTION_LABELS,
  TARGET_TYPE_LABELS,
  TOUCH_TARGET_MIN_PX,
} from '@/constants/routes';
import { formatDateTime } from '@/utils/format';

const ACTION_OPTIONS: { value: string; label: string }[] = Object.entries(
  ACTION_LABELS,
).map(([value, label]) => ({ value, label }));

const columns: TableProps<OperationLogEntry>['columns'] = [
  {
    title: '时间',
    dataIndex: 'occurred_at',
    key: 'occurred_at',
    width: 170,
    render: (value: string): React.ReactNode => formatDateTime(value),
  },
  {
    title: '操作',
    dataIndex: 'action',
    key: 'action',
    width: 140,
    render: (value: string): React.ReactNode => ACTION_LABELS[value] ?? value,
  },
  {
    title: '对象类型',
    dataIndex: 'target_type',
    key: 'target_type',
    width: 120,
    render: (value: string): React.ReactNode =>
      TARGET_TYPE_LABELS[value] ?? value,
  },
  {
    title: '对象 ID',
    dataIndex: 'target_id',
    key: 'target_id',
    width: 100,
    render: (value: number | null): React.ReactNode => value ?? '—',
  },
  {
    title: '操作者',
    dataIndex: 'actor',
    key: 'actor',
    width: 120,
  },
  {
    title: 'requestId',
    dataIndex: 'request_id',
    key: 'request_id',
    width: 260,
    render: (value: string): React.ReactNode => (
      <span>
        <Typography.Text className="stockin-request-id">{value}</Typography.Text>
        <ClipboardButton value={value} label="复制" />
      </span>
    ),
  },
  {
    title: '详情',
    dataIndex: 'detail',
    key: 'detail',
    ellipsis: true,
    render: (value: string | null): React.ReactNode =>
      value === null || value === '' ? '—' : value,
  },
];

const LogsPage: React.FC = () => {
  const { refreshKey } = useModel('ui');
  const [items, setItems] = useState<readonly OperationLogEntry[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [offset, setOffset] = useState<number>(0);
  const [limit, setLimit] = useState<number>(20);
  const [actionFilter, setActionFilter] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadToken, setReloadToken] = useState<number>(0);

  useEffect((): (() => void) => {
    let active = true;
    setLoading(true);
    setError(null);
    void listOperationLogs({ action: actionFilter, limit, offset })
      .then((result): void => {
        if (active) {
          setItems(result.items);
          setTotal(result.total);
        }
      })
      .catch((cause: unknown): void => {
        if (active) {
          setError(cause);
        }
      })
      .finally((): void => {
        if (active) {
          setLoading(false);
        }
      });
    return (): void => {
      active = false;
    };
  }, [actionFilter, limit, offset, refreshKey, reloadToken]);

  const retry = useCallback((): void => {
    setReloadToken((value: number): number => value + 1);
  }, []);

  return (
    <div className="stockin-page">
      <div className="stockin-page-head">
        <div>
          <h1 className="stockin-page-title">操作日志</h1>
          <div className="stockin-page-subtitle">
            只读 · append-only · 时间戳为服务器 UTC ISO 8601
          </div>
        </div>
        <Space wrap>
          <Select
            value={actionFilter}
            placeholder="按操作类型筛选"
            aria-label="按操作类型筛选"
            options={ACTION_OPTIONS}
            allowClear
            style={{ minWidth: 180, minHeight: TOUCH_TARGET_MIN_PX }}
            onChange={(value: string | undefined): void => {
              setActionFilter(value);
              setOffset(0);
            }}
          />
          <Button onClick={retry} style={{ minHeight: TOUCH_TARGET_MIN_PX }}>
            刷新
          </Button>
        </Space>
      </div>

      {error !== null ? (
        <ErrorView error={error} onRetry={retry} />
      ) : (
        <div style={{ background: '#fff', borderRadius: 8 }}>
          <Table<OperationLogEntry>
            rowKey="id"
            size="small"
            loading={loading}
            columns={columns}
            dataSource={items as OperationLogEntry[]}
            pagination={false}
            scroll={{ x: 1100 }}
            locale={{ emptyText: '暂无操作日志' }}
          />
          <div style={{ padding: 12, overflowX: 'auto' }}>
            <Pagination
              current={Math.floor(offset / limit) + 1}
              pageSize={limit}
              total={total}
              showSizeChanger
              onChange={(nextPage: number, nextSize: number): void => {
                setOffset((nextPage - 1) * nextSize);
                setLimit(nextSize);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default LogsPage;
