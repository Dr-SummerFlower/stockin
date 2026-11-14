/**
 * 批量操作条：选中行后出现（主色浅底 + 1px 主色边界）。
 *
 * 依据：design/stockin-ui-design-system.md §5.2 与原型 batch-bar。
 * 批量删除的二次确认由页面持有 `ConfirmDeleteModal`，本组件只发事件；
 * 每屏最多 1 个主按钮，故此处不使用 primary 主按钮。
 */
import React from 'react';
import { Button } from 'antd';
import Icon from '@/components/Icon';
import { TOUCH_TARGET_MIN_PX } from '@/constants/routes';

export interface BatchActionBarProps {
  readonly selectedCount: number;
  readonly busy: boolean;
  readonly onBatchDelete: () => void;
  readonly onClear: () => void;
}

const BatchActionBar: React.FC<BatchActionBarProps> = ({
  selectedCount,
  busy,
  onBatchDelete,
  onClear,
}) => {
  if (selectedCount === 0) {
    return null;
  }
  return (
    <div className="stockin-batch-bar is-floating stockin-touch">
      <span>
        已选中 <b>{selectedCount}</b> 条记录
      </span>
      <div className="stockin-btn-row">
        <Button
          onClick={onClear}
          disabled={busy}
          style={{ minHeight: TOUCH_TARGET_MIN_PX }}
        >
          取消选择
        </Button>
        <Button
          danger
          icon={<Icon name="trash" size="sm" />}
          loading={busy}
          onClick={onBatchDelete}
          style={{ minHeight: TOUCH_TARGET_MIN_PX }}
        >
          批量删除
        </Button>
      </div>
    </div>
  );
};

export default BatchActionBar;
