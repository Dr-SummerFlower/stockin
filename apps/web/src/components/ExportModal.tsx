/**
 * Excel 导出弹窗。
 *
 * 依据：设计文档 §2.4 BR-11「导出范围 = 当前筛选 ∩ 日期范围」；
 * 主理人 T04 口径 ② —— POST 不能用裸 `<a href>`，统一走
 * `download()` 的 `fetch → blob → createObjectURL → <a download> → revokeObjectURL`。
 */
import React, { useState } from 'react';
import { Input, Modal, Typography, message } from 'antd';
import type { RecordFilter } from '@stockin/shared';
import { exportExcel } from '@/services/api/excel';
import { errorMessage } from '@/services/request';
import { isDateString } from '@/utils/format';

export interface ExportModalProps {
  readonly open: boolean;
  /** 当前筛选（已去掉分页，来自 recordFilters model 的 exportFilter()）。 */
  readonly baseFilter: RecordFilter;
  readonly onClose: () => void;
}

const DATE_HINT = 'YYYY-MM-DD';

const ExportModal: React.FC<ExportModalProps> = ({
  open,
  baseFilter,
  onClose,
}) => {
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);

  const invalid: boolean =
    (from.trim() !== '' && !isDateString(from.trim())) ||
    (to.trim() !== '' && !isDateString(to.trim()));

  const doExport = async (): Promise<void> => {
    if (invalid) {
      message.warning('日期范围须为 YYYY-MM-DD 格式');
      return;
    }
    const filter: RecordFilter = { ...baseFilter };
    if (from.trim() !== '') {
      filter.purchaseDateFrom = from.trim();
    }
    if (to.trim() !== '') {
      filter.purchaseDateTo = to.trim();
    }
    setBusy(true);
    try {
      const result = await exportExcel(filter);
      message.success(`导出完成：${result.filename}`);
      onClose();
    } catch (cause) {
      message.error(errorMessage(cause, '导出失败'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="导出 Excel"
      onCancel={onClose}
      onOk={(): void => {
        void doExport();
      }}
      okText="开始导出"
      cancelText="取消"
      okButtonProps={{ loading: busy, disabled: invalid }}
      cancelButtonProps={{ disabled: busy }}
      maskClosable={!busy}
    >
      <Typography.Paragraph type="secondary">
        导出范围 = 当前列表筛选条件 ∩ 此处填写的进货日期范围；留空表示不限制。
      </Typography.Paragraph>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <Input
          value={from}
          placeholder={`起始进货日期 ${DATE_HINT}`}
          aria-label="导出起始进货日期"
          status={from.trim() !== '' && !isDateString(from.trim()) ? 'error' : undefined}
          onChange={(event: React.ChangeEvent<HTMLInputElement>): void => setFrom(event.target.value)}
          style={{ flex: '1 1 180px', minHeight: 44 }}
        />
        <Input
          value={to}
          placeholder={`截止进货日期 ${DATE_HINT}`}
          aria-label="导出截止进货日期"
          status={to.trim() !== '' && !isDateString(to.trim()) ? 'error' : undefined}
          onChange={(event: React.ChangeEvent<HTMLInputElement>): void => setTo(event.target.value)}
          style={{ flex: '1 1 180px', minHeight: 44 }}
        />
      </div>
    </Modal>
  );
};

export default ExportModal;
