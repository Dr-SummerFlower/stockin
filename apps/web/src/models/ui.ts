/**
 * 全局 UI model：抽屉 / 弹窗开关与「数据已变更」刷新计数。
 *
 * 写操作（新增 / 编辑 / 删除 / 恢复 / 导入 / 设置）成功后 `bumpRefresh()`，
 * 列表与大屏监听 `refreshKey` 重新拉取，避免多处各自维护刷新标志。
 */
import { useCallback, useState } from 'react';

export interface UiModelState {
  readonly refreshKey: number;
  readonly bumpRefresh: () => void;
  readonly importDrawerOpen: boolean;
  readonly exportModalOpen: boolean;
  readonly openImportDrawer: () => void;
  readonly closeImportDrawer: () => void;
  readonly openExportModal: () => void;
  readonly closeExportModal: () => void;
}

export default function useUiModel(): UiModelState {
  const [refreshKey, setRefreshKey] = useState<number>(0);
  const [importDrawerOpen, setImportDrawerOpen] = useState<boolean>(false);
  const [exportModalOpen, setExportModalOpen] = useState<boolean>(false);

  const bumpRefresh = useCallback((): void => {
    setRefreshKey((key) => key + 1);
  }, []);
  const openImportDrawer = useCallback((): void => setImportDrawerOpen(true), []);
  const closeImportDrawer = useCallback((): void => setImportDrawerOpen(false), []);
  const openExportModal = useCallback((): void => setExportModalOpen(true), []);
  const closeExportModal = useCallback((): void => setExportModalOpen(false), []);

  return {
    refreshKey,
    bumpRefresh,
    importDrawerOpen,
    exportModalOpen,
    openImportDrawer,
    closeImportDrawer,
    openExportModal,
    closeExportModal,
  };
}
