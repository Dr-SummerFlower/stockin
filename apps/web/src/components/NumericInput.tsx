/**
 * 数值输入（raw / parsed 双态）。
 *
 * 依据：设计文档 §5.1「数值输入用 raw/parsed 双态，避免 "0." 等中间态被误判为 0」。
 * `parsed` 一律复用 `@stockin/domain` 的 `parseFixed(raw, scale)`，前端不重写定点解析。
 * 触控目标最小尺寸统一取 `TOUCH_TARGET_MIN_PX`，不再硬编码 44。
 */
import React from 'react';
import { ImeInput as Input } from '@/components/ImeInput';
import { parseFixed } from '@stockin/domain';
import { TOUCH_TARGET_MIN_PX } from '@/constants/routes';

export interface NumericInputProps {
  /** 输入框原始文本（受控）。 */
  readonly raw: string;
  /** 定点倍率（SCALE.UNIT_PRICE / QUANTITY / AMOUNT_CENTS）。 */
  readonly scale: number;
  /** 文本变化时同时给出解析结果（null 表示未完成 / 除零中间态）。 */
  readonly onRawChange: (raw: string, parsed: number | null) => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly ariaLabel: string;
  readonly addonBefore?: React.ReactNode;
}

const NumericInput: React.FC<NumericInputProps> = ({
  raw,
  scale,
  onRawChange,
  placeholder,
  disabled = false,
  ariaLabel,
  addonBefore,
}) => {
  const parsed: number | null = parseFixed(raw, scale);
  const incomplete: boolean = raw.trim() !== '' && parsed === null;
  return (
    <Input
      value={raw}
      disabled={disabled}
      inputMode="decimal"
      autoComplete="off"
      placeholder={placeholder}
      aria-label={ariaLabel}
      addonBefore={addonBefore}
      status={incomplete ? 'warning' : undefined}
      onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
        const nextRaw: string = event.target.value;
        onRawChange(nextRaw, parseFixed(nextRaw, scale));
      }}
      style={{ minHeight: TOUCH_TARGET_MIN_PX }}
    />
  );
};

export default NumericInput;
