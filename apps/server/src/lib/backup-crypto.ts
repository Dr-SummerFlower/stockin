/**
 * 逻辑备份加密：P-256 ECDH + HKDF-SHA256 + AES-256-GCM。
 *
 * 这里只依赖 WebCrypto，因此 Node 26 与 Workers 使用同一份实现：
 *  - 公钥/私钥使用 DER 的 base64（SPKI / PKCS#8），不引入 PEM 解析依赖。
 *  - 每次备份生成一个随机 AES-256 数据密钥；用接收方公钥封装后存入 backups。
 *  - 每个 chunk 使用独立 12 字节 IV，AAD 绑定 backupId/seq/table。
 *
 * 私钥只在本地解密/恢复脚本中使用；服务端只拿公钥。
 */

export const BACKUP_FORMAT_VERSION = 1;
const KDF_INFO = new TextEncoder().encode('stockin-logical-backup-v1');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const AES_KEY_BYTES = 32;

export interface WrappedKeyMaterial {
  readonly keyId: string;
  readonly ephemeralPublicKey: string;
  readonly kdfSalt: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
}

export interface EncryptedChunk {
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
  readonly sha256: string;
}

const subtle = globalThis.crypto.subtle;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * WebCrypto 的 BufferSource 在当前 TS 定义里要求 ArrayBuffer，不能直接传
 * `Uint8Array<ArrayBufferLike>`（可能是 SharedArrayBuffer）。统一复制成普通
 * ArrayBuffer，避免 Node/Workers 类型差异扩散到调用方。
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await subtle.digest('SHA-256', toArrayBuffer(bytes))));
}

async function importPublicKey(publicKeyBase64: string): Promise<CryptoKey> {
  return subtle.importKey(
    'spki',
    toArrayBuffer(base64ToBytes(publicKeyBase64)),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
}

async function importPrivateKey(privateKeyBase64: string): Promise<CryptoKey> {
  return subtle.importKey(
    'pkcs8',
    toArrayBuffer(base64ToBytes(privateKeyBase64)),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
}

async function deriveWrappingKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const shared = await subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const hkdf = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: toArrayBuffer(salt), info: toArrayBuffer(KDF_INFO) },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** 生成 P-256 密钥对；返回 DER base64，方便直接放 Secret / 本地文件。 */
export async function generateBackupKeyPair(): Promise<{
  publicKey: string;
  privateKey: string;
  keyId: string;
}> {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const publicDer = new Uint8Array(await subtle.exportKey('spki', pair.publicKey));
  const privateDer = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
  const keyId = (await sha256(publicDer)).slice(0, 32);
  return {
    publicKey: bytesToBase64(publicDer),
    privateKey: bytesToBase64(privateDer),
    keyId,
  };
}

/** 用接收方公钥封装一个新的 AES-256 数据密钥。 */
export async function createBackupDataKey(publicKeyBase64: string): Promise<{
  dataKey: CryptoKey;
  wrapped: WrappedKeyMaterial;
}> {
  const recipient = await importPublicKey(publicKeyBase64);
  const ephemeral = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const wrapKey = await deriveWrappingKey(ephemeral.privateKey, recipient, salt);
  const rawDataKey = globalThis.crypto.getRandomValues(new Uint8Array(AES_KEY_BYTES));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: toArrayBuffer(KDF_INFO) },
      wrapKey,
      toArrayBuffer(rawDataKey),
    ),
  );
  const ciphertext = sealed.slice(0, sealed.length - TAG_BYTES);
  const tag = sealed.slice(sealed.length - TAG_BYTES);
  const dataKey = await subtle.importKey(
    'raw',
    toArrayBuffer(rawDataKey),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
  // keyId 标识的是「解封公钥」（即本地私钥这批密钥），不是每次随机生成的
  // AES 数据密钥；多份备份共用同一 keyId 是刻意的——它们都能被同一把本地私钥
  // 解封。数据密钥本身每次备份独立随机生成并单独封装（见上方 rawDataKey）。
  const keyId = (await sha256(base64ToBytes(publicKeyBase64))).slice(0, 32);
  return {
    dataKey,
    wrapped: {
      keyId,
      ephemeralPublicKey: bytesToBase64(
        new Uint8Array(await subtle.exportKey('spki', ephemeral.publicKey)),
      ),
      kdfSalt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(ciphertext),
      tag: bytesToBase64(tag),
    },
  };
}

/** 本地脚本使用私钥解封 AES 数据密钥。 */
export async function unwrapBackupDataKey(
  privateKeyBase64: string,
  wrapped: WrappedKeyMaterial,
): Promise<CryptoKey> {
  const privateKey = await importPrivateKey(privateKeyBase64);
  const ephemeral = await importPublicKey(wrapped.ephemeralPublicKey);
  const wrapKey = await deriveWrappingKey(privateKey, ephemeral, base64ToBytes(wrapped.kdfSalt));
  const ciphertext = base64ToBytes(wrapped.ciphertext);
  const tag = base64ToBytes(wrapped.tag);
  const sealed = new Uint8Array(ciphertext.length + tag.length);
  sealed.set(ciphertext);
  sealed.set(tag, ciphertext.length);
  const rawDataKey = new Uint8Array(
    await subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(base64ToBytes(wrapped.iv)),
        additionalData: toArrayBuffer(KDF_INFO),
      },
      wrapKey,
      toArrayBuffer(sealed),
    ),
  );
  return subtle.importKey('raw', toArrayBuffer(rawDataKey), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** 加密一个 chunk；返回密文、tag、明文 SHA-256。 */
export async function encryptBackupChunk(
  dataKey: CryptoKey,
  plaintext: Uint8Array,
  aad: string,
): Promise<EncryptedChunk> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const additionalData = new TextEncoder().encode(aad);
  const sealed = new Uint8Array(
    await subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: toArrayBuffer(additionalData) },
      dataKey,
      toArrayBuffer(plaintext),
    ),
  );
  const ciphertext = sealed.slice(0, sealed.length - TAG_BYTES);
  const tag = sealed.slice(sealed.length - TAG_BYTES);
  return {
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
    tag: bytesToBase64(tag),
    sha256: await sha256(plaintext),
  };
}

/** 本地脚本解密 chunk。 */
export async function decryptBackupChunk(
  dataKey: CryptoKey,
  chunk: Pick<EncryptedChunk, 'iv' | 'ciphertext' | 'tag'>,
  aad: string,
): Promise<Uint8Array> {
  const ciphertext = base64ToBytes(chunk.ciphertext);
  const tag = base64ToBytes(chunk.tag);
  const sealed = new Uint8Array(ciphertext.length + tag.length);
  sealed.set(ciphertext);
  sealed.set(tag, ciphertext.length);
  return new Uint8Array(
    await subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(base64ToBytes(chunk.iv)),
        additionalData: toArrayBuffer(new TextEncoder().encode(aad)),
      },
      dataKey,
      toArrayBuffer(sealed),
    ),
  );
}

export async function hashBackupBytes(bytes: Uint8Array): Promise<string> {
  return sha256(bytes);
}

/* ------------------------------------------------------------------ *
 * 恢复票据：ECDSA P-256 + SHA-256
 *
 * 与备份封装共用同一把 P-256 密钥对。DER 编码本身不绑定算法用途，
 * 因此同一份私钥 DER 可导入为 ECDH（解封数据密钥）或 ECDSA（签票据），
 * 公钥 DER 同理。私钥始终只在本地脚本中出现，服务端只有公钥。
 *
 * 已知待评审（纵深防御）：同一把密钥兼具 ECDH 封装与 ECDSA 签名两用，
 * 缺少密钥用途分离。目前未见可直接利用的交叉协议攻击；拆分密钥需要同时
 * 变更 generateBackupKeyPair、env 公钥配置、本地私钥脚本与既有备份的兼容
 * 策略，属重大变更，留待安全评审裁决后再动，不在本次修复范围。
 * ------------------------------------------------------------------ */

async function importSigningPrivateKey(privateKeyBase64: string): Promise<CryptoKey> {
  return subtle.importKey(
    'pkcs8',
    toArrayBuffer(base64ToBytes(privateKeyBase64)),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

async function importVerifyingPublicKey(publicKeyBase64: string): Promise<CryptoKey> {
  return subtle.importKey(
    'spki',
    toArrayBuffer(base64ToBytes(publicKeyBase64)),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
}

/** 本地：用私钥对票据字节签名，返回 base64（P-256 P1363 定长 64 字节 = r||s 各 32）。 */
export async function signRestoreTicket(
  privateKeyBase64: string,
  payload: Uint8Array,
): Promise<string> {
  const key: CryptoKey = await importSigningPrivateKey(privateKeyBase64);
  const signature: ArrayBuffer = await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    toArrayBuffer(payload),
  );
  return bytesToBase64(new Uint8Array(signature));
}

/** 服务端：用公钥验签；任何异常（含格式错误）都归为 false，不抛给上层。 */
export async function verifyRestoreTicket(
  publicKeyBase64: string,
  payload: Uint8Array,
  signatureBase64: string,
): Promise<boolean> {
  try {
    const key: CryptoKey = await importVerifyingPublicKey(publicKeyBase64);
    return await subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      toArrayBuffer(base64ToBytes(signatureBase64)),
      toArrayBuffer(payload),
    );
  } catch {
    return false;
  }
}
