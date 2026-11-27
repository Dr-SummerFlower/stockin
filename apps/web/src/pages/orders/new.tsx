/**
 * 新增进货单页（`/orders/new`）。
 *
 * 表单产出整单载荷（抬头 + N 条 RecordDraft），这里只负责调用 `POST /api/orders`
 * 并在成功后跳详情页 —— 单号、日期、明细行的算法全部在 OrderForm 与 domain 内。
 */
import React, { useState } from 'react';
import { App as AntdApp, Button } from 'antd';
import { useModel, useNavigate } from 'umi';
import { createOrder } from '@/services/api/order';
import OrderForm, { type OrderPayload } from '@/components/OrderForm';
import Icon from '@/components/Icon';
import { ROUTES } from '@/constants/routes';

const NewOrderPage: React.FC = () => {
  const navigate = useNavigate();
  const { message: holderMessage } = AntdApp.useApp();
  const { bumpRefresh } = useModel('ui');
  const [submitting, setSubmitting] = useState<boolean>(false);

  const onSubmit = async (payload: OrderPayload): Promise<void> => {
    setSubmitting(true);
    try {
      const created = await createOrder({
        orderNo: payload.orderNo === '' ? undefined : payload.orderNo,
        supplier: payload.supplier,
        purchaseDate: payload.purchaseDate,
        remark: payload.remark === '' ? null : payload.remark,
        items: payload.items,
        idempotencyKey: payload.idempotencyKey,
      });
      bumpRefresh();
      holderMessage.success(`进货单已保存：${created.orderNo}（${created.itemCount} 条）`);
      navigate(ROUTES.orderDetail(created.id));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="stockin-page">
      <div className="stockin-page-head">
        <div>
          <h1 className="stockin-page-title">新增进货单</h1>
          <p className="stockin-page-sub">一张单一个供货商：抬头写一次，明细里连续录，一次保存。</p>
        </div>
        <div className="stockin-page-actions">
          <Button
            icon={<Icon name="arrowLeft" size="sm" />}
            onClick={(): void => navigate(ROUTES.orders)}
          >
            返回列表
          </Button>
        </div>
      </div>
      <OrderForm
        submitting={submitting}
        onSubmit={onSubmit}
        onCancel={(): void => navigate(ROUTES.orders)}
      />
    </div>
  );
};

export default NewOrderPage;
