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
    <div className="stockin-standalone">
      <Result
        status="404"
        title="404"
        subTitle="页面不存在或已被移除。"
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
  );
};

export default NotFoundPage;
