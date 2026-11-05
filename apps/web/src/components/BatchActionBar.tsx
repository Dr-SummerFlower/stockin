/**
 * 底部批量操作条。
 *
 * 依据：主理人 T04 口径 ⑦ —— <768 时固定在底部（CSS `.stockin-batch-bar`），
 * 桌面档降级为普通行内工具条；触控目标 ≥44×44px。
 * 批量删除的二次确认由页面持有 `ConfirmDeleteModal`，本组件只发事件。
 */
import React from 'react';
import { Button, Typography } from 'antd';
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
}) => (
  <div className="stockin-batch-bar stockin-touch">
    <Typography.Text>
      已选 <Typography.Text strong>{selectedCount}</Typography.Text> 项
    </Typography.Text>
    <div className="stockin-btn-row">
      <Button
        onClick={onClear}
        disabled={busy || selectedCount === 0}
        style={{ minHeight: TOUCH_TARGET_MIN_PX }}
      >
        清空选择
      </Button>
      <Button
        danger
        type="primary"
        loading={busy}
        disabled={selectedCount === 0}
        onClick={onBatchDelete}
        style={{ minHeight: TOUCH_TARGET_MIN_PX }}
      >
        批量删除
      </Button>
    </div>
  </div>
);

export default BatchActionBar;
