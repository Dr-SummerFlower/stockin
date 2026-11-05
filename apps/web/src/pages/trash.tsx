/**
 * 回收站页（只读列表 + 恢复 / 彻底删除）。
 *
 * 依据：主理人 T04 口径 ⑩ —— 恢复 / 彻底删除都要二次确认。
 * 软删记录由 `GET /api/trash` 返回；恢复与物理删除分别走
 * `POST /api/trash/:id/restore` 与 `DELETE /api/trash/:id`。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Button, Space, Table, message } from 'antd';
import type { TableProps } from 'antd';
import { DEFAULT_PAGE_SIZE, type RecordView } from '@stockin/shared';
import { useModel } from 'umi';
import { listTrash, purgeTrash, restoreTrash } from '@/services/api/trash';
import ConfirmDeleteModal from '@/components/ConfirmDeleteModal';
import ErrorView from '@/components/ErrorView';
import { errorMessage } from '@/services/request';
import { formatDate, formatDateTime, formatMoney } from '@/utils/format';
import { TOUCH_TARGET_MIN_PX } from '@/constants/routes';

type TrashAction = 'restore' | 'purge';

function buildColumns(
  onRestore: (record: RecordView) => void,
  onPurge: (record: RecordView) => void,
): TableProps<RecordView>['columns'] {
  return [
    { title: '商品名称', dataIndex: 'name', key: 'name', width: 180, ellipsis: true },
    {
      title: '进货日期',
      dataIndex: 'purchaseDate',
      key: 'purchaseDate',
      width: 130,
      render: (value: string): React.ReactNode => formatDate(value),
    },
    {
      title: '到期日期',
      dataIndex: 'expiryDate',
      key: 'expiryDate',
      width: 130,
      render: (value: string | null): React.ReactNode => formatDate(value),
    },
    {
      title: '金额',
      dataIndex: 'amountCents',
      key: 'amountCents',
      width: 140,
      align: 'right',
      render: (value: number): React.ReactNode => formatMoney(value),
    },
    {
      title: '删除时间',
      dataIndex: 'deletedAt',
      key: 'deletedAt',
      width: 180,
      render: (value: string | null): React.ReactNode => formatDateTime(value),
    },
    {
      title: '操作',
      key: 'actions',
      fixed: 'right',
      width: 190,
      render: (_: unknown, record: RecordView): React.ReactNode => (
        <Space size={4}>
          <Button
            onClick={(): void => onRestore(record)}
            style={{ minHeight: TOUCH_TARGET_MIN_PX }}
          >
            恢复
          </Button>
          <Button
            danger
            onClick={(): void => onPurge(record)}
            style={{ minHeight: TOUCH_TARGET_MIN_PX }}
          >
            彻底删除
          </Button>
        </Space>
      ),
    },
  ];
}

const TrashPage: React.FC = () => {
  const { bumpRefresh } = useModel('ui');
  const [items, setItems] = useState<readonly RecordView[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [page, setPageState] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<unknown>(null);
  const [target, setTarget] = useState<RecordView | null>(null);
  const [action, setAction] = useState<TrashAction>('restore');
  const [busy, setBusy] = useState<boolean>(false);
  const [reloadToken, setReloadToken] = useState<number>(0);

  useEffect((): (() => void) => {
    let active = true;
    setLoading(true);
    setError(null);
    void listTrash(page, pageSize)
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
  }, [page, pageSize, reloadToken]);

  const onRestore = useCallback((record: RecordView): void => {
    setTarget(record);
    setAction('restore');
  }, []);
  const onPurge = useCallback((record: RecordView): void => {
    setTarget(record);
    setAction('purge');
  }, []);
  const retry = useCallback((): void => {
    setReloadToken((value: number): number => value + 1);
  }, []);

  const columns = React.useMemo(
    () => buildColumns(onRestore, onPurge),
    [onRestore, onPurge],
  );

  const doAction = async (): Promise<void> => {
    if (target === null) {
      return;
    }
    const id: number = target.id;
    const currentAction: TrashAction = action;
    setBusy(true);
    try {
      if (currentAction === 'restore') {
        await restoreTrash(id);
        message.success('记录已恢复');
      } else {
        await purgeTrash(id);
        message.success('记录已彻底删除');
      }
      setTarget(null);
      bumpRefresh();
      setReloadToken((value: number): number => value + 1);
    } catch (cause) {
      message.error(errorMessage(cause, '操作失败'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stockin-page">
      <div className="stockin-page-head">
        <div>
          <h1 className="stockin-page-title">回收站</h1>
          <div className="stockin-page-subtitle">
            软删记录可恢复；彻底删除不可撤销 · 共 {total} 条
          </div>
        </div>
      </div>

      {error !== null ? (
        <ErrorView error={error} onRetry={retry} />
      ) : (
        <div style={{ background: '#fff', borderRadius: 8 }}>
          <Table<RecordView>
            rowKey="id"
            size="small"
            loading={loading}
            columns={columns}
            dataSource={items as RecordView[]}
            scroll={{ x: 960 }}
            pagination={{
              current: page,
              pageSize,
              total,
              showSizeChanger: true,
              showTotal: (value: number): string => `共 ${value} 条`,
              onChange: (nextPage: number, nextSize: number): void => {
                setPageState(nextPage);
                setPageSize(nextSize);
              },
            }}
            locale={{ emptyText: '回收站为空' }}
          />
        </div>
      )}

      <ConfirmDeleteModal
        open={target !== null}
        title={action === 'restore' ? '恢复该记录？' : '彻底删除该记录？'}
        description={
          target === null
            ? ''
            : action === 'restore'
              ? `「${target.name}」将恢复到进货记录列表。`
              : `「${target.name}」将被物理删除，无法再恢复。`
        }
        confirmText={action === 'restore' ? '确认恢复' : '彻底删除'}
        danger={action === 'purge'}
        busy={busy}
        onConfirm={(): void => {
          void doAction();
        }}
        onCancel={(): void => setTarget(null)}
      />
    </div>
  );
};

export default TrashPage;
