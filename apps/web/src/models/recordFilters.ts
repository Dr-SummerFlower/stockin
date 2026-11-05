/**
 * 记录筛选 model：列表、Excel 导出共用同一份 `RecordFilter`（当前筛选 ∩ 日期范围）。
 *
 * 依据：设计文档 §2.4 BR-11「导出范围 = 当前筛选 ∩ 日期范围」；
 * 主理人 T04「导出用 FormData/POST JSON RecordFilter」。
 */
import { useCallback, useState } from 'react';
import { DEFAULT_PAGE_SIZE, type RecordFilter } from '@stockin/shared';

export const DEFAULT_RECORD_FILTER: Readonly<RecordFilter> = {
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  sortBy: 'purchaseDate',
  sortOrder: 'desc',
};

export interface RecordFiltersModelState {
  readonly filter: RecordFilter;
  readonly setFilter: (next: RecordFilter) => void;
  readonly patchFilter: (patch: Partial<RecordFilter>) => void;
  readonly resetFilter: () => void;
  /** 设置分页（保持其余条件不变）。 */
  readonly setPage: (page: number, pageSize?: number) => void;
  /** 供导出使用的「不含分页」筛选副本。 */
  readonly exportFilter: () => RecordFilter;
}

export default function useRecordFiltersModel(): RecordFiltersModelState {
  const [filter, setFilterState] = useState<RecordFilter>({ ...DEFAULT_RECORD_FILTER });

  const setFilter = useCallback((next: RecordFilter): void => {
    setFilterState({ ...next });
  }, []);

  const patchFilter = useCallback((patch: Partial<RecordFilter>): void => {
    setFilterState((prev) => ({ ...prev, ...patch, page: 1 }));
  }, []);

  const resetFilter = useCallback((): void => {
    setFilterState({ ...DEFAULT_RECORD_FILTER });
  }, []);

  const setPage = useCallback((page: number, pageSize?: number): void => {
    setFilterState((prev) => ({
      ...prev,
      page,
      pageSize: pageSize ?? prev.pageSize ?? DEFAULT_PAGE_SIZE,
    }));
  }, []);

  const exportFilter = useCallback((): RecordFilter => {
    const { page: _page, pageSize: _pageSize, ...rest } = filter;
    void _page;
    void _pageSize;
    return { ...rest };
  }, [filter]);

  return { filter, setFilter, patchFilter, resetFilter, setPage, exportFilter };
}
