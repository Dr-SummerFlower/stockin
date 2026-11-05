/**
 * Excel API（路径以 T03b `excel.routes.ts` 实际注册为准）。
 *
 * - 模板下载：GET + `download()`（fetch → blob → <a download> → revokeObjectURL）。
 * - 导入：POST multipart FormData，字段名 `file`；422 时 `ApiError.details` 是
 *   `ImportReport`（含 Excel 物理行号 issues），由 `ImportDrawer` 内联渲染。
 * - 导出：POST JSON `{ filter }` + `download()`（POST 不能用裸 `<a href>`）。
 */
import type { ImportReport, RecordFilter } from '@stockin/shared';
import { download, request } from '../request';

export function downloadTemplate(): Promise<{ blob: Blob; filename: string }> {
  return download('/api/excel/template');
}

export function importExcel(file: File, signal?: AbortSignal): Promise<ImportReport> {
  const form: FormData = new FormData();
  form.append('file', file, file.name);
  return request<ImportReport>('/api/excel/import', {
    method: 'POST',
    form,
    signal,
    // 422 错误行报告由 ImportDrawer 内联渲染，抑制全局提示。
    silent: true,
  });
}

export function exportExcel(
  filter: RecordFilter,
  signal?: AbortSignal,
): Promise<{ blob: Blob; filename: string }> {
  return download('/api/excel/export', {
    method: 'POST',
    json: { filter },
    signal,
  });
}
