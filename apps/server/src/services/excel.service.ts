/**
 * Excel 服务：模板 / 导入 / 导出。
 *
 * 依据：设计文档 v1.1 §2.4 BR-11 / §3.5 / §4.3 / §5.2 / §10.1 裁决 13、18 /
 * §10.2 裁决 30 —— 上传校验链（信号量 → 2MB → 临时文件 → 魔数/容器 →
 * 解压≤20MB / sheet / 单元格 / ≤1000 行 → 禁公式 → 表头比对 → 15s deadline →
 * 导入前备份）；逐行 Zod + domain 补算；文件内 Map 自比 + 库内批量判重；
 * **有 issue 不开写事务直接 422**；全通过才 `BEGIN IMMEDIATE` 整批单事务
 * + 1 条汇总日志 + COMMIT；导出走 StreamingWorkbookWriter 逐行 commit +
 * Repository 的 keyset 分页（`iteratePages`，内存水位与总行数无关）+ 写入 Hono
 * `stream()`（带第三参数错误处理器）；Workers 的 buffer 路径另设行数上限。
 * 错误行号一律 Excel 物理行号。exceljs 仅本服务使用。
 */
import { Writable } from 'node:stream';
import * as ExcelJS from 'exceljs';
import { stream } from 'hono/streaming';
import type { Context } from 'hono';
import {
  Action,
  ErrorCode,
  EMPTY_RECORD_SOURCES,
  EXCEL_COLUMN_COUNT,
  EXCEL_FIRST_DATA_ROW,
  EXCEL_HEADERS,
  EXCEL_HEADER_TEXTS,
  IMPORT_DEADLINE_MS,
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_ROWS,
  IMPORT_MAX_UNCOMPRESSED_BYTES,
  SCALE,
  SECURITY_HEADERS,
  TARGET_TYPE,
  excelImportMetaSchema,
  importRowSchema,
  formatShelfLifeCell,
  excelPhysicalRow,
  ORDER_EXPORT_HEADER_TEXTS,
  ORDER_EXPORT_HEADERS,
  type OrderDetailView,
  type RecordView,
  type ImportIssue,
  type ImportReport,
  MAX_PAGE_SIZE,
  type OrderFilter,
  type RecordFilter,
  type RecordSources,
} from '@stockin/shared';
import {
  buildImportReport,
  checkExcelHeader,
  checkExcelRowLimit,
  findImportDuplicates,
  makeImportIssue,
  parseExcelRow,
  type ImportParsedRow,
} from '@stockin/domain';
import type { Db } from '../repositories/db';
import { immediateTransaction } from '../repositories/db';
import type { RecordRepository } from '../repositories/record.repository';
import type { OrderRepository } from '../repositories/order.repository';
import type { OperationLogRepository } from '../repositories/operation-log.repository';
import type { SettingsRepository } from '../repositories/settings.repository';
import { toRecordFields, toRecordView, type WriteContext } from '../repositories/types';
import type { Env } from '../env';
import { formatServerDateTime, serverToday, utcNowIso } from '../lib/today';
import { logger } from '../lib/logger';
import { errorResponse } from '../lib/response';
import type { HeavyTaskGate } from './heavy-task';
import type { BackupService } from './backup.service';
import type { WorkbookReader } from '../runtime/ports';
import type { ExcelWriteKind } from '../runtime/platform';
import type { ServiceResult } from '../app';

export interface ExcelServiceDeps {
  readonly db: Db;
  readonly env: Env;
  readonly records: RecordRepository;
  /** 单据汇总导出用（只读，不参与导入）。 */
  readonly orders: OrderRepository;
  readonly logs: OperationLogRepository;
  readonly settings: SettingsRepository;
  readonly gate: HeavyTaskGate;
  readonly backup: BackupService;
  /**
   * 上传字节 → 工作簿。Node 落 tmp 卷再 readFile（保留既有排障习惯），
   * Workers 走内存 `load(buffer)`（无持久盘）。
   */
  readonly readWorkbook: WorkbookReader;
  /**
   * 写出方式（平台开关，见 `runtime/platform.ts` 的 `ExcelWriteKind`）。
   * `stream` = 逐行流式管进响应；`buffer` = 整份生成后一次返回。
   */
  readonly excelWrite: ExcelWriteKind;
  /**
   * 单次导出的行数上限（`buffer` 写出方式必须有；`stream` 可不设）。
   *
   * Workers 的 buffer 路径把整份工作簿建在 128MB isolate 里，实测 5k 行峰值
   * 堆约 60MB、10k 行约 72MB 且 RSS 更高，再往上必然 OOM。超限直接 413 并
   * 提示缩小日期范围，不用 OOM 兜底（OOM 只会留下一个 1101）。
   */
  readonly exportMaxRows?: number;
}

export interface ExcelContext {
  readonly requestId: string;
  readonly actor: string;
}

const ZIP_LOCAL_MAGIC = 0x04034b50;
const ZIP_CENTRAL_MAGIC = 0x02014b50;
const ZIP_EOCD_MAGIC = 0x06054b50;
const MAX_CELLS = (IMPORT_MAX_ROWS + 1) * EXCEL_COLUMN_COUNT * 2;

/* -------------------------------------------------------------------------- */
/* 导出样式（表格专家交付版，2026-11-28）                                       */
/* -------------------------------------------------------------------------- */
/* 只改样式层：表头深蓝白字、数据斑马纹与边框、冻结首行、自动筛选、列级数字格式。 */
/* 值层、列序、表头文案均不变；样式不在导入校验范围内，美化后的文件仍可导入。   */
/* 两个坑：① 流式 writer 的行一经 commit 便不可再改样式，故按行应用；
 * ② WorkbookWriter 默认 useStyles=false（内部用 StylesXform.Mock 丢弃全部样式），
 *    三处流式出口都必须显式 useStyles:true，否则只有行高生效、单元格样式全丢。 */

const XL_HEADER_BG = 'FF1F4E79';
const XL_STRIPE_BG = 'FFF2F6FC';
const XL_BORDER_COLOR = 'FFD9E2EC';
const XL_FONT_NAME = '微软雅黑';
const XL_TEXT_COLOR = 'FF1F2937';

const XL_CENTER_KINDS: ReadonlySet<string> = new Set(['date', 'datetime', 'shelfLife']);
const XL_RIGHT_KINDS: ReadonlySet<string> = new Set(['integer', 'quantity', 'decimal', 'money']);

/**
 * 冻结首行。流式 WorksheetWriter 的 `views` 只有 getter，必须在 addWorksheet
 * 的选项里传入；普通 Worksheet 则在 finishSheet 里赋值。两条路都要配。
 */
const XL_FROZEN_VIEW = { state: 'frozen' as const, ySplit: 1, activeCell: 'A2' };

/** 明细表列语义，从表头单一真源派生，不在此另写一份。 */
const DETAIL_COLUMN_KINDS: readonly string[] = EXCEL_HEADERS.map((def) => def.kind);
/** 进货单汇总列语义，同样从真源派生。 */
const ORDER_COLUMN_KINDS: readonly string[] = ORDER_EXPORT_HEADERS.map((def) => def.kind);

function thinBorder(): { top: object; bottom: object; left: object; right: object } {
  const thin = { style: 'thin' as const, color: { argb: XL_BORDER_COLOR } };
  return { top: thin, bottom: thin, left: thin, right: thin };
}

/** 表头：深蓝底白字加粗、行高 30、居中换行、细边框。 */
function styleHeaderRow(sheet: ExcelJS.Worksheet, lastCol: number): void {
  const header = sheet.getRow(1);
  header.height = 30;
  const border = thinBorder();
  for (let c = 1; c <= lastCol; c += 1) {
    const cell = header.getCell(c);
    cell.font = { name: XL_FONT_NAME, size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_HEADER_BG } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = border;
  }
}

/**
 * 数据行：浅蓝斑马纹、细边框、行高 22；对齐按列语义（文本左 / 日期居中 / 数值右）。
 * rowNumber 是 Excel 物理行号（表头占第 1 行）。
 */
function styleDataRow(
  sheet: ExcelJS.Worksheet,
  rowNumber: number,
  lastCol: number,
  kinds: readonly string[],
): void {
  const row = sheet.getRow(rowNumber);
  row.height = 22;
  const border = thinBorder();
  for (let c = 1; c <= lastCol; c += 1) {
    const cell = row.getCell(c);
    const kind = kinds[c - 1] ?? '';
    const horizontal: 'left' | 'center' | 'right' = XL_CENTER_KINDS.has(kind)
      ? 'center'
      : XL_RIGHT_KINDS.has(kind)
        ? 'right'
        : 'left';
    cell.font = { name: XL_FONT_NAME, size: 10, color: { argb: XL_TEXT_COLOR } };
    if (rowNumber % 2 === 0) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_STRIPE_BG } };
    }
    cell.alignment = { vertical: 'middle', horizontal, wrapText: horizontal === 'left' };
    cell.border = border;
  }
}

/**
 * 工作表级样式：自动筛选与打印页眉。列级 numFmt 由调用方设置。
 * 冻结首行在创建工作表时通过 views 选项传入（流式 WorksheetWriter 的
 * views 只有 getter，此处再赋值会抛 TypeError 并让整个导出返回空体）。
 */
function finishSheet(
  sheet: ExcelJS.Worksheet,
  lastRow: number,
  lastCol: number,
  title: string,
): void {
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, lastRow), column: lastCol },
  };
  sheet.headerFooter.oddHeader = `&C${title}`;
}

/** 明细表三列数字格式：单价 4 位、数量 3 位、金额 2 位，与 SCALE 一致。 */
function applyDetailNumFmt(sheet: ExcelJS.Worksheet): void {
  sheet.getColumn(7).numFmt = '0.0000';
  sheet.getColumn(8).numFmt = '0.000';
  sheet.getColumn(9).numFmt = '0.00';
}

/* -------------------------------------------------------------------------- */
/* 单张进货单打印版（销货清单样式，A4 横向分页）                                */
/* -------------------------------------------------------------------------- */

/**
 * 每页明细区硬上限 10 行。行高预算：固定区 256pt + 明细 10×24pt +
 * 末页整单总计 24pt = 520pt < A4 横向可用 537pt，留 ~17pt 余量防止截断。
 * 调整本值前必须重算整页行高。
 */
const ORDER_PRINT_MAX_DETAIL_ROWS = 10;

const ORDER_PRINT_COLOR = {
  totalBg: 'FFE8F0F9',
  grandBg: 'FFFDF3E0',
  border: 'FF6B7280',
};

/** 打印明细区表头：文案取自 EXCEL_HEADERS 真源，只有「序号」是版式专有。 */
const ORDER_PRINT_DETAIL_HEADERS: readonly string[] = [
  '序号',
  EXCEL_HEADERS[0]?.header ?? '', // 商品名称
  EXCEL_HEADERS[5]?.header ?? '', // 规格
  EXCEL_HEADERS[2]?.header ?? '', // 生产日期
  EXCEL_HEADERS[3]?.header ?? '', // 保质期
  EXCEL_HEADERS[4]?.header ?? '', // 到期日期
  EXCEL_HEADERS[6]?.header ?? '', // 单价
  EXCEL_HEADERS[7]?.header ?? '', // 数量
  EXCEL_HEADERS[8]?.header ?? '', // 金额
  EXCEL_HEADERS[9]?.header ?? '', // 备注
];
const ORDER_PRINT_WIDTHS: readonly number[] = [6, 25, 16, 13, 10, 13, 11, 11, 12, 14];

interface PrintCellStyle {
  readonly size?: number;
  readonly bold?: boolean;
  readonly align?: 'left' | 'center' | 'right';
  readonly color?: string;
  readonly bg?: string;
  readonly wrap?: boolean;
  readonly border?: boolean;
  readonly numFmt?: string;
}

interface OrderPrintMeta {
  readonly orderNo: string;
  readonly supplier: string;
  readonly purchaseDate: string;
  readonly remark: string;
}

/** 金额转中文大写（逐位算法，posUnits 已含万/亿锚点，避免跨节误补「零」）。 */
function toChineseAmount(amountYuan: number): string {
  if (!Number.isFinite(amountYuan)) {
    throw new Error('金额不是有限数字');
  }
  const negative: boolean = amountYuan < 0;
  const cents: number = Math.round(Math.abs(amountYuan) * 100);
  const yuan: number = Math.floor(cents / 100);
  const jiao: number = Math.floor((cents % 100) / 10);
  const fen: number = cents % 10;
  const digits = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];
  const posUnits = ['', '拾', '佰', '仟', '万', '拾', '佰', '仟', '亿', '拾', '佰', '仟'];
  const intPart = (n: number): string => {
    if (n === 0) return '';
    const text = String(n);
    let result = '';
    let zeroPending = false;
    for (let i = 0; i < text.length; i += 1) {
      const digit = Number(text[i]);
      const pos = text.length - i - 1;
      if (digit === 0) {
        if (result !== '') zeroPending = true;
      } else {
        if (zeroPending) {
          result += '零';
          zeroPending = false;
        }
        result += (digits[digit] ?? '') + (posUnits[pos] ?? '');
      }
    }
    return result;
  };
  if (yuan === 0 && jiao === 0 && fen === 0) return '零元整';
  let text = `${intPart(yuan)}元`;
  if (jiao === 0 && fen === 0) {
    text += '整';
  } else {
    if (jiao > 0) text += `${digits[jiao]}角`;
    else if (fen > 0) text += '零';
    if (fen > 0) text += `${digits[fen]}分`;
  }
  return `${negative ? '负' : ''}${text}`;
}

function stylePrintCell(cell: ExcelJS.Cell, opts: PrintCellStyle): void {
  cell.font = {
    name: XL_FONT_NAME,
    size: opts.size ?? 10,
    bold: opts.bold === true,
    color: { argb: opts.color ?? XL_TEXT_COLOR },
  };
  if (opts.bg !== undefined) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.bg } };
  }
  cell.alignment = {
    vertical: 'middle',
    horizontal: opts.align ?? 'left',
    wrapText: opts.wrap === true,
  };
  if (opts.border !== false) {
    const thin = { style: 'thin' as const, color: { argb: ORDER_PRINT_COLOR.border } };
    cell.border = { top: thin, bottom: thin, left: thin, right: thin };
  }
  if (opts.numFmt !== undefined) cell.numFmt = opts.numFmt;
}

function putMerged(
  ws: ExcelJS.Worksheet,
  rowStart: number,
  colStart: number,
  rowEnd: number,
  colEnd: number,
  value: string | number,
  opts: PrintCellStyle,
): void {
  ws.mergeCells(rowStart, colStart, rowEnd, colEnd);
  for (let r = rowStart; r <= rowEnd; r += 1) {
    for (let c = colStart; c <= colEnd; c += 1) {
      stylePrintCell(ws.getRow(r).getCell(c), opts);
    }
  }
  ws.getRow(rowStart).getCell(colStart).value = value;
}

/** 明细行：序号跨页连续，金额与数量统一从定点整数换算。 */
function toPrintRows(items: readonly RecordView[]): readonly (readonly (string | number)[])[] {
  return items.map((item, index) => [
    String(index + 1).padStart(2, '0'),
    item.name,
    item.spec ?? '',
    item.productionDate ?? '',
    formatShelfLifeCell(item.shelfLifeValue, item.shelfLifeUnit),
    item.expiryDate ?? '',
    item.unitPrice / SCALE.UNIT_PRICE,
    item.quantity / SCALE.QUANTITY,
    item.amountCents / SCALE.AMOUNT_CENTS,
    item.remark ?? '',
  ]);
}

function sumPrintAmountCents(items: readonly RecordView[]): number {
  return items.reduce((total, item) => total + item.amountCents, 0);
}

function sumPrintQuantity(items: readonly RecordView[]): number {
  return items.reduce((total, item) => total + item.quantity, 0) / SCALE.QUANTITY;
}

/** 写一页完整单据；每页都可单独打印（抬头、合计、备注、签字栏齐全）。 */
function writeOrderPrintPage(
  workbook: ExcelJS.Workbook,
  pageItems: readonly RecordView[],
  pageIndex: number,
  pageCount: number,
  allItems: readonly RecordView[],
  meta: OrderPrintMeta,
): void {
  const ws = workbook.addWorksheet(`进货单-第${pageIndex + 1}页`);
  ORDER_PRINT_WIDTHS.forEach((width, index) => {
    ws.getColumn(index + 1).width = width;
  });

  // 标题：多页时带页码，sheet 名避免 Excel 禁止的「/」。
  const title = pageCount === 1 ? '进 货 单' : `进 货 单　第 ${pageIndex + 1} / ${pageCount} 页`;
  ws.getRow(1).height = 40;
  putMerged(ws, 1, 1, 1, 10, title, {
    size: 18,
    bold: true,
    align: 'center',
    color: 'FFFFFFFF',
    bg: XL_HEADER_BG,
  });

  // 抬头（两行，标签右对齐 + 值左对齐）。
  ws.getRow(2).height = 26;
  putMerged(ws, 2, 1, 2, 2, '单据编号：', { bold: true, align: 'right' });
  putMerged(ws, 2, 3, 2, 5, meta.orderNo, { align: 'left' });
  putMerged(ws, 2, 6, 2, 7, '供货商：', { bold: true, align: 'right' });
  putMerged(ws, 2, 8, 2, 10, meta.supplier, { align: 'left' });
  ws.getRow(3).height = 26;
  putMerged(ws, 3, 1, 3, 2, '进货日期：', { bold: true, align: 'right' });
  putMerged(ws, 3, 3, 3, 5, meta.purchaseDate, { align: 'left' });
  putMerged(ws, 3, 6, 3, 7, '备    注：', { bold: true, align: 'right' });
  putMerged(ws, 3, 8, 3, 10, meta.remark, { align: 'left', wrap: true });
  ws.getRow(4).height = 8;

  // 明细表头。
  const headerRow = 5;
  ws.getRow(headerRow).height = 30;
  ORDER_PRINT_DETAIL_HEADERS.forEach((header, index) => {
    const cell = ws.getRow(headerRow).getCell(index + 1);
    cell.value = header;
    stylePrintCell(cell, {
      bold: true,
      align: 'center',
      color: 'FFFFFFFF',
      bg: XL_HEADER_BG,
    });
  });

  // 明细区恒为 10 行：有数据写数据，不足补带边框空白行，保持每页高度一致。
  const dataStart = headerRow + 1;
  const rows = toPrintRows(pageItems);
  for (let i = 0; i < ORDER_PRINT_MAX_DETAIL_ROWS; i += 1) {
    const rowNumber = dataStart + i;
    ws.getRow(rowNumber).height = 24;
    const values = rows[i];
    for (let c = 1; c <= 10; c += 1) {
      const cell = ws.getRow(rowNumber).getCell(c);
      if (values !== undefined) cell.value = values[c - 1] ?? '';
      let align: 'left' | 'center' | 'right' = 'left';
      let numFmt: string | undefined;
      if (c === 1 || c === 4 || c === 5 || c === 6) align = 'center';
      if (c === 7) {
        align = 'right';
        numFmt = '0.0000';
      }
      if (c === 8) {
        align = 'right';
        numFmt = '0.000';
      }
      if (c === 9) {
        align = 'right';
        numFmt = '0.00';
      }
      stylePrintCell(cell, {
        align,
        numFmt,
        wrap: c === 2 || c === 10,
        bg: i % 2 === 1 ? XL_STRIPE_BG : undefined,
        bold: c === 9 && values !== undefined,
        color: c === 9 && values !== undefined ? XL_HEADER_BG : XL_TEXT_COLOR,
      });
    }
  }

  // 合计区：单页为整单合计；多页为本页小计，末页另加整单总计。
  const prefix = pageCount === 1 ? '' : '本页';
  const pageCountItems = pageItems.length;
  const pageCents = sumPrintAmountCents(pageItems);
  const pageQty = sumPrintQuantity(pageItems);
  const totalStart = dataStart + ORDER_PRINT_MAX_DETAIL_ROWS;
  ws.getRow(totalStart).height = 28;
  putMerged(
    ws,
    totalStart,
    1,
    totalStart,
    3,
    pageCount === 1 ? '金额合计（大写）：' : '本页小计（大写）：',
    { bold: true, align: 'right', bg: ORDER_PRINT_COLOR.totalBg },
  );
  putMerged(ws, totalStart, 4, totalStart, 10, toChineseAmount(pageCents / SCALE.AMOUNT_CENTS), {
    bold: true,
    align: 'left',
    bg: ORDER_PRINT_COLOR.totalBg,
  });
  ws.getRow(totalStart + 1).height = 28;
  putMerged(
    ws,
    totalStart + 1,
    1,
    totalStart + 1,
    3,
    `${prefix}品种数：${pageCountItems}    ${prefix}数量合计：${pageQty.toFixed(3)}`,
    { bold: true, align: 'left', bg: ORDER_PRINT_COLOR.totalBg },
  );
  putMerged(ws, totalStart + 1, 4, totalStart + 1, 6, `${prefix}金额合计（小写）：`, {
    bold: true,
    align: 'right',
    bg: ORDER_PRINT_COLOR.totalBg,
  });
  putMerged(
    ws,
    totalStart + 1,
    7,
    totalStart + 1,
    10,
    `¥ ${(pageCents / SCALE.AMOUNT_CENTS).toFixed(2)}`,
    {
      bold: true,
      align: 'right',
      bg: ORDER_PRINT_COLOR.totalBg,
      color: XL_HEADER_BG,
    },
  );

  let cursor = totalStart + 2;
  if (pageCount > 1 && pageIndex === pageCount - 1) {
    const grandCents = sumPrintAmountCents(allItems);
    const grandQty = sumPrintQuantity(allItems);
    const grandUpper = toChineseAmount(grandCents / SCALE.AMOUNT_CENTS);
    ws.getRow(cursor).height = 24;
    putMerged(
      ws,
      cursor,
      1,
      cursor,
      10,
      `整单总计：共 ${allItems.length} 项　数量合计 ${grandQty.toFixed(3)}　金额合计 ¥ ${(grandCents / SCALE.AMOUNT_CENTS).toFixed(2)}（${grandUpper}）`,
      { bold: true, align: 'center', bg: ORDER_PRINT_COLOR.grandBg, color: XL_HEADER_BG },
    );
    cursor += 1;
  }

  // 备注 + 签字栏（留空手写）。
  ws.getRow(cursor).height = 34;
  putMerged(ws, cursor, 1, cursor, 2, '备注：', { bold: true, align: 'right' });
  putMerged(ws, cursor, 3, cursor, 10, '本单商品已当面清点，数量与金额核对无误。', {
    wrap: true,
  });
  const signRow = cursor + 1;
  ws.getRow(signRow).height = 36;
  putMerged(ws, signRow, 1, signRow, 2, '制单人：____________', { border: false });
  putMerged(ws, signRow, 3, signRow, 5, '供货商签字：____________', { border: false });
  putMerged(ws, signRow, 6, signRow, 8, '验收人：____________', { border: false });
  putMerged(ws, signRow, 9, signRow, 10, '日期：__年__月__日', {
    border: false,
    align: 'right',
  });

  ws.views = [{ showGridLines: false }];
  ws.pageSetup = {
    orientation: 'landscape',
    paperSize: 9,
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 1,
    horizontalCentered: true,
    // exceljs 从 pageSetup.printArea 读取打印区域（Worksheet 类型未单独暴露）。
    printArea: `A1:J${signRow}`,
    margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
  };
  ws.headerFooter.oddFooter = '&L打印日期：&D &T&R第 &P 页 / 共 &N 页';
}

/**
 * Workers 单次导出的行数上限（5,000 行）。
 *
 * 依据 2026-11-24 本机实测（exceljs 4.4.0，10 列 × N 行，`writeBuffer()`）：
 * 2k 行峰值堆 ≈ 8MB，5k 行 ≈ 60MB，10k 行 ≈ 72MB 且 RSS 更高。Workers 单
 * isolate 只有 128MB，且 workerd 的 zip 与字符串开销比 Node 更大，故取 5k
 * （约一个月的高峰数据量：2,000 商品 × 每月一次）留出余量。
 * Node 走流式写出，不受此限。
 */
export const EXCEL_EXPORT_MAX_ROWS_WORKERS = 5000;

/** 从 EOCD + central directory 估算解压后总字节数（不解压、不读系统时钟）。 */
export function estimateZipUncompressedSize(buffer: Buffer): {
  ok: boolean;
  totalBytes: number;
  entries: number;
} {
  const start: number = Math.max(0, buffer.length - 65_557);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= start; i -= 1) {
    if (i + 22 <= buffer.length && buffer.readUInt32LE(i) === ZIP_EOCD_MAGIC) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    return { ok: false, totalBytes: 0, entries: 0 };
  }
  const entries: number = buffer.readUInt16LE(eocd + 10);
  let cursor: number = buffer.readUInt32LE(eocd + 16);
  let totalBytes = 0;
  for (let n = 0; n < entries; n += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_MAGIC) {
      return { ok: false, totalBytes, entries };
    }
    totalBytes += buffer.readUInt32LE(cursor + 24);
    const nameLen: number = buffer.readUInt16LE(cursor + 28);
    const extraLen: number = buffer.readUInt16LE(cursor + 30);
    const commentLen: number = buffer.readUInt16LE(cursor + 32);
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return { ok: true, totalBytes, entries };
}

/** 单元格值 → 文本；公式对象单独识别（禁公式）。 */
function cellToText(value: unknown): { text: string; formula: boolean } {
  if (value === null || value === undefined) {
    return { text: '', formula: false };
  }
  if (value instanceof Date) {
    const y: string = String(value.getUTCFullYear()).padStart(4, '0');
    const m: string = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d: string = String(value.getUTCDate()).padStart(2, '0');
    return { text: `${y}-${m}-${d}`, formula: false };
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if ('formula' in obj || 'sharedFormula' in obj || 'result' in obj) {
      return { text: '', formula: true };
    }
    if ('text' in obj && typeof obj.text === 'string') {
      return { text: obj.text, formula: false };
    }
    if ('richText' in obj && Array.isArray(obj.richText)) {
      return {
        text: (obj.richText as { text?: string }[]).map((part) => part.text ?? '').join(''),
        formula: false,
      };
    }
    return { text: '', formula: false };
  }
  return { text: String(value), formula: false };
}

function elapsedMs(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}

/**
 * 把 Hono 的 `write()` 适配成 exceljs 流式 writer 需要的 Node `Writable`
 * （exceljs 内部执行 `zip.pipe(stream)`，并在 `finish` 事件上兑现 commit）。
 *
 * **不要**换回 `PassThrough` + `Readable.toWeb()` 的老写法：workerd 的
 * `node:stream` 实现里，`toWeb()` 产出的 Web 流在 `pipeTo()` 下不会把已写入的
 * chunk 交付出去，表现是响应 200 但 body 为 **0 字节**（Node 侧完全正常，
 * 极易误判成"流式写失败"——日志里能看到 ZIP 魔数 `50 4b 07 08` 早已进了
 * PassThrough）。直接桥到 `write()` 既跨运行时一致，也保住了背压。
 */
function writableFrom(sink: { write(chunk: Uint8Array): Promise<unknown> }): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback): void {
      // 必须等 Hono 真正接收（`writer.write` 兑现）后再回调，背压才成立；
      // 用 async IIFE 而不是 `.then(cb)` —— 后者会触发 lint 的
      // `promise/no-callback-in-promise`，而这里回调本来就该在 promise 之外。
      void (async (): Promise<void> => {
        try {
          await sink.write(chunk);
          callback();
        } catch (error) {
          callback(error as Error);
        }
      })();
    },
  });
}

/** Excel 服务（单进程单例）。 */
export class ExcelService {
  constructor(private readonly deps: ExcelServiceDeps) {}

  /** GET /api/excel/template：只有表头，不含示例行。 */
  createTemplateResponse(c: Context, ctx: ExcelContext): Response | Promise<Response> {
    // 契约清理：模板恒不含示例行，不再下发无效的 withSample 字段。
    // 模板下载不写审计：非业务写、高频，属「只留关键操作」移除范围。
    this.setDownloadHeaders(c, 'stockin-template.xlsx');

    if (this.deps.excelWrite === 'buffer') {
      return this.writeWhole(c, ctx, '模板', (sheet): void => {
        // 列级格式必须在首行写出前设置：流式 writer 在首次写行时就序列化列定义。
        applyDetailNumFmt(sheet);
        sheet.addRow([...EXCEL_HEADER_TEXTS]);
        styleHeaderRow(sheet, EXCEL_COLUMN_COUNT);
        finishSheet(sheet, 1, EXCEL_COLUMN_COUNT, '进货记录明细表');
      });
    }
    return stream(
      c,
      async (s): Promise<void> => {
        const writer = new ExcelJS.stream.xlsx.WorkbookWriter({
          stream: writableFrom(s),
          useStyles: true,
        });
        const sheet = writer.addWorksheet('进货记录', { views: [XL_FROZEN_VIEW] });
        applyDetailNumFmt(sheet);
        const header = sheet.addRow([...EXCEL_HEADER_TEXTS]);
        styleHeaderRow(sheet, EXCEL_COLUMN_COUNT);
        // 流式行 commit 后不可再改样式，必须在 commit 前完成写入。
        (header as unknown as { commit(): void }).commit();
        finishSheet(sheet, 1, EXCEL_COLUMN_COUNT, '进货记录明细表');
        await sheet.commit();
        await writer.commit();
      },
      async (error: Error, s): Promise<void> => {
        logger.error({ err: error.message, requestId: ctx.requestId }, '[excel] 模板写出失败');
        s.abort();
      },
    );
  }

  /** POST /api/excel/export：按筛选导出全部命中记录。 */
  createExportResponse(
    c: Context,
    filter: RecordFilter,
    ctx: ExcelContext,
  ): Response | Promise<Response> {
    const thresholdDays: number = this.deps.settings.getThresholdDays();
    const today: string = serverToday();

    // 先判上限再写响应头：一旦设置了 content-disposition，就必须返回一份文件，
    // 不能再退回 JSON 错误体。COUNT 与 iteratePages 共用同一套筛选条件，正常
    // 情况下两者一致；Workers 的 await 点可能插入并发写入，因此这是**宽松**
    // 上限 —— 5000 行本身留有余量，多几行不会立刻 OOM。要严格卡死需要快照
    // 事务或先物化全部行，前者会阻塞写入、后者正是这个上限要防的内存问题。
    const maxRows: number | undefined = this.deps.exportMaxRows;
    if (maxRows !== undefined) {
      const total: number = this.deps.records.count(filter, today, thresholdDays);
      if (total > maxRows) {
        return errorResponse(ErrorCode.EXCEL_EXPORT_TOO_LARGE, ctx.requestId, {
          total,
          limit: maxRows,
          reason: `命中 ${total} 行，超过当前平台单次导出上限 ${maxRows} 行；请缩小进货日期范围后分批导出`,
        });
      }
    }

    // 数据导出不写审计：只读、非状态变更，属「只留关键操作」移除范围。
    this.setDownloadHeaders(c, 'stockin-export.xlsx');

    if (this.deps.excelWrite === 'buffer') {
      return this.writeWhole(c, ctx, '导出', async (sheet): Promise<void> => {
        await this.fillExportSheet(sheet, filter, today, thresholdDays, false);
      });
    }
    return stream(
      c,
      async (s): Promise<void> => {
        const writer = new ExcelJS.stream.xlsx.WorkbookWriter({
          stream: writableFrom(s),
          useStyles: true,
        });
        const sheet = writer.addWorksheet('进货记录', { views: [XL_FROZEN_VIEW] });
        await this.fillExportSheet(sheet, filter, today, thresholdDays, true);
        await sheet.commit();
        await writer.commit();
      },
      async (error: Error, s): Promise<void> => {
        logger.error({ err: error.message, requestId: ctx.requestId }, '[excel] 导出写出失败');
        s.abort();
      },
    );
  }

  /**
   * GET /api/orders/export：按筛选导出**单据级汇总**（一张单一行）。
   *
   * 与记录导出的区别：这里不列明细，只给对账需要的抬头与合计；
   * 列定义在 shared 的 `ORDER_EXPORT_HEADERS`，不在这里另写一份。
   * 上限判定与记录导出一致：`buffer` 路径先数一下，超限 413，不写半个文件。
   */
  createOrderExportResponse(
    c: Context,
    filter: OrderFilter,
    ctx: ExcelContext,
  ): Response | Promise<Response> {
    const maxRows: number | undefined = this.deps.exportMaxRows;
    if (maxRows !== undefined) {
      const total: number = this.deps.orders.count(filter);
      if (total > maxRows) {
        return errorResponse(ErrorCode.EXCEL_EXPORT_TOO_LARGE, ctx.requestId, {
          total,
          limit: maxRows,
          reason: `命中 ${total} 张单据，超过当前平台单次导出上限 ${maxRows} 张；请缩小进货日期范围后分批导出`,
        });
      }
    }

    this.setDownloadHeaders(c, 'stockin-orders.xlsx');

    if (this.deps.excelWrite === 'buffer') {
      return this.writeWhole(
        c,
        ctx,
        '单据导出',
        async (sheet): Promise<void> => {
          await this.fillOrderSheet(sheet, filter, false);
        },
        '进货单',
      );
    }
    return stream(
      c,
      async (s): Promise<void> => {
        const writer = new ExcelJS.stream.xlsx.WorkbookWriter({
          stream: writableFrom(s),
          useStyles: true,
        });
        const sheet = writer.addWorksheet('进货单', { views: [XL_FROZEN_VIEW] });
        await this.fillOrderSheet(sheet, filter, true);
        await sheet.commit();
        await writer.commit();
      },
      async (error: Error, s): Promise<void> => {
        logger.error({ err: error.message, requestId: ctx.requestId }, '[excel] 单据导出写出失败');
        s.abort();
      },
    );
  }

  /**
   * GET /api/orders/:id/export：单张进货单的打印版（销货清单样式，A4 横向）。
   *
   * 与汇总导出的区别：这里输出一张单的抬头 + 明细 + 合计 + 签字栏，含合并
   * 单元格与标题行，**不可**作为 /api/excel/import 的输入。一张单最多 200 条
   * 明细，数据量小，Node / Workers 统一用 buffer 一次写出，规避流式 writer
   * 对合并单元格与打印设置的限制。
   */
  async createOrderDetailExportResponse(
    c: Context,
    order: OrderDetailView,
    ctx: ExcelContext,
  ): Promise<Response> {
    // 单号允许商家照抄纸质单据，可能含文件名非法字符，下载名做一次净化。
    const safeNo: string = order.orderNo.replace(/[\\/:*?"<>|]/g, '_');
    this.setDownloadHeaders(c, `stockin-order-${safeNo}.xlsx`);

    try {
      const workbook = new ExcelJS.Workbook();
      const meta: OrderPrintMeta = {
        orderNo: order.orderNo,
        supplier: order.supplier,
        purchaseDate: order.purchaseDate,
        remark: order.remark ?? '',
      };
      const pages: RecordView[][] = [];
      for (let i = 0; i < order.items.length; i += ORDER_PRINT_MAX_DETAIL_ROWS) {
        pages.push(order.items.slice(i, i + ORDER_PRINT_MAX_DETAIL_ROWS));
      }
      // 空单据也要给出一张可打印的空白单。
      if (pages.length === 0) pages.push([]);
      pages.forEach((page, index) => {
        writeOrderPrintPage(workbook, page, index, pages.length, order.items, meta);
      });
      const bytes = await workbook.xlsx.writeBuffer();
      return c.body(bytes as unknown as ArrayBuffer, 200);
    } catch (error) {
      logger.error(
        { err: (error as Error).message, requestId: ctx.requestId, orderId: order.id },
        '[excel] 单张进货单导出生成失败',
      );
      throw error;
    }
  }

  /** 单据汇总表：一页 200 张单，写一行 commit 一行，内存与总单据数无关。 */
  private async fillOrderSheet(
    sheet: ExcelJS.Worksheet,
    filter: OrderFilter,
    streaming: boolean,
  ): Promise<void> {
    const headerRow = sheet.addRow([...ORDER_EXPORT_HEADER_TEXTS]);
    ORDER_EXPORT_HEADERS.forEach((def, index): void => {
      sheet.getColumn(index + 1).width = def.width;
    });
    // 列定义随首行一起序列化，numFmt 必须在 commit 前设置。
    sheet.getColumn(5).numFmt = '0.000';
    sheet.getColumn(6).numFmt = '0.00';
    styleHeaderRow(sheet, ORDER_EXPORT_HEADERS.length);
    if (streaming) {
      (headerRow as unknown as { commit(): void }).commit();
    }

    let page = 1;
    let written = 0;
    for (;;) {
      const result = this.deps.orders.list({ ...filter, page, pageSize: MAX_PAGE_SIZE });
      if (result.rows.length === 0) break;
      for (const row of result.rows) {
        const added = sheet.addRow([
          row.order_no,
          row.supplier,
          row.purchase_date,
          row.item_count,
          row.total_quantity / SCALE.QUANTITY,
          row.total_amount_cents / SCALE.AMOUNT_CENTS,
          formatServerDateTime(row.created_at),
        ]);
        styleDataRow(sheet, written + 2, ORDER_EXPORT_HEADERS.length, ORDER_COLUMN_KINDS);
        if (streaming) {
          (added as unknown as { commit(): void }).commit();
        }
        written += 1;
        await this.deps.gate.yieldIfNeeded(written);
      }
      if (result.rows.length < MAX_PAGE_SIZE) break;
      page += 1;
    }

    finishSheet(sheet, written + 1, ORDER_EXPORT_HEADERS.length, '进货单汇总表');
  }

  /** 下载响应的三个公共头（两种写出方式共用，避免两处漂移）。 */
  private setDownloadHeaders(c: Context, filename: string): void {
    c.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    c.header('content-disposition', `attachment; filename="${filename}"`);
    c.header('cache-control', SECURITY_HEADERS.CACHE_CONTROL_API);
  }

  /**
   * `buffer` 写出方式：整份生成后一次返回。
   *
   * 走的是 `Workbook.writeBuffer()`，zip 条目是 Buffer（非流），因此不会碰到
   * archiver 的 `source instanceof Stream` 判定 —— 这正是 Workers 上能跑通的原因，
   * 细节见 `runtime/platform.ts` 的 `ExcelWriteKind` 注释。
   */
  private async writeWhole(
    c: Context,
    ctx: ExcelContext,
    label: string,
    fill: (sheet: ExcelJS.Worksheet) => void | Promise<void>,
    sheetName: string = '进货记录',
  ): Promise<Response> {
    try {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet(sheetName, { views: [XL_FROZEN_VIEW] });
      await fill(sheet);
      const bytes = await workbook.xlsx.writeBuffer();
      return c.body(bytes as unknown as ArrayBuffer, 200);
    } catch (error) {
      logger.error(
        { err: (error as Error).message, requestId: ctx.requestId },
        `[excel] ${label}生成失败`,
      );
      throw error;
    }
  }

  /**
   * 往工作表里填导出数据。
   *
   * @param streaming 流式 writer 的行必须 `commit()` 才会落盘；普通工作表没有
   *   这个方法，误调会抛 TypeError，所以由调用方显式声明。
   */
  private async fillExportSheet(
    sheet: ExcelJS.Worksheet,
    filter: RecordFilter,
    today: string,
    thresholdDays: number,
    streaming: boolean,
  ): Promise<void> {
    // 列级格式必须在首行写出前设置，否则流式 writer 已经把列定义序列化了。
    applyDetailNumFmt(sheet);
    const headerRow = sheet.addRow([...EXCEL_HEADER_TEXTS]);
    styleHeaderRow(sheet, EXCEL_COLUMN_COUNT);
    if (streaming) {
      (headerRow as unknown as { commit(): void }).commit();
    }
    let written = 0;
    for (const row of this.deps.records.iteratePages(filter, today, thresholdDays)) {
      const fields = toRecordFields(row);
      const added = sheet.addRow([
        fields.name,
        fields.purchaseDate,
        fields.productionDate ?? '',
        formatShelfLifeCell(fields.shelfLifeValue, fields.shelfLifeUnit),
        fields.expiryDate ?? '',
        fields.spec ?? '',
        fields.unitPrice / SCALE.UNIT_PRICE,
        fields.quantity / SCALE.QUANTITY,
        fields.amountCents / SCALE.AMOUNT_CENTS,
        fields.remark ?? '',
        // 单据编号（散记留空）：走 toRecordView 这一唯一映射入口，避免与记录接口漂移（06-P2-2）。
        toRecordView(row, today, thresholdDays).order?.orderNo ?? '',
      ]);
      // 必须在 commit 前完成样式；物理行号 = 数据序号 + 表头 1 行。
      styleDataRow(sheet, written + 2, EXCEL_COLUMN_COUNT, DETAIL_COLUMN_KINDS);
      if (streaming) {
        (added as unknown as { commit(): void }).commit();
      }
      written += 1;
      await this.deps.gate.yieldIfNeeded(written);
    }
    finishSheet(sheet, written + 1, EXCEL_COLUMN_COUNT, '进货记录明细表');
  }

  /**
   * POST /api/excel/import：完整上传校验链 + 整批单事务写入。
   * 有 issue 直接 422，绝不打开写事务。
   */
  async importFile(
    payload: { fileName: string; buffer: Buffer; sizeBytes: number },
    ctx: ExcelContext,
  ): Promise<ServiceResult<ImportReport>> {
    const started: bigint = process.hrtime.bigint();
    if (!this.deps.gate.acquire()) {
      return { ok: false, code: ErrorCode.COMMON_BUSY };
    }
    try {
      const meta = excelImportMetaSchema.safeParse({
        fileName: payload.fileName,
        sizeBytes: payload.sizeBytes,
      });
      if (!meta.success) {
        return {
          ok: false,
          code:
            payload.sizeBytes > IMPORT_MAX_FILE_BYTES
              ? ErrorCode.VALID_BODY_TOO_LARGE
              : ErrorCode.EXCEL_UNSUPPORTED_FILE,
        };
      }
      if (payload.buffer.length < 4 || payload.buffer.readUInt32LE(0) !== ZIP_LOCAL_MAGIC) {
        return { ok: false, code: ErrorCode.EXCEL_UNSUPPORTED_FILE };
      }

      const zip = estimateZipUncompressedSize(payload.buffer);
      if (!zip.ok || zip.totalBytes > IMPORT_MAX_UNCOMPRESSED_BYTES) {
        return { ok: false, code: ErrorCode.EXCEL_UNSUPPORTED_FILE };
      }

      // 上传字节 → 工作簿。具体落地方式由运行时端口决定：Node 写 tmp 卷再读，
      // Workers 直接内存解析（临时文件在 Workers 上没有持久性）。
      const workbook: ExcelJS.Workbook = await this.deps.readWorkbook(payload.buffer);
      if (workbook.worksheets.length !== 1) {
        return { ok: false, code: ErrorCode.EXCEL_UNSUPPORTED_FILE };
      }
      const sheet = workbook.worksheets[0];
      if (sheet === undefined) {
        return { ok: false, code: ErrorCode.EXCEL_UNSUPPORTED_FILE };
      }
      const dataRowCount: number = Math.max(0, sheet.rowCount - 1);
      const rowLimitIssue: ImportIssue | null = checkExcelRowLimit(dataRowCount);
      if (rowLimitIssue !== null) {
        return { ok: false, code: ErrorCode.EXCEL_TOO_MANY_ROWS, details: rowLimitIssue };
      }

      // 表头比对（物理第 1 行）。
      const headerCells: string[] = [];
      for (let col = 0; col < EXCEL_COLUMN_COUNT; col += 1) {
        headerCells.push(cellToText((sheet.getRow(1).values as unknown[])[col + 1]).text);
      }
      const headerIssues: ImportIssue[] = checkExcelHeader(headerCells);

      // 逐行：Zod 形状校验 → domain 补算/校验；同时做公式与单元格数上限检查。
      const issues: ImportIssue[] = [...headerIssues];
      const parsedRows: ImportParsedRow[] = [];
      let cellCount = 0;
      let formulaFound = false;
      for (let index = 0; index < dataRowCount; index += 1) {
        const physicalRow: number = excelPhysicalRow(index);
        const rawValues = sheet.getRow(index + 2).values as unknown[];
        const cells: string[] = [];
        for (let col = 0; col < EXCEL_COLUMN_COUNT; col += 1) {
          const converted = cellToText(rawValues[col + 1]);
          if (converted.formula) {
            formulaFound = true;
          }
          cells.push(converted.text);
          cellCount += 1;
        }
        if (cellCount > MAX_CELLS) {
          return { ok: false, code: ErrorCode.EXCEL_TOO_MANY_ROWS };
        }
        if (elapsedMs(started) > IMPORT_DEADLINE_MS) {
          return { ok: false, code: ErrorCode.EXCEL_DEADLINE };
        }
        const zodResult = importRowSchema.safeParse({
          name: cells[0] ?? '',
          purchaseDate: cells[1] ?? '',
          productionDate: cells[2] ?? '',
          shelfLife: cells[3] ?? '',
          expiryDate: cells[4] ?? '',
          spec: cells[5] ?? '',
          unitPrice: cells[6] ?? '',
          quantity: cells[7] ?? '',
          amount: cells[8] ?? '',
          remark: cells[9] ?? '',
        });
        if (!zodResult.success) {
          issues.push(makeImportIssue(physicalRow, 'VALID_FAILED', '导入行结构不合法'));
          continue;
        }
        const parsed = parseExcelRow(cells, physicalRow, serverToday());
        issues.push(...parsed.issues);
        if (parsed.record !== null) {
          parsedRows.push({ row: physicalRow, record: parsed.record });
        }
      }
      // 第 11 列「单据编号」在导入时**刻意忽略**：Excel 没有供货商列，按单号凭空
      // 建单据只会造出没有供货商的脏单据。导入一律按散记落库，要成单请在
      // 「新增进货单」里录（to-do 03-B-14 给出的最保守方案）。
      if (formulaFound) {
        issues.push(
          makeImportIssue(
            EXCEL_FIRST_DATA_ROW,
            'EXCEL_FORMULA_FORBIDDEN',
            '导入文件不允许包含公式',
          ),
        );
      }

      // 文件内 Map 自比 + 库内批量判重（八项，备注与保质期不参与）。
      issues.push(...findImportDuplicates(parsedRows));
      const duplicates: readonly boolean[] = this.deps.records.probeDuplicates(
        parsedRows.map((item) => item.record),
      );
      for (let i = 0; i < duplicates.length; i += 1) {
        if (duplicates[i] === true) {
          issues.push(
            makeImportIssue(
              parsedRows[i]?.row ?? EXCEL_FIRST_DATA_ROW,
              'EXCEL_DUPLICATE',
              '库内已存在八项完全相同的记录',
            ),
          );
        }
      }

      /**
       * 有 issue 的数据行不算「通过」。
       *
       * 此前 `acceptedRows` 直接取 `parsedRows.length`：一行被判「库内重复」时它
       * 仍在 `parsedRows` 里，报告会出现「2 行可导入、0 行被拒」却整体 422 的
       * 自相矛盾结果（AUDIT-06）。按 issue 覆盖的物理行扣减后才与结论自洽。
       * 表头 issue 的 row 是表头行，不参与数据行计数。
       */
      const rejectedRows = new Set<number>(
        issues.filter((issue) => issue.row >= EXCEL_FIRST_DATA_ROW).map((issue) => issue.row),
      );
      const acceptedRows: number = parsedRows.filter((item) => !rejectedRows.has(item.row)).length;
      const report: ImportReport = buildImportReport(dataRowCount, acceptedRows, issues);
      if (issues.length > 0 || parsedRows.length === 0) {
        // 有 issue：直接 422，绝不打开写事务、绝不部分写入。
        return { ok: false, code: ErrorCode.EXCEL_ROW_INVALID, details: report };
      }
      if (elapsedMs(started) > IMPORT_DEADLINE_MS) {
        return { ok: false, code: ErrorCode.EXCEL_DEADLINE };
      }

      // 导入前备份（导入已持有全局信号量，复用不占锁的入口）。
      await this.deps.backup.backupWithoutGate('pre-import', ctx.requestId, ctx.actor);

      const writeCtx: WriteContext = {
        requestId: ctx.requestId,
        actor: ctx.actor,
        occurredAt: utcNowIso(),
      };
      const sources: RecordSources = { ...EMPTY_RECORD_SOURCES };
      immediateTransaction(this.deps.db, () => {
        for (const item of parsedRows) {
          this.deps.records.create(item.record, sources, writeCtx);
        }
        this.deps.logs.append({
          action: Action.EXCEL_IMPORT,
          targetType: TARGET_TYPE.RECORD,
          targetId: null,
          detail: {
            fileName: payload.fileName,
            totalRows: report.totalRows,
            acceptedRows: report.acceptedRows,
            rejectedRows: report.rejectedRows,
            issueCount: report.issues.length,
            durationMs: Math.round(elapsedMs(started)),
            requestId: ctx.requestId,
          },
          requestId: ctx.requestId,
          actor: ctx.actor,
          occurredAt: writeCtx.occurredAt,
        });
      });
      return { ok: true, data: report };
    } finally {
      this.deps.gate.release();
    }
  }
}
