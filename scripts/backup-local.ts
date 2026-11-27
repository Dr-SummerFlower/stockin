#!/usr/bin/env node
/**
 * 本地备份工具（私钥永远只在这台机器上出现）。
 *
 * 子命令：
 *   decrypt  --in <backup.ndjson> [--key <private.key> | --key-dir .keys] [--out <dir>]
 *             解封数据密钥 → 逐 chunk 解密 + 校验 sha256 / AAD / manifest →
 *             输出 <dir>/restore-package.ndjson（首行 restore-meta，其后每表一行）。
 *   ticket   --package <restore-package.ndjson> --batch <batchId>
 *             --issued-at <iso> --schema <n> [--key <file> | --key-dir .keys]
 *             [--key-id <keyId>] [--out <file>]
 *             用本地私钥对票据规范字节做 ECDSA 签名，输出 restore-ticket.json。
 *   restore  --origin <https://host> --cookie '<admin-sid=...>' --package <file>
 *             --ticket <file> [--chunk-bytes <n>] [--key <file> | --key-dir .keys]
 *             端到端：POST begin → 分块 PUT → POST commit（票据用本地私钥签名）。
 *
 * 密钥环（推荐）：`.keys/` 下按 `<keyId>.private.key` 存放多把私钥。
 *   - decrypt 按备份 meta 的 keyId **自动选键**，所以轮换后旧备份照样能解；
 *   - ticket / restore 默认用 `.keys/active` 指向的签名密钥，也可 `--key-id` 指定。
 *   未指定 --key / --key-dir 时默认用项目根 `.keys/`。
 *
 * 说明：所有解密 / 验签 / 票据签名都只发生在本地；服务端只拿到公钥与已签名数据。
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  backupKeyId,
  decryptBackupChunk,
  hashBackupBytes,
  publicKeyFromPrivate,
  unwrapBackupDataKey,
  signRestoreTicket,
} from '../apps/server/src/lib/backup-crypto';
import {
  BACKUP_WIRE_VERSION,
  chunkAad,
  encodeManifest,
  encodeTicketPayload,
  ensureAllRestoreTables,
  parseBackupLine,
  restoreDataDigest,
  type BackupFileMeta,
  type RestoreTable,
  type RestoreTicket,
} from '../apps/server/src/lib/backup-format';
import { RESTORE_TABLES } from '../apps/server/src/repositories/restore.repository';

function arg(name: string, required = true): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0) {
    if (required) {
      throw new Error(`缺少参数 --${name}`);
    }
    return undefined;
  }
  const value = process.argv[idx + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`参数 --${name} 缺少值`);
  }
  return value;
}

function readText(file: string): string {
  return readFileSync(path.resolve(file), 'utf8').trim();
}

/** ------------------------------- 密钥环 -------------------------------- */

interface KeyringEntry {
  readonly keyId: string;
  readonly privateKey: string;
  readonly file: string;
}

/** 默认密钥目录：未显式给 --key / --key-dir 时用项目根 `.keys/`。 */
const DEFAULT_KEY_DIR = '.keys';

/**
 * 读取密钥环：目录内所有 `*.private.key` 与历史单文件 `backup-private.key`。
 *
 * keyId 由私钥派生出的公钥现算，因此旧文件无需改名即可被索引；顺序稳定
 * （按文件名排序），但选键只按 keyId 精确匹配，不依赖顺序。
 */
async function readKeyring(dir: string): Promise<KeyringEntry[]> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    throw new Error(`密钥目录不存在或不可读: ${dir}（用 --key-dir 指定，或 --key 指定单个私钥文件）`);
  }
  const files: string[] = names
    .filter((name) => name.endsWith('.private.key') || name === 'backup-private.key')
    .sort();
  if (files.length === 0) {
    throw new Error(`密钥目录里没有私钥文件（*.private.key）：${dir}`);
  }
  const ring: KeyringEntry[] = [];
  for (const name of files) {
    const file = path.join(dir, name);
    const privateKey = readText(file);
    const keyId = await backupKeyId(await publicKeyFromPrivate(privateKey));
    ring.push({ keyId, privateKey, file });
  }
  return ring;
}

/** 显式 `--key` 的私钥内容（同时给出其 keyId，便于与备份 meta 比对）。 */
async function explicitKey(): Promise<KeyringEntry | null> {
  const file = arg('key', false);
  if (file === undefined) {
    return null;
  }
  const privateKey = readText(file);
  const keyId = await backupKeyId(await publicKeyFromPrivate(privateKey));
  return { keyId, privateKey, file: path.resolve(file) };
}

/** 解密用私钥：优先 `--key`，否则按备份 meta 的 keyId 在密钥环里精确匹配。 */
async function resolveDecryptKey(backupKeyIdInMeta: string): Promise<KeyringEntry> {
  const explicit = await explicitKey();
  if (explicit !== null) {
    if (explicit.keyId.toLowerCase() !== backupKeyIdInMeta.toLowerCase()) {
      throw new Error(
        `--key 指定的私钥与备份不匹配：备份 keyId=${backupKeyIdInMeta}，` +
          `该私钥 keyId=${explicit.keyId}。请改用备份对应的私钥（或用 --key-dir 让脚本自动选键）`,
      );
    }
    return explicit;
  }
  const dir = path.resolve(arg('key-dir', false) ?? DEFAULT_KEY_DIR);
  const ring = await readKeyring(dir);
  const hit = ring.find(
    (entry) => entry.keyId.toLowerCase() === backupKeyIdInMeta.toLowerCase(),
  );
  if (hit === undefined) {
    throw new Error(
      `密钥环里没有能解封该备份的私钥（备份 keyId=${backupKeyIdInMeta}）。\n` +
        `  ${dir} 现有 keyId: ${ring.map((entry) => entry.keyId).join(', ')}\n` +
        '  轮换后旧备份仍需要旧私钥：把旧的 `<keyId>.private.key` 放回该目录即可。',
    );
  }
  return hit;
}

/** 签名用私钥（ticket / restore）：`--key` > `--key-id` > `.keys/active` > 唯一私钥。 */
async function resolveSigningKey(): Promise<KeyringEntry> {
  const explicit = await explicitKey();
  if (explicit !== null) {
    return explicit;
  }
  const dir = path.resolve(arg('key-dir', false) ?? DEFAULT_KEY_DIR);
  const ring = await readKeyring(dir);
  const wanted = arg('key-id', false);
  if (wanted !== undefined) {
    const hit = ring.find((entry) => entry.keyId.toLowerCase() === wanted.toLowerCase());
    if (hit === undefined) {
      throw new Error(
        `--key-id ${wanted} 不在密钥环里；现有 keyId: ${ring.map((entry) => entry.keyId).join(', ')}`,
      );
    }
    return hit;
  }
  let active = '';
  try {
    active = readText(path.join(dir, 'active'));
  } catch {
    active = '';
  }
  if (active !== '') {
    const hit = ring.find((entry) => entry.keyId.toLowerCase() === active.toLowerCase());
    if (hit === undefined) {
      throw new Error(
        `active 指向 ${active}，但该私钥不在密钥环里；` +
          `现有 keyId: ${ring.map((entry) => entry.keyId).join(', ')}`,
      );
    }
    return hit;
  }
  if (ring.length === 1) {
    return ring[0] as KeyringEntry;
  }
  throw new Error(
    `密钥环里有 ${ring.length} 把私钥且没有 active 指针，无法确定签名密钥；` +
      '请用 --key-id 指定，或在密钥目录写入 active 文件',
  );
}

/** ------------------------------- decrypt -------------------------------- */
async function cmdDecrypt(): Promise<void> {
  const input = readText(arg('in')!);
  const outDir = path.resolve(arg('out', false) ?? '.tmp/restore');
  mkdirSync(outDir, { recursive: true });

  const lines = input.split('\n').filter((line) => line.trim() !== '');
  const metaLine = parseBackupLine(lines[0] ?? '');
  if (metaLine.kind !== 'meta') {
    throw new Error('备份文件首行不是 meta');
  }
  const meta = metaLine as BackupFileMeta;
  if (meta.version !== BACKUP_WIRE_VERSION) {
    throw new Error(`不支持的备份格式版本: ${meta.version}`);
  }

  // 先按 keyId 选私钥：轮换后旧备份仍能解，选错时给出可操作的错误而不是 GCM 认证失败。
  const key = await resolveDecryptKey(meta.keyId);
  const dataKey = await unwrapBackupDataKey(key.privateKey, {
    keyId: meta.keyId,
    ephemeralPublicKey: meta.ephemeralPublicKey,
    kdfSalt: meta.kdfSalt,
    iv: meta.wrappedKeyIv,
    ciphertext: meta.wrappedKeyCiphertext,
    tag: meta.wrappedKeyTag,
  });

  // 按表聚合并校验每个 chunk 的 sha256 与 AAD。
  const byTable = new Map<string, RestoreTable>();
  const manifestEntries: {
    seq: number;
    table: string;
    rowStart: number;
    rowCount: number;
    sha256: string;
    plainBytes: number;
  }[] = [];
  let seenSeq = 0;
  for (let i = 1; i < lines.length; i += 1) {
    const line = parseBackupLine(lines[i] ?? '');
    if (line.kind !== 'chunk') {
      throw new Error(`第 ${i + 1} 行不是 chunk`);
    }
    if (line.seq !== seenSeq + 1) {
      throw new Error(`chunk 序号不连续: 期望 ${seenSeq + 1}，实际 ${line.seq}`);
    }
    seenSeq = line.seq;
    const plain = await decryptBackupChunk(
      dataKey,
      { iv: line.iv, ciphertext: line.ciphertext, tag: line.tag },
      chunkAad(meta.backupId, line.seq, line.table),
    );
    const digest = await hashBackupBytes(plain);
    if (digest !== line.sha256) {
      throw new Error(`chunk ${line.seq} sha256 不匹配`);
    }
    const payload = JSON.parse(new TextDecoder().decode(plain)) as {
      v: number;
      seq: number;
      table: string;
      columns: string[];
      rowStart: number;
      rows: unknown[][];
    };
    if (payload.table !== line.table || payload.seq !== line.seq) {
      throw new Error(`chunk ${line.seq} 内容与元数据不一致`);
    }
    const existing = byTable.get(line.table);
    if (existing === undefined) {
      byTable.set(line.table, {
        kind: 'table',
        table: line.table,
        columns: payload.columns,
        rows: payload.rows,
      });
    } else {
      (existing.rows as unknown[][]).push(...payload.rows);
    }
    manifestEntries.push({
      seq: line.seq,
      table: line.table,
      rowStart: line.rowStart,
      rowCount: line.rowCount,
      sha256: line.sha256,
      plainBytes: line.plainBytes,
    });
  }
  if (seenSeq !== meta.chunkCount) {
    throw new Error(`chunk 数量不匹配: meta=${meta.chunkCount}，实际=${seenSeq}`);
  }
  // manifest 摘要校验（与服务端收尾时一致）。
  const manifestDigest = await hashBackupBytes(encodeManifest(manifestEntries));
  if (manifestDigest !== meta.manifestSha256) {
    throw new Error('manifest 摘要不匹配，备份可能已被篡改');
  }

  // 全量替换语义要求恢复包恒定覆盖 RESTORE_TABLES 全部表：零行的表不会产生
  // chunk，若不在包里显式列出，服务端 restoreAll 先清空该表又不会回填，构成
  // 半恢复。ensureAllRestoreTables 为缺失表补空表条目（rows 为空时服务端跳过插入）。
  const tables: RestoreTable[] = ensureAllRestoreTables([...byTable.values()], RESTORE_TABLES);
  const dataSha256 = await restoreDataDigest(tables);
  const restoreLines = [
    JSON.stringify({
      kind: 'restore-meta',
      version: BACKUP_WIRE_VERSION,
      schemaVersion: meta.schemaVersion,
      keyId: meta.keyId,
      dataSha256,
    }),
    ...tables.map((table) => JSON.stringify(table)),
  ];
  const packagePath = path.join(outDir, 'restore-package.ndjson');
  writeFileSync(packagePath, `${restoreLines.join('\n')}\n`, 'utf8');
  writeFileSync(
    path.join(outDir, 'restore-package.info.json'),
    `${JSON.stringify({ backupId: meta.backupId, schemaVersion: meta.schemaVersion, keyId: meta.keyId, dataSha256 }, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(
    `[decrypt] 完成：${tables.length} 张表，keyId=${meta.keyId}（用 ${key.file}），` +
      `dataSha256=${dataSha256}\n` +
      `  恢复包: ${packagePath}\n`,
  );
}

/** -------------------------------- ticket -------------------------------- */
async function cmdTicket(): Promise<void> {
  const packageText = readText(arg('package')!);
  const batchId = arg('batch')!;
  const issuedAt = arg('issued-at')!;
  const schemaVersion = Number.parseInt(arg('schema')!, 10);
  const key = await resolveSigningKey();
  const tables: RestoreTable[] = packageText
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RestoreTable)
    .filter((row) => row.kind === 'table');
  const dataSha256 = await restoreDataDigest(tables);
  const metaRow = packageText
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line) as { kind?: string; keyId?: string; dataSha256?: string };
      } catch {
        return {};
      }
    })
    .find((row) => row.kind === 'restore-meta');
  // 签名前必须校验恢复包摘要：decrypt 阶段已把可信摘要写入 restore-meta。
  // 若 decrypt 与 ticket 之间包被篡改，重算值与 meta 不符即拒绝签名，避免把
  // 篡改后的数据摘要签进票据（服务端只校验「上传数据 == 票据摘要」，否则会放行）。
  if (metaRow?.dataSha256 !== dataSha256) {
    throw new Error(
      `恢复包摘要与 restore-meta 不符（meta=${metaRow?.dataSha256 ?? '缺失'}，` +
        `实际=${dataSha256}），包可能已被篡改，拒绝签名`,
    );
  }
  const payload = {
    v: BACKUP_WIRE_VERSION,
    batchId,
    issuedAt,
    dataSha256,
    schemaVersion,
    keyId: metaRow?.keyId ?? '',
  };
  const signature = await signRestoreTicket(key.privateKey, encodeTicketPayload(payload));
  const ticket: RestoreTicket = { payload, signature };
  const outFile = path.resolve(arg('out', false) ?? '.tmp/restore/restore-ticket.json');
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(ticket, null, 2)}\n`, 'utf8');
  process.stdout.write(`[ticket] 已生成: ${outFile}（签名 keyId=${key.keyId}）\n`);
}

/** -------------------------------- restore -------------------------------- */
async function cmdRestore(): Promise<void> {
  const origin = arg('origin')!.replace(/\/$/, '');
  const cookie = arg('cookie')!;
  const packageText = readText(arg('package')!);
  const ticket = JSON.parse(readText(arg('ticket')!)) as RestoreTicket;
  const chunkBytes = Number.parseInt(arg('chunk-bytes', false) ?? '65536', 10);

  // 上传前再校验一次：恢复包当前内容的摘要必须与待签票据的 dataSha256 一致，
  // 防止 ticket 之后包被替换，导致服务端按旧摘要放行被篡改的数据。
  const uploadTables: RestoreTable[] = packageText
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RestoreTable)
    .filter((row) => row.kind === 'table');
  const uploadDigest = await restoreDataDigest(uploadTables);
  if (uploadDigest !== ticket.payload.dataSha256) {
    throw new Error(
      `恢复包摘要与票据不符（票据=${ticket.payload.dataSha256}，实际=${uploadDigest}），拒绝上传`,
    );
  }

  const headers: Record<string, string> = {
    cookie,
    origin,
    'content-type': 'application/json',
  };
  const api = async (p: string, init: RequestInit): Promise<Response> => {
    const res = await fetch(`${origin}${p}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
    });
    if (!res.ok) {
      throw new Error(`${p} 返回 ${res.status}: ${await res.text()}`);
    }
    return res;
  };

  // 1) begin：拿到 batchId 与服务端 issuedAt（票据必须用这个 issuedAt 签）。
  const begun = (await (await api('/api/admin/restore/begin', { method: 'POST' })).json()) as {
    batchId: string;
    issuedAt: string;
  };

  // 重新签名票据（票据里的 batchId / issuedAt 必须与本次批次一致）。
  const key = await resolveSigningKey();
  const originalPayload = ticket.payload;
  const resignPayload = {
    ...originalPayload,
    batchId: begun.batchId,
    issuedAt: begun.issuedAt,
  };
  const signature = await signRestoreTicket(key.privateKey, encodeTicketPayload(resignPayload));
  const finalTicket: RestoreTicket = { payload: resignPayload, signature };

  // 2) 分块上传明文恢复包。
  const bytes = new TextEncoder().encode(`${packageText}\n`);
  let seq = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
    const slice = bytes.subarray(offset, offset + chunkBytes);
    await api(`/api/admin/restore/${begun.batchId}/chunk/${seq}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: slice,
    });
    seq += 1;
  }

  // 3) commit。
  const result = (await (
    await api('/api/admin/restore/commit', {
      method: 'POST',
      body: JSON.stringify({ batchId: begun.batchId, ticket: finalTicket }),
    })
  ).json()) as { restoredTables: number; restoredRows: number };
  process.stdout.write(
    `[restore] 完成：恢复 ${result.restoredTables} 张表 / ${result.restoredRows} 行；请用管理员账号重新登录\n`,
  );
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'decrypt') {
    await cmdDecrypt();
  } else if (command === 'ticket') {
    await cmdTicket();
  } else if (command === 'restore') {
    await cmdRestore();
  } else {
    throw new Error(`未知子命令: ${String(command)}（可选 decrypt / ticket / restore）`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[backup-local] 失败: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
