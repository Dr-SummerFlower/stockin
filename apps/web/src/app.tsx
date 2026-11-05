/**
 * Umi 运行时配置。
 *
 * 依据：主理人 T04 口径 ——
 * `getInitialState()` **只信 GET /api/auth/init-status**（绝不用 localStorage
 * 判初始化态）；`onRouteChange` 做 AuthGuard；chunk 加载失败提示刷新兜底。
 * 另把 `history` / antd `message` 注入 `services/request.ts` 的导航器与提示器，
 * 让统一拦截层不反向依赖运行时配置（避免循环导入）。
 * 裸 umi 的 `defineApp` 类型依赖生成目录，typecheck 沿用 T01 的 `umi setup` 前置。
 */
import { message } from 'antd';
import { defineApp, history } from 'umi';
import { getInitStatus, getMe } from '@/services/api/auth';
import {
  setRequestNavigator,
  setRequestNotifier,
  type NoticeLevel,
} from '@/services/request';
import { installChunkLoadFallback } from '@/components/ChunkLoadFallback';

/** 初始化态（只由 `GET /api/auth/init-status` 填充，不读 localStorage）。 */
export type InitialState = {
  initialized: boolean;
  initState: 0 | 1;
  username: string | null;
};

/** 绑定 SPA 导航：401 跳登录 / 403 跳引导由 request.ts 触发。 */
setRequestNavigator((path: string): void => {
  history.push(path);
});

/** 绑定全局提示：429 / 5xx / 网络异常由 request.ts 触发。 */
setRequestNotifier((level: NoticeLevel, content: string): void => {
  switch (level) {
    case 'success':
      message.success(content);
      break;
    case 'warning':
      message.warning(content);
      break;
    case 'info':
      message.info(content);
      break;
    case 'error':
    default:
      message.error(content);
      break;
  }
});

/**
 * 路由守卫：
 * - 已完成初始化（initState=1）：未登录 → /login；已登录 → 放行。
 * - 未完成初始化（initState=0 首启）：先检测登录态 ——
 *   未登录 → /login（输入部署日志中的初始密码）；
 *   已用初始密码登录 → /setup（设置正式账号与密码）。
 * 即「首启先登录、用初始密码登录后跳转设置密码」。
 */
async function authGuard(pathname: string): Promise<void> {
  if (pathname === '/login' || pathname === '/setup' || pathname === '/404') {
    return;
  }
  const init = await getInitStatus().catch(() => null);
  if (init !== null && init.initState === 0) {
    const me = await getMe().catch(() => null);
    if (me !== null && me.authenticated) {
      history.push('/setup');
    } else {
      history.push('/login');
    }
    return;
  }
  const me = await getMe().catch(() => null);
  if (me !== null && !me.authenticated) {
    history.push('/login');
  }
}

export default defineApp({
  async getInitialState(): Promise<InitialState> {
    const status = await getInitStatus().catch(() => null);
    return {
      // 探测失败时保守视为「已初始化且未登录」，交由 onRouteChange 的 me 兜底。
      initialized: status?.initialized ?? true,
      initState: status?.initState ?? 1,
      username: status?.username ?? null,
    };
  },
  onRouteChange({ location }): void {
    void authGuard(location?.pathname ?? '/');
  },
});

installChunkLoadFallback();
