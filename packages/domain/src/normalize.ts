/**
 * 归一化与八项判重键。
 *
 * 依据：设计文档 v1.1 §2.4 BR-6「八项全等 = 商品名 + 进货日期 + 生产日期 +
 * 到期日期 + 规格 + 单价 + 数量 + 金额；备注与保质期不参与；归一化后比较」、
 * §4.3「另写归一化列 name_norm/spec_norm 用于判重与种类数去重」、
 * §10.1 裁决 5/9/15。回收站排除由 T03 Repository 的 `deleted_at IS NULL` 保证。
 */

/** 文本归一化：NFKC（全角→半角）+ 折叠全部空白 + 小写。 */
export function normalizeText(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return '';
  }
  return value.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

/** 商品名归一化列 name_norm。 */
export function normalizeName(name: string | null | undefined): string {
  return normalizeText(name);
}

/** 规格归一化列 spec_norm。 */
export function normalizeSpec(spec: string | null | undefined): string {
  return normalizeText(spec);
}

/** 一次产出两个归一化列。 */
export function recordNorms(record: { name: string; spec: string | null | undefined }): {
  nameNorm: string;
  specNorm: string;
} {
  return {
    nameNorm: normalizeName(record.name),
    specNorm: normalizeSpec(record.spec),
  };
}

/** 判重输入：八项必填/可空字段；备注与保质期刻意声明为可选且不参与比较。 */
export interface DedupRecord {
  name: string;
  purchaseDate: string;
  productionDate: string | null;
  expiryDate: string | null;
  spec: string | null;
  /** 单价，×1e4 整数 */
  unitPrice: number;
  /** 数量，×1e3 整数 */
  quantity: number;
  /** 金额，分整数 */
  amountCents: number;
  /** 以下字段存在但不参与判重，仅为承载完整记录提供便利。 */
  remark?: string | null;
  shelfLifeValue?: number | null;
  shelfLifeUnit?: string | null;
  deletedAt?: string | null;
}

const SEPARATOR = '\u001f';
const NULL_MARKER = '\u001e';

function part(value: string | null | undefined): string {
  return value === null || value === undefined ? NULL_MARKER : value;
}

/**
 * 生成八项判重键。归一化后比较；备注与保质期**绝不**进入键。
 * 定点整数用十进制字符串拼接，天然归一化、无浮点误差。
 */
export function normalizeForCompare(record: DedupRecord): string {
  return [
    normalizeName(record.name),
    part(record.purchaseDate),
    part(record.productionDate),
    part(record.expiryDate),
    normalizeSpec(record.spec),
    String(record.unitPrice),
    String(record.quantity),
    String(record.amountCents),
  ].join(SEPARATOR);
}
