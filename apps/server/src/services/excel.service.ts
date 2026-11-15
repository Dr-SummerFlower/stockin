/**
 * Excel 服务：模板 / 导入 / 导出。
 *
 * 依据：设计文档 v1.1 §2.4 BR-11 / §3.5 / §4.3 / §5.2 / §10.1 裁决 13、18 /
 * §10.2 裁决 30 —— 上传校验链（信号量 → 2MB → 临时文件 → 魔数/容器 →
 * 解压≤20MB / sheet / 单元格 / ≤1000 行 → 禁公式 → 表头比对 → 15s deadline →
 * 导入前备份）；逐行 Zod + domain 补算；文件内 Map 自比 + 库内批量判重；
 * **有 issue 不开写事务直接 422**；全通过才 `BEGIN IMMEDIATE` 整批单事务
 * + 1 条汇总日志 + COMMIT；导出走 StreamingWorkbookWriter 逐行 commit +
 * Repository `iterate()` 游标 + 写入 Hono `stream()`（带第三参数错误处理器）。
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
  type ImportIssue,
  type ImportReport,
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
import type { OperationLogRepository } from '../repositories/operation-log.repository';
import type { SettingsRepository } from '../repositories/settings.repository';
import { toRecordFields, type WriteContext } from '../repositories/types';
import type { Env } from '../env';
import { serverToday, utcNowIso } from '../lib/today';
import { logger } from '../lib/logger';
import type { HeavyTaskGate } from './heavy-task';
import type { BackupService } from './backup.service';
import type { WorkbookReader } from '../runtime/ports';
import type { ExcelWriteKind } from '../runtime/platform';
import type { ServiceResult } from '../app';

export interface ExcelServiceDeps {
  readonly db: Db;
  readonly env: Env;
  readonly records: RecordRepository;
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
}

export interface ExcelContext {
  readonly requestId: string;
  readonly actor: string;
}

const ZIP_LOCAL_MAGIC = 0x04034b50;
const ZIP_CENTRAL_MAGIC = 0x02014b50;
const ZIP_EOCD_MAGIC = 0x06054b50;
const MAX_CELLS = (IMPORT_MAX_ROWS + 1) * EXCEL_COLUMN_COUNT * 2;

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
    this.appendLog(Action.EXCEL_TEMPLATE, ctx, {});
    this.setDownloadHeaders(c, 'stockin-template.xlsx');

    if (this.deps.excelWrite === 'buffer') {
      return this.writeWhole(c, ctx, '模板', (sheet): void => {
        sheet.addRow([...EXCEL_HEADER_TEXTS]);
      });
    }
    return stream(
      c,
      async (s): Promise<void> => {
        const writer = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: writableFrom(s) });
        const sheet = writer.addWorksheet('进货记录');
        sheet.addRow([...EXCEL_HEADER_TEXTS]).commit();
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
    this.appendLog(Action.EXCEL_EXPORT, ctx, { filter });
    this.setDownloadHeaders(c, 'stockin-export.xlsx');

    if (this.deps.excelWrite === 'buffer') {
      return this.writeWhole(c, ctx, '导出', async (sheet): Promise<void> => {
        await this.fillExportSheet(sheet, filter, today, thresholdDays, false);
      });
    }
    return stream(
      c,
      async (s): Promise<void> => {
        const writer = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: writableFrom(s) });
        const sheet = writer.addWorksheet('进货记录');
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
  ): Promise<Response> {
    try {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('进货记录');
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
    const headerRow = sheet.addRow([...EXCEL_HEADER_TEXTS]);
    if (streaming) {
      (headerRow as unknown as { commit(): void }).commit();
    }
    let written = 0;
    for (const row of this.deps.records.iterate(filter, today, thresholdDays)) {
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
      ]);
      if (streaming) {
        (added as unknown as { commit(): void }).commit();
      }
      written += 1;
      await this.deps.gate.yieldIfNeeded(written);
    }
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

      const report: ImportReport = buildImportReport(dataRowCount, parsedRows.length, issues);
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

  /** 模板/导出日志（非业务写，单独一条 append）。 */
  private appendLog(action: Action, ctx: ExcelContext, detail: unknown): void {
    this.deps.logs.append({
      action,
      targetType: TARGET_TYPE.NONE,
      targetId: null,
      detail,
      requestId: ctx.requestId,
      actor: ctx.actor,
      occurredAt: utcNowIso(),
    });
  }
}
