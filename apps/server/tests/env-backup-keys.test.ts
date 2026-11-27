/**
 * 默认备份公钥解析：单值、空值与形状校验。
 *
 * `BACKUP_PUBLIC_KEY` 只用于首次启动播种，解析层只做形状校验与去空白；
 * 真正的可用性由 WebCrypto 导入决定，见 backup-crypto 测试。
 */
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
import { generateBackupKeyPair } from '../src/lib/backup-crypto';

describe('默认备份公钥解析', () => {
  it('单值公钥原样保留（含首尾空白去除）', async () => {
    const pair = await generateBackupKeyPair();
    const env = loadEnv({ backupPublicKey: `  ${pair.publicKey}  ` });
    expect(env.backupPublicKey).toBe(pair.publicKey);
  });

  it('空值表示未提供默认公钥', () => {
    expect(loadEnv({ backupPublicKey: '   ' }).backupPublicKey).toBe('');
    expect(loadEnv().backupPublicKey).toBe('');
  });

  it('形状不合法（粘贴私钥 / 带换行 / 逗号列表）直接报错，不静默吞掉', () => {
    expect(() => loadEnv({ backupPublicKey: 'not-a-base64-key' })).toThrow(/base64/);
    expect(() =>
      loadEnv({ backupPublicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\nAAAA' }),
    ).toThrow(/base64/);
    // 复数列表已废弃：逗号分隔会被形状校验拦下，防止误当成旧锚点配置。
    expect(() => loadEnv({ backupPublicKey: 'abc,def' })).toThrow(/base64/);
  });
});
