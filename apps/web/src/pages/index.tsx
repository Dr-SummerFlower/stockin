/**
 * 统计大屏（`/`，主布局内首屏）。
 *
 * 依据：design/stockin-ui-design-system.md §5.1 与原型 view-dashboard。
 * 结构：页头 → 票据抬头信息带 → 4 项指标带（①–④）→ 左预警清单 / 右风险栏（⑤⑥）。
 * 预警清单的分段 / 分页均走 `getDashboard({ page, pageSize, status })` 这一份数据源，
 * 6 组指标始终是全表聚合；清单由服务端排定，**前端不二次排序**；
 * 写操作后由 ui model 的 refreshKey 触发重拉。零图表库、零趋势图 / 排行 / 下钻。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Button, Spin } from 'antd';
import { useModel, useNavigate } from 'umi';
import { DEFAULT_PAGE_SIZE, type DashboardResponse, type ExpiryAlertQuery } from '@stockin/shared';
import { getDashboard } from '@/services/api/dashboard';
import { MetricBand, RiskColumn } from '@/components/MetricCards';
import EmptyState from '@/components/EmptyState';
import ExpiryList from '@/components/ExpiryList';
import ErrorView from '@/components/ErrorView';
import Icon from '@/components/Icon';
import InfoTip from '@/components/InfoTip';
import { ROUTES } from '@/constants/routes';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { formatClock, formatDate } from '@/utils/format';

const DashboardPage: React.FC = () => {
  const { refreshKey } = useModel('ui');
  const navigate = useNavigate();
  const { useCardList } = useBreakpoint();
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [reloadToken, setReloadToken] = useState<number>(0);
  // 当次成功拉取的时间点，票据条据此显示真实的「更新于」，而不是写死的状态词。
  const [updatedAt, setUpdatedAt] = useState<string>('');
  // 预警清单的分段 / 分页条件：唯一数据源，变化即重调 getDashboard。
  const [query, setQuery] = useState<ExpiryAlertQuery>({
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
  });

  useEffect((): (() => void) => {
    let active = true;
    setLoading(true);
    setError(null);
    void getDashboard(query)
      .then((response: DashboardResponse): void => {
        if (active) {
          setData(response);
          setUpdatedAt(new Date().toISOString());
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
  }, [query, refreshKey, reloadToken]);

  const retry = useCallback((): void => {
    setReloadToken((value: number): number => value + 1);
  }, []);

  const onQueryChange = useCallback((next: ExpiryAlertQuery): void => {
    setQuery(next);
  }, []);

  const onView = useCallback(
    (id: number): void => navigate(ROUTES.recordEdit(id)),
    [navigate],
  );

  const baseDateText: string = data === null ? '—' : formatDate(data.baseDate);
  const thresholdText: string = data === null ? '—' : String(data.thresholdDays);

  return (
    <div className="stockin-page">
      <div className="stockin-page-head">
        <div className="stockin-title-row">
          <h1 className="stockin-page-title">统计大屏</h1>
          <InfoTip
            label="查看统计口径说明"
            title="统计口径"
            content="累计进货金额与笔数含全部有效记录；商品种类按商品名称去重；累计进货数量为各条数量之和。预警清单按到期日由近到远排列，未填到期日的记录不计入预警。"
          />
        </div>
        <div className="stockin-page-actions">
          <Button
            icon={<Icon name="list" size="sm" />}
            onClick={(): void => navigate(ROUTES.records)}
          >
            查看全部记录
          </Button>
          <Button
            type="primary"
            icon={<Icon name="plus" size="sm" />}
            onClick={(): void => navigate(ROUTES.recordNew)}
          >
            新增记录
          </Button>
        </div>
      </div>

      {error !== null ? (
        <ErrorView error={error} onRetry={retry} />
      ) : data === null ? (
        loading ? (
          <div style={{ textAlign: 'center', padding: 48 }}>
            <Spin size="large" />
            <div className="stockin-hint" style={{ marginTop: 12 }}>
              加载中…
            </div>
          </div>
        ) : (
          <EmptyState title="暂无统计数据" />
        )
      ) : (
        <>
          <div className="stockin-receipt-strip">
            <span>
              统计日期 <b className="stockin-mono">{baseDateText}</b>
            </span>
            <span>
              临期阈值 <b className="stockin-mono">{thresholdText}</b> 天
            </span>
            <span>
              更新于 <b className="stockin-mono">{formatClock(updatedAt)}</b>
            </span>
          </div>

          <MetricBand metrics={data.metrics} />

          <div className="stockin-dashboard-grid">
            <ExpiryList
              alerts={data.alerts}
              metrics={data.metrics}
              alertsTotal={data.alertsTotal}
              alertsPage={data.alertsPage}
              alertsPageSize={data.alertsPageSize}
              alertsStatus={data.alertsStatus}
              loading={loading}
              useCardList={useCardList}
              onQueryChange={onQueryChange}
              onView={onView}
              onRefresh={retry}
            />
            <RiskColumn
              metrics={data.metrics}
              onAdjust={(): void => navigate(ROUTES.settings)}
            />
          </div>
        </>
      )}
    </div>
  );
};

export default DashboardPage;
