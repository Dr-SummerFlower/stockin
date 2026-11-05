/**
 * 写操作幂等键生成。
 *
 * 依据：主理人 T04 口径 —— 用 `crypto.getRandomValues()`，
 * **不用 `randomUUID()`**（纯 HTTP 非安全上下文 `crypto.randomUUID` 不可用）。
 * 生成 16 字节随机数 → 32 位小写十六进制，落在 `idempotencyKey` 的 128 字符上限内。
 */

const KEY_BYTES = 16;

/** 生成一个 URL/JSON 安全的幂等键。 */
export function createIdempotencyKey(): string {
  const bytes: Uint8Array = new Uint8Array(KEY_BYTES);
  crypto.getRandomValues(bytes);
  let hex: string = '';
  for (let index = 0; index < bytes.length; index += 1) {
    hex += (bytes[index] ?? 0).toString(16).padStart(2, '0');
  }
  return hex;
}
