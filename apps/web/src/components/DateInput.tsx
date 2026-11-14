/**
 * 日期输入框：antd `DatePicker` 的薄封装，对外仍是 `YYYY-MM-DD` 字符串契约。
 *
 * 为什么不再用原生 `input[type=date]`：原生的空态/已填态显示格式由浏览器语言决定
 * （会出现 `mm/dd/yyyy`、`11/01/2026` 这类美式顺序），与「年-月-日」的中文习惯和
 * 旁边的提示文字相互矛盾，日历图标也不受控。改用 antd 后：
 * - 显示恒为 `YYYY-MM-DD`，空态是「请选择日期」；
 * - 弹层为中文月历（月份、星期取自 dayjs zh-cn，按钮文案取自 antd zh_CN）；
 * - 外观与全站输入框一致，暗色主题随 ConfigProvider 令牌自动切换。
 *
 * 与后端的契约不变：进出都是字符串，空值为 `''`；本组件不做任何日期推算，
 * 三天日期字段的联动仍全部由 `@stockin/domain` 负责。
 */
import React from 'react';
import { DatePicker } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import Icon from '@/components/Icon';

const DATE_FORMAT = 'YYYY-MM-DD';
export interface DateInputProps {
  /** 已选日期 `YYYY-MM-DD`；空字符串表示未选择。 */
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly ariaLabel: string;
  /** 必填语义：只作用于无障碍树（`aria-required`），不做视觉改动。 */
  readonly required?: boolean;
  readonly disabled?: boolean;
  readonly status?: 'error' | 'warning';
}

/** 字符串 → dayjs；非法或空值一律视为未选择，避免把脏值渲染成 Invalid Date。 */
function toDayjs(value: string): Dayjs | null {
  if (value === '') {
    return null;
  }
  const parsed: Dayjs = dayjs(value);
  return parsed.isValid() ? parsed : null;
}

const DateInput: React.FC<DateInputProps> = ({
  value,
  onChange,
  ariaLabel,
  required = false,
  disabled = false,
  status,
}) => (
  <DatePicker
    className="stockin-date-picker"
    value={toDayjs(value)}
    format={DATE_FORMAT}
    placeholder="请选择日期"
    allowClear
    disabled={disabled}
    status={status}
    suffixIcon={<Icon name="calendar" size="sm" />}
    aria-label={ariaLabel}
    aria-required={required}
    /**
     * 手机档（390x844）曾出现弹层 rect=[-26,-45,383,441]：面板高 441px 大于
     * 输入框上下两侧可用高度，rc-align 翻到上方并落在视口外；同时 383px 宽度
     * 在 390 视口里被 bottomRight 对齐推到 left=-26。
     * 这里固定从左下角展开，再配合 global.css 手机档的 popupClassName 约束
     * 把宽高压进视口，避免二次翻转。不改 getPopupContainer（保持 body，避免被
     * 滚动容器裁切）、不动 app.tsx 的 token.motion=false。
     */
    placement="bottomLeft"
    popupClassName="stockin-date-picker-popup"
    onChange={(next: Dayjs | null): void => {
      onChange(next === null ? '' : next.format(DATE_FORMAT));
    }}
    style={{ width: '100%' }}
  />
);

export interface DateRangeInputProps {
  /** 起始日期 `YYYY-MM-DD`；空字符串表示不限。 */
  readonly from: string;
  /** 截止日期 `YYYY-MM-DD`；空字符串表示不限。 */
  readonly to: string;
  readonly onChange: (from: string, to: string) => void;
  readonly ariaLabel: string;
  readonly placeholder?: readonly [string, string];
  readonly status?: 'error' | 'warning';
}

/**
 * 日期区间：起止共用一个控件，中间「至」由 antd 自带，不再手工拼两个输入框。
 * 允许只填一端（`allowEmpty`），与筛选口径一致：留空即该端不限。
 */
export const DateRangeInput: React.FC<DateRangeInputProps> = ({
  from,
  to,
  onChange,
  ariaLabel,
  placeholder = ['开始日期', '结束日期'],
  status,
}) => (
  <DatePicker.RangePicker
    className="stockin-date-range"
    value={[toDayjs(from), toDayjs(to)]}
    format={DATE_FORMAT}
    allowEmpty={[true, true]}
    allowClear
    status={status}
    separator={<span className="stockin-date-range-sep">至</span>}
    placeholder={[placeholder[0], placeholder[1]]}
    aria-label={ariaLabel}
    placement="bottomLeft"
    popupClassName="stockin-date-range-popup"
    onChange={(next: [Dayjs | null, Dayjs | null] | null): void => {
      onChange(
        next?.[0] == null ? '' : next[0].format(DATE_FORMAT),
        next?.[1] == null ? '' : next[1].format(DATE_FORMAT),
      );
    }}
    style={{ width: '100%' }}
  />
);

export default DateInput;
