/**
 * 恢复服务：验签票据 → 校验数据 → 防重放 → 危险操作前物理快照 → 全量恢复。
 *
 * 私钥只在本地脚本中：服务端仅持有公钥，用 ECDSA 验证本地对票据的签名。
 * 数据以明文 NDJSON 分块上传到 staging，commit 时按顺序拼接、校验摘要，
 * 再在 RestoreRepository 的单事务里全量重建（清空会话）。
 *
 * 时间窗口：票据 issuedAt 与服务端当前时间差不得超过 TICKET_WINDOW_MS。
 * 防重放：所有校验（验签 / 时间窗 / schema / 数据摘要）通过后消费 batchId，
 *   校验失败不消费以便重试；消费成功后进入破坏性恢复，票据一次性不可重放。
 * 回滚点：Node 下要求恢复前物理快照必须成功（skipped 即中止）；Workers 下以
 *   平台 PITR 作为托管回滚点并记日志，不伪造应用侧快照。
 */
import { ErrorCode } from '@stockin/shared';
import { randomUUID } from 'node:crypto';
import type { Env } from '../env';
import type { Db } from '../repositories/db';
import { immediateTransaction } from '../repositories/db';
import { SCHEMA_EXPECTED } from '../repositories/schema';
import type { OperationLogRepository } from '../repositories/operation-log.repository';
import type { MetaRepository } from '../repositories/meta.repository';
import type { RestoreStagingPort } from '../runtime/ports';
import type { BackupService } from './backup.service';
import { missingRestoreTables, RestoreRepository } from '../repositories/restore.repository';
import { verifyRestoreTicket } from '../lib/backup-crypto';
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
  readonly env: Env;
  readonly staging: RestoreStagingPort;
  readonly meta: MetaRepository;
  readonly logs: OperationLogRepository;
  readonly physicalBackup?: BackupService;
}

/** 票据有效期（与用户确认的 30 分钟一致）。 */
export const TICKET_WINDOW_MS = 30 * 60 * 1000;
/**
 * 允许票据签发时间落在服务端「未来」的最大偏差（时钟不同步容忍）。
 * issuedAt 由服务端 begin 返回，正常不会超前；给出 60 秒容忍避免边界抖动，
 * 但不像旧实现那样用 Math.abs 把有效期整体放宽到约 60 分钟。
 */
export const TICKET_FUTURE_SKEW_MS = 60 * 1000;
/** 单份恢复包分块数上限，防止恶意超量上传。 */
const MAX_CHUNKS = 2000;
/**
 * 单份恢复包字节上限（约 256MB）。commit 会把全部分块拼成单个 Uint8Array，
 * Workers 的实际可用内存需在 workerd 实测；Node 侧 1G 机器已有该上限保护。
 * 若实测 Workers 触发 OOM，下一步是改为流式逐段摘要，而非整体拼接。
 */
const MAX_BYTES = 256 * 1024 * 1024;

export interface BeginBatchResult {
  readonly batchId: string;
  readonly issuedAt: string;
  readonly windowMs: number;
}

export interface CommitResult {
  readonly backupId: string;
  readonly restoredTables: number;
  readonly restoredRows: number;
}

export class RestoreService {
  private readonly repo: RestoreRepository;

  constructor(private readonly deps: RestoreServiceDeps) {
    this.repo = new RestoreRepository(deps.db);
  }

  get enabled(): boolean {
    return this.deps.env.backupPublicKey.trim() !== '';
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

    // 1) 票据规范字节 + 验签。
    const payloadBytes: Uint8Array = encodeTicketPayload(ticket.payload);
    const signatureOk: boolean = await verifyRestoreTicket(
      this.deps.env.backupPublicKey,
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
    // schema 版本必须与当前一致，避免半恢复（用户拍板）。
    // 用 SCHEMA_EXPECTED（当前代码期望版本）而非 meta.schema_version（历史初始版本）。
    const currentSchema = SCHEMA_EXPECTED;
    if (ticket.payload.schemaVersion !== currentSchema) {
      return {
        ok: false,
        code: ErrorCode.BACKUP_RESTORE_FAILED,
        details: {
          reason: `备份 schema 版本 ${ticket.payload.schemaVersion} 与当前 ${currentSchema} 不一致`,
        },
      };
    }

    // 3) 重放前置判定：已消费的批次直接返回 CONFLICT（此时数据通常已被清理），
    //    避免在读取分块阶段误报为 RESTORE_FAILED；未消费则进入数据校验，
    //    校验失败不消费，用户可用同一批次修正后重试。
    if (await this.deps.staging.isConsumed(batchId)) {
      return { ok: false, code: ErrorCode.BACKUP_RESTORE_CONFLICT };
    }

    // 4) 读取并按序拼接恢复包（校验数据期间尚不消费批次，失败可重试）。
    try {
      // 4) 读取并按序拼接恢复包。
      const seqs: number[] = await this.deps.staging.listChunkSeqs(batchId);
      if (seqs.length === 0 || seqs.length > MAX_CHUNKS) {
        return { ok: false, code: ErrorCode.BACKUP_RESTORE_FAILED };
      }
      // 分块必须从 0 连续且唯一；缺口/重复会让拼接顺序错位。摘要校验虽能最终
      // 挡住，但错误信息不指向上传缺陷，这里提前给出明确判定。
      for (let expected = 0; expected < seqs.length; expected += 1) {
        if (seqs[expected] !== expected) {
          return {
            ok: false,
            code: ErrorCode.BACKUP_RESTORE_FAILED,
            details: {
              reason: `恢复包分块序号不连续：位置 ${expected} 期望 seq=${expected}，实际=${seqs[expected]}`,
            },
          };
        }
      }
      const parts: Uint8Array[] = [];
      let total = 0;
      for (const seq of seqs) {
        const chunk: Uint8Array | null = await this.deps.staging.readChunk(batchId, seq);
        if (chunk === null) {
          return { ok: false, code: ErrorCode.BACKUP_RESTORE_FAILED };
        }
        total += chunk.byteLength;
        if (total > MAX_BYTES) {
          return { ok: false, code: ErrorCode.BACKUP_RESTORE_FAILED };
        }
        parts.push(chunk);
      }
      const joined: Uint8Array = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) {
        joined.set(part, offset);
        offset += part.byteLength;
      }
      const text: string = new TextDecoder().decode(joined);
      const lines: string[] = text.split('\n').filter((line) => line.trim() !== '');
      const tables: RestoreTable[] = [];
      for (const line of lines) {
        const parsed = parseRestoreLine(line);
        if (parsed.kind === 'table') {
          tables.push(parsed);
        }
      }

      // 5) 摘要校验：恢复包内容必须与票据签名的数据哈希一致。
      //    校验失败不消费批次，用户修正票据/数据后可用同一批次重试。
      const digest: string = await restoreDataDigest(tables);
      if (digest !== ticket.payload.dataSha256) {
        return { ok: false, code: ErrorCode.BACKUP_INVALID_TICKET };
      }

      // 5.1) 覆盖校验（服务端强制，防半恢复）：恢复包必须覆盖全部可恢复表。
      //      正常脚本已在 decrypt 阶段补齐空表；这里挡住「持有私钥者构造缺表包」
      //      导致的「清空某表却不回填」。放在消费前，失败可用同一批次重试。
      const missing: string[] = missingRestoreTables(tables);
      if (missing.length > 0) {
        return {
          ok: false,
          code: ErrorCode.BACKUP_RESTORE_FAILED,
          details: { reason: `恢复包缺少可恢复表: ${missing.join(', ')}` },
        };
      }

      // 6) 消费批次（防重放）：仅在全部校验通过后、破坏性恢复前消费一次。
      //    快照失败或恢复失败时批次已消费，需重新 begin（票据是一次性的，
      //    这一点比「失败可无限重试」更安全，避免同一票据反复触发破坏性操作）。
      const expiresAtIso = new Date(nowMs + TICKET_WINDOW_MS).toISOString();
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
      this.repo.restoreAll(tables);

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
