/**
 * 主布局：桌面 224px 左侧竖栏 + 顶栏上下文；平板 76px 图标栏；手机底部 5 项 Tab。
 *
 * 依据：design/stockin-ui-design-system.md §5 / §7 与原型 app-shell。
 * 导航图标用内联 SVG（components/Icon），不引入图标包；路由与 NAV_ITEMS 不变。
 * 手机档侧栏用户区隐藏，退出登录入口改到顶栏，保证不隐藏任何业务功能。
 * 顶栏日期按北京时间（UTC+8）显示，与 utils/format.ts 的口径一致。
 * 顶栏不做面包屑：侧栏选中项已表明当前位置，重复一遍只是噪声。
 */
import React, { useCallback, useEffect } from 'react';
import { App as AntdApp } from 'antd';
import { Link, Outlet, useLocation, useModel, useNavigate } from 'umi';
import Icon, { type IconName } from '@/components/Icon';
import { NAV_ITEMS, ROUTES, type NavItem } from '@/constants/routes';

/** NavItem.icon → 内联 SVG 名；保持 routes.ts 的既有取值以免扩散改动。 */
const NAV_ICONS: Readonly<Record<NavItem['icon'], IconName>> = {
  dashboard: 'grid',
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

  useEffect((): void => {
    void refresh();
  }, [refresh]);

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
            <strong>进货统计</strong>
          </div>
        </div>

        <div className="stockin-nav-group">
          <nav className="stockin-nav" aria-label="主导航">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.key}
                to={item.path}
                className={`stockin-nav-item${selected === item.path ? ' is-active' : ''}`}
                aria-current={selected === item.path ? 'page' : undefined}
                title={item.label}
              >
                <Icon name={NAV_ICONS[item.icon]} />
                <span>{item.label}</span>
              </Link>
            ))}
          </nav>
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
    </div>
  );
};

export default AppLayout;
