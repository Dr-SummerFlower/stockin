#!/usr/bin/env node
/**
 * 生成逻辑备份用的 P-256 密钥对。
 *
 * 输出：
 *   <outDir>/backup-public.key   —— DER/SPKI base64，写入 GitHub Secret BACKUP_PUBLIC_KEY
 *   <outDir>/backup-private.key  —— DER/PKCS#8 base64，只保存在本地，不提交、不部署
 *
 * 默认输出到 .tmp/backup-keys/（.tmp 已被 gitignore）。
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const outDir = resolve(process.argv[2] ?? '.tmp/backup-keys');
const subtle = globalThis.crypto.subtle;

const b64 = (bytes) => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const publicDer = new Uint8Array(await subtle.exportKey('spki', pair.publicKey));
const privateDer = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
const digest = new Uint8Array(await subtle.digest('SHA-256', publicDer));
const keyId = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0'))
  .join('')
  .slice(0, 32);

mkdirSync(outDir, { recursive: true });
const publicPath = join(outDir, 'backup-public.key');
const privatePath = join(outDir, 'backup-private.key');
writeFileSync(publicPath, `${b64(publicDer)}\n`, { encoding: 'utf8', mode: 0o644 });
writeFileSync(privatePath, `${b64(privateDer)}\n`, { encoding: 'utf8', mode: 0o600 });
chmodSync(privatePath, 0o600);

process.stdout.write(
  `[backup-keygen] 生成完成\n` +
    `  key id: ${keyId}\n` +
    `  公钥: ${publicPath}\n` +
    `  私钥: ${privatePath}（只保存在本地，备份好，不要提交）\n` +
    `  下一步：把公钥内容写入 GitHub Secret BACKUP_PUBLIC_KEY\n`,
);
