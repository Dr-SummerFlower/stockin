/**
 * 回收站 API（路径以 T03b `trash.routes.ts` 实际注册为准）。
 * 恢复 / 彻底删除均需前端二次确认（`ConfirmDeleteModal`）。
 */
import { DEFAULT_PAGE_SIZE, type PageResult, type RecordView } from '@stockin/shared';
import { request } from '../request';

export function listTrash(
  page: number = 1,
  pageSize: number = DEFAULT_PAGE_SIZE,
): Promise<PageResult<RecordView>> {
  return request<PageResult<RecordView>>('/api/trash', { query: { page, pageSize } });
}

export function restoreTrash(id: number): Promise<{ id: number }> {
  return request<{ id: number }>(`/api/trash/${id}/restore`, { method: 'POST' });
}

export function purgeTrash(id: number): Promise<{ id: number }> {
  return request<{ id: number }>(`/api/trash/${id}`, { method: 'DELETE' });
}
