/**
 * 进货记录列表页。
 *
 * - 筛选与导出共用 `recordFilters` model 的同一份 `RecordFilter`；
 * - `<768` 由 `useBreakpoint()` 切换为卡片列表 + 底部 `BatchActionBar`；
 * - 单条删除 / 批量删除均经 `ConfirmDeleteModal` 二次确认；
 * - Excel 导入 / 导出 / 模板下载分别交给对应组件，写操作成功统一 `bumpRefresh()`。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Button, Pagination, Space, message } from 'antd';
import { useModel, useNavigate } from 'umi';
import {
  DEFAULT_PAGE_SIZE,
  type RecordFilter,
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
import ImportDrawer from '@/components/ImportDrawer';
import ExportModal from '@/components/ExportModal';
import TemplateDownload from '@/components/TemplateDownload';
import { ROUTES, TOUCH_TARGET_MIN_PX } from '@/constants/routes';

const RecordsPage: React.FC = () => {
  const navigate = useNavigate();
  const { useCardList } = useBreakpoint();
  const { filter, patchFilter, resetFilter, setPage, exportFilter } =
    useModel('recordFilters');
  const {
    refreshKey,
    bumpRefresh,
    importDrawerOpen,
    exportModalOpen,
    openImportDrawer,
    closeImportDrawer,
    openExportModal,
    closeExportModal,
  } = useModel('ui');

  const [items, setItems] = useState<readonly RecordView[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<unknown>(null);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<RecordView | null>(null);
  const [batchOpen, setBatchOpen] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [reloadToken, setReloadToken] = useState<number>(0);

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
    setDeleteTarget(record);
  }, []);
  const onPageChange = useCallback(
    (page: number, pageSize: number): void => setPage(page, pageSize),
    [setPage],
  );
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

  const doDeleteOne = async (): Promise<void> => {
    if (deleteTarget === null) {
      return;
    }
    const id: number = deleteTarget.id;
    setBusy(true);
    try {
      await deleteRecord(id);
      setDeleteTarget(null);
      setSelectedIds((prev: number[]): number[] =>
        prev.filter((value: number): boolean => value !== id),
      );
      bumpRefresh();
      message.success('已移入回收站，可在回收站恢复');
    } catch (cause) {
      message.error(errorMessage(cause, '删除失败'));
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
      setBatchOpen(false);
      setSelectedIds([]);
      bumpRefresh();
      message.success(`已删除 ${ids.length} 条记录`);
    } catch (cause) {
      message.error(errorMessage(cause, '批量删除失败'));
    } finally {
      setBusy(false);
    }
  };

  const currentPage: number = filter.page ?? 1;
  const currentPageSize: number = filter.pageSize ?? DEFAULT_PAGE_SIZE;

  return (
    <div className="stockin-page">
      <div className="stockin-page-head">
        <div>
          <h1 className="stockin-page-title">进货记录</h1>
          <div className="stockin-page-subtitle">
            筛选与导出共用同一份条件 · 导出范围 = 当前筛选 ∩ 日期范围
          </div>
        </div>
        <Space wrap>
          <Button
            type="primary"
            onClick={(): void => navigate(ROUTES.recordNew)}
            style={{ minHeight: TOUCH_TARGET_MIN_PX }}
          >
            新增记录
          </Button>
          <Button
            onClick={openImportDrawer}
            style={{ minHeight: TOUCH_TARGET_MIN_PX }}
          >
            导入 Excel
          </Button>
          <Button
            onClick={openExportModal}
            style={{ minHeight: TOUCH_TARGET_MIN_PX }}
          >
            导出 Excel
          </Button>
          <TemplateDownload />
        </Space>
      </div>

      <FilterBar filter={filter} onChange={onFilterChange} onReset={onFilterReset} />

      <BatchActionBar
        selectedCount={selectedIds.length}
        busy={busy}
        onBatchDelete={(): void => setBatchOpen(true)}
        onClear={clearSelection}
      />

      {error !== null ? (
        <ErrorView error={error} onRetry={retry} />
      ) : (
        <div style={{ background: '#fff', borderRadius: 8 }}>
          {useCardList ? (
            <div style={{ padding: 12 }}>
              <RecordCardList
                items={items}
                selectedIds={selectedIds}
                onToggle={onToggle}
                onEdit={onEdit}
                onDelete={onDelete}
              />
              <div style={{ marginTop: 12, overflowX: 'auto' }}>
                <Pagination
                  current={currentPage}
                  pageSize={currentPageSize}
                  total={total}
                  showSizeChanger
                  onChange={onPageChange}
                />
              </div>
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
            />
          )}
        </div>
      )}

      <ConfirmDeleteModal
        open={deleteTarget !== null}
        title="删除该记录？"
        description={
          deleteTarget === null
            ? ''
            : `「${deleteTarget.name}」将被移入回收站，可在回收站恢复。`
        }
        confirmText="移入回收站"
        busy={busy}
        onConfirm={(): void => {
          void doDeleteOne();
        }}
        onCancel={(): void => setDeleteTarget(null)}
      />

      <ConfirmDeleteModal
        open={batchOpen}
        title="批量删除记录？"
        description={`将把选中的 ${selectedIds.length} 条记录移入回收站，可在回收站逐条恢复。`}
        confirmText="批量删除"
        busy={busy}
        onConfirm={(): void => {
          void doBatchDelete();
        }}
        onCancel={(): void => setBatchOpen(false)}
      />

      <ImportDrawer
        open={importDrawerOpen}
        onClose={closeImportDrawer}
        onImported={onImported}
      />
      <ExportModal
        open={exportModalOpen}
        baseFilter={exportFilter()}
        onClose={closeExportModal}
      />
    </div>
  );
};

export default RecordsPage;
