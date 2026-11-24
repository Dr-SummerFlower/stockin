/**
 * 备份线格式纯函数测试：恢复包全表覆盖（防半恢复）。
 */
import { describe, expect, it } from 'vitest';
import {
  ensureAllRestoreTables,
  restoreDataDigest,
  type RestoreTable,
} from '../src/lib/backup-format';

const ALL = ['credentials', 'settings', 'records', 'operation_logs', 'meta', 'admin_accounts'];

describe('ensureAllRestoreTables', () => {
  it('已有表保持不变，缺失表补空表且不丢原有行', () => {
    const records: RestoreTable = {
      kind: 'table',
      table: 'records',
      columns: ['id', 'name'],
      rows: [[1, '商品']],
    };
    const result = ensureAllRestoreTables([records], ALL);
    expect(result).toHaveLength(ALL.length);
    expect(result.find((t) => t.table === 'records')).toBe(records);
    const settings = result.find((t) => t.table === 'settings');
    expect(settings).toMatchObject({ kind: 'table', columns: [], rows: [] });
  });

  it('已覆盖全部表时不重复添加', () => {
    const all = ALL.map((name) => ({ kind: 'table' as const, table: name, columns: [], rows: [] }));
    expect(ensureAllRestoreTables(all, ALL)).toHaveLength(ALL.length);
  });

  it('补齐后的包摘要确定可复现（票据签名与服务端校验一致的基础）', async () => {
    const a = ensureAllRestoreTables([], ALL);
    const b = ensureAllRestoreTables([], ALL);
    expect(await restoreDataDigest(a)).toBe(await restoreDataDigest(b));
  });
});
