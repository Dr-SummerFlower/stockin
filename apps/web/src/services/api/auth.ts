/**
 * 认证与初始化 API（路径以 T03b `auth.routes.ts` 实际注册为准）。
 */
import type {
  AuthMeResponse,
  ChangePasswordRequest,
  ForgotPasswordRequest,
  HealthResponse,
  InitStatusResponse,
  LoginRequest,
  LogoutResponse,
  SecurityQuestionRequest,
  SecurityQuestionResponse,
  SetupRequest,
  SimpleOkResponse,
  UpdateSecurityRequest,
} from '@stockin/shared';
import { request } from '../request';

/** POST /api/auth/login 的响应（服务端签发 HttpOnly Cookie）。 */
export interface LoginResult {
  readonly ok: true;
  readonly initState: 0 | 1;
}

/** POST /api/auth/setup 的响应（完成引导不签新会话）。 */
export interface SetupResult {
  readonly initState: 1;
}

export function getInitStatus(): Promise<InitStatusResponse> {
  return request<InitStatusResponse>('/api/auth/init-status', { silent: true });
}

export function getMe(): Promise<AuthMeResponse> {
  return request<AuthMeResponse>('/api/auth/me', { silent: true });
}

export function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/api/health', { silent: true });
}

/** 账密错误 401 内联渲染，不触发全局跳转。 */
export function login(input: LoginRequest): Promise<LoginResult> {
  return request<LoginResult>('/api/auth/login', { method: 'POST', json: input, silent: true });
}

export function logout(): Promise<LogoutResponse> {
  return request<LogoutResponse>('/api/auth/logout', { method: 'POST', silent: true });
}

/** 重复 setup（409 `AUTH_INIT_COMPLETED`）由调用方内联提示。 */
export function setup(input: SetupRequest): Promise<SetupResult> {
  return request<SetupResult>('/api/auth/setup', { method: 'POST', json: input, silent: true });
}

/** 登录态改密：成功后全部会话被吊销，调用方应跳登录页。 */
export function changePassword(input: ChangePasswordRequest): Promise<SimpleOkResponse> {
  return request<SimpleOkResponse>('/api/auth/change-password', {
    method: 'POST',
    json: input,
    silent: true,
  });
}

/** 登录态设置 / 修改密保问题（需当前密码）。 */
export function updateSecurity(input: UpdateSecurityRequest): Promise<SimpleOkResponse> {
  return request<SimpleOkResponse>('/api/auth/security', {
    method: 'POST',
    json: input,
    silent: true,
  });
}

/** 忘记密码第一步：按用户名取回密保问题。 */
export function lookupSecurityQuestion(
  input: SecurityQuestionRequest,
): Promise<SecurityQuestionResponse> {
  return request<SecurityQuestionResponse>('/api/auth/security-question', {
    method: 'POST',
    json: input,
    silent: true,
  });
}

/** 忘记密码第二步：用户名 + 密保答案 + 新密码一步式重置。 */
export function forgotPassword(input: ForgotPasswordRequest): Promise<SimpleOkResponse> {
  return request<SimpleOkResponse>('/api/auth/forgot-password', {
    method: 'POST',
    json: input,
    silent: true,
  });
}
