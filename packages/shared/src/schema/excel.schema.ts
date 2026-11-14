/**
 * Excel 端点 Zod schema（zod v4.6.7）。
 * 依据：设计文档 v1.1 §10.1 裁决 13（统一 POST /api/excel/export + JSON RecordFilter）、
 * §10.2 裁决 30（2MB / 1000 行上限）。
 */
import * as z from 'zod';
import { IMPORT_MAX_FILE_BYTES } from '../constants';
import { recordFilterSchema } from './record.schema';

export const excelExportSchema = z.object({
  filter: recordFilterSchema.optional(),
});
export type ExcelExportInput = z.infer<typeof excelExportSchema>;

/** 上传文件元数据（魔数/解压/公式等校验在服务端上传链，不属 shared）。 */
export const excelImportMetaSchema = z.object({
  fileName: z.string().min(1).max(255),
  sizeBytes: z.number().int().min(0).max(IMPORT_MAX_FILE_BYTES),
});
export type ExcelImportMetaInput = z.infer<typeof excelImportMetaSchema>;
