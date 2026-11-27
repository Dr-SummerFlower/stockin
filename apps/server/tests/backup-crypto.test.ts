import { describe, expect, it } from 'vitest';
import {
  backupKeyId,
  createBackupDataKey,
  decryptBackupChunk,
  encryptBackupChunk,
  generateBackupKeyPair,
  publicKeyFromPrivate,
  signRestoreTicket,
  unwrapBackupDataKey,
  verifyRestoreTicket,
  verifyRestoreTicketWithAnyKey,
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
    schemaVersion: 5,
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

  it('轮换过渡期：任一公钥验过即通过，空列表一律拒绝', async () => {
    const oldPair = await generateBackupKeyPair();
    const newPair = await generateBackupKeyPair();
    const bytes = encodeTicketPayload(payload);
    const oldSignature = await signRestoreTicket(oldPair.privateKey, bytes);
    const newSignature = await signRestoreTicket(newPair.privateKey, bytes);

    // 首项用于加密，验签按顺序尝试：新旧签名都能过。
    expect(
      await verifyRestoreTicketWithAnyKey(
        [newPair.publicKey, oldPair.publicKey],
        bytes,
        oldSignature,
      ),
    ).toBe(true);
    expect(
      await verifyRestoreTicketWithAnyKey(
        [newPair.publicKey, oldPair.publicKey],
        bytes,
        newSignature,
      ),
    ).toBe(true);
    // 过渡期结束后只保留新公钥：旧私钥签的票据被拒。
    expect(await verifyRestoreTicketWithAnyKey([newPair.publicKey], bytes, oldSignature)).toBe(
      false,
    );
    // 未配置公钥时不得「无密钥即放行」。
    expect(await verifyRestoreTicketWithAnyKey([], bytes, newSignature)).toBe(false);
  });
});

describe('私钥派生公钥（本地密钥环选键）', () => {
  it('派生出的公钥与密钥对的公钥、keyId 完全一致', async () => {
    const pair = await generateBackupKeyPair();
    expect(await publicKeyFromPrivate(pair.privateKey)).toBe(pair.publicKey);
    expect(await backupKeyId(pair.publicKey)).toBe(pair.keyId);
  });
});
