/**
 * 会话中间件：Cookie sid → `token_hash` → 应用层有效期判定。
 *
 * 依据：设计文档 v1.1 §4.2 / §5.2 / §10.2 裁决 28 —— DB 只存 token_hash；
 * 7d 空闲 / 30d 绝对 / revoked / auth_epoch 四类判定全在应用层
 * （`isSessionValid`）；Cookie 基线复用 T03a `lib/cookie.ts`，禁用 `prefix:'host'`。
 */
import type { MiddlewareHandler } from 'hono';
import { SESSION_IDLE_DAYS } from '@stockin/shared';
import { getSessionCookie, clearSessionCookie } from '../lib/cookie';
import { hashSessionToken } from '../lib/crypto';
import { utcAfterDaysIso, utcNowIso } from '../lib/today';
import {
  isSessionValid,
  toSessionIdentity,
  type SessionIdentity,
  type SessionRepository,
} from '../repositories/session.repository';
import type { MetaRepository } from '../repositories/meta.repository';
import type { CredentialRepository } from '../repositories/credential.repository';
import type { AppEnv } from '../types/hono';

export interface SessionMiddlewareDeps {
  readonly sessions: SessionRepository;
  readonly meta: MetaRepository;
  readonly credentials: CredentialRepository;
}

/** 构造会话中间件；每次有效访问滑动续期空闲过期，绝对过期不变。 */
export function createSessionMiddleware(deps: SessionMiddlewareDeps): MiddlewareHandler<AppEnv> {
  return async (c, next): Promise<void> => {
    const token: string | null = getSessionCookie(c);
    let identity: SessionIdentity | null = null;
    let actor = 'anonymous';

    if (token !== null) {
      const row = deps.sessions.findByTokenHash(hashSessionToken(token));
      const nowUtc: string = utcNowIso();
      if (row !== null && isSessionValid(row, nowUtc, deps.meta.authEpoch())) {
        identity = toSessionIdentity(row);
        actor = deps.credentials.find()?.username ?? 'anonymous';
        deps.sessions.touch(row.id, nowUtc, utcAfterDaysIso(SESSION_IDLE_DAYS));
      } else {
        clearSessionCookie(c);
      }
    }

    c.set('session', identity);
    c.set('actor', actor);
    await next();
  };
}
