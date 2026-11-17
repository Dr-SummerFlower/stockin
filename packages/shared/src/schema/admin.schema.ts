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
