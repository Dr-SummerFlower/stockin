/**
 * 认证与首次引导契约。
 * 依据：设计文档 v1.1 §2.1 A1–A4、§3.5、§5.2（认证状态机）、§7.4 首次部署 6 步。
 */
export interface LoginRequest {
  username: string;
  password: string;
}

/** 首次登录强制 /setup：需要初始密码 + 新账密。 */
export interface SetupRequest {
  currentPassword: string;
  username: string;
  password: string;
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
