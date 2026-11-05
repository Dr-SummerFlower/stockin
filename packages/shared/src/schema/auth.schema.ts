/**
 * 认证 Zod schema（zod v4.6.7）。
 * 说明：设计文档未规定密码强度/长度规则，此处只做非空与上限约束，不臆造复杂度策略。
 */
import * as z from 'zod';

export const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** 首次引导：初始密码 + 新账密。重复 setup 由服务端状态机返回 409。 */
export const setupSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});
export type SetupInput = z.infer<typeof setupSchema>;
