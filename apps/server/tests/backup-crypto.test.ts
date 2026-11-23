import { describe, expect, it } from 'vitest';
import {
  createBackupDataKey,
  decryptBackupChunk,
  encryptBackupChunk,
  generateBackupKeyPair,
  unwrapBackupDataKey,
} from '../src/lib/backup-crypto';

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
