/**
 * `EXCEL_HEADERS`：全项目 Excel 列序、表头文案、字段映射与格式规则的单一真源。
 *
 * 依据：设计文档 v1.1 §2.4 BR-11、§4.3（保质期拆「数值+单位」两列，导出时合并为
 * 单列文本 `"12个月"`）、§10.1 裁决 18（模板不含示例行、EXCEL_HEADERS 单一真源）。
 * 模板第 1 行为表头，错误行号一律使用 Excel 物理行号。
 */
import { DATE_FORMAT } from './constants';
import {
  ShelfLifeUnit,
  SHELF_LIFE_UNIT_LABELS,
  SHELF_LIFE_UNIT_BY_LABEL,
  type ShelfLifeUnit as ShelfLifeUnitType,
} from './enums';

/** 模板表头所在物理行号与首个数据行号。 */
export const EXCEL_HEADER_ROW = 1;
export const EXCEL_FIRST_DATA_ROW = EXCEL_HEADER_ROW + 1;

/** Excel 日期单元格的 numFmt（exceljs 约定），展示格式恒为 YYYY-MM-DD。 */
export const EXCEL_DATE_NUMFMT = 'yyyy-mm-dd';

/** 10 个业务字段的 Excel 列键（外加可选的「单据编号」尾列）。保质期是「数值 + 单位」合并的 1 列。 */
export type ExcelFieldKey =
  | 'name'
  | 'purchaseDate'
  | 'productionDate'
  | 'shelfLife'
  | 'expiryDate'
  | 'spec'
  | 'unitPrice'
  | 'quantity'
  | 'amount'
  | 'remark'
  | 'orderNo';

export interface ExcelHeaderDef {
  /** 稳定的列键。 */
  readonly key: ExcelFieldKey;
  /** 表头文案（唯一真源，导出与模板都读它）。 */
  readonly header: string;
  /** 映射到 RecordFields 的字段名。 */
  readonly field: string;
  /** 1-based 列号。 */
  readonly column: number;
  /** 日期列的展示格式。 */
  readonly dateFormat?: string;
  /** 日期列的 exceljs numFmt。 */
  readonly numFmt?: string;
  /** 单元格语义类别。 */
  readonly kind: 'text' | 'date' | 'shelfLife' | 'decimal' | 'money' | 'quantity';
  /**
   * 可选列：导入时允许缺失（含表头为空）。
   *
   * 用于「单据编号」这类后加的尾列：升级前导出的 10 列文件必须仍能导入，
   * 缺列按散记处理；写入始终按本数组顺序，缺列补空串。
   */
  readonly optional?: boolean;
}

/**
 * 固定列序，列序即导出/导入顺序。禁止在其它模块另写一份表头数组。
 *
 * 第 11 列「单据编号」是后加的**可选尾列**：放在最后而不是插进中间，
 * 否则升级前导出的文件会整体错列。
 */
export const EXCEL_HEADERS: readonly ExcelHeaderDef[] = [
  {
    key: 'name',
    header: '商品名称',
    field: 'name',
    column: 1,
    kind: 'text',
  },
  {
    key: 'purchaseDate',
    header: '进货日期',
    field: 'purchaseDate',
    column: 2,
    dateFormat: DATE_FORMAT,
    numFmt: EXCEL_DATE_NUMFMT,
    kind: 'date',
  },
  {
    key: 'productionDate',
    header: '生产日期',
    field: 'productionDate',
    column: 3,
    dateFormat: DATE_FORMAT,
    numFmt: EXCEL_DATE_NUMFMT,
    kind: 'date',
  },
  {
    key: 'shelfLife',
    header: '保质期',
    field: 'shelfLife',
    column: 4,
    kind: 'shelfLife',
  },
  {
    key: 'expiryDate',
    header: '到期日期',
    field: 'expiryDate',
    column: 5,
    dateFormat: DATE_FORMAT,
    numFmt: EXCEL_DATE_NUMFMT,
    kind: 'date',
  },
  {
    key: 'spec',
    header: '规格',
    field: 'spec',
    column: 6,
    kind: 'text',
  },
  {
    key: 'unitPrice',
    header: '单价',
    field: 'unitPrice',
    column: 7,
    kind: 'decimal',
  },
  {
    key: 'quantity',
    header: '数量',
    field: 'quantity',
    column: 8,
    kind: 'quantity',
  },
  {
    key: 'amount',
    header: '金额',
    field: 'amountCents',
    column: 9,
    kind: 'money',
  },
  {
    key: 'remark',
    header: '备注',
    field: 'remark',
    column: 10,
    kind: 'text',
  },
  {
    key: 'orderNo',
    header: '单据编号',
    field: 'orderNo',
    column: 11,
    kind: 'text',
    optional: true,
  },
];

/** 表头文案数组，用于导入时做表头一致性比对。 */
export const EXCEL_HEADER_TEXTS: readonly string[] = EXCEL_HEADERS.map((def) => def.header);

/**
 * 进货单汇总导出（`GET /api/orders/export`）的列。
 *
 * **这不是 `EXCEL_HEADERS` 的第二份**：上面那份是「一条记录一行」的明细表，
 * 这张是「一张单一行」的汇总表，两者列集与语义都不同，因此各自成一份常量，
 * 但同样只在这里定义一次，Service 不得另写列名数组。
 */
export interface OrderExportHeaderDef {
  readonly key:
    | 'orderNo'
    | 'supplier'
    | 'purchaseDate'
    | 'itemCount'
    | 'totalQuantity'
    | 'totalAmount'
    | 'createdAt';
  readonly header: string;
  /** 列宽（exceljs 字符宽度）。 */
  readonly width: number;
  readonly kind: 'text' | 'date' | 'integer' | 'quantity' | 'money' | 'datetime';
}

export const ORDER_EXPORT_HEADERS: readonly OrderExportHeaderDef[] = [
  { key: 'orderNo', header: '单据编号', width: 18, kind: 'text' },
  { key: 'supplier', header: '供货商', width: 22, kind: 'text' },
  { key: 'purchaseDate', header: '进货日期', width: 14, kind: 'date' },
  { key: 'itemCount', header: '品种数', width: 10, kind: 'integer' },
  { key: 'totalQuantity', header: '数量合计', width: 12, kind: 'quantity' },
  { key: 'totalAmount', header: '金额合计', width: 14, kind: 'money' },
  { key: 'createdAt', header: '录入时间', width: 20, kind: 'datetime' },
];

/** 进货单汇总表的表头文案。 */
export const ORDER_EXPORT_HEADER_TEXTS: readonly string[] = ORDER_EXPORT_HEADERS.map(
  (def) => def.header,
);

/** 全部列数（含可选列），模板与导出按此写出。 */
export const EXCEL_COLUMN_COUNT = EXCEL_HEADERS.length;

/**
 * 必填列数：导入时表头至少要覆盖到这几位。
 * 升级前导出的 10 列文件缺的正是可选尾列，因此这里从 11 降为 10。
 */
export const EXCEL_REQUIRED_COLUMN_COUNT = EXCEL_HEADERS.filter(
  (def) => def.optional !== true,
).length;

/** 取某列的 1-based 列号；未知键返回 0。 */
export function excelColumnNumber(key: ExcelFieldKey): number {
  const found: ExcelHeaderDef | undefined = EXCEL_HEADERS.find((def) => def.key === key);
  return found === undefined ? 0 : found.column;
}

/** 取某列的字段映射名；未知键返回空串。 */
export function excelFieldName(key: ExcelFieldKey): string {
  const found: ExcelHeaderDef | undefined = EXCEL_HEADERS.find((def) => def.key === key);
  return found === undefined ? '' : found.field;
}

/**
 * 0-based 数据行下标 → Excel 物理行号（模板第 1 行为表头，故 +2）。
 */
export function excelPhysicalRow(dataIndex0: number): number {
  return EXCEL_FIRST_DATA_ROW + dataIndex0;
}

/**
 * 保质期「数值 + 单位」合并规则：导出为 `"12个月"`。
 * 值为空或单位为空时返回空串（由导入侧按空单元格补算规则处理）。
 */
export function formatShelfLifeCell(value: number | null, unit: ShelfLifeUnitType | null): string {
  if (value === null || unit === null) {
    return '';
  }
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return '';
  }
  return `${value}${SHELF_LIFE_UNIT_LABELS[unit]}`;
}

/** 解析后的保质期单元格。 */
export interface ParsedShelfLifeCell {
  readonly value: number;
  readonly unit: ShelfLifeUnitType;
}

const SHELF_LIFE_CELL_PATTERN = /^\s*([+]?\d+)\s*([^\d\s]*)\s*$/;

/**
 * 拆分 `"12个月"` / `"12"` / `"12 month"` 一类文本。
 * 无单位时按「天」兜底（Excel 模板始终带单位，兼容手工编辑的简写）。
 * 无法解析返回 null，由调用方产出 EXCEL_ROW_INVALID issue。
 */
export function parseShelfLifeCell(cell: string | null | undefined): ParsedShelfLifeCell | null {
  if (cell === null || cell === undefined) {
    return null;
  }
  const match: RegExpExecArray | null = SHELF_LIFE_CELL_PATTERN.exec(cell);
  if (match === null) {
    return null;
  }
  const rawValue: string = match[1] ?? '';
  const label: string = (match[2] ?? '').trim();
  const value: number = Number.parseInt(rawValue, 10);
  if (!Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  if (label === '') {
    return { value, unit: ShelfLifeUnit.DAY };
  }
  const unit: ShelfLifeUnitType | undefined = SHELF_LIFE_UNIT_BY_LABEL[label.toLowerCase()];
  if (unit === undefined) {
    return null;
  }
  return { value, unit };
}
