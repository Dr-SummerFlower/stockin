/**
 * 认证、引导与账号安全 Zod schema（zod v4.6.7）。
 * 说明：设计文档未规定密码强度/长度规则，此处只做非空与上限约束，不臆造复杂度策略。
 */
import * as z from 'zod';
import { EXPIRY_THRESHOLD_MAX, EXPIRY_THRESHOLD_MIN } from '../constants';
import {
  SECURITY_ANSWER_MAX_LENGTH,
  SECURITY_QUESTION_MAX_LENGTH,
  SHOP_NAME_MAX_LENGTH,
} from '../security';

export const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});
export type LoginInput = z.infer<typeof loginSchema>;

/**
 * 自助引导初始化：账密 + 密保（必填）+ 店铺配置。
 * 重复 setup 由服务端状态机返回 409。
 */
export const setupSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
  securityQuestion: z.string().min(1).max(SECURITY_QUESTION_MAX_LENGTH),
  securityAnswer: z.string().min(1).max(SECURITY_ANSWER_MAX_LENGTH),
  shopName: z.string().max(SHOP_NAME_MAX_LENGTH),
  expiryThresholdDays: z.number().int().min(EXPIRY_THRESHOLD_MIN).max(EXPIRY_THRESHOLD_MAX),
});
export type SetupInput = z.infer<typeof setupSchema>;

/** 登录态改密：只接收当前密码与新密码，确认框由前端比对。 */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/** 登录态设置 / 修改密保问题。 */
export const updateSecuritySchema = z.object({
  currentPassword: z.string().min(1).max(256),
  securityQuestion: z.string().min(1).max(SECURITY_QUESTION_MAX_LENGTH),
  securityAnswer: z.string().min(1).max(SECURITY_ANSWER_MAX_LENGTH),
});
export type UpdateSecurityInput = z.infer<typeof updateSecuritySchema>;

/** 忘记密码第一步：按用户名取回密保问题。 */
export const securityQuestionLookupSchema = z.object({
  username: z.string().min(1).max(64),
});
export type SecurityQuestionLookupInput = z.infer<typeof securityQuestionLookupSchema>;

/** 忘记密码第二步：一步式重置（用户名 + 密保答案 + 新密码）。 */
export const forgotPasswordSchema = z.object({
  username: z.string().min(1).max(64),
  securityAnswer: z.string().min(1).max(SECURITY_ANSWER_MAX_LENGTH),
  newPassword: z.string().min(1).max(256),
});
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
