/**
 * 登录页（`.umirc.ts` 顶层独立路由，不继承主布局）。
 *
 * 只信 `GET /api/auth/init-status` 判定初始化态；账密错误 401 由
 * `services/api/auth.ts` 的 `silent: true` 内联渲染，不触发全局跳转。
 *
 * 附录 B.6：移除「前往初始化引导」入口 —— 多数 initState 下会被 app.tsx
 * 的全局守卫跳回，属无效入口；初始化只由登录返回的 initState === 0 触达。
 */
import React, { useEffect, useState } from 'react';
import { Alert, Button, Input } from 'antd';
import { useModel, useNavigate } from 'umi';
import { getInitStatus, login } from '@/services/api/auth';
import { errorMessage } from '@/services/request';
import { ROUTES, TOUCH_TARGET_MIN_PX } from '@/constants/routes';

const LoginPage: React.FC = () => {
  const navigate = useNavigate();
  const { refresh } = useModel('session');
  const [username, setUsername] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  // 只在尚未初始化时提示初始密码，避免已设置正式账密后仍显示首次登录说明。
  const [needsSetup, setNeedsSetup] = useState<boolean>(false);

  useEffect((): (() => void) => {
    let active = true;
    void getInitStatus()
      .then((status): void => {
        if (active) {
          setNeedsSetup(status.initState === 0);
        }
      })
      .catch((): void => undefined);
    return (): void => {
      active = false;
    };
  }, []);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setErrorText(null);
    if (username.trim() === '' || password === '') {
      setErrorText('用户名和密码不能为空');
      return;
    }
    setSubmitting(true);
    try {
      const result = await login({ username: username.trim(), password });
      await refresh().catch((): void => undefined);
      if (result.initState === 0) {
        navigate(ROUTES.setup, { replace: true });
        return;
      }
      navigate(ROUTES.dashboard, { replace: true });
    } catch (cause) {
      setErrorText(errorMessage(cause, '登录失败，用户名或密码不正确'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="stockin-standalone">
      <div className="stockin-login-left">
        <div className="stockin-brand" style={{ padding: 0 }}>
          <div className="stockin-brand-mark">进</div>
          <div className="stockin-brand-text">
            <strong>进货统计</strong>
          </div>
        </div>
      </div>
      <div className="stockin-login-right">
        <form className="stockin-login-form" onSubmit={submit} noValidate>
          <div>
            <h2>登录</h2>
            {needsSetup ? (
              <p
                style={{
                  margin: '6px 0 0',
                  fontSize: 'var(--stockin-fs-caption)',
                  color: 'var(--stockin-color-muted)',
                }}
              >
                首次登录使用初始密码，登录后设置正式账号与密码。
              </p>
            ) : null}
          </div>
          {errorText !== null ? (
            <Alert type="error" showIcon message={errorText} />
          ) : null}
          <div>
            <label className="stockin-field-label" htmlFor="login-username">
              用户名
            </label>
            <Input
              id="login-username"
              value={username}
              autoComplete="username"
              aria-label="用户名"
              placeholder="请输入用户名"
              onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                setUsername(event.target.value)
              }
              style={{ minHeight: TOUCH_TARGET_MIN_PX }}
            />
          </div>
          <div>
            <label className="stockin-field-label" htmlFor="login-password">
              密码
            </label>
            <Input.Password
              id="login-password"
              value={password}
              autoComplete="current-password"
              aria-label="密码"
              placeholder="请输入密码"
              onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                setPassword(event.target.value)
              }
              style={{ minHeight: TOUCH_TARGET_MIN_PX }}
            />
          </div>
          <Button
            type="primary"
            htmlType="submit"
            block
            loading={submitting}
            style={{ minHeight: TOUCH_TARGET_MIN_PX }}
          >
            登录
          </Button>
          <details className="stockin-login-tech">
            <summary>技术信息</summary>
            <div>未加密连接下，账号与密码以明文传输，仅适用于可信网络。</div>
          </details>
        </form>
      </div>
    </div>
  );
};

export default LoginPage;
