/**
 * 进货单列表（`/orders`）。
 *
 * 一张单一行：单号 / 供货商 / 进货日期 / 品种 / 合计金额 / 录入时间。
 * 桌面用表格，手机（<768）改卡片；两套布局共用同一份 `OrderFilter` 与同一次请求。
 *
 * 数据来源：`GET /api/orders`（契约见 `.tmp/接口契约-进货单.md`）。
 * 后端未就绪时此处会走统一错误面（ErrorView + 重试），不做假数据兜底。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { App as AntdApp, Button, Drawer, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useNavigate } from 'umi';
import type { OrderFilter, OrderView } from '@stockin/shared';
import { deleteOrder, listOrders, toOrderQuery } from '@/services/api/order';
import { download, errorMessage } from '@/services/request';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { ImeInput as Input } from '@/components/ImeInput';
import { DateRangeInput } from '@/components/DateInput';
import ConfirmDeleteModal from '@/components/ConfirmDeleteModal';
import EmptyState from '@/components/EmptyState';
import ErrorView from '@/components/ErrorView';
import Icon from '@/components/Icon';
import Pager from '@/components/Pager';
import { ROUTES, TOUCH_TARGET_MIN_PX } from '@/constants/routes';
import { formatCount, formatDateTime, formatMoney, formatQuantityShort } from '@/utils/format';

const PAGE_SIZE = 20;

const INITIAL_FILTER: OrderFilter = {
  q: '',
  purchaseDateFrom: '',
  purchaseDateTo: '',
  page: 1,
  pageSize: PAGE_SIZE,
};

const OrdersPage: React.FC = () => {
  const navigate = useNavigate();
  const { message: holderMessage } = AntdApp.useApp();
  const { isMobile } = useBreakpoint();

  const [filter, setFilter] = useState<OrderFilter>(INITIAL_FILTER);
  const [items, setItems] = useState<readonly OrderView[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadToken, setReloadToken] = useState<number>(0);
  const [sheetOpen, setSheetOpen] = useState<boolean>(false);
  const [pendingDelete, setPendingDelete] = useState<OrderView | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [exporting, setExporting] = useState<boolean>(false);

  useEffect((): (() => void) => {
    let active = true;
    setLoading(true);
    setError(null);
    void listOrders(filter)
      .then((page): void => {
        if (!active) return;
        setItems(page.items);
        setTotal(page.total);
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
  }, [filter, reloadToken]);

  const patch = useCallback((next: Partial<OrderFilter>): void => {
    setFilter((prev: OrderFilter): OrderFilter => ({ ...prev, ...next, page: 1 }));
  }, []);

  const hasFilter: boolean =
    (filter.q ?? '') !== '' ||
    (filter.purchaseDateFrom ?? '') !== '' ||
    (filter.purchaseDateTo ?? '') !== '';

  /** 导出当前筛选命中的单据汇总（xlsx，服务端生成）。 */
  const doExport = async (): Promise<void> => {
    setExporting(true);
    try {
      const result = await download('/api/orders/export', { query: toOrderQuery(filter) });
      holderMessage.success(`已开始下载 ${result.filename}`);
    } catch (cause) {
      holderMessage.error(errorMessage(cause, '导出失败'));
    } finally {
      setExporting(false);
    }
  };

  const doDelete = async (): Promise<void> => {
    if (pendingDelete === null) return;
    setBusy(true);
    try {
      await deleteOrder(pendingDelete.id);
      holderMessage.success('进货单已移入回收站');
      setPendingDelete(null);
      setReloadToken((v: number): number => v + 1);
    } catch (cause) {
      holderMessage.error(errorMessage(cause, '删除失败'));
    } finally {
      setBusy(false);
    }
  };

  const columns: ColumnsType<OrderView> = useMemo(
    () => [
      {
        title: '单据编号',
        dataIndex: 'orderNo',
        key: 'orderNo',
        width: 150,
        render: (value: string): React.ReactNode => <span className="stockin-mono-strong">{value}</span>,
      },
      { title: '供货商', dataIndex: 'supplier', key: 'supplier', width: 160 },
      {
        title: '进货日期',
        dataIndex: 'purchaseDate',
        key: 'purchaseDate',
        width: 120,
        render: (value: string): React.ReactNode => <span className="stockin-mono">{value}</span>,
      },
      {
        title: '品种',
        dataIndex: 'itemCount',
        key: 'itemCount',
        width: 80,
        align: 'right',
        render: (value: number): string => formatCount(value),
      },
      {
        title: '合计金额',
        dataIndex: 'totalAmountCents',
        key: 'totalAmountCents',
        width: 130,
        align: 'right',
        render: (value: number): React.ReactNode => (
          <span className="stockin-num-strong">{formatMoney(value)}</span>
        ),
      },
      {
        title: '录入时间',
        dataIndex: 'createdAt',
        key: 'createdAt',
        width: 150,
        render: (value: string): React.ReactNode => (
          <span className="stockin-text-muted">{formatDateTime(value)}</span>
        ),
      },
      {
        title: '',
        key: 'action',
        width: 96,
        align: 'right',
        render: (_: unknown, record: OrderView): React.ReactNode => (
          <span className="stockin-row-actions" onClick={(event): void => event.stopPropagation()}>
            <Button
              type="text"
              size="small"
              aria-label="查看单据"
              icon={<Icon name="chevron" size="sm" />}
              onClick={(): void => navigate(ROUTES.orderDetail(record.id))}
            />
            <Button
              type="text"
              size="small"
              aria-label="删除单据"
              icon={<Icon name="trash" size="sm" />}
              onClick={(): void => setPendingDelete(record)}
            />
          </span>
        ),
      },
    ],
    [navigate],
  );

  const filterFields = (
    <>
      <div className="stockin-field-wrap">
        <div className="stockin-field-label"><span>单号 / 供货商 / 商品</span></div>
        <Input
          value={filter.q ?? ''}
          placeholder="输入单号或供货商"
          aria-label="按单号或供货商筛选"
          maxLength={100}
          onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
            patch({ q: event.target.value })
          }
        />
      </div>
      <div className="stockin-field-wrap">
        <div className="stockin-field-label"><span>进货日期</span></div>
        <DateRangeInput
          from={filter.purchaseDateFrom ?? ''}
          to={filter.purchaseDateTo ?? ''}
          ariaLabel="进货日期范围"
          onChange={(from: string, to: string): void =>
            patch({ purchaseDateFrom: from, purchaseDateTo: to })
          }
        />
      </div>
    </>
  );

  return (
    <div className="stockin-page">
      <div className="stockin-page-head">
        <div className="stockin-title-row">
          <h1 className="stockin-page-title">进货单</h1>
        </div>
        <div className="stockin-page-actions">
          <Button
            icon={<Icon name="download" size="sm" />}
            loading={exporting}
            disabled={total === 0}
            onClick={(): void => void doExport()}
            style={{ minHeight: TOUCH_TARGET_MIN_PX }}
          >
            导出
          </Button>
          <Button
            type="primary"
            icon={<Icon name="plus" size="sm" />}
            onClick={(): void => navigate(ROUTES.orderNew)}
            style={{ minHeight: TOUCH_TARGET_MIN_PX }}
          >
            新增进货单
          </Button>
        </div>
      </div>

      <div className="stockin-receipt-strip">
        <span>共 <b>{formatCount(total)}</b> 张单</span>
        <span>一张单一个供货商</span>
        <span>单号 = 日期 + 当日序号，如 20261125001</span>
      </div>

      {isMobile ? (
        <div className="stockin-mfilter">
          <button
            type="button"
            className={`stockin-mfilter-chip${hasFilter ? ' is-on' : ''}`}
            onClick={(): void => setSheetOpen(true)}
          >
            <Icon name="search" size="sm" />
            筛选{hasFilter ? ' · 已设' : ''}
          </button>
          {hasFilter ? (
            <button
              type="button"
              className="stockin-mfilter-chip"
              onClick={(): void => setFilter(INITIAL_FILTER)}
            >
              清除
            </button>
          ) : null}
        </div>
      ) : (
        <div className="stockin-filter-bar">
          <div className="stockin-filter-fields">{filterFields}</div>
          <div className="stockin-filter-actions">
            {hasFilter ? (
              <Button onClick={(): void => setFilter(INITIAL_FILTER)}>重置</Button>
            ) : null}
          </div>
        </div>
      )}

      {error !== null ? (
        <ErrorView
          error={error}
          title="进货单加载失败"
          onRetry={(): void => setReloadToken((v: number): number => v + 1)}
        />
      ) : isMobile ? (
        <div>
          {loading ? (
            <div className="stockin-skeleton-list" aria-busy="true">
              {[0, 1, 2, 3].map((key: number) => (
                <div key={key} className="stockin-skeleton-card" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <EmptyState icon="list" title="还没有进货单" />
          ) : (
            items.map(
              (order: OrderView): React.ReactNode => (
                <button
                  key={order.id}
                  type="button"
                  className="stockin-order-card"
                  onClick={(): void => navigate(ROUTES.orderDetail(order.id))}
                >
                  <div className="stockin-order-card__top">
                    <span className="stockin-order-card__no">{order.orderNo}</span>
                    <b className="stockin-order-card__money">{formatMoney(order.totalAmountCents)}</b>
                  </div>
                  <div className="stockin-order-card__supplier">{order.supplier}</div>
                  <div className="stockin-order-card__meta">
                    <span>{order.purchaseDate}</span>
                    <span className="stockin-dot-sep" />
                    <span>{formatCount(order.itemCount)} 个品种</span>
                    <span className="stockin-dot-sep" />
                    <span>{formatQuantityShort(order.totalQuantity)} 件</span>
                  </div>
                </button>
              ),
            )
          )}
          {total > PAGE_SIZE ? (
            <Pager
              page={filter.page ?? 1}
              pageSize={PAGE_SIZE}
              total={total}
              onChange={(page: number): void => setFilter((prev) => ({ ...prev, page }))}
            />
          ) : null}
        </div>
      ) : (
        <div className="stockin-panel">
          {/* F-16：与记录页一致的骨架，不再叠加 antd Table 的居中 Spin。 */}
          {loading ? (
            <div className="stockin-skeleton-list" aria-busy="true">
              {[0, 1, 2, 3, 4].map((key: number) => (
                <div key={key} className="stockin-skeleton-row" />
              ))}
            </div>
          ) : null}
          <Table<OrderView>
            rowKey="id"
            size="middle"
            loading={false}
            dataSource={loading ? [] : (items as OrderView[])}
            columns={columns}
            pagination={false}
            onRow={(record: OrderView) => ({
              onClick: (): void => navigate(ROUTES.orderDetail(record.id)),
              style: { cursor: 'pointer' },
            })}
            locale={{ emptyText: <EmptyState icon="list" title="还没有进货单" /> }}
          />
          <div className="stockin-panel-foot is-plain">
            <Pager
              page={filter.page ?? 1}
              pageSize={PAGE_SIZE}
              total={total}
              onChange={(page: number): void => setFilter((prev) => ({ ...prev, page }))}
            />
          </div>
        </div>
      )}

      <Drawer
        placement="bottom"
        open={sheetOpen}
        onClose={(): void => setSheetOpen(false)}
        height="auto"
        title="筛选进货单"
        className="stockin-drawer"
      >
        <div className="stockin-form-grid" style={{ marginBottom: 16 }}>{filterFields}</div>
        <div className="stockin-btn-row" style={{ justifyContent: 'flex-end' }}>
          <Button onClick={(): void => setFilter(INITIAL_FILTER)}>重置</Button>
          <Button type="primary" onClick={(): void => setSheetOpen(false)} style={{ minHeight: TOUCH_TARGET_MIN_PX }}>
            查看结果
          </Button>
        </div>
      </Drawer>

      <ConfirmDeleteModal
        open={pendingDelete !== null}
        title="移入回收站"
        description={
          pendingDelete === null
            ? ''
            : `单据 ${pendingDelete.orderNo}（${formatCount(pendingDelete.itemCount)} 条明细）将一起移入回收站，可在回收站恢复。`
        }
        confirmText="移入回收站"
        danger={false}
        busy={busy}
        onConfirm={(): void => void doDelete()}
        onCancel={(): void => setPendingDelete(null)}
      />
    </div>
  );
};

export default OrdersPage;
