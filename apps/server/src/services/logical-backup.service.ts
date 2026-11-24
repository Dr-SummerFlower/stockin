/**
 * 逻辑备份服务：把业务表数据加密、分块、异步写入 backup_* 表。
 *
 * 设计约束（用户拍板 + Workers 免费额度）：
 *  - 每次触发先建 job + backup（building），返回 jobId；数据由一个异步 tick
 *    状态机逐块推进，绝不在单请求里序列化整库（10ms CPU 上限）。
 *  - 每个 tick 只处理有限个 chunk；游标 (cursor_table, cursor_rowid, chunk_seq)
 *    落库，DO alarm 在进程存活期间可跨 tick 续跑。数据密钥只存在进程内缓存，
 *    服务端无私钥、无法解封持久化信封，因此进程重启 / DO 驱逐会中断当前 job
 *    并在下次 tick 标记失败（需重新触发）；这是「无私钥」约束下的既定取舍。
 *  - 备份范围 = Repository 白名单（排除 backup_* 与 sessions/admin_sessions）。
 *  - 数据密钥每次随机，用公钥封装；明文只在本进程短暂存在。
 *  - 完成态计算 manifest 摘要、GC 保留 5 份；物理快照（Node 文件 / Workers
 *    PITR）作为容灾兜底，按管理员配置的物理间隔生成，与定时入口共用到期判定。
 *
 * 本服务只依赖端口与 Repository，不认识任何平台 API；调度由
 * `BackgroundTaskScheduler` 注入，触发方只调用 `enqueue()`。
 */
import { ErrorCode } from '@stockin/shared';
import { randomUUID } from 'node:crypto';
import type { Env } from '../env';
import type { Db } from '../repositories/db';
import { immediateTransaction } from '../repositories/db';
import { SCHEMA_EXPECTED } from '../repositories/schema';
import type { SettingsRepository } from '../repositories/settings.repository';
import type { OperationLogRepository } from '../repositories/operation-log.repository';
import type { MetaRepository } from '../repositories/meta.repository';
import {
  LOGICAL_BACKUP_CHUNK_ROWS,
  LOGICAL_BACKUP_FORMAT_VERSION,
  LOGICAL_BACKUP_KEEP_COUNT,
  LogicalBackupRepository,
  type BackupChunkRow,
  type BackupJobRow,
  type BackupRow,
} from '../repositories/logical-backup.repository';
import {
  createBackupDataKey,
  encryptBackupChunk,
  type WrappedKeyMaterial,
} from '../lib/backup-crypto';
import {
  BACKUP_WIRE_VERSION,
  chunkAad,
  encodeChunkPlaintext,
  manifestDigest,
  type BackupFileChunk,
  type BackupFileMeta,
  type ChunkPlaintext,
  type ManifestEntry,
} from '../lib/backup-format';
import { utcNowIso } from '../lib/today';
import { logger } from '../lib/logger';
import type { ServiceResult } from '../app';
import type { BackgroundTaskScheduler } from '../runtime/ports';
import type { BackupService } from './backup.service';

export interface LogicalBackupServiceDeps {
  readonly db: Db;
  readonly env: Env;
  readonly repo: LogicalBackupRepository;
  readonly settings: SettingsRepository;
  readonly meta: MetaRepository;
  readonly logs: OperationLogRepository;
  readonly scheduler: BackgroundTaskScheduler;
  /** 物理快照端口（危险操作/每次备份前刷新），可选：未注入时跳过。 */
  readonly physicalBackup?: BackupService;
}

/** job 的对外状态（不含游标等内部字段）。 */
export interface LogicalBackupJobView {
  readonly jobId: string;
  readonly backupId: string | null;
  readonly status: BackupJobRow['status'];
  readonly chunkSeq: number;
  readonly totalChunks: number | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

/** ready 备份的元数据（供列表 / 前端展示，无密钥材料）。 */
export interface LogicalBackupMeta {
  readonly id: string;
  readonly schemaVersion: number;
  readonly keyId: string;
  readonly createdAt: string;
  readonly chunkCount: number;
  readonly plainBytes: number;
  readonly manifestSha256: string | null;
  readonly formatVersion: number;
}

export interface LogicalBackupListResult {
  readonly items: readonly LogicalBackupMeta[];
  readonly keepCount: number;
  readonly intervalDays: number;
  readonly enabled: boolean;
  readonly lastBackupAt: string | null;
  readonly activeJob: LogicalBackupJobView | null;
}

/** 单个 tick 默认推进的 chunk 数（控制单次 CPU / 内存占用）。 */
const DEFAULT_CHUNKS_PER_TICK = 2;
/** 调度器延迟：给当前请求返回留时间，也让多次入队合并。 */
const SCHEDULE_DELAY_MS = 25;

/** 每份逻辑备份的明文上限（256MB，上限保护，防Gemini 记录异常膨胀撑爆 DO）。 */
const MAX_PLAIN_BYTES = 256 * 1024 * 1024;

export class LogicalBackupService {
  constructor(private readonly deps: LogicalBackupServiceDeps) {}

  /** 逻辑备份是否可用（公钥已配置）。 */
  get enabled(): boolean {
    return this.deps.env.backupPublicKey.trim() !== '';
  }

  /**
   * 入队一次逻辑备份。已有 active job 时返回 COMMON_BUSY（不排队双份）。
   * 成功返回 jobId，数据由调度器异步推进。
   */
  async enqueue(reason: string, requestId = ''): Promise<ServiceResult<{ jobId: string }>> {
    if (!this.enabled) {
      return { ok: false, code: ErrorCode.COMMON_FORBIDDEN, details: { reason: '备份公钥未配置' } };
    }
    let wrapped: WrappedKeyMaterial;
    let dataKey: CryptoKey;
    try {
      const created = await createBackupDataKey(this.deps.env.backupPublicKey);
      wrapped = created.wrapped;
      dataKey = created.dataKey;
    } catch (error) {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        '[logical-backup] 数据密钥封装失败',
      );
      return { ok: false, code: ErrorCode.COMMON_INTERNAL };
    }

    const jobId: string = `job-${randomUUID()}`;
    const backupId: string = `bk-${randomUUID()}`;
    const now: string = utcNowIso();

    const conflict: ServiceResult<{ jobId: string }> | null = immediateTransaction(
      this.deps.db,
      () => {
        // busy 判定必须在事务内、与 createJob 同一临界区：此前在 await
        // createBackupDataKey() 之前做检查，两个并发请求都可能通过检查并各建一个
        // job。数据密钥生成是异步的无法放进同步事务，但「检查 + 落库」可以，
        // 单写者事务保证并发入队只有一个成功，其余返回 COMMON_BUSY。
        if (this.deps.repo.hasActiveJob()) {
          return { ok: false, code: ErrorCode.COMMON_BUSY };
        }
        // 登记数据密钥供后续 tick 复用（进程内内存缓存，重启则本次 job 失败可重试）。
        cacheDataKey(backupId, dataKey);
        const job: BackupJobRow = {
          id: jobId,
          kind: 'logical',
          status: 'pending',
          cursor_table: null,
          cursor_rowid: null,
          chunk_seq: 0,
          total_chunks: null,
          error: null,
          created_at: now,
          updated_at: now,
          finished_at: null,
        };
        const backup: BackupRow = {
          id: backupId,
          job_id: jobId,
          format_version: LOGICAL_BACKUP_FORMAT_VERSION,
          schema_version: SCHEMA_EXPECTED,
          key_id: wrapped.keyId,
          ephemeral_public_key: wrapped.ephemeralPublicKey,
          kdf_salt: wrapped.kdfSalt,
          wrapped_key_iv: wrapped.iv,
          wrapped_key_ciphertext: wrapped.ciphertext,
          wrapped_key_tag: wrapped.tag,
          created_at: now,
          chunk_count: 0,
          plain_bytes: 0,
          manifest_sha256: null,
          status: 'building',
        };
        this.deps.repo.createJob(job);
        this.deps.repo.createBackup(backup);
        this.deps.logs.append({
          action: 'BACKUP_CREATE' as never,
          targetType: 'backup' as never,
          targetId: null,
          detail: { kind: 'logical', jobId, backupId, reason, status: 'enqueued' },
          requestId,
          actor: 'system',
          occurredAt: now,
        });
        return null; // null 表示创建成功（无冲突）。
      },
    );

    if (conflict !== null) {
      return conflict;
    }
    this.deps.scheduler.schedule(SCHEDULE_DELAY_MS);
    return { ok: true, data: { jobId } };
  }

  /**
   * 推进一个 job 若干 chunk。返回是否还有未完成工作（供调度器决定是否续调度）。
   * 幂等：重复调用只读游标之后的数据。
   */
  async tick(maxChunks: number = DEFAULT_CHUNKS_PER_TICK): Promise<boolean> {
    const job: BackupJobRow | undefined = this.deps.repo.nextRunnableJob();
    if (job === undefined) {
      return false;
    }
    const backup: BackupRow | undefined = this.findBackupByJob(job.id);
    if (backup === undefined) {
      this.failJob(job, '无法找到对应 backup 记录');
      return false;
    }

    const tables: string[] = this.deps.repo.listTables();
    try {
      let processed = 0;
      let cursorTable: string | null = job.cursor_table;
      let cursorRowid: number | null = job.cursor_rowid;
      let seq: number = job.chunk_seq;
      let plainBytesTotal: number = 0;
      const previous = this.deps.repo.listChunks(backup.id);
      plainBytesTotal = previous.reduce((sum, chunk) => sum + chunk.plain_bytes, 0);

      while (processed < maxChunks) {
        // 定位当前表：游标为 null 时从首表开始。
        let tableIndex: number = cursorTable === null ? 0 : tables.indexOf(cursorTable);
        if (tableIndex < 0) {
          // 游标表已不在白名单（如迁移删表）：跳到下一张。
          tableIndex = 0;
          cursorTable = null;
          cursorRowid = null;
        }
        if (tableIndex >= tables.length) {
          // 所有表处理完毕 → 收尾。
          await this.finish(backup, job);
          return false;
        }

        const table: string = tables[tableIndex] ?? '';
        const columns: string[] = this.deps.repo.listColumns(table);
        const afterRowid: number = cursorRowid ?? 0;
        const rows = this.deps.repo.readRows(table, afterRowid, LOGICAL_BACKUP_CHUNK_ROWS);

        if (rows.length === 0) {
          // 当前表读完，切下一张表。
          cursorTable = tables[tableIndex + 1] ?? null;
          cursorRowid = null;
          if (cursorTable === null) {
            await this.finish(backup, job);
            return false;
          }
          continue;
        }

        seq += 1;
        const plain: ChunkPlaintext = {
          v: BACKUP_WIRE_VERSION,
          seq,
          table,
          columns,
          rowStart: rows[0]?.rowid ?? 0,
          rows: rows.map((row) => row.values),
        };
        const plaintext: Uint8Array = encodeChunkPlaintext(plain);
        plainBytesTotal += plaintext.byteLength;
        if (plainBytesTotal > MAX_PLAIN_BYTES) {
          throw new Error(`逻辑备份超过 ${MAX_PLAIN_BYTES} 字节上限，已中止`);
        }

        const encrypted = await encryptBackupChunk(
          await importKeyFromWrapped(this.deps.env.backupPublicKey, backup),
          plaintext,
          chunkAad(backup.id, seq, table),
        );
        const rowStart: number = rows[0]?.rowid ?? 0;

        // chunk 落库与游标推进同一事务，保证崩溃后不重不漏。
        immediateTransaction(this.deps.db, () => {
          this.deps.repo.insertChunk({
            backup_id: backup.id,
            seq,
            table_name: table,
            row_start: rowStart,
            row_count: rows.length,
            iv: encrypted.iv,
            ciphertext: encrypted.ciphertext,
            tag: encrypted.tag,
            plain_bytes: plaintext.byteLength,
            sha256: encrypted.sha256,
          });
          const lastRowid: number = rows[rows.length - 1]?.rowid ?? afterRowid;
          this.deps.repo.updateJobCursor(job.id, table, lastRowid, seq, null);
          this.deps.repo.updateBackupProgress(backup.id, seq, plainBytesTotal);
        });

        cursorTable = table;
        cursorRowid = rows[rows.length - 1]?.rowid ?? afterRowid;
        processed += 1;
      }

      this.deps.scheduler.schedule(SCHEDULE_DELAY_MS);
      return true;
    } catch (error) {
      const message: string = error instanceof Error ? error.message : String(error);
      logger.error({ err: message, jobId: job.id }, '[logical-backup] 分块推进失败');
      this.failJob(job, message);
      return false;
    }
  }

  /** 完成收尾：算 manifest、标记 ready、GC、物理快照兜底。 */
  private async finish(backup: BackupRow, job: BackupJobRow): Promise<void> {
    const chunks = this.deps.repo.listChunks(backup.id);
    const entries: ManifestEntry[] = chunks.map((chunk) => ({
      seq: chunk.seq,
      table: chunk.table_name,
      rowStart: chunk.row_start,
      rowCount: chunk.row_count,
      sha256: chunk.sha256,
      plainBytes: chunk.plain_bytes,
    }));
    const digest: string = await manifestDigest(entries);
    const now: string = utcNowIso();

    immediateTransaction(this.deps.db, () => {
      this.deps.repo.setManifest(backup.id, digest);
      this.deps.repo.updateBackupProgress(
        backup.id,
        chunks.length,
        entries.reduce((sum, entry) => sum + entry.plainBytes, 0),
      );
      this.deps.repo.markBackupReady(backup.id);
      this.deps.repo.finishJob(job.id, 'done', null);
      this.deps.repo.gcReady(LOGICAL_BACKUP_KEEP_COUNT);
      this.deps.repo.gcTerminal(LOGICAL_BACKUP_KEEP_COUNT);
      this.deps.meta.setLastBackup(now, 'ok');
      this.deps.logs.append({
        action: 'BACKUP_CREATE' as never,
        targetType: 'backup' as never,
        targetId: null,
        detail: {
          kind: 'logical',
          backupId: backup.id,
          status: 'ready',
          chunks: chunks.length,
          manifestSha256: digest,
        },
        requestId: '',
        actor: 'system',
        occurredAt: now,
      });
    });

    // 逻辑备份完成后按需刷新物理快照作为整库容灾（异步、失败只告警）。
    // 与定时入口共用 isPhysicalDue()：兜底快照也受管理员配置的物理间隔约束，
    // 不再每次逻辑备份都刷新「最近物理快照时间」而让间隔失效（遗留 A）。
    // 恢复前的 pre-restore 快照不在此列，仍是无条件生成（CONVENTIONS §4）。
    if (this.deps.physicalBackup !== undefined && this.deps.physicalBackup.isPhysicalDue()) {
      try {
        await this.deps.physicalBackup.backupWithoutGate('post-logical-backup', '', 'system');
      } catch (error) {
        logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          '[logical-backup] 物理快照刷新失败（不影响逻辑备份）',
        );
      }
    }
    // 进入终态，释放进程内数据密钥。
    uncacheDataKey(backup.id);
  }

  private failJob(job: BackupJobRow, error: string): void {
    const now: string = utcNowIso();
    immediateTransaction(this.deps.db, () => {
      this.deps.repo.finishJob(job.id, 'failed', error);
      this.deps.repo.gcTerminal(LOGICAL_BACKUP_KEEP_COUNT);
      const backup = this.findBackupByJob(job.id);
      if (backup !== undefined) {
        this.deps.repo.markBackupFailed(backup.id);
      }
      this.deps.meta.setLastBackup(now, 'failed');
      this.deps.logs.append({
        action: 'BACKUP_CREATE' as never,
        targetType: 'backup' as never,
        targetId: null,
        detail: { kind: 'logical', jobId: job.id, status: 'failed', error },
        requestId: '',
        actor: 'system',
        occurredAt: now,
      });
    });
    // 失败也释放密钥；半成品 chunk 交由 gcReady 的终态清理统一回收。
    const failedBackup = this.findBackupByJob(job.id);
    if (failedBackup !== undefined) {
      uncacheDataKey(failedBackup.id);
    }
  }

  /** 按间隔检查是否需要自动入队一次逻辑备份（由定时调度调用）。 */
  async triggerScheduled(
    nowMs: number = Date.now(),
  ): Promise<ServiceResult<{ jobId: string } | null>> {
    if (!this.enabled) {
      return { ok: true, data: null };
    }
    const intervalDays: number = this.deps.settings.getLogicalBackupIntervalDays();
    const elapsed: number = this.deps.repo.millisecondsSinceLastReady(nowMs);
    if (elapsed < intervalDays * 86_400_000) {
      return { ok: true, data: null };
    }
    return this.enqueue('scheduled', '');
  }

  /** ready 备份列表 + 当前活动 job。 */
  list(): ServiceResult<LogicalBackupListResult> {
    const items: LogicalBackupMeta[] = this.deps.repo.listReady().map((row) => ({
      id: row.id,
      schemaVersion: row.schema_version,
      keyId: row.key_id,
      createdAt: row.created_at,
      chunkCount: row.chunk_count,
      plainBytes: row.plain_bytes,
      manifestSha256: row.manifest_sha256,
      formatVersion: row.format_version,
    }));
    const activeJob = this.deps.repo.nextRunnableJob();
    const activeBackup = activeJob === undefined ? undefined : this.findBackupByJob(activeJob.id);
    return {
      ok: true,
      data: {
        items,
        keepCount: LOGICAL_BACKUP_KEEP_COUNT,
        intervalDays: this.deps.settings.getLogicalBackupIntervalDays(),
        enabled: this.enabled,
        lastBackupAt: this.deps.meta.lastBackupAt(),
        activeJob:
          activeJob === undefined
            ? null
            : {
                jobId: activeJob.id,
                backupId: activeBackup?.id ?? null,
                status: activeJob.status,
                chunkSeq: activeJob.chunk_seq,
                totalChunks: activeJob.total_chunks,
                error: activeJob.error,
                createdAt: activeJob.created_at,
                finishedAt: activeJob.finished_at,
              },
      },
    };
  }

  private toFileMeta(backup: BackupRow): BackupFileMeta {
    return {
      kind: 'meta',
      format: 'stockin-logical-backup',
      version: backup.format_version,
      backupId: backup.id,
      schemaVersion: backup.schema_version,
      createdAt: backup.created_at,
      keyId: backup.key_id,
      ephemeralPublicKey: backup.ephemeral_public_key,
      kdfSalt: backup.kdf_salt,
      wrappedKeyIv: backup.wrapped_key_iv,
      wrappedKeyCiphertext: backup.wrapped_key_ciphertext,
      wrappedKeyTag: backup.wrapped_key_tag,
      chunkCount: backup.chunk_count,
      plainBytes: backup.plain_bytes,
      manifestSha256: backup.manifest_sha256 ?? '',
    };
  }

  private toFileChunk(chunk: {
    seq: number;
    table_name: string;
    row_start: number;
    row_count: number;
    iv: string;
    ciphertext: string;
    tag: string;
    sha256: string;
    plain_bytes: number;
  }): BackupFileChunk {
    return {
      kind: 'chunk',
      seq: chunk.seq,
      table: chunk.table_name,
      rowStart: chunk.row_start,
      rowCount: chunk.row_count,
      iv: chunk.iv,
      ciphertext: chunk.ciphertext,
      tag: chunk.tag,
      sha256: chunk.sha256,
      plainBytes: chunk.plain_bytes,
    };
  }

  /**
   * 惰性打开下载流：返回 meta 与「逐行 NDJSON」迭代器，chunk 由调用方按需拉取。
   * 与 buildDownload 的区别是不把全部 chunk 物化成数组，避免 256MB 上限下
   * 在 1G 内存机器 / Workers 上叠加出第二份整包副本。
   */
  openDownload(
    backupId: string,
  ): ServiceResult<{ meta: BackupFileMeta; lines: IterableIterator<string>; count: number }> {
    const backup: BackupRow | undefined = this.deps.repo.getBackup(backupId);
    if (backup === undefined || backup.status !== 'ready') {
      return { ok: false, code: ErrorCode.COMMON_NOT_FOUND };
    }
    const toLine = (chunk: BackupChunkRow): string =>
      `${JSON.stringify(this.toFileChunk(chunk))}\n`;
    const iter = this.deps.repo.iterateChunks(backup.id);
    const lines: IterableIterator<string> = {
      [Symbol.iterator]() {
        return this;
      },
      next(): IteratorResult<string> {
        const next = iter.next();
        if (next.done) {
          return { done: true, value: undefined };
        }
        return { done: false, value: toLine(next.value) };
      },
    };
    return {
      ok: true,
      data: { meta: this.toFileMeta(backup), lines, count: backup.chunk_count },
    };
  }

  /** 构造完整 NDJSON 行（meta + chunks，全部物化）。测试与小程序调用，路由用 openDownload。 */
  buildDownload(
    backupId: string,
  ): ServiceResult<{ meta: BackupFileMeta; chunks: BackupFileChunk[] }> {
    const backup: BackupRow | undefined = this.deps.repo.getBackup(backupId);
    if (backup === undefined || backup.status !== 'ready') {
      return { ok: false, code: ErrorCode.COMMON_NOT_FOUND };
    }
    const chunks: BackupFileChunk[] = this.deps.repo
      .listChunks(backup.id)
      .map((chunk) => this.toFileChunk(chunk));
    return { ok: true, data: { meta: this.toFileMeta(backup), chunks } };
  }

  private findBackupByJob(jobId: string): BackupRow | undefined {
    return this.deps.db.prepare('SELECT * FROM backups WHERE job_id = ?').get(jobId) as
      | BackupRow
      | undefined;
  }
}

/**
 * 从信封里的公钥材料导入数据密钥。
 *
 * 注意：服务端在**同一进程**内重新派生数据密钥是为了加密 chunk —— 用接收方
 * 公钥（env）与随机盐可复现出与封装时相同的 KEK，但数据密钥本身在 enqueue 时
 * 已随机生成并封装。这里更直接的做法是：enqueue 时就把数据密钥 CryptoKey 缓存
 * 在内存 Map，tick 命中直接用。为此提供下面的 DataKeyCache。
 */
const dataKeyCache = new Map<string, CryptoKey>();

/** enqueue 后登记数据密钥（进程内内存缓存；DO 重启则由下方 derive 兜底）。 */
export function cacheDataKey(backupId: string, key: CryptoKey): void {
  dataKeyCache.set(backupId, key);
}

/** 备份进入终态后释放内存密钥；避免模块级 Map 随备份次数无界增长。 */
export function uncacheDataKey(backupId: string): void {
  dataKeyCache.delete(backupId);
}

/** 仅供测试：清理全部缓存密钥。 */
export function clearDataKeyCache(): void {
  dataKeyCache.clear();
}

/** tick 取数据密钥：优先内存缓存；缺失时用公钥+信封信息重新派生（密钥封装的逆过程在本地脚本，服务端无私钥）。 */
async function importKeyFromWrapped(_publicKey: string, backup: BackupRow): Promise<CryptoKey> {
  const cached: CryptoKey | undefined = dataKeyCache.get(backup.id);
  if (cached !== undefined) {
    return cached;
  }
  // 服务端没有私钥，无法解封已随机生成的数据密钥。此处只能报错，提示调用方
  // 保证 enqueue 与 tick 在同一进程（Worker 单 DO / Node 单进程内成立）。
  throw new Error(
    `[logical-backup] 数据密钥缓存缺失（backup=${backup.id}），` +
      'enqueue 与 tick 必须落在同一进程；DO 重启会中断当前备份，需重新触发',
  );
}
