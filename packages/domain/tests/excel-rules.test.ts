import { describe, expect, it } from 'vitest';
import {
  EXCEL_COLUMN_COUNT,
  EXCEL_HEADER_TEXTS,
  IMPORT_MAX_ROWS,
  type RecordFields,
} from '@stockin/shared';
import {
  buildImportReport,
  checkExcelHeader,
  checkExcelRowLimit,
  findImportDuplicates,
  parseExcelRow,
  type ImportParsedRow,
} from '../src/excel-rules';

/** 一行合法数据：列序与 EXCEL_HEADERS 一致（10 列）。 */
function row(overrides: Partial<Record<number, string>> = {}): string[] {
  const base: string[] = [
    '纯牛奶', // 1 商品名称
    '2024-01-10', // 2 进货日期
    '2024-01-01', // 3 生产日期
    '12个月', // 4 保质期
    '', // 5 到期日期（留空待补算）
    '500ml', // 6 规格
    '3.3333', // 7 单价
    '3', // 8 数量
    '', // 9 金额（留空待补算）
    '', // 10 备注
  ];
  for (const [index, value] of Object.entries(overrides)) {
    base[Number(index)] = value;
  }
  return base;
}

function record(overrides: Partial<RecordFields> = {}): RecordFields {
  return {
    name: '纯牛奶',
    purchaseDate: '2024-01-10',
    productionDate: '2024-01-01',
    shelfLifeValue: 12,
    shelfLifeUnit: 'month',
    expiryDate: '2025-01-01',
    spec: '500ml',
    unitPrice: 33333,
    quantity: 3000,
    amountCents: 1000,
    remark: null,
    ...overrides,
  };
}

describe('checkExcelHeader 表头一致性', () => {
  it('与 EXCEL_HEADERS 完全一致时无 issue', () => {
    expect(checkExcelHeader(EXCEL_HEADER_TEXTS)).toEqual([]);
  });

  it('列数不足时报告表头错误', () => {
    const issues = checkExcelHeader(['商品名称']);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((issue) => issue.code === 'EXCEL_HEADER_MISMATCH')).toBe(true);
    expect(issues[0]?.row).toBe(1);
  });

  it('单列文案不符时定位到该列', () => {
    const headers: string[] = [...EXCEL_HEADER_TEXTS];
    headers[3] = '保质天数';
    const issues = checkExcelHeader(headers);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.column).toBe(4);
    expect(issues[0]?.field).toBe('shelfLife');
  });

  it('容错首尾空白', () => {
    const headers: string[] = EXCEL_HEADER_TEXTS.map((text: string) => ` ${text} `);
    expect(checkExcelHeader(headers)).toEqual([]);
  });
});

describe('checkExcelRowLimit 行数上限', () => {
  it('等于上限通过，超一行即拒绝', () => {
    expect(checkExcelRowLimit(IMPORT_MAX_ROWS)).toBeNull();
    expect(checkExcelRowLimit(IMPORT_MAX_ROWS + 1)?.code).toBe('EXCEL_TOO_MANY_ROWS');
  });
});

describe('parseExcelRow 逐行校验与空单元格补算', () => {
  it('到期日与金额留空时按同一份 domain 纯函数补算', () => {
    const result = parseExcelRow(row(), 2);
    expect(result.issues).toEqual([]);
    expect(result.record).not.toBeNull();
    expect(result.record?.expiryDate).toBe('2025-01-01');
    expect(result.record?.shelfLifeValue).toBe(12);
    expect(result.record?.shelfLifeUnit).toBe('month');
    // 3.3333 × 3 = 9.9999 → 10.00 → 1000 分
    expect(result.record?.amountCents).toBe(1000);
  });

  it('以 = 开头的单元格视为公式，整行拒绝', () => {
    const result = parseExcelRow(row({ 8: '=B2*C2' }), 2);
    expect(result.record).toBeNull();
    expect(result.issues.some((issue) => issue.code === 'EXCEL_FORMULA_FORBIDDEN')).toBe(true);
  });

  it('商品名称为空、进货日期非法都报 VALID_FAILED', () => {
    const result = parseExcelRow(row({ 0: '', 1: '2024/01/10' }), 2);
    expect(result.record).toBeNull();
    const fields: (string | undefined)[] = result.issues.map((issue) => issue.field);
    expect(fields).toContain('name');
    expect(fields).toContain('purchaseDate');
  });

  it('金额与「单价 × 数量」超出 1 分容差即拒绝', () => {
    const ok = parseExcelRow(row({ 8: '10.00' }), 2);
    expect(ok.issues).toEqual([]);

    const bad = parseExcelRow(row({ 8: '12.00' }), 2);
    expect(bad.record).toBeNull();
    expect(bad.issues.some((issue) => issue.code === 'VALID_FAILED')).toBe(true);
  });

  /**
   * 现状记录（**待确认的业务行为，不在本卡修改实现**）：
   * 生产日期晚于到期日时，`computeDateGroup` 按「冲突则清空非用户锚点」的规则
   * 把生产日期清成 null，而导入链的关系校验发生在补算之后、读的是已被清空的值，
   * 因此该行会被**接受**且生产日期丢失，不产生 issue。
   *
   * 若产品要求「冲突必须报错拒绝该行」，需要改 `parseExcelRow`（校验前置于补算），
   * 属业务实现变更，须单独确认后执行。
   */
  it('生产日期晚于到期日：当前行为是清空生产日期后接受该行', () => {
    const result = parseExcelRow(row({ 2: '2024-06-01', 4: '2024-01-01', 3: '' }), 2);
    expect(result.record).not.toBeNull();
    expect(result.record?.productionDate).toBeNull();
    expect(result.record?.expiryDate).toBe('2024-01-01');
  });

  it('保质期格式非法（缺单位数值）即拒绝', () => {
    const result = parseExcelRow(row({ 3: '十二个月' }), 2);
    expect(result.record).toBeNull();
    expect(result.issues.some((issue) => issue.field === 'shelfLife')).toBe(true);
  });

  it('issue 记录 Excel 物理行号', () => {
    const result = parseExcelRow(row({ 0: '' }), 17);
    expect(result.row).toBe(17);
    expect(result.issues.every((issue) => issue.row === 17)).toBe(true);
  });
});

describe('findImportDuplicates 八项判重', () => {
  it('八项相同即判重，备注与保质期不参与', () => {
    const rows: ImportParsedRow[] = [
      { row: 2, record: record({ remark: '第一批' }) },
      { row: 3, record: record({ remark: '第二批' }) },
    ];
    const issues = findImportDuplicates(rows);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.row).toBe(3);
    expect(issues[0]?.reason).toContain('第 2 行');
  });

  it('规格不同不算重复', () => {
    const rows: ImportParsedRow[] = [
      { row: 2, record: record() },
      { row: 3, record: record({ spec: '1L' }) },
    ];
    expect(findImportDuplicates(rows)).toEqual([]);
  });

  it('名称与规格做 NFKC + 去空白 + 小写归一化后比较', () => {
    const rows: ImportParsedRow[] = [
      { row: 2, record: record({ name: 'Pure Milk', spec: '500 ML' }) },
      { row: 3, record: record({ name: 'puremilk', spec: '500ml' }) },
    ];
    expect(findImportDuplicates(rows)).toHaveLength(1);
  });

  it('金额或数量不同不算重复', () => {
    const rows: ImportParsedRow[] = [
      { row: 2, record: record() },
      { row: 3, record: record({ quantity: 4000 }) },
    ];
    expect(findImportDuplicates(rows)).toEqual([]);
  });
});

describe('buildImportReport 汇总', () => {
  it('拒绝行数 = 总行数 − 接受行数', () => {
    const report = buildImportReport(10, 7, []);
    expect(report.rejectedRows).toBe(3);
    expect(report.acceptedRows).toBe(7);
    expect(report.totalRows).toBe(10);
  });
});

describe('列常量自洽', () => {
  it('表头数量与列定义一致', () => {
    expect(EXCEL_HEADER_TEXTS).toHaveLength(EXCEL_COLUMN_COUNT);
  });
});
