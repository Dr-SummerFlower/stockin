/**
 * 导入报告 model：保存最近一次 Excel 导入的 `ImportReport`，
 * 供导入面板展示错误行（**Excel 物理行号**）与成功汇总。
 */
import { useCallback, useState } from 'react';
import type { ImportReport } from '@stockin/shared';

export interface ImportReportModelState {
  readonly report: ImportReport | null;
  readonly fileName: string;
  readonly accepted: boolean;
  readonly setReport: (report: ImportReport | null, fileName?: string) => void;
  readonly clearReport: () => void;
}

export default function useImportReportModel(): ImportReportModelState {
  const [report, setReportState] = useState<ImportReport | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [accepted, setAccepted] = useState<boolean>(false);

  const setReport = useCallback((next: ImportReport | null, name: string = ''): void => {
    setReportState(next);
    setFileName(name);
    setAccepted(next !== null && next.rejectedRows === 0 && next.acceptedRows > 0);
  }, []);

  const clearReport = useCallback((): void => {
    setReportState(null);
    setFileName('');
    setAccepted(false);
  }, []);

  return { report, fileName, accepted, setReport, clearReport };
}
