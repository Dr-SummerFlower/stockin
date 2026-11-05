/**
 * 剪贴板复制按钮（三级降级）。
 *
 * 依据：主理人 T04 口径 ⑧ —— 纯 HTTP 非安全上下文下 `navigator.clipboard`
 * 不可用，必须依次降级：
 *  ① Clipboard API（仅安全上下文）；
 *  ② `document.execCommand('copy')` + 临时 textarea；
 *  ③ 弹出只读文本框并提示手动 Ctrl+C。
 * 不使用 `crypto.randomUUID()` 等安全上下文专属 API。
 */
import React, { useState } from 'react';
import { Button, Input, Modal, Typography, message } from 'antd';
import { TOUCH_TARGET_MIN_PX } from '@/constants/routes';

export interface ClipboardButtonProps {
  readonly value: string;
  readonly label?: string;
  readonly disabled?: boolean;
}

/** ① Clipboard API：非安全上下文或拒绝授权时返回 false，交下一级。 */
async function writeViaClipboardApi(text: string): Promise<boolean> {
  if (
    typeof navigator === 'undefined' ||
    navigator.clipboard === undefined ||
    typeof window === 'undefined' ||
    window.isSecureContext !== true
  ) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** ② execCommand：临时 textarea 选中后复制，随后移除节点。 */
function writeViaExecCommand(text: string): boolean {
  if (typeof document === 'undefined') {
    return false;
  }
  const textarea: HTMLTextAreaElement = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  let copied: boolean = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  document.body.removeChild(textarea);
  return copied;
}

const ClipboardButton: React.FC<ClipboardButtonProps> = ({
  value,
  label = '复制',
  disabled = false,
}) => {
  const [manualOpen, setManualOpen] = useState<boolean>(false);
  const [manualText, setManualText] = useState<string>('');

  const copy = async (): Promise<void> => {
    if (value === '') {
      message.warning('没有可复制的内容');
      return;
    }
    if (await writeViaClipboardApi(value)) {
      message.success('已复制');
      return;
    }
    if (writeViaExecCommand(value)) {
      message.success('已复制');
      return;
    }
    setManualText(value);
    setManualOpen(true);
    message.info('当前环境不支持自动复制，请在弹出文本框中按 Ctrl+C 手动复制');
  };

  return (
    <>
      <Button
        size="small"
        disabled={disabled}
        onClick={(): void => {
          void copy();
        }}
        style={{ minHeight: TOUCH_TARGET_MIN_PX, marginLeft: 8 }}
      >
        {label}
      </Button>
      <Modal
        open={manualOpen}
        title="手动复制"
        footer={null}
        onCancel={(): void => setManualOpen(false)}
      >
        <Typography.Paragraph type="secondary">
          文本框已选中，请按 Ctrl+C（Mac 为 ⌘+C）复制；复制完成后关闭本窗口。
        </Typography.Paragraph>
        <Input.TextArea
          value={manualText}
          readOnly
          autoSize={{ minRows: 2, maxRows: 6 }}
          aria-label="待复制文本"
          onFocus={(event: React.FocusEvent<HTMLTextAreaElement>): void => {
            event.currentTarget.select();
          }}
        />
      </Modal>
    </>
  );
};

export default ClipboardButton;
