/**
 * 记录列表筛选条。
 *
 * 只产出 `Partial<RecordFilter>` 补丁，由 model 的 `patchFilter` 负责把 page 复位为 1。
 * 日期统一用 `YYYY-MM-DD` 文本输入（不引入 dayjs / DatePicker），
 * 合法性在提交查询前做格式校验，日历合法性由服务端 schema 兜底。
 */
import React from 'react';
import { Button, Col, Input, Row, Select } from 'antd';
import type { RecordFilter } from '@stockin/shared';
import { isDateString } from '@/utils/format';
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

const SORT_BY_OPTIONS: { value: string; label: string }[] = [
  { value: 'purchaseDate', label: '进货日期' },
  { value: 'expiryDate', label: '到期日期' },
  { value: 'createdAt', label: '创建时间' },
];

const SORT_ORDER_OPTIONS: { value: string; label: string }[] = [
  { value: 'desc', label: '降序' },
  { value: 'asc', label: '升序' },
];

function dateStatus(value: string | undefined): 'error' | undefined {
  return value !== undefined && value !== '' && !isDateString(value) ? 'error' : undefined;
}

const FilterBar: React.FC<FilterBarProps> = ({ filter, onChange, onReset }) => (
  <div
    style={{
      background: '#fff',
      border: '1px solid #f0f0f0',
      borderRadius: 8,
      padding: 12,
      marginBottom: 12,
    }}
  >
    <Row gutter={[12, 12]} align="middle">
      <Col xs={24} sm={12} lg={6}>
        <Input
          value={filter.name ?? ''}
          placeholder="商品名称（模糊）"
          aria-label="按商品名称筛选"
          allowClear
          onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
            onChange({ name: event.target.value || undefined })
          }
          style={{ minHeight: TOUCH_TARGET_MIN_PX }}
        />
      </Col>
      <Col xs={24} sm={12} lg={6}>
        <Input
          value={filter.spec ?? ''}
          placeholder="规格（模糊）"
          aria-label="按规格筛选"
          allowClear
          onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
            onChange({ spec: event.target.value || undefined })
          }
          style={{ minHeight: TOUCH_TARGET_MIN_PX }}
        />
      </Col>
      <Col xs={12} sm={6} lg={3}>
        <Input
          value={filter.purchaseDateFrom ?? ''}
          placeholder="进货起 YYYY-MM-DD"
          aria-label="进货起始日期"
          status={dateStatus(filter.purchaseDateFrom)}
          onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
            onChange({ purchaseDateFrom: event.target.value || undefined })
          }
          style={{ minHeight: TOUCH_TARGET_MIN_PX }}
        />
      </Col>
      <Col xs={12} sm={6} lg={3}>
        <Input
          value={filter.purchaseDateTo ?? ''}
          placeholder="进货止 YYYY-MM-DD"
          aria-label="进货截止日期"
          status={dateStatus(filter.purchaseDateTo)}
          onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
            onChange({ purchaseDateTo: event.target.value || undefined })
          }
          style={{ minHeight: TOUCH_TARGET_MIN_PX }}
        />
      </Col>
      <Col xs={12} sm={6} lg={3}>
        <Input
          value={filter.expiryDateFrom ?? ''}
          placeholder="到期起 YYYY-MM-DD"
          aria-label="到期起始日期"
          status={dateStatus(filter.expiryDateFrom)}
          onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
            onChange({ expiryDateFrom: event.target.value || undefined })
          }
          style={{ minHeight: TOUCH_TARGET_MIN_PX }}
        />
      </Col>
      <Col xs={12} sm={6} lg={3}>
        <Input
          value={filter.expiryDateTo ?? ''}
          placeholder="到期止 YYYY-MM-DD"
          aria-label="到期截止日期"
          status={dateStatus(filter.expiryDateTo)}
          onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
            onChange({ expiryDateTo: event.target.value || undefined })
          }
          style={{ minHeight: TOUCH_TARGET_MIN_PX }}
        />
      </Col>
      <Col xs={12} sm={6} lg={4}>
        <Select
          value={filter.expiryStatus}
          placeholder="到期状态"
          aria-label="按到期状态筛选"
          options={STATUS_OPTIONS}
          allowClear
          style={{ width: '100%', minHeight: TOUCH_TARGET_MIN_PX }}
          onChange={(value: string | undefined): void =>
            onChange({ expiryStatus: value as RecordFilter['expiryStatus'] })
          }
        />
      </Col>
      <Col xs={12} sm={6} lg={4}>
        <Select
          value={filter.sortBy ?? 'purchaseDate'}
          aria-label="排序字段"
          options={SORT_BY_OPTIONS}
          style={{ width: '100%', minHeight: TOUCH_TARGET_MIN_PX }}
          onChange={(value: string): void =>
            onChange({ sortBy: value as RecordFilter['sortBy'] })
          }
        />
      </Col>
      <Col xs={12} sm={6} lg={4}>
        <Select
          value={filter.sortOrder ?? 'desc'}
          aria-label="排序方向"
          options={SORT_ORDER_OPTIONS}
          style={{ width: '100%', minHeight: TOUCH_TARGET_MIN_PX }}
          onChange={(value: string): void =>
            onChange({ sortOrder: value as RecordFilter['sortOrder'] })
          }
        />
      </Col>
      <Col xs={12} sm={6} lg={4}>
        <Button
          block
          onClick={onReset}
          style={{ minHeight: TOUCH_TARGET_MIN_PX }}
        >
          重置筛选
        </Button>
      </Col>
    </Row>
  </div>
);

export default FilterBar;
