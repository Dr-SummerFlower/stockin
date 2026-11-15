/**
 * Node 运行时：把上传字节落到 tmp 卷再读成工作簿。
 *
 * 保留既有行为（临时文件按主理人口径不做清理，留在 `tmp/` 下便于排障），
 * 只是搬进端口实现，让 `ExcelService` 不再认识 `node:fs`。
 */
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type { WorkbookReader } from '../ports';

export interface TempfileWorkbookOptions {
  readonly tmpDir: string;
}

export function createTempfileWorkbookReader(options: TempfileWorkbookOptions): WorkbookReader {
  return async (buffer: Buffer): Promise<ExcelJS.Workbook> => {
    fs.mkdirSync(options.tmpDir, { recursive: true });
    const tempDir: string = fs.mkdtempSync(path.join(options.tmpDir, 'import-'));
    const tempFile: string = path.join(tempDir, 'upload.xlsx');
    fs.writeFileSync(tempFile, buffer);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(tempFile);
    return workbook;
  };
}
