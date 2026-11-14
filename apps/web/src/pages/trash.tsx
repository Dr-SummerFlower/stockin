/**
 * 回收站页（只读列表 + 恢复 / 彻底删除）。
 *
 * 主视图为轻量行列表，手机档降级为卡片；两档均保留批量选择、批量恢复、
 * 批量彻底删除、分页、二次确认与加载 / 错误 / 空状态。软删语义收在标题旁的
 * 说明气泡，服务端请求参数与确认流程保持不变。文案采用中性书面语，
 * 不出现问句、劝导语或工程黑话。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { App as AntdApp, Button, Checkbox, Space, Tooltip } from 'antd';
import { DEFAULT_PAGE_SIZE, type RecordView } from '@stockin/shared';
import { useModel } from 'umi';
import {
  batchPurgeTrash,
  batchRestoreTrash,
  listTrash,
  purgeTrash,
  restoreTrash,
} from '@/services/api/trash';
import ConfirmDeleteModal from '@/components/ConfirmDeleteModal';
import EmptyState from '@/components/EmptyState';
import ErrorView from '@/components/ErrorView';
import Pager from '@/components/Pager';
import { errorMessage } from '@/services/request';
import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatRelativeDateTime,
} from '@/utils/format';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { TOUCH_TARGET_MIN_PX } from '@/constants/routes';

/** 四个动作（单条恢复/删除、批量恢复/删除）共用的确认态。 */
type ConfirmState =
  | {
      readonly kind: 'single';
      readonly action: 'restore' | 'purge';
      readonly record: RecordView;
    }
  | {
      readonly kind: 'batch';
      readonly action: 'batchRestore' | 'batchPurge';
    }
  | null;

function titleOfConfirm(state: ConfirmState): string {
  if (state === null) {
    return '';
  }
  if (state.kind === 'batch') {
    return state.action === 'batchPurge' ? '批量彻底删除' : '批量恢复';
  }
  return state.action === 'purge' ? '彻底删除' : '恢复';
}

/** 后果文案：动宾短句；「不可恢复」由 Alert 唯一承载，这里不再重复。 */
function describeConfirm(state: ConfirmState, count: number): string {
  if (state === null) {
    return '';
  }
  if (state.kind === 'batch') {
    return state.action === 'batchPurge'
      ? `彻底删除选中的 ${count} 条记录。`
      : `恢复选中的 ${count} 条记录至进货记录列表。`;
  }
  return state.action === 'purge'
    ? `彻底删除「${state.record.name}」。`
    : `恢复「${state.record.name}」至进货记录列表。`;
}

function confirmTextOf(state: ConfirmState): string {
  if (state === null) {
    return '确认';
  }
  const isPurge: boolean =
    state.action === 'purge' || state.action === 'batchPurge';
  if (state.kind === 'batch') {
    return isPurge ? '批量彻底删除' : '批量恢复';
  }
  return isPurge ? '彻底删除' : '恢复';
}

/** 规格空值用中性占位，不追加说明文字。 */
function specText(value: string | null): string {
  return value === null || value.trim() === '' ? '—' : value;
}

/**
 * 时间节点：可见文字是相对时间（今天 / 昨天 / MM-DD），完整北京时间走 Tooltip；
 * `dateTime` + `aria-label` 让读屏与触屏都能拿到绝对时间，不依赖 hover。
 */
const Timestamp: React.FC<{
  readonly iso: string | null;
  readonly children: React.ReactNode;
}> = ({ iso, children }) =>
  iso === null ? (
    <>{children}</>
  ) : (
    <Tooltip title={formatDateTime(iso)} placement="top">
      <time dateTime={iso} aria-label={formatDateTime(iso)}>
        {children}
      </time>
    </Tooltip>
  );

/** 桌面轻量行：左主信息 / 元信息，右恢复与彻底删除。 */
const TrashRow: React.FC<{
  readonly record: RecordView;
  readonly checked: boolean;
  readonly onToggle: (id: number, checked: boolean) => void;
  readonly onRestore: (record: RecordView) => void;
  readonly onPurge: (record: RecordView) => void;
}> = ({ record, checked, onToggle, onRestore, onPurge }) => (
  <div className="stockin-alert-row">
    <div className="stockin-alert-row-main">
      <Checkbox
        checked={checked}
        aria-label={`选择 ${record.name}`}
        onChange={(event): void => onToggle(record.id, event.target.checked)}
      />
      <span className="stockin-alert-row-name">{record.name}</span>
    </div>
    <div className="stockin-alert-row-meta">
      {/* 与手机卡片统一字段口径：补齐规格与到期，避免桌面反而更少。
          规格只在这里渲染一次并带标签，同一行不重复裸值。 */}
      <span className="stockin-num">{formatMoney(record.amountCents)}</span>
      <span>规格：{specText(record.spec)}</span>
      <span>到期：{formatDate(record.expiryDate)}</span>
      <span>
        删除：
        <Timestamp iso={record.deletedAt}>{formatRelativeDateTime(record.deletedAt)}</Timestamp>
      </span>
      <span>进货：{formatDate(record.purchaseDate)}</span>
    </div>
    <div className="stockin-alert-row-right">
      <Space size={4}>
        <Button
          aria-label={`恢复 ${record.name}`}
          onClick={(): void => onRestore(record)}
          style={{ minHeight: TOUCH_TARGET_MIN_PX }}
        >
          恢复
        </Button>
        <Button
          danger
          aria-label={`彻底删除 ${record.name}`}
          onClick={(): void => onPurge(record)}
          style={{ minHeight: TOUCH_TARGET_MIN_PX }}
        >
          彻底删除
        </Button>
      </Space>
    </div>
  </div>
);

/** 手机卡片：字段与行列表一致，金额保留，删除时间按北京时间显示。 */
const TrashCard: React.FC<{
  readonly record: RecordView;
  readonly checked: boolean;
  readonly onToggle: (id: number, checked: boolean) => void;
  readonly onRestore: (record: RecordView) => void;
  readonly onPurge: (record: RecordView) => void;
}> = ({ record, checked, onToggle, onRestore, onPurge }) => (
  <div className="stockin-simple-card">
    <div className="stockin-simple-card-head">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <Checkbox
          checked={checked}
          aria-label={`选择 ${record.name}`}
          onChange={(event): void => onToggle(record.id, event.target.checked)}
        />
        <span style={{ wordBreak: 'break-all' }}>{record.name}</span>
      </div>
    </div>
    <div className="stockin-simple-card-meta" style={{ marginTop: 4 }}>
      规格：{specText(record.spec)}
    </div>
    <div className="stockin-simple-card-value">
      {formatMoney(record.amountCents)}
    </div>
    <div className="stockin-card-detail">
      <div>进货：{formatDate(record.purchaseDate)}</div>
      <div>到期：{formatDate(record.expiryDate)}</div>
      <div style={{ gridColumn: '1 / -1' }}>
        删除：
        <Timestamp iso={record.deletedAt}>{formatRelativeDateTime(record.deletedAt)}</Timestamp>
      </div>
    </div>
    <Space wrap style={{ marginTop: 10 }}>
      <Button
        aria-label={`恢复 ${record.name}`}
        onClick={(): void => onRestore(record)}
        style={{ minHeight: TOUCH_TARGET_MIN_PX }}
      >
        恢复
      </Button>
      <Button
        danger
        aria-label={`彻底删除 ${record.name}`}
        onClick={(): void => onPurge(record)}
        style={{ minHeight: TOUCH_TARGET_MIN_PX }}
      >
        彻底删除
      </Button>
    </Space>
  </div>
);

/** 手机首屏骨架：避免加载中的空 items 被误显示成空态。 */
const SkeletonCards: React.FC = () => (
  <div className="stockin-card-list">
    {[0, 1, 2].map((key: number) => (
      <div key={key} className="stockin-skeleton-card" />
    ))}
  </div>
);

/** 桌面加载态：与表格 / 预警清单一致的行骨架，不再用居中 Spin。 */
const LoadingView: React.FC = () => (
  <div className="stockin-skeleton-list" aria-busy="true">
    {[0, 1, 2].map((key: number) => (
      <div key={key} className="stockin-skeleton-row" />
    ))}
  </div>
);

/** 空状态：图标 + 一句结论（与记录页、表格空态同一实现）。 */
const TrashPage: React.FC = () => {
  const { bumpRefresh } = useModel('ui');
  const { message } = AntdApp.useApp();
  const { useCardList } = useBreakpoint();
  const [items, setItems] = useState<readonly RecordView[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [page, setPageState] = useState<number>(1);
  // 每页条数固定，界面不提供下拉或输入框；design 原型只保留纯页码按钮。
  const pageSize: number = DEFAULT_PAGE_SIZE;
  const [selectedIds, setSelectedIds] = useState<readonly number[]>([]);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<unknown>(null);
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
    setConfirm({ kind: 'single', action: 'restore', record });
  }, []);
  const onPurge = useCallback((record: RecordView): void => {
    setConfirm({ kind: 'single', action: 'purge', record });
  }, []);
  const onToggle = useCallback((id: number, checked: boolean): void => {
    setSelectedIds((current: readonly number[]): readonly number[] =>
      checked
        ? current.includes(id)
          ? current
          : [...current, id]
        : current.filter((value: number): boolean => value !== id),
    );
  }, []);
  // 唯一的重试入口：ErrorView 共用。
  const retry = useCallback((): void => {
    setReloadToken((value: number): number => value + 1);
  }, []);

  const changePage = (next: number): void => {
    setPageState(next);
    setSelectedIds([]);
  };

  // 全选本页：补齐原表头复选框，桌面与手机共用。
  const allOnPageSelected: boolean =
    items.length > 0 &&
    items.every((record: RecordView): boolean => selectedIds.includes(record.id));
  const someOnPageSelected: boolean = items.some((record: RecordView): boolean =>
    selectedIds.includes(record.id),
  );
  const toggleAllOnPage = (checked: boolean): void => {
    setSelectedIds((current: readonly number[]): readonly number[] => {
      const pageIds: number[] = items.map((record: RecordView): number => record.id);
      if (!checked) {
        return current.filter((id: number): boolean => !pageIds.includes(id));
      }
      const next: Set<number> = new Set(current);
      pageIds.forEach((id: number): void => {
        next.add(id);
      });
      return [...next];
    });
  };

  const doAction = async (): Promise<void> => {
    if (confirm === null) {
      return;
    }
    const current: Exclude<ConfirmState, null> = confirm;
    setBusy(true);
    try {
      if (current.kind === 'batch') {
        if (current.action === 'batchRestore') {
          const result = await batchRestoreTrash(selectedIds);
          message.success(`已恢复 ${result.restored} 条记录`);
        } else {
          const result = await batchPurgeTrash(selectedIds);
          message.success(`已彻底删除 ${result.purged} 条记录`);
        }
        setSelectedIds([]);
      } else if (current.action === 'restore') {
        await restoreTrash(current.record.id);
        message.success('记录已恢复');
      } else {
        await purgeTrash(current.record.id);
        message.success('记录已彻底删除');
      }
      setConfirm(null);
      bumpRefresh();
      setReloadToken((value: number): number => value + 1);
    } catch (cause) {
      message.error(errorMessage(cause, '操作失败'));
    } finally {
      setBusy(false);
    }
  };

  const isPurge: boolean =
    confirm !== null &&
    (confirm.action === 'purge' || confirm.action === 'batchPurge');

  return (
    <div className="stockin-page">
      <div className="stockin-page-head">
        <div className="stockin-title-row">
          {/* 恢复 / 彻底删除的语义由按钮与确认弹窗直接承载，不再额外挂说明气泡。 */}
          <h1 className="stockin-page-title">回收站</h1>
        </div>
      </div>

      {error !== null ? (
        <ErrorView error={error} onRetry={retry} />
      ) : (
        <>
          {/* 批量条固定在列表上方：勾选后立即可见，不随列表高度落到分页之下。 */}
          {selectedIds.length > 0 ? (
            <div className="stockin-batch-bar is-floating">
              <span>
                已选中 <b>{selectedIds.length}</b> 条记录
              </span>
              <Space wrap>
                <Button
                  onClick={(): void =>
                    setConfirm({ kind: 'batch', action: 'batchRestore' })
                  }
                  style={{ minHeight: TOUCH_TARGET_MIN_PX }}
                >
                  批量恢复
                </Button>
                <Button
                  danger
                  onClick={(): void =>
                    setConfirm({ kind: 'batch', action: 'batchPurge' })
                  }
                  style={{ minHeight: TOUCH_TARGET_MIN_PX }}
                >
                  批量彻底删除
                </Button>
                <Button
                  type="link"
                  onClick={(): void => setSelectedIds([])}
                  style={{ minHeight: TOUCH_TARGET_MIN_PX }}
                >
                  取消选择
                </Button>
              </Space>
            </div>
          ) : null}

          <div className="stockin-panel">
            <div className="stockin-panel-head">
              {/* 分区标题与 h1「回收站」同义，已删；面板头用值型信息填充，不加说明文字。 */}
              <span className="stockin-hint">共 {total} 条</span>
              <Checkbox
                checked={allOnPageSelected}
                indeterminate={someOnPageSelected && !allOnPageSelected}
                disabled={items.length === 0}
                onChange={(event): void => toggleAllOnPage(event.target.checked)}
              >
                全选本页
              </Checkbox>
            </div>

            {useCardList ? (
              loading ? (
                <SkeletonCards />
              ) : items.length === 0 ? (
                <EmptyState icon="trash" title="回收站为空" />
              ) : (
                <div className="stockin-card-list" style={{ padding: 12 }}>
                  {items.map((record: RecordView) => (
                    <TrashCard
                      key={record.id}
                      record={record}
                      checked={selectedIds.includes(record.id)}
                      onToggle={onToggle}
                      onRestore={onRestore}
                      onPurge={onPurge}
                    />
                  ))}
                </div>
              )
            ) : loading ? (
              <LoadingView />
            ) : items.length === 0 ? (
              <EmptyState icon="trash" title="回收站为空" />
            ) : (
              <div>
                {items.map((record: RecordView) => (
                  <TrashRow
                    key={record.id}
                    record={record}
                    checked={selectedIds.includes(record.id)}
                    onToggle={onToggle}
                    onRestore={onRestore}
                    onPurge={onPurge}
                  />
                ))}
              </div>
            )}

            {/* 分页：纯页码按钮，与列表连成一体。 */}
            <div className="stockin-panel-foot">
              <Pager
                page={page}
                pageSize={pageSize}
                total={total}
                disabled={loading}
                onChange={changePage}
              />
            </div>
          </div>
        </>
      )}

      <ConfirmDeleteModal
        open={confirm !== null}
        title={titleOfConfirm(confirm)}
        description={describeConfirm(confirm, selectedIds.length)}
        confirmText={confirmTextOf(confirm)}
        danger={isPurge}
        busy={busy}
        onConfirm={(): void => {
          void doAction();
        }}
        onCancel={(): void => setConfirm(null)}
      />
    </div>
  );
};

export default TrashPage;
