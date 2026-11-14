/**
 * Excel 工作台：导入与导出共用的唯一弹窗。
 *
 * 两种操作是同一类「与 Excel 交换数据」的动作，不再分别使用抽屉与弹窗。
 * 顶部一组分段按钮即时切换面板（本地状态，不依赖请求回显），`key` 保证切换时
 * 面板状态重置。容器只负责壳与切换，导入 / 导出的全部业务逻辑留在各自面板。
 */
import React from 'react';
import { Modal } from 'antd';
import { useModel } from 'umi';
import type { RecordFilter } from '@stockin/shared';
import ImportPanel from '@/components/ImportPanel';
import ExportPanel from '@/components/ExportPanel';

export interface WorkbenchModalProps {
  /** 导入成功后的列表刷新回调。 */
  readonly onImported: () => void;
  /** 当前筛选（导出面板的基准条件）。 */
  readonly baseFilter: RecordFilter;
}

const MODES: readonly { readonly value: 'import' | 'export'; readonly label: string }[] = [
  { value: 'import', label: '导入 Excel' },
  { value: 'export', label: '导出 Excel' },
];

const WorkbenchModal: React.FC<WorkbenchModalProps> = ({ onImported, baseFilter }) => {
  const { workbench, openWorkbench, closeWorkbench, heavyBusy } = useModel('ui');
  const mode: 'import' | 'export' = workbench ?? 'import';

  return (
    <Modal
      open={workbench !== null}
      title="导入 / 导出 Excel"
      footer={null}
      /* 宽度交给 CSS 计算，横竖屏切换与窗口缩放无需重新渲染 */
      width="min(720px, calc(100vw - 32px))"
      onCancel={closeWorkbench}
      maskClosable={!heavyBusy}
      destroyOnClose
    >
      <div className="stockin-workbench-tabs" role="group" aria-label="Excel 操作">
        {MODES.map((item) => {
          const active: boolean = mode === item.value;
          return (
            <button
              key={item.value}
              type="button"
              aria-pressed={active}
              className={`stockin-segment-btn${active ? ' is-active' : ''}`}
              onClick={(): void => openWorkbench(item.value)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {mode === 'import' ? (
        <ImportPanel key="import" onImported={onImported} />
      ) : (
        <ExportPanel key="export" baseFilter={baseFilter} onClose={closeWorkbench} />
      )}
    </Modal>
  );
};

export default WorkbenchModal;
