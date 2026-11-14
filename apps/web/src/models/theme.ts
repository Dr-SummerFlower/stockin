/**
 * 主题 model（Umi）：供设置页切换三态、供组件读取解析后的外观。
 *
 * 状态真源在 `utils/theme.ts` 的模块级单例，本 model 只做订阅桥接，
 * 避免 `app.tsx` 的 rootContainer 与 Umi model Provider 产生顺序依赖。
 */
import { useSyncExternalStore } from 'react';
import {
  getServerThemeSnapshot,
  getThemeSnapshot,
  setThemeMode,
  subscribeTheme,
  type Appearance,
  type ThemeMode,
} from '@/utils/theme';

export interface ThemeModelState {
  /** 用户选择：浅色 / 深色 / 跟随系统。 */
  readonly mode: ThemeMode;
  /** 解析后的实际外观：浅色 / 深色。 */
  readonly appearance: Appearance;
  readonly setMode: (mode: ThemeMode) => void;
}

export default function useThemeModel(): ThemeModelState {
  const snapshot = useSyncExternalStore(
    subscribeTheme,
    getThemeSnapshot,
    getServerThemeSnapshot,
  );
  return {
    mode: snapshot.mode,
    appearance: snapshot.appearance,
    setMode: setThemeMode,
  };
}
