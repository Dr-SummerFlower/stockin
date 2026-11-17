/**
 * Hono 应用环境类型（供 `new Hono<AppEnv>()` 使用）。
 *
 * Bindings 刻意**中性化**：改造前继承 `@hono/node-server` 的 `HttpBindings`
 * （`incoming` / `outgoing`），这让整个应用在类型上绑死了 Node。Workers 侧
 * 没有 `incoming.socket`，同一份代码必须两边都能编译。
 *
 * 因此这里只声明运行时中立的字段，`incoming` 保留为**可选**，供 Node 侧的
 * 限流中间件按需读取（Worker 上为 undefined，走平台头部兜底）。
 *
 * Variables 承载 requestId / session / actor / clientIp，贯穿中间件、日志与操作日志表。
 */
import type { SessionIdentity } from '../repositories/session.repository';
import type { AdminIdentity } from '../repositories/admin-session.repository';

/** Node 原生 HTTP 连接的可选窄化视图（仅 @hono/node-server 会注入）。 */
export interface NodeIncomingLike {
  readonly socket?: { readonly remoteAddress?: string };
}

/** 请求作用域绑定的平台对象。 */
export interface AppBindings {
  /** Node（@hono/node-server）注入；Workers 上不存在。 */
  readonly incoming?: NodeIncomingLike;
  /** Workers 的 `[assets]` 绑定；Node 上不存在。 */
  readonly ASSETS?: unknown;
  /** 其余平台绑定按需扩展，避免每接一个运行时都要改类型。 */
  readonly [key: string]: unknown;
}

/** 请求级变量。 */
export interface AppVariables {
  requestId: string;
  session: SessionIdentity | null;
  actor: string;
  clientIp: string;
  /** 管理员身份（独立于店主会话）；未登录为 null。 */
  adminSession: AdminIdentity | null;
  /** 审计署名，形如 `admin:<github_login>`。 */
  adminActor: string;
}

/** 创建 app 时使用的 Env 泛型。 */
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
    adminSession: AdminIdentity | null;
    adminActor: string;
  }
}

export type { SessionIdentity, AdminIdentity };
