/**
 * 备份公钥服务：管理台维护 + 运行期取用。
 *
 * 设计取舍（用户 2026-11-24 拍板，2026-11-25 修订）：
 *   * 公钥以库内 `backup_keys` 为**唯一真源**，可以直接在管理台增删启用，轮换
 *     不再需要重新部署、也不需要 CF 账号权限；
 *   * `BACKUP_PUBLIC_KEY` 只作**首次启动播种**：bootstrap 在库内为空时写入一条
 *     默认公钥，之后加密与验签一律只读库内，环境变量不再参与任何运行期逻辑；
 *   * **旧公钥不必全部保留** —— 服务端公钥根本不参与解密（解密只需本地私钥 +
 *     备份 meta 的 keyId），所以退休一把旧公钥只影响「用它签出的恢复票据还能不能
 *     验签」，而票据窗口是 30 分钟。旧备份仍可在本地解密查看。
 *
 * 安全边界：公钥不是秘密，能写库的人本来就能改任意数据；真正的边界是私钥
 * 永不进入运行环境。因此这里不设「需要再次确认」以外的额外校验，只保证
 * 每次变更都落审计，并且**启用中的公钥不能被删**（避免误删导致备份直接停摆）。
 */
import {
  Action,
  ErrorCode,
  TARGET_TYPE,
  type BackupKeyItem,
  type BackupKeyListResponse,
} from '@stockin/shared';
import type { Db } from '../repositories/db';
import { immediateTransaction } from '../repositories/db';
import type { BackupKeyRepository, BackupKeyRow } from '../repositories/backup-key.repository';
import type { OperationLogRepository } from '../repositories/operation-log.repository';
import { assertValidBackupPublicKey, backupKeyId } from '../lib/backup-crypto';
import { utcNowIso } from '../lib/today';
import { logger } from '../lib/logger';
import type { ServiceResult } from '../app';

export interface BackupKeyServiceDeps {
  readonly db: Db;
  readonly repo: BackupKeyRepository;
  readonly logs: OperationLogRepository;
}

/**
 * 备份公钥来源的最小契约。
 *
 * 逻辑备份与恢复只依赖这三件事，管理台才需要完整服务；抽出来是为了让这两个
 * 调用方不必依赖具体实现（测试里可以直接给一个内存实现）。
 */
export interface BackupKeySource {
  /** 是否具备加密能力（逻辑备份与一次性恢复的总开关）。 */
  readonly enabled: boolean;
  /** 当前用于加密新备份的公钥；未配置时为空串。 */
  activePublicKey(): string;
  /** 恢复票据验签可接受的公钥集合（按公钥去重，保序）。 */
  verifyPublicKeys(): readonly string[];
}

/**
 * 首次启动播种：库内 `backup_keys` 为空且提供了默认公钥时，写入一条启用中的公钥。
 *
 * 只由 bootstrap 在迁移成功后、升级备份之前调用一次；之后加密/验签只读库内，
 * `BACKUP_PUBLIC_KEY` 不再参与运行期逻辑。幂等：`count() > 0` 时直接跳过，
 * 因此首次播种后管理员在面板删除/轮换公钥不会再被 env 覆盖。
 * 这是系统初始化而非管理台操作，不写 `operation_logs`。
 */
export async function seedDefaultBackupKey(
  db: Db,
  repo: BackupKeyRepository,
  defaultPublicKey: string,
): Promise<boolean> {
  if (defaultPublicKey === '' || repo.count() > 0) {
    return false;
  }
  await assertValidBackupPublicKey(defaultPublicKey);
  const keyId: string = await backupKeyId(defaultPublicKey);
  const now: string = utcNowIso();
  immediateTransaction(db, () => {
    repo.insert({
      keyId,
      publicKey: defaultPublicKey,
      label: '默认公钥（首次启动播种）',
      active: true,
      now,
    });
  });
  return true;
}

export class BackupKeyService implements BackupKeySource {
  constructor(private readonly deps: BackupKeyServiceDeps) {}

  /**
   * 是否具备加密能力（逻辑备份与一次性恢复的总开关）。
   *
   * 只读库内：库里有任意公钥即可用，环境变量不参与。
   */
  get enabled(): boolean {
    return this.deps.repo.count() > 0;
  }

  /**
   * 当前用于**加密新备份**的公钥：库内启用中的那把。
   * 没有时返回空串，调用方（逻辑备份）据此判定未启用。
   */
  activePublicKey(): string {
    return this.deps.repo.findActive()?.public_key ?? '';
  }

  /**
   * 恢复票据验签可接受的公钥集合：库内全部，按公钥去重。
   *
   * 轮换期间用新私钥签的票据要能被验过，所以验签接受库内**所有**公钥，
   * 不只启用中的那把；退休一把旧公钥的唯一影响就是用它签的票据被拒。
   */
  verifyPublicKeys(): readonly string[] {
    return [...new Set(this.deps.repo.list().map((row) => row.public_key))];
  }

  /** 管理台列表：库内条目 + 未落库的锚点条目（只读）。 */
  list(): ServiceResult<BackupKeyListResponse> {
    return { ok: true, data: this.snapshot() };
  }

  /**
   * 新增一把公钥。
   *
   * 先做 WebCrypto 导入校验（正则拦不住「像 base64 但不是 P-256 公钥」的输入），
   * 再按公钥派生 keyId 判重；`activate` 为真时同一事务内切成加密公钥。
   */
  async add(
    input: { publicKey: string; label?: string; activate?: boolean },
    actor: string,
    requestId: string,
  ): Promise<ServiceResult<BackupKeyListResponse>> {
    const publicKey: string = input.publicKey.trim();
    try {
      await assertValidBackupPublicKey(publicKey);
    } catch {
      return { ok: false, code: ErrorCode.BACKUP_KEY_INVALID };
    }
    const keyId: string = await backupKeyId(publicKey);
    if (this.deps.repo.findById(keyId) !== null) {
      return {
        ok: false,
        code: ErrorCode.VALID_FAILED,
        details: { reason: `该公钥已存在（keyId=${keyId}）` },
      };
    }

    const now: string = utcNowIso();
    const activate: boolean = input.activate ?? this.deps.repo.count() === 0;
    try {
      immediateTransaction(this.deps.db, () => {
        this.deps.repo.insert({
          keyId,
          publicKey,
          label: input.label?.trim() ?? '',
          active: activate,
          now,
        });
        this.appendAudit(actor, requestId, now, { op: 'add', keyId, activate });
      });
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error), keyId },
        '[backup-key] 新增公钥失败',
      );
      return { ok: false, code: ErrorCode.VALID_FAILED, details: { reason: '公钥写入失败' } };
    }
    return { ok: true, data: this.snapshot() };
  }

  /** 把某把公钥切成加密公钥（轮换的第一步）。 */
  activate(keyId: string, actor: string, requestId: string): ServiceResult<BackupKeyListResponse> {
    if (this.deps.repo.findById(keyId) === null) {
      return { ok: false, code: ErrorCode.COMMON_NOT_FOUND, details: { keyId } };
    }
    const now: string = utcNowIso();
    immediateTransaction(this.deps.db, () => {
      this.deps.repo.setActive(keyId, now);
      this.appendAudit(actor, requestId, now, { op: 'activate', keyId });
    });
    return { ok: true, data: this.snapshot() };
  }

  /**
   * 删除一把公钥。
   *
   * 启用中的那把不允许直接删：删掉会让「加密新备份」无键可用，语义上等于
   * 关掉备份。要求先启用另一把（`BACKUP_KEY_IN_USE`）。
   */
  remove(keyId: string, actor: string, requestId: string): ServiceResult<BackupKeyListResponse> {
    const row: BackupKeyRow | null = this.deps.repo.findById(keyId);
    if (row === null) {
      return { ok: false, code: ErrorCode.COMMON_NOT_FOUND, details: { keyId } };
    }
    if (row.is_active === 1) {
      return { ok: false, code: ErrorCode.BACKUP_KEY_IN_USE, details: { keyId } };
    }
    const now: string = utcNowIso();
    immediateTransaction(this.deps.db, () => {
      this.deps.repo.remove(keyId);
      this.appendAudit(actor, requestId, now, { op: 'remove', keyId });
    });
    return { ok: true, data: this.snapshot() };
  }

  /** 对外视图：只列库内条目，来源恒为 database（env 不再参与）。 */
  private snapshot(): BackupKeyListResponse {
    const rows: BackupKeyRow[] = this.deps.repo.list();
    const items: BackupKeyItem[] = rows.map((row) => ({
      keyId: row.key_id,
      label: row.label,
      active: row.is_active === 1,
      source: 'database',
      createdAt: row.created_at,
      activatedAt: row.activated_at,
    }));
    return { items, enabled: this.enabled };
  }

  private appendAudit(
    actor: string,
    requestId: string,
    occurredAt: string,
    detail: Record<string, unknown>,
  ): void {
    this.deps.logs.append({
      action: Action.BACKUP_KEY_UPDATE,
      targetType: TARGET_TYPE.BACKUP,
      targetId: null,
      detail,
      requestId,
      actor,
      occurredAt,
    });
  }
}
