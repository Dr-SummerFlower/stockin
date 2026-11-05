/**
 * 通用二次确认弹窗。
 *
 * 依据：主理人 T04 口径 ⑩ —— 回收站恢复 / 彻底删除、批量删除都要二次确认。
 * 恢复类操作可传 `danger={false}` 去掉「不可撤销」告警。
 */
import React from 'react';
import { Alert, Modal, Typography } from 'antd';

export interface ConfirmDeleteModalProps {
  readonly open: boolean;
  readonly title: string;
  readonly description: React.ReactNode;
  readonly confirmText?: string;
  readonly cancelText?: string;
  readonly danger?: boolean;
  readonly busy?: boolean;
  readonly extra?: React.ReactNode;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

const ConfirmDeleteModal: React.FC<ConfirmDeleteModalProps> = ({
  open,
  title,
  description,
  confirmText = '确认删除',
  cancelText = '取消',
  danger = true,
  busy = false,
  extra = null,
  onConfirm,
  onCancel,
}) => (
  <Modal
    open={open}
    title={title}
    onCancel={onCancel}
    onOk={onConfirm}
    okText={confirmText}
    cancelText={cancelText}
    okButtonProps={{ danger, loading: busy }}
    cancelButtonProps={{ disabled: busy }}
    maskClosable={!busy}
    closable={!busy}
  >
    <Typography.Paragraph>{description}</Typography.Paragraph>
    {extra}
    {danger ? (
      <Alert type="warning" showIcon message="此操作不可撤销，请二次确认。" />
    ) : null}
  </Modal>
);

export default ConfirmDeleteModal;
