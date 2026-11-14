/**
 * chunk 加载失败兜底。
 *
 * 依据：主理人 T04「chunk 加载失败提示刷新兜底」。
 * 拆成三块：① 纯判定（供 app.tsx 的全局监听复用）；② 安装器；③ 可复用 UI（ErrorView）。
 * 不做 PWA / Service Worker / 离线态相关任何处理。
 * 文案采用中性书面语，不含劝导语。
 */
import React from 'react';
import { Button, Result, Typography, message } from 'antd';
import { TOUCH_TARGET_MIN_PX } from '@/constants/routes';

const CHUNK_ERROR_PATTERN =
  /ChunkLoadError|Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed|Loading CSS chunk/i;

/** 是否为动态 import / chunk 加载失败。 */
export function isChunkLoadError(text: string): boolean {
  return CHUNK_ERROR_PATTERN.test(text);
}

/** 安装一次性全局监听（忽略重复安装）。 */
export function installChunkLoadFallback(): void {
  if (typeof window === 'undefined' || window.__STOCKIN_CHUNK_ERROR__ === true) {
    return;
  }
  window.__STOCKIN_CHUNK_ERROR__ = true;
  const notify = (text: string): void => {
    if (isChunkLoadError(text)) {
      message.error({
        content: '页面资源加载失败，刷新页面后重试',
        key: 'stockin-chunk-load',
        duration: 0,
      });
    }
  };
  window.addEventListener(
    'error',
    (event: ErrorEvent) => {
      notify(event.message ?? '');
    },
    true,
  );
  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const reason: unknown = event.reason;
    notify(reason instanceof Error ? reason.message : String(reason ?? ''));
  });
}

export interface ChunkLoadFallbackProps {
  readonly detail?: string;
}

/** 内联错误 UI：提示刷新并给出刷新按钮。 */
const ChunkLoadFallback: React.FC<ChunkLoadFallbackProps> = ({ detail }) => {
  const reload = (): void => {
    window.location.reload();
  };
  return (
    <Result
      status="warning"
      title="页面资源加载失败"
      subTitle={
        <Typography.Text type="secondary">
          {detail ?? '应用已更新，刷新页面后重试。'}
        </Typography.Text>
      }
      extra={
        <Button
          type="primary"
          onClick={reload}
          style={{ minHeight: TOUCH_TARGET_MIN_PX, minWidth: 88 }}
        >
          刷新页面
        </Button>
      }
    />
  );
};

export default ChunkLoadFallback;
