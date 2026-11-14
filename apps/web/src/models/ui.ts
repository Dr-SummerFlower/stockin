/**
 * 全局 UI model：数据刷新计数、重任务互斥、Excel 工作台。
 *
 * 导入与导出使用**同一个弹窗**，此处只用一个 `workbench` 状态记录当前面板，
 * 不再分别维护「抽屉」与「弹窗」两套开关，避免同类操作出现两种容器。
 *
 * 写操作（新增 / 编辑 / 删除 / 恢复 / 导入 / 设置）成功后 `bumpRefresh()`，
 * 列表与大屏监听 `refreshKey` 重新拉取，避免多处各自维护刷新标志。
 * 导入与导出共用服务端全局信号量(1)，并发第二个请求会拿到 503 COMMON_BUSY；
 * 故此处用一个前端互斥锁把按钮置为禁用态，避免用户触发该错误。
 */
import { useCallback, useRef, useState } from 'react';

export type WorkbenchMode = 'import' | 'export';

export interface UiModelState {
  readonly refreshKey: number;
  readonly bumpRefresh: () => void;
  /** null 表示弹窗关闭；否则为当前显示的面板。 */
  readonly workbench: WorkbenchMode | null;
  readonly openWorkbench: (mode: WorkbenchMode) => void;
  readonly closeWorkbench: () => void;
  /** 是否有导入 / 导出任务正在执行。 */
  readonly heavyBusy: boolean;
  /** 尝试占用重任务信号量；已被占用返回 false（调用方应提示稍候）。 */
  readonly acquireHeavy: () => boolean;
  readonly releaseHeavy: () => void;
}

export default function useUiModel(): UiModelState {
  const [refreshKey, setRefreshKey] = useState<number>(0);
  const [workbench, setWorkbench] = useState<WorkbenchMode | null>(null);
  const [heavyBusy, setHeavyBusy] = useState<boolean>(false);
  // ref 保证同一事件循环内的两次 acquire 也能互斥（state 更新是异步的）。
  const heavyRef = useRef<boolean>(false);

  const bumpRefresh = useCallback((): void => {
    setRefreshKey((key) => key + 1);
  }, []);
  const openWorkbench = useCallback((mode: WorkbenchMode): void => setWorkbench(mode), []);
  const closeWorkbench = useCallback((): void => setWorkbench(null), []);

  const acquireHeavy = useCallback((): boolean => {
    if (heavyRef.current) {
      return false;
    }
    heavyRef.current = true;
    setHeavyBusy(true);
    return true;
  }, []);
  const releaseHeavy = useCallback((): void => {
    heavyRef.current = false;
    setHeavyBusy(false);
  }, []);

  return {
    refreshKey,
    bumpRefresh,
    workbench,
    openWorkbench,
    closeWorkbench,
    heavyBusy,
    acquireHeavy,
    releaseHeavy,
  };
}
