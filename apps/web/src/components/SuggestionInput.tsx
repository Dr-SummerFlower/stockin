/**
 * 带历史值建议的文本输入（AntD AutoComplete）。
 *
 * - 数据来自 `GET /api/records/suggestions`：按前缀匹配历史商品名称/规格；
 * - 聚焦时才请求，输入后 200ms 防抖；失败静默，不影响正常录入；
 * - `onPick` 仅在用户从下拉中选中时触发，供商品名称带出规格与单价；
 *   直接输入文本不会触发联动。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AutoComplete } from 'antd';
import type { RecordSuggestion, RecordSuggestionField } from '@stockin/shared';
import { getRecordSuggestions } from '@/services/api/record';

export interface SuggestionInputProps {
  readonly field: RecordSuggestionField;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onPick?: (item: RecordSuggestion) => void;
  readonly ariaLabel: string;
  readonly placeholder?: string;
  readonly maxLength?: number;
  readonly allowClear?: boolean;
}

export const SuggestionInput: React.FC<SuggestionInputProps> = ({
  field,
  value,
  onChange,
  onPick,
  ariaLabel,
  placeholder,
  maxLength,
  allowClear = true,
}) => {
  const [items, setItems] = useState<readonly RecordSuggestion[]>([]);
  const [active, setActive] = useState<boolean>(false);
  const [query, setQuery] = useState<string>('');
  const requestId = useRef<number>(0);

  const load = useCallback(
    (text: string): void => {
      const id: number = requestId.current + 1;
      requestId.current = id;
      void getRecordSuggestions(field, text)
        .then((result): void => {
          // 只接受最后一次请求的结果，避免快速输入时旧响应覆盖新结果。
          if (requestId.current === id) {
            setItems(result.items);
          }
        })
        .catch((): void => undefined);
    },
    [field],
  );

  useEffect((): (() => void) | undefined => {
    if (!active) {
      return undefined;
    }
    const timer = setTimeout((): void => load(query), 200);
    return (): void => clearTimeout(timer);
  }, [active, query, load]);

  const options = items.map((item) => ({ value: item.value, label: item.value }));

  return (
    <AutoComplete
      value={value}
      options={options}
      aria-label={ariaLabel}
      placeholder={placeholder}
      allowClear={allowClear}
      filterOption={false}
      maxLength={maxLength}
      onFocus={(): void => {
        setActive(true);
        load(query);
      }}
      onSearch={(text: string): void => {
        setActive(true);
        setQuery(text);
      }}
      onChange={(text: string): void => onChange(text)}
      onSelect={(text: string): void => {
        const picked: RecordSuggestion | undefined = items.find((item) => item.value === text);
        if (picked !== undefined && onPick !== undefined) {
          onPick(picked);
        }
      }}
      style={{ width: '100%' }}
    />
  );
};

export default SuggestionInput;
