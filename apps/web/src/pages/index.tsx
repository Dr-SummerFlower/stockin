/**
 * 统计大屏（`/`，主布局内首屏）。
 *
 * 依据：设计文档 §5.2、主理人 T04 口径 ⑥ —— **开屏一次 `GET /api/dashboard`**，
 * 6 组指标卡 + 临期 / 过期预警清单；清单由服务端排定，**前端不二次排序**；
 * 纯 CSS Grid / DOM，零图表库。写操作后由 ui model 的 `refreshKey` 触发重拉。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Button, Card, Empty, Spin, Typography } from 'antd';
import { useModel } from 'umi';
import type { DashboardResponse } from '@stockin/shared';
import { getDashboard } from '@/services/api/dashboard';
import MetricCards from '@/components/MetricCards';
import ExpiryList from '@/components/ExpiryList';
import ErrorView from '@/components/ErrorView';
import { TOUCH_TARGET_MIN_PX } from '@/constants/routes';

const DashboardPage: React.FC = () => {
  const { refreshKey } = useModel('ui');
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [reloadToken, setReloadToken] = useState<number>(0);

  useEffect((): (() => void) => {
    let active = true;
    setLoading(true);
    setError(null);
    void getDashboard()
      .then((response: DashboardResponse): void => {
        if (active) {
          setData(response);
        }
      })
      .catch((cause: unknown): void => {
        if (active) {
          setError(cause);
        }
      })
      .finally((): void => {
        if (active) {
          setLoading(false);
        }
      });
    return (): void => {
      active = false;
    };
  }, [refreshKey, reloadToken]);

  const retry = useCallback((): void => {
    setReloadToken((value: number): number => value + 1);
  }, []);

  return (
    <div className="stockin-page">
      <div className="stockin-page-head">
        <div>
          <h1 className="stockin-page-title">统计大屏</h1>
          <div className="stockin-page-subtitle">
            单次请求返回 6 组指标与预警清单 · 基准日与阈值以服务端为准
          </div>
        </div>
        <Button onClick={retry} style={{ minHeight: TOUCH_TARGET_MIN_PX }}>
          刷新
        </Button>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin size="large" tip="加载中…" />
        </div>
      ) : error !== null ? (
        <ErrorView error={error} onRetry={retry} />
      ) : data === null ? (
        <Empty description="暂无统计数据" />
      ) : (
        <>
          <MetricCards metrics={data.metrics} />
          <Card
            title="临期 / 过期预警清单"
            extra={
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                共 {data.alerts.length} 条
              </Typography.Text>
            }
          >
            <ExpiryList
              alerts={data.alerts}
              thresholdDays={data.thresholdDays}
              baseDate={data.baseDate}
            />
          </Card>
        </>
      )}
    </div>
  );
};

export default DashboardPage;
