/**
 * 忘记密码页（`/forgot-password`，顶层独立路由）。
 *
 * 两段式交互、一次提交：先按用户名取回密保问题（服务端查不到账号时返回
 * 一条预设问题作掩护），再填写答案与新密码，一次请求完成重置。
 * 重置成功会吊销全部会话，因此直接跳登录页。
 */
import React, { useState } from 'react';
import { Alert, App as AntdApp, Button, Input } from 'antd';
import { useNavigate } from 'umi';
import { forgotPassword, lookupSecurityQuestion } from '@/services/api/auth';
import { errorMessage } from '@/services/request';
import { ROUTES, TOUCH_TARGET_MIN_PX } from '@/constants/routes';

const ForgotPasswordPage: React.FC = () => {
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const [username, setUsername] = useState<string>('');
  const [question, setQuestion] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string>('');
  const [newPassword, setNewPassword] = useState<string>('');
  const [confirmPassword, setConfirmPassword] = useState<string>('');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [loadingQuestion, setLoadingQuestion] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);

  const fetchQuestion = async (): Promise<void> => {
    setErrorText(null);
    if (username.trim() === '') {
      setErrorText('请先输入用户名');
      return;
    }
    setLoadingQuestion(true);
    try {
      const result = await lookupSecurityQuestion({ username: username.trim() });
      if (!result.configured) {
        setQuestion(null);
        setErrorText(
          '该账号尚未设置密保问题，无法通过密保重置。请登录后在「设置 → 账号安全」中补设，或使用本机命令行工具重置。',
        );
        return;
      }
      setQuestion(result.question);
    } catch (cause) {
      setQuestion(null);
      setErrorText(errorMessage(cause, '无法读取密保问题，请稍后重试'));
    } finally {
      setLoadingQuestion(false);
    }
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setErrorText(null);
    if (question === null) {
      setErrorText('请先获取密保问题');
      return;
    }
    if (answer.trim() === '' || newPassword === '') {
      setErrorText('密保答案与新密码不能为空');
      return;
    }
    if (newPassword !== confirmPassword) {
      setErrorText('两次输入的新密码不一致');
      return;
    }
    setSubmitting(true);
    try {
      await forgotPassword({
        username: username.trim(),
        securityAnswer: answer.trim(),
        newPassword,
      });
      message.success('密码已重置，请使用新密码登录');
      navigate(ROUTES.login, { replace: true });
    } catch (cause) {
      setErrorText(errorMessage(cause, '重置失败，用户名或密保答案不正确'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="stockin-standalone is-centered">
      <div className="stockin-standalone-card">
        <h2
          style={{
            margin: '0 0 8px',
            fontSize: 'var(--stockin-fs-h1)',
            fontWeight: 600,
            letterSpacing: '-0.025em',
          }}
        >
          找回密码
        </h2>
        <p
          style={{
            margin: '0 0 16px',
            fontSize: 'var(--stockin-fs-caption)',
            color: 'var(--stockin-color-muted)',
          }}
        >
          回答初始化时设置的密保问题即可重置密码，重置后所有设备需重新登录。
        </p>

        {errorText !== null ? (
          <Alert type="error" showIcon message={errorText} style={{ marginBottom: 16 }} />
        ) : null}

        <form onSubmit={submit} noValidate>
          <div style={{ marginBottom: 12 }}>
            <label className="stockin-field-label" htmlFor="forgot-username">
              用户名
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <Input
                id="forgot-username"
                value={username}
                autoComplete="username"
                aria-label="用户名"
                placeholder="请输入用户名"
                onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                  setUsername(event.target.value);
                  setQuestion(null);
                }}
                style={{ minHeight: TOUCH_TARGET_MIN_PX }}
              />
              <Button
                loading={loadingQuestion}
                onClick={(): void => {
                  void fetchQuestion();
                }}
                style={{ minHeight: TOUCH_TARGET_MIN_PX, flex: 'none' }}
              >
                获取问题
              </Button>
            </div>
          </div>

          {question !== null ? (
            <>
              <div style={{ marginBottom: 12 }}>
                <div className="stockin-field-label">密保问题</div>
                <div
                  style={{
                    padding: '10px 12px',
                    borderRadius: 'var(--stockin-radius)',
                    background: 'var(--stockin-color-surface-3)',
                    fontSize: 'var(--stockin-fs-body)',
                  }}
                >
                  {question}
                </div>
              </div>
              <div style={{ marginBottom: 12 }}>
                <label className="stockin-field-label" htmlFor="forgot-answer">
                  答案
                </label>
                <Input
                  id="forgot-answer"
                  value={answer}
                  autoComplete="off"
                  aria-label="密保答案"
                  placeholder="请输入密保答案"
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                    setAnswer(event.target.value)
                  }
                  style={{ minHeight: TOUCH_TARGET_MIN_PX }}
                />
                <div className="stockin-field-hint">不区分大小写，首尾空格会被忽略。</div>
              </div>
              <div style={{ marginBottom: 12 }}>
                <label className="stockin-field-label" htmlFor="forgot-new-password">
                  新密码
                </label>
                <Input.Password
                  id="forgot-new-password"
                  value={newPassword}
                  autoComplete="new-password"
                  aria-label="新密码"
                  placeholder="请输入新密码"
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                    setNewPassword(event.target.value)
                  }
                  style={{ minHeight: TOUCH_TARGET_MIN_PX }}
                />
              </div>
              <div style={{ marginBottom: 20 }}>
                <label className="stockin-field-label" htmlFor="forgot-confirm-password">
                  确认新密码
                </label>
                <Input.Password
                  id="forgot-confirm-password"
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
                重置密码
              </Button>
            </>
          ) : null}
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

export default ForgotPasswordPage;
