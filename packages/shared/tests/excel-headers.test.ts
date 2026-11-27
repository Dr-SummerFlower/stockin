import { describe, expect, it } from 'vitest';
import {
  DB_SRC_AUTO,
  DB_SRC_USER,
  decodeFieldSource,
  encodeFieldSource,
  EXCEL_COLUMN_COUNT,
  EXCEL_HEADER_ROW,
  EXCEL_HEADER_TEXTS,
  EXCEL_HEADERS,
  EXCEL_REQUIRED_COLUMN_COUNT,
  FieldSource,
  excelColumnNumber,
  excelPhysicalRow,
  formatShelfLifeCell,
  parseShelfLifeCell,
  ShelfLifeUnit,
  SHELF_LIFE_UNIT_BY_LABEL,
  SHELF_LIFE_UNIT_LABELS,
} from '../src/index';

/**
 * `EXCEL_HEADERS` 是列序与表头文案的单一真源（设计文档 §2.4 BR-11、§10.1 裁决 18）：
 * 导入校验、模板下载、导出三处都读它，改动必须同步。
 */
describe('EXCEL_HEADERS 单一真源', () => {
  it('固定 11 列（10 业务列 + 可选的单据编号尾列）且文案与顺序锁定', () => {
    expect(EXCEL_COLUMN_COUNT).toBe(11);
    // 必填列仍是 10：升级前导出的 10 列文件必须继续可导入。
    expect(EXCEL_REQUIRED_COLUMN_COUNT).toBe(10);
    expect(EXCEL_HEADER_TEXTS).toEqual([
      '商品名称',
      '进货日期',
      '生产日期',
      '保质期',
      '到期日期',
      '规格',
      '单价',
      '数量',
      '金额',
      '备注',
      '单据编号',
    ]);
  });

  it('单据编号是可选的尾列，缺失不影响其余列序', () => {
    const last = EXCEL_HEADERS[EXCEL_HEADERS.length - 1];
    expect(last?.key).toBe('orderNo');
    expect(last?.optional).toBe(true);
    expect(last?.column).toBe(11);
  });

  it('列号连续且与数组顺序一致', () => {
    EXCEL_HEADERS.forEach((def, index) => {
      expect(def.column).toBe(index + 1);
      expect(excelColumnNumber(def.key)).toBe(index + 1);
    });
  });

  it('物理行号 = 数据下标 + 2（表头占第 1 行）', () => {
    expect(EXCEL_HEADER_ROW).toBe(1);
    expect(excelPhysicalRow(0)).toBe(2);
    expect(excelPhysicalRow(9)).toBe(11);
  });
});

describe('parseShelfLifeCell / formatShelfLifeCell 闭环', () => {
  it('解析「数值 + 中文单位」', () => {
    expect(parseShelfLifeCell('12个月')).toEqual({ value: 12, unit: ShelfLifeUnit.MONTH });
    expect(parseShelfLifeCell('30天')).toEqual({ value: 30, unit: ShelfLifeUnit.DAY });
    expect(parseShelfLifeCell('2年')).toEqual({ value: 2, unit: ShelfLifeUnit.YEAR });
  });

  it('缺少单位时按天解释', () => {
    expect(parseShelfLifeCell('90')).toEqual({ value: 90, unit: ShelfLifeUnit.DAY });
  });

  it('未知单位与非法文本返回 null', () => {
    for (const cell of ['12周', 'abc', '', '12.5个月', '-3天']) {
      expect(parseShelfLifeCell(cell)).toBeNull();
    }
    expect(parseShelfLifeCell(null)).toBeNull();
  });

  it('格式化结果可被自身解析回来（导出→导入闭环）', () => {
    for (const unit of [ShelfLifeUnit.DAY, ShelfLifeUnit.MONTH, ShelfLifeUnit.YEAR]) {
      const text: string = formatShelfLifeCell(18, unit);
      expect(parseShelfLifeCell(text)).toEqual({ value: 18, unit });
    }
  });

  it('中文标签与反查表双向闭环', () => {
    for (const unit of [ShelfLifeUnit.DAY, ShelfLifeUnit.MONTH, ShelfLifeUnit.YEAR]) {
      const label: string = SHELF_LIFE_UNIT_LABELS[unit];
      expect(SHELF_LIFE_UNIT_BY_LABEL[label]).toBe(unit);
    }
  });
});

describe('来源位编解码', () => {
  it('值非空时 1=AUTO、0=MANUAL；值空恒为 EMPTY', () => {
    expect(decodeFieldSource(false, DB_SRC_AUTO)).toBe(FieldSource.AUTO);
    expect(decodeFieldSource(false, DB_SRC_USER)).toBe(FieldSource.MANUAL);
    expect(decodeFieldSource(true, DB_SRC_AUTO)).toBe(FieldSource.EMPTY);
    expect(decodeFieldSource(true, DB_SRC_USER)).toBe(FieldSource.EMPTY);
  });

  it('编码后能原样解码回来', () => {
    for (const source of [FieldSource.AUTO, FieldSource.MANUAL] as const) {
      expect(decodeFieldSource(false, encodeFieldSource(source))).toBe(source);
    }
    // EMPTY 不单独编码，落 USER 位（值列为空由调用方保证）
    expect(encodeFieldSource(FieldSource.EMPTY)).toBe(DB_SRC_USER);
  });
});
