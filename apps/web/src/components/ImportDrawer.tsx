/**
 * Excel 导入抽屉。
 *
 * 依据：主理人 T04 口径 ② —— 导入用 `FormData`（字段名 `file`）。
 * 422 时 `ApiError.details` 是 `ImportReport`（或单个 `ImportIssue` 行数超限），
 * 错误行号是 **Excel 物理行号**（模板第 1 行为表头，首个数据行为 2），此处原样渲染。
 * 用原生 `<input type="file">` 而非 antd Upload，避免引入额外的包解析依赖；
 * 前端不解析 xlsx，全部交给服务端。
 */
import React, { useRef, useState } from 'react';
import {
  Alert,
  Button,
  Drawer,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { TableProps } from 'antd';
import type { ImportIssue, ImportReport } from '@stockin/shared';
import { importExcel } from '@/services/api/excel';
import { ApiError, errorMessage } from '@/services/request';
import TemplateDownload from '@/components/TemplateDownload';
import { TOUCH_TARGET_MIN_PX } from '@/constants/routes';
import { useModel } from 'umi';

export interface ImportDrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** 导入成功后回调（页面据此 bumpRefresh 重拉列表）。 */
  readonly onImported: () => void;
}

/** 把 422 details 归一为 ImportReport；无法识别时返回 null。 */
export function normalizeImportReport(details: unknown): ImportReport | null {
  if (details === null || typeof details !== 'object') {
    return null;
  }
  const candidate = details as Partial<ImportReport> & Partial<ImportIssue>;
  if (typeof candidate.totalRows === 'number' && Array.isArray(candidate.issues)) {
    return {
      totalRows: candidate.totalRows,
      acceptedRows: typeof candidate.acceptedRows === 'number' ? candidate.acceptedRows : 0,
      rejectedRows: typeof candidate.rejectedRows === 'number' ? candidate.rejectedRows : 0,
      issues: candidate.issues as ImportIssue[],
    };
  }
  // 行数超限时服务端返回单个 ImportIssue。
  if (typeof candidate.row === 'number' && typeof candidate.reason === 'string') {
    return {
      totalRows: candidate.row,
      acceptedRows: 0,
      rejectedRows: 1,
      issues: [
        {
          row: candidate.row,
          column: candidate.column,
          field: candidate.field,
          code: candidate.code ?? 'EXCEL_ROW_INVALID',
          reason: candidate.reason,
        },
      ],
    };
  }
  return null;
}

const issueColumns: TableProps<ImportIssue>['columns'] = [
  {
    title: 'Excel 行号',
    dataIndex: 'row',
    key: 'row',
    width: 110,
    render: (row: number): React.ReactNode => <Tag color="error">{row}</Tag>,
  },
  {
    title: '列',
    dataIndex: 'column',
    key: 'column',
    width: 70,
    render: (column: number | undefined): React.ReactNode => column ?? '—',
  },
  {
    title: '字段',
    dataIndex: 'field',
    key: 'field',
    width: 120,
    render: (field: string | undefined): React.ReactNode => field ?? '—',
  },
  {
    title: '错误码',
    dataIndex: 'code',
    key: 'code',
    width: 180,
    render: (code: string): React.ReactNode => <Typography.Text code>{code}</Typography.Text>,
  },
  {
    title: '原因',
    dataIndex: 'reason',
    key: 'reason',
    render: (reason: string): React.ReactNode => reason,
  },
];

const ImportDrawer: React.FC<ImportDrawerProps> = ({ open, onClose, onImported }) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const { report, fileName, accepted, setReport, clearReport } = useModel('importReport');

  const onFileChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const next: File | null = event.target.files?.[0] ?? null;
    setFile(next);
    clearReport();
  };

  const run = async (): Promise<void> => {
    if (file === null) {
      message.warning('请先选择 .xlsx 文件');
      return;
    }
    setBusy(true);
    try {
      const result: ImportReport = await importExcel(file);
      setReport(result, file.name);
      message.success(`导入完成，成功 ${result.acceptedRows} 行`);
      onImported();
    } catch (cause) {
      const normalized: ImportReport | null =
        cause instanceof ApiError ? normalizeImportReport(cause.details) : null;
      if (normalized !== null) {
        setReport(normalized, file.name);
        message.warning(`导入被拒绝，共 ${normalized.issues.length} 个问题，请按行号修正后重试`);
      } else {
        const reason: string = errorMessage(cause, '导入失败');
        setReport(
          {
            totalRows: 0,
            acceptedRows: 0,
            rejectedRows: 0,
            issues: [{ row: 0, code: 'IMPORT_FAILED', reason }],
          },
          file.name,
        );
        message.error(reason);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open={open}
      title="导入 Excel"
      width={Math.min(720, typeof window === 'undefined' ? 720 : window.innerWidth)}
      onClose={onClose}
      maskClosable={!busy}
    >
      <Typography.Paragraph type="secondary">
        请先下载模板，按第 1 行表头填写（不含示例行）；空单元格会由服务端按三选二规则补算。
        有任一错误行时整批不写入。
      </Typography.Paragraph>

      <Space wrap style={{ marginBottom: 16 }}>
        <TemplateDownload />
        <Button
          onClick={(): void => fileInputRef.current?.click()}
          style={{ minHeight: TOUCH_TARGET_MIN_PX }}
        >
          选择 .xlsx 文件
        </Button>
        <Button
          type="primary"
          loading={busy}
          disabled={file === null}
          onClick={(): void => {
            void run();
          }}
          style={{ minHeight: TOUCH_TARGET_MIN_PX }}
        >
          开始导入
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          aria-label="选择导入文件"
          style={{ display: 'none' }}
          onChange={onFileChange}
        />
      </Space>

      {file !== null ? (
        <Typography.Paragraph>
          已选择：<Typography.Text strong>{file.name}</Typography.Text>
        </Typography.Paragraph>
      ) : null}

      {report !== null ? (
        <>
          {accepted ? (
            <Alert
              type="success"
              showIcon
              message={`导入成功：${fileName}`}
              description={`总行数 ${report.totalRows}，成功 ${report.acceptedRows} 行，拒绝 ${report.rejectedRows} 行。`}
              style={{ marginBottom: 12 }}
            />
          ) : (
            <Alert
              type="error"
              showIcon
              message={`导入未通过：${fileName}`}
              description={`总行数 ${report.totalRows}，成功 ${report.acceptedRows} 行，拒绝 ${report.rejectedRows} 行；以下为 Excel 物理行号。`}
              style={{ marginBottom: 12 }}
            />
          )}
          {report.issues.length > 0 ? (
            <Table<ImportIssue>
              rowKey={(issue: ImportIssue, index?: number): string =>
                `${issue.row}-${issue.code}-${index ?? 0}`
              }
              columns={issueColumns}
              dataSource={report.issues as ImportIssue[]}
              size="small"
              pagination={false}
              scroll={{ x: 640 }}
            />
          ) : null}
        </>
      ) : null}
    </Drawer>
  );
};

export default ImportDrawer;
