/**
 * 恢复服务：验签票据 → 校验数据 → 防重放 → 危险操作前物理快照 → 全量恢复。
 *
 * 私钥只在本地脚本中：服务端仅持有公钥，用 ECDSA 验证本地对票据的签名。
 * 数据以明文 NDJSON 分块上传到 staging，commit 时逐块流式解析（不整包拼接）、
 * 校验摘要，再在 RestoreRepository 的单事务里全量重建（清空会话）。
 *
 * 时间窗口：票据 issuedAt 与服务端当前时间差不得超过 TICKET_WINDOW_MS。
 * 防重放：所有校验（验签 / 时间窗 / schema / 数据摘要）通过后消费 batchId，
 *   校验失败不消费以便重试；消费成功后进入破坏性恢复，票据一次性不可重放。
 * 回滚点：Node 下要求恢复前物理快照必须成功（skipped 即中止）；Workers 下以
 *   平台 PITR 作为托管回滚点并记日志，不伪造应用侧快照。
 */
import { ErrorCode } from '@stockin/shared';
import { randomUUID } from 'node:crypto';
import type { Db } from '../repositories/db';
import { immediateTransaction, ensureQueryPlannerStats } from '../repositories/db';
import { SCHEMA_EXPECTED } from '../repositories/schema';
import type { OperationLogRepository } from '../repositories/operation-log.repository';
import type { MetaRepository } from '../repositories/meta.repository';
import type { RecordStatsRepository } from '../repositories/record-stats.repository';
import type { BackupKeySource } from './backup-key.service';
import type { RestoreStagingPort } from '../runtime/ports';
import type { BackupService } from './backup.service';
import {
  LEGACY_BACKUP_FORMAT_VERSION,
  LOGICAL_BACKUP_FORMAT_VERSION,
  missingRestoreTables,
  RestoreRepository,
} from '../repositories/restore.repository';
import { verifyRestoreTicketWithAnyKey } from '../lib/backup-crypto';
import {
  BACKUP_WIRE_VERSION,
  encodeTicketPayload,
  parseRestoreLine,
  restoreDataDigest,
  type RestoreTable,
  type RestoreTicket,
} from '../lib/backup-format';
import { utcNowIso } from '../lib/today';
import { logger } from '../lib/logger';
import type { ServiceResult } from '../app';

export interface RestoreServiceDeps {
  readonly db: Db;
  readonly staging: RestoreStagingPort;
  readonly meta: MetaRepository;
  readonly logs: OperationLogRepository;
  /** 仪表盘统计仓储：全量恢复后必须重算派生表（触发器在恢复窗口内是摘掉的）。 */
  readonly stats: RecordStatsRepository;
  /** 备份公钥：验签用「库内全部 + 部署锚点」，任一验过即通过。 */
  readonly keys: BackupKeySource;
  readonly physicalBackup?: BackupService;
  /**
   * 单份恢复包字节上限。缺省用 Node 上限；Workers 组合根传入更小的值
   * （128MB 内存装不下几十 MB 的包，超限必须在解析前直接拒绝，不能靠 OOM 兜底）。
   */
  readonly maxRestoreBytes?: number;
}

/** 票据有效期（与用户确认的 30 分钟一致）。 */
export const TICKET_WINDOW_MS = 30 * 60 * 1000;
/**
 * 允许票据签发时间落在服务端「未来」的最大偏差（时钟不同步容忍）。
 * issuedAt 由服务端 begin 返回，正常不会超前；给出 60 秒容忍避免边界抖动，
 * 但不像旧实现那样用 Math.abs 把有效期整体放宽到约 60 分钟。
 */
export const TICKET_FUTURE_SKEW_MS = 60 * 1000;
/**
 * 消费标记的存活时长（3 小时），远长于票据窗口 30 分钟。
 *
 * 标记只在防重放期间有意义：3 小时后任何票据都已过 30 分钟窗口，重放会被
 * 时间校验拦下，因此清理标记不会打开重放口子。写入时记录过期时间，访问时
 * 惰性清理（见两个 RestoreStagingPort 实现），避免标记长期累积占用 KV/磁盘。
 */
export const CONSUMED_MARK_TTL_MS = 3 * 60 * 60 * 1000;
/** 单份恢复包分块数上限，防止恶意超量上传。 */
const MAX_CHUNKS = 2000;
/**
 * Node 侧单份恢复包字节上限（32MB）。
 *
 * 依据 2026-11-24 实测（Node 26.13.0）：解析 + 摘要序列化的堆增量约为包体的
 * **6.1 倍**（2.1MB→13MB、8.5MB→53MB、16.1MB→99MB，线性）。1C1G 目标机型的
 * V8 默认 heap 上限约 256MB，32MB 包峰值约 195MB，留出应用常驻堆与 GC 余量。
 * 放大来自「恢复包一行一张表」的线格式：最大表必须整体驻留才能 JSON.parse，
 * 摘要还要再序列化一次。超限直接报错，不用进程 OOM 兜底。
 * 正常店铺数据（4 万条记录 ≈ 7MB）远低于该上限。
 */
export const RESTORE_MAX_BYTES_NODE = 32 * 1024 * 1024;
/**
 * Workers 侧单份恢复包字节上限（10MB）。
 *
 * Workers 单 isolate 内存 128MB，按实测 6.1 倍放大，10MB 包峰值约 61MB，
 * 加上应用常驻堆仍在安全区。2026-11-24 本地 workerd 实测：8.5MB / 8 万行包
 * 正常恢复（2.1s，6 张表 80001 行）；16.8MB 包被上限提前拒绝而不是 OOM。
 * 超限时提示改在自托管 Node 实例上恢复。
 */
export const RESTORE_MAX_BYTES_WORKERS = 10 * 1024 * 1024;

export interface BeginBatchResult {
  readonly batchId: string;
  readonly issuedAt: string;
  readonly windowMs: number;
}

/** 恢复包解析结果：各表明细 + 包格式版本（决定 `purchase_orders` 是否必需）。 */
export interface RestorePackageRead {
  readonly tables: RestoreTable[];
  readonly formatVersion: number;
}

export interface CommitResult {
  readonly backupId: string;
  readonly restoredTables: number;
  readonly restoredRows: number;
}

export class RestoreService {
  private readonly repo: RestoreRepository;
  private readonly maxRestoreBytes: number;

  constructor(private readonly deps: RestoreServiceDeps) {
    this.repo = new RestoreRepository(deps.db, deps.stats);
    this.maxRestoreBytes = deps.maxRestoreBytes ?? RESTORE_MAX_BYTES_NODE;
  }

  get enabled(): boolean {
    return this.deps.keys.enabled;
  }

  /**
   * 清理失败路径的暂存分块。批次一经消费即不可重放，失败后分块不再有用；
   * 清理失败只告警，不掩盖原始错误（遗留 E：失败恢复不清理 staging）。
   * consumed 标记由 staging 实现保留，batchId 仍不可复用。
   */
  private async cleanupStaging(batchId: string): Promise<void> {
    try {
      await this.deps.staging.deleteBatch(batchId);
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error), batchId },
        '[restore] 失败路径清理暂存分块失败',
      );
    }
  }

  /**
   * 逐块流式解析恢复包，不把整包拼成单个 `Uint8Array`。
   *
   * 旧实现是「拼 joined → 整体解码 text → split('\n') → 解析」，峰值约为包体的
   * 3 倍（字节 + UTF-16 文本 + 行数组），再叠加摘要序列化。这里改成边取块边
   * 解码，按行切分后立刻丢弃已消费的文本，常态峰值收敛为
   * 「一个分块的字节 + 一个未闭合行 + 已解析的行对象」。
   *
   * 单行仍可能很大：恢复包是「一行一张表」，所以最大的那张表必须整体驻留内存
   * 才能 `JSON.parse`，这是线格式的固有约束，不是本次实现选择。因此另设
   * `maxRestoreBytes`（按运行时给不同上限）在超限时提前拒绝。
   */
  private async readRestoreTables(
    batchId: string,
    seqs: readonly number[],
  ): Promise<ServiceResult<RestorePackageRead>> {
    const decoder = new TextDecoder();
    const tables: RestoreTable[] = [];
    // 首行 restore-meta 里的包格式版本；老包没有该字段，按 v1 处理。
    let formatVersion: number = LEGACY_BACKUP_FORMAT_VERSION;
    let formatVersionTooNew = false;
    let pending = '';
    let total = 0;

    const consumeLine = (line: string): void => {
      if (line.trim() === '') {
        return;
      }
      const parsed = parseRestoreLine(line);
      if (parsed.kind === 'table') {
        tables.push(parsed);
        return;
      }
      const version: number = Number(parsed.formatVersion);
      if (Number.isInteger(version) && version >= LEGACY_BACKUP_FORMAT_VERSION) {
        formatVersion = version;
        // 高于当前程序的包可能含本版本不认识的表 / 列语义，直接拒绝（06-P2-8），
        // 与本地 cmdDecrypt 的上界校验对齐；仍消费完整分块后再统一失败。
        if (version > LOGICAL_BACKUP_FORMAT_VERSION) {
          formatVersionTooNew = true;
        }
      }
    };

    for (const seq of seqs) {
      const chunk: Uint8Array | null = await this.deps.staging.readChunk(batchId, seq);
      if (chunk === null) {
        return { ok: false, code: ErrorCode.BACKUP_RESTORE_FAILED };
      }
      total += chunk.byteLength;
      if (total > this.maxRestoreBytes) {
        return {
          ok: false,
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          details: {
            reason: `恢复包超过当前运行时的字节上限（${this.maxRestoreBytes} 字节），请在自托管 Node 实例上恢复`,
          },
        };
      }
      // stream:true 让多字节字符跨分块边界时不被截断。
      pending += decoder.decode(chunk, { stream: true });
      let breakAt: number = pending.indexOf('\n');
      while (breakAt >= 0) {
        consumeLine(pending.slice(0, breakAt));
        pending = pending.slice(breakAt + 1);
        breakAt = pending.indexOf('\n');
      }
    }
    pending += decoder.decode();
    if (pending.trim() !== '') {
      consumeLine(pending);
    }
    if (formatVersionTooNew) {
      return {
        ok: false,
        code: ErrorCode.BACKUP_RESTORE_FAILED,
        details: {
          reason: `恢复包格式版本 ${formatVersion} 高于当前程序支持的 ${LOGICAL_BACKUP_FORMAT_VERSION}`,
        },
      };
    }
    return { ok: true, data: { tables, formatVersion } };
  }

  /**
   * 发起恢复批次：返回 batchId 与服务端时间戳。本地脚本据此生成票据
   * （票据 issuedAt 应填这里返回的 issuedAt）。batchId 只允许安全字符。
   */
  beginBatch(): ServiceResult<BeginBatchResult> {
    if (!this.enabled) {
      return { ok: false, code: ErrorCode.BACKUP_NOT_ENABLED };
    }
    return {
      ok: true,
      data: { batchId: `rb-${randomUUID()}`, issuedAt: utcNowIso(), windowMs: TICKET_WINDOW_MS },
    };
  }

  /** 上传一个明文分块（batchId + seq）。seq 从 0 连续。 */
  async putChunk(
    batchId: string,
    seq: number,
    data: Uint8Array,
  ): Promise<ServiceResult<{ ok: true }>> {
    if (data.byteLength === 0) {
      return { ok: false, code: ErrorCode.VALID_FAILED, details: { reason: '空分块' } };
    }
    try {
      await this.deps.staging.putChunk(batchId, seq, data);
      return { ok: true, data: { ok: true } };
    } catch (error) {
      return {
        ok: false,
        code: ErrorCode.VALID_FAILED,
        details: { reason: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  /**
   * 提交恢复：验签 → 时间窗口 → 拼接数据 → 摘要校验 → 批次防重放
   * → 物理快照 → 全量恢复 → 清理暂存。
   *
   * @param actor 审计署名，取管理员登录名（`admin:<login>`）；缺省仅用于直调测试。
   */
  async commit(
    batchId: string,
    ticket: RestoreTicket,
    actor: string = 'admin:restore',
  ): Promise<ServiceResult<CommitResult>> {
    if (!this.enabled) {
      return { ok: false, code: ErrorCode.BACKUP_NOT_ENABLED };
    }

    // 1) 票据规范字节 + 验签（轮换过渡期允许多把公钥，任一验过即可）。
    const payloadBytes: Uint8Array = encodeTicketPayload(ticket.payload);
    const signatureOk: boolean = await verifyRestoreTicketWithAnyKey(
      this.deps.keys.verifyPublicKeys(),
      payloadBytes,
      ticket.signature,
    );
    if (!signatureOk) {
      return { ok: false, code: ErrorCode.BACKUP_INVALID_TICKET };
    }

    // 2) batchId 绑定 + 时间窗口。
    if (ticket.payload.batchId !== batchId) {
      return { ok: false, code: ErrorCode.BACKUP_INVALID_TICKET };
    }
    if (ticket.payload.v !== BACKUP_WIRE_VERSION) {
      return { ok: false, code: ErrorCode.BACKUP_INVALID_TICKET };
    }
    const issuedMs: number = Date.parse(ticket.payload.issuedAt);
    const nowMs: number = Date.now();
    // 单向窗口：签发时间不得早于 now-window，也不得超前 now+skew。
    // 旧实现用 Math.abs 等价于把有效期延到约 60 分钟，这里收紧为单向。
    if (
      !Number.isFinite(issuedMs) ||
      nowMs - issuedMs > TICKET_WINDOW_MS ||
      issuedMs - nowMs > TICKET_FUTURE_SKEW_MS
    ) {
      return { ok: false, code: ErrorCode.BACKUP_TICKET_EXPIRED };
    }
    // schema 版本只拒绝「比当前新」的包：用 SCHEMA_EXPECTED（当前代码期望版本）而非
    // meta.schema_version（历史初始版本）。
    //
    // 为什么允许旧包（schemaVersion < 当前）：本项目的迁移只做「加表 / 加可空列」
    // （见 schema.ts 的 BREAKING_MIGRATIONS 约定），恢复按**包内列清单**插入，
    // 新增列自然取默认值 —— 于是升级前导出的备份仍能恢复，这正是恢复能力存在的
    // 意义（否则每次 schema 升级都会让所有历史备份一次性作废）。
    // 反向（包比程序新）必须拒绝：把新版列写进旧结构只会静默丢数据。
    const currentSchema = SCHEMA_EXPECTED;
    if (ticket.payload.schemaVersion > currentSchema) {
      return {
        ok: false,
        code: ErrorCode.BACKUP_RESTORE_FAILED,
        details: {
          reason: `备份 schema 版本 ${ticket.payload.schemaVersion} 高于当前程序支持的 ${currentSchema}，请先升级应用`,
        },
      };
    }

    // 3) 重放前置判定：已消费的批次直接返回 CONFLICT（此时数据通常已被清理），
    //    避免在读取分块阶段误报为 RESTORE_FAILED；未消费则进入数据校验。
    if (await this.deps.staging.isConsumed(batchId)) {
      return { ok: false, code: ErrorCode.BACKUP_RESTORE_CONFLICT };
    }

    // 4) 读取并流式解析恢复包。
    //    所有校验失败都先清理已上传的明文分块再返回：这些分块已无法修复（票据
    //    绑定同一份数据摘要），保留只会长期占用 Node 临时目录 / DO KV，且同一
    //    batchId 重试仍会命中同一失败。本地脚本每次运行都 begin 新批次，因此
    //    「清理后重新走完整流程」就是实际的重试路径。
    try {
      // 校验失败统一走这里：清理暂存分块（此时批次未消费，不会删掉 consumed 标记）。
      const fail = async (
        result: ServiceResult<CommitResult>,
      ): Promise<ServiceResult<CommitResult>> => {
        await this.cleanupStaging(batchId);
        return result;
      };

      const seqs: number[] = await this.deps.staging.listChunkSeqs(batchId);
      if (seqs.length === 0 || seqs.length > MAX_CHUNKS) {
        return await fail({ ok: false, code: ErrorCode.BACKUP_RESTORE_FAILED });
      }
      // 分块必须从 0 连续且唯一；缺口/重复会让拼接顺序错位。摘要校验虽能最终
      // 挡住，但错误信息不指向上传缺陷，这里提前给出明确判定。
      for (let expected = 0; expected < seqs.length; expected += 1) {
        if (seqs[expected] !== expected) {
          return await fail({
            ok: false,
            code: ErrorCode.BACKUP_RESTORE_FAILED,
            details: {
              reason: `恢复包分块序号不连续：位置 ${expected} 期望 seq=${expected}，实际=${seqs[expected]}`,
            },
          });
        }
      }
      const read = await this.readRestoreTables(batchId, seqs);
      if (!read.ok) {
        return await fail(read);
      }
      const { tables, formatVersion } = read.data;

      // 5) 摘要校验：恢复包内容必须与票据签名的数据哈希一致。
      const digest: string = await restoreDataDigest(tables);
      if (digest !== ticket.payload.dataSha256) {
        return await fail({ ok: false, code: ErrorCode.BACKUP_INVALID_TICKET });
      }

      // 5.1) 覆盖校验（服务端强制，防半恢复）：恢复包必须覆盖**该格式版本要求**的
      //      全部可恢复表。v1 旧包不含 purchase_orders，按空表处理即可；
      //      正常脚本已在 decrypt 阶段补齐空表。这里挡住「持有私钥者构造缺表包」
      //      导致的「清空某表却不回填」。放在消费前，失败只清理分块、不消费票据。
      const missing: string[] = missingRestoreTables(tables, formatVersion);
      if (missing.length > 0) {
        return await fail({
          ok: false,
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          details: { reason: `恢复包缺少可恢复表: ${missing.join(', ')}` },
        });
      }

      // 6) 消费批次（防重放）：仅在全部校验通过后、破坏性恢复前消费一次。
      //    快照失败或恢复失败时批次已消费，需重新 begin（票据是一次性的，
      //    这一点比「失败可无限重试」更安全，避免同一票据反复触发破坏性操作）。
      const expiresAtIso = new Date(nowMs + CONSUMED_MARK_TTL_MS).toISOString();
      const consumed: boolean = await this.deps.staging.consumeBatch(batchId, expiresAtIso);
      if (!consumed) {
        return { ok: false, code: ErrorCode.BACKUP_RESTORE_CONFLICT };
      }

      // 7) 危险操作前立即做物理快照（Node 文件 / Workers PITR），并校验结果。
      //    CONVENTIONS §4：全量恢复前必须生成物理快照；skipped 不得当作成功。
      if (this.deps.physicalBackup !== undefined) {
        const snapshot = await this.deps.physicalBackup.backupWithoutGate('pre-restore', '', actor);
        const snapStatus = snapshot.ok ? snapshot.data.status : 'failed';
        if (this.deps.physicalBackup.mode === 'pitr') {
          // Workers 无文件系统：PITR / Time Travel 即平台托管的回滚点，
          // 不是应用侧文件快照。明确以平台能力作为已满足的回滚点并记录，
          // 不伪造一份不存在的快照成功。
          logger.info(
            { batchId },
            '[restore] 当前运行时由平台 PITR 托管回滚点，跳过应用侧物理快照',
          );
        } else if (snapStatus !== 'ok') {
          this.deps.logs.append({
            action: 'BACKUP_RESTORE' as never,
            targetType: 'backup' as never,
            targetId: null,
            detail: { batchId, reason: 'pre-restore-snapshot-unavailable', status: snapStatus },
            requestId: '',
            actor,
            occurredAt: utcNowIso(),
          });
          // 批次已消费、票据一次性：清理上传的暂存分块，避免残留到批次过期（遗留 E）。
          await this.cleanupStaging(batchId);
          return {
            ok: false,
            code: ErrorCode.BACKUP_RESTORE_FAILED,
            details: { reason: '恢复前物理快照未生成，已中止恢复以避免无回滚点的破坏性操作' },
          };
        }
      }

      // 8) 全量恢复（单事务）。
      this.repo.assertSchemaCompatible();
      this.repo.restoreAll(tables, formatVersion);

      // 8.1) 全量替换后行数与分布整体变了，旧统计会误导规划器（曾把列表页
      //      判成全表扫描 + 临时 B 树排序）。强制重算一次，代价约百毫秒级。
      try {
        ensureQueryPlannerStats(this.deps.db, true);
      } catch (error) {
        logger.warn(
          { batchId, error: error instanceof Error ? error.message : String(error) },
          '[restore] ANALYZE 失败，恢复已完成但查询可能退化',
        );
      }

      const restoredRows: number = tables.reduce((sum, t) => sum + t.rows.length, 0);
      const now: string = utcNowIso();
      immediateTransaction(this.deps.db, () => {
        this.deps.logs.append({
          action: 'BACKUP_RESTORE' as never,
          targetType: 'backup' as never,
          targetId: null,
          detail: {
            batchId,
            backupKeyId: ticket.payload.keyId,
            restoredTables: tables.length,
            restoredRows,
          },
          requestId: '',
          actor,
          occurredAt: now,
        });
      });

      // 9) 清理暂存分块（consumed 标记保留，防 batchId 重用）。
      await this.deps.staging.deleteBatch(batchId);

      logger.info(
        { batchId, restoredTables: tables.length, restoredRows },
        '[restore] 全量恢复完成',
      );
      return {
        ok: true,
        data: { backupId: batchId, restoredTables: tables.length, restoredRows },
      };
    } catch (error) {
      const message: string = error instanceof Error ? error.message : String(error);
      logger.error({ err: message, batchId }, '[restore] 恢复执行失败');
      // 失败路径同样写审计（与快照失败分支一致），便于事后追溯（遗留 E）。
      try {
        immediateTransaction(this.deps.db, () => {
          this.deps.logs.append({
            action: 'BACKUP_RESTORE' as never,
            targetType: 'backup' as never,
            targetId: null,
            detail: { batchId, reason: 'restore-execution-failed', error: message },
            requestId: '',
            actor,
            occurredAt: utcNowIso(),
          });
        });
      } catch (auditError) {
        logger.warn(
          { err: auditError instanceof Error ? auditError.message : String(auditError), batchId },
          '[restore] 恢复失败审计写入失败',
        );
      }
      await this.cleanupStaging(batchId);
      return {
        ok: false,
        code: ErrorCode.BACKUP_RESTORE_FAILED,
        details: { reason: message },
      };
    }
  }
}
