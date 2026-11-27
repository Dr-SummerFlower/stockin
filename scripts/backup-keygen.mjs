#!/usr/bin/env node
/**
 * 生成逻辑备份用的 P-256 密钥对（可重复执行 = 轮换）。
 *
 * 输出（默认项目根 `.keys/`，已 gitignore；按 CONVENTIONS §4，读取该目录需用户明确同意）：
 *   <keyId>.public.key   —— DER/SPKI base64，粘贴到管理台「备份公钥」；
 *                           首次启动也可用 GitHub Secret BACKUP_PUBLIC_KEY 播种
 *   <keyId>.private.key  —— DER/PKCS#8 base64，只保存在本地，不提交、不部署
 *   active               —— 单行 keyId，`backup-local` 默认用它签恢复票据
 *
 * 与旧版的关键差异：**文件名带 keyId，不再覆盖同一路径**。
 *   - 旧版靠 `--force` 覆盖 backup-public.key / backup-private.key，覆盖即等于
 *     「旧备份永久解不开」，属于不可逆事故；
 *   - 现在每次执行都新增一对密钥文件，旧文件原地不动，轮换不存在覆盖风险；
 *   - 首把密钥自动成为 active；之后要切换签名密钥必须显式 `--activate`。
 *
 * 用法：node scripts/backup-keygen.mjs [outDir] [--activate]
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const activate = args.includes('--activate');
const outDir = resolve(args.find((arg) => !arg.startsWith('--')) ?? '.keys');
mkdirSync(outDir, { recursive: true });

const subtle = globalThis.crypto.subtle;
const b64 = (bytes) => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};
const sha256 = async (bytes) =>
  new Uint8Array(await subtle.digest('SHA-256', bytes))
    .reduce((hex, byte) => hex + byte.toString(16).padStart(2, '0'), '')
    .slice(0, 32);

const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const publicDer = new Uint8Array(await subtle.exportKey('spki', pair.publicKey));
const privateDer = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
const keyId = await sha256(publicDer);

const publicPath = join(outDir, `${keyId}.public.key`);
const privatePath = join(outDir, `${keyId}.private.key`);
const activePath = join(outDir, 'active');

// keyId 是公钥摘要，路径冲突意味着同一把密钥已存在——直接报错，不覆盖。
if (existsSync(publicPath) || existsSync(privatePath)) {
  process.stderr.write(
    `[backup-keygen] 该密钥已存在（keyId=${keyId}），拒绝覆盖：${outDir}\n` +
      '  如需新密钥请直接重新执行（不会覆盖任何已有文件）。\n',
  );
  process.exit(1);
}

writeFileSync(publicPath, `${b64(publicDer)}\n`, { encoding: 'utf8', mode: 0o644 });
writeFileSync(privatePath, `${b64(privateDer)}\n`, { encoding: 'utf8', mode: 0o600 });
chmodSync(privatePath, 0o600);

const previousActive = existsSync(activePath)
  ? readFileSync(activePath, 'utf8').trim()
  : '';
const becomesActive = previousActive === '' || activate;
if (becomesActive) {
  writeFileSync(activePath, `${keyId}\n`, { encoding: 'utf8', mode: 0o644 });
}

process.stdout.write(
  `[backup-keygen] 生成完成\n` +
    `  key id: ${keyId}\n` +
    `  公钥: ${publicPath}\n` +
    `  私钥: ${privatePath}（只保存在本地，备份好，不要提交）\n` +
    (becomesActive
      ? `  active: 已设为 ${keyId}（恢复票据用它签名）\n`
      : `  active: 仍是 ${previousActive}；本次生成的密钥未启用为签名密钥\n`) +
    (previousActive !== '' && !activate
      ? '  要把它设为签名密钥：加 --activate 重新执行，或手工写 active 文件。\n'
      : '') +
    '  下一步：把公钥内容粘贴到管理台「备份公钥」→ 添加（日常轮换都在这里做）。\n' +
    '  全新实例若还没进管理台，也可写入 GitHub Secret BACKUP_PUBLIC_KEY 作首次播种\n' +
    '  （Workers 侧由 CI 用 `wrangler secret put` 注入；详见 README「备份密钥轮换」）。\n',
);
