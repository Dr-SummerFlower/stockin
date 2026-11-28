/**
 * 密码哈希 / 令牌原语与重任务信号量单测。
 *
 * `crypto.ts` 是凭据校验的唯一实现：`verifyPasswordHash` 的「长度不符 / 盐非法」
 * 两条兜底分支此前零覆盖——它们正是畸形输入（被改坏的库、伪造的 hash）的
 * 拒绝路径，必须验证「失败关闭」而不是抛异常穿透到 500。
 */
import { describe, expect, it } from 'vitest';
import { IMPORT_YIELD_EVERY_ROWS, SCRYPT_PARAMS } from '@stockin/shared';
import {
  derivePasswordHash,
  generateReadablePassword,
  generateSaltHex,
  generateSessionToken,
  hashSessionToken,
  sha256Hex,
  verifyPasswordHash,
} from '../src/lib/crypto';
import { HeavyTaskGate } from '../src/services/heavy-task';

describe('密码哈希', () => {
  const saltHex: string = generateSaltHex();

  it('正确密码通过，错误密码不通过', () => {
    const hash: string = derivePasswordHash('owner-pass-123', saltHex);
    expect(verifyPasswordHash('owner-pass-123', hash, saltHex)).toBe(true);
    expect(verifyPasswordHash('owner-pass-124', hash, saltHex)).toBe(false);
  });

  it('空密码 / 哈希长度不符 / 盐长度不符一律返回 false（失败关闭）', () => {
    const hash: string = derivePasswordHash('owner-pass-123', saltHex);
    expect(verifyPasswordHash('', hash, saltHex)).toBe(false);
    // 长度不是 keylen 的哈希：不比较，直接拒绝。
    expect(verifyPasswordHash('owner-pass-123', 'ab', saltHex)).toBe(false);
    // 盐长度不对会让派生抛错，必须被吞掉转成 false。
    expect(verifyPasswordHash('owner-pass-123', hash, 'aabb')).toBe(false);
  });

  it('同一密码不同盐得到不同哈希（加盐生效）', () => {
    const otherSalt: string = generateSaltHex();
    expect(derivePasswordHash('same-pass', saltHex)).not.toBe(
      derivePasswordHash('same-pass', otherSalt),
    );
  });

  it('盐是 saltBytes 长度的 hex', () => {
    expect(saltHex).toMatch(new RegExp(`^[0-9a-f]{${SCRYPT_PARAMS.saltBytes * 2}}$`));
  });
});

describe('令牌与摘要', () => {
  it('会话 token 为 32 字节 URL 安全字符，每次不同', () => {
    const first: string = generateSessionToken();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateSessionToken()).not.toBe(first);
  });

  it('token 哈希是确定性的 64 位 hex，且不回显明文', () => {
    const token = 'token-abc';
    const hash: string = hashSessionToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(token)).toBe(hash);
    expect(hash).not.toContain(token);
  });

  it('sha256Hex 对固定输入给出标准摘要', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('generateReadablePassword', () => {
  it('默认 18 字节，输出 URL 安全字符', () => {
    expect(generateReadablePassword()).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(generateReadablePassword(12)).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(generateReadablePassword(64)).toMatch(/^[A-Za-z0-9_-]{86}$/);
  });

  it('长度越界或非整数直接抛 RangeError', () => {
    expect(() => generateReadablePassword(11)).toThrow(RangeError);
    expect(() => generateReadablePassword(65)).toThrow(RangeError);
    expect(() => generateReadablePassword(12.5)).toThrow(RangeError);
  });
});

describe('HeavyTaskGate', () => {
  it('互斥：第二次 acquire 失败，release 后可再次占用', () => {
    const gate = new HeavyTaskGate();
    expect(gate.isBusy()).toBe(false);
    expect(gate.acquire()).toBe(true);
    expect(gate.isBusy()).toBe(true);
    expect(gate.acquire()).toBe(false);
    gate.release();
    expect(gate.isBusy()).toBe(false);
    expect(gate.acquire()).toBe(true);
    // 重复 release 幂等。
    gate.release();
    gate.release();
    expect(gate.isBusy()).toBe(false);
  });

  it('yieldIfNeeded 只在整批边界让出，且不吞掉后续执行', async () => {
    const gate = new HeavyTaskGate();
    await expect(gate.yieldIfNeeded(0)).resolves.toBeUndefined();
    await expect(gate.yieldIfNeeded(IMPORT_YIELD_EVERY_ROWS - 1)).resolves.toBeUndefined();
    await expect(gate.yieldIfNeeded(IMPORT_YIELD_EVERY_ROWS)).resolves.toBeUndefined();
  });
});
