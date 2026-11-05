/**
 * 通用错误视图。
 *
 * 展示统一拦截层抛出的 ApiError 文案与 requestId（5xx 链路号，可复制），
 * 并可附一个重试动作。不做任何自动重试：重试只能由用户显式点击触发。
 */
import React from 'react';
import { Alert, Button, Space, Typography } from 'antd';
import { errorMessage, errorRequestId } from '@/services/request';
import ClipboardButton from '@/components/ClipboardButton';
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
        <div style={{ marginTop: 12 }}>
          <Typography.Text type="secondary">requestId：</Typography.Text>
          <Typography.Text className="stockin-request-id">{requestId}</Typography.Text>
          <ClipboardButton value={requestId} label="复制 requestId" />
        </div>
      ) : null}
      {onRetry !== undefined ? (
        <Space style={{ marginTop: 12 }}>
          <Button
            type="primary"
            onClick={onRetry}
            style={{ minHeight: TOUCH_TARGET_MIN_PX }}
          >
            重试
          </Button>
        </Space>
      ) : null}
    </div>
  );
};

export default ErrorView;
