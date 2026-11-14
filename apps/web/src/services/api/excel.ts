/**
 * Excel API（路径以 T03b `excel.routes.ts` 实际注册为准）。
 *
 * - 模板下载：GET + `download()`（fetch → blob → <a download> → revokeObjectURL）。
 * - 导入：POST multipart FormData，字段名 `file`；422 时 `ApiError.details` 是
 *   `ImportReport`（含 Excel 物理行号 issues），由 `导入面板` 内联渲染。
 * - 导出：POST JSON `{ filter }` + `download()`（POST 不能用裸 `<a href>`）。
 */
import type { ImportReport, RecordFilter } from '@stockin/shared';
import { download, request } from '../request';

export function downloadTemplate(): Promise<{ blob: Blob; filename: string }> {
  return download('/api/excel/template');
}

/** 供页面级「下载模板」按钮复用：只取文件名，提示由调用方统一发出。 */
export async function downloadTemplateFile(): Promise<string> {
  const result = await downloadTemplate();
  return result.filename;
}

export function importExcel(file: File, signal?: AbortSignal): Promise<ImportReport> {
  const form: FormData = new FormData();
  form.append('file', file, file.name);
  return request<ImportReport>('/api/excel/import', {
    method: 'POST',
    form,
    signal,
    // 422 错误行报告由 导入面板 内联渲染，抑制全局提示。
    silent: true,
  });
}

/**
 * 导出：filter 省略表示导出全部有效记录。
 * 注意日期区间由调用方合并进 filter（覆盖语义，不是与当前筛选取交集）。
 */
export function exportExcel(
  filter: RecordFilter = {},
  signal?: AbortSignal,
): Promise<{ blob: Blob; filename: string }> {
  return download('/api/excel/export', {
    method: 'POST',
    json: { filter },
    signal,
  });
}
