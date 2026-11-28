/**
 * 启动自检守卫与时间源守卫。
 *
 * 这些函数只在启动或异常输入时执行，但它们是「fail-fast 而不是带病运行」的
 * 全部依靠：Node 大版本漂移、卷只读、磁盘将满、TZ 为空，任何一项被静默放过，
 * 都会在运行期以更难定位的方式爆出来。
 */
import fs from 'node:fs';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertNodeVersion,
  checkDiskSpace,
  assertVolumeWritable,
  SELFCHECK_FAILED_FILE,
  writeSelfcheckFailed,
} from '../src/bootstrap';
import {
  configureServerTimeZone,
  currentServerTimeZone,
  formatServerDateTime,
  utcAfterDaysIso,
  utcAfterHoursIso,
  utcAfterMinutesIso,
} from '../src/lib/today';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'stockin-guard-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('启动自检守卫', () => {
  it('Node 版本不匹配时抛出 BootstrapError，且错误消息含期望与实际版本', () => {
    expect(() => assertNodeVersion('0.0.1')).toThrow(/Node 版本不匹配/);
    expect(() => assertNodeVersion('0.0.1')).toThrow(/26\.13\.0/);
    expect(() => assertNodeVersion('0.0.1')).toThrow(/实际/);
  });

  it('版本匹配（当前运行时）时静默通过', () => {
    expect(() => assertNodeVersion(process.versions.node)).not.toThrow();
  });

  it('sentinel 写入时间戳与错误消息，路径可回报给组合根', () => {
    const file: string = writeSelfcheckFailed(dir, new Error('端口 8080 已被占用'));

    expect(path.basename(file)).toBe(SELFCHECK_FAILED_FILE);
    const content: string = fs.readFileSync(file, 'utf8');
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(content).toContain('端口 8080 已被占用');
  });

  it('非 Error 抛出值也能落到 sentinel（String 化），不会二次抛错', () => {
    const file: string = writeSelfcheckFailed(dir, '字符串错误');
    expect(fs.readFileSync(file, 'utf8')).toContain('字符串错误');
  });

  it('卷不可写时 sentinel 写失败也不能覆盖原始错误', () => {
    // 把一个普通文件当作目录：mkdirSync 必然失败，这里只能静默返回路径。
    const blocker: string = path.join(dir, 'blocker');
    writeFileSync(blocker, 'x', 'utf8');

    expect(() => writeSelfcheckFailed(blocker, new Error('原始错误'))).not.toThrow();
  });

  it('卷可写探针写入后清理临时文件，不留垃圾', () => {
    assertVolumeWritable(dir, 'DATA_DIR');
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('磁盘余量：充足返回 true，不足只告警返回 false，目录不可读时按通过处理', () => {
    expect(checkDiskSpace(dir, 1)).toBe(true);
    // 要求远超任何真实磁盘，触发「余量偏低」分支（启动不阻断）。
    expect(checkDiskSpace(dir, Number.MAX_SAFE_INTEGER)).toBe(false);
    // statfs 失败不能把启动卡死。
    expect(checkDiskSpace(path.join(dir, 'not-exists'), 1)).toBe(true);
  });
});

describe('时间源守卫', () => {
  it('TZ 置空拒绝，合法值可读回', () => {
    expect(() => configureServerTimeZone('   ')).toThrow(/TZ 不能为空/);
    configureServerTimeZone('Asia/Shanghai');
    expect(currentServerTimeZone()).toBe('Asia/Shanghai');
  });

  it('非有限数值的偏移量直接报错，不生成 Invalid Date', () => {
    expect(() => utcAfterDaysIso(Number.NaN)).toThrow(/有限数字/);
    expect(() => utcAfterMinutesIso(Number.POSITIVE_INFINITY)).toThrow(/有限数字/);
    expect(() => utcAfterHoursIso(Number.NaN)).toThrow(/有限数字/);
  });

  it('无法解析的时间串原样返回，不抛错也不产出 NaN 文本', () => {
    expect(formatServerDateTime('not-a-date')).toBe('not-a-date');
  });

  it('合法时间按服务器时区格式化到分钟', () => {
    configureServerTimeZone('Asia/Shanghai');
    expect(formatServerDateTime('2026-11-10T00:30:00.000Z')).toBe('2026-11-10 08:30');
  });
});
