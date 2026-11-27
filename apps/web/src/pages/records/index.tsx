/**
 * 进货记录列表页（#1–#6、#11）。
 *
 * - 页头为「模板 / 导入 / 导出 / 新增记录」；导入与导出共用一个弹窗容器；
 * - 筛选与导出共用 `recordFilters` model 的同一份 `RecordFilter`，列头排序也写回该 model；
 * - `<768` 由 `useBreakpoint()` 切换为 4 字段卡片（自带骨架屏与总数分页）；
 * - 单条 / 批量删除复用一个 `ConfirmDeleteModal` 实例，按动作切文案并传 `danger={false}`
 *   （软删可恢复，不再与「不可撤销」自相矛盾）；
 * - 导入 / 导出通过全局 `heavyBusy` 互斥，避免服务端信号量冲突产生 503。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { App as AntdApp, Button, Drawer } from 'antd';
import { useModel, useNavigate } from 'umi';
import {
  DEFAULT_PAGE_SIZE,
  type RecordFilter,
  type RecordSortField,
  type RecordView,
} from '@stockin/shared';
import {
  batchDeleteRecords,
  deleteRecord,
  listRecords,
} from '@/services/api/record';
import { errorMessage } from '@/services/request';
import { createIdempotencyKey } from '@/utils/idempotency-key';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import FilterBar from '@/components/FilterBar';
import RecordTable from '@/components/RecordTable';
import RecordCardList from '@/components/RecordCardList';
import BatchActionBar from '@/components/BatchActionBar';
import ConfirmDeleteModal from '@/components/ConfirmDeleteModal';
import ErrorView from '@/components/ErrorView';
import Icon from '@/components/Icon';
import WorkbenchModal from '@/components/WorkbenchModal';
import { downloadTemplateFile } from '@/services/api/excel';
import { ROUTES, TOUCH_TARGET_MIN_PX } from '@/constants/routes';
import { describeRecordFilter } from '@/utils/format';

type DeleteState = { kind: 'one'; record: RecordView } | { kind: 'batch' } | null;

const RecordsPage: React.FC = () => {
  const navigate = useNavigate();
  const { message: holderMessage } = AntdApp.useApp();
  const { useCardList } = useBreakpoint();
  const { filter, patchFilter, resetFilter, setPage, exportFilter } =
    useModel('recordFilters');
  const { refreshKey, bumpRefresh, openWorkbench, heavyBusy } = useModel('ui');

  const [items, setItems] = useState<readonly RecordView[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<unknown>(null);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [deleteState, setDeleteState] = useState<DeleteState>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [reloadToken, setReloadToken] = useState<number>(0);
  const [filterSheetOpen, setFilterSheetOpen] = useState<boolean>(false);

  useEffect((): (() => void) => {
    let active = true;
    setLoading(true);
    setError(null);
    void listRecords(filter)
      .then((page): void => {
        if (active) {
          setItems(page.items);
          setTotal(page.total);
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
  }, [filter, refreshKey, reloadToken]);

  const onEdit = useCallback(
    (id: number): void => navigate(ROUTES.recordEdit(id)),
    [navigate],
  );
  const onDelete = useCallback((record: RecordView): void => {
    setDeleteState({ kind: 'one', record });
  }, []);
  const onPageChange = useCallback((page: number): void => setPage(page), [setPage]);
  const onSelectedIdsChange = useCallback((ids: number[]): void => {
    setSelectedIds(ids);
  }, []);
  const onToggle = useCallback((id: number, checked: boolean): void => {
    setSelectedIds((prev: number[]): number[] =>
      checked
        ? Array.from(new Set<number>([...prev, id]))
        : prev.filter((value: number): boolean => value !== id),
    );
  }, []);
  const onFilterChange = useCallback(
    (patch: Partial<RecordFilter>): void => patchFilter(patch),
    [patchFilter],
  );
  const onFilterReset = useCallback((): void => resetFilter(), [resetFilter]);
  const onImported = useCallback((): void => bumpRefresh(), [bumpRefresh]);
  const retry = useCallback((): void => setReloadToken((v: number): number => v + 1), []);
  const clearSelection = useCallback((): void => setSelectedIds([]), []);

  /** 列头排序：同字段切方向，新字段默认降序；写回 model 会自动把 page 复位为 1。 */
  const onSortChange = useCallback(
    (field: RecordSortField): void => {
      const nextOrder: 'asc' | 'desc' =
        filter.sortBy === field && filter.sortOrder === 'desc' ? 'asc' : 'desc';
      patchFilter({ sortBy: field, sortOrder: nextOrder });
    },
    [filter.sortBy, filter.sortOrder, patchFilter],
  );

  const doDeleteOne = async (record: RecordView): Promise<void> => {
    const id: number = record.id;
    setBusy(true);
    try {
      await deleteRecord(id);
      setDeleteState(null);
      setSelectedIds((prev: number[]): number[] =>
        prev.filter((value: number): boolean => value !== id),
      );
      bumpRefresh();
      holderMessage.success('已移入回收站');
    } catch (cause) {
      holderMessage.error(errorMessage(cause, '删除失败'));
    } finally {
      setBusy(false);
    }
  };

  const doBatchDelete = async (): Promise<void> => {
    const ids: number[] = [...selectedIds];
    if (ids.length === 0) {
      return;
    }
    // 单独声明变量以携带幂等键（BatchDeleteRequest 未显式声明该可选字段，
    // 但服务端 batchDeleteSchema 接受；结构化赋值不做多余属性检查）。
    const payload = { ids, idempotencyKey: createIdempotencyKey() };
    setBusy(true);
    try {
      await batchDeleteRecords(payload);
      setDeleteState(null);
      setSelectedIds([]);
      bumpRefresh();
      holderMessage.success(`已移入回收站 ${ids.length} 条`);
    } catch (cause) {
      holderMessage.error(errorMessage(cause, '批量删除失败'));
    } finally {
      setBusy(false);
    }
  };

  const onConfirmDelete = useCallback((): void => {
    if (deleteState === null) {
      return;
    }
    if (deleteState.kind === 'one') {
      void doDeleteOne(deleteState.record);
    } else {
      void doBatchDelete();
    }
    // doDeleteOne / doBatchDelete 定义在组件内，依赖随渲染变化，此处刻意只用当前闭包。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deleteState]);

  const onDownloadTemplate = useCallback(async (): Promise<void> => {
    try {
      const filename: string = await downloadTemplateFile();
      holderMessage.success(`模板已下载：${filename}`);
    } catch (cause) {
      holderMessage.error(errorMessage(cause, '模板下载失败'));
    }
    // holderMessage 由 AntdApp.useApp() 提供，实例在同一 App 上下文内稳定。
  }, [holderMessage]);

  const currentPage: number = filter.page ?? 1;
  const currentPageSize: number = filter.pageSize ?? DEFAULT_PAGE_SIZE;
  const baseExportFilter: RecordFilter = exportFilter();

  return (
    <div className="stockin-page">
      <div className="stockin-page-head">
        <div className="stockin-title-row">
          {/* 临期口径已在设置页与筛选条说明中交代，此处不再第三次重复。 */}
          <h1 className="stockin-page-title">进货记录</h1>
        </div>
        <div className="stockin-page-actions">
          <Button
            icon={<Icon name="template" size="sm" />}
            onClick={(): void => void onDownloadTemplate()}
            style={{ minHeight: TOUCH_TARGET_MIN_PX }}
          >
            下载模板
          </Button>
          <Button
            icon={<Icon name="upload" size="sm" />}
            disabled={heavyBusy}
            onClick={(): void => openWorkbench('import')}
            style={{ minHeight: TOUCH_TARGET_MIN_PX }}
          >
            导入
          </Button>
          <Button
            icon={<Icon name="download" size="sm" />}
            disabled={heavyBusy}
            onClick={(): void => openWorkbench('export')}
            style={{ minHeight: TOUCH_TARGET_MIN_PX }}
          >
            导出
          </Button>
          <span data-tour-id="records-new" style={{ display: 'inline-flex' }}>
            <Button
              type="primary"
              icon={<Icon name="plus" size="sm" />}
              onClick={(): void => navigate(ROUTES.recordNew)}
              style={{ minHeight: TOUCH_TARGET_MIN_PX }}
            >
              新增记录
            </Button>
          </span>
        </div>
      </div>

      {useCardList ? (
        <div className="stockin-mfilter">
          <button
            type="button"
            className={`stockin-mfilter-chip${describeRecordFilter(filter).length > 0 ? ' is-on' : ''}`}
            onClick={(): void => setFilterSheetOpen(true)}
          >
            <Icon name="search" size="sm" />
            筛选
            {describeRecordFilter(filter).length > 0
              ? ` · ${describeRecordFilter(filter).length}`
              : ''}
          </button>
          {describeRecordFilter(filter).length > 0 ? (
            <button type="button" className="stockin-mfilter-chip" onClick={onFilterReset}>
              清除
            </button>
          ) : null}
        </div>
      ) : (
        <FilterBar filter={filter} onChange={onFilterChange} onReset={onFilterReset} />
      )}

      {error !== null ? (
        <ErrorView error={error} onRetry={retry} />
      ) : (
        <>
          {/* 批量条固定在列表上方：勾选后立即可见，不随列表高度落到分页之下。 */}
          <BatchActionBar
            selectedCount={selectedIds.length}
            busy={busy}
            onBatchDelete={(): void => setDeleteState({ kind: 'batch' })}
            onClear={clearSelection}
          />

          {useCardList ? (
            <div>
              <RecordCardList
                items={items}
                loading={loading}
                selectedIds={selectedIds}
                onToggle={onToggle}
                onEdit={onEdit}
                onDelete={onDelete}
                total={total}
                page={currentPage}
                pageSize={currentPageSize}
                onPageChange={onPageChange}
              />
            </div>
          ) : (
            <RecordTable
              items={items}
              loading={loading}
              selectedIds={selectedIds}
              onSelectedIdsChange={onSelectedIdsChange}
              onEdit={onEdit}
              onDelete={onDelete}
              total={total}
              page={currentPage}
              pageSize={currentPageSize}
              onPageChange={onPageChange}
              sortBy={filter.sortBy}
              sortOrder={filter.sortOrder}
              onSortChange={onSortChange}
            />
          )}
        </>
      )}

      <ConfirmDeleteModal
        open={deleteState !== null}
        title={deleteState?.kind === 'batch' ? '批量移入回收站' : '移入回收站'}
        description={
          deleteState?.kind === 'batch'
            ? `选中的 ${selectedIds.length} 条记录移入回收站，可在回收站恢复。`
            : deleteState?.kind === 'one'
              ? `「${deleteState.record.name}」移入回收站，可在回收站恢复。`
              : ''
        }
        confirmText="移入回收站"
        danger={false}
        busy={busy}
        onConfirm={onConfirmDelete}
        onCancel={(): void => setDeleteState(null)}
      />

      <Drawer
        placement="bottom"
        open={filterSheetOpen}
        onClose={(): void => setFilterSheetOpen(false)}
        height="auto"
        title="筛选记录"
        className="stockin-drawer"
      >
        <FilterBar filter={filter} onChange={onFilterChange} onReset={onFilterReset} />
        <div className="stockin-btn-row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <Button onClick={onFilterReset}>重置</Button>
          <Button
            type="primary"
            onClick={(): void => setFilterSheetOpen(false)}
            style={{ minHeight: TOUCH_TARGET_MIN_PX }}
          >
            查看结果
          </Button>
        </div>
      </Drawer>

      <WorkbenchModal onImported={onImported} baseFilter={baseExportFilter} />
    </div>
  );
};

export default RecordsPage;
