/**
 * 登录页（`.umirc.ts` 顶层独立路由，不继承主布局）。
 *
 * 只信 `GET /api/auth/init-status` 判定初始化态；账密错误 401 由
 * `services/api/auth.ts` 的 `silent: true` 内联渲染，不触发全局跳转。
 */
import React, { useState } from 'react';
import { Alert, Button, Input, Typography } from 'antd';
import { useModel, useNavigate } from 'umi';
import { login } from '@/services/api/auth';
import { errorMessage } from '@/services/request';
import { ROUTES, TOUCH_TARGET_MIN_PX } from '@/constants/routes';

const LoginPage: React.FC = () => {
  const navigate = useNavigate();
  const { refresh } = useModel('session');
  const [username, setUsername] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setErrorText(null);
    if (username.trim() === '' || password === '') {
      setErrorText('请输入用户名和密码');
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
      setErrorText(errorMessage(cause, '登录失败，请检查用户名和密码'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="stockin-standalone">
      <div className="stockin-standalone-card">
        <Typography.Title level={3} style={{ marginTop: 0 }}>
          登录 · 进货统计
        </Typography.Title>
        <Typography.Paragraph type="secondary">
          首次启动请使用部署日志中的初始密码登录；登录后按引导设置正式账号与密码。
        </Typography.Paragraph>
        {errorText !== null ? (
          <Alert type="error" showIcon message={errorText} style={{ marginBottom: 16 }} />
        ) : null}
        <form onSubmit={submit} noValidate>
          <div style={{ marginBottom: 12 }}>
            <Typography.Text strong>用户名</Typography.Text>
            <Input
              value={username}
              autoComplete="username"
              aria-label="用户名"
              placeholder="请输入用户名"
              onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                setUsername(event.target.value)
              }
              style={{ marginTop: 4, minHeight: TOUCH_TARGET_MIN_PX }}
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <Typography.Text strong>密码</Typography.Text>
            <Input.Password
              value={password}
              autoComplete="current-password"
              aria-label="密码"
              placeholder="请输入密码"
              onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                setPassword(event.target.value)
              }
              style={{ marginTop: 4, minHeight: TOUCH_TARGET_MIN_PX }}
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
        </form>
        <div style={{ marginTop: 12, textAlign: 'center' }}>
          <Button
            type="link"
            onClick={(): void => navigate(ROUTES.setup)}
            style={{ minHeight: TOUCH_TARGET_MIN_PX }}
          >
            首次使用？前往初始化引导
          </Button>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
