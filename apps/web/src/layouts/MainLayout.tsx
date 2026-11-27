/**
 * 主布局：桌面 224px 左侧竖栏 + 顶栏上下文；平板 76px 图标栏；手机底部 5 项 Tab。
 *
 * 依据：design/stockin-ui-design-system.md §5 / §7 与原型 app-shell。
 * 导航图标用内联 SVG（components/Icon），不引入图标包；路由与 NAV_ITEMS 不变。
 * 手机档侧栏用户区隐藏，退出登录入口改到顶栏，保证不隐藏任何业务功能。
 * 顶栏日期按北京时间（UTC+8）显示，与 utils/format.ts 的口径一致。
 * 顶栏不做面包屑：侧栏选中项已表明当前位置，重复一遍只是噪声。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { App as AntdApp, Drawer } from 'antd';
import { Link, Outlet, useLocation, useModel, useNavigate } from 'umi';
import Icon, { type IconName } from '@/components/Icon';
import OnboardingTour from '@/components/OnboardingTour';
import { getSettings } from '@/services/api/settings';
import { NAV_ITEMS, ROUTES, type NavItem } from '@/constants/routes';
import { useBreakpoint } from '@/hooks/useBreakpoint';

/**
 * 手机档底部导航：4 个高频入口 + 中央「记一笔」。
 * 回收站 / 操作日志 / 设置收进「更多」，功能不隐藏，只是不再和主操作抢位置。
 */
const MOBILE_TABS: readonly NavItem[] = [
  { key: 'dashboard', path: ROUTES.dashboard, label: '大屏', icon: 'dashboard' },
  { key: 'orders', path: ROUTES.orders, label: '进货单', icon: 'receipt' },
  { key: 'records', path: ROUTES.records, label: '记录', icon: 'list' },
];
const MOBILE_MORE: readonly NavItem[] = [
  { key: 'trash', path: ROUTES.trash, label: '回收站', icon: 'delete' },
  { key: 'logs', path: ROUTES.logs, label: '操作日志', icon: 'file' },
  { key: 'settings', path: ROUTES.settings, label: '设置', icon: 'setting' },
];

/** NavItem.icon → 内联 SVG 名；保持 routes.ts 的既有取值以免扩散改动。 */
const NAV_ICONS: Readonly<Record<NavItem['icon'], IconName>> = {
  dashboard: 'grid',
  receipt: 'receipt',
  list: 'list',
  setting: 'setting',
  delete: 'trash',
  file: 'log',
};

/** 根据当前路径反查导航选中项；`/records/*` 归到「进货记录」。 */
export function selectedNavKey(pathname: string): string {
  const matched = NAV_ITEMS.find((item) =>
    item.path === ROUTES.dashboard
      ? pathname === ROUTES.dashboard
      : pathname.startsWith(item.path),
  );
  return matched?.path ?? ROUTES.dashboard;
}

/** 服务器与展示口径统一为北京时间；此处只读「今天」用于顶栏。 */
function chinaTodayLabel(): string {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  return `今天 · ${month}月${day}日`;
}

const AppLayout: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { username, refresh, signOut } = useModel('session');
  const { message: holderMessage } = AntdApp.useApp();
  const [shopName, setShopName] = useState<string>('');
  const [moreOpen, setMoreOpen] = useState<boolean>(false);
  const { isMobile } = useBreakpoint();

  useEffect((): void => {
    void refresh();
  }, [refresh]);

  // 店铺名称用于品牌位；取不到时回落默认名，不阻塞布局。
  useEffect((): (() => void) => {
    let active = true;
    void getSettings()
      .then((settings): void => {
        if (active) {
          setShopName(settings.shopName ?? '');
        }
      })
      .catch((): void => undefined);
    return (): void => {
      active = false;
    };
  }, []);

  const selected = selectedNavKey(location.pathname);

  const onSignOut = useCallback(async (): Promise<void> => {
    try {
      await signOut();
      holderMessage.success('已退出登录');
      navigate(ROUTES.login, { replace: true });
    } catch {
      // 统一拦截层已给出提示，这里不重复弹窗。
    }
  }, [holderMessage, navigate, signOut]);

  return (
    <div className="stockin-app-shell">
      <aside className="stockin-sidebar">
        <div className="stockin-brand">
          <div className="stockin-brand-mark">进</div>
          <div className="stockin-brand-text">
            <strong>{shopName === '' ? '进货统计' : shopName}</strong>
          </div>
        </div>

        <div className="stockin-nav-group">
          {isMobile ? (
            <nav
              className={`stockin-nav stockin-nav--mobile${
                location.pathname === ROUTES.orderNew ? ' is-compact' : ''
              }`}
              aria-label="主导航"
            >
              {MOBILE_TABS.slice(0, 2).map((item) => (
                <Link
                  key={item.key}
                  to={item.path}
                  className={`stockin-nav-item${selected === item.path ? ' is-active' : ''}`}
                  aria-current={selected === item.path ? 'page' : undefined}
                >
                  <Icon name={NAV_ICONS[item.icon]} />
                  <span>{item.label}</span>
                </Link>
              ))}
              {/* 新建页已有吸底「保存整单」，中央 FAB 与之上下相叠容易误点，故隐藏（04-F-05）。 */}
              {location.pathname === ROUTES.orderNew ? null : (
                <Link
                  to={ROUTES.orderNew}
                  className="stockin-nav-item stockin-nav-fab"
                  aria-label="记一笔进货"
                  data-tour-id="nav-order-new"
                >
                  <span className="stockin-nav-fab__btn">
                    <Icon name="plus" />
                  </span>
                  <span>记一笔</span>
                </Link>
              )}
              {MOBILE_TABS.slice(2).map((item) => (
                <Link
                  key={item.key}
                  to={item.path}
                  className={`stockin-nav-item${selected === item.path ? ' is-active' : ''}`}
                  aria-current={selected === item.path ? 'page' : undefined}
                >
                  <Icon name={NAV_ICONS[item.icon]} />
                  <span>{item.label}</span>
                </Link>
              ))}
              <button
                type="button"
                className={`stockin-nav-item${
                  MOBILE_MORE.some((item: NavItem): boolean => item.path === selected) ? ' is-active' : ''
                }`}
                onClick={(): void => setMoreOpen(true)}
                aria-label="更多入口"
              >
                <Icon name="setting" />
                <span>更多</span>
              </button>
            </nav>
          ) : (
            <nav className="stockin-nav" aria-label="主导航">
              {NAV_ITEMS.map((item) => (
                <Link
                  key={item.key}
                  to={item.path}
                  className={`stockin-nav-item${selected === item.path ? ' is-active' : ''}`}
                  aria-current={selected === item.path ? 'page' : undefined}
                  title={item.label}
                  data-tour-id={`nav-${item.key}`}
                >
                  <Icon name={NAV_ICONS[item.icon]} />
                  <span>{item.label}</span>
                </Link>
              ))}
            </nav>
          )}
        </div>

        <div className="stockin-sidebar-foot">
          <div className="stockin-user">
            <div className="stockin-user-avatar" aria-hidden="true">
              {(username ?? 'A').slice(0, 1).toUpperCase()}
            </div>
            <div className="stockin-user-meta">
              <b>{username ?? '未登录'}</b>
            </div>
            <button
              type="button"
              className="stockin-icon-btn"
              onClick={(): void => {
                void onSignOut();
              }}
              title="退出登录"
              aria-label="退出登录"
              style={{ width: 44, height: 44 }}
            >
              <Icon name="logout" size="sm" />
            </button>
          </div>
        </div>
      </aside>

      <div className="stockin-main">
        <header className="stockin-topbar">
          <div className="stockin-topbar-right">
            <span className="stockin-today">
              <i aria-hidden="true" />
              {chinaTodayLabel()}
            </span>
            <button
              type="button"
              className="stockin-icon-btn stockin-mobile-signout"
              onClick={(): void => {
                void onSignOut();
              }}
              title="退出登录"
              aria-label="退出登录"
            >
              <Icon name="logout" size="sm" />
            </button>
          </div>
        </header>

        <main className="stockin-content">
          <Outlet />
        </main>
      </div>
      <Drawer
        placement="bottom"
        open={moreOpen}
        onClose={(): void => setMoreOpen(false)}
        height="auto"
        title="更多"
        className="stockin-drawer"
      >
        <div className="stockin-more-list">
          {MOBILE_MORE.map((item) => (
            <Link
              key={item.key}
              to={item.path}
              className="stockin-more-item"
              onClick={(): void => setMoreOpen(false)}
            >
              <Icon name={NAV_ICONS[item.icon]} />
              <span>{item.label}</span>
              <Icon name="chevron" size="sm" />
            </Link>
          ))}
          <button
            type="button"
            className="stockin-more-item"
            onClick={(): void => {
              setMoreOpen(false);
              void onSignOut();
            }}
          >
            <Icon name="logout" />
            <span>退出登录</span>
            <Icon name="chevron" size="sm" />
          </button>
        </div>
      </Drawer>

      <OnboardingTour />
    </div>
  );
};

export default AppLayout;
