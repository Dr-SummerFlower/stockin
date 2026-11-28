/**
 * Schema 版本闸门单测。
 *
 * 这块是「镜像回退 / 跨版本升级」的唯一拦截点，判错一次就可能让旧程序打开
 * 新库并写坏数据；此前只有 Workers 表格存储那条链路被间接覆盖，Node 的文件式
 * 放行凭据与 `checkUserVersion` 的多数分支是空白。
 *
 * 全部落盘操作走 `.tmp/tests/` 临时目录，结束即删，不碰 `apps/server/data`。
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BREAKING_MIGRATIONS,
  MIGRATION_FILE_PATTERN,
  ROLLBACK_ALLOW_FILE,
  SCHEMA_EXPECTED,
  SCHEMA_MIN_USER_VERSION,
  checkUserVersion,
  consumeRollbackAllowance,
  isBreakingVersion,
  readRollbackAllowance,
  rollbackAllowancePath,
  writeRollbackAllowance,
  type RollbackAllowance,
} from '../src/repositories/schema';

const repoRoot: string = path.resolve(import.meta.dirname, '../../..');
const migrationsDir: string = path.join(
  repoRoot,
  'apps',
  'server',
  'src',
  'repositories',
  'migrations',
);

describe('checkUserVersion', () => {
  it('非整数或负数版本直接抛 RangeError（视为库损坏）', () => {
    const consume = vi.fn((): RollbackAllowance | null => null);
    expect(() => checkUserVersion(1.5, SCHEMA_EXPECTED, consume)).toThrow(RangeError);
    expect(() => checkUserVersion(-1, SCHEMA_EXPECTED, consume)).toThrow(RangeError);
    expect(consume).not.toHaveBeenCalled();
  });

  it('版本相等 → ok，且不消费放行凭据', () => {
    const consume = vi.fn((): RollbackAllowance | null => null);
    expect(checkUserVersion(SCHEMA_EXPECTED, SCHEMA_EXPECTED, consume)).toBe('ok');
    expect(consume).not.toHaveBeenCalled();
  });

  it('版本为 0（全新空库）→ migrate，且不受不可回滚下限约束', () => {
    const consume = vi.fn((): RollbackAllowance | null => null);
    expect(checkUserVersion(0, SCHEMA_EXPECTED, consume)).toBe('migrate');
    expect(consume).not.toHaveBeenCalled();
    // 下限本身应当不低于 1，否则「0 特判」就失去意义。
    expect(SCHEMA_MIN_USER_VERSION).toBeGreaterThan(0);
  });

  it('低于期望但高于下限 → migrate（fix-forward）', () => {
    const consume = vi.fn((): RollbackAllowance | null => null);
    expect(checkUserVersion(SCHEMA_EXPECTED - 1, SCHEMA_EXPECTED, consume)).toBe('migrate');
    expect(consume).not.toHaveBeenCalled();
  });

  it('高于期望且无放行 → 抛错并提示先升级应用', () => {
    const consume = vi.fn((): RollbackAllowance | null => null);
    expect(() => checkUserVersion(SCHEMA_EXPECTED + 1, SCHEMA_EXPECTED, consume)).toThrow(
      /高于当前程序期望/,
    );
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it('高于期望 + 放行区间覆盖当前版本 → rollback-allowed', () => {
    const consume = vi.fn((): RollbackAllowance => ({
      fromVersion: SCHEMA_EXPECTED + 1,
      toVersion: SCHEMA_EXPECTED,
      issuedAt: '2026-11-27T00:00:00.000Z',
    }));
    expect(checkUserVersion(SCHEMA_EXPECTED + 1, SCHEMA_EXPECTED, consume)).toBe(
      'rollback-allowed',
    );
  });

  it('放行凭据区间不覆盖（fromVersion 太小 / toVersion 太大）→ 仍然抛错', () => {
    const tooNarrow = vi.fn((): RollbackAllowance => ({
      fromVersion: SCHEMA_EXPECTED,
      toVersion: SCHEMA_EXPECTED - 1,
      issuedAt: '2026-11-27T00:00:00.000Z',
    }));
    expect(() => checkUserVersion(SCHEMA_EXPECTED + 1, SCHEMA_EXPECTED, tooNarrow)).toThrow(
      /高于当前程序期望/,
    );

    const tooWide = vi.fn((): RollbackAllowance => ({
      fromVersion: SCHEMA_EXPECTED + 1,
      toVersion: SCHEMA_EXPECTED + 5,
      issuedAt: '2026-11-27T00:00:00.000Z',
    }));
    expect(() => checkUserVersion(SCHEMA_EXPECTED + 1, SCHEMA_EXPECTED, tooWide)).toThrow(
      /高于当前程序期望/,
    );
  });
});

describe('文件式回滚放行凭据', () => {
  let dir: string;

  beforeEach((): void => {
    const tmpRoot: string = path.join(repoRoot, '.tmp', 'tests');
    mkdirSync(tmpRoot, { recursive: true });
    dir = mkdtempSync(path.join(tmpRoot, 'schema-'));
  });

  afterEach((): void => {
    rmSync(dir, { recursive: true, force: true });
  });

  const sample: RollbackAllowance = {
    fromVersion: SCHEMA_EXPECTED + 1,
    toVersion: SCHEMA_EXPECTED,
    issuedAt: '2026-11-27T00:00:00.000Z',
  };

  it('放行文件路径落在 data 卷根下，固定文件名', () => {
    expect(rollbackAllowancePath(dir)).toBe(path.join(dir, ROLLBACK_ALLOW_FILE));
  });

  it('文件不存在 → 未放行', () => {
    expect(readRollbackAllowance(dir)).toBeNull();
    expect(consumeRollbackAllowance(dir)).toBeNull();
  });

  it('写入后可读回，消费一次即删除（保证一次性）', () => {
    writeRollbackAllowance(path.join(dir, 'nested', 'data'), sample);
    const dataDir: string = path.join(dir, 'nested', 'data');
    expect(readRollbackAllowance(dataDir)).toEqual(sample);

    expect(consumeRollbackAllowance(dataDir)).toEqual(sample);
    expect(readRollbackAllowance(dataDir)).toBeNull();
    expect(consumeRollbackAllowance(dataDir)).toBeNull();
  });

  it('内容损坏（非法 JSON / 字段类型不对）一律按未放行处理', () => {
    writeFileSync(rollbackAllowancePath(dir), '{not-json', 'utf8');
    expect(readRollbackAllowance(dir)).toBeNull();

    writeFileSync(rollbackAllowancePath(dir), JSON.stringify({ fromVersion: '8' }), 'utf8');
    expect(readRollbackAllowance(dir)).toBeNull();

    writeFileSync(
      rollbackAllowancePath(dir),
      JSON.stringify({ fromVersion: 8, toVersion: 7, issuedAt: 123 }),
      'utf8',
    );
    expect(readRollbackAllowance(dir)).toBeNull();
  });
});

describe('登记表与迁移脚本', () => {
  it('isBreakingVersion 只认已登记版本', () => {
    for (const item of BREAKING_MIGRATIONS) {
      expect(isBreakingVersion(item.version)).toBe(true);
    }
    expect(isBreakingVersion(SCHEMA_EXPECTED + 99)).toBe(false);
  });

  it('最新迁移脚本序号与 SCHEMA_EXPECTED 一致（防止加脚本忘记升版本）', () => {
    const versions: number[] = readdirSync(migrationsDir)
      .map((name) => MIGRATION_FILE_PATTERN.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number.parseInt(match[1] as string, 10));
    expect(versions.length).toBeGreaterThan(0);
    expect(Math.max(...versions)).toBe(SCHEMA_EXPECTED);
  });
});
