/**
 * 会话 Cookie 封装。
 *
 * 依据：设计文档 v1.1 §5.2 / §10.2 裁决 28 ——
 * 纯 HTTP 下 `HttpOnly; SameSite=Lax; Secure=false; Path=/`，**禁用 prefix:'host'**
 * （`__Host-` 前缀要求 Secure，纯 HTTP 会被浏览器直接丢弃）；
 * HTTPS（Workers）下必须带 `Secure`，由 `Env.cookieSecure` 在装配时注入。
 *
 * 其余基线（httpOnly / sameSite / path）仍取自 shared 的 COOKIE_POLICY，
 * 本文件不重复定义常量。
 */
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { COOKIE_POLICY, SESSION_COOKIE_NAME, SESSION_IDLE_DAYS } from '@stockin/shared';

/** 当前进程是否给 Cookie 加 Secure；由 bootstrap 按来源 scheme 注入。 */
let cookieSecure = false;

/**
 * 注入 Secure 开关。
 *
 * 与 `configureServerTimeZone` 同一模式：单进程单配置、装配期设置一次。
 * 之所以不从每个 `c.env` 现读：Cookie 的写入点在路由层，路由层拿不到 `Env`
 * 快照；逐个透传参数会把一个全局事实散成 6 处实参，还把 `lib` 反向依赖到 `env`。
 */
export function configureCookiePolicy(options: { secure: boolean }): void {
  cookieSecure = options.secure;
}

/** 当前生效的 Secure 值（自测与日志用）。 */
export function cookieSecureNow(): boolean {
  return cookieSecure;
}

/** 基线选项。刻意不传 `prefix`，避免 __Host- 前缀。 */
function baseCookieOptions(): {
  httpOnly: boolean;
  sameSite: 'Lax' | 'Strict' | 'None';
  secure: boolean;
  path: string;
} {
  return {
    httpOnly: COOKIE_POLICY.httpOnly,
    sameSite: COOKIE_POLICY.sameSite,
    secure: cookieSecure,
    path: COOKIE_POLICY.path,
  };
}

/** 空闲过期秒数，取自 shared 的 SESSION_IDLE_DAYS。 */
export const SESSION_COOKIE_MAX_AGE_SECONDS: number = SESSION_IDLE_DAYS * 86_400;

/** 下发会话 Cookie（明文 token 只在浏览器侧存在）。 */
export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE_NAME, token, {
    ...baseCookieOptions(),
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  });
}

/** 读取会话 Cookie；缺失或空串返回 null。 */
export function getSessionCookie(c: Context): string | null {
  const value: string | undefined = getCookie(c, SESSION_COOKIE_NAME);
  return value === undefined || value.trim() === '' ? null : value;
}

/** 清除会话 Cookie（登出 / 会话失效）。 */
export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE_NAME, baseCookieOptions());
}
