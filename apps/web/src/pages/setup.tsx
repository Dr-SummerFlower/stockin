/**
 * 首次初始化引导页（`.umirc.ts` 顶层独立路由，不继承主布局）。
 *
 * 首启凭据由服务端在容器日志打印 `[BOOTSTRAP]`，卷保留时不重生成、不重打印；
 * 页面只提示用户去部署日志查看，绝不在前端臆造或缓存初始密码。
 * 完成引导后服务端不签新会话，故前端 `refresh()` 后跳转 `/login` 重新登录。
 */
import React, { useEffect, useState } from 'react';
import { Alert, Button, Input, Typography, message } from 'antd';
import { useModel, useNavigate } from 'umi';
import { getInitStatus, setup } from '@/services/api/auth';
import { errorMessage } from '@/services/request';
import { ROUTES, TOUCH_TARGET_MIN_PX } from '@/constants/routes';

const SetupPage: React.FC = () => {
  const navigate = useNavigate();
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
      setErrorText('请填写初始密码、新用户名与新密码');
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
      message.success('初始化完成，请使用新账号登录');
      navigate(ROUTES.login, { replace: true });
    } catch (cause) {
      setErrorText(errorMessage(cause, '初始化失败，请检查初始密码'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="stockin-standalone">
      <div className="stockin-standalone-card">
        <Typography.Title level={3} style={{ marginTop: 0 }}>
          首次初始化
        </Typography.Title>
        <Alert
          type="info"
          showIcon
          message="初始密码在哪里？"
          description="首次启动时服务端会在容器日志打印 [BOOTSTRAP] 初始密码，请在部署日志中查看。数据卷保留时不会重新生成或重新打印。"
          style={{ marginBottom: 16 }}
        />
        {errorText !== null ? (
          <Alert type="error" showIcon message={errorText} style={{ marginBottom: 16 }} />
        ) : null}
        <form onSubmit={submit} noValidate>
          <div style={{ marginBottom: 12 }}>
            <Typography.Text strong>初始密码</Typography.Text>
            <Input.Password
              value={currentPassword}
              autoComplete="off"
              aria-label="初始密码"
              placeholder="容器日志 [BOOTSTRAP] 打印的初始密码"
              onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                setCurrentPassword(event.target.value)
              }
              style={{ marginTop: 4, minHeight: TOUCH_TARGET_MIN_PX }}
            />
          </div>
          <div style={{ marginBottom: 12 }}>
            <Typography.Text strong>新用户名</Typography.Text>
            <Input
              value={username}
              autoComplete="username"
              aria-label="新用户名"
              placeholder="设置登录用户名"
              onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                setUsername(event.target.value)
              }
              style={{ marginTop: 4, minHeight: TOUCH_TARGET_MIN_PX }}
            />
          </div>
          <div style={{ marginBottom: 12 }}>
            <Typography.Text strong>新密码</Typography.Text>
            <Input.Password
              value={password}
              autoComplete="new-password"
              aria-label="新密码"
              placeholder="设置登录密码"
              onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                setPassword(event.target.value)
              }
              style={{ marginTop: 4, minHeight: TOUCH_TARGET_MIN_PX }}
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <Typography.Text strong>确认新密码</Typography.Text>
            <Input.Password
              value={confirmPassword}
              autoComplete="new-password"
              aria-label="确认新密码"
              placeholder="再次输入新密码"
              onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                setConfirmPassword(event.target.value)
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
            完成初始化
          </Button>
        </form>
        <div style={{ marginTop: 12, textAlign: 'center' }}>
          <Button
            type="link"
            onClick={(): void => navigate(ROUTES.login)}
            style={{ minHeight: TOUCH_TARGET_MIN_PX }}
          >
            已初始化？返回登录
          </Button>
        </div>
      </div>
    </div>
  );
};

export default SetupPage;
