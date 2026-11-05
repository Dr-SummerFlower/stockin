/**
 * Excel 模板下载按钮。
 *
 * 走 `services/request.ts` 的 `download()`：
 * `fetch → blob → createObjectURL → <a download> → revokeObjectURL`，
 * 文件名由 `content-disposition` 解析，不用裸 `<a href>`、不在前端解析 xlsx。
 */
import React, { useState } from 'react';
import { Button, message } from 'antd';
import { downloadTemplate } from '@/services/api/excel';
import { errorMessage } from '@/services/request';
import { TOUCH_TARGET_MIN_PX } from '@/constants/routes';

export interface TemplateDownloadProps {
  readonly label?: string;
}

const TemplateDownload: React.FC<TemplateDownloadProps> = ({
  label = '下载模板',
}) => {
  const [busy, setBusy] = useState<boolean>(false);

  const run = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await downloadTemplate();
      message.success(`模板已下载：${result.filename}`);
    } catch (cause) {
      message.error(errorMessage(cause, '模板下载失败'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      loading={busy}
      onClick={(): void => {
        void run();
      }}
      style={{ minHeight: TOUCH_TARGET_MIN_PX }}
    >
      {label}
    </Button>
  );
};

export default TemplateDownload;
