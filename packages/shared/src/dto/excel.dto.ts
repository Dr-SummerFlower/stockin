/**
 * Excel 契约：错误行报告、模板/导出请求、汇总日志载荷。
 * 依据：设计文档 v1.1 §2.4 BR-11、§5.2（导入链、物理行号、汇总日志）、§10.1 裁决 13/18。
 */
import type { RecordFilter } from './record.dto';

/**
 * 单行导入问题。row 恒为 **Excel 物理行号**（模板第 1 行是表头，首个数据行为 2）。
 */
export interface ImportIssue {
  row: number;
  /** 1-based 列号，可空（整行级问题） */
  column?: number;
  /** 字段键，可空 */
  field?: string;
  code: string;
  reason: string;
}

export interface ImportReport {
  totalRows: number;
  acceptedRows: number;
  rejectedRows: number;
  issues: ImportIssue[];
}

/**
 * 导出请求：沿用当前筛选（可选），统一 POST + JSON RecordFilter。
 * 与 `excelExportSchema.filter.optional()` 对齐；省略 filter 表示导出全部有效记录。
 * 日期区间由调用方合并进 filter（覆盖语义，非交集）。
 */
export interface ExportRequest {
  filter?: RecordFilter;
}

/** 导入文件的请求级元数据（用于校验链与汇总日志）。 */
export interface ImportRequestMeta {
  fileName: string;
  sizeBytes: number;
}

/** 一次导入写 1 条汇总操作日志的 detail 载荷。 */
export interface ImportSummaryLogPayload {
  fileName: string;
  totalRows: number;
  acceptedRows: number;
  rejectedRows: number;
  issueCount: number;
  durationMs: number;
  requestId: string;
}
