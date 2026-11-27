/**
 * 进货单 API。
 *
 * 契约见 `.tmp/接口契约-进货单.md`；类型来自 `@stockin/shared` 的 `dto/order.dto`。
 * 后端尚未实现时，这些端点会返回 404/500，页面按统一错误面渲染，
 * 不需要前端做额外降级分支。
 */
import type {
  OrderCreateRequest,
  OrderDetailView,
  OrderFilter,
  OrderNextNoResponse,
  OrderView,
  PageResult,
} from '@stockin/shared';
import { request } from '../request';

/** 把筛选对象序列化为 query（只带已定义/非空值）。 */
export function toOrderQuery(
  filter: OrderFilter,
): Readonly<Record<string, string | number | undefined>> {
  return {
    q: filter.q,
    supplier: filter.supplier,
    purchaseDateFrom: filter.purchaseDateFrom,
    purchaseDateTo: filter.purchaseDateTo,
    page: filter.page,
    pageSize: filter.pageSize,
  };
}

export function listOrders(filter: OrderFilter): Promise<PageResult<OrderView>> {
  return request<PageResult<OrderView>>('/api/orders', { query: toOrderQuery(filter) });
}

export function getOrder(id: number): Promise<OrderDetailView> {
  return request<OrderDetailView>(`/api/orders/${id}`);
}

/** 新建整单；失败时 `details.index` 指明出错明细行（从 0 开始）。 */
export function createOrder(payload: OrderCreateRequest): Promise<OrderView> {
  return request<OrderView>('/api/orders', { method: 'POST', json: payload, silent: true });
}

export function deleteOrder(id: number): Promise<{ id: number; deletedRecords: number }> {
  return request<{ id: number; deletedRecords: number }>(`/api/orders/${id}`, {
    method: 'DELETE',
  });
}

/** 预填用单号；失败静默（前端留空交给服务端生成）。 */
export function getNextOrderNo(date: string): Promise<OrderNextNoResponse> {
  return request<OrderNextNoResponse>('/api/orders/next-no', {
    query: { date },
    silent: true,
  });
}
