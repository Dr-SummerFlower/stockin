/**
 * 恢复服务：验签票据 → 校验数据 → 防重放 → 危险操作前物理快照 → 全量恢复。
 *
 * 私钥只在本地脚本中：服务端仅持有公钥，用 ECDSA 验证本地对票据的签名。
 * 数据以明文 NDJSON 分块上传到 staging，commit 时按顺序拼接、校验摘要，
 * 再在 RestoreRepository 的单事务里全量重建（清空会话）。
 *
 * 时间窗口：票据 issuedAt 与服务端当前时间差不得超过 TICKET_WINDOW_MS。
 * 防重放：commit 成功后消费 batchId（staging.consumeBatch），失败不消费以便重试。
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
import { RestoreRepository } from '../repositories/restore.repository';
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
/** 单份恢复包分块数上限，防止恶意超量上传。 */
const MAX_CHUNKS = 2000;
/** 单份恢复包字节上限（约 256MB）。 */
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
   * 提交恢复：验签 → 时间窗口 → 拼接数据 → 摘要校验 → 物理快照 → 全量恢复 → 消费批次。
   */
  async commit(batchId: string, ticket: RestoreTicket): Promise<ServiceResult<CommitResult>> {
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
    if (!Number.isFinite(issuedMs) || Math.abs(nowMs - issuedMs) > TICKET_WINDOW_MS) {
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

    // 3) 消费批次（防重放）：必须在验签通过后、恢复前，且只成功一次。
    const expiresAtIso = new Date(nowMs + TICKET_WINDOW_MS).toISOString();
    const consumed: boolean = await this.deps.staging.consumeBatch(batchId, expiresAtIso);
    if (!consumed) {
      return { ok: false, code: ErrorCode.BACKUP_RESTORE_CONFLICT };
    }

    try {
      // 4) 读取并按序拼接恢复包。
      const seqs: number[] = await this.deps.staging.listChunkSeqs(batchId);
      if (seqs.length === 0 || seqs.length > MAX_CHUNKS) {
        return { ok: false, code: ErrorCode.BACKUP_RESTORE_FAILED };
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
      const digest: string = await restoreDataDigest(tables);
      if (digest !== ticket.payload.dataSha256) {
        return { ok: false, code: ErrorCode.BACKUP_INVALID_TICKET };
      }

      // 6) 危险操作前立即做物理快照（Node 文件 / Workers PITR）。
      if (this.deps.physicalBackup !== undefined) {
        await this.deps.physicalBackup.backupWithoutGate('pre-restore', '', 'system');
      }

      // 7) 全量恢复（单事务）。
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
          actor: 'admin:restore',
          occurredAt: now,
        });
      });

      // 8) 清理暂存分块（consumed 标记保留，防 batchId 重用）。
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
      return {
        ok: false,
        code: ErrorCode.BACKUP_RESTORE_FAILED,
        details: { reason: message },
      };
    }
  }
}
