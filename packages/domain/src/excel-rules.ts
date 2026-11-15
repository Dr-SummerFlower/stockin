/**
 * Excel 导入/导出规则层（零 IO：只接收已解析的单元格文本，不做文件读写）。
 *
 * 依据：设计文档 v1.1 §2.4 BR-11、§5.2 导入校验链、§10.1 裁决 13/18、
 * §4.3「保质期导出时合并为单列文本」、附录 B `B-7`（物理行号口径）。
 * 表头文案与列序唯一真源来自 shared 的 `EXCEL_HEADERS`；
 * 错误行报告一律使用 **Excel 物理行号**（模板第 1 行为表头）。
 */
import {
  EXCEL_HEADERS,
  EXCEL_HEADER_TEXTS,
  EXCEL_HEADER_ROW,
  EXCEL_FIRST_DATA_ROW,
  EXCEL_COLUMN_COUNT,
  excelPhysicalRow,
  excelColumnNumber,
  parseShelfLifeCell,
  IMPORT_MAX_ROWS,
  SCALE,
  AMOUNT_ROUNDING_TOLERANCE_CENTS,
  FieldSource,
  type ImportIssue,
  type ImportReport,
  type ExcelFieldKey,
  type RecordFields,
  type ParsedShelfLifeCell,
} from '@stockin/shared';
import {
  computeDateGroup,
  computeAmountGroup,
  type DateGroupValues,
  type DateGroupSourceMap,
  type AmountGroupValues,
  type AmountGroupSourceMap,
} from './groups';
import { normalizeForCompare } from './normalize';
import { isValidISODate, compareISODate } from './date';
import { parseFixed, fixedMul } from './fixed';
import type { Today } from './types';

export interface ParsedImportRow {
  row: number;
  record: RecordFields | null;
  issues: ImportIssue[];
}

export interface ImportParsedRow {
  row: number;
  record: RecordFields;
}

/** 构造 issue；可选列号与字段名留空表示整行级问题。 */
export function makeImportIssue(
  row: number,
  code: string,
  reason: string,
  column?: number,
  field?: string,
): ImportIssue {
  const issue: ImportIssue = { row, code, reason };
  if (column !== undefined) {
    issue.column = column;
  }
  if (field !== undefined) {
    issue.field = field;
  }
  return issue;
}

/** 表头一致性：列数与逐列文案必须与 EXCEL_HEADERS 完全一致。 */
export function checkExcelHeader(actual: readonly (string | null | undefined)[]): ImportIssue[] {
  const issues: ImportIssue[] = [];
  if (actual.length < EXCEL_COLUMN_COUNT) {
    issues.push(
      makeImportIssue(
        EXCEL_HEADER_ROW,
        'EXCEL_HEADER_MISMATCH',
        `表头列数不足：期望 ${EXCEL_COLUMN_COUNT} 列，实际 ${actual.length} 列`,
      ),
    );
  }
  for (let i = 0; i < EXCEL_HEADER_TEXTS.length; i += 1) {
    const expected: string = EXCEL_HEADER_TEXTS[i] ?? '';
    const got: string = String(actual[i] ?? '').trim();
    if (got !== expected) {
      issues.push(
        makeImportIssue(
          EXCEL_HEADER_ROW,
          'EXCEL_HEADER_MISMATCH',
          `第 ${i + 1} 列表头应为「${expected}」，实际为「${got}」`,
          i + 1,
          EXCEL_HEADERS[i]?.key,
        ),
      );
    }
  }
  return issues;
}

/** 行数上限（导入链的第 1 道规则）。 */
export function checkExcelRowLimit(rowCount: number): ImportIssue | null {
  if (rowCount > IMPORT_MAX_ROWS) {
    return makeImportIssue(
      EXCEL_FIRST_DATA_ROW + IMPORT_MAX_ROWS,
      'EXCEL_TOO_MANY_ROWS',
      `导入行数 ${rowCount} 超过上限 ${IMPORT_MAX_ROWS}`,
    );
  }
  return null;
}

function columnIndexOf(key: ExcelFieldKey): number {
  return excelColumnNumber(key) - 1;
}

/**
 * 逐行校验 + 空单元格补算。
 *
 * 空单元格补算严格复用 `computeDateGroup` / `computeAmountGroup` 同一份纯函数
 * （文档 §5.2「唯一例外是 Excel 导入时单元格确实为空的字段，复用 domain 同一份纯函数补算」）。
 * 单元格文本由 T03 的 exceljs 读取层归一化后传入，本层不处理 Date/number 对象。
 */
export function parseExcelRow(
  cells: readonly (string | null | undefined)[],
  physicalRow: number,
  today?: Today,
): ParsedImportRow {
  const issues: ImportIssue[] = [];
  const padded: string[] = [];
  for (let i = 0; i < EXCEL_COLUMN_COUNT; i += 1) {
    padded.push(String(cells[i] ?? ''));
  }

  // 禁公式：任一单元格以 '=' 开头即整行拒绝。
  for (let i = 0; i < padded.length; i += 1) {
    if ((padded[i] ?? '').trimStart().startsWith('=')) {
      issues.push(
        makeImportIssue(
          physicalRow,
          'EXCEL_FORMULA_FORBIDDEN',
          `第 ${i + 1} 列不允许包含公式`,
          i + 1,
          EXCEL_HEADERS[i]?.key,
        ),
      );
    }
  }
  if (issues.length > 0) {
    return { row: physicalRow, record: null, issues };
  }

  const text = (key: ExcelFieldKey): string => padded[columnIndexOf(key)] ?? '';
  const trimmed = (key: ExcelFieldKey): string => text(key).trim();

  const name: string = trimmed('name');
  if (name === '') {
    issues.push(
      makeImportIssue(
        physicalRow,
        'VALID_FAILED',
        '商品名称不能为空',
        excelColumnNumber('name'),
        'name',
      ),
    );
  }

  const purchaseDate: string = trimmed('purchaseDate');
  if (!isValidISODate(purchaseDate)) {
    issues.push(
      makeImportIssue(
        physicalRow,
        'VALID_FAILED',
        `进货日期必须为 YYYY-MM-DD：${purchaseDate}`,
        excelColumnNumber('purchaseDate'),
        'purchaseDate',
      ),
    );
  }

  const productionDate: string = trimmed('productionDate');
  if (productionDate !== '' && !isValidISODate(productionDate)) {
    issues.push(
      makeImportIssue(
        physicalRow,
        'VALID_FAILED',
        `生产日期必须为 YYYY-MM-DD：${productionDate}`,
        excelColumnNumber('productionDate'),
        'productionDate',
      ),
    );
  }

  const shelfLifeCell: string = trimmed('shelfLife');
  const shelf: ParsedShelfLifeCell | null = parseShelfLifeCell(shelfLifeCell);
  if (shelfLifeCell !== '' && shelf === null) {
    issues.push(
      makeImportIssue(
        physicalRow,
        'VALID_FAILED',
        `保质期必须为「数值 + 单位」，如 12个月：${shelfLifeCell}`,
        excelColumnNumber('shelfLife'),
        'shelfLife',
      ),
    );
  }

  const expiryDate: string = trimmed('expiryDate');
  if (expiryDate !== '' && !isValidISODate(expiryDate)) {
    issues.push(
      makeImportIssue(
        physicalRow,
        'VALID_FAILED',
        `到期日期必须为 YYYY-MM-DD：${expiryDate}`,
        excelColumnNumber('expiryDate'),
        'expiryDate',
      ),
    );
  }

  const spec: string | null = text('spec') === '' ? null : text('spec');
  const remark: string | null = text('remark') === '' ? null : text('remark');

  const unitPriceParsed: number | null = parseFixed(trimmed('unitPrice'), SCALE.UNIT_PRICE);
  if (trimmed('unitPrice') !== '' && unitPriceParsed === null) {
    issues.push(
      makeImportIssue(
        physicalRow,
        'VALID_FAILED',
        '单价不是合法数字',
        excelColumnNumber('unitPrice'),
        'unitPrice',
      ),
    );
  }
  const quantityParsed: number | null = parseFixed(trimmed('quantity'), SCALE.QUANTITY);
  if (trimmed('quantity') !== '' && quantityParsed === null) {
    issues.push(
      makeImportIssue(
        physicalRow,
        'VALID_FAILED',
        '数量不是合法数字',
        excelColumnNumber('quantity'),
        'quantity',
      ),
    );
  }
  const amountParsed: number | null = parseFixed(trimmed('amount'), SCALE.AMOUNT_CENTS);
  if (trimmed('amount') !== '' && amountParsed === null) {
    issues.push(
      makeImportIssue(
        physicalRow,
        'VALID_FAILED',
        '金额不是合法数字',
        excelColumnNumber('amount'),
        'amount',
      ),
    );
  }

  // 三个金额字段齐全时做一致性校验（允许 ≤1 分舍入容差，文档 §5.2）。
  if (unitPriceParsed !== null && quantityParsed !== null && amountParsed !== null) {
    const computed: number = fixedMul(
      unitPriceParsed,
      quantityParsed,
      SCALE.UNIT_PRICE,
      SCALE.QUANTITY,
      SCALE.AMOUNT_CENTS,
    );
    if (Math.abs(computed - amountParsed) > AMOUNT_ROUNDING_TOLERANCE_CENTS) {
      issues.push(
        makeImportIssue(
          physicalRow,
          'VALID_FAILED',
          `金额与「单价 × 数量」不一致：期望 ${computed} 分，实际 ${amountParsed} 分`,
          excelColumnNumber('amount'),
          'amount',
        ),
      );
    }
  }

  if (issues.length > 0) {
    return { row: physicalRow, record: null, issues };
  }

  // ---- 空单元格补算：复用 groups 的同一份纯函数 ----
  const dateValues: DateGroupValues = {
    productionDate: productionDate === '' ? null : productionDate,
    shelfLifeValue: shelf === null ? null : shelf.value,
    shelfLifeUnit: shelf === null ? null : shelf.unit,
    expiryDate: expiryDate === '' ? null : expiryDate,
  };
  const dateSources: DateGroupSourceMap = {
    productionDate: productionDate === '' ? FieldSource.EMPTY : FieldSource.MANUAL,
    shelfLife: shelf === null ? FieldSource.EMPTY : FieldSource.MANUAL,
    expiryDate: expiryDate === '' ? FieldSource.EMPTY : FieldSource.MANUAL,
  };
  const dateResult = computeDateGroup(dateValues, dateSources, today);

  const amountValues: AmountGroupValues = {
    unitPrice: { raw: text('unitPrice'), parsed: unitPriceParsed },
    quantity: { raw: text('quantity'), parsed: quantityParsed },
    amount: { raw: text('amount'), parsed: amountParsed },
  };
  const amountSources: AmountGroupSourceMap = {
    unitPrice: unitPriceParsed === null ? FieldSource.EMPTY : FieldSource.MANUAL,
    quantity: quantityParsed === null ? FieldSource.EMPTY : FieldSource.MANUAL,
    amount: amountParsed === null ? FieldSource.EMPTY : FieldSource.MANUAL,
  };
  const amountResult = computeAmountGroup(amountValues, amountSources);

  // 补算后仍做「到期日不得早于生产日期」校验。
  const finalProductionDate: string | null = dateResult.values.productionDate;
  const finalExpiryDate: string | null = dateResult.values.expiryDate;
  if (
    finalProductionDate !== null &&
    finalExpiryDate !== null &&
    isValidISODate(finalProductionDate) &&
    isValidISODate(finalExpiryDate) &&
    compareISODate(finalExpiryDate, finalProductionDate) < 0
  ) {
    issues.push(
      makeImportIssue(
        physicalRow,
        'VALID_FAILED',
        '到期日期不得早于生产日期',
        excelColumnNumber('expiryDate'),
        'expiryDate',
      ),
    );
    return { row: physicalRow, record: null, issues };
  }

  const record: RecordFields = {
    name,
    purchaseDate,
    productionDate: finalProductionDate,
    shelfLifeValue: dateResult.values.shelfLifeValue,
    shelfLifeUnit: dateResult.values.shelfLifeUnit,
    expiryDate: finalExpiryDate,
    spec,
    unitPrice: amountResult.values.unitPrice.parsed ?? 0,
    quantity: amountResult.values.quantity.parsed ?? 0,
    amountCents: amountResult.values.amount.parsed ?? 0,
    remark,
  };
  return { row: physicalRow, record, issues };
}

/**
 * 文件内自比八项判重。命中即报告（整批拦截由 T03 事务层执行）。
 * 备注与保质期不参与比较，由 normalizeForCompare 保证。
 */
export function findImportDuplicates(rows: readonly ImportParsedRow[]): ImportIssue[] {
  const issues: ImportIssue[] = [];
  const seen = new Map<string, number>();
  for (const item of rows) {
    const key: string = normalizeForCompare(item.record);
    const firstRow: number | undefined = seen.get(key);
    if (firstRow !== undefined) {
      issues.push(
        makeImportIssue(
          item.row,
          'EXCEL_DUPLICATE',
          `与第 ${firstRow} 行八项判重重复（备注与保质期不参与）`,
        ),
      );
    } else {
      seen.set(key, item.row);
    }
  }
  return issues;
}

/** 汇总报告。 */
export function buildImportReport(
  totalRows: number,
  acceptedRows: number,
  issues: readonly ImportIssue[],
): ImportReport {
  return {
    totalRows,
    acceptedRows,
    rejectedRows: totalRows - acceptedRows,
    issues: [...issues],
  };
}

/** 规则面聚合对象，供服务端与前端共用同一份实现。 */
export const excelRules = {
  headers: EXCEL_HEADERS,
  headerRow: EXCEL_HEADER_ROW,
  firstDataRow: EXCEL_FIRST_DATA_ROW,
  columnCount: EXCEL_COLUMN_COUNT,
  maxRows: IMPORT_MAX_ROWS,
  physicalRow: excelPhysicalRow,
  columnNumber: excelColumnNumber,
  makeIssue: makeImportIssue,
  checkHeader: checkExcelHeader,
  checkRowLimit: checkExcelRowLimit,
  parseRow: parseExcelRow,
  findDuplicates: findImportDuplicates,
  buildReport: buildImportReport,
} as const;
