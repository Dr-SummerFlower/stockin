/**
 * 密码哈希、会话令牌与摘要原语。
 *
 * 依据：设计文档 v1.1 §3.4 / §4.2（scrypt N=2^15,r=8,p=1,keylen=64,salt16B；
 * DB 绝不存明文 token，只存 token_hash）。参数全部取自 shared 的 SCRYPT_PARAMS。
 */
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import { SCRYPT_PARAMS } from '@stockin/shared';

/** scrypt 参数序列化文本，随凭据行落库，便于未来参数升级时区分。 */
export interface StoredScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly keylen: number;
  readonly saltBytes: number;
  readonly maxmem: number;
}

export function scryptParamsSnapshot(): StoredScryptParams {
  return {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    keylen: SCRYPT_PARAMS.keylen,
    saltBytes: SCRYPT_PARAMS.saltBytes,
    maxmem: SCRYPT_PARAMS.maxmem,
  };
}

export function serializeScryptParams(params: StoredScryptParams = scryptParamsSnapshot()): string {
  return JSON.stringify(params);
}

/** 生成 16 字节随机盐（hex，长度 = saltBytes * 2）。 */
export function generateSaltHex(): string {
  return randomBytes(SCRYPT_PARAMS.saltBytes).toString('hex');
}

function toScryptOptions(): ScryptOptions {
  return {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: SCRYPT_PARAMS.maxmem,
  };
}

/** scrypt 派生密码哈希（hex）。同步调用，供 CLI / 单账户登录使用。 */
export function derivePasswordHash(password: string, saltHex: string): string {
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('[crypto] password 不能为空');
  }
  const salt: Buffer = Buffer.from(saltHex, 'hex');
  if (salt.length !== SCRYPT_PARAMS.saltBytes) {
    throw new RangeError('[crypto] salt 长度不匹配');
  }
  return scryptSync(password, salt, SCRYPT_PARAMS.keylen, toScryptOptions()).toString('hex');
}

/** 定长、常量时间比较，避免时序侧信道。 */
export function verifyPasswordHash(password: string, hashHex: string, saltHex: string): boolean {
  if (typeof password !== 'string' || password.length === 0) {
    return false;
  }
  let expected: Buffer;
  try {
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== SCRYPT_PARAMS.keylen) {
    return false;
  }
  let actual: Buffer;
  try {
    actual = Buffer.from(derivePasswordHash(password, saltHex), 'hex');
  } catch {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

/** 生成会话明文 token（仅经 Cookie 交给浏览器，绝不入库）。 */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** token → sha256 hex，作为 sessions.token_hash 的唯一存储形态。 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 通用 sha256 hex（备份校验链、幂等键摘要）。 */
export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 生成人类可抄录的随机初始密码（base64url，无歧义字符集）。 */
export function generateReadablePassword(byteLength: number = 18): string {
  if (!Number.isInteger(byteLength) || byteLength < 12 || byteLength > 64) {
    throw new RangeError('[crypto] byteLength 必须是 12~64 的整数');
  }
  return randomBytes(byteLength).toString('base64url');
}
