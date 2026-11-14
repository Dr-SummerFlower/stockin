/**
 * 404 兜底页（`.umirc.ts` 末尾 `{ path: '*', component: '404' }`）。
 */
import React from 'react';
import { Button, Result } from 'antd';
import { useNavigate } from 'umi';
import { ROUTES, TOUCH_TARGET_MIN_PX } from '@/constants/routes';

const NotFoundPage: React.FC = () => {
  const navigate = useNavigate();
  return (
    <div className="stockin-standalone is-centered">
      <div className="stockin-standalone-card">
        <Result
          status="404"
          title="页面不存在"
          extra={
            <Button
              type="primary"
              onClick={(): void => navigate(ROUTES.dashboard)}
              style={{ minHeight: TOUCH_TARGET_MIN_PX }}
            >
              返回统计大屏
            </Button>
          }
        />
      </div>
    </div>
  );
};

export default NotFoundPage;
