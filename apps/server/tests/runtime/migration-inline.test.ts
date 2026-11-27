/**
 * 内联迁移源测试（任务卡 01 第 8 条：Worker 没有磁盘，迁移脚本构建期内联）。
 *
 * 这里钉的是**安全网**而不是 SQL 内容：新增迁移忘记在清单里加 import 时，
 * 必须在启动阶段炸掉，而不是静默漏掉一个版本。
 */
import { describe, expect, it } from 'vitest';
import {
  createInlineMigrationSource,
  discoverInlineMigrations,
  stripUserVersionPragma,
} from '../../src/runtime/workers/migration-source.inline';
import { SCHEMA_EXPECTED } from '../../src/repositories/schema';

describe('stripUserVersionPragma', () => {
  it('剥掉赋值行，其余内容逐字节保留', () => {
    const sql: string = ['CREATE TABLE a (id INTEGER);', 'PRAGMA user_version = 1;', ''].join('\n');
    const stripped: string = stripUserVersionPragma(sql);
    expect(stripped).not.toMatch(/user_version/i);
    expect(stripped).toContain('CREATE TABLE a (id INTEGER);');
  });

  it('大小写与缩进都不影响识别', () => {
    expect(stripUserVersionPragma('  pragma  USER_VERSION=2;')).not.toMatch(/user_version/i);
  });

  it('只剥赋值，不误伤读取语句', () => {
    const sql: string = 'SELECT * FROM meta;\nPRAGMA user_version;';
    expect(stripUserVersionPragma(sql)).toContain('PRAGMA user_version;');
  });
});

describe('discoverInlineMigrations', () => {
  it('真实清单覆盖 SCHEMA_EXPECTED，且每条都带版本号', () => {
    const files = discoverInlineMigrations();
    expect(files.length).toBeGreaterThanOrEqual(SCHEMA_EXPECTED);
    expect(files[0]?.version).toBe(1);
    expect(files[0]?.filename).toMatch(/^\d{3}_.+\.sql$/);
    // 内联脚本没有磁盘路径，必须是空串而不是假路径。
    expect(files.every((file) => file.fullPath === '')).toBe(true);
  });

  it('乱序清单会被排好序', () => {
    const files = discoverInlineMigrations({
      '005_e.sql': 'SELECT 1;',
      '004_d.sql': 'SELECT 1;',
      '003_c.sql': 'SELECT 1;',
      '002_b.sql': 'SELECT 1;',
      '001_a.sql': 'SELECT 1;',
      '007_g.sql': 'SELECT 1;',
      '006_f.sql': 'SELECT 1;',
    });
    expect(files.map((file) => file.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('序号断档直接抛错（新增脚本忘了 import 的现场）', () => {
    expect(() =>
      discoverInlineMigrations({ '001_a.sql': 'SELECT 1;', '003_c.sql': 'SELECT 1;' }),
    ).toThrow(/序号不连续/);
  });

  it('数量不足 SCHEMA_EXPECTED 也抛错', () => {
    expect(() => discoverInlineMigrations({ '009_a.sql': 'SELECT 1;' })).toThrow(
      /SCHEMA_EXPECTED|序号不连续/,
    );
  });

  it('不匹配命名规则的文件被忽略', () => {
    const files = discoverInlineMigrations({
      '001_a.sql': 'SELECT 1;',
      '002_b.sql': 'SELECT 1;',
      '003_c.sql': 'SELECT 1;',
      '004_d.sql': 'SELECT 1;',
      '005_e.sql': 'SELECT 1;',
      '006_f.sql': 'SELECT 1;',
      '007_g.sql': 'SELECT 1;',
      'README.md': '# x',
    });
    expect(files).toHaveLength(7);
  });
});

describe('createInlineMigrationSource', () => {
  it('kind 标识为 inline，read 返回剥离后的脚本', () => {
    const source = createInlineMigrationSource({
      '001_a.sql': 'CREATE TABLE a (id INTEGER);\nPRAGMA user_version = 1;\n',
      '002_b.sql': "ALTER TABLE a ADD COLUMN x TEXT NOT NULL DEFAULT '';\n",
      '003_c.sql': 'CREATE TABLE c (id INTEGER);\n',
      '004_d.sql': 'CREATE TABLE d (id INTEGER);\n',
      '005_e.sql': 'CREATE TABLE e (id INTEGER);\n',
      '006_f.sql': 'CREATE TABLE f (id INTEGER);\n',
      '007_g.sql': 'CREATE TABLE g (id INTEGER);\n',
    });
    expect(source.kind).toBe('inline');
    const files = source.discover();
    expect(files).toHaveLength(7);
    const first = files[0];
    expect(first).toBeDefined();
    const sql: string = source.read(first!);
    expect(sql).toContain('CREATE TABLE a (id INTEGER);');
    expect(sql).not.toMatch(/user_version\s*=/i);
  });

  it('清单里没有的脚本名不能让流程静默通过', () => {
    const source = createInlineMigrationSource({ '001_a.sql': 'SELECT 1;' });
    expect(() => source.read({ version: 2, filename: '002_missing.sql', fullPath: '' })).toThrow(
      /没有 002_missing\.sql/,
    );
  });
});
