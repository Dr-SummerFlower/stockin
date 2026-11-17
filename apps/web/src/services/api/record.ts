/**
 * 进货记录 API（路径以 T03b `record.routes.ts` 实际注册为准）。
 *
 * 保存载荷为 `RecordDraft`（10 业务字段 + 6 个来源位 + version?/idempotencyKey?），
 * 服务端 `record.service` 只校验不重算，前端必须在 `RecordForm` 里算对。
 */
import type {
  BatchDeleteRequest,
  PageResult,
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

/** 输入建议：商品名称（附最近一次规格/单价）或规格；失败静默，不打扰录入。 */
export function getRecordSuggestions(
  field: RecordSuggestionField,
  q: string,
): Promise<RecordSuggestionResponse> {
  return request<RecordSuggestionResponse>('/api/records/suggestions', {
    query: { field, q },
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
