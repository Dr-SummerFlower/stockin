/**
 * 首次初始化引导页（`.umirc.ts` 顶层独立路由，不继承主布局）。
 *
 * 首启凭据由服务端在容器日志打印 `[BOOTSTRAP]`，卷保留时不重生成、不重打印；
 * 页面只提示用户去部署日志查看，绝不在前端臆造或缓存初始密码。
 * 完成引导后服务端不签新会话，故前端 `refresh()` 后跳转 `/login` 重新登录。
 */
import React, { useEffect, useState } from 'react';
import { Alert, App as AntdApp, Button, Input } from 'antd';
import { useModel, useNavigate } from 'umi';
import { getInitStatus, setup } from '@/services/api/auth';
import { errorMessage } from '@/services/request';
import { ROUTES, TOUCH_TARGET_MIN_PX } from '@/constants/routes';

const SetupPage: React.FC = () => {
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const { refresh } = useModel('session');
  const [currentPassword, setCurrentPassword] = useState<string>('');
  const [username, setUsername] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [confirmPassword, setConfirmPassword] = useState<string>('');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);

  // 已完成初始化（init_state 单向 0→1）则不再允许引导。
  useEffect((): (() => void) => {
    let active = true;
    void getInitStatus()
      .then((status): void => {
        if (active && status.initState === 1) {
          navigate(ROUTES.login, { replace: true });
        }
      })
      .catch((): void => undefined);
    return (): void => {
      active = false;
    };
  }, [navigate]);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setErrorText(null);
    if (
      currentPassword === '' ||
      username.trim() === '' ||
      password === ''
    ) {
      setErrorText('初始密码、新用户名与新密码不能为空');
      return;
    }
    if (password !== confirmPassword) {
      setErrorText('两次输入的新密码不一致');
      return;
    }
    setSubmitting(true);
    try {
      await setup({
        currentPassword,
        username: username.trim(),
        password,
      });
      await refresh().catch((): void => undefined);
      message.success('初始化完成，使用新账号登录');
      navigate(ROUTES.login, { replace: true });
    } catch (cause) {
      setErrorText(errorMessage(cause, '初始化失败，初始密码不正确'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="stockin-standalone is-centered">
      <div className="stockin-standalone-card">
        <h2
          style={{
            margin: '0 0 16px',
            fontSize: 'var(--stockin-fs-h1)',
            fontWeight: 600,
            letterSpacing: '-0.025em',
          }}
        >
          首次初始化
        </h2>
        <Alert
          type="info"
          showIcon
          message="初始密码来源"
          description="初始密码在首次启动时生成，可在启动日志中查看；数据保留期间不再重新生成。"
          style={{ marginBottom: 12 }}
        />
        <details
          style={{
            marginBottom: 16,
            fontSize: 13,
            color: 'var(--stockin-color-muted)',
          }}
        >
          <summary
            style={{
              minHeight: TOUCH_TARGET_MIN_PX,
              display: 'flex',
              alignItems: 'center',
              cursor: 'pointer',
            }}
          >
            技术信息
          </summary>
          <div style={{ paddingTop: 4 }}>
            <div>
              <span>日志标记：</span>
              <code className="stockin-mono">[BOOTSTRAP]</code>
            </div>
            <div className="stockin-field-hint">
              用于在启动日志中定位初始密码。
            </div>
          </div>
        </details>
        {errorText !== null ? (
          <Alert type="error" showIcon message={errorText} style={{ marginBottom: 16 }} />
        ) : null}
        <form onSubmit={submit} noValidate>
          <div style={{ marginBottom: 12 }}>
            <label className="stockin-field-label" htmlFor="setup-current-password">
              初始密码
            </label>
            <Input.Password
              id="setup-current-password"
              value={currentPassword}
              autoComplete="off"
              aria-label="初始密码"
              placeholder="启动日志中的初始密码"
              onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                setCurrentPassword(event.target.value)
              }
              style={{ minHeight: TOUCH_TARGET_MIN_PX }}
            />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label className="stockin-field-label" htmlFor="setup-username">
              新用户名
            </label>
            <Input
              id="setup-username"
              value={username}
              autoComplete="username"
              aria-label="新用户名"
              placeholder="请输入新用户名"
              onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                setUsername(event.target.value)
              }
              style={{ minHeight: TOUCH_TARGET_MIN_PX }}
            />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label className="stockin-field-label" htmlFor="setup-password">
              新密码
            </label>
            <Input.Password
              id="setup-password"
              value={password}
              autoComplete="new-password"
              aria-label="新密码"
              placeholder="请输入新密码"
              onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                setPassword(event.target.value)
              }
              style={{ minHeight: TOUCH_TARGET_MIN_PX }}
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label className="stockin-field-label" htmlFor="setup-confirm-password">
              确认新密码
            </label>
            <Input.Password
              id="setup-confirm-password"
              value={confirmPassword}
              autoComplete="new-password"
              aria-label="确认新密码"
              placeholder="请再次输入新密码"
              onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                setConfirmPassword(event.target.value)
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
            完成初始化
          </Button>
        </form>
        <div style={{ marginTop: 12, textAlign: 'center' }}>
          <button
            type="button"
            className="stockin-link-btn"
            onClick={(): void => navigate(ROUTES.login)}
          >
            返回登录
          </button>
        </div>
      </div>
    </div>
  );
};

export default SetupPage;
