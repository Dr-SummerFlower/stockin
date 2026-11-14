/**
 * 主题状态（模块级单例）：浅色 / 深色 / 跟随系统三态。
 *
 * 设计约束：
 * - 纯 HTTP + CSP `default-src 'self'`，不能依赖内联 <script>；本模块在入口
 *   `app.tsx` 被 import 时立即执行 `apply()`，早于 React 首屏渲染，因此无闪烁。
 * - 系统偏好由 `@media (prefers-color-scheme: dark)` 配合 `data-theme="system"`
 *   在 global.css 中覆盖，JS 只负责首屏打标、持久化和把解析后的外观交给
 *   antd ConfigProvider（`darkAlgorithm`）。
 * - `useSyncExternalStore` 的 getSnapshot 必须返回稳定引用，故用缓存快照。
 */
export type ThemeMode = 'light' | 'dark' | 'system';
export type Appearance = 'light' | 'dark';

export interface ThemeSnapshot {
  readonly mode: ThemeMode;
  readonly appearance: Appearance;
  /**
   * 系统是否要求「减少动态效果」。
   *
   * 由 antd 的 `token.motion=false` 消费：**必须**在 antd 侧关闭动效，
   * 不能用 CSS 把 animation-duration 压到 0（详见 global.css 末尾注释）——
   * 弹层靠 appear 动画完成对齐，动画被压没后 rc-align 会把弹层算到视口外。
   */
  readonly reducedMotion: boolean;
}

const STORAGE_KEY = 'stockin-theme-mode';
const DARK_QUERY = '(prefers-color-scheme: dark)';
const MOTION_QUERY = '(prefers-reduced-motion: reduce)';

const listeners = new Set<() => void>();

function isThemeMode(value: string | null): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

function readStoredMode(): ThemeMode {
  if (typeof window === 'undefined') return 'system';
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (isThemeMode(raw)) return raw;
  } catch {
    // 隐私模式 / 存储被禁用：退回跟随系统，不影响使用。
  }
  return 'system';
}

function readSystemDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(DARK_QUERY).matches;
}

function readReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(MOTION_QUERY).matches;
}

let currentMode: ThemeMode = readStoredMode();
let systemDark: boolean = readSystemDark();
let currentReducedMotion: boolean = readReducedMotion();

function resolveAppearance(mode: ThemeMode): Appearance {
  return mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
}

/** 把当前模式打到 <html>，CSS 与 antd 都据此取色。 */
function apply(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = currentMode;
  root.dataset.appearance = resolveAppearance(currentMode);
}

// 模块加载即应用：早于 React 挂载，避免首屏浅色闪烁。
apply();

let snapshot: ThemeSnapshot = {
  mode: currentMode,
  appearance: resolveAppearance(currentMode),
  reducedMotion: currentReducedMotion,
};

const SERVER_SNAPSHOT: ThemeSnapshot = {
  mode: 'light',
  appearance: 'light',
  reducedMotion: false,
};

function refreshSnapshot(): void {
  const appearance = resolveAppearance(currentMode);
  if (
    snapshot.mode === currentMode &&
    snapshot.appearance === appearance &&
    snapshot.reducedMotion === currentReducedMotion
  ) {
    return;
  }
  snapshot = { mode: currentMode, appearance, reducedMotion: currentReducedMotion };
  listeners.forEach((listener) => listener());
}

/** 系统偏好监听：暗色与「减少动态效果」共用一套 addEventListener 兼容写法。 */
function watchQuery(query: string, onChange: (matches: boolean) => void): void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  const list = window.matchMedia(query);
  const handler = (event: MediaQueryListEvent | MediaQueryList): void => {
    onChange(event.matches);
  };
  if (typeof list.addEventListener === 'function') {
    list.addEventListener('change', handler as (event: MediaQueryListEvent) => void);
  } else if (typeof list.addListener === 'function') {
    list.addListener(handler as (event: MediaQueryListEvent) => void);
  }
}

watchQuery(DARK_QUERY, (matches: boolean): void => {
  systemDark = matches;
  apply();
  refreshSnapshot();
});

// 系统开关「动画效果」后立即切换 antd 动效，无需刷新页面。
watchQuery(MOTION_QUERY, (matches: boolean): void => {
  currentReducedMotion = matches;
  refreshSnapshot();
});

export function getThemeSnapshot(): ThemeSnapshot {
  return snapshot;
}

export function getServerThemeSnapshot(): ThemeSnapshot {
  return SERVER_SNAPSHOT;
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

export function setThemeMode(mode: ThemeMode): void {
  if (mode === currentMode) return;
  currentMode = mode;
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // 存储不可用时仍保证本次会话内切换生效。
  }
  apply();
  refreshSnapshot();
}

export const THEME_MODE_OPTIONS: readonly { readonly value: ThemeMode; readonly label: string }[] = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
];
