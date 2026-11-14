/**
 * 分页：design 原型 `.pager` 的纯页码按钮形态。
 *
 * 设计依据：design/stockin-ui-prototype.html 第 306–309 / 771 行——
 * `‹ 1 2 3 … 161 ›` 一组按钮，配一行「显示 1–8 / 共 1,284 条」，
 * **没有「每页条数」下拉框，也没有可输入的页码框**。
 *
 * 每页条数由调用方固定（DEFAULT_PAGE_SIZE = 20），服务端请求参数不变；
 * 组件只负责翻页，不改写 pageSize。页码去重、越界钳制、省略号均在此收口。
 */
import React from 'react';
import { formatCount } from '@/utils/format';

export interface PagerProps {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly onChange: (page: number) => void;
  readonly disabled?: boolean;
}

/** 生成去重后的页码序列，并在断层处插入省略号标记（0）。 */
function pageItems(page: number, totalPages: number): number[] {
  const wanted: number[] = Array.from(
    new Set<number>([1, totalPages, page - 1, page, page + 1]),
  )
    .filter((value: number): boolean => value >= 1 && value <= totalPages)
    .sort((a: number, b: number): number => a - b);
  const result: number[] = [];
  wanted.forEach((value: number, index: number): void => {
    if (index > 0 && value - wanted[index - 1] > 1) {
      result.push(0);
    }
    result.push(value);
  });
  return result;
}

const Pager: React.FC<PagerProps> = ({ page, pageSize, total, onChange, disabled = false }) => {
  const totalPages: number = Math.max(1, Math.ceil(total / pageSize));
  const safePage: number = Math.min(Math.max(1, page), totalPages);
  const from: number = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const to: number = Math.min(safePage * pageSize, total);

  return (
    <div className="stockin-pager-wrap">
      <span className="stockin-pager-summary">
        显示 {formatCount(from)}–{formatCount(to)} / 共 {formatCount(total)} 条
      </span>
      <div className="stockin-pager" role="group" aria-label="分页">
        <button
          type="button"
          className="stockin-pager-btn"
          aria-label="上一页"
          disabled={disabled || safePage <= 1}
          onClick={(): void => onChange(safePage - 1)}
        >
          ‹
        </button>
        {pageItems(safePage, totalPages).map((value: number, index: number) =>
          value === 0 ? (
            <span className="stockin-pager-ellipsis" aria-hidden="true" key={`gap-${index}`}>
              …
            </span>
          ) : (
            <button
              type="button"
              key={value}
              className={`stockin-pager-btn${value === safePage ? ' is-on' : ''}`}
              aria-label={`第 ${value} 页`}
              aria-current={value === safePage ? 'page' : undefined}
              disabled={disabled}
              onClick={(): void => onChange(value)}
            >
              {value}
            </button>
          ),
        )}
        <button
          type="button"
          className="stockin-pager-btn"
          aria-label="下一页"
          disabled={disabled || safePage >= totalPages}
          onClick={(): void => onChange(safePage + 1)}
        >
          ›
        </button>
      </div>
    </div>
  );
};

export default Pager;
