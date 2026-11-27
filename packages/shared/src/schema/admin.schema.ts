/**
 * 管理员侧请求校验。
 *
 * 密码强度沿用项目既有口径（只约束非空与上限，不臆造复杂度策略）；
 * 管理员重置店主密码时，唯一额外约束是「确认框由前端比对」。
 */
import * as z from 'zod';

export const adminOwnerResetSchema = z.object({
  newPassword: z.string().min(1).max(256),
});
export type AdminOwnerResetInput = z.infer<typeof adminOwnerResetSchema>;

/** 备份间隔设置：1~365 天，两项都可选（只更新出现者）。 */
export const backupSettingsSchema = z
  .object({
    logicalBackupIntervalDays: z.number().int().min(1).max(365).optional(),
    physicalBackupIntervalDays: z.number().int().min(1).max(365).optional(),
  })
  .refine(
    (value) =>
      value.logicalBackupIntervalDays !== undefined ||
      value.physicalBackupIntervalDays !== undefined,
    { message: '至少提供一项间隔设置' },
  );

/** 恢复票据：字段固定，签名 8~2048 字符（base64；P-256 DER 约 88 字符，上限留余量）。 */
export const restoreCommitSchema = z.object({
  batchId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  ticket: z.object({
    payload: z.object({
      v: z.number().int().positive(),
      batchId: z.string().min(1),
      issuedAt: z.string().min(1),
      dataSha256: z.string().regex(/^[0-9a-f]{64}$/),
      schemaVersion: z.number().int().positive(),
      keyId: z.string().min(1),
    }),
    signature: z.string().min(8).max(2048),
  }),
});

/**
 * 新增备份公钥。
 *
 * 形状只做粗筛（base64 字符集 + 长度下界，P-256 SPKI/DER 约 124 字符），
 * 真正的合法性由服务端用 WebCrypto 导入公钥判定 —— 正则拦不住「像 base64、
 * 但不是 P-256 公钥」的输入，而这类错误必须在落库前说清楚。
 */
export const backupKeyAddSchema = z.object({
  publicKey: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9+/]{80,}={0,2}$/, '公钥必须是单行 base64'),
  label: z.string().trim().max(64).optional(),
  activate: z.boolean().optional(),
});
export type BackupKeyAddInput = z.infer<typeof backupKeyAddSchema>;
