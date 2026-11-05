/**
 * Excel 服务：模板 / 导入 / 导出。
 *
 * 依据：设计文档 v1.1 §2.4 BR-11 / §3.5 / §4.3 / §5.2 / §10.1 裁决 13、18 /
 * §10.2 裁决 30 —— 上传校验链（信号量 → 2MB → 临时文件 → 魔数/容器 →
 * 解压≤20MB / sheet / 单元格 / ≤1000 行 → 禁公式 → 表头比对 → 15s deadline →
 * 导入前备份）；逐行 Zod + domain 补算；文件内 Map 自比 + 库内批量判重；
 * **有 issue 不开写事务直接 422**；全通过才 `BEGIN IMMEDIATE` 整批单事务
 * + 1 条汇总日志 + COMMIT；导出走 StreamingWorkbookWriter 逐行 commit +
 * Repository `iterate()` 游标 + pipe 到 Hono `stream()`（带第三参数错误处理器）。
 * 错误行号一律 Excel 物理行号。exceljs 仅本服务使用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
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
import { toRecordFields, type RecordRow, type WriteContext } from '../repositories/types';
import type { Env } from '../env';
import { serverToday, utcNowIso } from '../lib/today';
import { logger } from '../lib/logger';
import type { HeavyTaskGate } from './heavy-task';
import type { BackupService } from './backup.service';
import type { ServiceResult } from '../app';

export interface ExcelServiceDeps {
  readonly db: Db;
  readonly env: Env;
  readonly records: RecordRepository;
  readonly logs: OperationLogRepository;
  readonly settings: SettingsRepository;
  readonly gate: HeavyTaskGate;
  readonly backup: BackupService;
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
export function estimateZipUncompressedSize(
  buffer: Buffer,
): { ok: boolean; totalBytes: number; entries: number } {
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

/** Excel 服务（单进程单例）。 */
export class ExcelService {
  constructor(private readonly deps: ExcelServiceDeps) {}

  /** GET /api/excel/template：流式写表头，不含示例行。 */
  createTemplateResponse(c: Context, ctx: ExcelContext): Response {
    this.appendLog(Action.EXCEL_TEMPLATE, ctx, { withSample: false });
    c.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    c.header('content-disposition', 'attachment; filename="stockin-template.xlsx"');
    c.header('cache-control', SECURITY_HEADERS.CACHE_CONTROL_API);
    return stream(
      c,
      async (s): Promise<void> => {
        const pass = new PassThrough();
        const piping: Promise<void> = s.pipe(Readable.toWeb(pass) as unknown as ReadableStream);
        const writer = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: pass });
        const sheet = writer.addWorksheet('进货记录');
        const header = sheet.addRow([...EXCEL_HEADER_TEXTS]);
        header.commit();
        await sheet.commit();
        await writer.commit();
        await piping;
      },
      async (error: Error, s): Promise<void> => {
        logger.error({ err: error.message, requestId: ctx.requestId }, '[excel] 模板流式写失败');
        s.abort();
      },
    );
  }

  /** POST /api/excel/export：按筛选游标逐行 commit，pipe 到 Hono stream()。 */
  createExportResponse(c: Context, filter: RecordFilter, ctx: ExcelContext): Response {
    const thresholdDays: number = this.deps.settings.getThresholdDays();
    const today: string = serverToday();
    this.appendLog(Action.EXCEL_EXPORT, ctx, { filter });
    c.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    c.header('content-disposition', 'attachment; filename="stockin-export.xlsx"');
    c.header('cache-control', SECURITY_HEADERS.CACHE_CONTROL_API);

    return stream(
      c,
      async (s): Promise<void> => {
        const pass = new PassThrough();
        const piping: Promise<void> = s.pipe(Readable.toWeb(pass) as unknown as ReadableStream);
        const writer = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: pass });
        const sheet = writer.addWorksheet('进货记录');
        sheet.addRow([...EXCEL_HEADER_TEXTS]).commit();

        let written = 0;
        for (const row of this.deps.records.iterate(filter, today, thresholdDays)) {
          const fields = toRecordFields(row);
          sheet
            .addRow([
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
            ])
            .commit();
          written += 1;
          await this.deps.gate.yieldIfNeeded(written);
        }
        await sheet.commit();
        await writer.commit();
        await piping;
      },
      async (error: Error, s): Promise<void> => {
        logger.error({ err: error.message, requestId: ctx.requestId }, '[excel] 导出流式写失败');
        s.abort();
      },
    );
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
          code: payload.sizeBytes > IMPORT_MAX_FILE_BYTES
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

      // tmpfs 临时文件：写入项目内 tmp 卷。按主理人口径不做任何删除/清理动作，
      // 临时文件保留在 tmp/ 下且已被 .gitignore 忽略。
      fs.mkdirSync(this.deps.env.tmpDir, { recursive: true });
      const tempDir: string = fs.mkdtempSync(path.join(this.deps.env.tmpDir, 'import-'));
      const tempFile: string = path.join(tempDir, 'upload.xlsx');
      fs.writeFileSync(tempFile, payload.buffer);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(tempFile);
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
          makeImportIssue(EXCEL_FIRST_DATA_ROW, 'EXCEL_FORMULA_FORBIDDEN', '导入文件不允许包含公式'),
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
