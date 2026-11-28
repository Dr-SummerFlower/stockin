/**
 * ZIP 结构估算（解压体积防线）。
 *
 * 导入前不解压就估算解压后总字节数，用来挡 ZIP 炸弹：一个 2KB 的上传
 * 可以解出几百 MB。估算必须是**纯读**、无时钟、结构异常即判不可用。
 */
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { estimateZipUncompressedSize } from '../src/services/excel.service';

const EOCD_SIGNATURE = 0x06_05_4b_50;
const CENTRAL_SIGNATURE = 0x02_01_4b_50;

/** 造一个只有 EOCD 的字节串；`cdOffset` 指向约定中的中央目录位置。 */
function withEocd(entryCount: number, cdOffset: number): Buffer {
  const buffer: Buffer = Buffer.alloc(64 + 22);
  buffer.writeUInt32LE(EOCD_SIGNATURE, 64);
  buffer.writeUInt16LE(entryCount, 64 + 10);
  buffer.writeUInt32LE(cdOffset, 64 + 16);
  return buffer;
}

describe('estimateZipUncompressedSize', () => {
  it('找不到 EOCD 时判为不可用（截断或非 ZIP 容器）', () => {
    expect(estimateZipUncompressedSize(Buffer.from([1, 2, 3, 4]))).toEqual({
      ok: false,
      totalBytes: 0,
      entries: 0,
    });
    // 长度不足 22 字节，连 EOCD 都放不下。
    expect(estimateZipUncompressedSize(Buffer.alloc(4)).ok).toBe(false);
  });

  it('中央目录签名不对时判为不可用，不返回不可信的体积', () => {
    const result = estimateZipUncompressedSize(withEocd(1, 0));
    expect(result).toEqual({ ok: false, totalBytes: 0, entries: 1 });
  });

  it('中央目录可解析时按声明的解压体积累加', () => {
    const central: Buffer = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt32LE(1_000, 24);
    const buffer: Buffer = Buffer.concat([central, withEocd(1, 0)]);

    expect(estimateZipUncompressedSize(buffer)).toEqual({
      ok: true,
      totalBytes: 1_000,
      entries: 1,
    });
  });

  it('空归档（entries=0）返回可用且体积为 0', () => {
    const buffer: Buffer = withEocd(0, 0);
    expect(estimateZipUncompressedSize(buffer)).toEqual({ ok: true, totalBytes: 0, entries: 0 });
  });

  it('真实 xlsx 估算出的解压体积大于文件本身（压缩率不会低于 1）', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('进货记录').addRow(['商品名', '日期']);
    const bytes: Buffer = Buffer.from((await workbook.xlsx.writeBuffer()) as ArrayBuffer);

    const result = estimateZipUncompressedSize(bytes);
    expect(result.ok).toBe(true);
    expect(result.entries).toBeGreaterThan(0);
    expect(result.totalBytes).toBeGreaterThan(bytes.length);
  });
});
