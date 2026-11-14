/**
 * 补充说明入口：小圆问号按钮。
 *
 * 展示约定：不重要的小字直接删除；确实无法用简短文字交代的信息才收进气泡。
 * 气泡文案使用中性书面语，不写实现口径、工程术语或劝导语。
 *
 * 交互约定（两段式）：
 * - 指针悬停 → 临时展开，移开即收起。适合顺带看一眼口径。
 * - 点击 → 常显（钉住），移开指针不收起；焦点转移、点击外部或按 Esc 才收起。
 *   适合边填边比照规则。
 * - 键盘聚焦同样展开，失焦即收起，不依赖鼠标。
 *
 * 实现说明：不使用 Popover / portal。此前按钮为兼容表单折叠区调用了
 * `stopPropagation()`，会掐断浮层库挂在 document 上的 click 监听，导致点击
 * 表现不稳定；同时 portal 浮层在弹窗、窄屏与暗色下需要额外处理层级与定位。
 * 现在改为组件内 state 驱动的内联面板，不依赖任何全局事件链。
 *
 * 为什么用单个 `open` 状态而不是 `hovered || focused || pinned` 推导：
 * 推导式写法里 Esc 必须把 `focused` 清成 false 才能收起，但此时按钮仍持有
 * DOM 焦点，之后再 `.focus()` 同一元素不会再派发 focus 事件，状态与真实焦点
 * 就此分叉，面板再也打不开。显式 `open` 由事件驱动，不存在这层失配。
 *
 * 两个容易失手的点，改动时请保持：
 * 1. 按钮的 `::after` 已把 24px 视觉外扩到 44px 热区，纵向盖住了面板上方
 *    8px 的空隙（`top: calc(100% + 8px)`）。指针从按钮移向面板不会触发
 *    `mouseleave`，无需再加桥接伪元素；若调整热区尺寸，这个覆盖关系会失效。
 * 2. 只有 `mouseenter` / `focus` 能打开面板，所以「指针停在按钮上点第二次」
 *    能正常收起而不会被悬停立刻拉起，不需要额外的抑制标志。
 */
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

/** 悬停展开延迟：短到不易察觉，长到能过滤掉鼠标扫过页面时的误触。 */
const HOVER_OPEN_DELAY_MS = 140;
/** 面板与视口边缘的最小间距。 */
const VIEWPORT_MARGIN_PX = 8;

export interface InfoTipProps {
  /** 无障碍标签，说明这条提示讲的是什么。 */
  readonly label: string;
  /** 气泡标题；不传则只显示正文。 */
  readonly title?: string;
  /** 精简后的说明正文。 */
  readonly content: React.ReactNode;
  readonly placement?: 'bottomLeft' | 'bottom' | 'topLeft' | 'top' | 'right';
}

const InfoTip: React.FC<InfoTipProps> = ({
  label,
  title,
  content,
  placement = 'bottomLeft',
}) => {
  const [open, setOpen] = useState<boolean>(false);
  /** 是否被点击钉住：钉住后移开指针不收起。 */
  const [pinned, setPinned] = useState<boolean>(false);

  const rootRef = useRef<HTMLSpanElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  /** 钉住态需要在鼠标离开时读取，用 ref 避免闭包拿到旧值。 */
  const pinnedRef = useRef<boolean>(false);
  const openTimerRef = useRef<number | null>(null);
  const panelId = useId();

  pinnedRef.current = pinned;

  const clearOpenTimer = (): void => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  };

  // 卸载时清掉待触发的定时器，避免对已卸载组件调用 setState。
  useEffect((): (() => void) => {
    return (): void => {
      clearOpenTimer();
    };
  }, []);

  useEffect((): (() => void) | undefined => {
    if (!open) {
      return undefined;
    }
    const onOutsideClick = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setPinned(false);
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setPinned(false);
        setOpen(false);
      }
    };
    document.addEventListener('click', onOutsideClick);
    document.addEventListener('keydown', onKeyDown);
    return (): void => {
      document.removeEventListener('click', onOutsideClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const handleMouseEnter = (): void => {
    // 已展开（多半是钉住）时不再排定时器。
    if (open || openTimerRef.current !== null) {
      return;
    }
    openTimerRef.current = window.setTimeout((): void => {
      openTimerRef.current = null;
      setOpen(true);
    }, HOVER_OPEN_DELAY_MS);
  };

  const handleMouseLeave = (): void => {
    clearOpenTimer();
    // 钉住的说明不因移开指针而消失。
    if (!pinnedRef.current) {
      setOpen(false);
    }
  };

  const handleBlur = (event: React.FocusEvent<HTMLSpanElement>): void => {
    const next = event.relatedTarget as Node | null;
    // 焦点仍在气泡内部时不收起。
    if (next !== null && rootRef.current !== null && rootRef.current.contains(next)) {
      return;
    }
    // 焦点转移即收起：这是「点击常显」的退出条件。
    setPinned(false);
    setOpen(false);
  };

  /**
   * 横向夹取：面板固定 280px 宽、贴着触发器左边缘展开，触发器靠近视口任一侧时
   * 都会溢出。纯 CSS 无解——`left` 对齐在右侧溢出、`right` 对齐在左侧溢出
   * （窄屏曾因此把面板整个折到视口左边、x 为负值）。这里在提交后量一次实际矩形，
   * 只用 translateX 平移，不改布局，因此不影响相邻元素。
   */
  useLayoutEffect((): void => {
    const el = panelRef.current;
    if (!open || el === null) {
      return;
    }
    const vw = document.documentElement.clientWidth;
    const rect = el.getBoundingClientRect();
    let dx = 0;
    if (rect.right > vw - VIEWPORT_MARGIN_PX) {
      dx = vw - VIEWPORT_MARGIN_PX - rect.right;
    }
    // 两侧同时溢出时（面板比可用宽度还宽）以左边界为准，右边界交给 max-width 兜底。
    if (rect.left + dx < VIEWPORT_MARGIN_PX) {
      dx = VIEWPORT_MARGIN_PX - rect.left;
    }
    el.style.transform = dx === 0 ? '' : `translateX(${Math.round(dx)}px)`;
  }, [open]);

  const above: boolean = placement === 'top' || placement === 'topLeft';

  return (
    <span
      className="stockin-info-tip-wrap"
      ref={rootRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={(): void => setOpen(true)}
      onBlur={handleBlur}
    >
      <button
        type="button"
        className="stockin-info-tip"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? panelId : undefined}
        onClick={(event: React.MouseEvent<HTMLButtonElement>): void => {
          // 表单分组在手机端用 <details> 折叠：阻止冒泡与默认行为，避免点问号时误折叠。
          event.preventDefault();
          event.stopPropagation();
          clearOpenTimer();
          if (pinned) {
            setPinned(false);
            setOpen(false);
            return;
          }
          setPinned(true);
          setOpen(true);
        }}
      >
        <span className="stockin-info-tip-mark" aria-hidden="true">
          ?
        </span>
      </button>
      {open ? (
        <div
          className={`stockin-info-tip-panel${above ? ' is-top' : ''}`}
          id={panelId}
          role="tooltip"
          ref={panelRef}
        >
          {title === undefined ? null : <b>{title}</b>}
          <div className="stockin-info-tip-content">{content}</div>
        </div>
      ) : null}
    </span>
  );
};

export default InfoTip;
