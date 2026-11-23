/**
 * 逻辑备份的**线格式**（服务端写、本地脚本读的共享契约）。
 *
 * 平台无关、零 IO：只做「行 → chunk 明文 → AAD / manifest / NDJSON」的
 * 确定性编码。服务端备份链路与本地解密脚本都以此为准，避免两份解释漂移。
 *
 * 格式版本 v1：
 *  - 每个 chunk 明文是一行 JSON：
 *      {"v":1,"seq":<n>,"table":"<表名>","columns":["c1",...],
 *       "rowStart":<rowid>,"rows":[[v1,v2,...], ...]}
 *    行值按 `columns` 顺序排列；null 直接序列化为 JSON null。
 *  - AAD = `stockin-backup:v1:<backupId>:<seq>:<table>`，绑定位置与来源表。
 *  - manifest = 所有 chunk 摘要的有序数组，规范化 JSON 后再取 sha256 作为整包摘要。
 *  - 下载文件为 NDJSON：第 1 行 meta，其后每行一个 chunk（含定义与密文）。
 */

import { hashBackupBytes } from './backup-crypto';

export const BACKUP_WIRE_VERSION = 1;
export const BACKUP_AAD_PREFIX = 'stockin-backup';
/** 下载格式的文件名后缀（NDJSON 逐行，便于流式解析）。 */
export const BACKUP_FILE_EXTENSION = '.backup.ndjson';

/** 一个 chunk 的明文载荷。 */
export interface ChunkPlaintext {
  readonly v: number;
  readonly seq: number;
  readonly table: string;
  readonly columns: readonly string[];
  readonly rowStart: number;
  readonly rows: readonly (readonly unknown[])[];
}

/** 下载文件第 1 行：元数据 + 密钥信封（全部 base64，无二进制控制字符）。 */
export interface BackupFileMeta {
  readonly kind: 'meta';
  readonly format: 'stockin-logical-backup';
  readonly version: number;
  readonly backupId: string;
  readonly schemaVersion: number;
  readonly createdAt: string;
  readonly keyId: string;
  readonly ephemeralPublicKey: string;
  readonly kdfSalt: string;
  readonly wrappedKeyIv: string;
  readonly wrappedKeyCiphertext: string;
  readonly wrappedKeyTag: string;
  readonly chunkCount: number;
  readonly plainBytes: number;
  readonly manifestSha256: string;
}

/** 下载文件后续每行：一个密文 chunk。 */
export interface BackupFileChunk {
  readonly kind: 'chunk';
  readonly seq: number;
  readonly table: string;
  readonly rowStart: number;
  readonly rowCount: number;
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
  readonly sha256: string;
  readonly plainBytes: number;
}

export type BackupFileLine = BackupFileMeta | BackupFileChunk;

/** manifest 中单个 chunk 的有序摘要条目。 */
export interface ManifestEntry {
  readonly seq: number;
  readonly table: string;
  readonly rowStart: number;
  readonly rowCount: number;
  readonly sha256: string;
  readonly plainBytes: number;
}

/** AAD：绑定备份 ID、序号与来源表，防止 chunk 被跨包/跨序重放。 */
export function chunkAad(backupId: string, seq: number, table: string): string {
  return `${BACKUP_AAD_PREFIX}:v${BACKUP_WIRE_VERSION}:${backupId}:${seq}:${table}`;
}

/** 把行数据编码为确定性 JSON 字节（键顺序固定，便于跨语言复现 sha256）。 */
export function encodeChunkPlaintext(chunk: ChunkPlaintext): Uint8Array {
  const stable: ChunkPlaintext = {
    v: chunk.v,
    seq: chunk.seq,
    table: chunk.table,
    columns: chunk.columns,
    rowStart: chunk.rowStart,
    rows: chunk.rows,
  };
  return new TextEncoder().encode(JSON.stringify(stable));
}

/** manifest 的规范化 JSON 字节（entry 按 seq 升序）。 */
export function encodeManifest(entries: readonly ManifestEntry[]): Uint8Array {
  // 复制后排序，避免修改入参（oxlint 的 toSorted 建议与本仓库 ES 目标冲突，保持 copy + sort）。
  const ordered: ManifestEntry[] = [...entries].sort((a, b) => a.seq - b.seq);
  const stable = ordered.map((entry) => ({
    seq: entry.seq,
    table: entry.table,
    rowStart: entry.rowStart,
    rowCount: entry.rowCount,
    sha256: entry.sha256,
    plainBytes: entry.plainBytes,
  }));
  return new TextEncoder().encode(JSON.stringify(stable));
}

/** 计算整包摘要：manifest 规范化 JSON 的 sha256。 */
export async function manifestDigest(entries: readonly ManifestEntry[]): Promise<string> {
  return hashBackupBytes(encodeManifest(entries));
}

/* ------------------------------------------------------------------ *
 * 恢复包与恢复票据（本地脚本生成，服务端验签 / 消费）
 * ------------------------------------------------------------------ */

/** 恢复票据的签名载荷：字段固定顺序，签名覆盖其规范 JSON 字节。 */
export interface RestoreTicketPayload {
  readonly v: number;
  readonly batchId: string;
  readonly issuedAt: string;
  /** 恢复包全部明文行的规范化 JSON 的 sha256。 */
  readonly dataSha256: string;
  readonly schemaVersion: number;
  readonly keyId: string;
}

/** 落盘的票据文件 = 载荷 + base64 签名。 */
export interface RestoreTicket {
  readonly payload: RestoreTicketPayload;
  readonly signature: string;
}

/** 恢复包的一行：一张表的完整数据（列 + 行值）。 */
export interface RestoreTable {
  readonly kind: 'table';
  readonly table: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
}

/** 恢复包第一行的元信息。 */
export interface RestorePackageMeta {
  readonly kind: 'restore-meta';
  readonly version: number;
  readonly schemaVersion: number;
  readonly keyId: string;
  readonly dataSha256: string;
}

export type RestorePackageLine = RestorePackageMeta | RestoreTable;

/** 票据规范 JSON 字节（字段顺序固定，本地 / 服务端必须一致）。 */
export function encodeTicketPayload(payload: RestoreTicketPayload): Uint8Array {
  const stable: RestoreTicketPayload = {
    v: payload.v,
    batchId: payload.batchId,
    issuedAt: payload.issuedAt,
    dataSha256: payload.dataSha256,
    schemaVersion: payload.schemaVersion,
    keyId: payload.keyId,
  };
  return new TextEncoder().encode(JSON.stringify(stable));
}

/**
 * 恢复包的"数据摘要"：对所有 `table` 行按出现顺序做规范化 JSON 后拼接再 hash。
 * 与票据 dataSha256 对应，用于服务端验证数据未被篡改。
 */
export async function restoreDataDigest(tables: readonly RestoreTable[]): Promise<string> {
  const parts: string[] = tables.map((table) =>
    JSON.stringify({
      kind: 'table',
      table: table.table,
      columns: table.columns,
      rows: table.rows,
    }),
  );
  return hashBackupBytes(new TextEncoder().encode(parts.join('\n')));
}

/** 把一行 NDJSON 解析为恢复包记录；非法行抛错。 */
export function parseRestoreLine(line: string): RestorePackageLine {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('[backup-format] 恢复包行不是对象');
  }
  const kind: unknown = (parsed as { kind?: unknown }).kind;
  if (kind === 'restore-meta') {
    return parsed as RestorePackageMeta;
  }
  if (kind === 'table') {
    return parsed as RestoreTable;
  }
  throw new Error(`[backup-format] 未知恢复包行 kind: ${String(kind)}`);
}

/** 把一行 NDJSON 解析为备份文件记录；非法行抛错。 */
export function parseBackupLine(line: string): BackupFileLine {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('[backup-format] NDJSON 行不是对象');
  }
  const kind: unknown = (parsed as { kind?: unknown }).kind;
  if (kind === 'meta') {
    return parsed as BackupFileMeta;
  }
  if (kind === 'chunk') {
    return parsed as BackupFileChunk;
  }
  throw new Error(`[backup-format] 未知 NDJSON 行 kind: ${String(kind)}`);
}
