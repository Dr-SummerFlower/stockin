/**
 * 首次漫游导航（AntD 5 Tour）。
 *
 * 交互原则：**不主动切页**。跨页步骤把高亮放在目标入口（导航项 / 新增按钮）上，
 * 由用户自己点击完成跳转；检测到路径与预期一致后自动进入下一步。
 *
 * 锚点稳定性：
 * - 步骤切换后先等目标挂载（最多约 1.2s），未就绪时不渲染 Tour，
 *   杜绝「页面还没加载完、遮罩就把整页当目标」导致遮罩消失；
 * - 实在找不到目标时退回居中弹层（`target: null`），保留全屏遮罩；
 * - 从任意页面重新打开引导时，从**当前页对应的步骤**开始，而不是总从第 1 步。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Tour } from 'antd';
import { useLocation, useNavigate } from 'umi';

const TOUR_DONE_KEY = 'stockin-tour-done';
const TOUR_RESET_EVENT = 'stockin:tour-reset';
/** 切页后等待目标挂载的轮询间隔与次数。 */
const ANCHOR_RETRY_MS = 100;
const ANCHOR_MAX_TRIES = 12;

export function isTourDone(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(TOUR_DONE_KEY) === '1';
  } catch {
    // 存储不可用时不再反复打扰。
    return true;
  }
}

export function markTourDone(): void {
  try {
    window.localStorage.setItem(TOUR_DONE_KEY, '1');
  } catch {
    // 忽略：本次会话内关闭即可。
  }
}

/** 清除完成态并通知已挂载的 Tour 立即重开（设置页「重新查看」）。 */
export function resetTour(): void {
  try {
    window.localStorage.removeItem(TOUR_DONE_KEY);
  } catch {
    // 忽略。
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(TOUR_RESET_EVENT));
  }
}

/** 按 data-tour-id 找可见锚点；隐藏元素（display:none）不返回，避免弹层定位错乱。 */
function findTarget(id: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(`[data-tour-id="${id}"]`));
  return nodes.find((node) => node.offsetParent !== null) ?? null;
}

interface TourScene {
  /** 该步所在页面。 */
  readonly path: string;
  readonly target: string;
  readonly title: string;
  readonly description: string;
  /** 弹层相对目标的放置方向；侧栏用 right、页首用 bottom、页尾用 top。 */
  readonly placement: 'right' | 'bottom' | 'bottomRight' | 'top';
  /** 操作步骤：用户点击高亮入口后应到达的路径；到达即自动进入下一步。 */
  readonly waitForPath?: string;
}

const SCENES: readonly TourScene[] = [
  {
    path: '/',
    target: 'nav-dashboard',
    title: '统计大屏',
    description: '汇总库存总量、临期与过期情况，作为日常入口。',
    placement: 'right',
  },
  {
    path: '/',
    target: 'dashboard-metrics',
    title: '关键指标',
    description:
      '指标带展示累计金额、进货笔数、商品种类与数量；下方分别列出临期、过期与最近录入的明细。',
    placement: 'bottom',
  },
  {
    path: '/',
    target: 'nav-records',
    title: '进入进货记录',
    description: '点击左侧「进货记录」，查看、筛选与导出全部记录。',
    placement: 'right',
    waitForPath: '/records',
  },
  {
    path: '/records',
    target: 'record-filter',
    title: '组合筛选',
    description:
      '商品名称与规格按开头文字匹配，可与日期区间、到期状态组合；当前筛选条件会随导出保留。',
    placement: 'bottom',
  },
  {
    path: '/records',
    target: 'records-new',
    title: '新增记录',
    description: '点击右上角「新增记录」，进入录入表单。',
    placement: 'bottomRight',
    waitForPath: '/records/new',
  },
  {
    path: '/records/new',
    target: 'record-base',
    title: '基础信息',
    description:
      '商品名称与进货日期为必填项；名称输入时会提示历史商品，选中后带出最近一次的规格与单价。规格与备注可留空，规格同样提供历史建议。',
    placement: 'bottom',
  },
  {
    path: '/records/new',
    target: 'record-date',
    title: '日期信息（三选二）',
    description:
      '生产日期、保质期、到期日期三项中填任意两项，第三项自动计算。手动修改某一项后，该组锁定，不再覆盖你的输入。',
    placement: 'bottom',
  },
  {
    path: '/records/new',
    target: 'record-amount',
    title: '金额信息（三选二）',
    description:
      '单价、数量、金额三项中填任意两项，第三项按「单价 × 数量」自动补算（允许 1 分钱舍入容差）；手动修改后同样锁定。',
    placement: 'bottom',
  },
  {
    path: '/records/new',
    target: 'record-submit',
    title: '保存记录',
    description:
      '「保存记录」提交并返回列表，「取消」放弃本次录入。保存后仍可在列表中编辑，删除会先进入回收站。',
    placement: 'top',
  },
  {
    path: '/records/new',
    target: 'nav-settings',
    title: '进入设置',
    description: '点击左侧「设置」，调整店铺信息、外观与账号安全。',
    placement: 'right',
    waitForPath: '/settings',
  },
  {
    path: '/settings',
    target: 'settings-shop',
    title: '店铺与阈值',
    description: '店铺名称显示在品牌位；临期阈值决定多少天内计入临期，默认 30 天。',
    placement: 'bottom',
  },
  {
    path: '/settings',
    target: 'settings-security',
    title: '账号与备份',
    description:
      '可修改密码与密保问题，修改后全部设备需重新登录；备份保留最近 7 份，可随时手动创建。',
    placement: 'top',
  },
];

type AnchorState = 'wait' | 'ok' | 'center';

const OnboardingTour: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState<boolean>(false);
  const [current, setCurrent] = useState<number>(0);
  const [anchor, setAnchor] = useState<AnchorState>('wait');
  /** 启动前置阶段：先回大屏并等内容就绪，再打开第 1 步。 */
  const [starting, setStarting] = useState<boolean>(false);
  const started = useRef<boolean>(false);
  const locationRef = useRef<string>(location.pathname);
  locationRef.current = location.pathname;

  /** 引导统一从第 1 步开始：先回到大屏，等内容渲染后再显示。 */
  const startFromBeginning = useCallback((): void => {
    setOpen(false);
    setCurrent(0);
    setAnchor('wait');
    setStarting(true);
    if (locationRef.current !== '/') {
      navigate('/');
    }
  }, [navigate]);

  useEffect((): (() => void) => {
    if (!started.current && !isTourDone()) {
      started.current = true;
      startFromBeginning();
    }
    return (): void => undefined;
  }, [startFromBeginning]);

  useEffect((): (() => void) => {
    const handler = (): void => startFromBeginning();
    window.addEventListener(TOUR_RESET_EVENT, handler);
    return (): void => {
      window.removeEventListener(TOUR_RESET_EVENT, handler);
    };
  }, [startFromBeginning]);

  // 启动前置：等大屏内容挂载（以指标带为准），最多约 2s，超时也照常开始。
  useEffect((): (() => void) | undefined => {
    if (!starting || location.pathname !== '/') return undefined;
    let cancelled = false;
    let tries = 0;
    let timer = 0;
    const check = (): void => {
      if (cancelled) return;
      if (findTarget('dashboard-metrics') !== null || tries >= 20) {
        setStarting(false);
        setOpen(true);
        return;
      }
      tries += 1;
      timer = window.setTimeout(check, 100);
    };
    check();
    return (): void => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [location.pathname, starting]);

  const finish = useCallback((): void => {
    setOpen(false);
    setStarting(false);
    markTourDone();
  }, []);

  // 锚点就绪检测：页面未挂载/路由未切到目标页时先等待，最多重试约 1.2s。
  useEffect((): (() => void) | undefined => {
    if (!open) {
      setAnchor('wait');
      return undefined;
    }
    const scene: TourScene | undefined = SCENES[current];
    if (scene === undefined) {
      setAnchor('center');
      return undefined;
    }
    let cancelled = false;
    let tries = 0;
    let timer = 0;

    const check = (): void => {
      if (cancelled) return;
      // 当前步骤不在这一页：等待用户点击入口或上一步的跨页导航。
      if (scene.path !== location.pathname) {
        setAnchor('wait');
        return;
      }
      if (findTarget(scene.target) !== null) {
        setAnchor('ok');
        return;
      }
      if (tries >= ANCHOR_MAX_TRIES) {
        // 目标确实找不到：居中显示，但保留全屏遮罩，避免「遮罩消失」。
        setAnchor('center');
        return;
      }
      tries += 1;
      timer = window.setTimeout(check, ANCHOR_RETRY_MS);
    };

    setAnchor('wait');
    check();
    return (): void => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [current, location.pathname, open]);

  // 若先退回居中（目标迟到），继续轻量轮询；目标出现后升级为锚定。
  useEffect((): (() => void) | undefined => {
    if (!open) return undefined;
    const timer = window.setInterval((): void => {
      const item: TourScene | undefined = SCENES[current];
      if (
        item !== undefined &&
        item.path === location.pathname &&
        findTarget(item.target) !== null
      ) {
        setAnchor((value: AnchorState): AnchorState => (value === 'center' ? 'ok' : value));
      }
    }, 400);
    return (): void => window.clearInterval(timer);
  }, [current, location.pathname, open]);

  // 页面被用户手动切换（浏览器前进/后退等）时，同步到该页对应的步骤。
  // 点击高亮入口的跨页同样走这里，锚点检测会等目标挂载后再显示。
  useEffect((): void => {
    if (!open) return;
    if (SCENES[current]?.path === location.pathname) return;
    const index: number = SCENES.findIndex((item) => item.path === location.pathname);
    if (index >= 0) {
      setCurrent(index);
    }
  }, [current, location.pathname, open]);

  const scene: TourScene = SCENES[current] ?? SCENES[0]!;
  const isActionStep: boolean = scene.waitForPath !== undefined;
  const visible: boolean = open && anchor !== 'wait';
  // 只允许在**同一页内**回退：跨页回退会重挂布局并丢失引导状态。
  const canGoPrev: boolean =
    current > 0 && SCENES[current - 1]?.path === location.pathname;

  const scenes = SCENES.map((item) => ({
    title: item.title,
    description: item.description,
    placement: item.placement,
    // 目标缺失时返回 null，Tour 会居中显示并保留全屏遮罩。
    target: (): HTMLElement => (findTarget(item.target) ?? null) as HTMLElement,
  }));

  return (
    <Tour
      open={visible}
      current={current}
      onChange={(next: number): void => setCurrent(next)}
      onClose={finish}
      onFinish={finish}
      steps={scenes}
      actionsRender={(_origin, info): React.ReactNode => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <Button type="link" size="small" style={{ paddingInline: 0 }} onClick={finish}>
            跳过引导
          </Button>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 12, color: 'var(--stockin-color-muted)' }}>
            {info.current + 1}/{info.total}
          </span>
          {isActionStep ? (
            <span style={{ fontSize: 12, color: 'var(--stockin-color-muted)' }}>
              点击高亮处继续
            </span>
          ) : (
            <>
              {canGoPrev ? (
                <Button size="small" onClick={(): void => setCurrent(info.current - 1)}>
                  上一步
                </Button>
              ) : null}
              <Button
                type="primary"
                size="small"
                onClick={(): void => {
                  if (info.current >= info.total - 1) {
                    finish();
                    return;
                  }
                  setCurrent(info.current + 1);
                }}
              >
                {info.current >= info.total - 1 ? '完成' : '下一步'}
              </Button>
            </>
          )}
        </div>
      )}
    />
  );
};

export default OnboardingTour;
