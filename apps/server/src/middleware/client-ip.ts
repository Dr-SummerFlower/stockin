/**
 * 客户端 IP 中间件：把 `clientIpOf(c)` 的结果放进 Context。
 *
 * 为什么要单独一层：IP 有两个消费方 —— 限流（`/api/auth/login` 的预检）与
 * 访问日志（安全事件溯源）。此前只有 session 中间件设置它，而 session 排在
 * CSRF 之后：被 CSRF 拒绝的写请求（伪造 Origin / Host，正是最该留痕的一类）
 * 在日志里 `clientIp` 是空串。放在链首附近后，两者都能拿到。
 *
 * 只做「取值 + 落 Context」，不读任何转发头以外的判断逻辑 —— 具体来源
 * （Node 走真实 socket、Workers 走 `CF-Connecting-IP`）由 `clientIpOf` 决定。
 */
import type { MiddlewareHandler } from 'hono';
import { clientIpOf } from './rate-limit';
import type { AppEnv } from '../types/hono';

/** 构造客户端 IP 中间件。 */
export function createClientIpMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next): Promise<void> => {
    c.set('clientIp', clientIpOf(c));
    await next();
  };
}
