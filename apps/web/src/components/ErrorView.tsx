/**
 * 通用错误视图。
 *
 * 主视图只显示错误说明与显式重试；操作编号属于排查用的技术信息，
 * 默认收进「技术信息」展开区，中文标签 + 一句用途说明，完整编号直接展示，
 * 供拖拽或长按选取。任何重试只由用户点击触发。
 */
import React from 'react';
import { Alert, Button, Space, Typography } from 'antd';
import { errorMessage, errorRequestId } from '@/services/request';
import { TOUCH_TARGET_MIN_PX } from '@/constants/routes';

export interface ErrorViewProps {
  readonly error: unknown;
  readonly title?: string;
  readonly onRetry?: () => void;
}

const ErrorView: React.FC<ErrorViewProps> = ({
  error,
  title = '加载失败',
  onRetry,
}) => {
  const text: string = errorMessage(error);
  const requestId: string = errorRequestId(error);
  return (
    <div className="stockin-error-box" role="alert">
      <Alert type="error" showIcon message={title} description={text} />
      {requestId !== '' ? (
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13, minHeight: TOUCH_TARGET_MIN_PX }}>
            技术信息
          </summary>
          <div style={{ marginTop: 8 }}>
            <Typography.Text type="secondary">操作编号：</Typography.Text>
            <Typography.Text className="stockin-request-id">{requestId}</Typography.Text>
          </div>
          <div className="stockin-hint">排查时提供该编号，可定位单次操作。</div>
        </details>
      ) : null}
      {onRetry !== undefined ? (
        <Space style={{ marginTop: 12 }}>
          <Button
            onClick={onRetry}
            style={{
              minHeight: TOUCH_TARGET_MIN_PX,
              borderColor: 'var(--stockin-color-primary)',
              color: 'var(--stockin-color-primary)',
            }}
          >
            重试
          </Button>
        </Space>
      ) : null}
    </div>
  );
};

export default ErrorView;
