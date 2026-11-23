import { describe, expect, it } from 'vitest';
import {
  createBackupDataKey,
  decryptBackupChunk,
  encryptBackupChunk,
  generateBackupKeyPair,
  signRestoreTicket,
  unwrapBackupDataKey,
  verifyRestoreTicket,
} from '../src/lib/backup-crypto';
import { encodeTicketPayload } from '../src/lib/backup-format';

describe('逻辑备份加密', () => {
  it('P-256 公钥封装的 AES 密钥可由私钥解封，并保持 chunk 往返一致', async () => {
    const pair = await generateBackupKeyPair();
    const { dataKey, wrapped } = await createBackupDataKey(pair.publicKey);
    const plaintext = new TextEncoder().encode('{"records":[{"id":1,"name":"测试商品"}]}');
    const aad = 'backup-id:1:records';
    const encrypted = await encryptBackupChunk(dataKey, plaintext, aad);

    const unwrapped = await unwrapBackupDataKey(pair.privateKey, wrapped);
    const decrypted = await decryptBackupChunk(unwrapped, encrypted, aad);

    expect(wrapped.keyId).toBe(pair.keyId);
    expect(new TextDecoder().decode(decrypted)).toBe(new TextDecoder().decode(plaintext));
  });

  it('AAD 不匹配时拒绝解密', async () => {
    const pair = await generateBackupKeyPair();
    const { dataKey, wrapped } = await createBackupDataKey(pair.publicKey);
    const encrypted = await encryptBackupChunk(
      dataKey,
      new TextEncoder().encode('secret'),
      'backup-id:records:1',
    );
    const unwrapped = await unwrapBackupDataKey(pair.privateKey, wrapped);

    await expect(
      decryptBackupChunk(unwrapped, encrypted, 'backup-id:records:2'),
    ).rejects.toBeDefined();
  });

  it('错误私钥不能解封', async () => {
    const pair = await generateBackupKeyPair();
    const wrong = await generateBackupKeyPair();
    const { wrapped } = await createBackupDataKey(pair.publicKey);

    await expect(unwrapBackupDataKey(wrong.privateKey, wrapped)).rejects.toBeDefined();
  });
});

describe('恢复票据 ECDSA 签名', () => {
  const payload = {
    v: 1,
    batchId: 'rb-123',
    issuedAt: '2026-01-01T00:00:00.000Z',
    dataSha256: 'a'.repeat(64),
    schemaVersion: 4,
    keyId: 'key-1',
  };

  it('同一密钥对的公钥可验证本地私钥签名', async () => {
    const pair = await generateBackupKeyPair();
    const bytes = encodeTicketPayload(payload);
    const signature = await signRestoreTicket(pair.privateKey, bytes);
    expect(await verifyRestoreTicket(pair.publicKey, bytes, signature)).toBe(true);
  });

  it('载荷被篡改则验签失败', async () => {
    const pair = await generateBackupKeyPair();
    const bytes = encodeTicketPayload(payload);
    const signature = await signRestoreTicket(pair.privateKey, bytes);
    const tampered = encodeTicketPayload({ ...payload, dataSha256: 'b'.repeat(64) });
    expect(await verifyRestoreTicket(pair.publicKey, tampered, signature)).toBe(false);
  });

  it('错误公钥验签失败，畸形签名不抛错', async () => {
    const pair = await generateBackupKeyPair();
    const wrong = await generateBackupKeyPair();
    const bytes = encodeTicketPayload(payload);
    const signature = await signRestoreTicket(pair.privateKey, bytes);
    expect(await verifyRestoreTicket(wrong.publicKey, bytes, signature)).toBe(false);
    expect(await verifyRestoreTicket(pair.publicKey, bytes, 'not-base64!!!')).toBe(false);
  });
});
