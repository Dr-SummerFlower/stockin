/**
 * 平台画像测试（任务卡 01 第 9 条：所有平台差异必须能从环境变量读出）。
 *
 * 这一层是"同一份代码跑两个运行时"的唯一开关表，一旦默认值漂了，
 * Node 侧就会在没有显式配置的情况下改变行为 —— 所以**缺省值等于改造前**
 * 这件事必须由测试钉住，而不是靠注释承诺。
 */
import { describe, expect, it } from 'vitest';
import {
  PLATFORM_PRESETS,
  resolvePlatform,
  resolveRuntimeTarget,
  shouldSecureCookie,
} from '../../src/runtime/platform';

describe('resolveRuntimeTarget', () => {
  it('未设置或空串都回落 node', () => {
    expect(resolveRuntimeTarget(undefined)).toBe('node');
    expect(resolveRuntimeTarget('')).toBe('node');
    expect(resolveRuntimeTarget('   ')).toBe('node');
  });

  it('显式 node / workers 原样返回（允许两侧空白）', () => {
    expect(resolveRuntimeTarget('node')).toBe('node');
    expect(resolveRuntimeTarget('workers')).toBe('workers');
    expect(resolveRuntimeTarget(' workers ')).toBe('workers');
  });

  it('非法值直接抛错，不静默兜底', () => {
    expect(() => resolveRuntimeTarget('deno')).toThrow(RangeError);
    expect(() => resolveRuntimeTarget('Worker')).toThrow(/RUNTIME_TARGET/);
  });
});

describe('resolvePlatform 缺省 = Node 行为零变化', () => {
  it('不设任何环境变量时逐项等于 Node 预设', () => {
    expect(resolvePlatform({})).toEqual(PLATFORM_PRESETS.node);
  });

  it('Node 预设的每一项都与改造前一致', () => {
    const profile = resolvePlatform({});
    expect(profile.dbDriver).toBe('node-sqlite');
    expect(profile.schemaVersionStore).toBe('pragma');
    expect(profile.integrityCheck).toBe('pragma');
    expect(profile.migrationsSource).toBe('filesystem');
    expect(profile.staticHandler).toBe('filesystem');
    expect(profile.backupMode).toBe('filesystem');
    expect(profile.excelIo).toBe('tempfile');
    expect(profile.excelWrite).toBe('stream');
    expect(profile.scheduler).toBe('interval');
    expect(profile.originScheme).toBe('http');
    expect(profile.nodeVersionAssert).toBe('strict');
    expect(profile.persistentFileSystem).toBe(true);
  });

  it('RUNTIME_TARGET=workers 切到 Workers 预设', () => {
    expect(resolvePlatform({ RUNTIME_TARGET: 'workers' })).toEqual(PLATFORM_PRESETS.workers);
  });

  it('Workers 预设逐项反转，且声明自己没有持久盘', () => {
    const profile = resolvePlatform({ RUNTIME_TARGET: 'workers' });
    expect(profile.dbDriver).toBe('do-sqlite');
    expect(profile.schemaVersionStore).toBe('table');
    expect(profile.integrityCheck).toBe('skip');
    expect(profile.migrationsSource).toBe('inline');
    expect(profile.staticHandler).toBe('assets');
    expect(profile.backupMode).toBe('pitr');
    expect(profile.excelIo).toBe('memory');
    expect(profile.excelWrite).toBe('buffer');
    expect(profile.scheduler).toBe('cron');
    expect(profile.originScheme).toBe('https');
    expect(profile.nodeVersionAssert).toBe('skip');
    expect(profile.persistentFileSystem).toBe(false);
  });
});

describe('逐项覆盖', () => {
  it('单项覆盖只改那一项，其余沿用预设', () => {
    const profile = resolvePlatform({ MIGRATIONS_SOURCE: 'inline' });
    expect(profile.migrationsSource).toBe('inline');
    // 其余仍是 Node 默认
    expect(profile.dbDriver).toBe('node-sqlite');
    expect(profile.target).toBe('node');
  });

  it('覆盖可以叠加在 workers 预设上（局部替换）', () => {
    const profile = resolvePlatform({ RUNTIME_TARGET: 'workers', EXCEL_WRITE: 'stream' });
    expect(profile.excelWrite).toBe('stream');
    expect(profile.backupMode).toBe('pitr');
  });

  it('空串视为未设置，不覆盖', () => {
    expect(resolvePlatform({ DB_DRIVER: '' }).dbDriver).toBe('node-sqlite');
    expect(resolvePlatform({ DB_DRIVER: '  ' }).dbDriver).toBe('node-sqlite');
  });

  it('每个开关都真的接线了（不是只在类型里存在）', () => {
    const overrides: Record<string, string> = {
      DB_DRIVER: 'do-sqlite',
      SCHEMA_VERSION_STORE: 'table',
      INTEGRITY_CHECK: 'skip',
      MIGRATIONS_SOURCE: 'inline',
      STATIC_HANDLER: 'assets',
      BACKUP_MODE: 'pitr',
      EXCEL_IO: 'memory',
      EXCEL_WRITE: 'buffer',
      SCHEDULER: 'cron',
      ORIGIN_SCHEME: 'https',
      NODE_VERSION_ASSERT: 'skip',
    };
    const profile = resolvePlatform(overrides);
    // 除了「选出来的预设」与「有没有持久盘」这两项事实，其余全等于 Workers 预设。
    expect(profile).toEqual({
      ...PLATFORM_PRESETS.workers,
      target: 'node',
      persistentFileSystem: true,
    });
    expect(profile.target).toBe('node');
  });

  it('非法覆盖值抛错并指出合法取值', () => {
    expect(() => resolvePlatform({ DB_DRIVER: 'd1' })).toThrow(/DB_DRIVER/);
    expect(() => resolvePlatform({ EXCEL_WRITE: 'tempfile' })).toThrow(/stream \/ buffer/);
  });
});

describe('不可覆盖项', () => {
  it('target 由 RUNTIME_TARGET 决定，其它变量改不动它', () => {
    expect(resolvePlatform({ STATIC_HANDLER: 'assets' }).target).toBe('node');
    expect(resolvePlatform({ RUNTIME_TARGET: 'workers' }).target).toBe('workers');
  });

  it('persistentFileSystem 是事实陈述，不随覆盖变化', () => {
    const nodeProfile = resolvePlatform({ BACKUP_MODE: 'pitr', EXCEL_IO: 'memory' });
    expect(nodeProfile.persistentFileSystem).toBe(true);
    const workersProfile = resolvePlatform({
      RUNTIME_TARGET: 'workers',
      BACKUP_MODE: 'filesystem',
    });
    expect(workersProfile.persistentFileSystem).toBe(false);
  });
});

describe('shouldSecureCookie', () => {
  it('只有 HTTPS 来源才下发 Secure Cookie', () => {
    expect(shouldSecureCookie(PLATFORM_PRESETS.node)).toBe(false);
    expect(shouldSecureCookie(PLATFORM_PRESETS.workers)).toBe(true);
    expect(shouldSecureCookie(resolvePlatform({ ORIGIN_SCHEME: 'https' }))).toBe(true);
  });
});
