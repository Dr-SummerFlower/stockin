/**
 * Hono 应用环境类型（供 T03b 的 `new Hono<AppEnv>()` 使用）。
 *
 * Bindings 继承 @hono/node-server 的 HttpBindings（incoming/outgoing），
 * 供限流中间件取 `c.env.incoming.socket.remoteAddress`；
 * Variables 承载 requestId / session / actor，贯穿中间件、日志与操作日志表。
 */
import type { HttpBindings } from '@hono/node-server';
import type { SessionIdentity } from '../repositories/session.repository';

/** 具备静态托管根与数据库句柄能力的 Bindings 扩展。 */
export interface AppBindings extends HttpBindings {
  readonly publicOrigins: readonly string[];
  readonly staticRoot: string;
}

/** 请求级变量。 */
export interface AppVariables {
  requestId: string;
  session: SessionIdentity | null;
  actor: string;
  clientIp: string;
}

/** T03b 创建 app 时使用的 Env 泛型。 */
export interface AppEnv {
  Bindings: AppBindings;
  Variables: AppVariables;
}

/** 同时扩展 Hono 的全局 ContextVariableMap，便于裸 Context 也能取到变量。 */
declare module 'hono' {
  interface ContextVariableMap {
    requestId: string;
    session: SessionIdentity | null;
    actor: string;
    clientIp: string;
  }
}

export type { HttpBindings, SessionIdentity };
