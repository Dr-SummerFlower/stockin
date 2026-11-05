/**
 * 会话 Cookie 封装。
 *
 * 依据：设计文档 v1.1 §5.2 / §10.2 裁决 28 —— 纯 HTTP 下固定
 * `HttpOnly; SameSite=Lax; Secure=false; Path=/`，**禁用 prefix:'host'**
 * （`__Host-` 前缀要求 Secure，纯 HTTP 会被浏览器直接丢弃）。
 * Cookie 基线全部取自 shared 的 COOKIE_POLICY，本文件不重复定义。
 */
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { COOKIE_POLICY, SESSION_COOKIE_NAME, SESSION_IDLE_DAYS } from '@stockin/shared';

/** 基线选项。刻意不传 `prefix`，避免 __Host- 前缀。 */
const BASE_COOKIE_OPTIONS = {
  httpOnly: COOKIE_POLICY.httpOnly,
  sameSite: COOKIE_POLICY.sameSite,
  secure: COOKIE_POLICY.secure,
  path: COOKIE_POLICY.path,
} as const;

/** 空闲过期秒数，取自 shared 的 SESSION_IDLE_DAYS。 */
export const SESSION_COOKIE_MAX_AGE_SECONDS: number = SESSION_IDLE_DAYS * 86_400;

/** 下发会话 Cookie（明文 token 只在浏览器侧存在）。 */
export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE_NAME, token, {
    ...BASE_COOKIE_OPTIONS,
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
  deleteCookie(c, SESSION_COOKIE_NAME, { ...BASE_COOKIE_OPTIONS });
}
