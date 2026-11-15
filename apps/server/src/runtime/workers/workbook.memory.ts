/**
 * Workers 运行时：上传字节直接在内存里解析成工作簿。
 *
 * Node 侧走"落 tmp 卷 → readFile"，那是为了留现场排障；Workers 的 `node:fs`
 * 虽可读写但**没有持久性**（实测），落盘只会在请求结束后消失，因此直接
 * `load(buffer)`。实测 `writeBuffer()` + `load()` 往返在 Workers 上可用。
 */
import ExcelJS from 'exceljs';
import type { WorkbookReader } from '../ports';

export function createMemoryWorkbookReader(): WorkbookReader {
  return async (buffer: Buffer): Promise<ExcelJS.Workbook> => {
    const workbook = new ExcelJS.Workbook();
    // exceljs 自带一份 `@types/node` 的 `Buffer` 声明，与项目锁定的 Node 26
    // 类型（`Buffer<ArrayBufferLike>`）在 `slice()` 的 `Symbol.toStringTag` 上
    // 不兼容。运行时是同一个 Buffer，这里只做类型对齐，不做任何数据转换。
    //
    // **必须保持 `workbook.xlsx.load(...)` 这种带接收者的调用形态**：`load()` 内部
    // 大量 `this.parseRels(...)` / `this.parseWorkbook(...)`。把方法摘出来裸调用
    // （`const load = workbook.xlsx.load; await load(buf)`）会让 `this` 变成
    // undefined（ESM 严格模式），抛
    // `Cannot read properties of undefined (reading 'parseRels')`，导入接口 500。
    const load = workbook.xlsx.load as unknown as (data: Buffer) => Promise<ExcelJS.Workbook>;
    await load.call(workbook.xlsx, buffer);
    return workbook;
  };
}
