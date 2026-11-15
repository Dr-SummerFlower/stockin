/**
 * 登录失败限流：5 次 / 15 分钟，**IP 与 IP+用户名双维度**内存计数。
 *
 * 依据：设计文档 v1.1 §3.6、§3.5（429 读 Retry-After）；客户端 IP 只取
 * `c.env.incoming.socket.remoteAddress`，**禁用 XFF**。时钟只读 T03a
 * `lib/today.ts` 的 `epochSeconds()`，本模块不直接调用 Date.now()。
 */
import type { Context, MiddlewareHandler } from 'hono';
import { ErrorCode, LOGIN_RATE_LIMIT } from '@stockin/shared';
import { epochSeconds } from '../lib/today';
import { errorResponse } from '../lib/response';
import type { AppEnv } from '../types/hono';

interface Bucket {
  count: number;
  /** Unix 秒；到达即视为窗口结束。 */
  resetAt: number;
}

const WINDOW_SECONDS: number = LOGIN_RATE_LIMIT.windowMinutes * 60;
const MAX_ATTEMPTS: number = LOGIN_RATE_LIMIT.maxAttempts;

/** 按 IP 的计数桶。 */
const byIp = new Map<string, Bucket>();
/** 按 IP + 用户名的计数桶。 */
const byIpUser = new Map<string, Bucket>();

/** 供其它中间件复用的客户端 IP 提取（只认真实 socket）。 */
export function clientIpOf(c: Context): string {
  const raw: unknown = (c.env as { incoming?: { socket?: { remoteAddress?: string } } })?.incoming
    ?.socket?.remoteAddress;
  return typeof raw === 'string' && raw !== '' ? raw : 'unknown';
}

function pairKey(ip: string, username: string): string {
  return `${ip}\u0000${username}`;
}

function windowBucket(map: Map<string, Bucket>, key: string, now: number): Bucket {
  const existing: Bucket | undefined = map.get(key);
  if (existing !== undefined && existing.resetAt > now) {
    return existing;
  }
  const fresh: Bucket = { count: 0, resetAt: now + WINDOW_SECONDS };
  map.set(key, fresh);
  return fresh;
}

/** 记录一次登录失败；两个维度同时累加。 */
export function recordLoginFailure(ip: string, username: string): void {
  const now: number = epochSeconds();
  windowBucket(byIp, ip, now).count += 1;
  windowBucket(byIpUser, pairKey(ip, username), now).count += 1;
}

/** 登录成功后清空该 IP / 用户的失败记录。 */
export function clearLoginFailures(ip: string, username: string): void {
  byIp.delete(ip);
  byIpUser.delete(pairKey(ip, username));
}

/** 当前限流状态；retryAfterSeconds 为剩余窗口秒数。 */
export function loginBlockState(
  ip: string,
  username: string,
): { blocked: boolean; retryAfterSeconds: number } {
  const now: number = epochSeconds();
  const candidates: Bucket[] = [];
  const ipBucket: Bucket | undefined = byIp.get(ip);
  if (ipBucket !== undefined && ipBucket.resetAt > now) {
    candidates.push(ipBucket);
  }
  const pairBucket: Bucket | undefined = byIpUser.get(pairKey(ip, username));
  if (pairBucket !== undefined && pairBucket.resetAt > now) {
    candidates.push(pairBucket);
  }
  let retryAfterSeconds = 0;
  let blocked = false;
  for (const bucket of candidates) {
    if (bucket.count >= MAX_ATTEMPTS) {
      blocked = true;
      retryAfterSeconds = Math.max(retryAfterSeconds, bucket.resetAt - now);
    }
  }
  return { blocked, retryAfterSeconds: Math.max(1, retryAfterSeconds) };
}

/**
 * 构造限流中间件：登录请求在预检阶段按 IP 维度拦截（用户名尚未解析），
 * 并按 Retry-After 返回 429；失败计数由 auth.service 调用 recordLoginFailure。
 */
export function createRateLimitMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next): Promise<Response | void> => {
    if (c.req.path === '/api/auth/login' && c.req.method === 'POST') {
      const state = loginBlockState(clientIpOf(c), '');
      if (state.blocked) {
        const response: Response = errorResponse(
          ErrorCode.AUTH_RATE_LIMITED,
          c.get('requestId') ?? '',
        );
        response.headers.set('retry-after', String(state.retryAfterSeconds));
        return response;
      }
    }
    await next();
  };
}
