/**
 * 管理员登录页（顶层独立路由，不继承店主导航布局）。
 *
 * 管理员只用 GitHub OAuth 登录，本页不接收账密。点击登录后整页跳转到
 * `/api/admin/auth/github/start`，由后端下发 state Cookie 并重定向到
 * GitHub 授权页；回调成功后后端 302 回 `/admin`，失败回本页并带 `error`。
 *
 * 文案保持中性书面语，错误按后端回传的原因码映射为中文。
 */
import React, { useEffect } from 'react';
import { Alert, Button } from 'antd';
import { useLocation } from 'umi';
import { startAdminGithubLogin } from '@/services/api/admin';
import { TOUCH_TARGET_MIN_PX } from '@/constants/routes';

/** OAuth 回调失败原因 → 中文文案；未知值回落中性提示。 */
const ERROR_TEXT: Readonly<Record<string, string>> = {
  state: '登录请求已过期或被中断，请重新发起登录',
  forbidden: '当前 GitHub 账号不在管理员名单内',
  failed: 'GitHub 授权未完成，请重新发起登录',
};

function errorText(code: string | null): string {
  if (code === null) return '';
  return ERROR_TEXT[code] ?? '管理员登录未完成，请重新发起';
}

const AdminLoginPage: React.FC = () => {
  const location = useLocation();
  const [message, setMessage] = React.useState<string>('');

  useEffect((): void => {
    const params: URLSearchParams = new URLSearchParams(location.search);
    setMessage(errorText(params.get('error')));
  }, [location.search]);

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
        <div className="stockin-login-form">
          <div>
            <h2>系统维护登录</h2>
            <p
              style={{
                margin: '6px 0 0',
                fontSize: 'var(--stockin-fs-caption)',
                color: 'var(--stockin-color-muted)',
              }}
            >
              本入口仅供系统维护，与店主账号相互独立。
            </p>
          </div>
          {message !== '' ? <Alert type="error" showIcon message={message} /> : null}
          <Button
            type="primary"
            block
            onClick={startAdminGithubLogin}
            style={{ minHeight: TOUCH_TARGET_MIN_PX }}
          >
            使用 GitHub 账号登录
          </Button>
          <details className="stockin-login-tech">
            <summary>说明</summary>
            <div>
              登录会话在关闭浏览器后即失效；仅白名单内的 GitHub 账号可进入。
              维护操作均写入安全审计日志。
            </div>
          </details>
        </div>
      </div>
    </div>
  );
};

export default AdminLoginPage;
