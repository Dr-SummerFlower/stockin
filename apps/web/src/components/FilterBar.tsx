/**
 * 记录列表筛选条：默认 3 项高频条件，其余收进「更多筛选」。
 *
 * 依据：design/stockin-ui-design-system.md §5.2 与原型 view-records。
 * 排序走主表列头，不在筛选条重复；「已应用」chips 与导出弹窗共用
 * `describeRecordFilter()` 的同一份描述，筛选与导出共用同一份 RecordFilter。
 *
 * 控件统一：全部用 antd 控件（Input / Select / RangePicker），值仍是
 * YYYY-MM-DD 字符串，与后端契约一致；日期区间用一个区间选择器承载起止两端，
 * 不再拼两个原生日期框。
 */
import React, { useState } from 'react';
import { Button, Select } from 'antd';
import type { RecordFilter } from '@stockin/shared';
import Icon from '@/components/Icon';
import InfoTip from '@/components/InfoTip';
import SuggestionInput from '@/components/SuggestionInput';
import { DateRangeInput } from '@/components/DateInput';
import { describeRecordFilter } from '@/utils/format';
import { TOUCH_TARGET_MIN_PX } from '@/constants/routes';

export interface FilterBarProps {
  readonly filter: RecordFilter;
  readonly onChange: (patch: Partial<RecordFilter>) => void;
  readonly onReset: () => void;
}

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'near', label: '临期' },
  { value: 'expired', label: '已过期' },
  { value: 'none', label: '正常' },
];

const FilterBar: React.FC<FilterBarProps> = ({
  filter,
  onChange,
  onReset,
}) => {
  const [moreOpen, setMoreOpen] = useState<boolean>(false);
  const chips = describeRecordFilter(filter);
  const moreCount = [
    filter.spec,
    filter.expiryDateFrom,
    filter.expiryDateTo,
  ].filter((value: string | undefined): boolean => value !== undefined && value !== '').length;

  const item = (
    label: string,
    node: React.ReactNode,
    kind?: 'sm' | 'range',
  ): React.ReactNode => (
    <div className={`stockin-filter-item${kind !== undefined ? ` is-${kind}` : ''}`}>
      <span className="stockin-filter-label">{label}</span>
      {node}
    </div>
  );

  const dateRange = (
    label: string,
    startValue: string | undefined,
    startKey: 'purchaseDateFrom' | 'expiryDateFrom',
    endValue: string | undefined,
    endKey: 'purchaseDateTo' | 'expiryDateTo',
  ): React.ReactNode => (
    <DateRangeInput
      from={startValue ?? ''}
      to={endValue ?? ''}
      ariaLabel={`按${label}区间筛选`}
      onChange={(from: string, to: string): void =>
        onChange({
          [startKey]: from === '' ? undefined : from,
          [endKey]: to === '' ? undefined : to,
        })
      }
    />
  );

  return (
    <>
      <div className="stockin-filter-bar" data-tour-id="record-filter">
        <div className="stockin-filter-row">
          {item(
            '商品名称',
            <SuggestionInput
              field="name"
              value={filter.name ?? ''}
              ariaLabel="按商品名称筛选"
              placeholder="请输入商品名称"
              onChange={(value: string): void =>
                onChange({ name: value === '' ? undefined : value })
              }
            />,
          )}
          {item(
            '到期状态',
            <Select
              value={filter.expiryStatus}
              placeholder="全部状态"
              aria-label="按到期状态筛选"
              options={STATUS_OPTIONS}
              allowClear
              getPopupContainer={(): HTMLElement => document.body}
              style={{ width: '100%', minHeight: TOUCH_TARGET_MIN_PX }}
              onChange={(value: string | undefined): void =>
                onChange({ expiryStatus: value as RecordFilter['expiryStatus'] })
              }
            />,
            'sm',
          )}
          {item(
            '进货日期',
            dateRange(
              '进货日期', filter.purchaseDateFrom, 'purchaseDateFrom',
              filter.purchaseDateTo, 'purchaseDateTo',
            ),
            'range',
          )}
          <div className="stockin-filter-actions">
            <button
              type="button"
              className="stockin-link-btn"
              onClick={(): void => setMoreOpen((open: boolean): boolean => !open)}
              aria-expanded={moreOpen}
            >
              {moreOpen ? '收起筛选' : '更多筛选'}
              {moreCount > 0 ? ` ${moreCount}` : ''}
              <Icon
                name="chevron"
                size="sm"
                className={moreOpen ? 'stockin-icon-rotated' : undefined}
              />
            </button>
            <Button onClick={onReset} style={{ minHeight: TOUCH_TARGET_MIN_PX }}>
              重置
            </Button>
            <InfoTip
              label="查看筛选规则说明"
              title="筛选规则"
              content="商品名称与规格按开头文字匹配；到期状态按设置页的当前阈值判定，「正常」含未填到期日的记录。"
            />
          </div>
        </div>

        {moreOpen ? (
          <div className="stockin-advanced-panel">
            <div className="stockin-filter-row">
              {item(
                '规格',
                <SuggestionInput
                  field="spec"
                  value={filter.spec ?? ''}
                  ariaLabel="按规格筛选"
                  onChange={(value: string): void =>
                    onChange({ spec: value === '' ? undefined : value })
                  }
                />,
                'sm',
              )}
              {item(
                '到期日期',
                dateRange(
                  '到期日期', filter.expiryDateFrom, 'expiryDateFrom',
                  filter.expiryDateTo, 'expiryDateTo',
                ),
                'range',
              )}
            </div>
          </div>
        ) : null}
      </div>

      {chips.length > 0 ? (
        <div className="stockin-chips">
          <span>已应用</span>
          {chips.map((chip) => (
            <span key={chip.key} className="stockin-chip">
              {chip.label}
              <button
                type="button"
                aria-label={`移除筛选 ${chip.label}`}
                onClick={(): void =>
                  onChange({ [chip.key]: undefined } as Partial<RecordFilter>)
                }
                style={{
                  border: 0,
                  background: 'transparent',
                  color: 'inherit',
                  cursor: 'pointer',
                  minWidth: 20,
                  minHeight: 20,
                  padding: 0,
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </span>
          ))}
          <button
            type="button"
            className="stockin-link-btn"
            onClick={onReset}
            style={{ minHeight: 32 }}
          >
            全部清除
          </button>
        </div>
      ) : null}
    </>
  );
};

export default FilterBar;
