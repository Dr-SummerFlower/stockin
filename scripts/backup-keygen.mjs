#!/usr/bin/env node
/**
 * 生成逻辑备份用的 P-256 密钥对。
 *
 * 输出：
 *   <outDir>/backup-public.key   —— DER/SPKI base64，写入 GitHub Secret BACKUP_PUBLIC_KEY
 *   <outDir>/backup-private.key  —— DER/PKCS#8 base64，只保存在本地，不提交、不部署
 *
 * 默认输出到项目根 `.keys/`（已 gitignore；按 CONVENTIONS §4，读取该目录需用户明确同意）。
 * 目录内已有密钥时默认拒绝生成，避免误覆盖导致既有备份永久无法解密；确需轮换用 --force。
 *
 * 用法：node scripts/backup-keygen.mjs [outDir] [--force]
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const force = process.argv.includes('--force');
const outDir = resolve(
  process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? '.keys',
);
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

const publicPath = join(outDir, 'backup-public.key');
const privatePath = join(outDir, 'backup-private.key');

// 覆盖即等于轮换：旧备份只能由旧私钥解密，静默覆盖会造成不可逆的数据可用性事故。
if (!force && (existsSync(publicPath) || existsSync(privatePath))) {
  process.stderr.write(
    `[backup-keygen] 已存在密钥文件，拒绝覆盖：${outDir}\n` +
      `  覆盖会让既有逻辑备份永久无法解密。确需轮换请显式加 --force，\n` +
      `  并先备份旧私钥（轮换流程见 .tmp/待办/03-部署BACKUP_PUBLIC_KEY.md）。\n`,
  );
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
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
