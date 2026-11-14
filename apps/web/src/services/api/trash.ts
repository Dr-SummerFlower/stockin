/**
 * 回收站 API。恢复 / 彻底删除均需前端二次确认（ConfirmDeleteModal）。
 * B4：新增批量恢复 / 批量彻底删除，两者与单条端点共用幂等语义与审计日志。
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

/** B4：批量恢复，返回实际恢复条数。 */
export function batchRestoreTrash(ids: readonly number[]): Promise<{ restored: number }> {
  return request<{ restored: number }>('/api/trash/batch-restore', {
    method: 'POST',
    json: { ids: [...ids] },
  });
}

/** B4：批量彻底删除，返回实际删除条数。 */
export function batchPurgeTrash(ids: readonly number[]): Promise<{ purged: number }> {
  return request<{ purged: number }>('/api/trash/batch-purge', {
    method: 'POST',
    json: { ids: [...ids] },
  });
}
