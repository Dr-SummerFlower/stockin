/**
 * 会话 model：当前登录态与初始化态。
 *
 * 依据：`getInitialState()` / AuthGuard 只信 `GET /api/auth/init-status` 与
 * `GET /api/auth/me`，绝不用 localStorage 判定初始化态。
 * 本 model 只缓存接口结果供布局与页面消费，不作为鉴权真源。
 */
import { useCallback, useState } from 'react';
import type { AuthMeResponse, InitStatusResponse } from '@stockin/shared';
import { getInitStatus, getMe, logout } from '@/services/api/auth';

export interface SessionModelState {
  readonly initStatus: InitStatusResponse | null;
  readonly me: AuthMeResponse | null;
  readonly loading: boolean;
  readonly refresh: () => Promise<void>;
  readonly signOut: () => Promise<void>;
  readonly username: string | null;
  readonly isAuthenticated: boolean;
}

export default function useSessionModel(): SessionModelState {
  const [initStatus, setInitStatus] = useState<InitStatusResponse | null>(null);
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [status, current] = await Promise.all([
        getInitStatus().catch(() => null),
        getMe().catch(() => null),
      ]);
      setInitStatus(status);
      setMe(current);
    } finally {
      setLoading(false);
    }
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    await logout().catch(() => undefined);
    setMe(null);
  }, []);

  const username: string | null = me?.user?.username ?? initStatus?.username ?? null;
  const isAuthenticated: boolean = me?.authenticated === true;

  return { initStatus, me, loading, refresh, signOut, username, isAuthenticated };
}
