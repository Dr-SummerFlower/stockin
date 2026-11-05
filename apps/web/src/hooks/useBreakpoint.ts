/**
 * 响应式断点 hook：三档口径（主理人 T04）。
 *
 * - mobile：<768（手机）
 * - tablet：768–1199（平板）
 * - desktop：≥1200（桌面）
 *
 * 用 `matchMedia` + `change` 事件，避免逐像素 resize 抖动；SSR/首屏给保守默认值。
 */
import { useEffect, useState } from 'react';
import { TOUCH_TARGET_MIN_PX } from '@/constants/routes';

export type Breakpoint = 'mobile' | 'tablet' | 'desktop';

export interface BreakpointState {
  readonly breakpoint: Breakpoint;
  readonly width: number;
  readonly isMobile: boolean;
  readonly isTablet: boolean;
  readonly isDesktop: boolean;
  /** 是否为「表格降级为卡片列表」的断点（<768）。 */
  readonly useCardList: boolean;
  /** 触控目标最小尺寸，供内联样式复用。 */
  readonly touchTargetPx: number;
}

const MOBILE_MAX = 767;
const TABLET_MAX = 1_199;

/** 纯函数：宽度 → 断点（便于内联自测与跨组件一致）。 */
export function resolveBreakpoint(width: number): Breakpoint {
  if (width <= MOBILE_MAX) {
    return 'mobile';
  }
  if (width <= TABLET_MAX) {
    return 'tablet';
  }
  return 'desktop';
}

function currentWidth(): number {
  if (typeof window === 'undefined') {
    return 1_440;
  }
  return window.innerWidth;
}

/** 订阅窗口断点变化，返回三档状态。 */
export function useBreakpoint(): BreakpointState {
  const [width, setWidth] = useState<number>(() => currentWidth());

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const onChange = (): void => setWidth(window.innerWidth);
    onChange();
    window.addEventListener('resize', onChange);
    window.addEventListener('orientationchange', onChange);
    const mobileQuery: MediaQueryList = window.matchMedia(`(max-width: ${MOBILE_MAX}px)`);
    const tabletQuery: MediaQueryList = window.matchMedia(
      `(min-width: ${MOBILE_MAX + 1}px) and (max-width: ${TABLET_MAX}px)`,
    );
    mobileQuery.addEventListener('change', onChange);
    tabletQuery.addEventListener('change', onChange);
    return () => {
      window.removeEventListener('resize', onChange);
      window.removeEventListener('orientationchange', onChange);
      mobileQuery.removeEventListener('change', onChange);
      tabletQuery.removeEventListener('change', onChange);
    };
  }, []);

  const breakpoint: Breakpoint = resolveBreakpoint(width);
  return {
    breakpoint,
    width,
    isMobile: breakpoint === 'mobile',
    isTablet: breakpoint === 'tablet',
    isDesktop: breakpoint === 'desktop',
    useCardList: breakpoint === 'mobile',
    touchTargetPx: TOUCH_TARGET_MIN_PX,
  };
}
