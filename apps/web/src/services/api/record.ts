/**
 * 进货记录 API（路径以 T03b `record.routes.ts` 实际注册为准）。
 *
 * 保存载荷为 `RecordDraft`（10 业务字段 + 6 个来源位 + version?/idempotencyKey?），
 * 服务端 `record.service` 只校验不重算，前端必须在 `RecordForm` 里算对。
 */
import type {
  BatchDeleteRequest,
  PageResult,
  ProductNameListResponse,
  RecordDraft,
  RecordFilter,
  RecordSuggestionField,
  RecordSuggestionResponse,
  RecordView,
} from '@stockin/shared';
import { request } from '../request';

/** 把筛选对象序列化为 query（只带已定义/非空值）。 */
export function toRecordQuery(
  filter: RecordFilter,
): Readonly<Record<string, string | number | boolean | undefined>> {
  return {
    name: filter.name,
    purchaseDateFrom: filter.purchaseDateFrom,
    purchaseDateTo: filter.purchaseDateTo,
    expiryDateFrom: filter.expiryDateFrom,
    expiryDateTo: filter.expiryDateTo,
    spec: filter.spec,
    expiryStatus: filter.expiryStatus,
    page: filter.page,
    pageSize: filter.pageSize,
    sortBy: filter.sortBy,
    sortOrder: filter.sortOrder,
  };
}

export function listRecords(filter: RecordFilter): Promise<PageResult<RecordView>> {
  return request<PageResult<RecordView>>('/api/records', { query: toRecordQuery(filter) });
}

/**
 * 输入建议：商品名称（附最近一次规格/单价）或规格；失败静默，不打扰录入。
 * `supplier` 可选：传了就优先取该供货商下的最近一条，避免把别家的价带进来。
 */
export function getRecordSuggestions(
  field: RecordSuggestionField,
  q: string,
  supplier?: string,
): Promise<RecordSuggestionResponse> {
  return request<RecordSuggestionResponse>('/api/records/suggestions', {
    query: { field, q, supplier },
    silent: true,
  });
}

/**
 * 商品名清单：录入页打开时拉一次，本地做「疑似重复商品」检测。
 * 失败静默 —— 检测是增强项，不能因此挡住录入。
 *
 * `supplier` 可选：传了就只返回该供货商进过的名称（服务端按 `supplier_norm`
 * 严格过滤，**不回退全局**）。用于「从上次带入」的第二组候选。
 */
export function getProductNames(
  limit = 500,
  supplier?: string,
): Promise<ProductNameListResponse> {
  return request<ProductNameListResponse>('/api/records/product-names', {
    query: { limit, supplier },
    silent: true,
  });
}

export function getRecord(id: number): Promise<RecordView> {
  return request<RecordView>(`/api/records/${id}`);
}

export function createRecord(draft: RecordDraft): Promise<RecordView> {
  return request<RecordView>('/api/records', { method: 'POST', json: draft, silent: true });
}

export function updateRecord(id: number, draft: RecordDraft): Promise<RecordView> {
  return request<RecordView>(`/api/records/${id}`, { method: 'PUT', json: draft, silent: true });
}

export function deleteRecord(id: number): Promise<{ id: number }> {
  return request<{ id: number }>(`/api/records/${id}`, { method: 'DELETE' });
}

export function batchDeleteRecords(payload: BatchDeleteRequest): Promise<{ deleted: number }> {
  return request<{ deleted: number }>('/api/records/batch-delete', {
    method: 'POST',
    json: payload,
  });
}
