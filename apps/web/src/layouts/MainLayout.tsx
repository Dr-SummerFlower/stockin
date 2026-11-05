/**
 * 主布局：顶部导航 + `Outlet`。
 *
 * 依据：`.umirc.ts` 的配置式 routes（`/` 下嵌套布局，`/login` / `/setup` / `404`
 * 为顶层独立路由，不继承本布局）；主理人 T04 口径 ⑦ 响应式与触控目标。
 * 导航图标用纯文字符号（内联展示），**不引入 `@ant-design/icons`**：
 * 该包在 pnpm 严格隔离下从 `apps/web` 不可直接解析。
 */
import React, { useCallback, useEffect } from 'react';
import { Button, Layout, Menu, Typography, message } from 'antd';
import { Link, Outlet, useLocation, useModel, useNavigate } from 'umi';
import { NAV_ITEMS, ROUTES, TOUCH_TARGET_MIN_PX } from '@/constants/routes';

const { Header, Content } = Layout;

/** 纯文字导航符号（避免图标包依赖）。 */
const NAV_GLYPHS: Readonly<Record<string, string>> = {
  dashboard: '▦',
  list: '☰',
  setting: '⚙',
  delete: '⌫',
  file: '▤',
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

const AppLayout: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { username, refresh, signOut } = useModel('session');

  useEffect((): void => {
    void refresh();
  }, [refresh]);

  const onSignOut = useCallback(async (): Promise<void> => {
    try {
      await signOut();
      message.success('已退出登录');
      navigate(ROUTES.login, { replace: true });
    } catch {
      // 统一拦截层已给出提示，这里不重复弹窗。
    }
  }, [navigate, signOut]);

  const menuItems = NAV_ITEMS.map((item) => ({
    key: item.path,
    label: (
      <Link
        to={item.path}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          minHeight: TOUCH_TARGET_MIN_PX,
        }}
      >
        <span aria-hidden="true">{NAV_GLYPHS[item.icon] ?? '•'}</span>
        <span>{item.label}</span>
      </Link>
    ),
  }));

  return (
    <Layout className="stockin-layout">
      <Header
        className="stockin-header"
        style={{
          height: 'auto',
          minHeight: 56,
          lineHeight: 'normal',
          flexWrap: 'wrap',
          padding: '6px 16px',
        }}
      >
        <div className="stockin-header-title">进货统计</div>
        <Menu
          theme="dark"
          mode="horizontal"
          selectedKeys={[selectedNavKey(location.pathname)]}
          items={menuItems}
          style={{
            flex: '1 1 320px',
            minWidth: 260,
            background: 'transparent',
            borderBottom: 'none',
          }}
        />
        <div className="stockin-header-right">
          <Typography.Text style={{ color: 'rgba(255,255,255,0.85)' }} ellipsis>
            {username ?? '未登录'}
          </Typography.Text>
          <Button
            size="small"
            onClick={(): void => {
              void onSignOut();
            }}
            style={{ minHeight: TOUCH_TARGET_MIN_PX }}
          >
            退出
          </Button>
        </div>
      </Header>
      <Content className="stockin-content">
        <div className="stockin-page">
          <Outlet />
        </div>
      </Content>
    </Layout>
  );
};

export default AppLayout;
