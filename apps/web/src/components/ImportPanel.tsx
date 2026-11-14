/**
 * Excel 导入面板（由 WorkbenchModal 统一承载，自身不含容器）。
 *
 * 依据：主理人 T04 口径 ② —— 导入用 `FormData`（字段名 `file`）。
 * 422 时 `ApiError.details` 是 `ImportReport`（或单个 `ImportIssue` 行数超限），
 * 错误行号是 **Excel 物理行号**（模板第 1 行为表头，首个数据行为 2），此处原样渲染。
 * 用原生 `<input type="file">` 而非 antd Upload，避免引入额外的包解析依赖；
 * 前端不解析 xlsx，全部交给服务端。
 *
 * 展示口径：服务端错误码统一走 `ERROR_MESSAGES` 中文映射，未知值回落中性中文；
 * 英文列名映射为中文标签，中文表头原样显示；不出现裸枚举与工程黑话。
 */
import React, { useId, useRef, useState } from 'react';
import { Alert, App as AntdApp, Button, Popover, Table, Typography } from 'antd';
import type { TableProps } from 'antd';
import type { ImportIssue, ImportReport } from '@stockin/shared';
import { ERROR_MESSAGES } from '@stockin/shared';
import { useModel } from 'umi';
import { importExcel } from '@/services/api/excel';
import { ApiError, errorMessage } from '@/services/request';
import { RECORD_FIELD_LABELS, TOUCH_TARGET_MIN_PX } from '@/constants/routes';

export interface ImportPanelProps {
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

/** 错误码 → 中文问题类型；未知值回落中性文案，不把服务端枚举直出。 */
function issueCodeText(code: string): string {
  const table: Readonly<Record<string, string>> = ERROR_MESSAGES;
  return table[code] ?? '该行校验未通过';
}

/** 英文列名映射中文；中文表头原样显示；其余回落中性文案。 */
function issueFieldText(field: string | undefined): string {
  if (field === undefined || field === '') {
    return '—';
  }
  if (/[\u4e00-\u9fa5]/.test(field)) {
    return field;
  }
  return RECORD_FIELD_LABELS[field] ?? '未指明字段';
}

const issueColumns: TableProps<ImportIssue>['columns'] = [
  {
    title: '表格行号',
    dataIndex: 'row',
    key: 'row',
    width: 96,
    render: (row: number): React.ReactNode => (
      <span className="stockin-mono">{row}</span>
    ),
  },
  {
    title: '列',
    dataIndex: 'column',
    key: 'column',
    width: 64,
    render: (column: number | undefined): React.ReactNode => column ?? '—',
  },
  {
    title: '字段',
    dataIndex: 'field',
    key: 'field',
    width: 116,
    render: (field: string | undefined): React.ReactNode => issueFieldText(field),
  },
  {
    title: '问题类型',
    dataIndex: 'code',
    key: 'code',
    width: 168,
    render: (code: string): React.ReactNode => issueCodeText(code),
  },
  {
    title: '原因',
    dataIndex: 'reason',
    key: 'reason',
    render: (reason: string): React.ReactNode => reason,
  },
];

/**
 * 导入规则说明：这里用 antd Popover（portal）而不是 InfoTip。
 *
 * InfoTip 的面板是内联绝对定位、非 portal，挂在本弹窗里会被 `.ant-modal-body`
 * 的盒子裁切（实测 390×844 与 1440×900 下四个角点分别命中 `.ant-modal-content`
 * 与 `.ant-modal-wrap`，即面板被压在弹窗内容后面）。Popover 走 portal 挂到 body，
 * 文案与视觉仍与 InfoTip 面板一致。InfoTip 自身的非 portal 机制不动
 * （内联定位是为避开 details/summary 误折叠刻意做的）。
 */
const ImportRuleTip: React.FC = () => {
  const contentId: string = useId();
  const [open, setOpen] = useState<boolean>(false);
  return (
    <Popover
      trigger="click"
      placement="topLeft"
      arrow={{ pointAtCenter: true }}
      open={open}
      onOpenChange={setOpen}
      overlayClassName="stockin-popover"
      content={
        <div id={contentId} className="stockin-popover-panel">
          <b>导入规则</b>
          <div>模板取自记录页「下载模板」；第 1 行为表头，自第 2 行起填写；任一行有问题则整批不导入。</div>
          <div>同一批次内或与已有记录八项相同的行会被拦下；备注与保质期不参与判重。</div>
        </div>
      }
    >
      <button
        type="button"
        className="stockin-info-tip"
        aria-label="查看导入规则说明"
        aria-expanded={open}
        aria-describedby={open ? contentId : undefined}
      >
        <span className="stockin-info-tip-mark" aria-hidden="true">
          ?
        </span>
      </button>
    </Popover>
  );
};

const ImportPanel: React.FC<ImportPanelProps> = ({ onImported }) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const { message: holderMessage } = AntdApp.useApp();
  const { report, fileName, accepted, setReport, clearReport } = useModel('importReport');
  // 导入 / 导出共用服务端全局信号量(1)，前端互斥避免第二个请求拿到 503。
  const { acquireHeavy, releaseHeavy, heavyBusy } = useModel('ui');

  const onFileChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const next: File | null = event.target.files?.[0] ?? null;
    setFile(next);
    clearReport();
  };

  const run = async (): Promise<void> => {
    if (file === null) {
      holderMessage.warning('尚未选择文件');
      return;
    }
    if (!acquireHeavy()) {
      holderMessage.warning('已有导入 / 导出任务进行中，稍后重试');
      return;
    }
    setBusy(true);
    try {
      const result: ImportReport = await importExcel(file);
      setReport(result, file.name);
      holderMessage.success(`导入完成，成功 ${result.acceptedRows} 行`);
      onImported();
    } catch (cause) {
      const normalized: ImportReport | null =
        cause instanceof ApiError ? normalizeImportReport(cause.details) : null;
      if (normalized !== null) {
        setReport(normalized, file.name);
        holderMessage.warning(`导入被拒绝，共 ${normalized.issues.length} 个问题，修正后重试`);
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
        holderMessage.error(reason);
      }
    } finally {
      setBusy(false);
      releaseHeavy();
    }
  };

  return (
    <div>
      <div className="stockin-workbench-actions" style={{ marginTop: 0 }}>
        <Button
          onClick={(): void => fileInputRef.current?.click()}
          style={{ minHeight: TOUCH_TARGET_MIN_PX }}
        >
          选择文件（.xlsx）
        </Button>
        <Button
          type="primary"
          loading={busy}
          disabled={file === null || heavyBusy}
          onClick={(): void => {
            void run();
          }}
          style={{ minHeight: TOUCH_TARGET_MIN_PX }}
        >
          开始导入
        </Button>
        <ImportRuleTip />
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          aria-label="选择导入文件"
          style={{ display: 'none' }}
          onChange={onFileChange}
        />
      </div>

      {file !== null ? (
        <Typography.Paragraph style={{ marginTop: 12 }}>
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
              description={`总行数 ${report.totalRows}，成功 ${report.acceptedRows} 行，拒绝 ${report.rejectedRows} 行；行号为表格中的实际行号。`}
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
    </div>
  );
};

export default ImportPanel;
