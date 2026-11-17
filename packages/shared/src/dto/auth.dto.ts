/**
 * 认证、首次引导与账号安全契约。
 * 依据：设计文档 v1.1 §2.1 A1–A4、§3.5、§5.2（认证状态机）、§7.4 首次部署 6 步。
 */

export interface LoginRequest {
  username: string;
  password: string;
}

/**
 * 自助引导初始化：不再需要“初始密码”，首次访问直接设置正式账密、
 * 密保问题与店铺配置。密保为必填项——忘记密码功能依赖它。
 */
export interface SetupRequest {
  username: string;
  password: string;
  /** 密保问题文本（预设文案或用户自定义原文）。 */
  securityQuestion: string;
  /** 密保答案明文（服务端归一化后加盐哈希存储，绝不落明文）。 */
  securityAnswer: string;
  /** 店铺名称，可留空。 */
  shopName: string;
  expiryThresholdDays: number;
}

/** init-state 单向 0→1；前端 AuthGuard 只信此接口。 */
export interface InitStatusResponse {
  initialized: boolean;
  initState: 0 | 1;
  username: string | null;
}

export interface SessionUser {
  id: number;
  username: string;
}

export interface AuthMeResponse {
  authenticated: boolean;
  user: SessionUser | null;
  initState: 0 | 1;
}

export interface LogoutResponse {
  ok: true;
}

/** 登录失败限流响应头（429 时读取）。 */
export interface RateLimitHint {
  retryAfterSeconds: number;
}

/** 通用成功响应。 */
export interface SimpleOkResponse {
  ok: true;
}

/** 登录态下修改密码：改后全部会话（含当前）被吊销，需重新登录。 */
export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

/** 登录态下设置 / 修改密保问题，需再次校验当前密码。 */
export interface UpdateSecurityRequest {
  currentPassword: string;
  securityQuestion: string;
  securityAnswer: string;
}

/** 忘记密码第一步：按用户名取回该账号设置的密保问题。 */
export interface SecurityQuestionRequest {
  username: string;
}

/**
 * 忘记密码第二步：一步式重置。
 * 用户名不存在、未设密保、答案错误统一返回同一错误码与文案。
 */
export interface ForgotPasswordRequest {
  username: string;
  securityAnswer: string;
  newPassword: string;
}

/** 密保问题回显；查不到账号时服务端返回一条预设问题作为掩护，不泄漏账号存在性。 */
export interface SecurityQuestionResponse {
  question: string;
  /**
   * 该账号是否真的设置过密保。
   *
   * `false` 只会在「用户名匹配但密保列为空」时出现（1.0.0 升级上来的老库），
   * 用于提示用户尽快补设；未知用户名一律返回 `true` + 掩护问题，避免枚举。
   */
  configured: boolean;
}
