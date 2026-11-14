/**
 * Umi 运行时配置。
 *
 * 依据：主理人 T04 口径 ——
 * `getInitialState()` **只信 GET /api/auth/init-status**（绝不用 localStorage
 * 判初始化态）；`onRouteChange` 做 AuthGuard；chunk 加载失败提示刷新兜底。
 * 另把 `history` / 提示器注入 `services/request.ts`，使统一拦截层不反向依赖
 * 运行时配置（避免循环导入）。
 *
 * 界面 v1.0：`rootContainer` 挂一层 ThemeRoot（ConfigProvider）+ antd App。
 * 主题为「浅色 / 深色 / 跟随系统」三态，令牌取自 design/stockin-ui-design-system.md
 * §9.1；浅色默认墨绿 #1F6B52，深色走 darkAlgorithm + 去饱和主色 #5DBB92。
 * 解析后的外观由 utils/theme.ts 的模块级单例提供，首屏已打标，无闪烁。
 */
import { App as AntdApp, ConfigProvider, message, theme as antdTheme, type ThemeConfig } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import { useEffect, useMemo, useSyncExternalStore, type ReactElement, type ReactNode } from 'react';
import { defineApp, history } from 'umi';
import { getInitStatus, getMe } from '@/services/api/auth';
import {
  setRequestNavigator,
  setRequestNotifier,
  type NoticeLevel,
} from '@/services/request';
import { installChunkLoadFallback } from '@/components/ChunkLoadFallback';
import {
  getServerThemeSnapshot,
  getThemeSnapshot,
  subscribeTheme,
  type Appearance,
} from '@/utils/theme';

/** 与 global.css 的 --stockin-font-sans 保持一致，不引入外部 Web Font。 */
const FONT_FAMILY =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif";

/** 日期面板用中文：日期选择器的月份、星期、按钮文案都取自 dayjs 语言包。 */
dayjs.locale('zh-cn');

const BASE_TOKEN: ThemeConfig['token'] = {
  fontFamily: FONT_FAMILY,
  fontSize: 14,
  borderRadius: 6,
  borderRadiusLG: 10,
  /** 控件统一 44px：按钮、输入框、日期、下拉高度一致，同时满足触控最小尺寸。 */
  controlHeight: 44,
  motionDurationMid: '0.15s',
};

/** 浅色墨绿令牌（设计文档 §9.1 映射）。 */
const LIGHT_TOKEN: ThemeConfig['token'] = {
  ...BASE_TOKEN,
  colorPrimary: '#1F6B52',
  colorPrimaryHover: '#18573F',
  colorPrimaryText: '#1F6B52',
  colorPrimaryBg: '#E8F2ED',
  colorPrimaryBgHover: '#D7E9DF',
  colorPrimaryBorder: '#C6DED2',
  colorInfo: '#1F6B52',
  colorLink: '#1F6B52',
  colorText: '#1B2421',
  colorTextSecondary: '#4F5A55',
  colorTextTertiary: '#616D67',
  colorTextQuaternary: '#616D67',
  colorBgLayout: '#F7F8F6',
  colorBgContainer: '#FDFDFC',
  colorBgElevated: '#FDFDFC',
  colorBorder: '#E1E6E2',
  colorBorderSecondary: '#E1E6E2',
  colorError: '#B3261E',
  colorWarning: '#9C4F06',
  colorSuccess: '#2F6B3A',
};

/** 深色令牌：靠更亮的表面分层，主色去饱和。 */
const DARK_TOKEN: ThemeConfig['token'] = {
  ...BASE_TOKEN,
  colorBgBase: '#121A17',
  colorPrimary: '#5DBB92',
  colorPrimaryHover: '#7ACCA6',
  colorPrimaryText: '#5DBB92',
  colorPrimaryBg: '#1C3328',
  colorPrimaryBgHover: '#244434',
  colorPrimaryBorder: '#2D5340',
  colorInfo: '#5DBB92',
  colorLink: '#5DBB92',
  colorText: '#EDF2EF',
  colorTextSecondary: '#B6C2BB',
  colorTextTertiary: '#93A29A',
  colorTextQuaternary: '#93A29A',
  colorBgLayout: '#121A17',
  colorBgContainer: '#18221E',
  colorBgElevated: '#202C27',
  /**
   * 主按钮实心底上的文字色。darkAlgorithm 派生的实心底实测为 #52a27f，
   * 默认白字仅 3.07:1（不达 WCAG AA 4.5:1）；改用深墨绿后为 5.81:1。
   * 同时作用于 Tooltip / 选中格等实底元素，暗色下它们本就是「深底深字」组合。
   */
  colorTextLightSolid: '#0E1A14',
  colorBorder: '#2B3A33',
  colorBorderSecondary: '#2B3A33',
  colorError: '#EE8B84',
  colorWarning: '#E3A25C',
  colorSuccess: '#7BC48B',
};

function configFor(appearance: Appearance, reducedMotion: boolean): ThemeConfig {
  const base: ThemeConfig['token'] = appearance === 'dark' ? DARK_TOKEN : LIGHT_TOKEN;
  const dark: boolean = appearance === 'dark';
  /**
   * 系统要求减少动态效果时，由 antd 自己关掉动效（`motion:false` 会让组件
   * 不再挂 motion 类名，弹层一次定位到位）。
   *
   * **不要**改用 CSS 把 animation-duration 压成 0：日期/下拉弹层的定位依赖
   * 出现动画的时序，动画被压没后 rc-align 的第二次测量会算错，弹层被停到
   * `-1000vh/-1000vw` 起步位（实测 inset 变成 ±1 万像素）——表现为点了没反应、
   * 同时闪一下横向滚动条。详见 global.css 末尾的说明。
   */
  return {
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: reducedMotion ? { ...base, motion: false } : base,
    /**
     * Tooltip 的文字色取全局 `colorTextLightSolid`、底色取 `colorBgSpotlight`。
     * 本项目暗色的 `colorTextLightSolid` 为深墨绿（为修主按钮对比度而设），
     * 与暗色算法派生的 `colorBgSpotlight` 撞成「深底深字」，故在此按主题
     * 单独指定这一对取值，不能用 `token` 覆盖（会连带影响主按钮）。
     */
    components: {
      Tooltip: dark
        ? { colorBgSpotlight: '#202C27', colorTextLightSolid: '#EDF2EF' }
        : { colorBgSpotlight: '#FDFDFC', colorTextLightSolid: '#1B2421' },
    },
  };
}

/** 唯一一层 Provider：覆盖 /login、/setup、404 等所有顶层路由。 */
function ThemeRoot({ children }: { children: ReactNode }): ReactElement {
  const snapshot = useSyncExternalStore(
    subscribeTheme,
    getThemeSnapshot,
    getServerThemeSnapshot,
  );
  const config = useMemo(
    () => configFor(snapshot.appearance, snapshot.reducedMotion),
    [snapshot.appearance, snapshot.reducedMotion],
  );
  return (
    <ConfigProvider theme={config} locale={zhCN}>
      {children}
    </ConfigProvider>
  );
}

/**
 * 把 antd App 的 message 实例注入统一拦截层。
 * 静态 `message.*` 不受 ConfigProvider 影响，改用 holder 实例才能随主题切换。
 */
function NotifierBinder(): null {
  const { message: holderMessage } = AntdApp.useApp();
  useEffect((): void => {
    setRequestNotifier((level: NoticeLevel, content: string): void => {
      switch (level) {
        case 'success':
          holderMessage.success(content);
          break;
        case 'warning':
          holderMessage.warning(content);
          break;
        case 'info':
          holderMessage.info(content);
          break;
        case 'error':
        default:
          holderMessage.error(content);
          break;
      }
    });
  }, [holderMessage]);
  return null;
}

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

/** 首屏兜底提示器；React 挂载后由 NotifierBinder 覆盖为跟随主题的实例。 */
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
  rootContainer(container: ReactElement): ReactElement {
    return (
      <ThemeRoot>
        <AntdApp>
          <NotifierBinder />
          {container}
        </AntdApp>
      </ThemeRoot>
    );
  },
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
