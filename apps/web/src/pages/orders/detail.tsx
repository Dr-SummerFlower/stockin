/**
 * 进货单详情（`/orders/:id`）。
 *
 * 一张单排成一张票：抬头四项 + 明细表 + 合计 + 整单备注。
 * 明细就是普通记录，展示口径复用记录页的格式化函数，不另立一套。
 * 手机档改卡片，字段按「商品 / 日期 / 金额」优先级重排。
 */
import React, { useEffect, useState } from 'react';
import { Button, Spin, Table, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useNavigate, useParams } from 'umi';
import type { OrderDetailView, RecordView } from '@stockin/shared';
import { getOrder } from '@/services/api/order';
import ErrorView from '@/components/ErrorView';
import Icon from '@/components/Icon';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { ROUTES, TOUCH_TARGET_MIN_PX } from '@/constants/routes';
import {
  formatCount,
  formatDate,
  formatMoney,
  formatQuantity,
  formatQuantityShort,
  formatUnitPriceShort,
  formatShelfLife,
  formatUnitPrice,
} from '@/utils/format';

const OrderDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const orderId: number = Number.parseInt(id ?? '', 10);
  const navigate = useNavigate();
  const { isMobile } = useBreakpoint();

  const [order, setOrder] = useState<OrderDetailView | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState<number>(0);

  useEffect((): (() => void) => {
    let active = true;
    setLoading(true);
    setError(null);
    if (!Number.isSafeInteger(orderId) || orderId <= 0) {
      setError(new Error('单号不合法'));
      setLoading(false);
      return (): void => {
        active = false;
      };
    }
    void getOrder(orderId)
      .then((detail): void => {
        if (active) setOrder(detail);
      })
      .catch((cause: unknown): void => {
        if (active) setError(cause);
      })
      .finally((): void => {
        if (active) setLoading(false);
      });
    return (): void => {
      active = false;
    };
  }, [orderId, reloadKey]);

  const columns: ColumnsType<RecordView> = [
    {
      title: '商品',
      dataIndex: 'name',
      key: 'name',
      render: (value: string, record: RecordView): React.ReactNode => (
        <div>
          <div className="stockin-cell-name">{value}</div>
          {record.spec !== null && record.spec !== '' ? (
            <div className="stockin-cell-sub">{record.spec}</div>
          ) : null}
        </div>
      ),
    },
    {
      title: '生产日期',
      dataIndex: 'productionDate',
      key: 'productionDate',
      width: 120,
      render: (value: string | null): React.ReactNode => (
        <span className="stockin-mono">{formatDate(value)}</span>
      ),
    },
    {
      title: '保质期',
      key: 'shelfLife',
      width: 110,
      render: (_: unknown, record: RecordView): string =>
        formatShelfLife(record.shelfLifeValue, record.shelfLifeUnit),
    },
    {
      title: '到期日',
      dataIndex: 'expiryDate',
      key: 'expiryDate',
      width: 120,
      render: (value: string | null): React.ReactNode => (
        <span className="stockin-mono">{formatDate(value)}</span>
      ),
    },
    {
      title: '单价',
      dataIndex: 'unitPrice',
      key: 'unitPrice',
      width: 100,
      align: 'right',
      render: (value: number): React.ReactNode => (
        <span className="stockin-mono">{formatUnitPrice(value)}</span>
      ),
    },
    {
      title: '数量',
      dataIndex: 'quantity',
      key: 'quantity',
      width: 90,
      align: 'right',
      render: (value: number): React.ReactNode => (
        <span className="stockin-mono">{formatQuantity(value)}</span>
      ),
    },
    {
      title: '金额',
      dataIndex: 'amountCents',
      key: 'amountCents',
      width: 120,
      align: 'right',
      render: (value: number): React.ReactNode => (
        <span className="stockin-num-strong">{formatMoney(value)}</span>
      ),
    },
  ];

  if (loading) {
    return (
      <div className="stockin-page" style={{ textAlign: 'center', padding: 48 }}>
        <Spin size="large" />
        <div className="stockin-hint" style={{ marginTop: 12 }}>加载进货单中…</div>
      </div>
    );
  }
  if (error !== null) {
    return (
      <div className="stockin-page">
        <ErrorView
          error={error}
          title="进货单加载失败"
          onRetry={(): void => setReloadKey((key: number): number => key + 1)}
        />
        <Button
          style={{ marginTop: 12, minHeight: TOUCH_TARGET_MIN_PX }}
          onClick={(): void => navigate(ROUTES.orders)}
        >
          返回列表
        </Button>
      </div>
    );
  }
  if (order === null) {
    return (
      <div className="stockin-page">
        <ErrorView error={new Error('进货单不存在或已被删除')} title="进货单不存在" />
      </div>
    );
  }

  return (
    <div className="stockin-page">
      <div className="stockin-page-head">
        <div>
          <h1 className="stockin-page-title">
            进货单 <span className="stockin-mono">{order.orderNo}</span>
          </h1>
          <p className="stockin-page-sub">{order.supplier} · {order.purchaseDate}</p>
        </div>
        <div className="stockin-page-actions">
          <Button
            icon={<Icon name="arrowLeft" size="sm" />}
            onClick={(): void => navigate(ROUTES.orders)}
            style={{ minHeight: TOUCH_TARGET_MIN_PX }}
          >
            返回列表
          </Button>
          <Tooltip title="浏览器打印 / 存 PDF">
            <Button
              icon={<Icon name="download" size="sm" />}
              onClick={(): void => window.print()}
              style={{ minHeight: TOUCH_TARGET_MIN_PX }}
            >
              打印
            </Button>
          </Tooltip>
        </div>
      </div>

      <div className="stockin-receipt-strip">
        <span>单据编号 <b>{order.orderNo}</b></span>
        <span>供货商 <b>{order.supplier}</b></span>
        <span>进货日期 <b>{order.purchaseDate}</b></span>
        <span>
          品种 <b>{formatCount(order.itemCount)}</b> · 数量 <b>{formatQuantityShort(order.totalQuantity)}</b>
        </span>
        <span>合计 <b>{formatMoney(order.totalAmountCents)}</b></span>
      </div>

      {isMobile ? (
        <div>
          {order.items.map(
            (item: RecordView): React.ReactNode => (
              <div key={item.id} className="stockin-order-item-card">
                <div className="stockin-order-item-card__top">
                  <b>{item.name}</b>
                  <span className="stockin-num-strong">{formatMoney(item.amountCents)}</span>
                </div>
                <div className="stockin-order-item-card__spec">
                  {item.spec ?? '无规格'} · {formatShelfLife(item.shelfLifeValue, item.shelfLifeUnit)}
                </div>
                <div className="stockin-order-item-card__meta">
                  <span>{formatQuantityShort(item.quantity)} 件 × ¥{formatUnitPriceShort(item.unitPrice)}</span>
                  <span>到期 {formatDate(item.expiryDate)}</span>
                </div>
              </div>
            ),
          )}
          <div className="stockin-order-total">
            <span>合计</span>
            <b>{formatMoney(order.totalAmountCents)}</b>
          </div>
        </div>
      ) : (
        <div className="stockin-panel">
          <Table<RecordView>
            rowKey="id"
            size="middle"
            pagination={false}
            dataSource={order.items as RecordView[]}
            columns={columns}
          />
          <div className="stockin-order-total is-panel">
            <span>合计</span>
            <b>{formatMoney(order.totalAmountCents)}</b>
          </div>
        </div>
      )}

      {order.remark !== null && order.remark !== '' ? (
        <div className="stockin-order-remark">
          <b>整单备注：</b>
          {order.remark}
        </div>
      ) : null}
    </div>
  );
};

export default OrderDetailPage;
