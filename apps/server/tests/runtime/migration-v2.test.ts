/**
 * 迁移 002 的结构验证：版本号与新增列。
 *
 * 001→002 只做 `ALTER TABLE ... ADD COLUMN` 且全部带 DEFAULT，老行可读；
 * Workers 侧同一份 SQL 由构建期内联，列结构一致（内联序号校验在
 * `migration-inline.test.ts` 覆盖）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readUserVersion } from '../../src/repositories/db';
import { SCHEMA_EXPECTED } from '../../src/repositories/schema';
import { createHarness, type Harness } from '../support/harness';

let harness: Harness | null = null;

afterEach(() => {
  harness?.close();
  harness = null;
});

function columnNames(harness: Harness, table: string): string[] {
  const rows = harness.deps.db.prepare(`PRAGMA table_info('${table}')`).all() as {
    name: string;
  }[];
  return rows.map((row) => row.name);
}

describe('迁移 002：自助引导与账号安全字段', () => {
  it('完整迁移链到达当前 schema 版本', async () => {
    harness = await createHarness();
    expect(readUserVersion(harness.deps.db)).toBe(SCHEMA_EXPECTED);
  });

  it('credentials 具备密保三列，settings 具备 shop_name', async () => {
    harness = await createHarness();
    const credentials: string[] = columnNames(harness, 'credentials');
    expect(credentials).toContain('security_question');
    expect(credentials).toContain('security_answer_salt');
    expect(credentials).toContain('security_answer_hash');

    const settings: string[] = columnNames(harness, 'settings');
    expect(settings).toContain('shop_name');
  });
});
